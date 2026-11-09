/**
 * Commercial Wave 2 — line-level partial receipt and supplier returns.
 * Operations Slice E1.
 *
 * Model
 * -----
 * A `PurchaseReceipt` is an immutable goods-receipt event with one line per
 * purchase-order line. A `PurchaseReturn` is a compensating event against
 * quantities that were actually received. Nothing overwrites receipt history.
 *
 * For each purchase-order line the derived position is:
 *
 *   received  = Σ receipt line quantities
 *   returned  = Σ return line quantities of returns in (pending_approval, approved)
 *   net       = received − returned
 *   remaining = max(ordered − net, 0)
 *
 * A `pending_approval` return already holds its quantity, so two concurrent
 * returns can never together exceed what was received. A rejected return
 * releases its quantity again.
 *
 * Concurrency: every quantity mutation takes `SELECT ... FOR UPDATE` on the
 * parent `PurchaseOrder` row first, so concurrent receives, concurrent returns,
 * and a full-receive racing a partial receive all serialize on one lock and the
 * position is always recomputed inside that lock.
 *
 * Idempotency: `Idempotency-Key` is required. The prior row is looked up
 * *before* any write (never inside an aborted transaction); an exact retry
 * replays it and a different payload on the same key is a 409.
 */

import type { Express, RequestHandler } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { PERMISSIONS } from './permissions';
import { assertVisibleRequest } from './purchasing';
import {
  assertQuantityWithinRange,
  computeLinePosition,
  milliToQuantity,
  quantityToMilli,
  readMoney,
  readQuantity,
  storedQuantityToMilli,
  type LineQuantityPosition,
} from './purchasingMath';
import {
  fail,
  generateDocumentNumber,
  has,
  isIdempotencyKeyConflict,
  lockPurchaseOrder,
  optionalText,
  parseBody,
  payloadFingerprint,
  requireIdempotencyKey,
  retryDocumentNumberCollision,
  sendW2Error,
  timestamp,
  type PurchasingW2Request,
  type PurchasingW2User,
} from './purchasingW2Core';

interface ReceiptRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
}

/** Second-confirmation token for an explicit over-receipt (mirrors purchasingOverride.ts). */
export const RECEIPT_OVERRIDE_CONFIRMATION = 'OVERRIDE';

export const RETURN_REASON_CODES = [
  'damaged',
  'wrong_item',
  'excess_quantity',
  'quality_rejected',
  'expired',
  'other',
] as const;

/** Return quantities are held by pending and approved returns alike. */
const HOLDING_RETURN_STATUSES = ['pending_approval', 'approved'] as const;

const quantityText = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/, 'الكمية غير صالحة');

const receiptLineSchema = z
  .object({
    purchaseOrderLineId: z.string().uuid(),
    quantity: quantityText,
    note: optionalText(500),
  })
  .strict();

const receiptBodySchema = z
  .object({
    lines: z.array(receiptLineSchema).min(1).max(50),
    referenceNumber: optionalText(120),
    note: optionalText(1000),
    override: z
      .object({
        confirmation: z.literal(RECEIPT_OVERRIDE_CONFIRMATION),
        reason: z.string().trim().min(1).max(500),
      })
      .strict()
      .optional(),
  })
  .strict();

const returnLineSchema = z
  .object({
    purchaseOrderLineId: z.string().uuid(),
    quantity: quantityText,
    note: optionalText(500),
  })
  .strict();

const returnBodySchema = z
  .object({
    reasonCode: z.enum(RETURN_REASON_CODES),
    note: optionalText(1000),
    lines: z.array(returnLineSchema).min(1).max(50),
  })
  .strict();

const returnReviewSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    note: optionalText(1000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'reject' && !value.note?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'سبب الرفض مطلوب' });
    }
  });

const orderVisibilityInclude = {
  lines: { orderBy: { createdAt: 'asc' as const } },
  purchaseRequest: {
    include: {
      requester: {
        select: {
          id: true,
          employeeNum: true,
          user: { select: { id: true, name: true, role: { select: { permissions: true } } } },
        },
      },
    },
  },
} as const;

const receiptInclude = {
  lines: { orderBy: { createdAt: 'asc' as const } },
  receivedBy: { select: { id: true, name: true } },
} as const;

const returnInclude = {
  lines: { orderBy: { createdAt: 'asc' as const } },
  createdBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
} as const;

