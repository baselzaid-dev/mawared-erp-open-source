import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSessionRoutes } from '../src/sessionRoutes';
import {
  CannotRevokeCurrentSessionError,
  listSessionsForUser,
  revokeAllSessionsForUser,
  revokeSessionByPublicId,
  shapeSessionSummary,
} from '../src/sessions';
import { attachSessionIdToAccessToken } from '../src/tokens';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

const USER_ID = 'u1';
const COMPANY_ID = 'c1';
const OTHER_USER_ID = 'u2';
const OTHER_COMPANY_ID = 'c2';

function seedSession(
  store: any[],
  overrides: Record<string, unknown> = {},
) {
  const row = {
    id: `rt-${store.length + 1}`,
    sessionId: crypto.randomUUID(),
    userId: USER_ID,
    companyId: COMPANY_ID,
    tokenHash: `hash-${store.length + 1}`,
    bindingHash: `binding-${store.length + 1}`,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    revokedAt: null,
    createdAt: new Date('2026-07-01T10:00:00.000Z'),
    lastUsedAt: new Date('2026-07-18T12:00:00.000Z'),
    deviceLabel: 'Pixel 8',
    platform: 'android',
    ...overrides,
  };
  store.push(row);
  return row;
}

function enhanceRefreshTokenMock(prisma: any) {
  const store = prisma._store.refreshTokens as any[];

  prisma.refreshToken.findMany = vi.fn(async ({ where, orderBy }: any = {}) => {
    let rows = store.filter((row) => {
      if (where?.userId !== undefined && row.userId !== where.userId) return false;
      if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
      return true;
    });
    if (orderBy) {
      rows = [...rows].sort((a, b) => {
        for (const clause of Array.isArray(orderBy) ? orderBy : [orderBy]) {
          const [field, direction] = Object.entries(clause)[0] as [string, 'asc' | 'desc'];
          const av = a[field] ? new Date(a[field]).getTime() : 0;
          const bv = b[field] ? new Date(b[field]).getTime() : 0;
          if (av !== bv) return direction === 'desc' ? bv - av : av - bv;
        }
        return 0;
      });
    }
    return rows.map((row) => ({
      sessionId: row.sessionId,
      deviceLabel: row.deviceLabel ?? null,
      platform: row.platform ?? null,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt ?? null,
      revokedAt: row.revokedAt ?? null,
    }));
  });

  prisma.refreshToken.findFirst = vi.fn(async ({ where }: any) => {
    const row = store.find((candidate) => {
      if (where.sessionId !== undefined && candidate.sessionId !== where.sessionId) return false;
      if (where.userId !== undefined && candidate.userId !== where.userId) return false;
      if (where.companyId !== undefined && candidate.companyId !== where.companyId) return false;
      return true;
    });
    if (!row) return null;
    return {
      sessionId: row.sessionId,
      revokedAt: row.revokedAt ?? null,
    };
  });

  prisma.refreshToken.updateMany = vi.fn(async ({ where, data }: any) => {
    const matching = store.filter((row) => {
      if (where.id !== undefined && row.id !== where.id) return false;
      if (where.sessionId !== undefined) {
        if (typeof where.sessionId === 'string' && row.sessionId !== where.sessionId) return false;
        if (where.sessionId.not && row.sessionId === where.sessionId.not) return false;
      }
      if (where.userId !== undefined && row.userId !== where.userId) return false;
      if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
      if (where.revokedAt === null && row.revokedAt !== null) return false;
      if (where.expiresAt?.gt && row.expiresAt <= where.expiresAt.gt) return false;
      return true;
    });
    matching.forEach((row) => Object.assign(row, data));
    return { count: matching.length };
  });
}

