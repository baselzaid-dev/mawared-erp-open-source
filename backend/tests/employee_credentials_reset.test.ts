import bcrypt from 'bcrypt';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_RESET_REASONS,
  createEmployeeAdminResetRateLimiter,
  registerEmployeeCredentialResetRoutes,
  resetEmployeeCredential,
} from '../src/employeeCredentialReset';
import {
  InMemoryRecoveryRateLimitStore,
  RecoveryRateLimiter,
  DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
} from '../src/credentialRecovery';
import { OneTimePasswordSecret } from '../src/credentialSecrets';
import { PERMISSIONS } from '../src/permissions';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

type StoreRow = Record<string, unknown>;

const RATE_PEPPER = 'e2-test-recovery-rate-limit-pepper-32chars!!';

function makeCredentialResetPrisma(passwordHash: string) {
  const credentialVersions: Record<string, number> = {
    'u-owner': 1,
    'u-hr': 1,
    'u-target': 3,
    'u-self': 2,
    'u-foreign': 1,
    'u-peer': 1,
    'u-dept-mgr': 1,
    'u-out-dept': 1,
    'u-inactive': 1,
    'u-archived': 1,
  };
  const passwordChangedAt: Record<string, Date | null> = {
    'u-target': new Date('2026-01-15T10:00:00.000Z'),
    'u-self': null,
    'u-owner': null,
    'u-hr': null,
    'u-foreign': null,
    'u-peer': null,
    'u-dept-mgr': null,
    'u-out-dept': null,
    'u-inactive': null,
    'u-archived': null,
  };
  const accountStatus: Record<string, string> = {
    'u-owner': 'active',
    'u-hr': 'active',
    'u-target': 'active',
    'u-self': 'active',
    'u-foreign': 'active',
    'u-peer': 'active',
    'u-dept-mgr': 'active',
    'u-out-dept': 'active',
    'u-inactive': 'disabled',
    'u-archived': 'archived',
  };

  const users: Record<string, StoreRow> = {
    'u-owner': {
      id: 'u-owner',
      companyId: 'c1',
      employeeId: 'e-owner',
      name: 'Primary Owner',
      password: passwordHash,
      accountStatus: 'active',
      authorizationVersion: 1,
      role: { permissions: JSON.stringify([PERMISSIONS.ADMIN_FULL]) },
      employee: { departmentId: 'd1', status: 'active', archivedAt: null },
    },
    'u-hr': {
      id: 'u-hr',
      companyId: 'c1',
      employeeId: 'e-hr',
      name: 'HR Admin',
      password: passwordHash,
      accountStatus: 'active',
      authorizationVersion: 1,
      role: {
        permissions: JSON.stringify([
          PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
          PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
          PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
        ]),
      },
      employee: { departmentId: 'd1', status: 'active', archivedAt: null },
    },
    'u-target': {
      id: 'u-target',
      companyId: 'c1',
      employeeId: 'e-target',
      name: 'Target Employee',
      password: passwordHash,
      accountStatus: 'active',
      authorizationVersion: 1,
      role: { permissions: JSON.stringify([PERMISSIONS.DASHBOARD_SELF]) },
      employee: { departmentId: 'd1', status: 'active', archivedAt: null },
    },
    'u-self': {
      id: 'u-self',
      companyId: 'c1',
      employeeId: 'e-self',
      name: 'Self Actor',
      password: passwordHash,
      accountStatus: 'active',
      authorizationVersion: 1,
      role: {
        permissions: JSON.stringify([
          PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
          PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
          PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
        ]),
      },
      employee: { departmentId: 'd1', status: 'active', archivedAt: null },
    },
    'u-peer': {
      id: 'u-peer',
      companyId: 'c1',
      employeeId: 'e-peer',
      name: 'Peer Admin',
      password: passwordHash,
      accountStatus: 'active',
      authorizationVersion: 1,
      role: {
        permissions: JSON.stringify([
          PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
          PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
          PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
        ]),
      },
      employee: { departmentId: 'd1', status: 'active', archivedAt: null },
    },
    'u-dept-mgr': {
      id: 'u-dept-mgr',
      companyId: 'c1',
      employeeId: 'e-dept-mgr',
      name: 'Dept Manager',
      password: passwordHash,
      accountStatus: 'active',
      authorizationVersion: 1,
      role: {
        permissions: JSON.stringify([
          PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
          PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
          PERMISSIONS.PERMISSIONS_MANAGE_DEPARTMENT,
        ]),
      },
      employee: { departmentId: 'd1', status: 'active', archivedAt: null },
    },
    'u-out-dept': {
      id: 'u-out-dept',
      companyId: 'c1',
      employeeId: 'e-out-dept',
      name: 'Other Dept',
      password: passwordHash,
      accountStatus: 'active',
      authorizationVersion: 1,
      role: { permissions: JSON.stringify([PERMISSIONS.DASHBOARD_SELF]) },
      employee: { departmentId: 'd2', status: 'active', archivedAt: null },
    },
    'u-inactive': {
      id: 'u-inactive',
      companyId: 'c1',
      employeeId: 'e-inactive',
      name: 'Inactive User',
      password: passwordHash,
      accountStatus: 'disabled',
      authorizationVersion: 1,
      role: { permissions: JSON.stringify([PERMISSIONS.DASHBOARD_SELF]) },
      employee: { departmentId: 'd1', status: 'active', archivedAt: null },
    },
    'u-archived': {
      id: 'u-archived',
      companyId: 'c1',
      employeeId: 'e-archived',
      name: 'Archived Emp',
      password: passwordHash,
      accountStatus: 'archived',
      authorizationVersion: 1,
      role: { permissions: JSON.stringify([PERMISSIONS.DASHBOARD_SELF]) },
      employee: { departmentId: 'd1', status: 'inactive', archivedAt: new Date('2026-01-01') },
    },
    'u-foreign': {
      id: 'u-foreign',
      companyId: 'c2',
      employeeId: 'e-foreign',
      name: 'Foreign Employee',
      password: passwordHash,
      accountStatus: 'active',
      authorizationVersion: 1,
      role: { permissions: JSON.stringify([PERMISSIONS.DASHBOARD_SELF]) },
      employee: { departmentId: 'd9', status: 'active', archivedAt: null },
    },
  };

  const employees: StoreRow[] = [
    { id: 'e-owner', companyId: 'c1', departmentId: 'd1', status: 'active', archivedAt: null, user: users['u-owner'] },
    { id: 'e-hr', companyId: 'c1', departmentId: 'd1', status: 'active', archivedAt: null, user: users['u-hr'] },
    { id: 'e-target', companyId: 'c1', departmentId: 'd1', status: 'active', archivedAt: null, user: users['u-target'] },
    { id: 'e-self', companyId: 'c1', departmentId: 'd1', status: 'active', archivedAt: null, user: users['u-self'] },
    { id: 'e-peer', companyId: 'c1', departmentId: 'd1', status: 'active', archivedAt: null, user: users['u-peer'] },
    { id: 'e-dept-mgr', companyId: 'c1', departmentId: 'd1', status: 'active', archivedAt: null, user: users['u-dept-mgr'] },
    { id: 'e-out-dept', companyId: 'c1', departmentId: 'd2', status: 'active', archivedAt: null, user: users['u-out-dept'] },
    { id: 'e-inactive', companyId: 'c1', departmentId: 'd1', status: 'active', archivedAt: null, user: users['u-inactive'] },
    {
      id: 'e-archived',
      companyId: 'c1',
      departmentId: 'd1',
      status: 'inactive',
      archivedAt: new Date('2026-01-01'),
      user: users['u-archived'],
    },
    { id: 'e-orphan', companyId: 'c1', departmentId: 'd1', status: 'active', archivedAt: null, user: null },
    { id: 'e-foreign', companyId: 'c2', departmentId: 'd9', status: 'active', archivedAt: null, user: users['u-foreign'] },
  ];

  const prisma = makeFakePrisma();
  const mfaByUser: Record<string, StoreRow> = {
    'u-target': {
      userId: 'u-target',
      companyId: 'c1',
      state: 'enrolled',
      secretCiphertext: 'cipher-keep',
      backupCodeHashes: '[]',
    },
  };
  const ownership = {
    id: 'own-1',
    companyId: 'c1',
    userId: 'u-owner',
    isPrimary: true,
    status: 'active',
  };

  prisma.user.findFirst = vi.fn(async ({ where, select }: any = {}) => {
    const user = users[where.id as string];
    if (!user || user.companyId !== where.companyId) return null;
    if (where.accountStatus && user.accountStatus !== where.accountStatus) return null;
    const row = {
      ...user,
      credentialVersion: credentialVersions[user.id as string],
      passwordChangedAt: passwordChangedAt[user.id as string] ?? null,
      accountStatus: accountStatus[user.id as string] ?? user.accountStatus,
      password: user.password,
    };
    if (select) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(select)) {
        if (key === 'employee') out.employee = user.employee ?? null;
        else if (key === 'role') out.role = user.role;
        else if (key in row) out[key] = (row as any)[key];
      }
      return out;
    }
    return row;
  });

  prisma.user.updateMany = vi.fn(async ({ where, data }: any) => {
    const user = users[where.id as string];
    if (!user || user.companyId !== where.companyId) return { count: 0 };
    if (where.accountStatus && (accountStatus[where.id] ?? user.accountStatus) !== where.accountStatus) {
      return { count: 0 };
    }
    if (where.credentialVersion !== credentialVersions[where.id]) return { count: 0 };
    if (data.password) user.password = data.password;
    if (data.mustChangePassword !== undefined) user.mustChangePassword = data.mustChangePassword;
    if (data.temporaryPasswordExpiresAt !== undefined) {
      user.temporaryPasswordExpiresAt = data.temporaryPasswordExpiresAt;
    }
    if (data.passwordChangedAt !== undefined) {
      passwordChangedAt[where.id] = data.passwordChangedAt;
    }
    if (data.credentialVersion?.increment) {
      credentialVersions[where.id] += data.credentialVersion.increment;
    }
    return { count: 1 };
  });

  prisma.employee.findFirst = vi.fn(async ({ where, select }: any = {}) => {
    const row = employees.find((employee) =>
      employee.id === where.id && employee.companyId === where.companyId,
    );
    if (!row) return null;
    if (select?.user) {
      const linked = row.user as StoreRow | null;
      if (!linked) {
        return {
          id: row.id,
          companyId: row.companyId,
          departmentId: row.departmentId,
          status: row.status,
          archivedAt: row.archivedAt,
          user: null,
        };
      }
      const user = users[linked.id as string];
      return {
        id: row.id,
        companyId: row.companyId,
        departmentId: row.departmentId,
        status: row.status,
        archivedAt: row.archivedAt,
        user: user ? {
          id: user.id,
          companyId: user.companyId,
          employeeId: user.employeeId,
          accountStatus: accountStatus[user.id as string],
          credentialVersion: credentialVersions[user.id as string],
          password: user.password,
          authorizationVersion: (user.authorizationVersion as number) ?? 1,
        } : null,
      };
    }
    return row;
  });

  prisma.companyOwnership.findFirst = vi.fn(async ({ where }: any = {}) => {
    if (where.companyId && where.companyId !== 'c1') return null;
    if (where.userId === 'u-owner' && where.isPrimary === true && (where.status === 'active' || !where.status)) {
      return ownership;
    }
    if (where.isPrimary === true && where.status === 'active' && !where.userId) {
      return ownership;
    }
    return null;
  });

  prisma.department.findMany = vi.fn(async ({ where }: any = {}) => {
    if (where?.managerId === 'u-dept-mgr') return [{ id: 'd1' }];
    return [];
  });
  prisma.departmentManager.findMany = vi.fn(async ({ where }: any = {}) => {
    if (where?.userId === 'u-dept-mgr') return [{ departmentId: 'd1' }];
    return [];
  });
  prisma.accessGrant.findMany = vi.fn(async () => []);
  prisma.temporaryDelegation.findMany = vi.fn(async () => []);
  prisma.userMfaCredential = {
    findUnique: vi.fn(async ({ where }: any) => mfaByUser[where.userId] ?? null),
    findFirst: vi.fn(async ({ where }: any) => mfaByUser[where.userId] ?? null),
  };

  prisma.refreshToken.updateMany = vi.fn(async ({ where, data }: any) => {
    const matching = prisma._store.refreshTokens.filter((row: StoreRow) =>
      row.userId === where.userId
      && row.companyId === where.companyId
      && (where.revokedAt !== null || row.revokedAt == null),
    );
    matching.forEach((row: StoreRow) => Object.assign(row, data));
    return { count: matching.length };
  });

  return {
    prisma,
    stores: {
      users,
      employees,
      credentialVersions,
      passwordChangedAt,
      accountStatus,
      mfaByUser,
      ownership,
    },
  };
}

