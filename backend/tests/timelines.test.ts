import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerTimelineRoutes } from '../src/timelines';
import { PERMISSIONS } from '../src/permissions';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

function makeTimelineApp(prisma: any) {
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
      req.user = jwt.verify(match[1], TEST_SECRET) as Record<string, unknown>;
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
    const permissions = req.user?.permissions ?? [];
    if (
      permissions.includes(PERMISSIONS.ADMIN_FULL) ||
      required.some((permission) => permissions.includes(permission))
    ) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden', code: 403 });
  };
  registerTimelineRoutes({ app, prisma, requireAuth, checkAnyPermission });
  return app;
}

const LEAVE_ROW = {
  id: 'lr-1',
  companyId: 'c1',
  employeeId: 'e-req',
  status: 'approved',
  submissionMode: 'self',
  submissionReason: null,
  createdAt: new Date('2026-06-01T08:00:00Z'),
  employee: {
    id: 'e-req',
    user: { id: 'u-req', name: 'Requester', role: { permissions: '[]' } },
  },
  submittedBy: null,
  approvalHistory: [
    {
      createdAt: new Date('2026-06-02T08:00:00Z'),
      action: 'hr_approve',
      fromStatus: 'pending_hr',
      toStatus: 'pending_admin',
      reason: 'ok by HR',
      isOverride: false,
      actorRoleSnapshot: 'HR Manager',
      actionByUser: { name: 'Hana HR' },
    },
    {
      createdAt: new Date('2026-06-03T08:00:00Z'),
      action: 'override_approve',
      fromStatus: 'pending_admin',
      toStatus: 'approved',
      reason: 'executive decision',
      isOverride: true,
      actorRoleSnapshot: 'Admin',
      actionByUser: { name: 'Omar Admin' },
    },
  ],
};

function leavePrisma(row: any = LEAVE_ROW, ownerUserId: string | null = null) {
  const prisma = makeFakePrisma();
  prisma.leaveRequest.findFirst = vi.fn(async ({ where }: any) =>
    row.id === where.id && row.companyId === where.companyId ? row : null);
  prisma.companyOwnership.findFirst = vi.fn(async () =>
    ownerUserId ? { userId: ownerUserId } : null);
  return prisma;
}

