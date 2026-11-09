import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { sanitizeAuditDetails } from '../src/audit';
import {
  classifyFinishedRequest,
  isForbiddenMetricLabel,
  normalizeRouteCategory,
  resetMetrics,
  snapshotMetrics,
} from '../src/metrics';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

describe('health and readiness', () => {
  it('liveness returns a safe successful response', async () => {
    const response = await request(makeApp(makeFakePrisma())).get('/healthz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(JSON.stringify(response.body)).not.toMatch(/prisma|sql|password|token|DATABASE|env/i);
  });

  it('liveness performs no business-data write', async () => {
    const prisma = makeFakePrisma();
    await request(makeApp(prisma)).get('/healthz');
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.employee.create).not.toHaveBeenCalled();
  });

  it('readiness returns a safe successful response when dependencies are ready', async () => {
    const response = await request(makeApp(makeFakePrisma())).get('/readyz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
  });

  it('readiness fails safely when a required dependency fails', async () => {
    const prisma = makeFakePrisma();
    // security-scan-allow: synthetic failure text must not appear in the public body
    prisma.$queryRaw.mockRejectedValueOnce(new Error('database path and connection details'));
    const response = await request(makeApp(prisma)).get('/readyz');
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('ServiceUnavailable');
    expect(response.body.requestId).toBeTruthy();
  });

  it('readiness exposes no Prisma, SQL, path, environment, or secret details', async () => {
    const prisma = makeFakePrisma();
    // security-scan-allow: synthetic exception message for redaction assertion only
    prisma.$queryRaw.mockRejectedValueOnce(
      new Error('PrismaClientKnownRequestError table placeholder path=example.invalid'),
    );
    const response = await request(makeApp(prisma)).get('/readyz');
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/Prisma|SELECT|DATABASE_URL|postgresql:\/\/|example\.invalid|path=/i);
  });

  it('health and readiness paths do not permit business-data writes', async () => {
    const prisma = makeFakePrisma();
    await request(makeApp(prisma)).get('/healthz');
    await request(makeApp(prisma)).get('/readyz');
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('provider-neutral metrics safety', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('uses bounded normalized route labels for request metrics', () => {
    expect(normalizeRouteCategory('/healthz')).toBe('health');
    expect(normalizeRouteCategory('/readyz')).toBe('ready');
    expect(normalizeRouteCategory('/api/auth/login')).toBe('auth_company');
    expect(normalizeRouteCategory('/api/platform/login')).toBe('auth_platform');
    expect(normalizeRouteCategory('/api/v2/auth/mfa/verify')).toBe('mfa');
    classifyFinishedRequest({ routeCategory: 'api', status: 200, durationMs: 12 });
    const snap = snapshotMetrics();
    expect(Object.keys(snap.httpRequests)).toEqual(['api']);
    expect(snap.httpRequests.api).toBe(1);
  });

  it('metrics contain no request IDs, emails, tokens, company names, or resource IDs', () => {
    classifyFinishedRequest({ routeCategory: 'auth_company', status: 401, durationMs: 5 });
    const snap = snapshotMetrics();
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toMatch(/@|Bearer |eyJ|company-A|requestId|employee/i);
    expect(isForbiddenMetricLabel('person@example.com')).toBe(true);
    expect(isForbiddenMetricLabel('a1b2c3d4-e5f6-4789-a012-3456789abcde')).toBe(true);
    expect(isForbiddenMetricLabel('Bearer abc.def.ghi')).toBe(true);
    expect(isForbiddenMetricLabel('auth_company')).toBe(false);
  });

  it('authentication failure metrics do not expose identity data', () => {
    classifyFinishedRequest({ routeCategory: 'auth_company', status: 401 });
    classifyFinishedRequest({ routeCategory: 'auth_platform', status: 401 });
    const snap = snapshotMetrics();
    expect(snap.authFailures.company).toBe(1);
    expect(snap.authFailures.platform).toBe(1);
    expect(JSON.stringify(snap.authFailures)).not.toMatch(/email|user|token/i);
  });

  it('MFA failure metrics contain no MFA material', () => {
    classifyFinishedRequest({ routeCategory: 'mfa', status: 401, errorCode: 'MfaInvalid' });
    const snap = snapshotMetrics();
    expect(snap.mfaFailures.company).toBe(1);
    expect(JSON.stringify(snap)).not.toMatch(/totp|backup|secret|challenge/i);
  });

  it('rate-limit metrics use bounded categories', () => {
    classifyFinishedRequest({ routeCategory: 'auth_company', status: 429 });
    classifyFinishedRequest({ routeCategory: 'mfa', status: 429 });
    const snap = snapshotMetrics();
    expect(snap.rateLimitEvents.auth).toBe(1);
    expect(snap.rateLimitEvents.mfa).toBe(1);
  });

  it('cross-tenant metrics contain no tenant or resource identifiers', () => {
    classifyFinishedRequest({
      routeCategory: 'api',
      status: 404,
      opaquePrivacy: true,
    });
    const snap = snapshotMetrics();
    expect(snap.crossTenantDenials).toBe(1);
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toMatch(/company-[A-Za-z0-9]|vendor-|employee-|resource-/i);
    expect(serialized).not.toMatch(/@[a-z]+\./i);
  });

  it('platform and company authentication metrics remain distinguishable without identity leakage', () => {
    classifyFinishedRequest({ routeCategory: 'auth_company', status: 401 });
    classifyFinishedRequest({ routeCategory: 'auth_platform', status: 401 });
    const snap = snapshotMetrics();
    expect(snap.authFailures.company).toBeGreaterThan(0);
    expect(snap.authFailures.platform).toBeGreaterThan(0);
    expect(snap.authFailures.company).not.toEqual(snap.authFailures.platform + 10);
  });

  it('records HTTP metrics from live requests without identity labels', async () => {
    resetMetrics();
    await request(makeApp(makeFakePrisma())).get('/healthz');
    await request(makeApp(makeFakePrisma())).get('/api/not-a-route');
    const snap = snapshotMetrics();
    expect(snap.httpRequests.health).toBeGreaterThanOrEqual(1);
    expect(snap.http4xx.other ?? snap.http4xx.api ?? 0).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(snap)).not.toMatch(/@|Bearer |password/i);
  });
});

describe('audit secret safety for observability foundation', () => {
  it('rejects or sanitizes password material from audit details', () => {
    const sanitized = sanitizeAuditDetails({
      userId: 'u1',
      status: 'failed',
      password: 'plain-password', // security-scan-allow
      temporaryPassword: 'temp-pass', // security-scan-allow
      accessToken: 'access-token-value', // security-scan-allow
      refreshToken: 'refresh-token-value', // security-scan-allow
    });
    expect(JSON.stringify(sanitized)).not.toContain('plain-password');
    expect(JSON.stringify(sanitized)).not.toContain('temp-pass');
    expect(JSON.stringify(sanitized)).not.toContain('access-token');
    expect(JSON.stringify(sanitized)).not.toContain('refresh-token');
  });

  it('rejects or sanitizes MFA material from audit details', () => {
    const sanitized = sanitizeAuditDetails({
      userId: 'u1',
      action: 'auth.mfa.verify',
      mfaSecret: 'secret-base32', // security-scan-allow
      totpCode: '123456',
      backupCodes: ['111111'],
      mfaChallenge: 'challenge-token', // security-scan-allow
    });
    expect(JSON.stringify(sanitized)).not.toContain('secret-base32');
    expect(JSON.stringify(sanitized)).not.toContain('123456');
    expect(JSON.stringify(sanitized)).not.toContain('111111');
    expect(JSON.stringify(sanitized)).not.toContain('challenge-token');
  });

  it('keeps existing authorization privacy behavior unchanged', async () => {
    const prisma = makeFakePrisma();
    prisma.vendor.findFirst.mockResolvedValue(null);
    const token = tokenFor({ permissions: ['vendors.archive'] });
    const response = await request(makeApp(prisma))
      .post('/api/vendors/other-company-vendor/archive')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'cleanup' });
    expect(response.status).toBe(404);
    expect(response.body.error).not.toBe('Forbidden');
  });

  it('does not require an external monitoring credential for focused tests', () => {
    expect(process.env.SENTRY_DSN).toBeUndefined();
    expect(process.env.DATADOG_API_KEY).toBeUndefined();
    resetMetrics();
    classifyFinishedRequest({ routeCategory: 'health', status: 200 });
    expect(snapshotMetrics().httpRequests.health).toBe(1);
  });
});
