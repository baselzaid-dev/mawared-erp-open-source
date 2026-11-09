import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

function pendingHrLeave(overrides: Record<string, any> = {}) {
  return {
    id: 'LV-1',
    companyId: 'c1',
    employeeId: 'e-requester',
    leaveType: 'special',
    status: 'pending_hr',
    employee: { id: 'e-requester', user: { id: 'u-requester' } },
    ...overrides,
  };
}

function installStatefulLeave(prisma: any, initial: Record<string, any>) {
  let current = { ...initial };
  prisma.leaveRequest.findFirst.mockImplementation(async ({ where }: any) => {
    if (where.id !== current.id || where.companyId !== current.companyId) return null;
    return { ...current };
  });
  prisma.leaveRequest.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (
      where.id !== current.id ||
      where.companyId !== current.companyId ||
      where.status !== current.status
    ) {
      return { count: 0 };
    }
    current = { ...current, ...data };
    return { count: 1 };
  });
  return () => ({ ...current });
}

function safeLeave(overrides: Record<string, any> = {}) {
  return {
    id: 'LV-safe',
    companyId: 'c1',
    employeeId: 'e1',
    leaveType: 'annual',
    startDate: new Date('2026-07-01T00:00:00.000Z'),
    endDate: new Date('2026-07-03T00:00:00.000Z'),
    totalDays: 3,
    reason: null,
    status: 'pending_hr',
    exitReentryRequested: false,
    visaFeePaid: false,
    rejectionReason: null,
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    updatedAt: new Date('2026-06-20T00:00:00.000Z'),
    employee: {
      id: 'e1',
      employeeNum: 'EMP-1',
      departmentId: 'd1',
      department: { id: 'd1', name: 'التقنية' },
      user: {
        id: 'u1',
        name: 'موظف الاختبار',
        email: 'must-not-leak@example.test',
        password: 'must-not-leak', // security-scan-allow: response-redaction fixture
        passwordHash: 'must-not-leak',
        role: { permissions: '[]' },
      },
    },
    ...overrides,
  };
}

