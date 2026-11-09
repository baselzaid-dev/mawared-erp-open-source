import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerEmployeeCredentialRoutes } from '../src/employeeCredentials';
import { PERMISSIONS } from '../src/permissions';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

type StoreRow = Record<string, unknown>;

function makeEmployeeCredentialPrisma() {
  const users: StoreRow[] = [];
  const roles: StoreRow[] = [
    {
      id: 'role-employee',
      companyId: 'c1',
      name: 'Employee',
      permissions: JSON.stringify(['dashboard.self']),
    },
  ];
  const employees: StoreRow[] = [
    {
      id: 'e-no-user',
      companyId: 'c1',
      departmentId: 'd1',
      employeeNum: '1002',
      jobTitle: 'Operations Associate',
      status: 'active',
      archivedAt: null,
      user: null,
      department: { id: 'd1' },
    },
    {
      id: 'e-has-user',
      companyId: 'c1',
      departmentId: 'd1',
      employeeNum: '1003',
      jobTitle: 'Existing Login',
      status: 'active',
      archivedAt: null,
      user: { id: 'u-existing' },
      department: { id: 'd1' },
    },
    {
      id: 'e-inactive',
      companyId: 'c1',
      departmentId: 'd1',
      employeeNum: '1004',
      jobTitle: 'Inactive Staff',
      status: 'inactive',
      archivedAt: null,
      user: null,
      department: { id: 'd1' },
    },
    {
      id: 'e-other-company',
      companyId: 'c2',
      departmentId: 'd9',
      employeeNum: '9001',
      jobTitle: 'Other Co',
      status: 'active',
      archivedAt: null,
      user: null,
      department: { id: 'd9' },
    },
    {
      id: 'e-other-dept',
      companyId: 'c1',
      departmentId: 'd2',
      employeeNum: '2001',
      jobTitle: 'Finance Staff',
      status: 'active',
      archivedAt: null,
      user: null,
      department: { id: 'd2' },
    },
  ];
  const loginIdentities: StoreRow[] = [];

  const prisma = makeFakePrisma();

  prisma.role.findFirst = vi.fn(async ({ where }: any = {}) =>
    roles.find((role) =>
      role.companyId === where.companyId
      && (where.name === undefined || role.name === where.name)
      && (where.id === undefined || role.id === where.id),
    ) ?? null,
  );

  prisma.employee.findFirst = vi.fn(async ({ where, include }: any = {}) => {
    const row = employees.find((employee) => {
      if (where.id !== undefined && employee.id !== where.id) return false;
      if (where.companyId !== undefined && employee.companyId !== where.companyId) return false;
      return true;
    });
    if (!row) return null;
    const linkedUser = users.find((user) => user.employeeId === row.id) ?? row.user ?? null;
    if (include?.user || include?.department) {
      return {
        ...row,
        user: linkedUser
          ? {
              id: (linkedUser as { id: string }).id,
              role: { permissions: '[]' },
            }
          : null,
        department: row.department ?? { id: row.departmentId },
      };
    }
    return { ...row, user: linkedUser };
  });

  prisma.loginIdentity.findFirst = vi.fn(async ({ where }: any = {}) =>
    loginIdentities.find((identity) => {
      if (where.companyId !== undefined && identity.companyId !== where.companyId) return false;
      if (where.normalizedIdentifier?.in) {
        return where.normalizedIdentifier.in.includes(identity.normalizedIdentifier);
      }
      return false;
    }) ?? null,
  );

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

  prisma.user.create = vi.fn(async ({ data }: any) => {
    const row = { id: data.id ?? `user-${users.length + 1}`, ...data };
    users.push(row);
    const employee = employees.find((item) => item.id === row.employeeId);
    if (employee) employee.user = { id: row.id as string };
    return row;
  });

  prisma.departmentManager.findMany = vi.fn(async ({ where }: any = {}) =>
    where.userId === 'u-dept-manager' ? [{ departmentId: 'd1' }] : [],
  );

  prisma.department.findMany = vi.fn(async ({ where }: any = {}) =>
    where.managerId === 'u-dept-manager' ? [{ id: 'd1' }] : [],
  );

  return {
    prisma,
    stores: { employees, users, roles, loginIdentities },
  };
}