describe('GET /api/v2/leaves/:id/timeline', () => {
  it('returns chronological events with safe actor snapshot for the requester', async () => {
    const app = makeTimelineApp(leavePrisma());
    const res = await request(app)
      .get('/api/v2/leaves/lr-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-req', companyId: 'c1', employeeId: 'e-req',
        permissions: [PERMISSIONS.LEAVES_VIEW_OWN],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.entityType).toBe('leave');
    const types = res.body.events.map((e: any) => e.type);
    expect(types).toEqual(['leave.submitted', 'leave.hr_approve', 'leave.override_approve']);
    const override = res.body.events[2];
    expect(override.actorName).toBe('Omar Admin');
    expect(override.actorRole).toBe('Admin');
    expect(override.override).toBe(true);
    expect(override.fromStatus).toBe('pending_admin');
    expect(override.toStatus).toBe('approved');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('actionByUserId');
    expect(raw).not.toContain('auditLog');
  });

  it('returns an opaque 404 for another employee leave when caller only views own', async () => {
    const app = makeTimelineApp(leavePrisma());
    const res = await request(app)
      .get('/api/v2/leaves/lr-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-peer', companyId: 'c1', employeeId: 'e-peer',
        permissions: [PERMISSIONS.LEAVES_VIEW_OWN],
      })}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NotFound');
  });

  it('returns an opaque 404 across companies even for a reviewer', async () => {
    const app = makeTimelineApp(leavePrisma());
    const res = await request(app)
      .get('/api/v2/leaves/lr-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-foreign', companyId: 'c2', employeeId: 'e-x',
        permissions: [PERMISSIONS.LEAVES_VIEW],
      })}`);
    expect(res.status).toBe(404);
  });

  it('allows a company reviewer with leaves.view', async () => {
    const app = makeTimelineApp(leavePrisma());
    const res = await request(app)
      .get('/api/v2/leaves/lr-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-hr', companyId: 'c1', employeeId: 'e-hr',
        permissions: [PERMISSIONS.LEAVES_VIEW],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(3);
  });

  it('allows an approve-only reviewer to load the leave timeline', async () => {
    const app = makeTimelineApp(leavePrisma());
    const res = await request(app)
      .get('/api/v2/leaves/lr-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-approver', companyId: 'c1', employeeId: 'e-approver',
        permissions: [PERMISSIONS.LEAVES_APPROVE],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(3);
  });

  it('hides protected-owner leave timelines from ordinary reviewers', async () => {
    const ownerLeave = {
      ...LEAVE_ROW,
      employee: {
        id: 'e-owner',
        user: { id: 'u-owner', name: 'Owner', role: { permissions: '[]' } },
      },
      employeeId: 'e-owner',
    };
    const app = makeTimelineApp(leavePrisma(ownerLeave, 'u-owner'));
    const blocked = await request(app)
      .get('/api/v2/leaves/lr-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-reviewer', companyId: 'c1', employeeId: 'e-reviewer',
        permissions: [PERMISSIONS.LEAVES_VIEW],
      })}`);
    expect(blocked.status).toBe(404);

    const own = await request(makeTimelineApp(leavePrisma(ownerLeave, 'u-owner')))
      .get('/api/v2/leaves/lr-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-owner', companyId: 'c1', employeeId: 'e-owner',
        permissions: [PERMISSIONS.LEAVES_VIEW_OWN],
      })}`);
    expect(own.status).toBe(200);
  });

  it('rejects callers without any leave view permission at the route gate', async () => {
    const app = makeTimelineApp(leavePrisma());
    const res = await request(app)
      .get('/api/v2/leaves/lr-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-none', companyId: 'c1', permissions: [],
      })}`);
    expect(res.status).toBe(403);
  });
});

const REQUEST_ROW = {
  id: 'pr-1',
  companyId: 'c1',
  departmentId: 'd1',
  requestedByEmployeeId: 'e-req',
  requesterNameSnapshot: 'Requester',
  status: 'approved',
  createdAt: new Date('2026-05-01T08:00:00Z'),
  departmentReviewedAt: new Date('2026-05-02T08:00:00Z'),
  departmentReviewNote: 'dept ok',
  departmentReviewer: { name: 'Dana Dept' },
  purchasingReviewedAt: new Date('2026-05-03T08:00:00Z'),
  purchasingReviewNote: 'purchasing ok',
  purchasingReviewer: { name: 'Paul Purchasing' },
  rejectedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  cancelledBy: null,
  requester: { user: { id: 'u-req', role: { permissions: '[]' } } },
};

function purchasingPrisma(
  row: any = REQUEST_ROW,
  events: any[] = [],
  auditRows: any[] = [],
  ownerUserId: string | null = null,
) {
  const prisma = makeFakePrisma();
  (prisma as any).purchaseRequest = {
    findFirst: vi.fn(async ({ where }: any) =>
      row.id === where.id && row.companyId === where.companyId ? row : null),
  };
  (prisma as any).purchaseWorkflowEvent = {
    findMany: vi.fn(async ({ where }: any) =>
      events.filter((event) =>
        event.companyId === where.companyId &&
        event.entityType === where.entityType &&
        event.entityId === where.entityId)),
  };
  prisma.auditLog.findMany = vi.fn(async () => auditRows);
  prisma.companyOwnership.findFirst = vi.fn(async () =>
    ownerUserId ? { userId: ownerUserId } : null);
  return prisma;
}