describe('leave business rules', () => {
  it('an approver cannot approve their own leave', async () => {
    const prisma = makeFakePrisma();
    prisma.leaveRequest.findFirst.mockResolvedValue(
      pendingHrLeave({ employeeId: 'e-hr' }) // the HR user is the requester
    );
    const app = makeApp(prisma);

    const token = tokenFor({ employeeId: 'e-hr', permissions: ['leaves.approve'] });
    const res = await request(app)
      .post('/api/leaves/LV-1/hr-approve')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Cannot approve own leave');
  });

  it('annual leave HR-approval escalates to admin instead of final approval', async () => {
    const prisma = makeFakePrisma();
    prisma.leaveRequest.findFirst.mockResolvedValue(pendingHrLeave({ leaveType: 'annual' }));
    let capturedUpdate: any = null;
    prisma.leaveRequest.updateMany.mockImplementation(async (args: any) => {
      capturedUpdate = args;
      return { count: 1 };
    });
    const app = makeApp(prisma);

    const token = tokenFor({ employeeId: 'e-hr', permissions: ['leaves.approve'] });
    const res = await request(app)
      .post('/api/leaves/LV-1/hr-approve')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Escalated to Admin');
    expect(capturedUpdate.data.status).toBe('pending_admin');
    // Audit trail written for the escalation.
    const actions = prisma._store.auditLogs.map((a: any) => a.action);
    expect(actions).toContain('leave.hr_escalate');
  });

  it('non-annual leave HR-approval approves directly', async () => {
    const prisma = makeFakePrisma();
    prisma.leaveRequest.findFirst.mockResolvedValue(pendingHrLeave({ leaveType: 'sick' }));
    let capturedUpdate: any = null;
    prisma.leaveRequest.updateMany.mockImplementation(async (args: any) => {
      capturedUpdate = args;
      return { count: 1 };
    });
    const app = makeApp(prisma);

    const token = tokenFor({ employeeId: 'e-hr', permissions: ['leaves.approve'] });
    const res = await request(app)
      .post('/api/leaves/LV-1/hr-approve')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Approved');
    expect(capturedUpdate.data.status).toBe('approved');
  });

  it('HR rejection succeeds once and records one complete workflow', async () => {
    const prisma = makeFakePrisma();
    const current = installStatefulLeave(prisma, pendingHrLeave());
    const res = await request(makeApp(prisma))
      .post('/api/leaves/LV-1/hr-reject')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-hr', employeeId: 'e-hr', permissions: ['leaves.approve'] })}`)
      .send({ reason: 'Test rejection reason' });

    expect(res.status).toBe(200);
    expect(current().status).toBe('rejected');
    expect(prisma._store.approvalHistory).toHaveLength(1);
    expect(prisma._store.approvalHistory[0].action).toBe('hr_reject');
    expect(prisma._store.notifications).toHaveLength(1);
    expect(prisma._store.auditLogs.filter((row: any) => row.action === 'leave.hr_reject')).toHaveLength(1);
  });

  it.each([
    ['admin-approve', undefined, 'approved', 'admin_approve', 'leave.admin_approve'],
    ['admin-reject', { reason: 'Test rejection reason' }, 'rejected', 'admin_reject', 'leave.admin_reject'],
  ])('Admin %s succeeds once and records one complete workflow', async (
    route,
    body,
    expectedStatus,
    historyAction,
    auditAction,
  ) => {
    const prisma = makeFakePrisma();
    const current = installStatefulLeave(
      prisma,
      pendingHrLeave({ leaveType: 'annual', status: 'pending_admin' }),
    );
    let call = request(makeApp(prisma))
      .post(`/api/leaves/LV-1/${route}`)
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-admin', employeeId: 'e-admin', permissions: ['admin.full'] })}`);
    if (body) call = call.send(body);
    const res = await call;

    expect(res.status).toBe(200);
    expect(current().status).toBe(expectedStatus);
    expect(prisma._store.approvalHistory).toHaveLength(1);
    expect(prisma._store.approvalHistory[0].action).toBe(historyAction);
    expect(prisma._store.notifications).toHaveLength(1);
    expect(prisma._store.auditLogs.filter((row: any) => row.action === auditAction)).toHaveLength(1);
  });

  it('returns a controlled 409 when the same transition is repeated', async () => {
    const prisma = makeFakePrisma();
    installStatefulLeave(prisma, pendingHrLeave());
    const app = makeApp(prisma);
    const token = tokenFor({ id: 'u-hr', employeeId: 'e-hr', permissions: ['leaves.approve'] });

    const first = await request(app)
      .post('/api/leaves/LV-1/hr-approve')
      .set('Authorization', `Bearer ${token}`);
    const second = await request(app)
      .post('/api/leaves/LV-1/hr-approve')
      .set('Authorization', `Bearer ${token}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: 'LeaveStateConflict',
      message: 'تمت معالجة طلب الإجازة مسبقاً أو تغيرت حالته',
      code: 409,
    });
    expect(second.body.requestId).toEqual(expect.any(String));
    expect(prisma._store.approvalHistory).toHaveLength(1);
    expect(prisma._store.notifications).toHaveLength(1);
    expect(prisma._store.auditLogs.filter((row: any) => row.action === 'leave.hr_approve')).toHaveLength(1);
  });

  it('allows only one winner in an approval-versus-rejection race', async () => {
    const prisma = makeFakePrisma();
    const current = installStatefulLeave(prisma, pendingHrLeave());
    const app = makeApp(prisma);
    const token = tokenFor({ id: 'u-hr', employeeId: 'e-hr', permissions: ['leaves.approve'] });

    const [approve, reject] = await Promise.all([
      request(app)
        .post('/api/leaves/LV-1/hr-approve')
        .set('Authorization', `Bearer ${token}`),
      request(app)
        .post('/api/leaves/LV-1/hr-reject')
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Test rejection reason' }),
    ]);

    expect([approve.status, reject.status].sort()).toEqual([200, 409]);
    expect(['approved', 'rejected']).toContain(current().status);
    expect(prisma._store.approvalHistory).toHaveLength(1);
    expect(prisma._store.notifications).toHaveLength(1);
    expect(prisma._store.auditLogs.filter((row: any) => row.action.startsWith('leave.hr_'))).toHaveLength(1);
  });

  it('keeps a cross-company leave identifier opaque during transition', async () => {
    const prisma = makeFakePrisma();
    prisma.leaveRequest.findFirst.mockResolvedValue(null);
    const res = await request(makeApp(prisma))
      .post('/api/leaves/foreign-leave/hr-approve')
      .set('Authorization', `Bearer ${tokenFor({ companyId: 'c1', employeeId: 'e-hr', permissions: ['leaves.approve'] })}`);

    expect(res.status).toBe(404);
    expect(prisma.leaveRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'foreign-leave', companyId: 'c1' },
    }));
    expect(prisma.leaveRequest.updateMany).not.toHaveBeenCalled();
  });

  it('enforces the 14-day yearly sick-leave cap', async () => {
    const prisma = makeFakePrisma();
    prisma.leaveRequest.aggregate.mockResolvedValue({ _sum: { totalDays: 13 } });
    const app = makeApp(prisma);

    const token = tokenFor({ employeeId: 'e1', permissions: ['leaves.create'] });
    const res = await request(app)
      .post('/api/leaves')
      .set('Authorization', `Bearer ${token}`)
      .send({ leaveType: 'sick', startDate: '2026-07-06', endDate: '2026-07-08' }); // 3 days, 13 used

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('sick leave days remaining');
  });

  it('rejects end date before start date', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const token = tokenFor({ employeeId: 'e1', permissions: ['leaves.create'] });
    const res = await request(app)
      .post('/api/leaves')
      .set('Authorization', `Bearer ${token}`)
      .send({ leaveType: 'special', startDate: '2026-07-10', endDate: '2026-07-05' });
    expect(res.status).toBe(400);
  });

  it('requires a reason to reject a leave (validation)', async () => {
    const prisma = makeFakePrisma();
    prisma.leaveRequest.findFirst.mockResolvedValue(pendingHrLeave());
    const app = makeApp(prisma);
    const token = tokenFor({ employeeId: 'e-hr', permissions: ['leaves.approve'] });

    const res = await request(app)
      .post('/api/leaves/LV-1/hr-reject')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
  });

  it('annual leave with exit/re-entry requires the visa fee first', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const token = tokenFor({ employeeId: 'e1', permissions: ['leaves.create'] });
    const res = await request(app)
      .post('/api/leaves')
      .set('Authorization', `Bearer ${token}`)
      .send({
        leaveType: 'annual',
        startDate: '2026-08-01',
        endDate: '2026-08-05',
        exitReentryRequested: true,
        visaFeePaid: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('التأشيرة');
  });

  it('Arabic leave type سنوية triggers the same visa-fee gate (app contract)', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const token = tokenFor({ employeeId: 'e1', permissions: ['leaves.create'] });
    const res = await request(app)
      .post('/api/leaves')
      .set('Authorization', `Bearer ${token}`)
      .send({
        leaveType: 'سنوية',
        startDate: '2026-08-01',
        endDate: '2026-08-05',
        exitReentryRequested: true,
        visaFeePaid: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('التأشيرة');
  });

  it('audits a submitted leave request', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const token = tokenFor({ employeeId: 'e1', permissions: ['leaves.create'] });
    const res = await request(app)
      .post('/api/leaves')
      .set('Authorization', `Bearer ${token}`)
      .send({ leaveType: 'special', startDate: '2026-07-06', endDate: '2026-07-07' });

    expect(res.status).toBe(200);
    const actions = prisma._store.auditLogs.map((a: any) => a.action);
    expect(actions).toContain('leave.submit');
  });
});

describe('Sprint 5A leave permissions and filters', () => {
  it('requires leaves.create and permits the admin.full bypass', async () => {
    const deniedPrisma = makeFakePrisma();
    const denied = await request(makeApp(deniedPrisma))
      .post('/api/leaves')
      .set('Authorization', `Bearer ${tokenFor({ employeeId: 'e1' })}`)
      .send({ leaveType: 'special', startDate: '2026-08-01', endDate: '2026-08-02' });
    expect(denied.status).toBe(403);
    expect(deniedPrisma.leaveRequest.create).not.toHaveBeenCalled();

    const adminPrisma = makeFakePrisma();
    const allowed = await request(makeApp(adminPrisma))
      .post('/api/leaves')
      .set('Authorization', `Bearer ${tokenFor({ employeeId: 'e-admin', permissions: ['admin.full'] })}`)
      .send({ leaveType: 'special', startDate: '2026-08-01', endDate: '2026-08-02' });
    expect(allowed.status).toBe(200);
  });

  it('returns a controlled 403 when the account has no employee profile', async () => {
    const prisma = makeFakePrisma();
    const res = await request(makeApp(prisma))
      .post('/api/leaves')
      .set('Authorization', `Bearer ${tokenFor({ employeeId: null, permissions: ['leaves.create'] })}`)
      .send({ leaveType: 'special', startDate: '2026-08-01', endDate: '2026-08-02' });
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('ملف موظف');
  });

  it('counts Arabic sick leave together with English sick leave', async () => {
    const prisma = makeFakePrisma();
    let capturedWhere: any = null;
    prisma.leaveRequest.aggregate.mockImplementation(async ({ where }: any) => {
      capturedWhere = where;
      return { _sum: { totalDays: 13 } };
    });
    const res = await request(makeApp(prisma))
      .post('/api/leaves')
      .set('Authorization', `Bearer ${tokenFor({ employeeId: 'e1', permissions: ['leaves.create'] })}`)
      .send({ leaveType: 'مرضية', startDate: '2026-08-01', endDate: '2026-08-03' });
    expect(res.status).toBe(400);
    expect(capturedWhere.leaveType.in).toEqual(expect.arrayContaining(['sick', 'مرضية']));
  });

  it('filters My Requests without allowing employeeId to widen ownership', async () => {
    const prisma = makeFakePrisma();
    let capturedWhere: any = null;
    prisma.leaveRequest.findMany.mockImplementation(async ({ where }: any) => {
      capturedWhere = where;
      return [safeLeave()];
    });
    const app = makeApp(prisma);
    const token = tokenFor({ companyId: 'c1', employeeId: 'e1' });
    const res = await request(app)
      .get('/api/leaves/my?from=2026-07-01&to=2026-07-31&status=pending_hr&leaveType=annual')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(capturedWhere.companyId).toBe('c1');
    expect(capturedWhere.employeeId).toBe('e1');
    expect(capturedWhere.leaveType.in).toEqual(['annual', 'سنوية']);
    expect(capturedWhere.startDate.lte.toISOString()).toBe('2026-07-31T23:59:59.999Z');
    expect(capturedWhere.endDate.gte.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|permissions|email|bcrypt/i);

    const widened = await request(app)
      .get('/api/leaves/my?employeeId=e2')
      .set('Authorization', `Bearer ${token}`);
    expect(widened.status).toBe(400);
  });

  it.each([
    ['/api/leaves/report?from=2026-7-01&to=2026-07-31'],
    ['/api/leaves/report?from=2026-08-01&to=2026-07-31'],
    ['/api/leaves/report?from=2025-01-01&to=2026-07-31'],
  ])('rejects an invalid report range: %s', async (path) => {
    const res = await request(makeApp(makeFakePrisma()))
      .get(path)
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['leaves.view'] })}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/[؀-ۿ]/);
  });

  it('denies reports to view-own managers and builds a safe scoped summary for leaves.view', async () => {
    const deniedPrisma = makeFakePrisma();
    const denied = await request(makeApp(deniedPrisma))
      .get('/api/leaves/report?from=2026-07-01&to=2026-07-31')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['leaves.view_own'] })}`);
    expect(denied.status).toBe(403);

    const prisma = makeFakePrisma();
    let capturedWhere: any = null;
    const rows = [
      safeLeave({ id: 'p-hr', status: 'pending_hr', totalDays: 1 }),
      safeLeave({ id: 'p-admin', status: 'pending_admin', totalDays: 2 }),
      safeLeave({ id: 'approved', status: 'approved', totalDays: 3 }),
      safeLeave({ id: 'rejected', status: 'rejected', totalDays: 4 }),
      safeLeave({ id: 'cancelled', status: 'cancelled', totalDays: 5 }),
      safeLeave({
        id: 'owner-hidden',
        status: 'approved',
        totalDays: 99,
        employee: {
          id: 'owner', employeeNum: 'OWNER', departmentId: null, department: null,
          user: { name: 'المالك', role: { permissions: '["admin.full"]' } },
        },
      }),
    ];
    prisma.leaveRequest.findMany.mockImplementation(async ({ where }: any) => {
      capturedWhere = where;
      return rows;
    });
    const res = await request(makeApp(prisma))
      .get('/api/leaves/report?from=2026-07-01&to=2026-07-31&leaveType=سنوية')
      .set('Authorization', `Bearer ${tokenFor({ companyId: 'c1', permissions: ['leaves.view'] })}`);
    expect(res.status).toBe(200);
    expect(capturedWhere.companyId).toBe('c1');
    expect(capturedWhere.leaveType.in).toEqual(['annual', 'سنوية']);
    expect(res.body.summary).toEqual({
      total: 5, pendingHr: 1, pendingAdmin: 1, approved: 1,
      rejected: 1, cancelled: 1, totalDays: 15,
    });
    expect(res.body.requests).toHaveLength(5);
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|permissions|email|bcrypt/i);
  });

  it('rejects an employee report filter outside the requester company', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(null);
    const res = await request(makeApp(prisma))
      .get('/api/leaves/report?from=2026-07-01&to=2026-07-31&employeeId=other-company')
      .set('Authorization', `Bearer ${tokenFor({ companyId: 'c1', permissions: ['leaves.view'] })}`);
    expect(res.status).toBe(404);
    expect(prisma.leaveRequest.findMany).not.toHaveBeenCalled();
  });
});

