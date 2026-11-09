import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAdminSessionRoutes } from '../src/adminSessionRoutes';
import { PERMISSIONS } from '../src/permissions';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

type StoreRow = Record<string, unknown>;

function enhanceRefreshTokenMock(prisma: ReturnType<typeof makeFakePrisma>) {
  const store = prisma._store.refreshTokens as StoreRow[];

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
          const av = a[field] ? new Date(a[field] as string).getTime() : 0;
          const bv = b[field] ? new Date(b[field] as string).getTime() : 0;
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

  prisma.refreshToken.updateMany = vi.fn(async ({ where, data }: any) => {
    const matching = store.filter((row) => {
      if (where.sessionId !== undefined) {
        if (typeof where.sessionId === 'string' && row.sessionId !== where.sessionId) return false;
        if (where.sessionId.not && row.sessionId === where.sessionId.not) return false;
      }
      if (where.userId !== undefined && row.userId !== where.userId) return false;
      if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
      if (where.revokedAt === null && row.revokedAt !== null) return false;
      return true;
    });
    matching.forEach((row) => Object.assign(row, data));
    return { count: matching.length };
  });
}

function seedSession(
  store: StoreRow[],
  overrides: Record<string, unknown> = {},
) {
  const row = {
    id: `rt-${store.length + 1}`,
    sessionId: crypto.randomUUID(),
    userId: 'u-target',
    companyId: 'c1',
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

function makeAdminSessionPrisma() {
  const users: Record<string, StoreRow> = {
    'u-owner': {
      id: 'u-owner',
      companyId: 'c1',
      employeeId: 'e-owner',
      name: 'Primary Owner',
      authorizationVersion: 1,
      role: {
        permissions: JSON.stringify([
          PERMISSIONS.ADMIN_FULL,
          PERMISSIONS.COMPANY_SESSIONS_MANAGE,
        ]),
      },
      employee: { departmentId: 'd1', status: 'active' },
    },
    'u-admin': {
      id: 'u-admin',
      companyId: 'c1',
      employeeId: 'e-admin',
      name: 'Security Admin',
      authorizationVersion: 2,
      role: {
        permissions: JSON.stringify([
          PERMISSIONS.COMPANY_SESSIONS_MANAGE,
          PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
          PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
        ]),
      },
      employee: { departmentId: 'd1', status: 'active' },
    },
    'u-peer': {
      id: 'u-peer',
      companyId: 'c1',
      employeeId: 'e-peer',
      name: 'Peer Manager',
      authorizationVersion: 1,
      role: {
        permissions: JSON.stringify([
          PERMISSIONS.COMPANY_SESSIONS_MANAGE,
          PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
          PERMISSIONS.PERMISSIONS_MANAGE_DEPARTMENT,
        ]),
      },
      employee: { departmentId: 'd1', status: 'active' },
    },
    'u-target': {
      id: 'u-target',
      companyId: 'c1',
      employeeId: 'e-target',
      name: 'Target Employee',
      authorizationVersion: 3,
      role: { permissions: JSON.stringify([PERMISSIONS.DASHBOARD_SELF]) },
      employee: { departmentId: 'd1', status: 'active' },
    },
    'u-foreign': {
      id: 'u-foreign',
      companyId: 'c2',
      employeeId: 'e-foreign',
      name: 'Foreign Employee',
      authorizationVersion: 1,
      role: { permissions: JSON.stringify([PERMISSIONS.DASHBOARD_SELF]) },
      employee: { departmentId: 'd9', status: 'active' },
    },
  };

  const prisma = makeFakePrisma();
  enhanceRefreshTokenMock(prisma);

  prisma.user.findFirst = vi.fn(async ({ where, select }: any = {}) => {
    const user = users[where.id];
    if (!user || user.companyId !== where.companyId) return null;

    const shaped: StoreRow = { id: user.id };
    if (select?.companyId) shaped.companyId = user.companyId;
    if (select?.employeeId) shaped.employeeId = user.employeeId;
    if (select?.name) shaped.name = user.name;
    if (select?.authorizationVersion) shaped.authorizationVersion = user.authorizationVersion;
    if (select?.role) {
      shaped.role = user.role;
    }
    if (select?.employee) {
      shaped.employee = user.employee ?? null;
    }
    return shaped;
  });

  prisma.companyOwnership.findFirst = vi.fn(async ({ where }: any = {}) => {
    if (where.userId === 'u-owner' && where.isPrimary === true) {
      return { id: 'ownership-owner', userId: 'u-owner' };
    }
    return null;
  });

  prisma.department.findMany = vi.fn(async ({ where }: any = {}) => {
    if (where.managerId === 'u-peer') return [{ id: 'd1' }];
    return [];
  });

  prisma.departmentManager.findMany = vi.fn(async ({ where }: any = {}) => {
    if (where.userId === 'u-peer') return [{ departmentId: 'd1' }];
    if (where.userId === 'u-target') return [{ departmentId: 'd1' }];
    return [];
  });

  prisma.accessGrant.findMany = vi.fn(async () => []);
  prisma.temporaryDelegation.findMany = vi.fn(async () => []);

  return { prisma, users };
}

function makeAdminSessionApp(prisma: ReturnType<typeof makeFakePrisma>) {
  const app = express();
  app.use(express.json());

  const requireAuth = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const header = req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const payload = jwt.verify(header.slice(7), TEST_SECRET) as {
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

  const checkPermission = (requiredPermission: string) =>
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const permissions = (req as express.Request & { user?: { permissions?: string[] } }).user?.permissions ?? [];
      if (
        permissions.includes(PERMISSIONS.ADMIN_FULL)
        || permissions.includes(requiredPermission)
      ) {
        return next();
      }
      return res.status(403).json({ error: 'Forbidden' });
    };

  registerAdminSessionRoutes({
    app,
    prisma,
    requireAuth,
    checkPermission,
  });

  return app;
}

describe('admin session routes', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let app: express.Express;
  let users: Record<string, StoreRow>;

  const adminToken = () => tokenFor({
    id: 'u-admin',
    companyId: 'c1',
    employeeId: 'e-admin',
    permissions: [
      PERMISSIONS.COMPANY_SESSIONS_MANAGE,
      PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
      PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
    ],
  });

  const peerToken = () => tokenFor({
    id: 'u-peer',
    companyId: 'c1',
    employeeId: 'e-peer',
    permissions: [
      PERMISSIONS.COMPANY_SESSIONS_MANAGE,
      PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
      PERMISSIONS.PERMISSIONS_MANAGE_DEPARTMENT,
    ],
  });

  const ownerToken = () => tokenFor({
    id: 'u-owner',
    companyId: 'c1',
    employeeId: 'e-owner',
    permissions: [PERMISSIONS.ADMIN_FULL, PERMISSIONS.COMPANY_SESSIONS_MANAGE],
  });

  beforeEach(() => {
    const fixture = makeAdminSessionPrisma();
    prisma = fixture.prisma;
    users = fixture.users;
    app = makeAdminSessionApp(prisma);
  });

  it('lists manageable user sessions without hash leakage or isCurrent', async () => {
    seedSession(prisma._store.refreshTokens);
    seedSession(prisma._store.refreshTokens, {
      sessionId: '22222222-2222-4222-8222-222222222222',
      deviceLabel: 'Browser',
      platform: 'web',
    });

    const response = await request(app)
      .get('/api/v2/security/users/u-target/sessions')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(JSON.stringify(response.body)).not.toMatch(/tokenHash|bindingHash/i);
    expect(response.body.every((row: Record<string, unknown>) => row.isCurrent === undefined)).toBe(true);

    const audit = prisma._store.auditLogs.at(-1);
    expect(audit.action).toBe('security.sessions.list');
    expect(JSON.parse(audit.details)).toEqual({
      targetUserId: 'u-target',
      sessionCount: 2,
    });
  });

  it('returns 403 when targeting the primary owner', async () => {
    const response = await request(app)
      .get('/api/v2/security/users/u-owner/sessions')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(403);
    expect(response.body.messageKey).toBe('security.sessions.forbidden');
  });

  it('returns 403 when a peer manager lacks peer-management authority', async () => {
    const response = await request(app)
      .get('/api/v2/security/users/u-target/sessions')
      .set('Authorization', `Bearer ${peerToken()}`);

    expect(response.status).toBe(403);
    expect(response.body.messageKey).toBe('security.sessions.forbidden');
  });

  it('returns opaque 404 for a cross-company user id', async () => {
    const response = await request(app)
      .get('/api/v2/security/users/u-foreign/sessions')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(response.status).toBe(404);
    expect(response.body.messageKey).toBe('security.sessions.user_not_found');
  });

  it('revokes all target sessions, audits, and notifies safely', async () => {
    seedSession(prisma._store.refreshTokens);
    seedSession(prisma._store.refreshTokens, {
      sessionId: '33333333-3333-4333-8333-333333333333',
    });

    const response = await request(app)
      .post('/api/v2/security/users/u-target/sessions/revoke-all')
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('Idempotency-Key', 'admin-revoke-001')
      .send({
        reason: 'Suspicious login activity reported by employee',
        expectedAuthorizationVersion: users['u-target'].authorizationVersion,
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ revokedCount: 2 });
    expect(prisma._store.refreshTokens.every((row: StoreRow) => row.revokedAt != null)).toBe(true);

    const revokeAllAudit = prisma._store.auditLogs.find(
      (row: StoreRow) => row.action === 'auth.session.revoke_all',
    );
    expect(revokeAllAudit).toBeTruthy();
    expect(JSON.parse(revokeAllAudit.details)).toEqual({ revokedCount: 2 });

    const adminAudit = prisma._store.auditLogs.find(
      (row: StoreRow) => row.action === 'security.sessions.revoke_all',
    );
    expect(adminAudit).toBeTruthy();
    expect(JSON.parse(adminAudit.details)).toEqual({
      targetUserId: 'u-target',
      revokedCount: 2,
      revokedReason: 'Suspicious login activity reported by employee',
    });

    const notification = prisma._store.notifications.at(-1);
    expect(notification).toMatchObject({
      userId: 'u-target',
      category: 'security',
      routeKey: 'auth.sessions',
      resourceType: 'security',
    });
    expect(notification.resourceId).toBeFalsy();
    expect(JSON.stringify(notification)).not.toMatch(/tokenHash|bindingHash|Bearer|password|refreshToken/i);
  });

  it('returns 403 when revoke-all targets the primary owner', async () => {
    const response = await request(app)
      .post('/api/v2/security/users/u-owner/sessions/revoke-all')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({
        reason: 'Attempted owner session revocation',
        expectedAuthorizationVersion: users['u-owner'].authorizationVersion,
      });

    expect(response.status).toBe(403);
    expect(response.body.messageKey).toBe('security.sessions.forbidden');
  });

  it('returns 412 when expectedAuthorizationVersion is stale', async () => {
    seedSession(prisma._store.refreshTokens);

    const response = await request(app)
      .post('/api/v2/security/users/u-target/sessions/revoke-all')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        reason: 'Stale version guard test',
        expectedAuthorizationVersion: 99,
      });

    expect(response.status).toBe(412);
    expect(response.body.messageKey).toBe('security.sessions.stale_version');
    expect(prisma._store.refreshTokens.every((row: StoreRow) => row.revokedAt == null)).toBe(true);
  });

  it('returns opaque 404 for revoke-all on a cross-company user id', async () => {
    const response = await request(app)
      .post('/api/v2/security/users/u-foreign/sessions/revoke-all')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        reason: 'Cross-company revoke attempt',
        expectedAuthorizationVersion: users['u-foreign'].authorizationVersion,
      });

    expect(response.status).toBe(404);
    expect(response.body.messageKey).toBe('security.sessions.user_not_found');
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });
});
