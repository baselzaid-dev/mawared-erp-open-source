/**
 * Commercial Wave 2 purchasing reports.
 *
 * These are the first consumers of the report registration contract published
 * in `reportRegistry.ts` — they add no new wiring to `reports.ts`. Every report
 * here is backed by data the schema actually captures; nothing is estimated,
 * scored or fabricated.
 *
 * Registration happens at module scope so it runs exactly once per process even
 * when a test suite builds many Express apps.
 */

import { z } from 'zod';
import { loadPrimaryOwnerUserId } from './authorization';
import { PERMISSIONS } from './permissions';
import { milliToQuantity, readMoney, storedQuantityToMilli, computeLinePosition } from './purchasingMath';
import {
  registerReport,
  REPORT_REGISTRY_CONTRACT_VERSION,
  type RegisteredReportContext,
  type RegisteredReportResult,
} from './reportRegistry';
import type { ReportUser } from './reports';

const isAdmin = (user: ReportUser): boolean => user.permissions.includes(PERMISSIONS.ADMIN_FULL);
const has = (user: ReportUser, permission: string): boolean =>
  isAdmin(user) || user.permissions.includes(permission);

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'يجب إدخال التاريخ بصيغة yyyy-MM-dd')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'التاريخ غير صالح');

const baseFields = {
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

class PurchasingReportError extends Error {
  constructor(readonly status: number, readonly errorCode: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PurchasingReportError(
      400,
      'REPORT_VALIDATION_ERROR',
      result.error.issues[0]?.message ?? 'معايير التقرير غير صالحة',
      result.error.flatten(),
    );
  }
  return result.data;
};

const utcToday = (): string => new Date().toISOString().slice(0, 10);

const normalizedRange = (from?: string, to?: string): { from: string; to: string } => {
  if (from && to) {
    if (from > to) {
      throw new PurchasingReportError(400, 'REPORT_VALIDATION_ERROR', 'تاريخ البداية يجب ألا يكون بعد تاريخ النهاية');
    }
    const days =
      Math.floor(
        (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
      ) + 1;
    if (days > 366) {
      throw new PurchasingReportError(400, 'REPORT_VALIDATION_ERROR', 'نطاق التاريخ يجب ألا يتجاوز 366 يوماً');
    }
    return { from, to };
  }
  if (from || to) {
    throw new PurchasingReportError(400, 'REPORT_VALIDATION_ERROR', 'يجب تحديد تاريخي البداية والنهاية معاً');
  }
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
};

const rangeWhere = (range: { from: string; to: string }) => ({
  gte: new Date(`${range.from}T00:00:00.000Z`),
  lte: new Date(`${range.to}T23:59:59.999Z`),
});

const paginate = (
  rows: Array<Record<string, unknown>>,
  page: number,
  pageSize: number,
): { rows: Array<Record<string, unknown>>; pagination: { page: number; pageSize: number; total: number } } => ({
  rows: rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize),
  pagination: { page, pageSize, total: rows.length },
});

const timestamp = (value: unknown): string | null =>
  value == null ? null : new Date(value as any).toISOString();
const dateOnly = (value: unknown): string | null =>
  value == null ? null : new Date(value as any).toISOString().slice(0, 10);

const parseRolePermissions = (value: string | null | undefined): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * Purchase requests raised by the company's Primary Owner (or another
 * `admin.full` holder) stay hidden from non-admin readers, exactly as the
 * existing purchasing report already does.
 */
const isOwnerRequest = (request: any, primaryOwnerUserId: string | null): boolean =>
  request?.requester?.user?.id === primaryOwnerUserId ||
  parseRolePermissions(request?.requester?.user?.role?.permissions).includes(PERMISSIONS.ADMIN_FULL);

const requesterSelect = {
  select: {
    id: true,
    user: { select: { id: true, role: { select: { permissions: true } } } },
  },
} as const;

const scopeCompany = { kind: 'company' as const, departmentId: null };

// ---------------------------------------------------------------------------
// purchasing_quotations — supplier quotation status and comparison facts
// ---------------------------------------------------------------------------

const quotationQuerySchema = z
  .strictObject({
    ...baseFields,
    status: z.enum(['draft', 'submitted', 'selected', 'rejected']).optional(),
    vendorId: z.string().uuid('معرّف المورد غير صالح').optional(),
    requestId: z.string().uuid('معرّف الطلب غير صالح').optional(),
  });

