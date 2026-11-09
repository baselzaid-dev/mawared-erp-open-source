import { randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { PERMISSIONS } from './permissions';
import {
  hasEffectiveCapability,
  loadAuthorizationContext,
  loadManagedDepartmentIds,
  loadPrimaryOwnerUserId,
} from './authorization';
import {
  applyReceiptCoverage,
  loadOrderProgress,
  recordFullReceiptEvent,
} from './purchasingReceipts';

export interface PurchasingUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface PurchasingRequest extends Request {
  user?: PurchasingUser;
}

interface PurchasingRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
}

type ViewScope = 'own' | 'department' | 'company';

export class PurchasingError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const dateOnlyText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'يجب إدخال التاريخ بصيغة yyyy-MM-dd');
const quantityText = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/, 'الكمية غير صالحة');
const moneyText = z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/, 'المبلغ غير صالح');

const vendorBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  contact: optionalText(160),
  email: z.string().trim().email().max(254).nullable().optional(),
  taxNumber: optionalText(80),
  category: optionalText(120),
}).strict();

const vendorStatusSchema = z.object({
  status: z.enum(['active', 'inactive']),
  reason: optionalText(500),
}).strict();

const requestLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  category: optionalText(120),
  quantity: quantityText,
  unit: z.string().trim().min(1).max(40),
  estimatedUnitPrice: moneyText,
}).strict();

const createRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  justification: optionalText(2000),
  neededByDate: dateOnlyText.nullable().optional(),
  currency: z.literal('SAR').default('SAR'),
  lines: z.array(requestLineSchema).min(1).max(50),
}).strict();

const reviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  note: optionalText(1000),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'reject' && !value.note?.trim()) {
    ctx.addIssue({ code: 'custom', path: ['note'], message: 'سبب الرفض مطلوب' });
  }
});

const cancelSchema = z.object({
  cancellationReason: z.string().trim().min(1).max(1000),
}).strict();

const receiveSchema = z.object({ receiptNote: optionalText(1000) }).strict();

const orderLineSchema = z.object({
  id: z.string().uuid().optional(),
  requestLineId: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(1).max(500),
  category: optionalText(120),
  quantity: quantityText,
  unit: z.string().trim().min(1).max(40),
  unitPrice: moneyText,
}).strict();

const orderBodySchema = z.object({
  purchaseRequestId: z.string().uuid(),
  vendorId: z.string().uuid(),
  currency: z.literal('SAR').default('SAR'),
  /** W2: optional link to the selected supplier quotation for this request. */
  supplierQuotationId: z.string().uuid().nullable().optional(),
  lines: z.array(orderLineSchema).min(1).max(50),
}).strict();

const orderUpdateSchema = orderBodySchema.omit({ purchaseRequestId: true });

const listSchema = z.object({
  scope: z.enum(['own', 'department', 'company']).optional(),
  status: z.string().trim().max(40).optional(),
  from: dateOnlyText.optional(),
  to: dateOnlyText.optional(),
  departmentId: z.string().uuid().optional(),
  requesterEmployeeId: z.string().uuid().optional(),
  vendorId: z.string().uuid().optional(),
  requestId: z.string().uuid().optional(),
  search: z.string().trim().max(160).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const reportSchema = z.object({
  from: dateOnlyText.optional(),
  to: dateOnlyText.optional(),
  requestStatus: z.string().trim().max(40).optional(),
  orderStatus: z.string().trim().max(40).optional(),
  vendorId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
}).strict();

export type PurchasingReportFilters = z.infer<typeof reportSchema>;

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PurchasingError(400, 'VALIDATION_ERROR', 'البيانات المدخلة غير صالحة', result.error.flatten());
  }
  return result.data;
};

const sendError = (res: Response, error: unknown): Response => {
  if (error instanceof PurchasingError) {
    return res.status(error.status).json({
      error: error.errorCode,
      message: error.message,
      code: error.status,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return res.status(409).json({
      error: 'PURCHASING_DUPLICATE',
      message: 'يوجد سجل مماثل بالفعل',
      code: 409,
    });
  }
  return res.status(500).json({
    error: 'PURCHASING_OPERATION_FAILED',
    message: 'تعذر إكمال عملية المشتريات حالياً',
    code: 500,
  });
};

const isAdmin = (user: PurchasingUser): boolean => user.permissions.includes(PERMISSIONS.ADMIN_FULL);
const has = (user: PurchasingUser, permission: string): boolean =>
  isAdmin(user) || user.permissions.includes(permission);

const parsePermissions = (value: string | null | undefined): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

const isOwnerRequester = (request: any, primaryOwnerUserId: string | null): boolean =>
  request.requester?.user?.id === primaryOwnerUserId ||
  parsePermissions(request.requester?.user?.role?.permissions).includes(PERMISSIONS.ADMIN_FULL);

const timestamp = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();
const dateOnly = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString().slice(0, 10);
const decimalString = (value: unknown, scale: number): string => {
  const raw = value == null ? '0' : String(value);
  const [whole, fraction = ''] = raw.split('.');
  return `${whole}.${fraction.padEnd(scale, '0').slice(0, scale)}`;
};

const parseScaled = (value: string, scale: number): bigint => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * (10n ** BigInt(scale)) + BigInt(fraction.padEnd(scale, '0'));
};

const formatScaled = (value: bigint, scale: number): string => {
  const divisor = 10n ** BigInt(scale);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(scale, '0');
  return `${whole}.${fraction}`;
};

const calculateLines = <T extends { quantity: string; unitPrice?: string; estimatedUnitPrice?: string }>(lines: T[]) => {
  let totalCents = 0n;
  const calculated = lines.map((line) => {
    const quantityMillis = parseScaled(line.quantity, 3);
    const price = line.unitPrice ?? line.estimatedUnitPrice ?? '0';
    const priceCents = parseScaled(price, 2);
    if (quantityMillis <= 0n) throw new PurchasingError(400, 'INVALID_QUANTITY', 'يجب أن تكون الكمية أكبر من صفر');
    const lineCents = (quantityMillis * priceCents + 500n) / 1000n;
    totalCents += lineCents;
    return { ...line, quantityValue: formatScaled(quantityMillis, 3), priceValue: formatScaled(priceCents, 2), lineTotal: formatScaled(lineCents, 2) };
  });
  return { lines: calculated, total: formatScaled(totalCents, 2), totalCents };
};

const parseDate = (value: string, endOfDay = false): Date => {
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new PurchasingError(400, 'INVALID_DATE', 'التاريخ غير صالح');
  }
  return date;
};

const validateRange = (from?: string, to?: string): { from?: Date; to?: Date } => {
  const start = from ? parseDate(from) : undefined;
  const end = to ? parseDate(to, true) : undefined;
  if (start && end && start > end) throw new PurchasingError(400, 'INVALID_DATE_RANGE', 'تاريخ البداية يجب أن يسبق تاريخ النهاية');
  if (start && end && (end.getTime() - start.getTime()) / 86_400_000 > 366) {
    throw new PurchasingError(400, 'DATE_RANGE_TOO_LONG', 'الفترة المطلوبة يجب ألا تتجاوز 366 يوماً');
  }
  return { from: start, to: end };
};

