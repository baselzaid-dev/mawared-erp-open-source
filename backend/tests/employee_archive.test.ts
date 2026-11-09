import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerEmployeeArchiveRoutes } from '../src/employeeArchive';
import { PERMISSIONS } from '../src/permissions';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

type StoreRow = Record<string, unknown>;

function makeEmployeeArchivePrisma() {
  const fixedUpdatedAt = new Date('2026-07-19T10:00:00.000Z');
  const archivedUpdatedAt = new Date('2026-07-19T11:00:00.000Z');

  const users: Record<string, StoreRow> = {
    'u-owner': {
      id: 'u-owner',
      companyId: 'c1',
      employeeId: 'e-owner',
      name: 'Primary Owner',
      email: 'owner@fixture-2.example.test',
      accountStatus: 'active',
      authorizationVersion: 1,
      role: { permissions: JSON.stringify([PERMISSIONS.ADMIN_FULL]) },
      employee: { departmentId: 'd1', status: 'active' },
    },
    'u-hr': {
      id: 'u-hr',
      companyId: 'c1',
      employeeId: 'e-hr',
      name: 'HR Admin',
      email: 'hr@fixture-2.example.test',
      accountStatus: 'active',
      authorizationVersion: 1,
      role: {
        permissions: JSON.stringify([
          PERMISSIONS.EMPLOYEES_ARCHIVE,
          PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
          PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
        ]),
      },
      employee: { departmentId: 'd1', status: 'active' },
    },
    'u-target': {
      id: 'u-target',
      companyId: 'c1',
      employeeId: 'e-target',
      name: 'Target Employee',
      email: 'target@fixture-2.example.test',
      accountStatus: 'active',
      authorizationVersion: 1,
      role: { permissions: JSON.stringify([PERMISSIONS.DASHBOARD_SELF]) },
      employee: { departmentId: 'd1', status: 'active' },
    },
    'u-self': {
      id: 'u-self',
      companyId: 'c1',
      employeeId: 'e-self',
      name: 'Self Actor',
      email: 'self@fixture-2.example.test',
      accountStatus: 'active',
      authorizationVersion: 1,
      role: {
        permissions: JSON.stringify([
          PERMISSIONS.EMPLOYEES_ARCHIVE,
          PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
          PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
        ]),
      },
      employee: { departmentId: 'd1', status: 'active' },
    },
    'u-archived': {
      id: 'u-archived',
      companyId: 'c1',
      employeeId: 'e-archived',
      name: 'Archived Employee',
      email: 'archived@fixture-2.example.test',
      accountStatus: 'archived',
      authorizationVersion: 1,
      role: { permissions: JSON.stringify([PERMISSIONS.DASHBOARD_SELF]) },
      employee: { departmentId: 'd1', status: 'inactive' },
    },
    'u-foreign': {
      id: 'u-foreign',
      companyId: 'c2',
      employeeId: 'e-foreign',
      name: 'Foreign Employee',
      email: 'foreign@fixture-2.example.test',
      accountStatus: 'active',
      authorizationVersion: 1,
      role: { permissions: JSON.stringify([PERMISSIONS.DASHBOARD_SELF]) },
      employee: { departmentId: 'd9', status: 'active' },
    },
  };

  const employees: StoreRow[] = [
    {
      id: 'e-owner',
      companyId: 'c1',
      departmentId: 'd1',
      employeeNum: '0001',
      jobTitle: 'Owner',
      joiningDate: new Date('2024-01-01T00:00:00.000Z'),
      status: 'active',
      archivedAt: null,
      archivedByUserId: null,
      archiveReason: null,
      createdAt: fixedUpdatedAt,
      updatedAt: fixedUpdatedAt,
      user: users['u-owner'],
      department: { id: 'd1', name: 'Operations' },
    },
    {
      id: 'e-hr',
      companyId: 'c1',
      departmentId: 'd1',
      employeeNum: '0002',
      jobTitle: 'HR Admin',
      joiningDate: new Date('2024-01-01T00:00:00.000Z'),
      status: 'active',
      archivedAt: null,
      archivedByUserId: null,
      archiveReason: null,
      createdAt: fixedUpdatedAt,
      updatedAt: fixedUpdatedAt,
      user: users['u-hr'],
      department: { id: 'd1', name: 'Operations' },
    },
    {
      id: 'e-target',
      companyId: 'c1',
      departmentId: 'd1',
      employeeNum: '1001',
      jobTitle: 'Staff Member',
      joiningDate: new Date('2024-02-01T00:00:00.000Z'),
      status: 'active',
      archivedAt: null,
      archivedByUserId: null,
      archiveReason: null,
      createdAt: fixedUpdatedAt,
      updatedAt: fixedUpdatedAt,
      user: users['u-target'],
      department: { id: 'd1', name: 'Operations' },
    },
    {
      id: 'e-self',
      companyId: 'c1',
      departmentId: 'd1',
      employeeNum: '1002',
      jobTitle: 'Self Actor',
      joiningDate: new Date('2024-02-01T00:00:00.000Z'),
      status: 'active',
      archivedAt: null,
      archivedByUserId: null,
      archiveReason: null,
      createdAt: fixedUpdatedAt,
      updatedAt: fixedUpdatedAt,
      user: users['u-self'],
      department: { id: 'd1', name: 'Operations' },
    },
    {
      id: 'e-archived',
      companyId: 'c1',
      departmentId: 'd1',
      employeeNum: '1003',
      jobTitle: 'Former Staff',
      joiningDate: new Date('2024-02-01T00:00:00.000Z'),
      status: 'inactive',
      archivedAt: archivedUpdatedAt,
      archivedByUserId: 'u-hr',
      archiveReason: 'End of contract',
      createdAt: fixedUpdatedAt,
      updatedAt: archivedUpdatedAt,
      user: users['u-archived'],
      department: { id: 'd1', name: 'Operations' },
    },
    {
      id: 'e-foreign',
      companyId: 'c2',
      departmentId: 'd9',
      employeeNum: '9001',
      jobTitle: 'Foreign Staff',
      joiningDate: new Date('2024-02-01T00:00:00.000Z'),
      status: 'active',
      archivedAt: null,
      archivedByUserId: null,
      archiveReason: null,
      createdAt: fixedUpdatedAt,
      updatedAt: fixedUpdatedAt,
      user: users['u-foreign'],
      department: { id: 'd9', name: 'Other Co' },
    },
  ];

  const loginIdentities: StoreRow[] = [
    {
      id: 'li-archived-email',
      companyId: 'c1',
      userId: 'u-archived',
      type: 'email',
      normalizedIdentifier: 'archived@fixture-2.example.test',
    },
    {
      id: 'li-archived-num',
      companyId: 'c1',
      userId: 'u-archived',
      type: 'employee_number',
      normalizedIdentifier: '1003',
    },
  ];

  const prisma = makeFakePrisma();

  prisma.user.findFirst = vi.fn(async ({ where, select }: any = {}) => {
    const user = users[where.id];
    if (!user || user.companyId !== where.companyId) return null;
    if (select?.employee) {
      return { ...user, employee: user.employee ?? null };
    }
    if (select?.accountStatus || select?.email || select?.name || select?.roleId || select?.role) {
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        accountStatus: user.accountStatus,
        authorizationVersion: user.authorizationVersion,
        employeeId: user.employeeId,
        role: user.role,
        roleId: 'role-employee',
        employee: user.employee ?? null,
      };
    }
    return user;
  });

  prisma.user.update = vi.fn(async ({ where, data }: any) => {
    const user = users[where.id];
    if (!user) throw new Error('user not found');
    Object.assign(user, data);
    const employee = employees.find((row) => row.id === user.employeeId);
    if (employee?.user) {
      (employee.user as StoreRow).accountStatus = user.accountStatus;
    }
    return { id: where.id, ...user, ...data };
  });

  prisma.employee.findFirst = vi.fn(async ({ where, include }: any = {}) => {
    const row = employees.find((employee) => {
      if (where.id !== undefined && employee.id !== where.id) return false;
      if (where.companyId !== undefined && employee.companyId !== where.companyId) return false;
      if (where.archivedAt === null && employee.archivedAt != null) return false;
      if (where.archivedAt?.not === null && employee.archivedAt == null) return false;
      if (where.updatedAt !== undefined && (employee.updatedAt as Date).getTime() !== where.updatedAt.getTime()) {
        return false;
      }
      return true;
    });
    if (!row) return null;
    const linkedUser = users[(row.user as StoreRow)?.id as string] ?? row.user ?? null;
    if (include?.user || include?.department) {
      return {
        ...row,
        user: linkedUser
          ? {
              id: (linkedUser as { id: string }).id,
              name: (linkedUser as { name: string }).name,
              email: (linkedUser as { email: string }).email,
              accountStatus: (linkedUser as { accountStatus: string }).accountStatus,
              roleId: 'role-employee',
              role: { id: 'role-employee', name: 'Employee' },
            }
          : null,
        department: row.department ?? { id: row.departmentId, name: 'Operations' },
      };
    }
    return { ...row, user: linkedUser };
  });

  prisma.employee.updateMany = vi.fn(async ({ where, data }: any) => {
    const row = employees.find((employee) => {
      if (where.id !== undefined && employee.id !== where.id) return false;
      if (where.companyId !== undefined && employee.companyId !== where.companyId) return false;
      if (where.archivedAt === null && employee.archivedAt != null) return false;
      if (where.archivedAt?.not === null && employee.archivedAt == null) return false;
      if (where.updatedAt !== undefined && (employee.updatedAt as Date).getTime() !== where.updatedAt.getTime()) {
        return false;
      }
      return true;
    });
    if (!row) return { count: 0 };
    Object.assign(row, data, { updatedAt: new Date() });
    if (row.user) {
      const user = users[(row.user as StoreRow).id as string] as StoreRow | undefined;
      const linkedEmployee = user?.employee as StoreRow | undefined;
      if (linkedEmployee) {
        linkedEmployee.status = row.status;
      }
    }
    return { count: 1 };
  });

  prisma.companyOwnership.findFirst = vi.fn(async ({ where }: any = {}) => {
    if (where.userId === 'u-owner' && where.isPrimary === true) {
      return { id: 'ownership-owner', userId: 'u-owner' };
    }
    return null;
  });

  prisma.department.findMany = vi.fn(async () => []);
  prisma.departmentManager.findMany = vi.fn(async () => []);
  prisma.accessGrant.findMany = vi.fn(async () => []);
  prisma.temporaryDelegation.findMany = vi.fn(async () => []);

  prisma.loginIdentity.findMany = vi.fn(async ({ where }: any = {}) =>
    loginIdentities.filter((identity) => {
      if (where.companyId !== undefined && identity.companyId !== where.companyId) return false;
      if (where.userId !== undefined && identity.userId !== where.userId) return false;
      return true;
    }),
  );

  prisma.loginIdentity.create = vi.fn(async ({ data }: any) => {
    const row = {
      id: `identity-${loginIdentities.length + 1}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    };
    loginIdentities.push(row);
    return row;
  });

  prisma.loginIdentity.update = vi.fn(async ({ where, data }: any) => {
    const row = loginIdentities.find((identity) => identity.id === where.id);
    if (row) Object.assign(row, data, { updatedAt: new Date() });
    return row ?? { id: where.id, ...data };
  });

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
      employees,
      users,
      loginIdentities,
      fixedUpdatedAt,
      archivedUpdatedAt,
    },
  };
}

function makeEmployeeArchiveApp(prisma: ReturnType<typeof makeFakePrisma>) {
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

  registerEmployeeArchiveRoutes({ app, prisma, requireAuth, checkPermission });
  return app;
}

describe('employee archive routes', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let stores: ReturnType<typeof makeEmployeeArchivePrisma>['stores'];
  let app: express.Express;

  beforeEach(() => {
    const setup = makeEmployeeArchivePrisma();
    prisma = setup.prisma;
    stores = setup.stores;
    app = makeEmployeeArchiveApp(prisma);

    prisma._store.refreshTokens.push(
      {
        id: 'rt-target-1',
        userId: 'u-target',
        companyId: 'c1',
        tokenHash: 'hash-1',
        revokedAt: null,
        revokedReason: null,
      },
      {
        id: 'rt-target-2',
        userId: 'u-target',
        companyId: 'c1',
        tokenHash: 'hash-2',
        revokedAt: null,
        revokedReason: null,
      },
    );
  });

  const hrToken = () => tokenFor({
    id: 'u-hr',
    companyId: 'c1',
    employeeId: 'e-hr',
    permissions: [
      PERMISSIONS.EMPLOYEES_ARCHIVE,
      PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
      PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
    ],
  });

  const selfToken = () => tokenFor({
    id: 'u-self',
    companyId: 'c1',
    employeeId: 'e-self',
    permissions: [
      PERMISSIONS.EMPLOYEES_ARCHIVE,
      PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
      PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
    ],
  });

  const archivePayload = () => ({
    reason: 'Employee left the company after project completion',
    expectedUpdatedAt: stores.fixedUpdatedAt.toISOString(),
  });

  const reactivatePayload = () => ({
    reason: 'Employee returned on a new contract',
    expectedUpdatedAt: stores.archivedUpdatedAt.toISOString(),
  });

  it('archives an employee, revokes sessions, and writes audit', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-target/archive')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send(archivePayload());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 'e-target',
      status: 'inactive',
      archiveReason: archivePayload().reason,
    });
    expect(res.body.archivedAt).toBeTruthy();

    const target = stores.employees.find((row) => row.id === 'e-target');
    expect(target?.archivedAt).toBeTruthy();
    expect(target?.archivedByUserId).toBe('u-hr');
    expect(target?.status).toBe('inactive');
    expect(stores.users['u-target'].accountStatus).toBe('archived');

    expect(prisma._store.refreshTokens.every((row: StoreRow) =>
      row.userId !== 'u-target' || row.revokedAt != null,
    )).toBe(true);
    expect(prisma._store.refreshTokens.every((row: StoreRow) =>
      row.userId !== 'u-target' || row.revokedReason === 'employee_archive',
    )).toBe(true);

    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'employee.archive',
        userId: 'u-hr',
      }),
    }));
    expect(prisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 'u-target',
        category: 'security',
        routeKey: 'employees.profile',
        resourceType: 'security',
      }),
    }));
  });

  it('returns idempotent 200 when archive is repeated', async () => {
    await request(app)
      .post('/api/v2/employees/e-target/archive')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send(archivePayload());

    const res = await request(app)
      .post('/api/v2/employees/e-target/archive')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send(archivePayload());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('e-target');
    expect(res.body.archivedAt).toBeTruthy();
    expect(prisma.employee.updateMany).toHaveBeenCalledTimes(1);
  });

  it('returns 403 when target is the primary owner', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-owner/archive')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({
        ...archivePayload(),
        expectedUpdatedAt: stores.fixedUpdatedAt.toISOString(),
      });

    expect(res.status).toBe(403);
    expect(res.body.messageKey).toBe('employees.archive_forbidden');
  });

  it('returns 403 when actor archives themselves', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-self/archive')
      .set('Authorization', `Bearer ${selfToken()}`)
      .send({
        ...archivePayload(),
        expectedUpdatedAt: stores.fixedUpdatedAt.toISOString(),
      });

    expect(res.status).toBe(403);
    expect(res.body.messageKey).toBe('employees.archive_forbidden');
  });

  it('returns opaque 404 for a foreign-company employee', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-foreign/archive')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({
        ...archivePayload(),
        expectedUpdatedAt: stores.fixedUpdatedAt.toISOString(),
      });

    expect(res.status).toBe(404);
    expect(res.body.messageKey).toBe('employees.employee_not_found');
  });

  it('returns 412 when expectedUpdatedAt is stale', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-target/archive')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({
        ...archivePayload(),
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      });

    expect(res.status).toBe(412);
    expect(res.body.messageKey).toBe('employees.stale_employee_version');
    expect(prisma.employee.updateMany).not.toHaveBeenCalled();
  });

  it('reactivates an archived employee and clears archive metadata', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-archived/reactivate')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send(reactivatePayload());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 'e-archived',
      status: 'active',
      archivedAt: null,
      archiveReason: null,
    });
    expect(stores.users['u-archived'].accountStatus).toBe('active');

    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'employee.reactivate',
        userId: 'u-hr',
      }),
    }));
    expect(prisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 'u-archived',
        category: 'security',
        routeKey: 'employees.profile',
        resourceType: 'security',
      }),
    }));
  });

  it('returns 409 when reactivating a non-archived employee', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-target/reactivate')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send(archivePayload());

    expect(res.status).toBe(409);
    expect(res.body.messageKey).toBe('employees.not_archived');
  });
});
