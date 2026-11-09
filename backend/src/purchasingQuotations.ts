/**
 * Commercial Wave 2 — Supplier quotations and quotation comparison.
 * Operations Slice E1.
 *
 * Lifecycle: `draft` → `submitted` → (`selected` | `rejected`).
 *  - `draft` and `submitted` quotations are editable; every material edit bumps
 *    `version` and records a workflow event.
 *  - `selected` and `rejected` quotations are immutable historical facts and are
 *    always kept so the comparison history survives the award.
 *  - Exactly one `selected` quotation may exist per purchase request. That is
 *    enforced by a partial unique index in the database as well as by taking the
 *    `PurchaseRequest` row lock, so a concurrent double-award cannot succeed.
 *
 * Selection is an authorized human decision. This module deliberately performs
 * no supplier scoring and never designates a "best" supplier.
 */

import type { Express, RequestHandler } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { PERMISSIONS } from './permissions';
import { assertVisibleRequest } from './purchasing';
import {
  assertMoneyWithinRange,
  centsToPurchasingMoney,
  lineTotalCents,
  milliToQuantity,
  purchasingMoneyToCents,
  quantityToMilli,
  readMoney,
  readQuantity,
  storedMoneyToCents,
} from './purchasingMath';
import {
  dateOnly,
  dateOnlyText,
  fail,
  generateDocumentNumber,
  has,
  isIdempotencyKeyConflict,
  lockPurchaseRequest,
  optionalText,
  parseBody,
  parseDateOnly,
  payloadFingerprint,
  PurchasingW2Error,
  requireIdempotencyKey,
  retryDocumentNumberCollision,
  sendW2Error,
  timestamp,
  type PurchasingW2Request,
  type PurchasingW2User,
} from './purchasingW2Core';

interface QuotationRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
}

/** Quotations may only be captured while sourcing is still open. */
const QUOTABLE_REQUEST_STATUSES = ['pending_department', 'pending_purchasing', 'approved'] as const;
const EDITABLE_QUOTATION_STATUSES = ['draft', 'submitted'] as const;

const WORKFLOW_ENTITY = 'supplier_quotation';

const quantityText = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/, 'الكمية غير صالحة');
const moneyText = z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/, 'المبلغ غير صالح');
const leadTimeDays = z.number().int().min(0).max(3650).nullable().optional();

const quotationLineSchema = z
  .object({
    requestLineId: z.string().uuid().nullable().optional(),
    description: z.string().trim().min(1).max(500),
    category: optionalText(120),
    quantity: quantityText,
    unit: z.string().trim().min(1).max(40),
    unitPrice: moneyText,
    leadTimeDays,
    notes: optionalText(500),
  })
  .strict();

const quotationBodySchema = z
  .object({
    vendorId: z.string().uuid(),
    supplierReference: optionalText(120),
    currency: z.literal('SAR').default('SAR'),
    quotationDate: dateOnlyText.nullable().optional(),
    validUntilDate: dateOnlyText.nullable().optional(),
    expectedDeliveryDate: dateOnlyText.nullable().optional(),
    leadTimeDays,
    paymentTerms: optionalText(300),
    notes: optionalText(2000),
    lines: z.array(quotationLineSchema).min(1).max(50),
  })
  .strict();

/** A quotation update keeps its vendor; changing the supplier means a new quotation. */
const quotationUpdateSchema = quotationBodySchema.omit({ vendorId: true });