const testRequireAuth: express.RequestHandler = (req, res, next) => {
  const authorization = req.headers.authorization;
  const match = typeof authorization === 'string'
    ? authorization.match(/^Bearer\s+(\S+)$/i)
    : null;
  const token = match?.[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, TEST_SECRET) as {
      id: string;
      companyId: string;
      employeeId: string | null;
      permissions: string[];
    };
    (req as express.Request & { user?: typeof payload }).user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

function makeSessionApp(prisma: any) {
  const app = express();
  app.use(express.json());
  registerSessionRoutes({
    app,
    prisma,
    requireAuth: testRequireAuth,
    jwtSecret: TEST_SECRET,
  });
  return app;
}

function authToken(sessionId?: string) {
  if (sessionId) {
    return attachSessionIdToAccessToken(
      {
        id: USER_ID,
        companyId: COMPANY_ID,
        employeeId: 'e1',
        permissions: [],
        authorizationVersion: 1,
      },
      sessionId,
      TEST_SECRET,
      '15m',
    );
  }
  return tokenFor({
    id: USER_ID,
    companyId: COMPANY_ID,
    employeeId: 'e1',
    permissions: [],
    authorizationVersion: 1,
  });
}

describe('sessions service', () => {
  let prisma: any;

  beforeEach(() => {
    prisma = makeFakePrisma();
    enhanceRefreshTokenMock(prisma);
  });

  it('shapeSessionSummary marks legacy devices and omits sensitive fields', () => {
    const summary = shapeSessionSummary(
      {
        sessionId: '11111111-1111-4111-8111-111111111111',
        deviceLabel: null,
        platform: null,
        createdAt: new Date('2026-07-01T10:00:00.000Z'),
        lastUsedAt: null,
        revokedAt: null,
      },
      { isCurrent: false },
    );
    expect(summary).toEqual({
      sessionId: '11111111-1111-4111-8111-111111111111',
      deviceLabel: null,
      platform: null,
      createdAt: '2026-07-01T10:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
      isCurrent: false,
      isLegacyDevice: true,
    });
    expect(summary).not.toHaveProperty('tokenHash');
    expect(summary).not.toHaveProperty('bindingHash');
  });

  it('listSessionsForUser marks the current session', async () => {
    const current = seedSession(prisma._store.refreshTokens, { deviceLabel: 'Current phone' });
    seedSession(prisma._store.refreshTokens, {
      sessionId: '22222222-2222-4222-8222-222222222222',
      deviceLabel: 'Old tablet',
    });

    const sessions = await listSessionsForUser(prisma, USER_ID, COMPANY_ID, current.sessionId);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((row) => row.sessionId === current.sessionId)?.isCurrent).toBe(true);
    expect(sessions.find((row) => row.sessionId === '22222222-2222-4222-8222-222222222222')?.isCurrent)
      .toBe(false);
  });
});