export const receiptShape = (row: any) => ({
  id: row.id,
  companyId: row.companyId,
  purchaseOrderId: row.purchaseOrderId,
  receiptNumber: row.receiptNumber,
  receiptKind: row.receiptKind,
  referenceNumber: row.referenceNumber ?? null,
  note: row.note ?? null,
  receivedBy: row.receivedBy ? { id: row.receivedBy.id, name: row.receivedBy.name } : null,
  receivedAt: timestamp(row.receivedAt),
  overrideApplied: Boolean(row.overrideApplied),
  overrideReason: row.overrideReason ?? null,
  lines: (row.lines ?? []).map((line: any) => ({
    id: line.id,
    purchaseOrderLineId: line.purchaseOrderLineId,
    quantity: readQuantity(line.quantity),
    note: line.note ?? null,
  })),
  createdAt: timestamp(row.createdAt),
});

export const purchaseReturnShape = (row: any) => ({
  id: row.id,
  companyId: row.companyId,
  purchaseOrderId: row.purchaseOrderId,
  returnNumber: row.returnNumber,
  status: row.status,
  reasonCode: row.reasonCode,
  note: row.note ?? null,
  createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
  createdAt: timestamp(row.createdAt),
  review: row.reviewedAt
    ? {
        actor: row.reviewedBy ? { id: row.reviewedBy.id, name: row.reviewedBy.name } : null,
        reviewedAt: timestamp(row.reviewedAt),
        note: row.reviewNote ?? null,
      }
    : null,
  lines: (row.lines ?? []).map((line: any) => ({
    id: line.id,
    purchaseOrderLineId: line.purchaseOrderLineId,
    quantity: readQuantity(line.quantity),
    note: line.note ?? null,
  })),
  updatedAt: timestamp(row.updatedAt),
});

export interface OrderLineProgress extends LineQuantityPosition {
  purchaseOrderLineId: string;
  descriptionSnapshot: string;
  unitSnapshot: string;
  unitPrice: string;
  orderedQuantity: string;
  receivedQuantity: string;
  returnedQuantity: string;
  netReceivedQuantity: string;
  remainingQuantity: string;
  fullyReceived: boolean;
}

export interface OrderReceiptProgress {
  purchaseOrderId: string;
  fullyReceived: boolean;
  anyReceived: boolean;
  lines: OrderLineProgress[];
}

/**
 * Recomputes every line position from the immutable receipt/return events.
 * Callers must already hold the `PurchaseOrder` row lock when the result is
 * used to authorize a mutation.
 */
export async function loadOrderProgress(
  client: any,
  companyId: string,
  orderLines: Array<{ id: string; quantity: unknown; descriptionSnapshot: string; unitSnapshot: string; unitPrice: unknown }>,
  purchaseOrderId: string,
): Promise<OrderReceiptProgress> {
  const lineIds = orderLines.map((line) => line.id);
  const [receiptLines, returnLines] = lineIds.length
    ? await Promise.all([
        client.purchaseReceiptLine.findMany({
          where: { companyId, purchaseOrderLineId: { in: lineIds } },
          select: { purchaseOrderLineId: true, quantity: true },
        }),
        client.purchaseReturnLine.findMany({
          where: {
            companyId,
            purchaseOrderLineId: { in: lineIds },
            purchaseReturn: { status: { in: [...HOLDING_RETURN_STATUSES] } },
          },
          select: { purchaseOrderLineId: true, quantity: true },
        }),
      ])
    : [[], []];

  const receivedByLine = new Map<string, bigint>();
  for (const line of receiptLines) {
    receivedByLine.set(
      line.purchaseOrderLineId,
      (receivedByLine.get(line.purchaseOrderLineId) ?? 0n) + storedQuantityToMilli(line.quantity),
    );
  }
  const returnedByLine = new Map<string, bigint>();
  for (const line of returnLines) {
    returnedByLine.set(
      line.purchaseOrderLineId,
      (returnedByLine.get(line.purchaseOrderLineId) ?? 0n) + storedQuantityToMilli(line.quantity),
    );
  }

  const lines: OrderLineProgress[] = orderLines.map((line) => {
    const position = computeLinePosition({
      orderedMilli: storedQuantityToMilli(line.quantity),
      receivedMilli: receivedByLine.get(line.id) ?? 0n,
      returnedMilli: returnedByLine.get(line.id) ?? 0n,
    });
    return {
      ...position,
      purchaseOrderLineId: line.id,
      descriptionSnapshot: line.descriptionSnapshot,
      unitSnapshot: line.unitSnapshot,
      unitPrice: readMoney(line.unitPrice),
      orderedQuantity: milliToQuantity(position.orderedMilli),
      receivedQuantity: milliToQuantity(position.receivedMilli),
      returnedQuantity: milliToQuantity(position.returnedMilli),
      netReceivedQuantity: milliToQuantity(position.netReceivedMilli),
      remainingQuantity: milliToQuantity(position.remainingMilli),
      fullyReceived: position.netReceivedMilli >= position.orderedMilli,
    };
  });

  return {
    purchaseOrderId,
    fullyReceived: lines.length > 0 && lines.every((line) => line.fullyReceived),
    anyReceived: lines.some((line) => line.receivedMilli > 0n),
    lines,
  };
}