function makeCredentialResetApp(
  prisma: ReturnType<typeof makeFakePrisma>,
  rateLimiter: ReturnType<typeof createEmployeeAdminResetRateLimiter> = null,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { requestId?: string }).requestId = 'req-test-1';
    next();
  });

  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const header = req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ code: 'Unauthorized', messageKey: 'credentials.unauthorized' });
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
      return res.status(401).json({ code: 'Unauthorized', messageKey: 'credentials.unauthorized' });
    }
  };

  const checkPermission = (requiredPermission: string) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const permissions = (req as express.Request & { user?: { permissions?: string[] } }).user?.permissions ?? [];
      if (
        permissions.includes(PERMISSIONS.ADMIN_FULL)
        || permissions.includes(requiredPermission)
      ) {
        return next();
      }
      return res.status(403).json({ code: 'Forbidden', messageKey: 'credentials.reset_forbidden' });
    };

  registerEmployeeCredentialResetRoutes({
    app,
    prisma,
    requireAuth,
    checkPermission,
    rateLimiter,
  });
  return app;
}

describe('employee credential reset routes (E2)', () => {
  let passwordHash = '';
  let prisma: ReturnType<typeof makeFakePrisma>;
  let stores: ReturnType<typeof makeCredentialResetPrisma>['stores'];
  let app: express.Express;

  beforeEach(async () => {
    passwordHash = await bcrypt.hash('Seed-password-1', 4);
    const setup = makeCredentialResetPrisma(passwordHash);
    prisma = setup.prisma;
    stores = setup.stores;
    app = makeCredentialResetApp(prisma, null);

    prisma._store.refreshTokens.push(
      {
        id: 'rt-1',
        userId: 'u-target',
        companyId: 'c1',
        tokenHash: 'hash-1',
        revokedAt: null,
        revokedReason: null,
        credentialVersion: 3,
      },
      {
        id: 'rt-2',
        userId: 'u-target',
        companyId: 'c1',
        tokenHash: 'hash-2',
        revokedAt: null,
        revokedReason: null,
        credentialVersion: 3,
      },
      {
        id: 'rt-old',
        userId: 'u-target',
        companyId: 'c1',
        tokenHash: 'hash-old',
        revokedAt: new Date('2026-01-01'),
        revokedReason: 'prior',
        credentialVersion: 2,
      },
    );
  });

  const hrToken = () => tokenFor({
    id: 'u-hr',
    companyId: 'c1',
    employeeId: 'e-hr',
    permissions: [
      PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
      PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
      PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
    ],
    credentialVersion: 1,
  });

  const selfToken = () => tokenFor({
    id: 'u-self',
    companyId: 'c1',
    employeeId: 'e-self',
    permissions: [
      PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
      PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
      PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
    ],
    credentialVersion: 2,
  });

  const deptMgrToken = () => tokenFor({
    id: 'u-dept-mgr',
    companyId: 'c1',
    employeeId: 'e-dept-mgr',
    permissions: [
      PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
      PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
      PERMISSIONS.PERMISSIONS_MANAGE_DEPARTMENT,
    ],
    credentialVersion: 1,
  });

  const validPayload = {
    reason: 'forgotten_password' as const,
    expectedCredentialVersion: 3,
  };

  it('resets credentials, revokes sessions, audits safely, and returns a one-time DTO', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-target/credentials/reset')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send(validPayload);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mustChangePassword: true,
      credentialVersion: 4,
    });
    expect(typeof res.body.temporaryPassword).toBe('string');
    expect(res.body.temporaryPassword.length).toBeGreaterThan(10);
    expect(typeof res.body.expiresAt).toBe('string');
    expect(stores.credentialVersions['u-target']).toBe(4);
    expect(stores.passwordChangedAt['u-target']).toBeTruthy();
    expect(stores.users['u-target'].mustChangePassword).toBe(true);
    expect(await bcrypt.compare(res.body.temporaryPassword, stores.users['u-target'].password as string)).toBe(true);

    expect(prisma._store.refreshTokens.filter((row: StoreRow) => row.userId === 'u-target' && row.id !== 'rt-old')
      .every((row: StoreRow) => row.revokedAt != null && row.revokedReason === 'credential_reset')).toBe(true);
    expect(prisma._store.refreshTokens.find((row: StoreRow) => row.id === 'rt-old')?.revokedReason).toBe('prior');

    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'employee.credentials.reset',
        userId: 'u-hr',
      }),
    }));
    const auditCall = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const auditJson = JSON.stringify(auditCall?.[0]?.data ?? {});
    expect(auditJson).not.toMatch(/temporaryPassword|"password"|Seed-password/i);
    expect(auditJson).toContain('forgotten_password');

    expect(prisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 'u-target',
        category: 'security',
        routeKey: 'auth.change_password',
        resourceType: 'security',
      }),
    }));
    const notifyCall = (prisma.notification.create as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const notifyJson = JSON.stringify(notifyCall?.[0]?.data ?? {});
    expect(notifyJson).not.toContain(res.body.temporaryPassword);
    expect(notifyJson).not.toMatch(/temporaryPassword|tokenHash|refreshToken|Bearer|mfaSecret/i);
    expect(notifyCall?.[0]?.data?.resourceId).toBeUndefined();
    expect(stores.mfaByUser['u-target'].secretCiphertext).toBe('cipher-keep');
    expect(stores.ownership.userId).toBe('u-owner');
  });

  it('rejects missing permission (AT-CR-23)', async () => {
    const token = tokenFor({
      id: 'u-target',
      companyId: 'c1',
      employeeId: 'e-target',
      permissions: [PERMISSIONS.DASHBOARD_SELF],
    });
    const res = await request(app)
      .post('/api/v2/employees/e-target/credentials/reset')
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload);
    expect(res.status).toBe(403);
  });

  it('returns 412 when expectedCredentialVersion is stale and performs no write', async () => {
    const before = stores.credentialVersions['u-target'];
    const res = await request(app)
      .post('/api/v2/employees/e-target/credentials/reset')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ ...validPayload, expectedCredentialVersion: 2 });

    expect(res.status).toBe(412);
    expect(res.body.messageKey).toBe('credentials.stale_credential_version');
    expect(res.body.temporaryPassword).toBeUndefined();
    expect(stores.credentialVersions['u-target']).toBe(before);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('full request replay after success returns 412 without a second secret (AT-CR-30/46)', async () => {
    const first = await request(app)
      .post('/api/v2/employees/e-target/credentials/reset')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send(validPayload);
    expect(first.status).toBe(200);
    const secret = first.body.temporaryPassword;

    const second = await request(app)
      .post('/api/v2/employees/e-target/credentials/reset')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send(validPayload);
    expect(second.status).toBe(412);
    expect(second.body.temporaryPassword).toBeUndefined();
    expect(stores.credentialVersions['u-target']).toBe(4);
    expect(await bcrypt.compare(secret, stores.users['u-target'].password as string)).toBe(true);
  });

  it('returns 403 when target is the primary owner (AT-CR-25)', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-owner/credentials/reset')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ ...validPayload, expectedCredentialVersion: 1 });

    expect(res.status).toBe(403);
    expect(res.body.messageKey).toBe('credentials.reset_forbidden');
    expect(JSON.stringify(res.body)).not.toMatch(/protected_owner|peer_manager/);
  });

  it('returns 403 when actor resets their own credentials', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-self/credentials/reset')
      .set('Authorization', `Bearer ${selfToken()}`)
      .send({ ...validPayload, expectedCredentialVersion: 2 });

    expect(res.status).toBe(403);
    expect(res.body.messageKey).toBe('credentials.reset_forbidden');
  });

  it('returns 403 when targeting a peer admin without principals.manage_peers (AT-CR-26)', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-peer/credentials/reset')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ ...validPayload, expectedCredentialVersion: 1 });
    expect(res.status).toBe(403);
    expect(res.body.messageKey).toBe('credentials.reset_forbidden');
  });

  it('allows department manager in-scope and denies out-of-scope (AT-CR-24)', async () => {
    const inScope = await request(app)
      .post('/api/v2/employees/e-target/credentials/reset')
      .set('Authorization', `Bearer ${deptMgrToken()}`)
      .send(validPayload);
    expect(inScope.status).toBe(200);

    stores.credentialVersions['u-out-dept'] = 1;
    const outScope = await request(app)
      .post('/api/v2/employees/e-out-dept/credentials/reset')
      .set('Authorization', `Bearer ${deptMgrToken()}`)
      .send({ reason: 'access_recovery', expectedCredentialVersion: 1 });
    expect(outScope.status).toBe(403);
    expect(outScope.body.messageKey).toBe('credentials.reset_forbidden');
  });

  it('returns opaque 404 for foreign-company and nonexistent targets (AT-CR-47)', async () => {
    const foreign = await request(app)
      .post('/api/v2/employees/e-foreign/credentials/reset')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ ...validPayload, expectedCredentialVersion: 1 });
    const missing = await request(app)
      .post('/api/v2/employees/e-missing/credentials/reset')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ ...validPayload, expectedCredentialVersion: 1 });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.messageKey).toBe(missing.body.messageKey);
  });

  it('denies inactive, archived, and orphan targets opaquely', async () => {
    for (const [employeeId, version] of [
      ['e-inactive', 1],
      ['e-archived', 1],
      ['e-orphan', 1],
    ] as const) {
      const res = await request(app)
        .post(`/api/v2/employees/${employeeId}/credentials/reset`)
        .set('Authorization', `Bearer ${hrToken()}`)
        .send({ reason: 'administrative_rotation', expectedCredentialVersion: version });
      expect(res.status).toBe(404);
      expect(res.body.messageKey).toBe('credentials.employee_not_found');
    }
  });

  it('rejects unknown reason, free text, secret-shaped reason, and unknown fields', async () => {
    const cases = [
      { reason: 'other', expectedCredentialVersion: 3 },
      { reason: 'Employee forgot password in person', expectedCredentialVersion: 3 },
      { reason: 'TempPass123!', expectedCredentialVersion: 3 },
      { reason: 'user@example.com', expectedCredentialVersion: 3 },
      { reason: 'https://evil.example/reset', expectedCredentialVersion: 3 },
      { reason: 'forgotten_password', expectedCredentialVersion: 3, extra: true },
      { expectedCredentialVersion: 3 },
      { reason: 'forgotten_password', expectedCredentialVersion: 0 },
      { reason: 'forgotten_password', expectedCredentialVersion: -1 },
      { reason: 'forgotten_password', expectedCredentialVersion: 1.5 },
    ];
    for (const body of cases) {
      const payload = { ...body } as Record<string, unknown>;
      if (payload.extra) {
        delete payload.extra;
        payload.note = 'nope';
      }
      const res = await request(app)
        .post('/api/v2/employees/e-target/credentials/reset')
        .set('Authorization', `Bearer ${hrToken()}`)
        .send(payload);
      expect(res.status).toBe(400);
      expect(res.body.messageKey).toBe('credentials.invalid_request');
    }
    expect(CREDENTIAL_RESET_REASONS).toEqual([
      'forgotten_password',
      'suspected_compromise',
      'administrative_rotation',
      'access_recovery',
    ]);
  });

  it('never serializes OneTimePasswordSecret via JSON/inspect', () => {
    const secret = new OneTimePasswordSecret('SuperSecretTemp-99');
    expect(JSON.stringify({ secret })).toContain('[OneTimePasswordSecret]');
    expect(String(secret)).toBe('[OneTimePasswordSecret]');
    expect(secret.reveal()).toBe('SuperSecretTemp-99');
  });

  it('rate-limits actor/target/company/global before generating a password', async () => {
    let now = Date.now();
    const store = new InMemoryRecoveryRateLimitStore();
    const limiter = new RecoveryRateLimiter(
      store,
      RATE_PEPPER,
      {
        ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
        employee_admin_reset: {
          actor: { windowMs: 60_000, blockLimit: 1, alertLimit: 1 },
          target: { windowMs: 60_000, blockLimit: 10, alertLimit: 5 },
          company: { windowMs: 60_000, blockLimit: 10, alertLimit: 5 },
          global: { windowMs: 60_000, blockLimit: 100, alertLimit: 50 },
        },
      },
      () => new Date(now),
    );
    const limitedApp = makeCredentialResetApp(prisma, limiter);

    const first = await request(limitedApp)
      .post('/api/v2/employees/e-target/credentials/reset')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send(validPayload);
    expect(first.status).toBe(200);

    stores.credentialVersions['u-target'] = 4;
    const second = await request(limitedApp)
      .post('/api/v2/employees/e-target/credentials/reset')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ reason: 'access_recovery', expectedCredentialVersion: 4 });
    expect(second.status).toBe(429);
    expect(second.body.messageKey).toBe('credentials.reset_rate_limited');
    expect(second.body.temporaryPassword).toBeUndefined();
    expect(stores.credentialVersions['u-target']).toBe(4);

    const bucketKeys = [...(store as any).buckets?.keys?.() ?? []];
    const serialized = JSON.stringify(bucketKeys);
    expect(serialized).not.toContain('u-hr');
    expect(serialized).not.toContain('e-target');
    expect(serialized).not.toContain('c1');
  });

  it('ignores stale JWT permission hints once persisted reset permission is revoked', async () => {
    const beforeHash = stores.users['u-target'].password;
    const beforeVersion = stores.credentialVersions['u-target'];
    const beforeAudit = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls.length;
    const beforeNotify = (prisma.notification.create as ReturnType<typeof vi.fn>).mock.calls.length;

    // Persist role without reset capability while the caller still carries a stale hint.
    stores.users['u-hr'].role = {
      permissions: JSON.stringify([
        PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
        PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
      ]),
    };

    await expect(resetEmployeeCredential({
      prisma: prisma as any,
      actor: {
        id: 'u-hr',
        companyId: 'c1',
        employeeId: 'e-hr',
        permissions: [
          PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
          PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
          PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
        ],
      },
      employeeId: 'e-target',
      reason: 'forgotten_password',
      expectedCredentialVersion: 3,
      rateLimiter: null,
    })).rejects.toMatchObject({
      status: 403,
      messageKey: 'credentials.reset_forbidden',
    });

    expect(stores.users['u-target'].password).toBe(beforeHash);
    expect(stores.credentialVersions['u-target']).toBe(beforeVersion);
    expect((prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(beforeAudit);
    expect((prisma.notification.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(beforeNotify);
    expect(prisma._store.refreshTokens.filter((row: StoreRow) =>
      row.userId === 'u-target' && row.revokedReason === 'credential_reset',
    )).toHaveLength(0);
  });
});

describe('resetEmployeeCredential service helpers', () => {
  it('createEmployeeAdminResetRateLimiter requires a 32+ char pepper', () => {
    const prisma = makeFakePrisma();
    expect(createEmployeeAdminResetRateLimiter(prisma as any, 'short', { useInMemoryStore: true })).toBeNull();
    expect(createEmployeeAdminResetRateLimiter(prisma as any, RATE_PEPPER, { useInMemoryStore: true })).toBeTruthy();
  });
});
