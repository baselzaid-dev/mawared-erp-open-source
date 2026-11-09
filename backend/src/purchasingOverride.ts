import type { Express, Request, RequestHandler, Response } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { PERMISSIONS } from './permissions';
import {
  isIdempotencyKeyConflict,
  lockPurchaseRequest,
  payloadFingerprint,
} from './purchasingW2Core';

/** Second-confirmation token required in the request body (RC2 override UX, mirrors leave override). */
export const PURCHASING_OVERRIDE_CONFIRMATION = 'OVERRIDE';

type OverrideAction = 'approve' | 'reject' | 'cancel';

const idempotencyKeySchema = z.string().trim().min(8).max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const reasonSchema = z.string().trim().min(1).max(500);
const isoDateTimeSchema = z.string().datetime({ offset: true });

const purchasingOverrideBodySchema = z.object({
  action: z.enum(['approve', 'reject', 'cancel']),
  reason: reasonSchema,
  confirmation: z.literal(PURCHASING_OVERRIDE_CONFIRMATION),
  expectedUpdatedAt: isoDateTimeSchema.optional(),
}).strict();

/** Legal source statuses per override action. Anything else is an illegal transition (409). */
const ALLOWED_FROM_STATUSES: Record<OverrideAction, readonly string[]> = {
  approve: ['pending_department', 'pending_purchasing'],
  reject: ['pending_department', 'pending_purchasing', 'approved'],
  cancel: ['pending_department', 'pending_purchasing', 'approved'],
};

interface PurchasingOverrideUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface PurchasingOverrideRequest extends Request {
  user?: PurchasingOverrideUser;
}

export interface PurchasingOverrideRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkPermission: (permission: string) => RequestHandler;
}

class PurchasingOverrideError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(messageKey);
  }
}

type PurchaseRequestRow = Prisma.PurchaseRequestGetPayload<{
  include: {
    requester: {
      select: {
        id: true;
        employeeNum: true;
        user: { select: { id: true; name: true } };
      };
    };
    orders: { select: { id: true; status: true } };
  };
}>;

type PurchasingOverrideOutcome =
  | { kind: 'not_found' }
  | { kind: 'self' }
  | { kind: 'version_mismatch'; currentUpdatedAt: string }
  | { kind: 'illegal_transition'; currentStatus: string }
  | { kind: 'active_order_exists' }
  | { kind: 'conflict' }
  | { kind: 'idempotency_conflict' }
  | { kind: 'success'; request: ReturnType<typeof shapePurchaseRequestDto> };

const fail = (
  status: number,
  code: string,
  messageKey: string,
  details?: Record<string, unknown>,
): never => {
  throw new PurchasingOverrideError(status, code, messageKey, details);
};

const route = (
  handler: (req: PurchasingOverrideRequest, res: Response) => Promise<unknown>,
): RequestHandler => async (request, response, next) => {
  try {
    await handler(request as PurchasingOverrideRequest, response);
  } catch (error) {
    if (error instanceof PurchasingOverrideError) {
      return response.status(error.status).json({
        error: error.code,
        code: error.status,
        message: error.messageKey,
        messageKey: error.messageKey,
        ...(error.details ?? {}),
      });
    }
    if ((error as { code?: string }).code === 'P2002') {
      return response.status(409).json({
        error: 'IdempotencyKeyReused',
        code: 409,
        message: 'purchasing.override_idempotency_key_reused',
        messageKey: 'purchasing.override_idempotency_key_reused',
      });
    }
    return next(error);
  }
};

const actorFrom = (req: PurchasingOverrideRequest): PurchasingOverrideUser => {
  if (!req.user?.id || !req.user.companyId) {
    fail(401, 'Unauthorized', 'purchasing.unauthorized');
  }
  return req.user!;
};

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail(400, 'InvalidRequest', 'purchasing.invalid_request');
  return parsed.data;
};

/** Idempotency-Key is a required header (not a body field) for this override endpoint. */
const requireIdempotencyKey = (req: Request): string => {
  const header = req.header('Idempotency-Key');
  if (header == null || header.trim() === '') {
    fail(400, 'IdempotencyKeyRequired', 'purchasing.override_idempotency_key_required');
  }
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    fail(400, 'IdempotencyKeyInvalid', 'purchasing.override_idempotency_key_invalid');
  }
  return parsed.data;
};