/** JSON-safe progress payload (BigInt fields removed). */
export const progressShape = (progress: OrderReceiptProgress) => ({
  purchaseOrderId: progress.purchaseOrderId,
  fullyReceived: progress.fullyReceived,
  anyReceived: progress.anyReceived,
  lines: progress.lines.map((line) => ({
    purchaseOrderLineId: line.purchaseOrderLineId,
    descriptionSnapshot: line.descriptionSnapshot,
    unitSnapshot: line.unitSnapshot,
    unitPrice: line.unitPrice,
    orderedQuantity: line.orderedQuantity,
    receivedQuantity: line.receivedQuantity,
    returnedQuantity: line.returnedQuantity,
    netReceivedQuantity: line.netReceivedQuantity,
    remainingQuantity: line.remainingQuantity,
    fullyReceived: line.fullyReceived,
  })),
});

/** Order statuses from which a further receipt may be recorded. */
const RECEIVABLE_ORDER_STATUSES = ['issued', 'partially_received', 'received'] as const;

const assertReceivableOrder = (status: string) => {
  if (!(RECEIVABLE_ORDER_STATUSES as readonly string[]).includes(status)) {
    fail(409, 'ORDER_RECEIVE_INVALID', 'لا يمكن تسجيل استلام لأمر الشراء في حالته الحالية');
  }
};

/**
 * Applies the derived coverage to the order and its request.
 * The whole-order and line-level paths share this so the two can never disagree.
 */
export async function applyReceiptCoverage(
  tx: any,
  input: {
    companyId: string;
    orderId: string;
    purchaseRequestId: string;
    progress: OrderReceiptProgress;
    receivedByUserId: string;
    receivedAt: Date;
    receiptNote: string | null;
  },
): Promise<void> {
  if (input.progress.fullyReceived) {
    await tx.purchaseOrder.update({
      where: { id: input.orderId },
      data: {
        status: 'received',
        receivedByUserId: input.receivedByUserId,
        receivedAt: input.receivedAt,
        ...(input.receiptNote != null ? { receiptNote: input.receiptNote } : {}),
      },
    });
    await tx.purchaseRequest.update({
      where: { id: input.purchaseRequestId },
      data: { status: 'received' },
    });
    return;
  }
  await tx.purchaseOrder.update({
    where: { id: input.orderId },
    data: {
      status: 'partially_received',
      ...(input.receiptNote != null ? { receiptNote: input.receiptNote } : {}),
    },
  });
  await tx.purchaseRequest.update({
    where: { id: input.purchaseRequestId },
    data: { status: 'ordered' },
  });
}

/**
 * Creates the single receipt event that the legacy whole-order receive endpoint
 * records. It covers every remaining quantity, computed transactionally inside
 * the caller's `PurchaseOrder` row lock, so "received to date" stays exact.
 */