describe('GET /api/v2/purchasing/requests/:id/timeline', () => {
  it('returns lifecycle plus override workflow events for a company viewer', async () => {
    const overrideEvent = {
      companyId: 'c1', entityType: 'purchase_request', entityId: 'pr-1',
      action: 'override_approve', previousStatus: 'pending_purchasing', newStatus: 'approved',
      reason: 'urgent', createdAt: new Date('2026-05-04T08:00:00Z'), actor: { name: 'Omar Admin' },
    };
    const app = makeTimelineApp(purchasingPrisma(REQUEST_ROW, [overrideEvent]));
    const res = await request(app)
      .get('/api/v2/purchasing/requests/pr-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-view', companyId: 'c1', permissions: [PERMISSIONS.PURCHASING_VIEW],
      })}`);
    expect(res.status).toBe(200);
    const types = res.body.events.map((e: any) => e.type);
    expect(types).toEqual([
      'purchase_request.created',
      'purchase_request.department_reviewed',
      'purchase_request.purchasing_reviewed',
      'purchase_request.override_approve',
    ]);
    const override = res.body.events[3];
    expect(override.override).toBe(true);
    expect(override.reason).toBe('urgent');
    expect(override.fromStatus).toBe('pending_purchasing');
  });

  it('scopes department viewers to managed departments with an opaque 404 otherwise', async () => {
    const prisma = purchasingPrisma();
    prisma.department.findMany = vi.fn(async ({ where }: any = {}) =>
      where?.managerId === 'u-mgr-d2' ? [{ id: 'd2' }] : []);
    const app = makeTimelineApp(prisma);
    const res = await request(app)
      .get('/api/v2/purchasing/requests/pr-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-mgr-d2', companyId: 'c1',
        permissions: [PERMISSIONS.PURCHASING_VIEW_DEPARTMENT],
      })}`);
    expect(res.status).toBe(404);
  });

  it('allows the requesting employee with purchasing.view_own and blocks peers', async () => {
    const app = makeTimelineApp(purchasingPrisma());
    const own = await request(app)
      .get('/api/v2/purchasing/requests/pr-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-req', companyId: 'c1', employeeId: 'e-req',
        permissions: [PERMISSIONS.PURCHASING_VIEW_OWN],
      })}`);
    expect(own.status).toBe(200);

    const peer = await request(app)
      .get('/api/v2/purchasing/requests/pr-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-peer', companyId: 'c1', employeeId: 'e-peer',
        permissions: [PERMISSIONS.PURCHASING_VIEW_OWN],
      })}`);
    expect(peer.status).toBe(404);
  });

  it('uses the audited actual initial Purchasing status', async () => {
    const row = {
      ...REQUEST_ROW,
      status: 'approved',
      departmentReviewedAt: null,
      departmentReviewer: null,
    };
    const auditRows = [{
      action: 'purchasing.request.create',
      createdAt: row.createdAt,
      details: JSON.stringify({ requestId: row.id, status: 'pending_purchasing' }),
      user: { name: 'Requester', role: { name: 'Employee' } },
    }];
    const app = makeTimelineApp(purchasingPrisma(row, [], auditRows));
    const res = await request(app)
      .get('/api/v2/purchasing/requests/pr-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-view', companyId: 'c1', permissions: [PERMISSIONS.PURCHASING_VIEW],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({
      type: 'purchase_request.created',
      toStatus: 'pending_purchasing',
      actorRole: 'Employee',
    });
  });

  it('hides protected-owner Purchasing timelines from non-owner viewers', async () => {
    const ownerRequest = {
      ...REQUEST_ROW,
      requestedByEmployeeId: 'e-owner',
      requester: {
        user: {
          id: 'u-owner',
          role: { permissions: `["${PERMISSIONS.ADMIN_FULL}"]` },
        },
      },
    };
    const app = makeTimelineApp(purchasingPrisma(ownerRequest, [], [], 'u-owner'));
    const res = await request(app)
      .get('/api/v2/purchasing/requests/pr-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-view', companyId: 'c1', permissions: [PERMISSIONS.PURCHASING_VIEW],
      })}`);
    expect(res.status).toBe(404);
  });
});

const EMPLOYEE_ROW = {
  id: 'emp-1',
  companyId: 'c1',
  departmentId: 'd1',
  status: 'active',
  joiningDate: new Date('2025-01-15T00:00:00Z'),
  createdAt: new Date('2025-01-10T00:00:00Z'),
  archivedAt: new Date('2026-03-01T00:00:00Z'),
  archiveReason: 'contract ended',
  archivedBy: { name: 'Hana HR' },
  user: { id: 'u-emp1', role: { permissions: '[]' } },
};

function employeePrisma(
  row: any = EMPLOYEE_ROW,
  ownerUserId: string | null = null,
  auditRows: any[] = [],
) {
  const prisma = makeFakePrisma();
  prisma.employee.findFirst = vi.fn(async ({ where }: any) =>
    row.id === where.id && row.companyId === where.companyId ? row : null);
  prisma.companyOwnership.findFirst = vi.fn(async () =>
    ownerUserId ? { userId: ownerUserId } : null);
  prisma.auditLog.findMany = vi.fn(async () => auditRows);
  return prisma;
}

describe('GET /api/v2/employees/:id/timeline', () => {
  it('returns created/joined/archived events with reason and no salary or credential fields', async () => {
    const app = makeTimelineApp(employeePrisma());
    const res = await request(app)
      .get('/api/v2/employees/emp-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-hr', companyId: 'c1', permissions: [PERMISSIONS.EMPLOYEES_VIEW],
      })}`);
    expect(res.status).toBe(200);
    const types = res.body.events.map((e: any) => e.type);
    expect(types).toEqual(['employee.created', 'employee.joined', 'employee.archived']);
    const archived = res.body.events[2];
    expect(archived.actorName).toBe('Hana HR');
    expect(archived.reason).toBe('contract ended');
    const raw = JSON.stringify(res.body).toLowerCase();
    expect(raw).not.toContain('salary');
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('credential');
  });

  it('returns an opaque 404 to a department viewer outside the managed scope', async () => {
    const prisma = employeePrisma();
    prisma.department.findMany = vi.fn(async () => []);
    const app = makeTimelineApp(prisma);
    const res = await request(app)
      .get('/api/v2/employees/emp-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-mgr', companyId: 'c1',
        permissions: [PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT],
      })}`);
    expect(res.status).toBe(404);
  });

  it('hides the Primary Owner employee timeline from non owner-data viewers', async () => {
    const ownerRow = { ...EMPLOYEE_ROW, id: 'emp-own', user: { id: 'u-owner', role: { permissions: '[]' } } };
    const app = makeTimelineApp(employeePrisma(ownerRow, 'u-owner'));
    const blocked = await request(app)
      .get('/api/v2/employees/emp-own/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-viewer', companyId: 'c1', permissions: [PERMISSIONS.EMPLOYEES_VIEW],
      })}`);
    expect(blocked.status).toBe(404);

    const hrApp = makeTimelineApp(employeePrisma(ownerRow, 'u-owner'));
    const allowed = await request(hrApp)
      .get('/api/v2/employees/emp-own/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-hr', companyId: 'c1',
        permissions: [PERMISSIONS.EMPLOYEES_VIEW, PERMISSIONS.HR_VIEW],
      })}`);
    expect(allowed.status).toBe(200);
  });

  it('also hides legacy admin-full employee timelines from ordinary viewers', async () => {
    const legacyAdmin = {
      ...EMPLOYEE_ROW,
      id: 'emp-admin',
      user: {
        id: 'u-admin-target',
        role: { permissions: `["${PERMISSIONS.ADMIN_FULL}"]` },
      },
    };
    const app = makeTimelineApp(employeePrisma(legacyAdmin));
    const res = await request(app)
      .get('/api/v2/employees/emp-admin/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-viewer', companyId: 'c1', permissions: [PERMISSIONS.EMPLOYEES_VIEW],
      })}`);
    expect(res.status).toBe(404);
  });

  it('preserves repeated archive and reactivation events from sanitized audit history', async () => {
    const active = {
      ...EMPLOYEE_ROW,
      status: 'active',
      archivedAt: null,
      archiveReason: null,
      archivedBy: null,
    };
    const auditRows = [
      {
        action: 'employee.archive',
        createdAt: new Date('2026-01-01T08:00:00Z'),
        details: JSON.stringify({ employeeId: active.id, archiveReason: 'contract ended' }),
        user: { name: 'Hana HR', role: { name: 'HR Manager' } },
      },
      {
        action: 'employee.reactivate',
        createdAt: new Date('2026-02-01T08:00:00Z'),
        details: JSON.stringify({ employeeId: active.id, archiveReason: 'rehired' }),
        user: { name: 'Hana HR', role: { name: 'HR Manager' } },
      },
      {
        action: 'employee.archive',
        createdAt: new Date('2026-03-01T08:00:00Z'),
        details: JSON.stringify({ employeeId: active.id, archiveReason: 'second exit' }),
        user: { name: 'Hana HR', role: { name: 'HR Manager' } },
      },
    ];
    const app = makeTimelineApp(employeePrisma(active, null, auditRows));
    const res = await request(app)
      .get('/api/v2/employees/emp-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-hr', companyId: 'c1', permissions: [PERMISSIONS.EMPLOYEES_VIEW],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.events.map((item: any) => item.type)).toEqual([
      'employee.created',
      'employee.joined',
      'employee.archived',
      'employee.reactivated',
      'employee.archived',
    ]);
    expect(res.body.events.at(-1).reason).toBe('second exit');
  });

  it('returns an opaque 404 across companies', async () => {
    const app = makeTimelineApp(employeePrisma());
    const res = await request(app)
      .get('/api/v2/employees/emp-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-foreign', companyId: 'c2', permissions: [PERMISSIONS.EMPLOYEES_VIEW],
      })}`);
    expect(res.status).toBe(404);
  });
});

const ASSIGNMENT_ROW = {
  id: 'ta-1',
  companyId: 'c1',
  courseId: 'tc-1',
  employeeId: 'e-req',
  departmentIdSnapshot: 'd1',
  status: 'completed',
  assignedAt: new Date('2026-04-01T08:00:00Z'),
  assignedBy: { name: 'Tariq Trainer' },
  startedAt: new Date('2026-04-02T08:00:00Z'),
  submittedAt: new Date('2026-04-03T08:00:00Z'),
  reviewedAt: new Date('2026-04-04T08:00:00Z'),
  reviewNote: 'well done',
  reviewedBy: { name: 'Rana Reviewer' },
  cancelledAt: null,
  cancellationReason: null,
  cancelledBy: null,
  employee: { user: { id: 'u-req', role: { permissions: '[]' } } },
};

function trainingPrisma(
  row: any = ASSIGNMENT_ROW,
  auditRows: any[] = [],
  ownerUserId: string | null = null,
) {
  const prisma = makeFakePrisma();
  (prisma as any).trainingAssignment = {
    findFirst: vi.fn(async ({ where }: any) =>
      row.id === where.id && row.companyId === where.companyId ? row : null),
  };
  prisma.auditLog.findMany = vi.fn(async () => auditRows);
  prisma.companyOwnership.findFirst = vi.fn(async () =>
    ownerUserId ? { userId: ownerUserId } : null);
  return prisma;
}

describe('GET /api/v2/training/assignments/:id/timeline', () => {
  it('returns the assignment lifecycle for the assigned employee', async () => {
    const app = makeTimelineApp(trainingPrisma());
    const res = await request(app)
      .get('/api/v2/training/assignments/ta-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-req', companyId: 'c1', employeeId: 'e-req',
        permissions: [PERMISSIONS.TRAINING_VIEW_OWN],
      })}`);
    expect(res.status).toBe(200);
    const types = res.body.events.map((e: any) => e.type);
    expect(types).toEqual([
      'assignment.assigned',
      'assignment.started',
      'assignment.submitted',
      'assignment.reviewed',
    ]);
    expect(res.body.events[3].reason).toBe('well done');
    expect(res.body.events[3].actorName).toBe('Rana Reviewer');
  });

  it('blocks another employee with only training.view_own via opaque 404', async () => {
    const app = makeTimelineApp(trainingPrisma());
    const res = await request(app)
      .get('/api/v2/training/assignments/ta-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-peer', companyId: 'c1', employeeId: 'e-peer',
        permissions: [PERMISSIONS.TRAINING_VIEW_OWN],
      })}`);
    expect(res.status).toBe(404);
  });

  it('scopes department viewers by the assignment department snapshot', async () => {
    const prisma = trainingPrisma();
    prisma.department.findMany = vi.fn(async ({ where }: any = {}) =>
      where?.managerId === 'u-mgr' ? [{ id: 'd1' }] : []);
    const app = makeTimelineApp(prisma);
    const res = await request(app)
      .get('/api/v2/training/assignments/ta-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-mgr', companyId: 'c1',
        permissions: [PERMISSIONS.TRAINING_VIEW_DEPARTMENT],
      })}`);
    expect(res.status).toBe(200);
  });

  it('hides protected-owner Training timelines from non-owner company viewers', async () => {
    const ownerAssignment = {
      ...ASSIGNMENT_ROW,
      employeeId: 'e-owner',
      employee: {
        user: {
          id: 'u-owner',
          role: { permissions: `["${PERMISSIONS.ADMIN_FULL}"]` },
        },
      },
    };
    const app = makeTimelineApp(trainingPrisma(ownerAssignment, [], 'u-owner'));
    const res = await request(app)
      .get('/api/v2/training/assignments/ta-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-trainer', companyId: 'c1',
        permissions: [PERMISSIONS.TRAINING_VIEW_COMPANY],
      })}`);
    expect(res.status).toBe(404);
  });

  it('preserves every submit and review cycle from sanitized audit history', async () => {
    const auditRows = [
      {
        action: 'training.assignment.submit',
        createdAt: new Date('2026-04-03T08:00:00Z'),
        details: JSON.stringify({ assignmentId: 'ta-1', status: 'submitted' }),
        user: { name: 'Requester', role: { name: 'Employee' } },
      },
      {
        action: 'training.assignment.review',
        createdAt: new Date('2026-04-04T08:00:00Z'),
        details: JSON.stringify({ assignmentId: 'ta-1', action: 'return', status: 'returned' }),
        user: { name: 'Rana Reviewer', role: { name: 'Training Manager' } },
      },
      {
        action: 'training.assignment.submit',
        createdAt: new Date('2026-04-05T08:00:00Z'),
        details: JSON.stringify({ assignmentId: 'ta-1', status: 'submitted' }),
        user: { name: 'Requester', role: { name: 'Employee' } },
      },
      {
        action: 'training.assignment.review',
        createdAt: new Date('2026-04-06T08:00:00Z'),
        details: JSON.stringify({ assignmentId: 'ta-1', action: 'accept', status: 'completed' }),
        user: { name: 'Rana Reviewer', role: { name: 'Training Manager' } },
      },
    ];
    const app = makeTimelineApp(trainingPrisma(ASSIGNMENT_ROW, auditRows));
    const res = await request(app)
      .get('/api/v2/training/assignments/ta-1/timeline')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-req', companyId: 'c1', employeeId: 'e-req',
        permissions: [PERMISSIONS.TRAINING_VIEW_OWN],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.events.map((item: any) => item.type)).toEqual([
      'assignment.assigned',
      'assignment.started',
      'assignment.submitted',
      'assignment.returned',
      'assignment.submitted',
      'assignment.completed',
    ]);
    expect(res.body.events.at(-1).reason).toBe('well done');
  });
});
