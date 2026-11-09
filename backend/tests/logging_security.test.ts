import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { sanitizeAuditDetails } from '../src/audit';
import { createAppLogger, type LogLevel } from '../src/appLogger';
import {
  isSensitiveKey,
  redactHeaders,
  redactMetadata,
  redactString,
  REDACTED,
} from '../src/redact';
import {
  finalErrorHandler,
  requestContextMiddleware,
  resolveRequestId,
  type SafeRequestLog,
} from '../src/security';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

const VALID_REQUEST_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';

describe('request ID lifecycle', () => {
  it('assigns a canonical request ID to every HTTP request', async () => {
    const response = await request(makeApp(makeFakePrisma())).get('/healthz');
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('returns the canonical request ID in the response header', async () => {
    const response = await request(makeApp(makeFakePrisma())).get('/api/not-a-route');
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('reuses a valid bounded inbound request ID', async () => {
    const response = await request(makeApp(makeFakePrisma()))
      .get('/healthz')
      .set('X-Request-ID', VALID_REQUEST_ID);
    expect(response.headers['x-request-id']).toBe(VALID_REQUEST_ID.toLowerCase());
  });

  it('replaces an unsafe or oversized inbound request ID', async () => {
    const oversized = `${'a'.repeat(200)}-${randomUUID()}`;
    const response = await request(makeApp(makeFakePrisma()))
      .get('/healthz')
      .set('X-Request-ID', oversized);
    expect(response.headers['x-request-id']).not.toBe(oversized);
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('rejects newline and control-character request IDs', () => {
    expect(resolveRequestId('good-id-but-not-uuid')).not.toBe('good-id-but-not-uuid');
    expect(resolveRequestId('abc\nDEF')).not.toMatch(/\n/);
    expect(resolveRequestId('abc\rDEF')).not.toMatch(/\r/);
    expect(resolveRequestId('abc\u0001DEF')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe('centralized secret redaction', () => {
  it('redacts Authorization and Cookie headers', () => {
    const redacted = redactHeaders({
      Authorization: 'Bearer secret-token-value', // security-scan-allow
      Cookie: 'session=abc123',
      'X-Trace': 'safe',
    });
    expect(redacted.Authorization).toBe(REDACTED);
    expect(redacted.Cookie).toBe(REDACTED);
    expect(redacted['X-Trace']).toBe('safe');
    expect(JSON.stringify(redacted)).not.toContain('secret-token-value');
  });

  it('redacts password and temporary-password values', () => {
    const redacted = redactMetadata({
      password: 'plain-text-password', // security-scan-allow
      temporaryPassword: 'temp-pass-123', // security-scan-allow
      userId: 'u1',
    }) as Record<string, unknown>;
    expect(redacted.password).toBe(REDACTED);
    expect(redacted.temporaryPassword).toBe(REDACTED);
    expect(redacted.userId).toBe('u1');
  });

  it('redacts access and refresh tokens', () => {
    const redacted = redactMetadata({
      accessToken: 'access-token-value', // security-scan-allow
      refreshToken: 'refresh-token-value', // security-scan-allow
    }) as Record<string, unknown>;
    expect(redacted.accessToken).toBe(REDACTED);
    expect(redacted.refreshToken).toBe(REDACTED);
  });

  it('redacts MFA secrets, TOTP codes, challenges, and backup codes', () => {
    const redacted = redactMetadata({
      mfaSecret: 'secret-base32', // security-scan-allow
      totpCode: '123456',
      mfaChallenge: 'challenge-id',
      backupCodes: ['111111', '222222'],
    }) as Record<string, unknown>;
    expect(redacted.mfaSecret).toBe(REDACTED);
    expect(redacted.totpCode).toBe(REDACTED);
    expect(redacted.mfaChallenge).toBe(REDACTED);
    expect(redacted.backupCodes).toBe(REDACTED);
  });

  it('redacts database URLs and encryption keys', () => {
    expect(redactString('postgresql://example-user:example-password@db.example.invalid/example-db')).toBe(REDACTED); // security-scan-allow
    const redacted = redactMetadata({
      databaseUrl: 'postgresql://example-user:example-password@db.example.invalid/example-db', // security-scan-allow
      encryptionKey: 'local-encryption-key', // security-scan-allow
    }) as Record<string, unknown>;
    expect(redacted.databaseUrl).toBe(REDACTED);
    expect(redacted.encryptionKey).toBe(REDACTED);
  });

  it('does not retain recoverable secret fragments', () => {
    const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz'; // security-scan-allow
    const redacted = redactString(bearer);
    expect(redacted).toBe(REDACTED);
    expect(redacted).not.toContain('Bearer');
    expect(redacted).not.toContain('abc');
  });

  it('handles null and malformed metadata without crashing', () => {
    expect(() => redactMetadata(null)).not.toThrow();
    expect(() => redactMetadata(undefined)).not.toThrow();
    expect(redactMetadata({ weird: Symbol('x') })).toEqual({ weird: REDACTED });
    expect(isSensitiveKey('PaSsWoRd')).toBe(true);
  });
});

describe('safe public error responses', () => {
  it('keeps expected authorization failures at the correct safe status', async () => {
    const app = makeApp(makeFakePrisma());
    const token = tokenFor({ permissions: ['employees.view'] });
    const response = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Test Employee' });
    expect(response.status).toBe(403);
    expect(response.body.error).toBeTruthy();
    expect(response.body.requestId).toBeTruthy();
  });

  it('preserves opaque cross-tenant privacy behavior', async () => {
    const prisma = makeFakePrisma();
    prisma.vendor.findFirst.mockResolvedValue(null);
    const token = tokenFor({ permissions: ['vendors.archive'] });
    const response = await request(makeApp(prisma))
      .post('/api/vendors/other-company-vendor/archive')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'cleanup' });
    expect(response.status).toBe(404);
    expect(response.body.error).not.toBe('Forbidden');
    expect(JSON.stringify(response.body)).not.toMatch(/other-company|tenant/i);
  });

  it('returns a generic public error for unexpected exceptions', async () => {
    const app = express();
    app.use(requestContextMiddleware({ isProduction: true }));
    app.get('/boom', (_req, _res, next) => {
      next(new Error('PrismaClientKnownRequestError table User column password')); // security-scan-allow
    });
    app.use(finalErrorHandler({ isProduction: true }));

    const response = await request(app).get('/boom');
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      error: 'InternalServerError',
      code: 500,
    });
    expect(response.body.requestId).toBeTruthy();
  });

  it('keeps stack traces, Prisma details, SQL, paths, and secrets out of public errors', async () => {
    const app = express();
    app.use(requestContextMiddleware({ isProduction: true }));
    app.get('/boom', (_req, _res, next) => {
      next(new Error('C:\\secrets\\keys\\prod.pem SELECT * FROM "User" WHERE password = token')); // security-scan-allow
    });
    app.use(finalErrorHandler({ isProduction: true }));

    const response = await request(app).get('/boom');
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/stack|Prisma|SELECT|password|token|prod\.pem/i);
    expect(response.body.message).toContain('رقم الطلب');
  });

  it('includes the support-safe request ID where required', async () => {
    const response = await request(makeApp(makeFakePrisma())).get('/api/not-a-route');
    expect(response.body.requestId).toEqual(response.headers['x-request-id']);
  });
});

describe('structured logging boundaries', () => {
  it('does not emit debug-level events in production', () => {
    const lines: Array<{ level: LogLevel; line: string }> = [];
    const logger = createAppLogger({
      isProduction: true,
      sink: (line, level) => lines.push({ line, level }),
    });
    logger.debug('debug.event', { note: 'hidden' });
    logger.info('info.event', { note: 'visible' });
    expect(lines.some((entry) => entry.level === 'debug')).toBe(false);
    expect(lines.some((entry) => entry.level === 'info')).toBe(true);
  });

  it('keeps audit and application logging boundaries free of raw MFA or password material', () => {
    const audit = sanitizeAuditDetails({
      password: 'audit-password', // security-scan-allow
      mfaSecret: 'audit-mfa-secret', // security-scan-allow
      userId: 'u1',
      status: 'failed',
    });
    expect(JSON.stringify(audit)).not.toContain('audit-password');
    expect(JSON.stringify(audit)).not.toContain('audit-mfa-secret');

    const logs: SafeRequestLog[] = [];
    const app = express();
    app.use(requestContextMiddleware({
      isProduction: true,
      logger: (entry) => logs.push(entry),
    }));
    app.post('/login', (_req, res) => {
      res.status(401).json({ error: 'Unauthorized', code: 401 });
    });

    return request(app)
      .post('/login')
      .set('Authorization', 'Bearer leaked-token') // security-scan-allow
      .send({ password: 'plain-password', mfaSecret: 'secret' }) // security-scan-allow
      .expect(401)
      .then(() => {
        expect(JSON.stringify(logs)).not.toContain('leaked-token');
        expect(JSON.stringify(logs)).not.toContain('plain-password');
        expect(JSON.stringify(logs)).not.toContain('secret');
      });
  });

  it('logs client errors separately from unhandled application crashes', async () => {
    const lines: string[] = [];
    const app = express();
    const logger = createAppLogger({
      isProduction: true,
      jsonOutput: true,
      sink: (line) => lines.push(line),
    });
    app.use(requestContextMiddleware({ isProduction: true, appLogger: logger }));
    app.get('/missing', (_req, res) => {
      res.status(404).json({ error: 'RouteNotFound', code: 404 });
    });
    app.get('/crash', (_req, _res, next) => next(new Error('internal-only'))); // security-scan-allow
    app.use(finalErrorHandler({ isProduction: true, appLogger: logger }));

    await request(app).get('/missing');
    await request(app).get('/crash');

    expect(lines.some((line) => line.includes('http.request.client_error'))).toBe(true);
    expect(lines.some((line) => line.includes('http.unhandled_error'))).toBe(true);
    expect(lines.some((line) => line.includes('internal-only'))).toBe(false);
  });
});