async function loadQuotationReport(context: RegisteredReportContext): Promise<RegisteredReportResult> {
  const query = parse(quotationQuerySchema, context.filters);
  const range = normalizedRange(query.from, query.to);
  const [rows, primaryOwnerUserId] = await Promise.all([
    context.prisma.supplierQuotation.findMany({
      where: {
        companyId: context.user.companyId,
        createdAt: rangeWhere(range),
        ...(query.status ? { status: query.status } : {}),
        ...(query.vendorId ? { vendorId: query.vendorId } : {}),
        ...(query.requestId ? { purchaseRequestId: query.requestId } : {}),
      },
      include: {
        lines: { select: { id: true } },
        purchaseRequest: { select: { id: true, requestNumber: true, title: true, requester: requesterSelect } },
      },
      orderBy: { createdAt: 'desc' },
      take: context.rowCap + 1,
    }),
    loadPrimaryOwnerUserId(context.prisma, context.user.companyId),
  ]);

  const visible = rows.filter(
    (row: any) => isAdmin(context.user) || !isOwnerRequest(row.purchaseRequest, primaryOwnerUserId),
  );
  const protectedRowCount = rows.length - visible.length;
  context.assertRowLimit(visible.length);

  const today = utcToday();
  const mapped = visible.map((row: any) => ({
    id: row.id,
    quotationNumber: row.quotationNumber,
    requestNumber: row.purchaseRequest?.requestNumber ?? null,
    requestId: row.purchaseRequestId,
    vendorNameSnapshot: row.vendorNameSnapshot,
    vendorId: row.vendorId,
    supplierReference: row.supplierReference ?? null,
    status: row.status,
    version: row.version,
    isSelected: row.status === 'selected',
    lineCount: row.lines.length,
    totalAmount: readMoney(row.totalAmount),
    currency: row.currency,
    quotationDate: dateOnly(row.quotationDate),
    validUntilDate: dateOnly(row.validUntilDate),
    validityExpired: row.validUntilDate ? dateOnly(row.validUntilDate)! < today : null,
    expectedDeliveryDate: dateOnly(row.expectedDeliveryDate),
    leadTimeDays: row.leadTimeDays ?? null,
    createdAt: timestamp(row.createdAt),
    selectedAt: timestamp(row.selectedAt),
  }));

  const page = paginate(
    mapped,
    context.exportMode ? 1 : query.page,
    context.exportMode ? context.rowCap : query.pageSize,
  );

  return {
    generatedAt: new Date().toISOString(),
    range,
    scope: scopeCompany,
    summary: {
      quotationCount: mapped.length,
      draftCount: mapped.filter((row) => row.status === 'draft').length,
      submittedCount: mapped.filter((row) => row.status === 'submitted').length,
      selectedCount: mapped.filter((row) => row.status === 'selected').length,
      rejectedCount: mapped.filter((row) => row.status === 'rejected').length,
      expiredValidityCount: mapped.filter((row) => row.validityExpired === true).length,
      currency: 'SAR',
    },
    rows: page.rows,
    pagination: page.pagination,
    warnings: protectedRowCount > 0 ? ['توجد صفوف محمية غير ظاهرة في التقرير.'] : [],
    ...(protectedRowCount > 0 ? { protectedRowsHidden: true, protectedRowCount } : {}),
  };
}

// ---------------------------------------------------------------------------
// purchasing_receipts — per-line receipt progress, backorders and overdue lines
// ---------------------------------------------------------------------------

const receiptQuerySchema = z.strictObject({
  ...baseFields,
  vendorId: z.string().uuid('معرّف المورد غير صالح').optional(),
  orderStatus: z.enum(['issued', 'partially_received', 'received', 'cancelled', 'draft']).optional(),
  outstandingOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .optional(),
});

