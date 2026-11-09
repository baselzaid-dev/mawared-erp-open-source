import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import {
  finalErrorHandler,
  requestContextMiddleware,
  type SafeRequestLog,
} from '../src/security';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

const PRODUCTION_TEST_SECRET = 'production-test-secret-only-000000000000';

describe('HTTP security boundary', () => {
  it('sets production headers, accepts native requests and enforces the browser allow-list', async () => {
    const app = makeApp(makeFakePrisma(), {
      isProduction: true,
      jwtSecret: PRODUCTION_TEST_SECRET,
      corsOrigins: ['https://allowed.example'],
    });

    const native = await request(app).get('/healthz');
    expect(native.status).toBe(200);
    expect(native.headers['x-powered-by']).toBeUndefined();
    expect(native.headers['x-content-type-options']).toBe('nosniff');
    expect(native.headers['referrer-policy']).toBe('no-referrer');
    expect(native.headers['x-frame-options']).toBe('DENY');
    expect(native.headers['strict-transport-security']).toContain('max-age=31536000');

    const allowed = await request(app)
      .get('/healthz')
      .set('Origin', 'https://allowed.example');
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://allowed.example');

    const denied = await request(app)
      .get('/healthz')
      .set('Origin', 'https://evil.example');
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('CORS_ORIGIN_FORBIDDEN');
  });

  it('refuses weak production JWT configuration before listening', () => {
    expect(() => createApp({
      prisma: makeFakePrisma(),
      config: { jwtSecret: 'short', isProduction: true },
    })).toThrow(/too weak/);
  });
});

describe('request correlation and safe errors', () => {
  it('generates a server request ID and never reflects an untrusted client ID', async () => {
    const response = await request(makeApp(makeFakePrisma()))
      .get('/api/not-a-route')
      .set('X-Request-ID', 'attacker-controlled');

    expect(response.status).toBe(404);
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(response.headers['x-request-id']).not.toBe('attacker-controlled');
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
    expect(response.body).toMatchObject({
      error: 'RouteNotFound',
      code: 404,
    });
  });

  it('reuses a valid inbound UUID request ID for correlation', async () => {
    const inbound = 'b2c3d4e5-f6a7-4789-b012-3456789abcde';
    const response = await request(makeApp(makeFakePrisma()))
      .get('/healthz')
      .set('X-Request-ID', inbound);
    expect(response.headers['x-request-id']).toBe(inbound);
  });

  it('returns safe readiness responses without database details', async () => {
    const ready = await request(makeApp(makeFakePrisma())).get('/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready' });

    const prisma = makeFakePrisma();
    prisma.$queryRaw.mockRejectedValueOnce(new Error('database path and connection details'));
    const unavailable = await request(makeApp(prisma)).get('/readyz');
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(unavailable.body)).not.toMatch(/database|connection details/i);
    expect(unavailable.body.requestId).toBeTruthy();
  });

  it('logs metadata only and excludes headers, bodies and query values', async () => {
    const logs: SafeRequestLog[] = [];
    const app = makeApp(makeFakePrisma(), { requestLogger: (entry) => logs.push(entry) });
    const response = await request(app)
      .get('/api/not-a-route?private=value')
      .set('Authorization', 'Bearer should-never-be-logged'); // security-scan-allow
    expect(response.status).toBe(404);
    expect(logs).toHaveLength(1);
    expect(logs[0].route).not.toContain('private');
    expect(JSON.stringify(logs[0])).not.toContain('should-never-be-logged');
    expect(Object.keys(logs[0])).not.toContain('body');
  });

  it('never writes an unknown exception message into logs', async () => {
    const logs: SafeRequestLog[] = [];
    const app = express();
    app.use(requestContextMiddleware({ isProduction: true, logger: (entry) => logs.push(entry) }));
    app.get('/boom', (_req, _res, next) => {
      next(new Error('token=test-only-value-that-must-not-log')); // security-scan-allow
    });
    app.use(finalErrorHandler({ isProduction: true, logger: (entry) => logs.push(entry) }));

    const response = await request(app).get('/boom');

    expect(response.status).toBe(500);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('test-only-value-that-must-not-log');
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: 'unhandled_error',
        errorMessage: 'Unhandled server error',
      })
    );
  });
});

describe('payload and rate-limit hardening', () => {
  it('rejects non-JSON writes, duplicate query parameters and dangerous object keys', async () => {
    const app = makeApp(makeFakePrisma());
    const token = tokenFor({ permissions: ['leaves.create'] });

    const mediaType = await request(app)
      .post('/api/leaves')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/plain')
      .send('not-json');
    expect(mediaType.status).toBe(415);

    const duplicate = await request(app)
      .get('/api/reports/catalog?x=1&x=2')
      .set('Authorization', `Bearer ${token}`);
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toBe('DuplicateQueryParameter');

    const dangerous = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":"person@example.com","password":"x","constructor":{"prototype":{}}}');
    expect(dangerous.status).toBe(400);
    expect(dangerous.body.error).toBe('UnsafePayload');
  });

  it('rejects malformed and oversized JSON without stack or parser details', async () => {
    const app = makeApp(makeFakePrisma());
    const malformed = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('InvalidJson');
    expect(JSON.stringify(malformed.body)).not.toMatch(/SyntaxError|stack|node_modules/i);

    const oversized = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'person@example.com', password: 'x'.repeat(1_100_000) }));
    expect(oversized.status).toBe(413);
    expect(oversized.body.error).toBe('PayloadTooLarge');
  });

  it('rate-limits exports while leaving health checks available', async () => {
    const prisma = makeFakePrisma();
    prisma.attendance.findMany.mockResolvedValue([]);
    const app = makeApp(prisma, {
      exportRateLimitWindowMs: 60_000,
      exportRateLimitMax: 1,
    });
    const token = tokenFor({ permissions: ['attendance.view', 'reports.export'] });
    const body = { reportType: 'attendance', filters: {}, format: 'csv' };

    const first = await request(app)
      .post('/api/reports/export')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    const second = await request(app)
      .post('/api/reports/export')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);

    for (let index = 0; index < 3; index += 1) {
      const health = await request(app).get('/healthz');
      expect(health.status).toBe(200);
    }
  });
});