function makeEmployeeCredentialApp(prisma: ReturnType<typeof makeFakePrisma>) {
  const app = express();
  app.use(express.json());

  const requireAuth = (
    req: express.Request & { user?: Record<string, unknown> },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? header.match(/^Bearer\s+(\S+)$/i) : null;
    if (!match) return res.status(401).json({ error: 'Unauthorized' });
    try {
      req.user = jwt.verify(match[1], TEST_SECRET) as {
        id: string;
        companyId: string;
        employeeId: string | null;
        permissions: string[];
      };
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };

  const checkAnyPermission = (...required: string[]) => (
    req: express.Request & { user?: { permissions?: string[] } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const permissions: string[] = req.user?.permissions ?? [];
    if (
      permissions.includes(PERMISSIONS.ADMIN_FULL)
      || required.some((permission) => permissions.includes(permission))
    ) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden' });
  };

  registerEmployeeCredentialRoutes({ app, prisma, requireAuth, checkAnyPermission });
  return app;
}

describe('employee credential create route', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let stores: ReturnType<typeof makeEmployeeCredentialPrisma>['stores'];
  let app: express.Express;

  beforeEach(() => {
    const setup = makeEmployeeCredentialPrisma();
    prisma = setup.prisma;
    stores = setup.stores;
    app = makeEmployeeCredentialApp(prisma);
  });

  const hrToken = () => tokenFor({
    id: 'u-hr',
    companyId: 'c1',
    employeeId: 'e-hr',
    permissions: [
      PERMISSIONS.EMPLOYEES_CREDENTIALS_CREATE,
      PERMISSIONS.EMPLOYEES_VIEW,
    ],
  });

  const deptManagerToken = () => tokenFor({
    id: 'u-dept-manager',
    companyId: 'c1',
    employeeId: 'e-manager',
    permissions: [
      PERMISSIONS.EMPLOYEES_CREDENTIALS_CREATE,
      PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT,
    ],
  });

  it('creates a one-time credential for an employee without login', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-no-user/credentials')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ email: 'new.login@fixture-2.example.test' });

    expect(res.status).toBe(201);
    expect(res.body.mustChangePassword).toBe(true);
    expect(res.body.credentialVersion).toBe(1);
    expect(typeof res.body.temporaryPassword).toBe('string');
    expect(res.body.temporaryPassword.length).toBeGreaterThan(10);
    expect(typeof res.body.expiresAt).toBe('string');
    expect(stores.users).toHaveLength(1);
    expect(stores.users[0]).toMatchObject({
      email: 'new.login@fixture-2.example.test',
      employeeId: 'e-no-user',
      mustChangePassword: true,
      credentialVersion: 1,
      accountStatus: 'active',
      passwordChangedAt: expect.any(Date),
      roleId: 'role-employee',
    });
    expect(stores.users[0].password).not.toBe(res.body.temporaryPassword);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'employee.credentials.create',
        userId: 'u-hr',
      }),
    }));
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('returns 409 when the employee already has a linked user', async () => {
    stores.users.push({
      id: 'u-existing',
      companyId: 'c1',
      employeeId: 'e-has-user',
      email: 'existing@fixture-2.example.test',
    });

    const res = await request(app)
      .post('/api/v2/employees/e-has-user/credentials')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ email: 'another@fixture-2.example.test' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CredentialAlreadyExists');
    expect(res.body.messageKey).toBe('employees.credential_already_exists');
  });

  it('requires employees.credentials.create permission', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-no-user/credentials')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-viewer',
        companyId: 'c1',
        employeeId: 'e-viewer',
        permissions: [PERMISSIONS.EMPLOYEES_VIEW],
      })}`)
      .send({ email: 'blocked@fixture-2.example.test' });

    expect(res.status).toBe(403);
  });

  it('returns opaque 404 for cross-company employees', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-other-company/credentials')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ email: 'cross@fixture-2.example.test' });

    expect(res.status).toBe(404);
    expect(res.body.messageKey).toBe('employees.employee_not_found');
  });

  it('rejects inactive employees', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-inactive/credentials')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ email: 'inactive@fixture-2.example.test' });

    expect(res.status).toBe(409);
    expect(res.body.messageKey).toBe('employees.inactive_employee');
  });

  it('never stores the temporary password in audit details', async () => {
    const res = await request(app)
      .post('/api/v2/employees/e-no-user/credentials')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ email: 'audit-safe@fixture-2.example.test' });

    expect(res.status).toBe(201);
    const auditCall = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const detailsRaw = auditCall?.[0]?.data?.details ?? '';
    expect(detailsRaw).not.toContain(res.body.temporaryPassword);
    expect(detailsRaw).toContain('employeeId');
    expect(detailsRaw).toContain('userId');
    expect(detailsRaw).not.toMatch(/temporaryPassword|password/i);
  });

  it('enforces department scope for department viewers', async () => {
    const outOfScope = await request(app)
      .post('/api/v2/employees/e-other-dept/credentials')
      .set('Authorization', `Bearer ${deptManagerToken()}`)
      .send({ email: 'finance@fixture-2.example.test' });
    expect(outOfScope.status).toBe(403);
    expect(outOfScope.body.messageKey).toBe('employees.forbidden');

    const inScope = await request(app)
      .post('/api/v2/employees/e-no-user/credentials')
      .set('Authorization', `Bearer ${deptManagerToken()}`)
      .send({ email: 'scoped@fixture-2.example.test' });
    expect(inScope.status).toBe(201);
  });
});