async function loadReceiptProgressReport(
  context: RegisteredReportContext,
): Promise<RegisteredReportResult> {
  const query = parse(receiptQuerySchema, context.filters);
  const range = normalizedRange(query.from, query.to);

  const [orders, primaryOwnerUserId] = await Promise.all([
    context.prisma.purchaseOrder.findMany({
      where: {
        companyId: context.user.companyId,
        createdAt: rangeWhere(range),
        ...(query.vendorId ? { vendorId: query.vendorId } : {}),
        ...(query.orderStatus ? { status: query.orderStatus } : { status: { not: 'cancelled' } }),
      },
      include: {
        lines: { orderBy: { createdAt: 'asc' } },
        purchaseRequest: {
          select: { id: true, requestNumber: true, neededByDate: true, requester: requesterSelect },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: context.rowCap + 1,
    }),
    loadPrimaryOwnerUserId(context.prisma, context.user.companyId),
  ]);

  const visibleOrders = orders.filter(
    (order: any) => isAdmin(context.user) || !isOwnerRequest(order.purchaseRequest, primaryOwnerUserId),
  );
  const protectedRowCount = orders.length - visibleOrders.length;

  const lineIds = visibleOrders.flatMap((order: any) => order.lines.map((line: any) => line.id));
  const [receiptLines, returnLines] = lineIds.length
    ? await Promise.all([
        context.prisma.purchaseReceiptLine.findMany({
          where: { companyId: context.user.companyId, purchaseOrderLineId: { in: lineIds } },
          select: { purchaseOrderLineId: true, quantity: true, receipt: { select: { receivedAt: true } } },
        }),
        context.prisma.purchaseReturnLine.findMany({
          where: {
            companyId: context.user.companyId,
            purchaseOrderLineId: { in: lineIds },
            purchaseReturn: { status: { in: ['pending_approval', 'approved'] } },
          },
          select: { purchaseOrderLineId: true, quantity: true },
        }),
      ])
    : [[], []];

  const received = new Map<string, bigint>();
  const lastReceivedAt = new Map<string, string>();
  for (const line of receiptLines) {
    received.set(
      line.purchaseOrderLineId,
      (received.get(line.purchaseOrderLineId) ?? 0n) + storedQuantityToMilli(line.quantity),
    );
    const at = timestamp(line.receipt?.receivedAt);
    if (at && (!lastReceivedAt.has(line.purchaseOrderLineId) || at > lastReceivedAt.get(line.purchaseOrderLineId)!)) {
      lastReceivedAt.set(line.purchaseOrderLineId, at);
    }
  }
  const returned = new Map<string, bigint>();
  for (const line of returnLines) {
    returned.set(
      line.purchaseOrderLineId,
      (returned.get(line.purchaseOrderLineId) ?? 0n) + storedQuantityToMilli(line.quantity),
    );
  }

  const today = utcToday();
  const rows = visibleOrders.flatMap((order: any) =>
    order.lines.map((line: any) => {
      const position = computeLinePosition({
        orderedMilli: storedQuantityToMilli(line.quantity),
        receivedMilli: received.get(line.id) ?? 0n,
        returnedMilli: returned.get(line.id) ?? 0n,
      });
      const fullyReceived = position.netReceivedMilli >= position.orderedMilli;
      const neededByDate = dateOnly(order.purchaseRequest?.neededByDate);
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        orderStatus: order.status,
        requestNumber: order.purchaseRequest?.requestNumber ?? null,
        vendorNameSnapshot: order.vendorNameSnapshot,
        vendorId: order.vendorId,
        purchaseOrderLineId: line.id,
        descriptionSnapshot: line.descriptionSnapshot,
        unitSnapshot: line.unitSnapshot,
        unitPrice: readMoney(line.unitPrice),
        lineTotal: readMoney(line.lineTotal),
        orderedQuantity: milliToQuantity(position.orderedMilli),
        receivedQuantity: milliToQuantity(position.receivedMilli),
        returnedQuantity: milliToQuantity(position.returnedMilli),
        netReceivedQuantity: milliToQuantity(position.netReceivedMilli),
        remainingQuantity: milliToQuantity(position.remainingMilli),
        fullyReceived,
        overReceived: position.netReceivedMilli > position.orderedMilli,
        lastReceivedAt: lastReceivedAt.get(line.id) ?? null,
        neededByDate,
        // "Overdue" only where the request actually captured a needed-by date.
        overdue: neededByDate != null && !fullyReceived && neededByDate < today,
        currency: order.currency,
        createdAt: timestamp(order.createdAt),
      };
    }),
  );

  const filtered = query.outstandingOnly ? rows.filter((row) => !row.fullyReceived) : rows;
  context.assertRowLimit(filtered.length);
  const page = paginate(
    filtered,
    context.exportMode ? 1 : query.page,
    context.exportMode ? context.rowCap : query.pageSize,
  );

  return {
    generatedAt: new Date().toISOString(),
    range,
    scope: scopeCompany,
    summary: {
      orderCount: visibleOrders.length,
      orderLineCount: rows.length,
      fullyReceivedLineCount: rows.filter((row) => row.fullyReceived).length,
      outstandingLineCount: rows.filter((row) => !row.fullyReceived).length,
      partiallyReceivedOrderCount: visibleOrders.filter((order: any) => order.status === 'partially_received').length,
      overdueLineCount: rows.filter((row) => row.overdue).length,
      overReceivedLineCount: rows.filter((row) => row.overReceived).length,
      currency: 'SAR',
    },
    rows: page.rows,
    pagination: page.pagination,
    warnings: protectedRowCount > 0 ? ['توجد صفوف محمية غير ظاهرة في التقرير.'] : [],
    ...(protectedRowCount > 0 ? { protectedRowsHidden: true, protectedRowCount } : {}),
  };
}

// ---------------------------------------------------------------------------
// purchasing_returns — supplier return summary
// ---------------------------------------------------------------------------

const returnQuerySchema = z.strictObject({
  ...baseFields,
  status: z.enum(['pending_approval', 'approved', 'rejected']).optional(),
  vendorId: z.string().uuid('معرّف المورد غير صالح').optional(),
});

async function loadReturnReport(context: RegisteredReportContext): Promise<RegisteredReportResult> {
  const query = parse(returnQuerySchema, context.filters);
  const range = normalizedRange(query.from, query.to);

  const [rows, primaryOwnerUserId] = await Promise.all([
    context.prisma.purchaseReturn.findMany({
      where: {
        companyId: context.user.companyId,
        createdAt: rangeWhere(range),
        ...(query.status ? { status: query.status } : {}),
        ...(query.vendorId ? { purchaseOrder: { vendorId: query.vendorId } } : {}),
      },
      include: {
        lines: { orderBy: { createdAt: 'asc' } },
        purchaseOrder: {
          select: {
            id: true,
            orderNumber: true,
            vendorId: true,
            vendorNameSnapshot: true,
            currency: true,
            purchaseRequest: { select: { id: true, requestNumber: true, requester: requesterSelect } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: context.rowCap + 1,
    }),
    loadPrimaryOwnerUserId(context.prisma, context.user.companyId),
  ]);

  const visible = rows.filter(
    (row: any) =>
      isAdmin(context.user) || !isOwnerRequest(row.purchaseOrder?.purchaseRequest, primaryOwnerUserId),
  );
  const protectedRowCount = rows.length - visible.length;

  const mapped = visible.flatMap((row: any) =>
    row.lines.map((line: any) => ({
      returnId: row.id,
      returnNumber: row.returnNumber,
      status: row.status,
      reasonCode: row.reasonCode,
      orderId: row.purchaseOrderId,
      orderNumber: row.purchaseOrder?.orderNumber ?? null,
      requestNumber: row.purchaseOrder?.purchaseRequest?.requestNumber ?? null,
      vendorId: row.purchaseOrder?.vendorId ?? null,
      vendorNameSnapshot: row.purchaseOrder?.vendorNameSnapshot ?? null,
      purchaseOrderLineId: line.purchaseOrderLineId,
      quantity: milliToQuantity(storedQuantityToMilli(line.quantity)),
      currency: row.purchaseOrder?.currency ?? 'SAR',
      createdAt: timestamp(row.createdAt),
      reviewedAt: timestamp(row.reviewedAt),
    })),
  );
  context.assertRowLimit(mapped.length);

  const page = paginate(
    mapped,
    context.exportMode ? 1 : query.page,
    context.exportMode ? context.rowCap : query.pageSize,
  );

  return {
    generatedAt: new Date().toISOString(),
    range,
    scope: scopeCompany,
    summary: {
      returnCount: visible.length,
      returnLineCount: mapped.length,
      pendingCount: visible.filter((row: any) => row.status === 'pending_approval').length,
      approvedCount: visible.filter((row: any) => row.status === 'approved').length,
      rejectedCount: visible.filter((row: any) => row.status === 'rejected').length,
      currency: 'SAR',
    },
    rows: page.rows,
    pagination: page.pagination,
    warnings: protectedRowCount > 0 ? ['توجد صفوف محمية غير ظاهرة في التقرير.'] : [],
    ...(protectedRowCount > 0 ? { protectedRowsHidden: true, protectedRowCount } : {}),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const PURCHASING_W2_REPORT_KEYS = [
  'purchasing_quotations',
  'purchasing_receipts',
  'purchasing_returns',
] as const;

registerReport({
  key: 'purchasing_quotations',
  contractVersion: REPORT_REGISTRY_CONTRACT_VERSION,
  title: 'عروض أسعار الموردين',
  description: 'حالة عروض الأسعار وصلاحيتها والعرض المعتمد لكل طلب شراء',
  module: 'purchasing',
  supportedFilters: ['from', 'to', 'status', 'vendorId', 'requestId'],
  containsFinancialData: true,
  maximumRangeDays: 366,
  availableScopes: ['company'],
  exportable: true,
  // Quotation pricing is commercially sensitive: reading it needs an explicit
  // quotation permission on top of the purchasing report permission.
  canAccess: (user) =>
    has(user, PERMISSIONS.PURCHASING_REPORT) &&
    (has(user, PERMISSIONS.PURCHASING_QUOTATION_COMPARE) ||
      has(user, PERMISSIONS.PURCHASING_QUOTATION_MANAGE)),
  columns: [
    { key: 'quotationNumber', title: 'رقم عرض السعر' },
    { key: 'requestNumber', title: 'رقم طلب الشراء' },
    { key: 'vendorNameSnapshot', title: 'المورد' },
    { key: 'supplierReference', title: 'مرجع المورد' },
    { key: 'status', title: 'الحالة' },
    { key: 'version', title: 'الإصدار' },
    { key: 'lineCount', title: 'عدد البنود' },
    { key: 'totalAmount', title: 'الإجمالي' },
    { key: 'currency', title: 'العملة' },
    { key: 'quotationDate', title: 'تاريخ العرض' },
    { key: 'validUntilDate', title: 'صالح حتى' },
    { key: 'expectedDeliveryDate', title: 'تاريخ التسليم المتوقع' },
    { key: 'leadTimeDays', title: 'مدة التوريد (أيام)' },
    { key: 'isSelected', title: 'معتمد' },
    { key: 'createdAt', title: 'تاريخ الإنشاء' },
  ],
  load: loadQuotationReport,
});

registerReport({
  key: 'purchasing_receipts',
  contractVersion: REPORT_REGISTRY_CONTRACT_VERSION,
  title: 'تقدم استلام أوامر الشراء',
  description: 'الكميات المطلوبة والمستلمة والمرتجعة والمتبقية لكل بند أمر شراء',
  module: 'purchasing',
  supportedFilters: ['from', 'to', 'vendorId', 'orderStatus', 'outstandingOnly'],
  containsFinancialData: true,
  maximumRangeDays: 366,
  availableScopes: ['company'],
  exportable: true,
  canAccess: (user) => has(user, PERMISSIONS.PURCHASING_REPORT),
  columns: [
    { key: 'orderNumber', title: 'رقم أمر الشراء' },
    { key: 'requestNumber', title: 'رقم طلب الشراء' },
    { key: 'vendorNameSnapshot', title: 'المورد' },
    { key: 'orderStatus', title: 'حالة الأمر' },
    { key: 'descriptionSnapshot', title: 'البند' },
    { key: 'unitSnapshot', title: 'الوحدة' },
    { key: 'orderedQuantity', title: 'الكمية المطلوبة' },
    { key: 'receivedQuantity', title: 'المستلم' },
    { key: 'returnedQuantity', title: 'المرتجع' },
    { key: 'netReceivedQuantity', title: 'الصافي المستلم' },
    { key: 'remainingQuantity', title: 'المتبقي' },
    { key: 'fullyReceived', title: 'مكتمل' },
    { key: 'overdue', title: 'متأخر' },
    { key: 'neededByDate', title: 'تاريخ الاحتياج' },
    { key: 'lastReceivedAt', title: 'آخر استلام' },
    { key: 'currency', title: 'العملة' },
  ],
  load: loadReceiptProgressReport,
});

registerReport({
  key: 'purchasing_returns',
  contractVersion: REPORT_REGISTRY_CONTRACT_VERSION,
  title: 'مرتجعات المشتريات',
  description: 'طلبات إرجاع الموردين وحالتها وكمياتها',
  module: 'purchasing',
  supportedFilters: ['from', 'to', 'status', 'vendorId'],
  containsFinancialData: false,
  maximumRangeDays: 366,
  availableScopes: ['company'],
  exportable: true,
  canAccess: (user) => has(user, PERMISSIONS.PURCHASING_REPORT),
  columns: [
    { key: 'returnNumber', title: 'رقم الإرجاع' },
    { key: 'orderNumber', title: 'رقم أمر الشراء' },
    { key: 'requestNumber', title: 'رقم طلب الشراء' },
    { key: 'vendorNameSnapshot', title: 'المورد' },
    { key: 'status', title: 'الحالة' },
    { key: 'reasonCode', title: 'سبب الإرجاع' },
    { key: 'quantity', title: 'الكمية' },
    { key: 'createdAt', title: 'تاريخ الطلب' },
    { key: 'reviewedAt', title: 'تاريخ المراجعة' },
  ],
  load: loadReturnReport,
});
