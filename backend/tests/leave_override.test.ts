import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEAVE_OVERRIDE_CONFIRMATION,
  registerLeaveOverrideRoutes,
} from '../src/leaveOverride';
import { PERMISSIONS } from '../src/permissions';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

type StoreRow = Record<string, unknown>;

function makeLeavePrisma() {
  const leaves: StoreRow[] = [];
  const users: StoreRow[] = [
    {
      id: 'u-override',
      companyId: 'c1',
      employeeId: 'e-override',
      role: { name: 'HR Admin' },
    },
    {
      id: 'u-requester',
      companyId: 'c1',
      employeeId: 'e-requester',
      role: { name: 'Employee' },
    },
  ];

  const prisma = makeFakePrisma();

  prisma.user.findFirst = vi.fn(async ({ where, select }: any = {}) => {
    const row = users.find((user) =>
      user.id === where.id && user.companyId === where.companyId,
    );
    if (!row) return null;
    if (select?.role) {
      return { role: row.role };
    }
    return row;
  });

  prisma.leaveRequest.findFirst = vi.fn(async ({ where, include }: any = {}) => {
    const row = leaves.find((leave) =>
      leave.id === where.id && leave.companyId === where.companyId,
    );
    if (!row) return null;
    if (include?.employee) {
      return {
        ...row,
        employee: row.employee ?? {
          id: row.employeeId,
          employeeNum: 'EMP-1',
          departmentId: 'd1',
          department: { id: 'd1', name: 'HR' },
          user: { id: 'u-requester', name: 'Requester' },
        },
      };
    }
    if (where.status !== undefined && row.status !== where.status) return null;
    return { ...row };
  });

  prisma.leaveRequest.updateMany = vi.fn(async ({ where, data }: any) => {
    const row = leaves.find((leave) =>
      leave.id === where.id
      && leave.companyId === where.companyId
      && (where.status === undefined || leave.status === where.status),
    );
    if (!row) return { count: 0 };
    Object.assign(row, data, { updatedAt: new Date() });
    return { count: 1 };
  });

  return { prisma, stores: { leaves, users } };
}

