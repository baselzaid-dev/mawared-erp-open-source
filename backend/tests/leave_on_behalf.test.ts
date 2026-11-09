import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLeaveOnBehalfRoutes } from '../src/leaveOnBehalf';
import { PERMISSIONS } from '../src/permissions';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

type StoreRow = Record<string, unknown>;

function makeLeaveOnBehalfPrisma() {
  const leaveRequests: StoreRow[] = [];
  const employees: StoreRow[] = [
    {
      id: 'e-target',
      companyId: 'c1',
      departmentId: 'd1',
      employeeNum: '1002',
      status: 'active',
      user: { id: 'u-target', name: 'Target Employee', role: { permissions: '[]' } },
      department: { id: 'd1', name: 'Operations', managerId: 'u-manager' },
    },
    {
      id: 'e-inactive',
      companyId: 'c1',
      departmentId: 'd1',
      employeeNum: '1003',
      status: 'inactive',
      user: { id: 'u-inactive', name: 'Inactive Employee', role: { permissions: '[]' } },
      department: { id: 'd1', name: 'Operations', managerId: null },
    },
    {
      id: 'e-owner',
      companyId: 'c1',
      departmentId: 'd1',
      employeeNum: '1000',
      status: 'active',
      user: {
        id: 'u-owner',
        name: 'Owner Employee',
        role: { permissions: JSON.stringify([PERMISSIONS.ADMIN_FULL]) },
      },
      department: { id: 'd1', name: 'Operations', managerId: null },
    },
    {
      id: 'e-other-dept',
      companyId: 'c1',
      departmentId: 'd2',
      employeeNum: '2001',
      status: 'active',
      user: { id: 'u-other', name: 'Other Dept', role: { permissions: '[]' } },
      department: { id: 'd2', name: 'Finance', managerId: null },
    },
    {
      id: 'e-hr',
      companyId: 'c1',
      departmentId: 'd1',
      employeeNum: '1001',
      status: 'active',
      user: { id: 'u-hr', name: 'HR User', role: { permissions: '[]' } },
      department: { id: 'd1', name: 'Operations', managerId: null },
    },
  ];
  const users: StoreRow[] = [
    { id: 'u-hr', companyId: 'c1', employeeId: 'e-hr', role: { permissions: '[]' } },
    { id: 'u-target', companyId: 'c1', employeeId: 'e-target', role: { permissions: '[]' } },
    { id: 'u-reviewer', companyId: 'c1', employeeId: 'e-hr', role: { permissions: JSON.stringify([PERMISSIONS.HR_VIEW]) } },
  ];

  const prisma = makeFakePrisma();

  prisma.employee.findFirst = vi.fn(async ({ where, include }: any = {}) => {
    const row = employees.find((employee) =>
      employee.companyId === where.companyId && employee.id === where.id,
    );
    if (!row) return null;
    if (include?.user || include?.department) {
      return {
        ...row,
        user: row.user ?? { id: 'unknown', name: 'Unknown', role: { permissions: '[]' } },
        department: row.department ?? { id: row.departmentId, name: 'Dept', managerId: null },
      };
    }
    return row;
  });

  prisma.user.findMany = vi.fn(async ({ where }: any = {}) => {
    if (where.role?.permissions?.contains === PERMISSIONS.HR_VIEW) {
      return users.filter((user) =>
        user.companyId === where.companyId
        && String((user.role as { permissions?: string } | undefined)?.permissions ?? '').includes(PERMISSIONS.HR_VIEW),
      );
    }
    return users.filter((user) => user.companyId === where.companyId);
  });

  prisma.companyOwnership.findFirst = vi.fn(async ({ where }: any = {}) => {
    if (where.isPrimary && where.status === 'active' && where.companyId === 'c1') {
      return { userId: 'u-owner' };
    }
    return null;
  });

  prisma.departmentManager.findMany = vi.fn(async ({ where }: any = {}) =>
    where.departmentId === 'd1' ? [{ userId: 'u-manager' }] : [],
  );

  prisma.leaveRequest.create = vi.fn(async ({ data }: any) => {
    const now = new Date();
    const row = {
      createdAt: now,
      updatedAt: now,
      rejectionReason: null,
      ...data,
    };
    leaveRequests.push(row);
    return row;
  });

  prisma.leaveRequest.aggregate = vi.fn(async ({ where, _sum }: any = {}) => {
    const total = leaveRequests
      .filter((row) => {
        if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
        if (where.employeeId !== undefined && row.employeeId !== where.employeeId) return false;
        if (where.status?.in && !where.status.in.includes(row.status)) return false;
        if (where.leaveType?.in && !where.leaveType.in.includes(row.leaveType)) return false;
        return true;
      })
      .reduce((sum, row) => sum + Number(row.totalDays ?? 0), 0);
    return { _sum: { totalDays: _sum?.totalDays ? total : total } };
  });

  return {
    prisma,
    stores: { leaveRequests, employees, users },
  };
}

function makeLeaveOnBehalfApp(prisma: ReturnType<typeof makeFakePrisma>) {
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

  registerLeaveOnBehalfRoutes({ app, prisma, requireAuth, checkAnyPermission });
  return app;
}