const targetStatusForAction = (action: OverrideAction): string => {
  switch (action) {
    case 'approve':
      return 'approved';
    case 'reject':
      return 'rejected';
    case 'cancel':
      return 'cancelled';
    default:
      return action;
  }
};

const historyActionFor = (action: OverrideAction): string => `override_${action}`;

/** Fixed audit action name per RC2 policy; per-action detail lives in sanitized `details`. */
const AUDIT_ACTION = 'purchasing.override';

export const shapePurchaseRequestDto = (row: PurchaseRequestRow | (PurchaseRequestRow & { status: string })) => ({
  id: row.id,
  companyId: row.companyId,
  requestNumber: row.requestNumber,
  requestedByEmployeeId: row.requestedByEmployeeId,
  status: row.status,
  totalEstimated: String(row.totalEstimated),
  currency: row.currency,
  departmentReviewNote: row.departmentReviewNote ?? null,
  purchasingReviewNote: row.purchasingReviewNote ?? null,
  rejectedAt: row.rejectedAt ? new Date(row.rejectedAt).toISOString() : null,
  cancelledByUserId: row.cancelledByUserId ?? null,
  cancelledAt: row.cancelledAt ? new Date(row.cancelledAt).toISOString() : null,
  cancellationReason: row.cancellationReason ?? null,
  createdAt: new Date(row.createdAt).toISOString(),
  updatedAt: new Date(row.updatedAt).toISOString(),
});

const requestInclude = {
  requester: {
    select: {
      id: true,
      employeeNum: true,
      user: { select: { id: true, name: true } },
    },
  },
  orders: { select: { id: true, status: true } },
} as const;

interface ClaimPurchasingOverrideInput {
  prisma: PrismaClient;
  purchaseRequestId: string;
  companyId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  action: OverrideAction;
  reason: string;
  expectedUpdatedAt?: string;
  idempotencyKey: string;
}

/** Reads only — satisfied by both the base client and an interactive `tx`. */
type OverrideReadDb = Pick<PrismaClient, 'purchaseWorkflowEvent' | 'purchaseRequest'>;

/**
 * Canonical SHA-256 fingerprint of the *logical* override request, bound to the
 * Idempotency-Key. Two textually-different requests that mean the same thing
 * (whitespace in `reason`, an equivalent `expectedUpdatedAt` representation)
 * hash identically and replay; a same-key retry that changes the target,
 * action, reason, expected version, or actor hashes differently and is a 409
 * rather than a false-success replay. Only this digest is persisted — never the
 * raw client body, token, or confirmation value.
 */
const overrideRequestFingerprint = (input: {
  companyId: string;
  purchaseRequestId: string;
  actorUserId: string;
  action: OverrideAction;
  reason: string;
  expectedUpdatedAt?: string;
}): string =>
  payloadFingerprint({
    kind: 'purchasing_override',
    companyId: input.companyId,
    purchaseRequestId: input.purchaseRequestId,
    // Bind the actor so a *different* authorized admin cannot replay (and thus
    // observe) another admin's operation under the same key — fail closed.
    actorUserId: input.actorUserId,
    action: input.action,
    // `reason` is already Zod-trimmed; that trimmed form is the canonical value.
    reason: input.reason,
    // The required OVERRIDE confirmation is a fixed literal, so bind its
    // semantic presence rather than persisting the raw client value.
    confirmationProvided: true,
    // Normalize to one canonical instant so equivalent ISO representations
    // (with/without offset or trailing zeros) produce the same digest.
    expectedUpdatedAt: input.expectedUpdatedAt
      ? new Date(input.expectedUpdatedAt).toISOString()
      : null,
  });

/**
 * Replays a prior override for this (company, key) when one exists. Returns
 * `null` when there is no prior event (caller proceeds to mutate). A prior event
 * whose target or payload fingerprint differs is an idempotency conflict (409),
 * never a false replay of a different logical request.
 */
async function replayExistingOverride(
  db: OverrideReadDb,
  input: { companyId: string; idempotencyKey: string; purchaseRequestId: string },
  fingerprint: string,
): Promise<PurchasingOverrideOutcome | null> {
  const priorEvent = await db.purchaseWorkflowEvent.findFirst({
    where: { companyId: input.companyId, idempotencyKey: input.idempotencyKey },
  });
  if (!priorEvent) return null;
  const sameLogicalRequest =
    priorEvent.entityType === 'purchase_request'
    && priorEvent.entityId === input.purchaseRequestId
    && priorEvent.payloadFingerprint === fingerprint;
  if (!sameLogicalRequest) return { kind: 'idempotency_conflict' };
  const replayed = await db.purchaseRequest.findFirst({
    where: { id: input.purchaseRequestId, companyId: input.companyId },
    include: requestInclude,
  });
  if (!replayed) return { kind: 'not_found' };
  return { kind: 'success', request: shapePurchaseRequestDto(replayed) };
}