const validateNeededByDate = (value?: string | null): Date | null => {
  if (!value) return null;
  const date = parseDate(value);
  const oldest = new Date();
  oldest.setUTCFullYear(oldest.getUTCFullYear() - 1);
  oldest.setUTCHours(0, 0, 0, 0);
  if (date < oldest) throw new PurchasingError(400, 'NEEDED_DATE_TOO_OLD', 'تاريخ الاحتياج قديم بشكل غير مقبول');
  return date;
};

const vendorShape = (vendor: any) => ({
  id: vendor.id,
  companyId: vendor.companyId,
  name: vendor.name,
  contact: vendor.contact ?? null,
  email: vendor.email ?? null,
  taxNumber: vendor.taxNumber ?? null,
  category: vendor.category ?? null,
  status: vendor.status,
  deactivatedAt: timestamp(vendor.deactivatedAt),
  createdAt: timestamp(vendor.createdAt),
  updatedAt: timestamp(vendor.updatedAt),
});

const requestInclude = {
  lines: { orderBy: { createdAt: 'asc' as const } },
  department: { select: { id: true, name: true } },
  requester: {
    select: {
      id: true,
      employeeNum: true,
      user: { select: { id: true, name: true, role: { select: { permissions: true } } } },
    },
  },
  departmentReviewer: { select: { id: true, name: true } },
  purchasingReviewer: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  orders: {
    select: { id: true, orderNumber: true, status: true, totalAmount: true, currency: true, createdAt: true },
    orderBy: { createdAt: 'desc' as const },
  },
} as const;

const requestShape = (request: any) => ({
  id: request.id,
  companyId: request.companyId,
  requestNumber: request.requestNumber,
  requestedByEmployeeId: request.requestedByEmployeeId,
  requesterNameSnapshot: request.requesterNameSnapshot,
  requesterNumSnapshot: request.requesterNumSnapshot,
  departmentId: request.departmentId ?? null,
  departmentNameSnapshot: request.departmentNameSnapshot ?? null,
  title: request.title,
  justification: request.justification ?? null,
  neededByDate: dateOnly(request.neededByDate),
  status: request.status,
  totalEstimated: decimalString(request.totalEstimated, 2),
  currency: request.currency,
  lines: (request.lines ?? []).map((line: any) => ({
    id: line.id,
    description: line.description,
    category: line.category ?? null,
    quantity: decimalString(line.quantity, 3),
    unit: line.unit,
    estimatedUnitPrice: decimalString(line.estimatedUnitPrice, 2),
    estimatedTotal: decimalString(line.estimatedTotal, 2),
  })),
  departmentReview: request.departmentReviewedAt ? {
    reviewer: request.departmentReviewer ? { id: request.departmentReviewer.id, name: request.departmentReviewer.name } : null,
    reviewedAt: timestamp(request.departmentReviewedAt),
    note: request.departmentReviewNote ?? null,
  } : null,
  purchasingReview: request.purchasingReviewedAt ? {
    reviewer: request.purchasingReviewer ? { id: request.purchasingReviewer.id, name: request.purchasingReviewer.name } : null,
    reviewedAt: timestamp(request.purchasingReviewedAt),
    note: request.purchasingReviewNote ?? null,
  } : null,
  cancellation: request.cancelledAt ? {
    actor: request.cancelledBy ? { id: request.cancelledBy.id, name: request.cancelledBy.name } : null,
    cancelledAt: timestamp(request.cancelledAt),
    reason: request.cancellationReason ?? null,
  } : null,
  rejectedAt: timestamp(request.rejectedAt),
  orders: (request.orders ?? []).map((order: any) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    totalAmount: decimalString(order.totalAmount, 2),
    currency: order.currency,
    createdAt: timestamp(order.createdAt),
  })),
  createdAt: timestamp(request.createdAt),
  updatedAt: timestamp(request.updatedAt),
});