function makeLeaveOverrideApp(prisma: ReturnType<typeof makeFakePrisma>) {
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

  const checkPermission = (required: string) => (
    req: express.Request & { user?: { permissions?: string[] } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const permissions = req.user?.permissions ?? [];
    if (permissions.includes(required)) return next();
    return res.status(403).json({ error: 'Forbidden', code: 403 });
  };

  registerLeaveOverrideRoutes({
    app,
    prisma: prisma as any,
    requireAuth,
    checkPermission,
  });

  return app;
}

function seedLeave(store: StoreRow[], overrides: Partial<StoreRow> = {}) {
  const updatedAt = new Date('2026-07-19T10:00:00.000Z');
  const row = {
    id: 'LV-1',
    companyId: 'c1',
    employeeId: 'e-requester',
    leaveType: 'special',
    startDate: new Date('2026-07-20T00:00:00.000Z'),
    endDate: new Date('2026-07-22T00:00:00.000Z'),
    totalDays: 3,
    reason: 'Trip',
    status: 'pending_hr',
    exitReentryRequested: false,
    visaFeePaid: false,
    rejectionReason: null,
    createdAt: new Date('2026-07-18T00:00:00.000Z'),
    updatedAt,
    employee: {
      id: 'e-requester',
      employeeNum: 'EMP-2',
      departmentId: 'd1',
      department: { id: 'd1', name: 'HR' },
      user: { id: 'u-requester', name: 'Requester' },
    },
    ...overrides,
  };
  store.push(row);
  return row;
}

function overrideBody(overrides: Record<string, unknown> = {}) {
  return {
    action: 'approve',
    reason: 'Emergency staffing override',
    confirmation: LEAVE_OVERRIDE_CONFIRMATION,
    ...overrides,
  };
}

describe('POST /api/v2/leaves/:id/override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('approves a pending leave with history, audit, and notification', async () => {
    const { prisma, stores } = makeLeavePrisma();
    seedLeave(stores.leaves);
    const app = makeLeaveOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/leaves/LV-1/override')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-override',
        employeeId: 'e-override',
        permissions: [PERMISSIONS.LEAVES_ADMIN_OVERRIDE],
      })}`)
      .send(overrideBody({
        expectedUpdatedAt: '2026-07-19T10:00:00.000Z',
      }));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(stores.leaves[0].status).toBe('approved');
    expect(prisma._store.approvalHistory).toHaveLength(1);
    expect(prisma._store.approvalHistory[0]).toMatchObject({
      action: 'override_approve',
      fromStatus: 'pending_hr',
      toStatus: 'approved',
      isOverride: true,
      reasonCategory: 'admin_override',
      actorRoleSnapshot: 'HR Admin',
      reason: 'Emergency staffing override',
    });
    expect(prisma._store.auditLogs.some((row: StoreRow) => row.action === 'leave.override_approve')).toBe(true);
    expect(prisma._store.notifications).toHaveLength(1);
    expect(prisma._store.notifications[0].userId).toBe('u-requester');
    expect(prisma._store.notifications[0]).toMatchObject({
      routeKey: 'leave.detail',
      resourceType: 'leaveRequest',
      resourceId: 'LV-1',
      category: 'leave',
    });
  });

  it('rejects an approved leave and stores rejection reason', async () => {
    const { prisma, stores } = makeLeavePrisma();
    seedLeave(stores.leaves, { status: 'approved' });
    const app = makeLeaveOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/leaves/LV-1/override')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-override',
        employeeId: 'e-override',
        permissions: [PERMISSIONS.LEAVES_ADMIN_OVERRIDE],
      })}`)
      .send(overrideBody({
        action: 'reject',
        reason: 'Policy violation after review',
      }));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(stores.leaves[0].rejectionReason).toBe('Policy violation after review');
    expect(prisma._store.approvalHistory[0].action).toBe('override_reject');
  });

  it('cancels a pending_admin leave', async () => {
    const { prisma, stores } = makeLeavePrisma();
    seedLeave(stores.leaves, { status: 'pending_admin', leaveType: 'annual' });
    const app = makeLeaveOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/leaves/LV-1/override')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-override',
        employeeId: 'e-override',
        permissions: [PERMISSIONS.LEAVES_ADMIN_OVERRIDE],
      })}`)
      .send(overrideBody({ action: 'cancel', reason: 'Duplicate request' }));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(prisma._store.approvalHistory[0].action).toBe('override_cancel');
  });

  it('returns 403 without the explicit leaves.admin_override permission', async () => {
    const { prisma, stores } = makeLeavePrisma();
    seedLeave(stores.leaves);
    const app = makeLeaveOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/leaves/LV-1/override')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-admin',
        employeeId: 'e-admin',
        permissions: [PERMISSIONS.ADMIN_FULL],
      })}`)
      .send(overrideBody());

    expect(res.status).toBe(403);
    expect(prisma._store.approvalHistory).toHaveLength(0);
  });

  it('returns 403 when overriding own leave', async () => {
    const { prisma, stores } = makeLeavePrisma();
    seedLeave(stores.leaves, { employeeId: 'e-override' });
    const app = makeLeaveOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/leaves/LV-1/override')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-override',
        employeeId: 'e-override',
        permissions: [PERMISSIONS.LEAVES_ADMIN_OVERRIDE],
      })}`)
      .send(overrideBody());

    expect(res.status).toBe(403);
    expect(res.body.messageKey).toBe('leave.override_self_forbidden');
    expect(prisma._store.approvalHistory).toHaveLength(0);
  });

  it('returns opaque 404 for cross-tenant leave ids', async () => {
    const { prisma, stores } = makeLeavePrisma();
    seedLeave(stores.leaves, { companyId: 'c-other' });
    const app = makeLeaveOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/leaves/LV-1/override')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-override',
        employeeId: 'e-override',
        permissions: [PERMISSIONS.LEAVES_ADMIN_OVERRIDE],
      })}`)
      .send(overrideBody());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NotFound');
  });

  it('returns 400 for empty reason', async () => {
    const { prisma, stores } = makeLeavePrisma();
    seedLeave(stores.leaves);
    const app = makeLeaveOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/leaves/LV-1/override')
      .set('Authorization', `Bearer ${tokenFor({
        permissions: [PERMISSIONS.LEAVES_ADMIN_OVERRIDE],
      })}`)
      .send(overrideBody({ reason: '   ' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('returns 400 when confirmation token is not OVERRIDE', async () => {
    const { prisma, stores } = makeLeavePrisma();
    seedLeave(stores.leaves);
    const app = makeLeaveOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/leaves/LV-1/override')
      .set('Authorization', `Bearer ${tokenFor({
        permissions: [PERMISSIONS.LEAVES_ADMIN_OVERRIDE],
      })}`)
      .send(overrideBody({ confirmation: 'CONFIRM' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('returns 400 when expectedVersion is sent because LeaveRequest has no version column', async () => {
    const { prisma, stores } = makeLeavePrisma();
    seedLeave(stores.leaves);
    const app = makeLeaveOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/leaves/LV-1/override')
      .set('Authorization', `Bearer ${tokenFor({
        permissions: [PERMISSIONS.LEAVES_ADMIN_OVERRIDE],
      })}`)
      .send(overrideBody({ expectedVersion: 1 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('returns 412 when expectedUpdatedAt does not match', async () => {
    const { prisma, stores } = makeLeavePrisma();
    seedLeave(stores.leaves);
    const app = makeLeaveOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/leaves/LV-1/override')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-override',
        employeeId: 'e-override',
        permissions: [PERMISSIONS.LEAVES_ADMIN_OVERRIDE],
      })}`)
      .send(overrideBody({ expectedUpdatedAt: '2026-07-19T11:00:00.000Z' }));

    expect(res.status).toBe(412);
    expect(res.body.error).toBe('VersionMismatch');
    expect(res.body.currentUpdatedAt).toBe('2026-07-19T10:00:00.000Z');
    expect(prisma._store.approvalHistory).toHaveLength(0);
  });

  it('returns 409 when the leave is already in the target state', async () => {
    const { prisma, stores } = makeLeavePrisma();
    seedLeave(stores.leaves, { status: 'approved' });
    const app = makeLeaveOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/leaves/LV-1/override')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-override',
        employeeId: 'e-override',
        permissions: [PERMISSIONS.LEAVES_ADMIN_OVERRIDE],
      })}`)
      .send(overrideBody({ action: 'approve' }));

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('LeaveStateConflict');
    expect(prisma._store.approvalHistory).toHaveLength(0);
  });

  it('returns 409 on concurrent status change (atomic guard)', async () => {
    const { prisma, stores } = makeLeavePrisma();
    seedLeave(stores.leaves);
    prisma.leaveRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    const app = makeLeaveOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/leaves/LV-1/override')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-override',
        employeeId: 'e-override',
        permissions: [PERMISSIONS.LEAVES_ADMIN_OVERRIDE],
      })}`)
      .send(overrideBody());

    expect(res.status).toBe(409);
    expect(prisma._store.approvalHistory).toHaveLength(0);
  });
});