export async function recordFullReceiptEvent(
  tx: any,
  input: {
    companyId: string;
    orderId: string;
    progress: OrderReceiptProgress;
    receivedByUserId: string;
    receivedAt: Date;
    note: string | null;
    idempotencyKey: string;
  },
): Promise<{ receiptId: string; lineCount: number } | null> {
  const lines = input.progress.lines
    .filter((line) => line.remainingMilli > 0n)
    .map((line) => ({
      purchaseOrderLineId: line.purchaseOrderLineId,
      quantity: new Prisma.Decimal(milliToQuantity(line.remainingMilli)),
    }));
  if (lines.length === 0) return null;

  const receipt = await retryDocumentNumberCollision('receiptNumber', async () =>
    tx.purchaseReceipt.create({
      data: {
        companyId: input.companyId,
        purchaseOrderId: input.orderId,
        receiptNumber: generateDocumentNumber('GRN'),
        receiptKind: 'full',
        note: input.note,
        receivedByUserId: input.receivedByUserId,
        receivedAt: input.receivedAt,
        idempotencyKey: input.idempotencyKey,
        payloadFingerprint: payloadFingerprint({ kind: 'full', orderId: input.orderId, lines }),
        // companyId is supplied by the parent composite relation.
        lines: { create: lines },
      },
      select: { id: true },
    }),
  );
  return { receiptId: receipt.id, lineCount: lines.length };
}

const loadVisibleOrder = async (prisma: any, user: PurchasingW2User, orderId: string) => {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: orderId, companyId: user.companyId },
    include: orderVisibilityInclude,
  });
  // Opaque 404 for a cross-company id, matching the existing purchasing convention.
  if (!order) fail(404, 'PURCHASE_ORDER_NOT_FOUND', 'أمر الشراء غير موجود');
  await assertVisibleRequest(prisma, user as any, order.purchaseRequest);
  return order;
};

/** Looks up a prior identical mutation before any write is attempted. */
async function replayReceipt(tx: any, companyId: string, idempotencyKey: string, fingerprint: string, orderId: string) {
  const prior = await tx.purchaseReceipt.findFirst({
    where: { companyId, idempotencyKey },
    include: receiptInclude,
  });
  if (!prior) return null;
  if (prior.purchaseOrderId !== orderId || prior.payloadFingerprint !== fingerprint) {
    fail(409, 'IDEMPOTENCY_CONFLICT', 'تم استخدام مفتاح منع التكرار لعملية مختلفة');
  }
  return prior;
}

/**
 * Runs a create that is protected by a company-scoped idempotency key.
 *
 * If a concurrent request with the same key wins, this transaction is aborted by
 * the unique constraint. The winning row is then re-read through `replay` in a
 * fresh transaction and returned as a replay, so an exact concurrent retry gets
 * the stored result instead of a confusing conflict. A genuinely different
 * payload on the same key still fails inside `replay` with 409.
 */
async function withIdempotencyReplay<TRow, TOutcome>(
  replay: () => Promise<TRow | null>,
  asReplayed: (row: TRow) => TOutcome,
  create: () => Promise<TOutcome>,
): Promise<TOutcome> {
  try {
    return await create();
  } catch (error) {
    if (!isIdempotencyKeyConflict(error)) throw error;
    const winner = await replay();
    if (!winner) throw error;
    return asReplayed(winner);
  }
}

async function replayReturn(tx: any, companyId: string, idempotencyKey: string, fingerprint: string, orderId: string) {
  const prior = await tx.purchaseReturn.findFirst({
    where: { companyId, idempotencyKey },
    include: returnInclude,
  });
  if (!prior) return null;
  if (prior.purchaseOrderId !== orderId || prior.payloadFingerprint !== fingerprint) {
    fail(409, 'IDEMPOTENCY_CONFLICT', 'تم استخدام مفتاح منع التكرار لعملية مختلفة');
  }
  return prior;
}