const orderInclude = {
  lines: { orderBy: { createdAt: 'asc' as const } },
  purchaseRequest: { include: requestInclude },
  createdBy: { select: { id: true, name: true } },
  issuedBy: { select: { id: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
} as const;

const orderShape = (order: any) => ({
  id: order.id,
  companyId: order.companyId,
  orderNumber: order.orderNumber,
  purchaseRequestId: order.purchaseRequestId,
  request: order.purchaseRequest ? {
    id: order.purchaseRequest.id,
    requestNumber: order.purchaseRequest.requestNumber,
    title: order.purchaseRequest.title,
    requesterNameSnapshot: order.purchaseRequest.requesterNameSnapshot,
    departmentNameSnapshot: order.purchaseRequest.departmentNameSnapshot ?? null,
    status: order.purchaseRequest.status,
  } : null,
  vendorId: order.vendorId,
  supplierQuotationId: order.supplierQuotationId ?? null,
  vendorNameSnapshot: order.vendorNameSnapshot,
  vendorContactSnapshot: order.vendorContactSnapshot ?? null,
  vendorEmailSnapshot: order.vendorEmailSnapshot ?? null,
  vendorTaxNumberSnapshot: order.vendorTaxNumberSnapshot ?? null,
  status: order.status,
  currency: order.currency,
  subtotal: decimalString(order.subtotal, 2),
  totalAmount: decimalString(order.totalAmount, 2),
  lines: (order.lines ?? []).map((line: any) => ({
    id: line.id,
    requestLineId: line.requestLineId ?? null,
    descriptionSnapshot: line.descriptionSnapshot,
    categorySnapshot: line.categorySnapshot ?? null,
    quantity: decimalString(line.quantity, 3),
    unitSnapshot: line.unitSnapshot,
    unitPrice: decimalString(line.unitPrice, 2),
    lineTotal: decimalString(line.lineTotal, 2),
  })),
  createdBy: order.createdBy ? { id: order.createdBy.id, name: order.createdBy.name } : null,
  issuedBy: order.issuedBy ? { id: order.issuedBy.id, name: order.issuedBy.name } : null,
  issuedAt: timestamp(order.issuedAt),
  receivedBy: order.receivedBy ? { id: order.receivedBy.id, name: order.receivedBy.name } : null,
  receivedAt: timestamp(order.receivedAt),
  receiptNote: order.receiptNote ?? null,
  cancelledBy: order.cancelledBy ? { id: order.cancelledBy.id, name: order.cancelledBy.name } : null,
  cancelledAt: timestamp(order.cancelledAt),
  cancellationReason: order.cancellationReason ?? null,
  createdAt: timestamp(order.createdAt),
  updatedAt: timestamp(order.updatedAt),
});

const managedDepartmentIds = async (client: any, user: PurchasingUser): Promise<string[]> => {
  return loadManagedDepartmentIds(client, { companyId: user.companyId, userId: user.id });
};

const resolveScope = async (client: any, user: PurchasingUser, requested?: ViewScope) => {
  const preferred: ViewScope = requested ?? (
    has(user, PERMISSIONS.PURCHASING_VIEW) ? 'company'
      : has(user, PERMISSIONS.PURCHASING_VIEW_DEPARTMENT) ? 'department'
        : 'own'
  );
  if (preferred === 'company' && !has(user, PERMISSIONS.PURCHASING_VIEW)) {
    throw new PurchasingError(403, 'PURCHASING_SCOPE_FORBIDDEN', 'لا تملك صلاحية عرض مشتريات الشركة');
  }
  if (preferred === 'department' && !has(user, PERMISSIONS.PURCHASING_VIEW_DEPARTMENT)) {
    throw new PurchasingError(403, 'PURCHASING_SCOPE_FORBIDDEN', 'لا تملك صلاحية عرض مشتريات الأقسام');
  }
  if (preferred === 'own' && !has(user, PERMISSIONS.PURCHASING_VIEW_OWN)) {
    throw new PurchasingError(403, 'PURCHASING_SCOPE_FORBIDDEN', 'لا تملك صلاحية عرض طلباتك');
  }
  return {
    kind: preferred,
    employeeId: user.employeeId,
    departmentIds: preferred === 'department' ? await managedDepartmentIds(client, user) : [],
  };
};

const scopeWhere = (scope: { kind: ViewScope; employeeId: string | null; departmentIds: string[] }) => {
  if (scope.kind === 'company') return {};
  if (scope.kind === 'department') return { departmentId: { in: scope.departmentIds } };
  return { requestedByEmployeeId: scope.employeeId ?? '__none__' };
};

const notify = async (client: any, companyId: string, actorId: string, recipients: Iterable<string>, title: string, message: string) => {
  for (const userId of new Set(recipients)) {
    if (userId === actorId) continue;
    await client.notification.create({ data: { companyId, userId, title, message } });
  }
};

const usersWithPermission = async (client: any, companyId: string, permission: string): Promise<string[]> => {
  const users = await client.user.findMany({
    where: { companyId },
    select: { id: true, role: { select: { permissions: true } } },
  });
  return users.filter((user: any) => {
    const permissions = parsePermissions(user.role?.permissions);
    return permissions.includes(PERMISSIONS.ADMIN_FULL) || permissions.includes(permission);
  }).map((user: any) => user.id);
};

const generateNumber = (prefix: 'PR' | 'PO'): string => {
  const month = new Date().toISOString().slice(0, 7).replace('-', '');
  return `${prefix}-${month}-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
};

const retryNumberCollision = async <T>(field: 'requestNumber' | 'orderNumber', operation: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const target = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
        ? String(error.meta?.target ?? '')
        : '';
      if (!target.includes(field) || attempt === 2) throw error;
    }
  }
  throw new PurchasingError(409, 'PURCHASING_NUMBER_COLLISION', 'تعذر إنشاء رقم فريد للسجل');
};

/**
 * W2 traceability: a Purchase Order may be linked to the quotation that won the
 * award. The quotation must belong to this company *and* this request, and must
 * actually be the selected one — a link is never accepted on trust.
 */
const resolveLinkedQuotation = async (
  client: any,
  companyId: string,
  purchaseRequestId: string,
  quotationId: string | null | undefined,
  vendorId: string,
): Promise<string | null> => {
  if (!quotationId) return null;
  const quotation = await client.supplierQuotation.findFirst({
    where: { id: quotationId, companyId },
    select: { id: true, purchaseRequestId: true, status: true, vendorId: true },
  });
  if (!quotation || quotation.purchaseRequestId !== purchaseRequestId) {
    throw new PurchasingError(404, 'SUPPLIER_QUOTATION_NOT_FOUND', 'عرض السعر غير موجود');
  }
  if (quotation.status !== 'selected') {
    throw new PurchasingError(409, 'QUOTATION_NOT_SELECTED', 'يجب اعتماد عرض السعر قبل ربطه بأمر الشراء');
  }
  if (quotation.vendorId !== vendorId) {
    throw new PurchasingError(409, 'QUOTATION_VENDOR_MISMATCH', 'المورد لا يطابق عرض السعر المعتمد');
  }
  return quotation.id;
};

const activeVendorForOrder = async (client: any, companyId: string, vendorId: string) => {
  const vendor = await client.vendor.findFirst({ where: { id: vendorId, companyId } });
  if (!vendor) {
    throw new PurchasingError(404, 'ACTIVE_VENDOR_NOT_FOUND', 'المورد النشط غير موجود');
  }
  if (vendor.status !== 'active') {
    throw new PurchasingError(409, 'VendorInactive', 'المورد غير نشط ولا يمكن استخدامه في أمر شراء جديد');
  }
  return vendor;
};

export const assertVisibleRequest = async (client: any, user: PurchasingUser, request: any, requestedScope?: ViewScope) => {
  const scope = await resolveScope(client, user, requestedScope);
  const primaryOwnerUserId = await loadPrimaryOwnerUserId(client, user.companyId);
  const visible = scope.kind === 'company'
    || (scope.kind === 'department' && request.departmentId && scope.departmentIds.includes(request.departmentId))
    || (scope.kind === 'own' && request.requestedByEmployeeId === scope.employeeId);
  if (!visible || (isOwnerRequester(request, primaryOwnerUserId) && !isAdmin(user) && scope.kind !== 'own')) {
    throw new PurchasingError(404, 'PURCHASE_REQUEST_NOT_FOUND', 'طلب الشراء غير موجود');
  }
};

export async function buildPurchasingReport(
  client: any,
  user: PurchasingUser,
  rawFilters: unknown,
  maxRows = 1000
): Promise<any> {
  const query = parse(reportSchema, rawFilters);
  const range = validateRange(query.from, query.to);
  const limit = Math.max(1, Math.min(maxRows, 5001));
  const requestWhere: any = {
    companyId: user.companyId,
    ...(query.requestStatus ? { status: query.requestStatus } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...((range.from || range.to) ? {
      createdAt: {
        ...(range.from ? { gte: range.from } : {}),
        ...(range.to ? { lte: range.to } : {}),
      },
    } : {}),
  };
  const orderWhere: any = {
    companyId: user.companyId,
    ...(query.orderStatus ? { status: query.orderStatus } : {}),
    ...(query.vendorId ? { vendorId: query.vendorId } : {}),
    ...(query.departmentId ? { purchaseRequest: { departmentId: query.departmentId } } : {}),
    ...((range.from || range.to) ? {
      createdAt: {
        ...(range.from ? { gte: range.from } : {}),
        ...(range.to ? { lte: range.to } : {}),
      },
    } : {}),
  };
  const [requestRows, orderRows, primaryOwnerUserId] = await Promise.all([
    client.purchaseRequest.findMany({
      where: requestWhere,
      include: requestInclude,
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    client.purchaseOrder.findMany({
      where: orderWhere,
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    loadPrimaryOwnerUserId(client, user.companyId),
  ]);
  const requests = requestRows.filter(
    (row: any) => isAdmin(user) || !isOwnerRequester(row, primaryOwnerUserId),
  );
  const orders = orderRows.filter(
    (row: any) => isAdmin(user) || !isOwnerRequester(row.purchaseRequest, primaryOwnerUserId)
  );
  const sum = (values: unknown[]) => formatScaled(
    values.reduce<bigint>(
      (total, value) => total + parseScaled(decimalString(value, 2), 2),
      0n
    ),
    2
  );
  const activeOrders = orders.filter((order: any) => order.status !== 'cancelled');
  const receivedOrders = orders.filter((order: any) => order.status === 'received');
  return {
    summary: {
      requestCount: requests.length,
      pendingDepartmentCount: requests.filter((row: any) => row.status === 'pending_department').length,
      pendingPurchasingCount: requests.filter((row: any) => row.status === 'pending_purchasing').length,
      approvedCount: requests.filter((row: any) => row.status === 'approved').length,
      rejectedCount: requests.filter((row: any) => row.status === 'rejected').length,
      orderedCount: requests.filter((row: any) => row.status === 'ordered').length,
      receivedCount: requests.filter((row: any) => row.status === 'received').length,
      cancelledCount: requests.filter((row: any) => row.status === 'cancelled').length,
      orderCount: orders.length,
      draftOrderCount: orders.filter((row: any) => row.status === 'draft').length,
      issuedOrderCount: orders.filter((row: any) => row.status === 'issued').length,
      receivedOrderCount: receivedOrders.length,
      cancelledOrderCount: orders.filter((row: any) => row.status === 'cancelled').length,
      estimatedTotal: sum(requests.map((row: any) => row.totalEstimated)),
      orderedTotal: sum(activeOrders.map((row: any) => row.totalAmount)),
      receivedTotal: sum(receivedOrders.map((row: any) => row.totalAmount)),
      currency: 'SAR',
    },
    requests: requests.map((row: any) => ({
      id: row.id,
      requestNumber: row.requestNumber,
      title: row.title,
      requesterNameSnapshot: row.requesterNameSnapshot,
      departmentNameSnapshot: row.departmentNameSnapshot,
      status: row.status,
      totalEstimated: decimalString(row.totalEstimated, 2),
      createdAt: timestamp(row.createdAt),
    })),
    orders: orders.map((row: any) => ({
      id: row.id,
      orderNumber: row.orderNumber,
      requestNumber: row.purchaseRequest.requestNumber,
      vendorNameSnapshot: row.vendorNameSnapshot,
      status: row.status,
      totalAmount: decimalString(row.totalAmount, 2),
      createdAt: timestamp(row.createdAt),
    })),
  };
}

export function registerPurchasingRoutes({ app, prisma, requireAuth, checkAnyPermission }: PurchasingRouteDeps): void {
  app.get('/api/vendors', requireAuth, checkAnyPermission(PERMISSIONS.VENDORS_VIEW), async (req: PurchasingRequest, res) => {
    try {
      const query = parse(listSchema.pick({ status: true, search: true, page: true, pageSize: true }), req.query);
      const where: any = {
        companyId: req.user!.companyId,
        ...(query.status ? { status: query.status } : { status: 'active' }),
        ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
      };
      const [items, total] = await Promise.all([
        prisma.vendor.findMany({ where, orderBy: { name: 'asc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.vendor.count({ where }),
      ]);
      return res.json({ items: items.map(vendorShape), page: query.page, pageSize: query.pageSize, total });
    } catch (error) { return sendError(res, error); }
  });

  app.post('/api/vendors', requireAuth, checkAnyPermission(PERMISSIONS.VENDORS_MANAGE), async (req: PurchasingRequest, res) => {
    try {
      const body = parse(vendorBodySchema, req.body);
      const vendor = await prisma.$transaction(async (tx) => {
        const duplicate = await tx.vendor.findFirst({ where: { companyId: req.user!.companyId, status: 'active', name: { equals: body.name, mode: 'insensitive' } } });
        if (duplicate) throw new PurchasingError(409, 'VENDOR_NAME_DUPLICATE', 'يوجد مورد نشط بهذا الاسم');
        const created = await tx.vendor.create({ data: {
          companyId: req.user!.companyId, createdByUserId: req.user!.id, status: 'active',
          name: body.name, contact: body.contact ?? null, email: body.email ?? null,
          taxNumber: body.taxNumber ?? null, category: body.category ?? null,
        } });
        await writeAuditRequired(tx as any, { companyId: req.user!.companyId, userId: req.user!.id, action: 'vendor.create', details: { vendorId: created.id } });
        return created;
      });
      return res.status(201).json(vendorShape(vendor));
    } catch (error) { return sendError(res, error); }
  });

  app.put('/api/vendors/:id', requireAuth, checkAnyPermission(PERMISSIONS.VENDORS_MANAGE), async (req: PurchasingRequest, res) => {
    try {
      const body = parse(vendorBodySchema, req.body);
      const vendor = await prisma.$transaction(async (tx) => {
        const existing = await tx.vendor.findFirst({ where: { id: req.params.id, companyId: req.user!.companyId } });
        if (!existing) throw new PurchasingError(404, 'VENDOR_NOT_FOUND', 'المورد غير موجود');
        if (existing.status === 'active') {
          const duplicate = await tx.vendor.findFirst({ where: { companyId: req.user!.companyId, status: 'active', id: { not: existing.id }, name: { equals: body.name, mode: 'insensitive' } } });
          if (duplicate) throw new PurchasingError(409, 'VENDOR_NAME_DUPLICATE', 'يوجد مورد نشط بهذا الاسم');
        }
        const changedFields = ['name', 'contact', 'email', 'taxNumber', 'category'].filter((field) => (existing as any)[field] !== (body as any)[field]);
        const updated = await tx.vendor.update({ where: { id: existing.id }, data: {
          name: body.name, contact: body.contact ?? null, email: body.email ?? null,
          taxNumber: body.taxNumber ?? null, category: body.category ?? null,
        } });
        await writeAuditRequired(tx as any, { companyId: req.user!.companyId, userId: req.user!.id, action: 'vendor.update', details: { vendorId: existing.id, changedFields } });
        return updated;
      });
      return res.json(vendorShape(vendor));
    } catch (error) { return sendError(res, error); }
  });

  app.patch('/api/vendors/:id/status', requireAuth, checkAnyPermission(PERMISSIONS.VENDORS_MANAGE), async (req: PurchasingRequest, res) => {
    try {
      const body = parse(vendorStatusSchema, req.body);
      const vendor = await prisma.$transaction(async (tx) => {
        const existing = await tx.vendor.findFirst({ where: { id: req.params.id, companyId: req.user!.companyId } });
        if (!existing) throw new PurchasingError(404, 'VENDOR_NOT_FOUND', 'المورد غير موجود');
        if (existing.status === body.status) return existing;
        if (body.status === 'active') {
          const duplicate = await tx.vendor.findFirst({ where: { companyId: req.user!.companyId, status: 'active', id: { not: existing.id }, name: { equals: existing.name, mode: 'insensitive' } } });
          if (duplicate) throw new PurchasingError(409, 'VENDOR_NAME_DUPLICATE', 'لا يمكن تفعيل المورد لوجود مورد نشط بالاسم نفسه');
        }
        const updated = await tx.vendor.update({ where: { id: existing.id }, data: { status: body.status, deactivatedAt: body.status === 'inactive' ? new Date() : null } });
        await writeAuditRequired(tx as any, { companyId: req.user!.companyId, userId: req.user!.id, action: 'vendor.status', details: { vendorId: existing.id, status: body.status } });
        return updated;
      });
      return res.json(vendorShape(vendor));
    } catch (error) { return sendError(res, error); }
  });

  app.delete('/api/vendors/:id', requireAuth, (_req, res) => res.status(405).json({
    error: 'VENDOR_DELETE_NOT_ALLOWED',
    message: 'حذف المورد غير مسموح. استخدم تعطيل المورد للحفاظ على السجل.',
    code: 405,
  }));

  app.post('/api/purchasing/requests', requireAuth, checkAnyPermission(PERMISSIONS.PURCHASING_CREATE), async (req: PurchasingRequest, res) => {
    try {
      const body = parse(createRequestSchema, req.body);
      const neededByDate = validateNeededByDate(body.neededByDate);
      const calculated = calculateLines(body.lines);
      const created = await retryNumberCollision('requestNumber', () => prisma.$transaction(async (tx) => {
        const employee = await tx.employee.findFirst({
          where: { id: req.user!.employeeId ?? '__none__', companyId: req.user!.companyId, status: 'active' },
          include: { user: { select: { id: true, name: true } }, department: { select: { id: true, name: true, managerId: true } } },
        });
        if (!employee || employee.user?.id !== req.user!.id) {
          throw new PurchasingError(403, 'ACTIVE_EMPLOYEE_REQUIRED', 'يلزم ربط الحساب بموظف نشط لإنشاء طلب شراء');
        }
        const managerIds = new Set<string>();
        if (employee.department?.managerId) managerIds.add(employee.department.managerId);
        if (employee.department?.id) {
          const managerRows = await tx.departmentManager.findMany({
            where: {
              companyId: req.user!.companyId,
              departmentId: employee.department.id,
              status: 'active',
            },
            select: { userId: true },
          });
          for (const manager of managerRows) managerIds.add(manager.userId);
        }
        managerIds.delete(req.user!.id);
        const eligibleManagerIds: string[] = [];
        for (const managerId of managerIds) {
          const managerContext = await loadAuthorizationContext(tx, {
            companyId: req.user!.companyId,
            userId: managerId,
          });
          if (managerContext && employee.department?.id && hasEffectiveCapability(
            managerContext,
            PERMISSIONS.PURCHASING_REVIEW_DEPARTMENT,
            { scopeType: 'department', departmentId: employee.department.id },
          )) {
            eligibleManagerIds.push(managerId);
          }
        }
        const initialStatus = eligibleManagerIds.length > 0 ? 'pending_department' : 'pending_purchasing';
        const requestNumber = generateNumber('PR');
        const purchaseRequest = await tx.purchaseRequest.create({
          data: {
            companyId: req.user!.companyId,
            requestNumber,
            requestedByEmployeeId: employee.id,
            requesterNameSnapshot: employee.user.name,
            requesterNumSnapshot: employee.employeeNum,
            departmentId: employee.department?.id ?? null,
            departmentNameSnapshot: employee.department?.name ?? null,
            title: body.title,
            justification: body.justification ?? null,
            neededByDate,
            status: initialStatus,
            totalEstimated: new Prisma.Decimal(calculated.total),
            currency: 'SAR',
            lines: { create: calculated.lines.map((line) => ({
              description: line.description,
              category: line.category ?? null,
              quantity: new Prisma.Decimal(line.quantityValue),
              unit: line.unit,
              estimatedUnitPrice: new Prisma.Decimal(line.priceValue),
              estimatedTotal: new Prisma.Decimal(line.lineTotal),
            })) },
          },
          include: requestInclude,
        });
        const recipients = eligibleManagerIds.length > 0
          ? eligibleManagerIds
          : await usersWithPermission(tx, req.user!.companyId, PERMISSIONS.PURCHASING_APPROVE);
        await notify(tx, req.user!.companyId, req.user!.id, recipients,
          initialStatus === 'pending_department' ? 'طلب شراء بانتظار مراجعة القسم' : 'طلب شراء بانتظار المراجعة',
          initialStatus === 'pending_department' ? 'يوجد طلب شراء جديد يحتاج مراجعة القسم.' : 'يوجد طلب شراء جديد يحتاج مراجعة المشتريات.');
        await writeAuditRequired(tx as any, { companyId: req.user!.companyId, userId: req.user!.id, action: 'purchasing.request.create', details: { requestId: purchaseRequest.id, lineCount: calculated.lines.length, status: initialStatus } });
        return purchaseRequest;
      }));
      return res.status(201).json(requestShape(created));
    } catch (error) { return sendError(res, error); }
  });

  app.get('/api/purchasing/requests', requireAuth, checkAnyPermission(
    PERMISSIONS.PURCHASING_VIEW_OWN, PERMISSIONS.PURCHASING_VIEW_DEPARTMENT, PERMISSIONS.PURCHASING_VIEW
  ), async (req: PurchasingRequest, res) => {
    try {
      const query = parse(listSchema.omit({ vendorId: true, requestId: true, search: true }), req.query);
      const scope = await resolveScope(prisma, req.user!, query.scope);
      const range = validateRange(query.from, query.to);
      if (query.departmentId && scope.kind === 'department' && !scope.departmentIds.includes(query.departmentId)) {
        throw new PurchasingError(403, 'DEPARTMENT_SCOPE_FORBIDDEN', 'القسم المطلوب خارج نطاق إدارتك');
      }
      if ((query.departmentId || query.requesterEmployeeId) && scope.kind === 'own') {
        throw new PurchasingError(403, 'PURCHASING_FILTER_FORBIDDEN', 'لا يمكن استخدام هذا المرشح في النطاق الشخصي');
      }
      const where: any = {
        companyId: req.user!.companyId,
        ...scopeWhere(scope),
        ...(query.status ? { status: query.status } : {}),
        ...(query.departmentId ? { departmentId: query.departmentId } : {}),
        ...(query.requesterEmployeeId ? { requestedByEmployeeId: query.requesterEmployeeId } : {}),
        ...((range.from || range.to) ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}),
      };
      const rows = await prisma.purchaseRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize });
      const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
      const visible = rows.filter((row) =>
        isAdmin(req.user!) || scope.kind === 'own' || !isOwnerRequester(row, primaryOwnerUserId)
      );
      return res.json({ items: visible.map(requestShape), page: query.page, pageSize: query.pageSize, total: visible.length });
    } catch (error) { return sendError(res, error); }
  });

  app.get('/api/purchasing/requests/:id', requireAuth, checkAnyPermission(
    PERMISSIONS.PURCHASING_VIEW_OWN, PERMISSIONS.PURCHASING_VIEW_DEPARTMENT, PERMISSIONS.PURCHASING_VIEW
  ), async (req: PurchasingRequest, res) => {
    try {
      const request = await prisma.purchaseRequest.findFirst({ where: { id: req.params.id, companyId: req.user!.companyId }, include: requestInclude });
      if (!request) throw new PurchasingError(404, 'PURCHASE_REQUEST_NOT_FOUND', 'طلب الشراء غير موجود');
      await assertVisibleRequest(prisma, req.user!, request, req.query.scope as ViewScope | undefined);
      return res.json(requestShape(request));
    } catch (error) { return sendError(res, error); }
  });

  app.post('/api/purchasing/requests/:id/cancel', requireAuth, checkAnyPermission(
    PERMISSIONS.PURCHASING_VIEW_OWN, PERMISSIONS.PURCHASING_MANAGE
  ), async (req: PurchasingRequest, res) => {
    try {
      const body = parse(cancelSchema, req.body);
      const updated = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "PurchaseRequest" WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId} FOR UPDATE`;
        const request = await tx.purchaseRequest.findFirst({ where: { id: req.params.id, companyId: req.user!.companyId }, include: requestInclude });
        if (!request) throw new PurchasingError(404, 'PURCHASE_REQUEST_NOT_FOUND', 'طلب الشراء غير موجود');
        const ownPending = request.requestedByEmployeeId === req.user!.employeeId && ['pending_department', 'pending_purchasing'].includes(request.status);
        const managerCancel = has(req.user!, PERMISSIONS.PURCHASING_MANAGE) && request.status !== 'received';
        if (!ownPending && !managerCancel) throw new PurchasingError(409, 'REQUEST_CANCEL_NOT_ALLOWED', 'لا يمكن إلغاء طلب الشراء في حالته الحالية');
        if ((request.orders ?? []).some((order: any) => order.status !== 'cancelled')) {
          throw new PurchasingError(409, 'ACTIVE_ORDER_EXISTS', 'يجب إلغاء أمر الشراء النشط أولاً');
        }
        const result = await tx.purchaseRequest.update({ where: { id: request.id }, data: { status: 'cancelled', cancelledByUserId: req.user!.id, cancelledAt: new Date(), cancellationReason: body.cancellationReason }, include: requestInclude });
        const requesterUserId = request.requester?.user?.id;
        if (requesterUserId) await notify(tx, req.user!.companyId, req.user!.id, [requesterUserId], 'تم إلغاء طلب الشراء', 'تم إلغاء طلب الشراء الخاص بك.');
        await writeAuditRequired(tx as any, { companyId: req.user!.companyId, userId: req.user!.id, action: 'purchasing.request.cancel', details: { requestId: request.id, status: 'cancelled' } });
        return result;
      });
      return res.json(requestShape(updated));
    } catch (error) { return sendError(res, error); }
  });

  app.post('/api/purchasing/requests/:id/department-review', requireAuth, checkAnyPermission(PERMISSIONS.PURCHASING_REVIEW_DEPARTMENT), async (req: PurchasingRequest, res) => {
    try {
      const body = parse(reviewSchema, req.body);
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "PurchaseRequest" WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId} FOR UPDATE`;
        const request = await tx.purchaseRequest.findFirst({ where: { id: req.params.id, companyId: req.user!.companyId }, include: requestInclude });
        if (!request) throw new PurchasingError(404, 'PURCHASE_REQUEST_NOT_FOUND', 'طلب الشراء غير موجود');
        if (request.status !== 'pending_department') throw new PurchasingError(409, 'DEPARTMENT_REVIEW_INVALID', 'الطلب ليس بانتظار مراجعة القسم');
        const departments = await managedDepartmentIds(tx, req.user!);
        if (!request.departmentId || !departments.includes(request.departmentId)) throw new PurchasingError(403, 'DEPARTMENT_REVIEW_FORBIDDEN', 'الطلب خارج نطاق إدارتك');
        if (request.requestedByEmployeeId === req.user!.employeeId) throw new PurchasingError(403, 'SELF_REVIEW_BLOCKED', 'لا يمكنك مراجعة طلبك الشخصي');
        const nextStatus = body.action === 'approve' ? 'pending_purchasing' : 'rejected';
        const updated = await tx.purchaseRequest.update({ where: { id: request.id }, data: {
          status: nextStatus, departmentReviewedByUserId: req.user!.id, departmentReviewedAt: new Date(),
          departmentReviewNote: body.note ?? null, rejectedAt: body.action === 'reject' ? new Date() : null,
        }, include: requestInclude });
        const requesterId = request.requester?.user?.id;
        const recipients = body.action === 'approve' ? await usersWithPermission(tx, req.user!.companyId, PERMISSIONS.PURCHASING_APPROVE) : [];
        if (requesterId) recipients.push(requesterId);
        await notify(tx, req.user!.companyId, req.user!.id, recipients,
          body.action === 'approve' ? 'تمت مراجعة طلب الشراء' : 'تم رفض طلب الشراء',
          body.action === 'approve' ? 'انتقل طلب الشراء إلى مراجعة المشتريات.' : 'تم رفض طلب الشراء.');
        await writeAuditRequired(tx as any, { companyId: req.user!.companyId, userId: req.user!.id, action: `purchasing.request.department_${body.action}`, details: { requestId: request.id, action: body.action } });
        return updated;
      });
      return res.json(requestShape(result));
    } catch (error) { return sendError(res, error); }
  });

  app.post('/api/purchasing/requests/:id/purchasing-review', requireAuth, checkAnyPermission(PERMISSIONS.PURCHASING_APPROVE), async (req: PurchasingRequest, res) => {
    try {
      const body = parse(reviewSchema, req.body);
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "PurchaseRequest" WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId} FOR UPDATE`;
        const request = await tx.purchaseRequest.findFirst({ where: { id: req.params.id, companyId: req.user!.companyId }, include: requestInclude });
        if (!request) throw new PurchasingError(404, 'PURCHASE_REQUEST_NOT_FOUND', 'طلب الشراء غير موجود');
        if (request.status !== 'pending_purchasing') throw new PurchasingError(409, 'PURCHASING_REVIEW_INVALID', 'الطلب ليس بانتظار مراجعة المشتريات');
        if (request.requestedByEmployeeId === req.user!.employeeId) throw new PurchasingError(403, 'SELF_REVIEW_BLOCKED', 'لا يمكنك اعتماد طلبك الشخصي');
        const nextStatus = body.action === 'approve' ? 'approved' : 'rejected';
        const updated = await tx.purchaseRequest.update({ where: { id: request.id }, data: {
          status: nextStatus, purchasingReviewedByUserId: req.user!.id, purchasingReviewedAt: new Date(),
          purchasingReviewNote: body.note ?? null, rejectedAt: body.action === 'reject' ? new Date() : null,
        }, include: requestInclude });
        const requesterId = request.requester?.user?.id;
        if (requesterId) await notify(tx, req.user!.companyId, req.user!.id, [requesterId],
          body.action === 'approve' ? 'تم اعتماد طلب الشراء' : 'تم رفض طلب الشراء',
          body.action === 'approve' ? 'تم اعتماد طلب الشراء وأصبح جاهزاً لإنشاء أمر شراء.' : 'تم رفض طلب الشراء.');
        await writeAuditRequired(tx as any, { companyId: req.user!.companyId, userId: req.user!.id, action: `purchasing.request.${body.action}`, details: { requestId: request.id, action: body.action } });
        return updated;
      });
      return res.json(requestShape(result));
    } catch (error) { return sendError(res, error); }
  });

  app.post('/api/purchasing/orders', requireAuth, checkAnyPermission(PERMISSIONS.PURCHASING_MANAGE), async (req: PurchasingRequest, res) => {
    try {
      const body = parse(orderBodySchema, req.body);
      const calculated = calculateLines(body.lines);
      const result = await retryNumberCollision('orderNumber', () => prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "PurchaseRequest" WHERE "id" = ${body.purchaseRequestId} AND "companyId" = ${req.user!.companyId} FOR UPDATE`;
        const request = await tx.purchaseRequest.findFirst({ where: { id: body.purchaseRequestId, companyId: req.user!.companyId }, include: { lines: true, orders: true, requester: { include: { user: { select: { id: true } } } } } });
        if (!request) throw new PurchasingError(404, 'PURCHASE_REQUEST_NOT_FOUND', 'طلب الشراء غير موجود');
        if (request.status !== 'approved') throw new PurchasingError(409, 'ORDER_REQUEST_NOT_APPROVED', 'يجب اعتماد طلب الشراء أولاً');
        if (request.orders.some((order: any) => order.status !== 'cancelled')) throw new PurchasingError(409, 'ACTIVE_ORDER_EXISTS', 'يوجد أمر شراء نشط لهذا الطلب');
        const vendor = await activeVendorForOrder(tx, req.user!.companyId, body.vendorId);
        const requestLineIds = new Set(request.lines.map((line: any) => line.id));
        if (body.lines.some((line) => line.requestLineId && !requestLineIds.has(line.requestLineId))) {
          throw new PurchasingError(400, 'INVALID_REQUEST_LINE', 'أحد بنود الأمر لا يتبع طلب الشراء');
        }
        const linkedQuotationId = await resolveLinkedQuotation(
          tx, req.user!.companyId, request.id, body.supplierQuotationId, vendor.id,
        );
        const order = await tx.purchaseOrder.create({ data: {
          companyId: req.user!.companyId, orderNumber: generateNumber('PO'), purchaseRequestId: request.id,
          supplierQuotationId: linkedQuotationId,
          vendorId: vendor.id, vendorNameSnapshot: vendor.name, vendorContactSnapshot: vendor.contact,
          vendorEmailSnapshot: vendor.email, vendorTaxNumberSnapshot: vendor.taxNumber,
          status: 'draft', currency: 'SAR', subtotal: new Prisma.Decimal(calculated.total), totalAmount: new Prisma.Decimal(calculated.total),
          createdByUserId: req.user!.id,
          lines: { create: calculated.lines.map((line) => ({
            requestLineId: line.requestLineId ?? null,
            descriptionSnapshot: line.description, categorySnapshot: line.category ?? null,
            quantity: new Prisma.Decimal(line.quantityValue), unitSnapshot: line.unit,
            unitPrice: new Prisma.Decimal(line.priceValue), lineTotal: new Prisma.Decimal(line.lineTotal),
          })) },
        }, include: orderInclude });
        await tx.purchaseRequest.update({ where: { id: request.id }, data: { status: 'ordered' } });
        const requesterId = request.requester?.user?.id;
        if (requesterId) await notify(tx, req.user!.companyId, req.user!.id, [requesterId], 'تم إنشاء أمر شراء', 'تم إنشاء مسودة أمر شراء لطلبك.');
        await writeAuditRequired(tx as any, { companyId: req.user!.companyId, userId: req.user!.id, action: 'purchasing.order.create', details: { orderId: order.id, requestId: request.id, vendorId: vendor.id, itemCount: calculated.lines.length, ...(linkedQuotationId ? { quotationId: linkedQuotationId } : {}) } });
        return order;
      }));
      return res.status(201).json(orderShape(result));
    } catch (error) { return sendError(res, error); }
  });

  app.put('/api/purchasing/orders/:id', requireAuth, checkAnyPermission(PERMISSIONS.PURCHASING_MANAGE), async (req: PurchasingRequest, res) => {
    try {
      const body = parse(orderUpdateSchema, req.body);
      const calculated = calculateLines(body.lines);
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId} FOR UPDATE`;
        const order = await tx.purchaseOrder.findFirst({ where: { id: req.params.id, companyId: req.user!.companyId }, include: { lines: true, purchaseRequest: { include: { lines: true } } } });
        if (!order) throw new PurchasingError(404, 'PURCHASE_ORDER_NOT_FOUND', 'أمر الشراء غير موجود');
        if (order.status !== 'draft') throw new PurchasingError(409, 'ORDER_IMMUTABLE', 'لا يمكن تعديل أمر الشراء بعد إصداره');
        const vendor = await activeVendorForOrder(tx, req.user!.companyId, body.vendorId);
        const existingIds = new Set(order.lines.map((line: any) => line.id));
        const suppliedIds = new Set(body.lines.map((line) => line.id).filter((id): id is string => !!id));
        if ([...existingIds].some((id) => !suppliedIds.has(id)) || [...suppliedIds].some((id) => !existingIds.has(id))) {
          throw new PurchasingError(400, 'ORDER_LINE_REMOVAL_NOT_ALLOWED', 'لا يمكن حذف بنود أمر الشراء؛ يمكن تعديل البنود الحالية أو إضافة بنود جديدة');
        }
        const requestLineIds = new Set(order.purchaseRequest.lines.map((line: any) => line.id));
        if (body.lines.some((line) => line.requestLineId && !requestLineIds.has(line.requestLineId))) throw new PurchasingError(400, 'INVALID_REQUEST_LINE', 'أحد البنود لا يتبع طلب الشراء');
        for (const line of calculated.lines) {
          const data = { requestLineId: line.requestLineId ?? null, descriptionSnapshot: line.description, categorySnapshot: line.category ?? null, quantity: new Prisma.Decimal(line.quantityValue), unitSnapshot: line.unit, unitPrice: new Prisma.Decimal(line.priceValue), lineTotal: new Prisma.Decimal(line.lineTotal) };
          if (line.id) await tx.purchaseOrderLine.update({ where: { id: line.id }, data });
          else await tx.purchaseOrderLine.create({ data: { ...data, companyId: req.user!.companyId, purchaseOrderId: order.id } });
        }
        await tx.purchaseOrder.update({ where: { id: order.id }, data: {
          vendorId: vendor.id, vendorNameSnapshot: vendor.name, vendorContactSnapshot: vendor.contact,
          vendorEmailSnapshot: vendor.email, vendorTaxNumberSnapshot: vendor.taxNumber,
          subtotal: new Prisma.Decimal(calculated.total), totalAmount: new Prisma.Decimal(calculated.total),
        } });
        await writeAuditRequired(tx as any, { companyId: req.user!.companyId, userId: req.user!.id, action: 'purchasing.order.update', details: { orderId: order.id, changedFields: ['vendor', 'lines', 'totals'], itemCount: calculated.lines.length } });
        return tx.purchaseOrder.findUnique({ where: { id: order.id }, include: orderInclude });
      });
      return res.json(orderShape(result));
    } catch (error) { return sendError(res, error); }
  });

  app.get('/api/purchasing/orders', requireAuth, checkAnyPermission(
    PERMISSIONS.PURCHASING_VIEW_OWN, PERMISSIONS.PURCHASING_VIEW_DEPARTMENT, PERMISSIONS.PURCHASING_VIEW
  ), async (req: PurchasingRequest, res) => {
    try {
      const query = parse(listSchema.omit({ requesterEmployeeId: true, departmentId: true, search: true }), req.query);
      const scope = await resolveScope(prisma, req.user!, query.scope);
      const range = validateRange(query.from, query.to);
      const requestFilter = scopeWhere(scope);
      const where: any = {
        companyId: req.user!.companyId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.vendorId ? { vendorId: query.vendorId } : {}),
        ...(query.requestId ? { purchaseRequestId: query.requestId } : {}),
        ...(Object.keys(requestFilter).length ? { purchaseRequest: requestFilter } : {}),
        ...((range.from || range.to) ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}),
      };
      const rows = await prisma.purchaseOrder.findMany({ where, include: orderInclude, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize });
      const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
      const visible = rows.filter((row) =>
        isAdmin(req.user!) || scope.kind === 'own' ||
        !isOwnerRequester(row.purchaseRequest, primaryOwnerUserId)
      );
      return res.json({ items: visible.map(orderShape), page: query.page, pageSize: query.pageSize, total: visible.length });
    } catch (error) { return sendError(res, error); }
  });

  app.get('/api/purchasing/orders/:id', requireAuth, checkAnyPermission(
    PERMISSIONS.PURCHASING_VIEW_OWN, PERMISSIONS.PURCHASING_VIEW_DEPARTMENT, PERMISSIONS.PURCHASING_VIEW
  ), async (req: PurchasingRequest, res) => {
    try {
      const order = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, companyId: req.user!.companyId }, include: orderInclude });
      if (!order) throw new PurchasingError(404, 'PURCHASE_ORDER_NOT_FOUND', 'أمر الشراء غير موجود');
      await assertVisibleRequest(prisma, req.user!, order.purchaseRequest, req.query.scope as ViewScope | undefined);
      return res.json(orderShape(order));
    } catch (error) { return sendError(res, error); }
  });

  app.post('/api/purchasing/orders/:id/issue', requireAuth, checkAnyPermission(PERMISSIONS.PURCHASING_MANAGE), async (req: PurchasingRequest, res) => {
    try {
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId} FOR UPDATE`;
        const order = await tx.purchaseOrder.findFirst({ where: { id: req.params.id, companyId: req.user!.companyId }, include: orderInclude });
        if (!order) throw new PurchasingError(404, 'PURCHASE_ORDER_NOT_FOUND', 'أمر الشراء غير موجود');
        if (order.status !== 'draft' || !order.lines.length || order.purchaseRequest.status !== 'ordered') throw new PurchasingError(409, 'ORDER_ISSUE_INVALID', 'لا يمكن إصدار أمر الشراء في حالته الحالية');
        const vendor = await tx.vendor.findFirst({ where: { id: order.vendorId, companyId: req.user!.companyId, status: 'active' }, select: { id: true } });
        if (!vendor) throw new PurchasingError(409, 'ORDER_VENDOR_INACTIVE', 'لا يمكن إصدار الأمر لأن المورد غير نشط');
        const updated = await tx.purchaseOrder.update({ where: { id: order.id }, data: { status: 'issued', issuedByUserId: req.user!.id, issuedAt: new Date() }, include: orderInclude });
        const requesterId = order.purchaseRequest.requester?.user?.id;
        if (requesterId) await notify(tx, req.user!.companyId, req.user!.id, [requesterId], 'تم إصدار أمر الشراء', 'تم إصدار أمر الشراء المرتبط بطلبك.');
        await writeAuditRequired(tx as any, { companyId: req.user!.companyId, userId: req.user!.id, action: 'purchasing.order.issue', details: { orderId: order.id, status: 'issued' } });
        return updated;
      });
      return res.json(orderShape(result));
    } catch (error) { return sendError(res, error); }
  });

  app.post('/api/purchasing/orders/:id/receive', requireAuth, checkAnyPermission(PERMISSIONS.PURCHASING_RECEIVE), async (req: PurchasingRequest, res) => {
    try {
      const body = parse(receiveSchema, req.body);
      const receivedAt = new Date();
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId} FOR UPDATE`;
        const order = await tx.purchaseOrder.findFirst({ where: { id: req.params.id, companyId: req.user!.companyId }, include: orderInclude });
        if (!order) throw new PurchasingError(404, 'PURCHASE_ORDER_NOT_FOUND', 'أمر الشراء غير موجود');
        // W2: a partially received order may still be closed out through this
        // legacy whole-order path; every other status keeps its previous meaning.
        if (!['issued', 'partially_received'].includes(order.status)) {
          throw new PurchasingError(409, 'ORDER_RECEIVE_INVALID', 'يمكن استلام أوامر الشراء الصادرة فقط');
        }
        // "Receive all remaining" is computed transactionally inside the order
        // row lock taken above, then recorded as one immutable receipt event.
        const before = await loadOrderProgress(tx, req.user!.companyId, order.lines as any, order.id);
        const receipt = await recordFullReceiptEvent(tx, {
          companyId: req.user!.companyId,
          orderId: order.id,
          progress: before,
          receivedByUserId: req.user!.id,
          receivedAt,
          note: body.receiptNote ?? null,
          idempotencyKey: `legacy-full-receive:${order.id}:${randomUUID()}`,
        });
        const after = await loadOrderProgress(tx, req.user!.companyId, order.lines as any, order.id);
        await applyReceiptCoverage(tx, {
          companyId: req.user!.companyId,
          orderId: order.id,
          purchaseRequestId: order.purchaseRequestId,
          progress: after,
          receivedByUserId: req.user!.id,
          receivedAt,
          receiptNote: body.receiptNote ?? null,
        });
        const updated = await tx.purchaseOrder.findFirst({ where: { id: order.id, companyId: req.user!.companyId }, include: orderInclude });
        const recipients = await usersWithPermission(tx, req.user!.companyId, PERMISSIONS.PURCHASING_MANAGE);
        const requesterId = order.purchaseRequest.requester?.user?.id;
        if (requesterId) recipients.push(requesterId);
        await notify(tx, req.user!.companyId, req.user!.id, recipients, 'تم استلام أمر الشراء', 'تم تسجيل الاستلام الإداري لأمر الشراء.');
        await writeAuditRequired(tx as any, { companyId: req.user!.companyId, userId: req.user!.id, action: 'purchasing.order.receive', details: { orderId: order.id, requestId: order.purchaseRequestId, status: after.fullyReceived ? 'received' : 'partially_received', ...(receipt ? { receiptId: receipt.receiptId, lineCount: receipt.lineCount } : {}) } });
        return updated;
      });
      return res.json(orderShape(result));
    } catch (error) { return sendError(res, error); }
  });

  app.post('/api/purchasing/orders/:id/cancel', requireAuth, checkAnyPermission(PERMISSIONS.PURCHASING_MANAGE), async (req: PurchasingRequest, res) => {
    try {
      const body = parse(cancelSchema, req.body);
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId} FOR UPDATE`;
        const order = await tx.purchaseOrder.findFirst({ where: { id: req.params.id, companyId: req.user!.companyId }, include: orderInclude });
        if (!order) throw new PurchasingError(404, 'PURCHASE_ORDER_NOT_FOUND', 'أمر الشراء غير موجود');
        if (!['draft', 'issued'].includes(order.status)) throw new PurchasingError(409, 'ORDER_CANCEL_INVALID', 'لا يمكن إلغاء أمر الشراء في حالته الحالية');
        const updated = await tx.purchaseOrder.update({ where: { id: order.id }, data: { status: 'cancelled', cancelledByUserId: req.user!.id, cancelledAt: new Date(), cancellationReason: body.cancellationReason }, include: orderInclude });
        const other = await tx.purchaseOrder.findFirst({ where: { companyId: req.user!.companyId, purchaseRequestId: order.purchaseRequestId, id: { not: order.id }, status: { not: 'cancelled' } }, select: { id: true } });
        if (!other) await tx.purchaseRequest.update({ where: { id: order.purchaseRequestId }, data: { status: 'approved' } });
        const requesterId = order.purchaseRequest.requester?.user?.id;
        if (requesterId) await notify(tx, req.user!.companyId, req.user!.id, [requesterId], 'تم إلغاء أمر الشراء', 'تم إلغاء أمر الشراء المرتبط بطلبك.');
        await writeAuditRequired(tx as any, { companyId: req.user!.companyId, userId: req.user!.id, action: 'purchasing.order.cancel', details: { orderId: order.id, requestId: order.purchaseRequestId, status: 'cancelled' } });
        return updated;
      });
      return res.json(orderShape(result));
    } catch (error) { return sendError(res, error); }
  });

  app.get('/api/purchasing/report', requireAuth, checkAnyPermission(PERMISSIONS.PURCHASING_REPORT), async (req: PurchasingRequest, res) => {
    try {
      const payload = await buildPurchasingReport(prisma, req.user!, req.query);
      await writeAuditRequired(prisma as any, {
        companyId: req.user!.companyId,
        userId: req.user!.id,
        action: 'purchasing.report.read',
        details: {
          requestCount: payload.requests.length,
          orderCount: payload.orders.length,
        },
      });
      return res.json(payload);
    } catch (error) { return sendError(res, error); }
  });
}
