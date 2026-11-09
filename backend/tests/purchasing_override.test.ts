import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PURCHASING_OVERRIDE_CONFIRMATION,
  registerPurchasingOverrideRoutes,
} from '../src/purchasingOverride';
import { PERMISSIONS } from '../src/permissions';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

type StoreRow = Record<string, unknown>;

function makePurchaseOverridePrisma() {
  const requests: StoreRow[] = [];
  const workflowEvents: StoreRow[] = [];

  const prisma = makeFakePrisma();

  prisma.purchaseRequest = {
    findFirst: vi.fn(async ({ where }: any = {}) => {
      const row = requests.find((request) =>
        request.id === where.id && request.companyId === where.companyId,
      );
      if (!row) return null;
      if (where.status !== undefined && row.status !== where.status) return null;
      return { ...row };
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const row = requests.find((request) =>
        request.id === where.id
        && request.companyId === where.companyId
        && (where.status === undefined || request.status === where.status),
      );
      if (!row) return { count: 0 };
      Object.assign(row, data, { updatedAt: new Date() });
      return { count: 1 };
    }),
  };

  prisma.purchaseWorkflowEvent = {
    findFirst: vi.fn(async ({ where }: any = {}) =>
      workflowEvents.find((event) =>
        event.companyId === where.companyId && event.idempotencyKey === where.idempotencyKey,
      ) ?? null,
    ),
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `event-${workflowEvents.length + 1}`, createdAt: new Date(), ...data };
      workflowEvents.push(row);
      return row;
    }),
  };

  return { prisma, stores: { requests, workflowEvents } };
}

function makePurchasingOverrideApp(prisma: ReturnType<typeof makeFakePrisma>) {
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
    // Mirror production app.ts checkPermission: admin.full is the only bypass.
    if (permissions.includes(PERMISSIONS.ADMIN_FULL) || permissions.includes(required)) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden', code: 403 });
  };

  registerPurchasingOverrideRoutes({
    app,
    prisma: prisma as any,
    requireAuth,
    checkPermission,
  });

  return app;
}

function seedPurchaseRequest(store: StoreRow[], overrides: Partial<StoreRow> = {}) {
  const updatedAt = new Date('2026-07-19T10:00:00.000Z');
  const row: StoreRow = {
    id: 'PR-1',
    companyId: 'c1',
    requestNumber: 'PR-202607-TEST0001',
    requestedByEmployeeId: 'e-requester',
    requesterNameSnapshot: 'Requester',
    requesterNumSnapshot: 'EMP-2',
    departmentId: null,
    departmentNameSnapshot: null,
    title: 'Office chairs',
    justification: null,
    neededByDate: null,
    status: 'pending_purchasing',
    totalEstimated: '500.00',
    currency: 'SAR',
    departmentReviewedByUserId: null,
    departmentReviewedAt: null,
    departmentReviewNote: null,
    purchasingReviewedByUserId: null,
    purchasingReviewedAt: null,
    purchasingReviewNote: null,
    cancelledByUserId: null,
    cancelledAt: null,
    cancellationReason: null,
    rejectedAt: null,
    createdAt: new Date('2026-07-18T00:00:00.000Z'),
    updatedAt,
    requester: {
      id: 'e-requester',
      employeeNum: 'EMP-2',
      user: { id: 'u-requester', name: 'Requester' },
    },
    orders: [],
    ...overrides,
  };
  store.push(row);
  return row;
}

function overrideBody(overrides: Record<string, unknown> = {}) {
  return {
    action: 'approve',
    reason: 'Vendor deadline requires immediate admin override',
    confirmation: PURCHASING_OVERRIDE_CONFIRMATION,
    ...overrides,
  };
}

const overrideToken = (permissions = [PERMISSIONS.PURCHASING_ADMIN_OVERRIDE]) => tokenFor({
  id: 'u-override',
  employeeId: 'e-override',
  permissions,
});