export function registerPurchasingReceiptRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
}: ReceiptRouteDeps): void {
  const viewScope = checkAnyPermission(
    PERMISSIONS.PURCHASING_VIEW_OWN,
    PERMISSIONS.PURCHASING_VIEW_DEPARTMENT,
    PERMISSIONS.PURCHASING_VIEW,
  );

  app.get(
    '/api/v2/purchasing/orders/:id/receipts',
    requireAuth,
    viewScope,
    async (req: PurchasingW2Request, res) => {
      try {
        const user = req.user!;
        const order = await loadVisibleOrder(prisma, user, req.params.id);
        const [receipts, progress] = await Promise.all([
          prisma.purchaseReceipt.findMany({
            where: { companyId: user.companyId, purchaseOrderId: order.id },
            include: receiptInclude,
            orderBy: { receivedAt: 'asc' },
            take: 200,
          }),
          loadOrderProgress(prisma, user.companyId, order.lines as any, order.id),
        ]);
        return res.json({
          items: receipts.map(receiptShape),
          total: receipts.length,
          progress: progressShape(progress),
        });
      } catch (error) {
        return sendW2Error(res, error);
      }
    },
  );

  app.post(
    '/api/v2/purchasing/orders/:id/receipts',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PURCHASING_RECEIVE),
    async (req: PurchasingW2Request, res) => {
      try {
        const user = req.user!;
        const body = parseBody(receiptBodySchema, req.body);
        const idempotencyKey = requireIdempotencyKey(req);
        await loadVisibleOrder(prisma, user, req.params.id);

        const duplicateLine = new Set<string>();
        for (const line of body.lines) {
          if (duplicateLine.has(line.purchaseOrderLineId)) {
            fail(400, 'DUPLICATE_RECEIPT_LINE', 'لا يمكن تكرار بند الاستلام نفسه');
          }
          duplicateLine.add(line.purchaseOrderLineId);
        }

        if (body.override && !has(user, PERMISSIONS.PURCHASING_ADMIN_OVERRIDE)) {
          fail(403, 'RECEIPT_OVERRIDE_FORBIDDEN', 'لا تملك صلاحية تجاوز الكمية المطلوبة');
        }

        const fingerprint = payloadFingerprint({
          kind: 'partial',
          orderId: req.params.id,
          referenceNumber: body.referenceNumber ?? null,
          note: body.note ?? null,
          override: body.override ? { reason: body.override.reason } : null,
          lines: body.lines.map((line) => ({
            purchaseOrderLineId: line.purchaseOrderLineId,
            quantity: milliToQuantity(quantityToMilli(line.quantity)),
            note: line.note ?? null,
          })),
        });

        const outcome = await withIdempotencyReplay(
          // A concurrent request with the same key aborts this transaction, so the
          // winner is re-read afterwards in a fresh one, never inside the aborted one.
          () => replayReceipt(prisma, user.companyId, idempotencyKey, fingerprint, req.params.id),
          (row) => ({ row, replayed: true, progress: null as OrderReceiptProgress | null }),
          () => retryDocumentNumberCollision('receiptNumber', () =>
          prisma.$transaction(async (tx) => {
            // Lock first, then replay: a concurrent same-key retry is serialized
            // and finds the winner instead of racing to insert.
            await lockPurchaseOrder(tx, req.params.id, user.companyId);
            const replay = await replayReceipt(tx, user.companyId, idempotencyKey, fingerprint, req.params.id);
            if (replay) return { row: replay, replayed: true, progress: null as OrderReceiptProgress | null };

            const order = await tx.purchaseOrder.findFirst({
              where: { id: req.params.id, companyId: user.companyId },
              include: { lines: { orderBy: { createdAt: 'asc' } } },
            });
            if (!order) fail(404, 'PURCHASE_ORDER_NOT_FOUND', 'أمر الشراء غير موجود');
            assertReceivableOrder(order.status);

            const before = await loadOrderProgress(tx, user.companyId, order.lines as any, order.id);
            const positionByLine = new Map(before.lines.map((line) => [line.purchaseOrderLineId, line]));

            let overrideNeeded = false;
            const creates: Array<{ purchaseOrderLineId: string; quantity: Prisma.Decimal; note: string | null }> = [];
            for (const line of body.lines) {
              const position = positionByLine.get(line.purchaseOrderLineId);
              if (!position) {
                fail(400, 'INVALID_ORDER_LINE', 'أحد البنود لا يتبع أمر الشراء');
              }
              const requested = quantityToMilli(line.quantity);
              if (requested <= 0n) {
                fail(400, 'INVALID_QUANTITY', 'يجب أن تكون الكمية أكبر من صفر');
              }
              assertQuantityWithinRange(position!.netReceivedMilli + requested);
              if (requested > position!.remainingMilli) {
                if (!body.override) {
                  fail(409, 'RECEIPT_EXCEEDS_REMAINING', 'الكمية المستلمة تتجاوز الكمية المتبقية');
                }
                overrideNeeded = true;
              }
              creates.push({
                purchaseOrderLineId: line.purchaseOrderLineId,
                quantity: new Prisma.Decimal(milliToQuantity(requested)),
                note: line.note ?? null,
              });
            }

            if (body.override && !overrideNeeded) {
              fail(400, 'RECEIPT_OVERRIDE_NOT_REQUIRED', 'لا حاجة لتجاوز الكمية في هذا الاستلام');
            }

            const receivedAt = new Date();
            const receipt = await tx.purchaseReceipt.create({
              data: {
                companyId: user.companyId,
                purchaseOrderId: order.id,
                receiptNumber: generateDocumentNumber('GRN'),
                receiptKind: 'partial',
                referenceNumber: body.referenceNumber ?? null,
                note: body.note ?? null,
                receivedByUserId: user.id,
                receivedAt,
                overrideApplied: overrideNeeded,
                overrideReason: overrideNeeded ? body.override!.reason : null,
                idempotencyKey,
                payloadFingerprint: fingerprint,
                // companyId is supplied by the parent composite relation.
                lines: { create: creates },
              },
              include: receiptInclude,
            });

            const after = await loadOrderProgress(tx, user.companyId, order.lines as any, order.id);
            await applyReceiptCoverage(tx, {
              companyId: user.companyId,
              orderId: order.id,
              purchaseRequestId: order.purchaseRequestId,
              progress: after,
              receivedByUserId: user.id,
              receivedAt,
              receiptNote: body.note ?? null,
            });

            await tx.purchaseWorkflowEvent.create({
              data: {
                companyId: user.companyId,
                entityType: 'purchase_order',
                entityId: order.id,
                action: 'order_receive_partial',
                previousStatus: order.status,
                newStatus: after.fullyReceived ? 'received' : 'partially_received',
                reason: overrideNeeded ? 'receipt_over_receipt_override' : 'receipt_recorded',
                actorUserId: user.id,
                idempotencyKey: null,
              },
            });

            await writeAuditRequired(tx, {
              companyId: user.companyId,
              userId: user.id,
              action: 'purchasing.order.receive_partial',
              details: {
                orderId: order.id,
                requestId: order.purchaseRequestId,
                receiptId: receipt.id,
                lineCount: creates.length,
                previousStatus: order.status,
                newStatus: after.fullyReceived ? 'received' : 'partially_received',
                overrideApplied: overrideNeeded,
                ...(overrideNeeded ? { reasonProvided: true } : {}),
              },
            });

            return { row: receipt, replayed: false, progress: after };
          }),
        ));

        const progress =
          outcome.progress ??
          (await (async () => {
            const order = await prisma.purchaseOrder.findFirst({
              where: { id: req.params.id, companyId: user.companyId },
              include: { lines: { orderBy: { createdAt: 'asc' } } },
            });
            return order ? loadOrderProgress(prisma, user.companyId, order.lines as any, order.id) : null;
          })());

        return res.status(outcome.replayed ? 200 : 201).json({
          receipt: receiptShape(outcome.row),
          progress: progress ? progressShape(progress) : null,
        });
      } catch (error) {
        return sendW2Error(res, error);
      }
    },
  );

  app.get(
    '/api/v2/purchasing/orders/:id/returns',
    requireAuth,
    viewScope,
    async (req: PurchasingW2Request, res) => {
      try {
        const user = req.user!;
        const order = await loadVisibleOrder(prisma, user, req.params.id);
        const rows = await prisma.purchaseReturn.findMany({
          where: { companyId: user.companyId, purchaseOrderId: order.id },
          include: returnInclude,
          orderBy: { createdAt: 'asc' },
          take: 200,
        });
        return res.json({ items: rows.map(purchaseReturnShape), total: rows.length });
      } catch (error) {
        return sendW2Error(res, error);
      }
    },
  );

  app.post(
    '/api/v2/purchasing/orders/:id/returns',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PURCHASING_RETURN_CREATE),
    async (req: PurchasingW2Request, res) => {
      try {
        const user = req.user!;
        const body = parseBody(returnBodySchema, req.body);
        const idempotencyKey = requireIdempotencyKey(req);
        await loadVisibleOrder(prisma, user, req.params.id);

        const seen = new Set<string>();
        for (const line of body.lines) {
          if (seen.has(line.purchaseOrderLineId)) {
            fail(400, 'DUPLICATE_RETURN_LINE', 'لا يمكن تكرار بند الإرجاع نفسه');
          }
          seen.add(line.purchaseOrderLineId);
        }

        const fingerprint = payloadFingerprint({
          orderId: req.params.id,
          reasonCode: body.reasonCode,
          note: body.note ?? null,
          lines: body.lines.map((line) => ({
            purchaseOrderLineId: line.purchaseOrderLineId,
            quantity: milliToQuantity(quantityToMilli(line.quantity)),
            note: line.note ?? null,
          })),
        });

        const outcome = await withIdempotencyReplay(
          () => replayReturn(prisma, user.companyId, idempotencyKey, fingerprint, req.params.id),
          (row) => ({ row, replayed: true }),
          () => retryDocumentNumberCollision('returnNumber', () =>
          prisma.$transaction(async (tx) => {
            // Lock first, then replay: a concurrent same-key retry is serialized
            // and finds the winner instead of racing to insert.
            await lockPurchaseOrder(tx, req.params.id, user.companyId);
            const replay = await replayReturn(tx, user.companyId, idempotencyKey, fingerprint, req.params.id);
            if (replay) return { row: replay, replayed: true };

            const order = await tx.purchaseOrder.findFirst({
              where: { id: req.params.id, companyId: user.companyId },
              include: { lines: { orderBy: { createdAt: 'asc' } } },
            });
            if (!order) fail(404, 'PURCHASE_ORDER_NOT_FOUND', 'أمر الشراء غير موجود');
            if (order.status === 'draft' || order.status === 'cancelled') {
              fail(409, 'RETURN_ORDER_STATE_INVALID', 'لا يمكن تسجيل إرجاع لأمر الشراء في حالته الحالية');
            }

            const progress = await loadOrderProgress(tx, user.companyId, order.lines as any, order.id);
            const positionByLine = new Map(progress.lines.map((line) => [line.purchaseOrderLineId, line]));

            const creates: Array<{ purchaseOrderLineId: string; quantity: Prisma.Decimal; note: string | null }> = [];
            for (const line of body.lines) {
              const position = positionByLine.get(line.purchaseOrderLineId);
              if (!position) {
                fail(400, 'INVALID_ORDER_LINE', 'أحد البنود لا يتبع أمر الشراء');
              }
              const requested = quantityToMilli(line.quantity);
              if (requested <= 0n) {
                fail(400, 'INVALID_QUANTITY', 'يجب أن تكون الكمية أكبر من صفر');
              }
              // Nothing was ever received against this line at all.
              if (position!.receivedMilli <= 0n) {
                fail(409, 'RETURN_WITHOUT_RECEIPT', 'لا يمكن إرجاع كمية لم يتم استلامها');
              }
              // Pending returns already hold quantity, so this bound is exact:
              // it also covers "everything received has already been returned".
              if (requested > position!.netReceivedMilli) {
                fail(409, 'RETURN_EXCEEDS_RECEIVED', 'الكمية المرتجعة تتجاوز الكمية المستلمة');
              }
              creates.push({
                purchaseOrderLineId: line.purchaseOrderLineId,
                quantity: new Prisma.Decimal(milliToQuantity(requested)),
                note: line.note ?? null,
              });
            }

            const row = await tx.purchaseReturn.create({
              data: {
                companyId: user.companyId,
                purchaseOrderId: order.id,
                returnNumber: generateDocumentNumber('PRT'),
                status: 'pending_approval',
                reasonCode: body.reasonCode,
                note: body.note ?? null,
                createdByUserId: user.id,
                idempotencyKey,
                payloadFingerprint: fingerprint,
                // companyId is supplied by the parent composite relation.
                lines: { create: creates },
              },
              include: returnInclude,
            });

            await tx.purchaseWorkflowEvent.create({
              data: {
                companyId: user.companyId,
                entityType: 'purchase_return',
                entityId: row.id,
                action: 'return_create',
                previousStatus: 'none',
                newStatus: 'pending_approval',
                reason: body.reasonCode,
                actorUserId: user.id,
                idempotencyKey: null,
              },
            });

            await writeAuditRequired(tx, {
              companyId: user.companyId,
              userId: user.id,
              action: 'purchasing.return.create',
              details: {
                returnId: row.id,
                orderId: order.id,
                requestId: order.purchaseRequestId,
                lineCount: creates.length,
                reasonCode: body.reasonCode,
                status: 'pending_approval',
              },
            });

            return { row, replayed: false };
          }),
        ));

        return res.status(outcome.replayed ? 200 : 201).json(purchaseReturnShape(outcome.row));
      } catch (error) {
        return sendW2Error(res, error);
      }
    },
  );

  app.post(
    '/api/v2/purchasing/returns/:id/review',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PURCHASING_RETURN_APPROVE),
    async (req: PurchasingW2Request, res) => {
      try {
        const user = req.user!;
        const body = parseBody(returnReviewSchema, req.body);
        const idempotencyKey = requireIdempotencyKey(req);

        const existing = await prisma.purchaseReturn.findFirst({
          where: { id: req.params.id, companyId: user.companyId },
          select: { id: true, purchaseOrderId: true },
        });
        if (!existing) fail(404, 'PURCHASE_RETURN_NOT_FOUND', 'طلب الإرجاع غير موجود');
        await loadVisibleOrder(prisma, user, existing.purchaseOrderId);

        // Bind the key to the full logical review: return id, action and note.
        // Same key + `approve` then same key + `reject` is a different payload
        // and must conflict, never replay the approved row as a success.
        const fingerprint = payloadFingerprint({
          kind: 'return_review',
          returnId: existing.id,
          action: body.action,
          note: body.note?.trim() ?? null,
        });

        const replayReview = async (client: any) => {
          const prior = await client.purchaseWorkflowEvent.findFirst({
            where: { companyId: user.companyId, idempotencyKey },
          });
          if (!prior) return null;
          if (
            prior.entityType !== 'purchase_return' ||
            prior.entityId !== existing.id ||
            (prior.payloadFingerprint != null && prior.payloadFingerprint !== fingerprint)
          ) {
            fail(409, 'IDEMPOTENCY_CONFLICT', 'تم استخدام مفتاح منع التكرار لعملية مختلفة');
          }
          return client.purchaseReturn.findFirst({
            where: { id: existing.id, companyId: user.companyId },
            include: returnInclude,
          });
        };

        const reviewed = await withIdempotencyReplay(
          () => replayReview(prisma),
          (row) => row,
          () => prisma.$transaction(async (tx) => {
          // Lock first, then replay, so a concurrent same-key review is
          // serialized and replays instead of seeing an already-reviewed status.
          await lockPurchaseOrder(tx, existing.purchaseOrderId, user.companyId);
          const replay = await replayReview(tx);
          if (replay) return replay;

          const row = await tx.purchaseReturn.findFirst({
            where: { id: existing.id, companyId: user.companyId },
          });
          if (!row) fail(404, 'PURCHASE_RETURN_NOT_FOUND', 'طلب الإرجاع غير موجود');
          if (row.status !== 'pending_approval') {
            fail(409, 'RETURN_REVIEW_INVALID', 'تمت مراجعة طلب الإرجاع بالفعل');
          }
          // Segregation of duties: the raiser of a return never approves it.
          if (row.createdByUserId === user.id) {
            fail(403, 'SELF_REVIEW_BLOCKED', 'لا يمكنك مراجعة طلب إرجاع أنشأته بنفسك');
          }

          const nextStatus = body.action === 'approve' ? 'approved' : 'rejected';
          const updated = await tx.purchaseReturn.update({
            where: { id: row.id },
            data: {
              status: nextStatus,
              reviewedByUserId: user.id,
              reviewedAt: new Date(),
              reviewNote: body.note ?? null,
            },
            include: returnInclude,
          });

          await tx.purchaseWorkflowEvent.create({
            data: {
              companyId: user.companyId,
              entityType: 'purchase_return',
              entityId: row.id,
              action: `return_${body.action}`,
              previousStatus: 'pending_approval',
              newStatus: nextStatus,
              reason: row.reasonCode,
              actorUserId: user.id,
              idempotencyKey,
              payloadFingerprint: fingerprint,
            },
          });

          await writeAuditRequired(tx, {
            companyId: user.companyId,
            userId: user.id,
            action: `purchasing.return.${body.action}`,
            details: {
              returnId: row.id,
              orderId: row.purchaseOrderId,
              action: body.action,
              previousStatus: 'pending_approval',
              newStatus: nextStatus,
              reasonCode: row.reasonCode,
            },
          });

          return updated;
        }));

        return res.json(purchaseReturnShape(reviewed));
      } catch (error) {
        return sendW2Error(res, error);
      }
    },
  );
}

export const __testing = {
  RECEIVABLE_ORDER_STATUSES,
  HOLDING_RETURN_STATUSES,
};