describe('leave on-behalf routes', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let stores: ReturnType<typeof makeLeaveOnBehalfPrisma>['stores'];
  let app: express.Express;

  beforeEach(() => {
    const setup = makeLeaveOnBehalfPrisma();
    prisma = setup.prisma;
    stores = setup.stores;
    app = makeLeaveOnBehalfApp(prisma);
  });

  const hrToken = () => tokenFor({
    id: 'u-hr',
    companyId: 'c1',
    employeeId: 'e-hr',
    permissions: [
      PERMISSIONS.LEAVES_CREATE_ON_BEHALF,
      PERMISSIONS.EMPLOYEES_VIEW,
    ],
  });

  const deptManagerToken = () => tokenFor({
    id: 'u-manager',
    companyId: 'c1',
    employeeId: 'e-manager',
    permissions: [
      PERMISSIONS.LEAVES_CREATE_ON_BEHALF,
      PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT,
    ],
  });

  const validPayload = {
    employeeId: 'e-target',
    leaveType: 'annual',
    startDate: '2026-08-01T00:00:00.000Z',
    endDate: '2026-08-03T00:00:00.000Z',
    reason: 'Family travel',
    submissionReason: 'Employee unavailable to submit personally',
  };

  it('creates a pending_hr on-behalf leave with actor metadata', async () => {
    const res = await request(app)
      .post('/api/v2/leaves/on-behalf')
      .set('Authorization', `Bearer ${hrToken()}`)
      .set('Idempotency-Key', 'leave-on-behalf-key-1')
      .send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_hr');
    expect(res.body.submittedByUserId).toBe('u-hr');
    expect(res.body.submissionMode).toBe('on_behalf');
    expect(res.body.submissionReason).toBe(validPayload.submissionReason);
    expect(res.body.employeeId).toBe('e-target');
    expect(stores.leaveRequests).toHaveLength(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'leave.submit_on_behalf',
        userId: 'u-hr',
      }),
    }));
    expect(prisma.notification.create).toHaveBeenCalled();
  });

  it('requires leaves.create_on_behalf permission', async () => {
    const res = await request(app)
      .post('/api/v2/leaves/on-behalf')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-hr',
        employeeId: 'e-hr',
        permissions: [PERMISSIONS.EMPLOYEES_VIEW],
      })}`)
      .send(validPayload);

    expect(res.status).toBe(403);
  });

  it('rejects missing submissionReason', async () => {
    const { submissionReason: _ignored, ...payload } = validPayload;
    const res = await request(app)
      .post('/api/v2/leaves/on-behalf')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.messageKey).toBe('leaves.invalid_request');
  });

  it('rejects invalid optional Idempotency-Key header format', async () => {
    const res = await request(app)
      .post('/api/v2/leaves/on-behalf')
      .set('Authorization', `Bearer ${hrToken()}`)
      .set('Idempotency-Key', 'bad key!')
      .send(validPayload);

    expect(res.status).toBe(400);
    expect(res.body.messageKey).toBe('leaves.idempotency_key_invalid');
  });

  it('returns 404 for unknown employee', async () => {
    const res = await request(app)
      .post('/api/v2/leaves/on-behalf')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ ...validPayload, employeeId: 'missing-employee' });

    expect(res.status).toBe(404);
    expect(res.body.messageKey).toBe('leaves.employee_not_found');
  });

  it('blocks inactive target employees', async () => {
    const res = await request(app)
      .post('/api/v2/leaves/on-behalf')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ ...validPayload, employeeId: 'e-inactive' });

    expect(res.status).toBe(409);
    expect(res.body.messageKey).toBe('leaves.inactive_employee');
  });

  it('blocks protected owner targets', async () => {
    const res = await request(app)
      .post('/api/v2/leaves/on-behalf')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ ...validPayload, employeeId: 'e-owner' });

    expect(res.status).toBe(403);
    expect(res.body.messageKey).toBe('leaves.protected_target');
  });

  it('blocks submitting for own employee record', async () => {
    const res = await request(app)
      .post('/api/v2/leaves/on-behalf')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({ ...validPayload, employeeId: 'e-hr' });

    expect(res.status).toBe(403);
    expect(res.body.messageKey).toBe('leaves.on_behalf_self_forbidden');
  });

  it('enforces department scope for department viewers', async () => {
    prisma.departmentManager.findMany = vi.fn(async ({ where }: any = {}) =>
      where.userId === 'u-manager' ? [{ departmentId: 'd1' }] : [],
    );

    const outOfScope = await request(app)
      .post('/api/v2/leaves/on-behalf')
      .set('Authorization', `Bearer ${deptManagerToken()}`)
      .send({ ...validPayload, employeeId: 'e-other-dept' });
    expect(outOfScope.status).toBe(403);
    expect(outOfScope.body.messageKey).toBe('leaves.forbidden');

    const inScope = await request(app)
      .post('/api/v2/leaves/on-behalf')
      .set('Authorization', `Bearer ${deptManagerToken()}`)
      .send(validPayload);
    expect(inScope.status).toBe(201);
  });

  it('enforces sick leave quota for on-behalf submissions', async () => {
    stores.leaveRequests.push({
      id: 'LR-used',
      companyId: 'c1',
      employeeId: 'e-target',
      leaveType: 'sick',
      totalDays: 13,
      status: 'approved',
    });

    const res = await request(app)
      .post('/api/v2/leaves/on-behalf')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send({
        ...validPayload,
        leaveType: 'sick',
        startDate: '2026-08-01T00:00:00.000Z',
        endDate: '2026-08-03T00:00:00.000Z',
      });

    expect(res.status).toBe(400);
    expect(res.body.messageKey).toBe('leaves.sick_quota_exceeded');
  });

  it('notifies the target employee user', async () => {
    await request(app)
      .post('/api/v2/leaves/on-behalf')
      .set('Authorization', `Bearer ${hrToken()}`)
      .send(validPayload);

    const notificationCalls = (prisma.notification.create as ReturnType<typeof vi.fn>).mock.calls;
    const targetNotification = notificationCalls.find(
      ([payload]) => payload.data.userId === 'u-target',
    );
    expect(targetNotification).toBeTruthy();
    expect(targetNotification?.[0].data.title).toContain('نيابة');
  });
});