describe('POST /api/v2/purchasing/requests/:id/override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('approves a pending_purchasing request with workflow event, audit, and notification', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', 'override-key-0001')
      .send(overrideBody({ expectedUpdatedAt: '2026-07-19T10:00:00.000Z' }));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(stores.requests[0].status).toBe('approved');

    expect(stores.workflowEvents).toHaveLength(1);
    expect(stores.workflowEvents[0]).toMatchObject({
      entityType: 'purchase_request',
      entityId: 'PR-1',
      action: 'override_approve',
      previousStatus: 'pending_purchasing',
      newStatus: 'approved',
      reason: 'Vendor deadline requires immediate admin override',
      actorUserId: 'u-override',
      idempotencyKey: 'override-key-0001',
    });

    const audit = prisma._store.auditLogs.find((row: StoreRow) => row.action === 'purchasing.override');
    expect(audit).toBeDefined();
    const auditDetails = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
    expect(auditDetails).toMatchObject({ entityId: 'PR-1', action: 'approve', status: 'approved' });
    expect(JSON.stringify(auditDetails)).not.toContain('Vendor deadline');

    expect(prisma._store.notifications).toHaveLength(1);
    expect(prisma._store.notifications[0].userId).toBe('u-requester');
    expect(prisma._store.notifications[0]).toMatchObject({
      routeKey: 'purchasing.requests.detail',
      resourceType: 'purchase_request',
      resourceId: 'PR-1',
      category: 'purchasing',
    });
  });

  it('rejects an approved request and preserves prior review notes', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests, {
      status: 'approved',
      departmentReviewNote: 'Looks fine from dept',
      purchasingReviewNote: 'Approved by purchasing officer',
    });
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', 'override-key-0002')
      .send(overrideBody({ action: 'reject', reason: 'Budget freeze this quarter' }));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.departmentReviewNote).toBe('Looks fine from dept');
    expect(res.body.purchasingReviewNote).toBe('Approved by purchasing officer');
    expect(stores.requests[0].departmentReviewNote).toBe('Looks fine from dept');
    expect(stores.workflowEvents[0].action).toBe('override_reject');
  });

  it('cancels a pending_department request with no active orders', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests, { status: 'pending_department', orders: [] });
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', 'override-key-0003')
      .send(overrideBody({ action: 'cancel', reason: 'Duplicate submission' }));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.cancellationReason).toBe('Duplicate submission');
    expect(res.body.cancelledByUserId).toBe('u-override');
    expect(stores.workflowEvents[0].action).toBe('override_cancel');
  });

  it('returns 409 ActiveOrderExists when cancelling a request with a non-cancelled order', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests, {
      status: 'approved',
      orders: [{ id: 'PO-1', status: 'issued' }],
    });
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', 'override-key-0004')
      .send(overrideBody({ action: 'cancel', reason: 'Trying to cancel with active order' }));

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ActiveOrderExists');
    expect(stores.workflowEvents).toHaveLength(0);
  });

  it('returns 409 IllegalTransition when the action is not legal from the current status', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests, { status: 'cancelled' });
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', 'override-key-0005')
      .send(overrideBody({ action: 'approve' }));

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('IllegalTransition');
    expect(res.body.currentStatus).toBe('cancelled');
    expect(stores.workflowEvents).toHaveLength(0);
  });

  it('returns 403 without purchasing.admin_override (ordinary purchasing.approve is not enough)', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-buyer', employeeId: 'e-buyer', permissions: [PERMISSIONS.PURCHASING_APPROVE] })}`)
      .set('Idempotency-Key', 'override-key-0006')
      .send(overrideBody());

    expect(res.status).toBe(403);
    expect(stores.workflowEvents).toHaveLength(0);
  });

  it('allows admin.full as the existing global checkPermission bypass (still blocks self-override)', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-admin', employeeId: 'e-admin', permissions: [PERMISSIONS.ADMIN_FULL] })}`)
      .set('Idempotency-Key', 'override-key-0006b')
      .send(overrideBody({ action: 'approve' }));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(stores.workflowEvents).toHaveLength(1);
  });

  it('returns 403 when overriding a request the actor themselves submitted', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests, { requestedByEmployeeId: 'e-override' });
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', 'override-key-0007')
      .send(overrideBody());

    expect(res.status).toBe(403);
    expect(res.body.messageKey).toBe('purchasing.override_self_forbidden');
    expect(stores.workflowEvents).toHaveLength(0);
  });

  it('returns opaque 404 for cross-tenant purchase request ids', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests, { companyId: 'c-other' });
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', 'override-key-0008')
      .send(overrideBody());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NotFound');
  });

  it('returns 400 for an empty reason', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', 'override-key-0009')
      .send(overrideBody({ reason: '   ' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('returns 400 when confirmation token is not OVERRIDE', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', 'override-key-0010')
      .send(overrideBody({ confirmation: 'CONFIRM' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('returns 400 when the Idempotency-Key header is missing', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .send(overrideBody());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('IdempotencyKeyRequired');
  });

  it('returns 400 when the Idempotency-Key header is too short', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', 'short')
      .send(overrideBody());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('IdempotencyKeyInvalid');
  });

  it('returns 412 when expectedUpdatedAt does not match', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', 'override-key-0011')
      .send(overrideBody({ expectedUpdatedAt: '2026-07-19T11:00:00.000Z' }));

    expect(res.status).toBe(412);
    expect(res.body.error).toBe('VersionMismatch');
    expect(res.body.currentUpdatedAt).toBe('2026-07-19T10:00:00.000Z');
    expect(stores.workflowEvents).toHaveLength(0);
  });

  it('returns 409 on concurrent status change (atomic guard)', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    prisma.purchaseRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    const app = makePurchasingOverrideApp(prisma);

    const res = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', 'override-key-0012')
      .send(overrideBody());

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PurchaseRequestStateConflict');
    expect(stores.workflowEvents).toHaveLength(0);
  });

  it('replays the same Idempotency-Key without appending a duplicate workflow event', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    const app = makePurchasingOverrideApp(prisma);
    const idempotencyKey = 'override-key-replay-01';

    const first = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(overrideBody());

    const second = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(overrideBody());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('approved');
    expect(stores.workflowEvents).toHaveLength(1);
  });

  it('returns 409 IdempotencyKeyReused when the same key targets a different request', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests, { id: 'PR-1' });
    seedPurchaseRequest(stores.requests, { id: 'PR-2', requestedByEmployeeId: 'e-other-requester' });
    const app = makePurchasingOverrideApp(prisma);
    const idempotencyKey = 'override-key-reused-01';

    const first = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(overrideBody());

    const second = await request(app)
      .post('/api/v2/purchasing/requests/PR-2/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(overrideBody());

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('IdempotencyKeyReused');
  });

  it('returns 409 IdempotencyKeyReused when the same key changes the action', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    const app = makePurchasingOverrideApp(prisma);
    const idempotencyKey = 'override-key-diff-action-01';

    const first = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(overrideBody({ action: 'approve' }));

    const second = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(overrideBody({ action: 'reject' }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('IdempotencyKeyReused');
    // The winner's state and single side effect must be preserved.
    expect(stores.requests[0].status).toBe('approved');
    expect(stores.workflowEvents).toHaveLength(1);
    expect(stores.workflowEvents[0].action).toBe('override_approve');
  });

  it('returns 409 IdempotencyKeyReused when the same key changes the reason', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    const app = makePurchasingOverrideApp(prisma);
    const idempotencyKey = 'override-key-diff-reason-01';

    const first = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(overrideBody({ reason: 'Original documented reason for override' }));

    const second = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(overrideBody({ reason: 'A completely different reason' }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('IdempotencyKeyReused');
    expect(stores.workflowEvents).toHaveLength(1);
    expect(stores.workflowEvents[0].reason).toBe('Original documented reason for override');
  });

  it('returns 409 IdempotencyKeyReused when the same key changes expectedUpdatedAt', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    const app = makePurchasingOverrideApp(prisma);
    const idempotencyKey = 'override-key-diff-version-01';

    const first = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(overrideBody({ expectedUpdatedAt: '2026-07-19T10:00:00.000Z' }));

    const second = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', idempotencyKey)
      // A different (later) expected version is a different logical request.
      .send(overrideBody({ expectedUpdatedAt: '2026-07-19T12:00:00.000Z' }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('IdempotencyKeyReused');
    expect(stores.workflowEvents).toHaveLength(1);
  });

  it('returns 409 IdempotencyKeyReused when a different actor reuses the key (fail closed)', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    const app = makePurchasingOverrideApp(prisma);
    const idempotencyKey = 'override-key-diff-actor-01';

    const first = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-admin-a', employeeId: 'e-admin-a', permissions: [PERMISSIONS.PURCHASING_ADMIN_OVERRIDE] })}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(overrideBody());

    const second = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-admin-b', employeeId: 'e-admin-b', permissions: [PERMISSIONS.PURCHASING_ADMIN_OVERRIDE] })}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(overrideBody());

    expect(first.status).toBe(200);
    // A second authorized admin must not replay (and thus observe) admin A's result.
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('IdempotencyKeyReused');
    expect(stores.workflowEvents).toHaveLength(1);
  });

  it('replays a canonical-equivalent retry (whitespace reason, offset timestamp)', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests);
    const app = makePurchasingOverrideApp(prisma);
    const idempotencyKey = 'override-key-canonical-01';

    const first = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(overrideBody({
        reason: 'Vendor deadline requires immediate admin override',
        // UTC instant matching the seeded updatedAt (2026-07-19T10:00:00.000Z).
        expectedUpdatedAt: '2026-07-19T10:00:00.000Z',
      }));

    const second = await request(app)
      .post('/api/v2/purchasing/requests/PR-1/override')
      .set('Authorization', `Bearer ${overrideToken()}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(overrideBody({
        // Same trimmed reason, and the same instant expressed with an offset.
        reason: '   Vendor deadline requires immediate admin override   ',
        expectedUpdatedAt: '2026-07-19T13:00:00.000+03:00',
      }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('approved');
    // Equivalent representations must replay, not conflict — still one event.
    expect(stores.workflowEvents).toHaveLength(1);
  });

  it('scopes the idempotency key per company (same textual key, no tenant leakage)', async () => {
    const { prisma, stores } = makePurchaseOverridePrisma();
    seedPurchaseRequest(stores.requests, { id: 'PR-C1', companyId: 'c1', requestedByEmployeeId: 'e-req-c1' });
    seedPurchaseRequest(stores.requests, { id: 'PR-C2', companyId: 'c2', requestedByEmployeeId: 'e-req-c2' });
    const app = makePurchasingOverrideApp(prisma);
    const sharedKey = 'override-key-shared-across-companies';

    const first = await request(app)
      .post('/api/v2/purchasing/requests/PR-C1/override')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-c1', companyId: 'c1', employeeId: 'e-admin-c1', permissions: [PERMISSIONS.PURCHASING_ADMIN_OVERRIDE] })}`)
      .set('Idempotency-Key', sharedKey)
      .send(overrideBody());

    const second = await request(app)
      .post('/api/v2/purchasing/requests/PR-C2/override')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-c2', companyId: 'c2', employeeId: 'e-admin-c2', permissions: [PERMISSIONS.PURCHASING_ADMIN_OVERRIDE] })}`)
      .set('Idempotency-Key', sharedKey)
      .send(overrideBody());

    // The same textual key in a different company is an independent operation.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(stores.workflowEvents).toHaveLength(2);
    expect(stores.workflowEvents.map((event) => event.companyId).sort()).toEqual(['c1', 'c2']);
  });
});