describe('session routes', () => {
  let prisma: any;
  let app: express.Express;

  beforeEach(() => {
    prisma = makeFakePrisma();
    enhanceRefreshTokenMock(prisma);
    app = makeSessionApp(prisma);
  });

  it('returns 401 when listing sessions without auth', async () => {
    const response = await request(app).get('/api/v2/auth/sessions');
    expect(response.status).toBe(401);
  });

  it('lists own sessions with correct shape and no hash leakage', async () => {
    const current = seedSession(prisma._store.refreshTokens);
    seedSession(prisma._store.refreshTokens, {
      sessionId: '33333333-3333-4333-8333-333333333333',
      deviceLabel: null,
      platform: null,
      revokedAt: new Date('2026-07-10T08:00:00.000Z'),
    });

    const response = await request(app)
      .get('/api/v2/auth/sessions')
      .set('Authorization', `Bearer ${authToken(current.sessionId)}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(JSON.stringify(response.body)).not.toMatch(/tokenHash|bindingHash/i);

    const currentRow = response.body.find((row: any) => row.sessionId === current.sessionId);
    expect(currentRow.isCurrent).toBe(true);
    expect(currentRow.isLegacyDevice).toBe(false);

    const legacyRow = response.body.find(
      (row: any) => row.sessionId === '33333333-3333-4333-8333-333333333333',
    );
    expect(legacyRow.isLegacyDevice).toBe(true);
    expect(legacyRow.revokedAt).toBe('2026-07-10T08:00:00.000Z');
  });

  it('marks isCurrent from X-Session-Id when JWT lacks sessionId claim', async () => {
    const current = seedSession(prisma._store.refreshTokens);

    const response = await request(app)
      .get('/api/v2/auth/sessions')
      .set('Authorization', `Bearer ${authToken()}`)
      .set('X-Session-Id', current.sessionId);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].isCurrent).toBe(true);
  });

  it('revokes another session and writes audit with sessionId only', async () => {
    const current = seedSession(prisma._store.refreshTokens);
    const other = seedSession(prisma._store.refreshTokens, {
      sessionId: '44444444-4444-4444-8444-444444444444',
      deviceLabel: 'Browser',
      platform: 'web',
    });

    const response = await request(app)
      .delete(`/api/v2/auth/sessions/${other.sessionId}`)
      .set('Authorization', `Bearer ${authToken(current.sessionId)}`);

    expect(response.status).toBe(204);
    expect(prisma._store.refreshTokens.find((row: any) => row.sessionId === other.sessionId).revokedAt)
      .toBeTruthy();
    expect(prisma._store.refreshTokens.find((row: any) => row.sessionId === current.sessionId).revokedAt)
      .toBeNull();

    const audit = prisma._store.auditLogs.at(-1);
    expect(audit.action).toBe('auth.session.revoke');
    expect(JSON.parse(audit.details)).toEqual({ sessionId: other.sessionId });
    expect(JSON.stringify(audit.details)).not.toMatch(/tokenHash|bindingHash/i);
  });

  it('returns 409 when revoking the current session', async () => {
    const current = seedSession(prisma._store.refreshTokens);

    const response = await request(app)
      .delete(`/api/v2/auth/sessions/${current.sessionId}`)
      .set('Authorization', `Bearer ${authToken(current.sessionId)}`);

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('CurrentSession');
    expect(prisma._store.refreshTokens[0].revokedAt).toBeNull();
  });

  it('revoke-all with exceptCurrent keeps the current session active', async () => {
    const current = seedSession(prisma._store.refreshTokens);
    const other = seedSession(prisma._store.refreshTokens, {
      sessionId: '55555555-5555-4555-8555-555555555555',
    });

    const response = await request(app)
      .post('/api/v2/auth/sessions/revoke-all')
      .set('Authorization', `Bearer ${authToken(current.sessionId)}`)
      .send({ exceptCurrent: true });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ revokedCount: 1 });
    expect(prisma._store.refreshTokens.find((row: any) => row.sessionId === current.sessionId).revokedAt)
      .toBeNull();
    expect(prisma._store.refreshTokens.find((row: any) => row.sessionId === other.sessionId).revokedAt)
      .toBeTruthy();
  });

  it('returns opaque 404 for another user session id', async () => {
    const current = seedSession(prisma._store.refreshTokens);
    const foreign = seedSession(prisma._store.refreshTokens, {
      sessionId: '66666666-6666-4666-8666-666666666666',
      userId: OTHER_USER_ID,
    });

    const response = await request(app)
      .delete(`/api/v2/auth/sessions/${foreign.sessionId}`)
      .set('Authorization', `Bearer ${authToken(current.sessionId)}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('NotFound');
    expect(prisma._store.refreshTokens.find((row: any) => row.sessionId === foreign.sessionId).revokedAt)
      .toBeNull();
  });

  it('returns opaque 404 for cross-tenant session id', async () => {
    const current = seedSession(prisma._store.refreshTokens);
    const foreign = seedSession(prisma._store.refreshTokens, {
      sessionId: '77777777-7777-4777-8777-777777777777',
      companyId: OTHER_COMPANY_ID,
    });

    const response = await request(app)
      .delete(`/api/v2/auth/sessions/${foreign.sessionId}`)
      .set('Authorization', `Bearer ${authToken(current.sessionId)}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('NotFound');
    expect(prisma._store.refreshTokens.find((row: any) => row.sessionId === foreign.sessionId).revokedAt)
      .toBeNull();
  });
});

describe('session service guards', () => {
  let prisma: any;

  beforeEach(() => {
    prisma = makeFakePrisma();
    enhanceRefreshTokenMock(prisma);
  });

  it('revokeSessionByPublicId rejects current session when allowCurrent is false', async () => {
    const current = seedSession(prisma._store.refreshTokens);
    await expect(
      revokeSessionByPublicId(prisma, current.sessionId, { id: USER_ID, companyId: COMPANY_ID }, {
        allowCurrent: false,
        currentSessionId: current.sessionId,
      }),
    ).rejects.toBeInstanceOf(CannotRevokeCurrentSessionError);
  });

  it('revokeAllSessionsForUser respects exceptSessionId', async () => {
    const keep = seedSession(prisma._store.refreshTokens);
    seedSession(prisma._store.refreshTokens, {
      sessionId: '88888888-8888-4888-8888-888888888888',
    });

    const result = await revokeAllSessionsForUser(prisma, USER_ID, COMPANY_ID, {
      exceptSessionId: keep.sessionId,
      actorUserId: USER_ID,
    });

    expect(result).toEqual({ revokedCount: 1 });
    expect(prisma._store.refreshTokens.find((row: any) => row.sessionId === keep.sessionId).revokedAt)
      .toBeNull();
  });
});