async function claimPurchasingOverride(input: ClaimPurchasingOverrideInput): Promise<PurchasingOverrideOutcome> {
  const fingerprint = overrideRequestFingerprint(input);

  try {
    return await input.prisma.$transaction(async (tx) => {
      // Serialize concurrent same-key overrides on the aggregate root: a second
      // caller blocks here, then observes the winner's committed event below and
      // replays instead of racing to a second state mutation.
      await lockPurchaseRequest(tx, input.purchaseRequestId, input.companyId);

      const replay = await replayExistingOverride(tx, input, fingerprint);
      if (replay) return replay;

      const request = await tx.purchaseRequest.findFirst({
        where: { id: input.purchaseRequestId, companyId: input.companyId },
        include: requestInclude,
      });
      if (!request) return { kind: 'not_found' };
      if (request.requestedByEmployeeId === input.actorEmployeeId) return { kind: 'self' };

      const currentUpdatedAt = request.updatedAt.toISOString();
      if (input.expectedUpdatedAt !== undefined) {
        const expected = new Date(input.expectedUpdatedAt).toISOString();
        if (expected !== currentUpdatedAt) {
          return { kind: 'version_mismatch', currentUpdatedAt };
        }
      }

      const fromStatus = request.status;
      const toStatus = targetStatusForAction(input.action);
      if (!ALLOWED_FROM_STATUSES[input.action].includes(fromStatus)) {
        return { kind: 'illegal_transition', currentStatus: fromStatus };
      }

      if (input.action === 'cancel') {
        const hasActiveOrder = (request.orders ?? []).some((order) => order.status !== 'cancelled');
        if (hasActiveOrder) return { kind: 'active_order_exists' };
      }

      const update: Prisma.PurchaseRequestUncheckedUpdateManyInput = { status: toStatus };
      if (input.action === 'reject') {
        update.rejectedAt = new Date();
      }
      if (input.action === 'cancel') {
        update.cancelledByUserId = input.actorUserId;
        update.cancelledAt = new Date();
        update.cancellationReason = input.reason;
      }

      const claimed = await tx.purchaseRequest.updateMany({
        where: {
          id: request.id,
          companyId: input.companyId,
          status: fromStatus,
        },
        data: update,
      });

      if (claimed.count !== 1) {
        const stillVisible = await tx.purchaseRequest.findFirst({
          where: { id: request.id, companyId: input.companyId },
          select: { id: true },
        });
        return stillVisible ? { kind: 'conflict' } : { kind: 'not_found' };
      }

      await tx.purchaseWorkflowEvent.create({
        data: {
          companyId: input.companyId,
          entityType: 'purchase_request',
          entityId: request.id,
          action: historyActionFor(input.action),
          previousStatus: fromStatus,
          newStatus: toStatus,
          reason: input.reason,
          actorUserId: input.actorUserId,
          idempotencyKey: input.idempotencyKey,
          payloadFingerprint: fingerprint,
        },
      });

      await writeAuditRequired(tx, {
        companyId: input.companyId,
        userId: input.actorUserId,
        action: AUDIT_ACTION,
        details: {
          entityId: request.id,
          action: input.action,
          status: toStatus,
        },
      });

      const requesterUserId = request.requester?.user?.id;
      if (requesterUserId) {
        const notifyTitle = input.action === 'approve'
          ? 'تم اعتماد طلب الشراء (إجراء إداري)'
          : input.action === 'reject'
            ? 'تم رفض طلب الشراء (إجراء إداري)'
            : 'تم إلغاء طلب الشراء (إجراء إداري)';
        const notifyMessage = input.action === 'approve'
          ? 'تم اعتماد طلب الشراء عبر إجراء إداري استثنائي.'
          : input.action === 'reject'
            ? 'تم رفض طلب الشراء عبر إجراء إداري استثنائي.'
            : 'تم إلغاء طلب الشراء عبر إجراء إداري استثنائي.';
        await tx.notification.create({
          data: {
            companyId: input.companyId,
            userId: requesterUserId,
            title: notifyTitle,
            message: notifyMessage,
            category: 'purchasing',
            routeKey: 'purchasing.requests.detail',
            resourceType: 'purchase_request',
            resourceId: request.id,
          },
        });
      }

      const updatedRequest: PurchaseRequestRow = {
        ...request,
        status: toStatus,
        rejectedAt: input.action === 'reject' ? new Date() : request.rejectedAt,
        cancelledByUserId: input.action === 'cancel' ? input.actorUserId : request.cancelledByUserId,
        cancelledAt: input.action === 'cancel' ? new Date() : request.cancelledAt,
        cancellationReason: input.action === 'cancel' ? input.reason : request.cancellationReason,
        updatedAt: new Date(),
      };

      return { kind: 'success', request: shapePurchaseRequestDto(updatedRequest) };
    });
  } catch (error) {
    // Cross-request same-key races don't share the aggregate-root lock, so a
    // concurrent insert can still abort this transaction on the
    // (companyId, idempotencyKey) unique index. Recover the winner in a FRESH
    // context — never a query inside the already-aborted transaction (the
    // W1A/W2 lesson). A different logical request surfaces as 409 here too.
    if (!isIdempotencyKeyConflict(error)) throw error;
    const recovered = await replayExistingOverride(input.prisma, input, fingerprint);
    if (!recovered) throw error;
    return recovered;
  }
}