describe('Sprint 5A leave cancellation and approval stages', () => {
  it('atomically cancels the owner pending_hr request and writes history and audit', async () => {
    const prisma = makeFakePrisma();
    prisma.leaveRequest.findFirst.mockResolvedValue(safeLeave());
    const res = await request(makeApp(prisma))
      .post('/api/leaves/LV-safe/cancel')
      .set('Authorization', `Bearer ${tokenFor({ companyId: 'c1', employeeId: 'e1' })}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(prisma.leaveRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'LV-safe', companyId: 'c1', employeeId: 'e1', status: 'pending_hr',
      }),
    }));
    expect(prisma._store.approvalHistory.some((row: any) => row.action === 'cancel')).toBe(true);
    expect(prisma._store.auditLogs.some((row: any) => row.action === 'leave.cancel')).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|permissions|email|bcrypt/i);
  });

  it('returns the same 404 for unknown, other-employee, or cross-company requests', async () => {
    const prisma = makeFakePrisma();
    prisma.leaveRequest.findFirst.mockResolvedValue(null);
    const res = await request(makeApp(prisma))
      .post('/api/leaves/not-visible/cancel')
      .set('Authorization', `Bearer ${tokenFor({ companyId: 'c1', employeeId: 'e1' })}`);
    expect(res.status).toBe(404);
    expect(prisma.leaveRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'not-visible', companyId: 'c1', employeeId: 'e1' },
    }));
  });

  it.each(['pending_admin', 'approved', 'rejected', 'cancelled'])(
    'rejects cancellation when status is %s',
    async (status) => {
      const prisma = makeFakePrisma();
      prisma.leaveRequest.findFirst.mockResolvedValue(safeLeave({ status }));
      const res = await request(makeApp(prisma))
        .post('/api/leaves/LV-safe/cancel')
        .set('Authorization', `Bearer ${tokenFor({ companyId: 'c1', employeeId: 'e1' })}`);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/[؀-ۿ]/);
      expect(prisma.leaveRequest.updateMany).not.toHaveBeenCalled();
    }
  );

  it('does not allow a repeated cancellation to succeed twice', async () => {
    const prisma = makeFakePrisma();
    prisma.leaveRequest.findFirst
      .mockResolvedValueOnce(safeLeave())
      .mockResolvedValueOnce(safeLeave({ status: 'cancelled' }));
    const app = makeApp(prisma);
    const token = tokenFor({ companyId: 'c1', employeeId: 'e1' });
    const first = await request(app).post('/api/leaves/LV-safe/cancel').set('Authorization', `Bearer ${token}`);
    const second = await request(app).post('/api/leaves/LV-safe/cancel').set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(prisma.leaveRequest.updateMany).toHaveBeenCalledTimes(1);
  });

  it('escalates Arabic annual leave and blocks Admin self approve and reject', async () => {
    const hrPrisma = makeFakePrisma();
    hrPrisma.leaveRequest.findFirst.mockResolvedValue(pendingHrLeave({ leaveType: 'سنوية' }));
    const hrRes = await request(makeApp(hrPrisma))
      .post('/api/leaves/LV-1/hr-approve')
      .set('Authorization', `Bearer ${tokenFor({ employeeId: 'e-hr', permissions: ['leaves.approve'] })}`);
    expect(hrRes.status).toBe(200);
    expect(hrPrisma.leaveRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'pending_admin' }),
    }));

    const adminPrisma = makeFakePrisma();
    adminPrisma.leaveRequest.findFirst.mockResolvedValue(
      pendingHrLeave({ employeeId: 'e-admin', status: 'pending_admin' })
    );
    const adminApp = makeApp(adminPrisma);
    const adminToken = tokenFor({ employeeId: 'e-admin', permissions: ['admin.full'] });
    const approve = await request(adminApp)
      .post('/api/leaves/LV-1/admin-approve')
      .set('Authorization', `Bearer ${adminToken}`);
    const reject = await request(adminApp)
      .post('/api/leaves/LV-1/admin-reject')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'سبب اختبار' });
    expect(approve.status).toBe(403);
    expect(reject.status).toBe(403);
  });

  it('keeps pending queue stages separate for HR and Admin', async () => {
    const hrPrisma = makeFakePrisma();
    let hrWhere: any = null;
    hrPrisma.leaveRequest.findMany.mockImplementation(async ({ where }: any) => {
      hrWhere = where;
      return [];
    });
    await request(makeApp(hrPrisma))
      .get('/api/leaves/pending')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['leaves.review'] })}`);
    expect(hrWhere.status).toBe('pending_hr');

    const adminPrisma = makeFakePrisma();
    let adminWhere: any = null;
    adminPrisma.leaveRequest.findMany.mockImplementation(async ({ where }: any) => {
      adminWhere = where;
      return [];
    });
    await request(makeApp(adminPrisma))
      .get('/api/leaves/pending')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['admin.full'] })}`);
    expect(adminWhere.status).toBe('pending_admin');
  });
});

describe('employee creation', () => {
  it('validates the body systematically (password >= 8 chars)', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const token = tokenFor({ permissions: ['employees.create'] });

    const res = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'new@fixture-2.example.test',
        password: 'short',
        name: 'موظف جديد',
        roleId: 'r1',
        employeeNum: 'EMP-9',
        jobTitle: 'محاسب',
        joiningDate: '2026-07-01',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
    expect(res.body.details?.[0]?.field).toBe('password');
  });

  it('creates employee + user in a transaction and audits it', async () => {
    const prisma = makeFakePrisma();
    prisma.user.findUnique.mockResolvedValue(null); // email unused
    prisma.role.findFirst.mockResolvedValue({ id: 'r1', companyId: 'c1' });
    const app = makeApp(prisma);
    const token = tokenFor({ companyId: 'c1', permissions: ['employees.create'] });

    const res = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'new@fixture-2.example.test',
        password: 'password123',
        name: 'موظف جديد',
        roleId: 'r1',
        employeeNum: 'EMP-9',
        jobTitle: 'محاسب',
        joiningDate: '2026-07-01',
      });

    expect(res.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalled();
    const actions = prisma._store.auditLogs.map((a: any) => a.action);
    expect(actions).toContain('employee.create');
    // The audit record must never contain the raw password.
    expect(JSON.stringify(prisma._store.auditLogs)).not.toContain('password123');
  });

  it('blocks creating an employee with an admin.full role', async () => {
    const prisma = makeFakePrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.role.findFirst.mockResolvedValue({
      id: 'owner-role',
      companyId: 'c1',
      permissions: JSON.stringify(['admin.full']),
    });
    const app = makeApp(prisma);
    const token = tokenFor({ companyId: 'c1', permissions: ['employees.create'] });

    const res = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'new@fixture-2.example.test',
        password: 'password123',
        name: 'New employee',
        roleId: 'owner-role',
        employeeNum: 'EMP-10',
        jobTitle: 'Accountant',
        joiningDate: '2026-07-01',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('EmployeeRoleForbidden');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('is denied for the seeded HR-style permission set without employees.create', async () => {
    const app = makeApp(makeFakePrisma());
    const token = tokenFor({ permissions: ['employees.view'] });
    const res = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
  });
});

describe('GET /api/leaves/:id company isolation and self scope', () => {
  it('returns a company-scoped leave for reviewers', async () => {
    const prisma = makeFakePrisma();
    prisma.leaveRequest.findFirst.mockResolvedValue(safeLeave());
    const res = await request(makeApp(prisma))
      .get('/api/leaves/LV-safe')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['leaves.view'] })}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('LV-safe');
    expect(prisma.leaveRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'LV-safe', companyId: 'c1' }),
    }));
    expect(JSON.stringify(res.body)).not.toMatch(/password|passwordHash|must-not-leak/);
  });

  it('keeps foreign-company leave ids opaque', async () => {
    const prisma = makeFakePrisma();
    prisma.leaveRequest.findFirst.mockResolvedValue(null);
    const res = await request(makeApp(prisma))
      .get('/api/leaves/foreign-leave')
      .set('Authorization', `Bearer ${tokenFor({ companyId: 'c1', permissions: ['leaves.approve'] })}`);
    expect(res.status).toBe(404);
    expect(prisma.leaveRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'foreign-leave', companyId: 'c1' }),
    }));
  });

  it('scopes leaves.view_own callers to their own employee id', async () => {
    const prisma = makeFakePrisma();
    prisma.leaveRequest.findFirst.mockResolvedValue(null);
    const res = await request(makeApp(prisma))
      .get('/api/leaves/LV-safe')
      .set('Authorization', `Bearer ${tokenFor({ employeeId: 'e-other', permissions: ['leaves.view_own'] })}`);
    expect(res.status).toBe(404);
    expect(prisma.leaveRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ employeeId: 'e-other' }),
    }));
  });
});

describe('GET /api/leaves/pending permission gate', () => {
  it('allows leaves.approve without leaves.review', async () => {
    const prisma = makeFakePrisma();
    prisma.leaveRequest.findMany.mockResolvedValue([safeLeave()]);
    const res = await request(makeApp(prisma))
      .get('/api/leaves/pending')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['leaves.approve'] })}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('rejects callers without review or approve permission', async () => {
    const res = await request(makeApp(makeFakePrisma()))
      .get('/api/leaves/pending')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['leaves.create'] })}`);
    expect(res.status).toBe(403);
  });
});