const selectSchema = z
  .object({
    confirm: z.literal(true),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const rejectSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const listQuerySchema = z
  .object({
    status: z.enum(['draft', 'submitted', 'selected', 'rejected']).optional(),
  })
  .strict();

const requestVisibilityInclude = {
  lines: { orderBy: { createdAt: 'asc' as const } },
  requester: {
    select: {
      id: true,
      employeeNum: true,
      user: { select: { id: true, name: true, role: { select: { permissions: true } } } },
    },
  },
} as const;

const quotationInclude = {
  lines: { orderBy: { createdAt: 'asc' as const } },
  vendor: { select: { id: true, name: true, status: true } },
  createdBy: { select: { id: true, name: true } },
  selectedBy: { select: { id: true, name: true } },
  rejectedBy: { select: { id: true, name: true } },
} as const;

export const quotationShape = (row: any) => ({
  id: row.id,
  companyId: row.companyId,
  quotationNumber: row.quotationNumber,
  purchaseRequestId: row.purchaseRequestId,
  vendorId: row.vendorId,
  vendorNameSnapshot: row.vendorNameSnapshot,
  vendorStatus: row.vendor?.status ?? null,
  supplierReference: row.supplierReference ?? null,
  status: row.status,
  version: row.version,
  currency: row.currency,
  subtotal: readMoney(row.subtotal),
  totalAmount: readMoney(row.totalAmount),
  quotationDate: dateOnly(row.quotationDate),
  validUntilDate: dateOnly(row.validUntilDate),
  expectedDeliveryDate: dateOnly(row.expectedDeliveryDate),
  leadTimeDays: row.leadTimeDays ?? null,
  paymentTerms: row.paymentTerms ?? null,
  notes: row.notes ?? null,
  lines: (row.lines ?? []).map((line: any) => ({
    id: line.id,
    requestLineId: line.requestLineId ?? null,
    descriptionSnapshot: line.descriptionSnapshot,
    categorySnapshot: line.categorySnapshot ?? null,
    quantity: readQuantity(line.quantity),
    unitSnapshot: line.unitSnapshot,
    unitPrice: readMoney(line.unitPrice),
    lineTotal: readMoney(line.lineTotal),
    leadTimeDays: line.leadTimeDays ?? null,
    notes: line.notes ?? null,
  })),
  createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
  submittedAt: timestamp(row.submittedAt),
  selection: row.selectedAt
    ? {
        actor: row.selectedBy ? { id: row.selectedBy.id, name: row.selectedBy.name } : null,
        selectedAt: timestamp(row.selectedAt),
        reason: row.selectionReason ?? null,
      }
    : null,
  rejection: row.rejectedAt
    ? {
        actor: row.rejectedBy ? { id: row.rejectedBy.id, name: row.rejectedBy.name } : null,
        rejectedAt: timestamp(row.rejectedAt),
        reason: row.rejectionReason ?? null,
      }
    : null,
  createdAt: timestamp(row.createdAt),
  updatedAt: timestamp(row.updatedAt),
});

/** Exact totals for a quotation body. Never touches IEEE floating point. */
export function calculateQuotationLines(lines: z.infer<typeof quotationLineSchema>[]) {
  let totalCents = 0n;
  const calculated = lines.map((line) => {
    const quantityMilli = quantityToMilli(line.quantity);
    if (quantityMilli <= 0n) {
      fail(400, 'INVALID_QUANTITY', 'يجب أن تكون الكمية أكبر من صفر');
    }
    const priceCents = purchasingMoneyToCents(line.unitPrice);
    const cents = lineTotalCents(quantityMilli, priceCents);
    assertMoneyWithinRange(cents);
    totalCents += cents;
    return {
      ...line,
      quantityValue: milliToQuantity(quantityMilli),
      priceValue: centsToPurchasingMoney(priceCents),
      lineTotal: centsToPurchasingMoney(cents),
    };
  });
  assertMoneyWithinRange(totalCents);
  return { lines: calculated, total: centsToPurchasingMoney(totalCents) };
}

const assertVendorUsable = async (tx: any, companyId: string, vendorId: string) => {
  const vendor = await tx.vendor.findFirst({ where: { id: vendorId, companyId } });
  if (!vendor) fail(404, 'VENDOR_NOT_FOUND', 'المورد غير موجود');
  if (vendor.status !== 'active') {
    fail(409, 'VENDOR_INACTIVE', 'المورد غير نشط ولا يمكن تسجيل عرض سعر له');
  }
  return vendor;
};

const assertRequestLinesBelong = (
  lines: Array<{ requestLineId?: string | null }>,
  requestLineIds: Set<string>,
) => {
  if (lines.some((line) => line.requestLineId && !requestLineIds.has(line.requestLineId))) {
    fail(400, 'INVALID_REQUEST_LINE', 'أحد بنود عرض السعر لا يتبع طلب الشراء');
  }
};

const loadVisibleRequest = async (prisma: any, user: PurchasingW2User, requestId: string) => {
  const request = await prisma.purchaseRequest.findFirst({
    where: { id: requestId, companyId: user.companyId },
    include: requestVisibilityInclude,
  });
  // Opaque 404 for a cross-company id: the existing purchasing convention.
  if (!request) fail(404, 'PURCHASE_REQUEST_NOT_FOUND', 'طلب الشراء غير موجود');
  await assertVisibleRequest(prisma, user as any, request);
  return request;
};

const loadVisibleQuotation = async (prisma: any, user: PurchasingW2User, quotationId: string) => {
  const quotation = await prisma.supplierQuotation.findFirst({
    where: { id: quotationId, companyId: user.companyId },
    include: quotationInclude,
  });
  if (!quotation) fail(404, 'SUPPLIER_QUOTATION_NOT_FOUND', 'عرض السعر غير موجود');
  await loadVisibleRequest(prisma, user, quotation.purchaseRequestId);
  return quotation;
};

const recordWorkflowEvent = async (
  tx: any,
  input: {
    companyId: string;
    quotationId: string;
    action: string;
    previousStatus: string;
    newStatus: string;
    reason: string;
    actorUserId: string;
    idempotencyKey?: string | null;
    payloadFingerprint?: string | null;
  },
) => {
  await tx.purchaseWorkflowEvent.create({
    data: {
      companyId: input.companyId,
      entityType: WORKFLOW_ENTITY,
      entityId: input.quotationId,
      action: input.action,
      previousStatus: input.previousStatus,
      newStatus: input.newStatus,
      reason: input.reason,
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey ?? null,
      payloadFingerprint: input.payloadFingerprint ?? null,
    },
  });
};

/**
 * Replays a prior mutation that used the same company-scoped idempotency key.
 *
 * The lookup happens before any write so it never runs inside an aborted
 * transaction (the W1A lesson). The key is bound to the full logical request:
 * a prior event whose entity/action/id/fingerprint does not match the current
 * request is a `409 IDEMPOTENCY_CONFLICT`, so a same-key retry with a changed
 * payload is never told it succeeded.
 */
async function replayByIdempotencyKey(
  tx: any,
  companyId: string,
  idempotencyKey: string,
  expected: { action: string; entityId?: string; fingerprint: string },
): Promise<any | null> {
  const prior = await tx.purchaseWorkflowEvent.findFirst({
    where: { companyId, idempotencyKey },
  });
  if (!prior) return null;
  if (
    prior.entityType !== WORKFLOW_ENTITY ||
    prior.action !== expected.action ||
    (expected.entityId && prior.entityId !== expected.entityId) ||
    // A stored fingerprint that differs proves a different logical payload.
    // A null stored fingerprint (legacy/pre-W2 event) cannot prove a conflict.
    (prior.payloadFingerprint != null && prior.payloadFingerprint !== expected.fingerprint)
  ) {
    fail(409, 'IDEMPOTENCY_CONFLICT', 'تم استخدام مفتاح منع التكرار لعملية مختلفة');
  }
  return tx.supplierQuotation.findFirst({
    where: { id: prior.entityId, companyId },
    include: quotationInclude,
  });
}

/**
 * Runs a write protected by a company-scoped idempotency key.
 *
 * A concurrent request with the same key aborts this transaction through the
 * unique index; the winner is then re-read in a *fresh* transaction (never the
 * aborted one) and returned as a replay, so an exact concurrent retry gets the
 * stored result. A different payload on the same key still fails with 409.
 */
async function withIdempotencyReplay<T>(
  replay: () => Promise<T | null>,
  create: () => Promise<T>,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (!isIdempotencyKeyConflict(error)) throw error;
    const winner = await replay();
    if (!winner) throw error;
    return winner;
  }
}

/**
 * Quotation comparison contract.
 *
 * Reports only facts that the request and quotation records actually captured:
 * supplier, reference, per-line quantity/price/total, quotation total, currency,
 * lead/delivery dates, validity, terms/notes and the selected flag. It does not
 * score suppliers and does not nominate a winner.
 */
export function buildQuotationComparison(request: any, quotations: any[]) {
  const requestLines = (request.lines ?? []).map((line: any) => ({
    id: line.id,
    description: line.description,
    category: line.category ?? null,
    quantity: readQuantity(line.quantity),
    unit: line.unit,
    estimatedUnitPrice: readMoney(line.estimatedUnitPrice),
    estimatedTotal: readMoney(line.estimatedTotal),
  }));
  const requestLineIds = requestLines.map((line: any) => line.id);
  const today = new Date().toISOString().slice(0, 10);

  const shaped = quotations.map((quotation: any) => {
    const base = quotationShape(quotation);
    const quotedRequestLineIds = new Set(
      base.lines.map((line) => line.requestLineId).filter((id): id is string => Boolean(id)),
    );
    const validUntil = base.validUntilDate;
    return {
      ...base,
      isSelected: base.status === 'selected',
      validityExpired: validUntil == null ? null : validUntil < today,
      coverage: {
        requestLineCount: requestLineIds.length,
        quotedRequestLineCount: quotedRequestLineIds.size,
        unquotedRequestLineIds: requestLineIds.filter((id: string) => !quotedRequestLineIds.has(id)),
      },
    };
  });

  const matrix = requestLines.map((requestLine: any) => ({
    requestLineId: requestLine.id,
    description: requestLine.description,
    requestedQuantity: requestLine.quantity,
    unit: requestLine.unit,
    estimatedUnitPrice: requestLine.estimatedUnitPrice,
    cells: shaped.map((quotation) => {
      const match = quotation.lines.find((line) => line.requestLineId === requestLine.id) ?? null;
      return {
        quotationId: quotation.id,
        quotationNumber: quotation.quotationNumber,
        vendorId: quotation.vendorId,
        vendorNameSnapshot: quotation.vendorNameSnapshot,
        quoted: Boolean(match),
        quantity: match?.quantity ?? null,
        unit: match?.unitSnapshot ?? null,
        unitPrice: match?.unitPrice ?? null,
        lineTotal: match?.lineTotal ?? null,
        leadTimeDays: match?.leadTimeDays ?? quotation.leadTimeDays ?? null,
        notes: match?.notes ?? null,
      };
    }),
  }));

  const comparableTotals = shaped
    .filter((quotation) => quotation.status !== 'rejected')
    .map((quotation) => storedMoneyToCents(quotation.totalAmount));
  const lowestCents = comparableTotals.length
    ? comparableTotals.reduce((low, value) => (value < low ? value : low))
    : null;
  const highestCents = comparableTotals.length
    ? comparableTotals.reduce((high, value) => (value > high ? value : high))
    : null;

  return {
    generatedAt: new Date().toISOString(),
    request: {
      id: request.id,
      requestNumber: request.requestNumber,
      title: request.title,
      status: request.status,
      currency: request.currency,
      totalEstimated: readMoney(request.totalEstimated),
    },
    requestLines,
    quotations: shaped,
    matrix,
    // Objective aggregates only — no ranking, scoring or recommended supplier.
    totals: {
      currency: 'SAR',
      comparableQuotationCount: comparableTotals.length,
      lowestTotalAmount: lowestCents == null ? null : centsToPurchasingMoney(lowestCents),
      highestTotalAmount: highestCents == null ? null : centsToPurchasingMoney(highestCents),
      spreadAmount:
        lowestCents == null || highestCents == null
          ? null
          : centsToPurchasingMoney(highestCents - lowestCents),
    },
    selectedQuotationId: shaped.find((quotation) => quotation.status === 'selected')?.id ?? null,
  };
}

/**
 * Canonical fingerprint of a quotation-create request. Money and quantity use
 * the already-normalized exact strings from `calculateQuotationLines`, so two
 * semantically equal exact values (e.g. "10" and "10.000") never diverge and no
 * IEEE float ever enters the hash input.
 */
export const quotationCreateFingerprint = (
  requestId: string,
  body: z.infer<typeof quotationBodySchema>,
  calculated: ReturnType<typeof calculateQuotationLines>,
): string =>
  payloadFingerprint({
    kind: 'quotation_create',
    requestId,
    vendorId: body.vendorId,
    supplierReference: body.supplierReference ?? null,
    currency: 'SAR',
    quotationDate: body.quotationDate ?? null,
    validUntilDate: body.validUntilDate ?? null,
    expectedDeliveryDate: body.expectedDeliveryDate ?? null,
    leadTimeDays: body.leadTimeDays ?? null,
    paymentTerms: body.paymentTerms ?? null,
    notes: body.notes ?? null,
    lines: calculated.lines.map((line) => ({
      requestLineId: line.requestLineId ?? null,
      description: line.description,
      category: line.category ?? null,
      quantity: line.quantityValue,
      unit: line.unit,
      unitPrice: line.priceValue,
      leadTimeDays: line.leadTimeDays ?? null,
      notes: line.notes ?? null,
    })),
  });

/** Canonical fingerprint of a quotation-award request. */
export const quotationSelectFingerprint = (
  quotationId: string,
  purchaseRequestId: string,
  reason: string,
): string =>
  payloadFingerprint({
    kind: 'quotation_select',
    quotationId,
    purchaseRequestId,
    confirm: true,
    reason: reason.trim(),
  });

export function registerPurchasingQuotationRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
}: QuotationRouteDeps): void {
  const manage = checkAnyPermission(PERMISSIONS.PURCHASING_QUOTATION_MANAGE);
  const view = checkAnyPermission(
    PERMISSIONS.PURCHASING_QUOTATION_MANAGE,
    PERMISSIONS.PURCHASING_QUOTATION_COMPARE,
  );
  const compare = checkAnyPermission(PERMISSIONS.PURCHASING_QUOTATION_COMPARE);

  app.get(
    '/api/v2/purchasing/requests/:requestId/quotations',
    requireAuth,
    view,
    async (req: PurchasingW2Request, res) => {
      try {
        const user = req.user!;
        const query = parseBody(listQuerySchema, req.query);
        await loadVisibleRequest(prisma, user, req.params.requestId);
        const rows = await prisma.supplierQuotation.findMany({
          where: {
            companyId: user.companyId,
            purchaseRequestId: req.params.requestId,
            ...(query.status ? { status: query.status } : {}),
          },
          include: quotationInclude,
          orderBy: { createdAt: 'asc' },
          take: 200,
        });
        return res.json({ items: rows.map(quotationShape), total: rows.length });
      } catch (error) {
        return sendW2Error(res, error);
      }
    },
  );

  app.get(
    '/api/v2/purchasing/requests/:requestId/quotations/compare',
    requireAuth,
    compare,
    async (req: PurchasingW2Request, res) => {
      try {
        const user = req.user!;
        const request = await loadVisibleRequest(prisma, user, req.params.requestId);
        const quotations = await prisma.supplierQuotation.findMany({
          where: { companyId: user.companyId, purchaseRequestId: request.id },
          include: quotationInclude,
          orderBy: { createdAt: 'asc' },
          take: 200,
        });
        const payload = buildQuotationComparison(request, quotations);
        await writeAuditRequired(prisma, {
          companyId: user.companyId,
          userId: user.id,
          action: 'purchasing.quotation.compare',
          details: {
            requestId: request.id,
            quotationCount: quotations.length,
          },
        });
        return res.json(payload);
      } catch (error) {
        return sendW2Error(res, error);
      }
    },
  );

  app.post(
    '/api/v2/purchasing/requests/:requestId/quotations',
    requireAuth,
    manage,
    async (req: PurchasingW2Request, res) => {
      try {
        const user = req.user!;
        const body = parseBody(quotationBodySchema, req.body);
        const idempotencyKey = requireIdempotencyKey(req);
        await loadVisibleRequest(prisma, user, req.params.requestId);
        const calculated = calculateQuotationLines(body.lines);
        const fingerprint = quotationCreateFingerprint(req.params.requestId, body, calculated);

        const created = await withIdempotencyReplay(
          async () => {
            const winner = await replayByIdempotencyKey(prisma, user.companyId, idempotencyKey, {
              action: 'quotation_create',
              fingerprint,
            });
            return winner ? { row: winner, replayed: true } : null;
          },
          () => retryDocumentNumberCollision('quotationNumber', () =>
          prisma.$transaction(async (tx) => {
            const replay = await replayByIdempotencyKey(tx, user.companyId, idempotencyKey, {
              action: 'quotation_create',
              fingerprint,
            });
            if (replay) return { row: replay, replayed: true };

            await lockPurchaseRequest(tx, req.params.requestId, user.companyId);
            const request = await tx.purchaseRequest.findFirst({
              where: { id: req.params.requestId, companyId: user.companyId },
              include: { lines: { select: { id: true } } },
            });
            if (!request) fail(404, 'PURCHASE_REQUEST_NOT_FOUND', 'طلب الشراء غير موجود');
            if (!(QUOTABLE_REQUEST_STATUSES as readonly string[]).includes(request.status)) {
              fail(409, 'QUOTATION_REQUEST_STATE_INVALID', 'لا يمكن تسجيل عروض أسعار لهذا الطلب في حالته الحالية');
            }
            const vendor = await assertVendorUsable(tx, user.companyId, body.vendorId);
            assertRequestLinesBelong(body.lines, new Set(request.lines.map((line: any) => line.id)));

            const row = await tx.supplierQuotation.create({
              data: {
                companyId: user.companyId,
                quotationNumber: generateDocumentNumber('SQ'),
                purchaseRequestId: request.id,
                vendorId: vendor.id,
                vendorNameSnapshot: vendor.name,
                supplierReference: body.supplierReference ?? null,
                status: 'draft',
                version: 1,
                currency: 'SAR',
                subtotal: new Prisma.Decimal(calculated.total),
                totalAmount: new Prisma.Decimal(calculated.total),
                quotationDate: body.quotationDate ? parseDateOnly(body.quotationDate) : null,
                validUntilDate: body.validUntilDate ? parseDateOnly(body.validUntilDate) : null,
                expectedDeliveryDate: body.expectedDeliveryDate
                  ? parseDateOnly(body.expectedDeliveryDate)
                  : null,
                leadTimeDays: body.leadTimeDays ?? null,
                paymentTerms: body.paymentTerms ?? null,
                notes: body.notes ?? null,
                createdByUserId: user.id,
                lines: {
                  // companyId is supplied by the parent composite relation.
                  create: calculated.lines.map((line) => ({
                    requestLineId: line.requestLineId ?? null,
                    descriptionSnapshot: line.description,
                    categorySnapshot: line.category ?? null,
                    quantity: new Prisma.Decimal(line.quantityValue),
                    unitSnapshot: line.unit,
                    unitPrice: new Prisma.Decimal(line.priceValue),
                    lineTotal: new Prisma.Decimal(line.lineTotal),
                    leadTimeDays: line.leadTimeDays ?? null,
                    notes: line.notes ?? null,
                  })),
                },
              },
              include: quotationInclude,
            });

            await recordWorkflowEvent(tx, {
              companyId: user.companyId,
              quotationId: row.id,
              action: 'quotation_create',
              previousStatus: 'none',
              newStatus: 'draft',
              reason: 'quotation_captured',
              actorUserId: user.id,
              idempotencyKey,
              payloadFingerprint: fingerprint,
            });
            await writeAuditRequired(tx, {
              companyId: user.companyId,
              userId: user.id,
              action: 'purchasing.quotation.create',
              details: {
                quotationId: row.id,
                requestId: request.id,
                vendorId: vendor.id,
                lineCount: calculated.lines.length,
                status: 'draft',
                amountCents: storedMoneyToCents(calculated.total).toString(),
              },
            });
            return { row, replayed: false };
          }),
        ));

        return res.status(created.replayed ? 200 : 201).json(quotationShape(created.row));
      } catch (error) {
        return sendW2Error(res, error);
      }
    },
  );

  app.get(
    '/api/v2/purchasing/quotations/:id',
    requireAuth,
    view,
    async (req: PurchasingW2Request, res) => {
      try {
        const quotation = await loadVisibleQuotation(prisma, req.user!, req.params.id);
        return res.json(quotationShape(quotation));
      } catch (error) {
        return sendW2Error(res, error);
      }
    },
  );

  app.patch(
    '/api/v2/purchasing/quotations/:id',
    requireAuth,
    manage,
    async (req: PurchasingW2Request, res) => {
      try {
        const user = req.user!;
        const body = parseBody(quotationUpdateSchema, req.body);
        await loadVisibleQuotation(prisma, user, req.params.id);
        const calculated = calculateQuotationLines(body.lines);

        const updated = await prisma.$transaction(async (tx) => {
          const existing = await tx.supplierQuotation.findFirst({
            where: { id: req.params.id, companyId: user.companyId },
            include: { lines: true, purchaseRequest: { include: { lines: { select: { id: true } } } } },
          });
          if (!existing) fail(404, 'SUPPLIER_QUOTATION_NOT_FOUND', 'عرض السعر غير موجود');
          await lockPurchaseRequest(tx, existing.purchaseRequestId, user.companyId);
          if (!(EDITABLE_QUOTATION_STATUSES as readonly string[]).includes(existing.status)) {
            fail(409, 'QUOTATION_IMMUTABLE', 'لا يمكن تعديل عرض السعر بعد اعتماده أو رفضه');
          }
          assertRequestLinesBelong(
            body.lines,
            new Set(existing.purchaseRequest.lines.map((line: any) => line.id)),
          );

          // Replace-by-recreate keeps line identity simple; the previous content
          // stays reachable through the version counter and workflow events.
          await tx.supplierQuotationLine.deleteMany({
            where: { companyId: user.companyId, supplierQuotationId: existing.id },
          });
          const row = await tx.supplierQuotation.update({
            where: { id: existing.id },
            data: {
              supplierReference: body.supplierReference ?? null,
              subtotal: new Prisma.Decimal(calculated.total),
              totalAmount: new Prisma.Decimal(calculated.total),
              quotationDate: body.quotationDate ? parseDateOnly(body.quotationDate) : null,
              validUntilDate: body.validUntilDate ? parseDateOnly(body.validUntilDate) : null,
              expectedDeliveryDate: body.expectedDeliveryDate
                ? parseDateOnly(body.expectedDeliveryDate)
                : null,
              leadTimeDays: body.leadTimeDays ?? null,
              paymentTerms: body.paymentTerms ?? null,
              notes: body.notes ?? null,
              version: { increment: 1 },
              lines: {
                // companyId is supplied by the parent composite relation.
                create: calculated.lines.map((line) => ({
                  requestLineId: line.requestLineId ?? null,
                  descriptionSnapshot: line.description,
                  categorySnapshot: line.category ?? null,
                  quantity: new Prisma.Decimal(line.quantityValue),
                  unitSnapshot: line.unit,
                  unitPrice: new Prisma.Decimal(line.priceValue),
                  lineTotal: new Prisma.Decimal(line.lineTotal),
                  leadTimeDays: line.leadTimeDays ?? null,
                  notes: line.notes ?? null,
                })),
              },
            },
            include: quotationInclude,
          });
          await recordWorkflowEvent(tx, {
            companyId: user.companyId,
            quotationId: row.id,
            action: 'quotation_update',
            previousStatus: existing.status,
            newStatus: row.status,
            reason: 'quotation_updated',
            actorUserId: user.id,
          });
          await writeAuditRequired(tx, {
            companyId: user.companyId,
            userId: user.id,
            action: 'purchasing.quotation.update',
            details: {
              quotationId: row.id,
              requestId: row.purchaseRequestId,
              lineCount: calculated.lines.length,
              version: row.version,
              status: row.status,
              amountCents: storedMoneyToCents(calculated.total).toString(),
            },
          });
          return row;
        });

        return res.json(quotationShape(updated));
      } catch (error) {
        return sendW2Error(res, error);
      }
    },
  );

  app.post(
    '/api/v2/purchasing/quotations/:id/submit',
    requireAuth,
    manage,
    async (req: PurchasingW2Request, res) => {
      try {
        const user = req.user!;
        await loadVisibleQuotation(prisma, user, req.params.id);
        const updated = await prisma.$transaction(async (tx) => {
          const existing = await tx.supplierQuotation.findFirst({
            where: { id: req.params.id, companyId: user.companyId },
          });
          if (!existing) fail(404, 'SUPPLIER_QUOTATION_NOT_FOUND', 'عرض السعر غير موجود');
          await lockPurchaseRequest(tx, existing.purchaseRequestId, user.companyId);
          if (existing.status === 'submitted') {
            return tx.supplierQuotation.findFirst({
              where: { id: existing.id, companyId: user.companyId },
              include: quotationInclude,
            });
          }
          if (existing.status !== 'draft') {
            fail(409, 'QUOTATION_SUBMIT_INVALID', 'لا يمكن ترحيل عرض السعر في حالته الحالية');
          }
          const row = await tx.supplierQuotation.update({
            where: { id: existing.id },
            data: { status: 'submitted', submittedAt: new Date() },
            include: quotationInclude,
          });
          await recordWorkflowEvent(tx, {
            companyId: user.companyId,
            quotationId: row.id,
            action: 'quotation_submit',
            previousStatus: 'draft',
            newStatus: 'submitted',
            reason: 'quotation_submitted',
            actorUserId: user.id,
          });
          await writeAuditRequired(tx, {
            companyId: user.companyId,
            userId: user.id,
            action: 'purchasing.quotation.submit',
            details: { quotationId: row.id, requestId: row.purchaseRequestId, status: 'submitted' },
          });
          return row;
        });
        return res.json(quotationShape(updated));
      } catch (error) {
        return sendW2Error(res, error);
      }
    },
  );

  app.post(
    '/api/v2/purchasing/quotations/:id/reject',
    requireAuth,
    manage,
    async (req: PurchasingW2Request, res) => {
      try {
        const user = req.user!;
        const body = parseBody(rejectSchema, req.body);
        await loadVisibleQuotation(prisma, user, req.params.id);
        const updated = await prisma.$transaction(async (tx) => {
          const existing = await tx.supplierQuotation.findFirst({
            where: { id: req.params.id, companyId: user.companyId },
          });
          if (!existing) fail(404, 'SUPPLIER_QUOTATION_NOT_FOUND', 'عرض السعر غير موجود');
          await lockPurchaseRequest(tx, existing.purchaseRequestId, user.companyId);
          if (!(EDITABLE_QUOTATION_STATUSES as readonly string[]).includes(existing.status)) {
            fail(409, 'QUOTATION_REJECT_INVALID', 'لا يمكن رفض عرض السعر في حالته الحالية');
          }
          const row = await tx.supplierQuotation.update({
            where: { id: existing.id },
            data: {
              status: 'rejected',
              rejectedByUserId: user.id,
              rejectedAt: new Date(),
              rejectionReason: body.reason,
            },
            include: quotationInclude,
          });
          await recordWorkflowEvent(tx, {
            companyId: user.companyId,
            quotationId: row.id,
            action: 'quotation_reject',
            previousStatus: existing.status,
            newStatus: 'rejected',
            reason: body.reason,
            actorUserId: user.id,
          });
          await writeAuditRequired(tx, {
            companyId: user.companyId,
            userId: user.id,
            action: 'purchasing.quotation.reject',
            details: {
              quotationId: row.id,
              requestId: row.purchaseRequestId,
              status: 'rejected',
              reasonProvided: true,
            },
          });
          return row;
        });
        return res.json(quotationShape(updated));
      } catch (error) {
        return sendW2Error(res, error);
      }
    },
  );

  app.post(
    '/api/v2/purchasing/quotations/:id/select',
    requireAuth,
    manage,
    async (req: PurchasingW2Request, res) => {
      try {
        const user = req.user!;
        const body = parseBody(selectSchema, req.body);
        const idempotencyKey = requireIdempotencyKey(req);
        const visible = await loadVisibleQuotation(prisma, user, req.params.id);
        const fingerprint = quotationSelectFingerprint(
          req.params.id,
          visible.purchaseRequestId,
          body.reason,
        );

        const selected = await withIdempotencyReplay(
          () => replayByIdempotencyKey(prisma, user.companyId, idempotencyKey, {
            action: 'quotation_select',
            entityId: req.params.id,
            fingerprint,
          }),
          () => prisma.$transaction(async (tx) => {
          // Take the request lock *before* the replay lookup so a concurrent
          // same-key award is serialized: the loser then finds the winner's
          // workflow event and replays it instead of seeing a stale status.
          await lockPurchaseRequest(tx, visible.purchaseRequestId, user.companyId);
          const replay = await replayByIdempotencyKey(tx, user.companyId, idempotencyKey, {
            action: 'quotation_select',
            entityId: req.params.id,
            fingerprint,
          });
          if (replay) return replay;

          const request = await tx.purchaseRequest.findFirst({
            where: { id: visible.purchaseRequestId, companyId: user.companyId },
            select: { id: true, status: true, requestedByEmployeeId: true },
          });
          if (!request) fail(404, 'PURCHASE_REQUEST_NOT_FOUND', 'طلب الشراء غير موجود');
          // Same segregation rule the existing purchasing review already enforces.
          if (request.requestedByEmployeeId === user.employeeId) {
            fail(403, 'SELF_SELECTION_BLOCKED', 'لا يمكنك اعتماد عرض سعر لطلبك الشخصي');
          }

          const existing = await tx.supplierQuotation.findFirst({
            where: { id: req.params.id, companyId: user.companyId },
          });
          if (!existing) fail(404, 'SUPPLIER_QUOTATION_NOT_FOUND', 'عرض السعر غير موجود');
          if (existing.status !== 'submitted') {
            fail(409, 'QUOTATION_SELECT_INVALID', 'يمكن اعتماد عروض الأسعار المرحّلة فقط');
          }

          const alreadySelected = await tx.supplierQuotation.findFirst({
            where: {
              companyId: user.companyId,
              purchaseRequestId: request.id,
              status: 'selected',
            },
            select: { id: true },
          });
          if (alreadySelected) {
            fail(409, 'QUOTATION_ALREADY_SELECTED', 'يوجد عرض سعر معتمد بالفعل لهذا الطلب');
          }

          const row = await tx.supplierQuotation.update({
            where: { id: existing.id },
            data: {
              status: 'selected',
              selectedByUserId: user.id,
              selectedAt: new Date(),
              selectionReason: body.reason,
            },
            include: quotationInclude,
          });
          await recordWorkflowEvent(tx, {
            companyId: user.companyId,
            quotationId: row.id,
            action: 'quotation_select',
            previousStatus: 'submitted',
            newStatus: 'selected',
            reason: body.reason,
            actorUserId: user.id,
            idempotencyKey,
            payloadFingerprint: fingerprint,
          });
          await writeAuditRequired(tx, {
            companyId: user.companyId,
            userId: user.id,
            action: 'purchasing.quotation.select',
            details: {
              quotationId: row.id,
              requestId: request.id,
              vendorId: row.vendorId,
              status: 'selected',
              confirmationProvided: true,
              reasonProvided: true,
              amountCents: storedMoneyToCents(row.totalAmount).toString(),
            },
          });
          return row;
        }));

        return res.json(quotationShape(selected));
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          String(error.meta?.target ?? '').includes('selected')
        ) {
          return sendW2Error(
            res,
            new PurchasingW2Error(
              409,
              'QUOTATION_ALREADY_SELECTED',
              'يوجد عرض سعر معتمد بالفعل لهذا الطلب',
            ),
          );
        }
        return sendW2Error(res, error);
      }
    },
  );
}

export const __testing = {
  QUOTABLE_REQUEST_STATUSES,
  EDITABLE_QUOTATION_STATUSES,
  payloadFingerprint,
  quotationCreateFingerprint,
  quotationSelectFingerprint,
  has,
};