const sendPurchasingOverrideOutcome = (res: Response, outcome: PurchasingOverrideOutcome): Response => {
  if (outcome.kind === 'not_found') {
    return res.status(404).json({ error: 'NotFound', code: 404, message: 'purchasing.override_not_found', messageKey: 'purchasing.override_not_found' });
  }
  if (outcome.kind === 'self') {
    return res.status(403).json({
      error: 'Forbidden',
      code: 403,
      message: 'purchasing.override_self_forbidden',
      messageKey: 'purchasing.override_self_forbidden',
    });
  }
  if (outcome.kind === 'version_mismatch') {
    return res.status(412).json({
      error: 'VersionMismatch',
      code: 412,
      message: 'purchasing.override_updated_at_mismatch',
      messageKey: 'purchasing.override_updated_at_mismatch',
      currentUpdatedAt: outcome.currentUpdatedAt,
    });
  }
  if (outcome.kind === 'illegal_transition') {
    return res.status(409).json({
      error: 'IllegalTransition',
      code: 409,
      message: 'purchasing.override_illegal_transition',
      messageKey: 'purchasing.override_illegal_transition',
      currentStatus: outcome.currentStatus,
    });
  }
  if (outcome.kind === 'active_order_exists') {
    return res.status(409).json({
      error: 'ActiveOrderExists',
      code: 409,
      message: 'purchasing.override_active_order_exists',
      messageKey: 'purchasing.override_active_order_exists',
    });
  }
  if (outcome.kind === 'conflict') {
    return res.status(409).json({
      error: 'PurchaseRequestStateConflict',
      code: 409,
      message: 'purchasing.override_state_conflict',
      messageKey: 'purchasing.override_state_conflict',
    });
  }
  if (outcome.kind === 'idempotency_conflict') {
    return res.status(409).json({
      error: 'IdempotencyKeyReused',
      code: 409,
      message: 'purchasing.override_idempotency_key_reused',
      messageKey: 'purchasing.override_idempotency_key_reused',
    });
  }
  return res.json(outcome.request);
};

export function registerPurchasingOverrideRoutes({
  app,
  prisma,
  requireAuth,
  checkPermission,
}: PurchasingOverrideRouteDeps): void {
  app.post(
    '/api/v2/purchasing/requests/:id/override',
    requireAuth,
    checkPermission(PERMISSIONS.PURCHASING_ADMIN_OVERRIDE),
    route(async (req, res) => {
      const actor = actorFrom(req);
      const body = parseBody(purchasingOverrideBodySchema, req.body);
      const idempotencyKey = requireIdempotencyKey(req);

      const outcome = await claimPurchasingOverride({
        prisma,
        purchaseRequestId: req.params.id,
        companyId: actor.companyId,
        actorUserId: actor.id,
        actorEmployeeId: actor.employeeId,
        action: body.action,
        reason: body.reason,
        expectedUpdatedAt: body.expectedUpdatedAt,
        idempotencyKey,
      });

      return sendPurchasingOverrideOutcome(res, outcome);
    }),
  );
}

export {
  claimPurchasingOverride,
  purchasingOverrideBodySchema,
  targetStatusForAction,
};
