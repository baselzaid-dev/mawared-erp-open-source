import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { sanitizeAuditDetails, writeAuditRequired } from './audit';
import { buildPayrollReport } from './payroll';
import { buildPurchasingReport } from './purchasing';
import { buildTrainingReport } from './training';
import { loadScopedTasks } from './tasks';
import { PERMISSIONS } from './permissions';
import { loadManagedDepartmentIds, loadPrimaryOwnerUserId } from './authorization';
import {
  getRegisteredReport,
  listAccessibleRegisteredReports,
  listRegisteredReports,
  REGISTERED_REPORT_EXPORT_ROW_CAP,
  type RegisteredReportDefinition,
  type RegisteredReportResult,
} from './reportRegistry';

export const REPORT_TYPES = [
  'overview',
  'attendance',
  'leaves',
  'tasks',
  'payroll',
  'purchasing',
  'training',
  'audit',
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

export interface ReportUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface ReportRequest extends Request {
  user?: ReportUser;
}

interface ReportRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  exportLimiter?: RequestHandler;
}

export interface ReportDetail {
  type: Exclude<ReportType, 'overview'>;
  generatedAt: string;
  range: { from: string; to: string } | null;
  scope: { kind: 'company' | 'department'; departmentId: string | null };
  summary: Record<string, string | number | boolean | null>;
  rows: Array<Record<string, unknown>>;
  pagination: { page: number; pageSize: number; total: number };
  warnings: string[];
  protectedRowsHidden?: boolean;
  protectedRowCount?: number;
}

interface DepartmentScope {
  kind: 'company' | 'department';
  departmentIds: string[] | null;
  selectedDepartmentId: string | null;
}

class ReportError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'يجب إدخال التاريخ بصيغة yyyy-MM-dd').refine(
  (value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  },
  'التاريخ غير صالح'
);

const rangeFields = {
  from: isoDate.optional(),
  to: isoDate.optional(),
};

const pageFields = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

const refineRange = (
  value: { from?: string; to?: string },
  ctx: z.RefinementCtx,
  maximumDays = 366
): void => {
  if (!!value.from !== !!value.to) {
    ctx.addIssue({
      code: 'custom',
      path: [value.from ? 'to' : 'from'],
      message: 'يجب تحديد تاريخي البداية والنهاية معاً',
    });
    return;
  }
  if (!value.from || !value.to) return;
  if (value.from > value.to) {
    ctx.addIssue({
      code: 'custom',
      path: ['from'],
      message: 'تاريخ البداية يجب ألا يكون بعد تاريخ النهاية',
    });
    return;
  }
  const days = Math.floor(
    (Date.parse(`${value.to}T00:00:00.000Z`) - Date.parse(`${value.from}T00:00:00.000Z`)) /
      86_400_000
  ) + 1;
  if (days > maximumDays) {
    ctx.addIssue({
      code: 'custom',
      path: ['to'],
      message: `نطاق التاريخ يجب ألا يتجاوز ${maximumDays} يوماً`,
    });
  }
};

const attendanceQuerySchema = z.strictObject({
  ...rangeFields,
  ...pageFields,
  departmentId: z.string().uuid('معرّف القسم غير صالح').optional(),
  status: z.enum(['present', 'late', 'absent']).optional(),
}).superRefine((value, ctx) => refineRange(value, ctx));

const leavesQuerySchema = z.strictObject({
  ...rangeFields,
  ...pageFields,
  departmentId: z.string().uuid('معرّف القسم غير صالح').optional(),
  employeeId: z.string().uuid('معرّف الموظف غير صالح').optional(),
  status: z.enum(['pending_hr', 'pending_admin', 'approved', 'rejected', 'cancelled']).optional(),
  leaveType: z.string().trim().min(1).max(50).optional(),
}).superRefine((value, ctx) => refineRange(value, ctx));

const tasksQuerySchema = z.strictObject({
  ...rangeFields,
  ...pageFields,
  departmentId: z.string().uuid('معرّف القسم غير صالح').optional(),
  employeeId: z.string().uuid('معرّف الموظف غير صالح').optional(),
  status: z.enum([
    'active',
    'completed',
    'cancelled',
    'assigned',
    'in_progress',
    'submitted',
    'accepted',
    'returned',
  ]).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
}).superRefine((value, ctx) => refineRange(value, ctx));

const payrollQuerySchema = z.strictObject({
  ...pageFields,
  periodId: z.string().uuid('معرّف فترة الرواتب غير صالح').optional(),
});

const purchasingQuerySchema = z.strictObject({
  ...rangeFields,
  ...pageFields,
  requestStatus: z.string().trim().max(40).optional(),
  orderStatus: z.string().trim().max(40).optional(),
  vendorId: z.string().uuid('معرّف المورد غير صالح').optional(),
  departmentId: z.string().uuid('معرّف القسم غير صالح').optional(),
}).superRefine((value, ctx) => refineRange(value, ctx));

const trainingQuerySchema = z.strictObject({
  ...rangeFields,
  ...pageFields,
  courseStatus: z.enum(['draft', 'published', 'completed', 'cancelled', 'archived']).optional(),
  assignmentStatus: z.enum(['assigned', 'in_progress', 'submitted', 'completed', 'returned', 'cancelled']).optional(),
  category: z.string().trim().max(120).optional(),
  departmentId: z.string().uuid('معرّف القسم غير صالح').optional(),
}).superRefine((value, ctx) => refineRange(value, ctx));

const overviewQuerySchema = z.strictObject({
  ...rangeFields,
  departmentId: z.string().uuid('معرّف القسم غير صالح').optional(),
}).superRefine((value, ctx) => refineRange(value, ctx));

const auditQuerySchema = z.strictObject({
  ...rangeFields,
  ...pageFields,
  actionPrefix: z.string().trim().min(1).max(120).optional(),
  userId: z.string().uuid('معرّف المستخدم غير صالح').optional(),
}).superRefine((value, ctx) => refineRange(value, ctx, 90));

const exportFilterValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
const BUILT_IN_EXPORT_TYPES = [
  'attendance',
  'leaves',
  'tasks',
  'payroll',
  'purchasing',
  'training',
  'audit',
] as const;
const exportSchema = z.strictObject({
  // Built-in types plus any key published through the Wave 2 report
  // registration contract. Unknown keys are rejected here, before any query.
  reportType: z
    .string()
    .max(64)
    .refine(
      (value) =>
        (BUILT_IN_EXPORT_TYPES as readonly string[]).includes(value) ||
        Boolean(getRegisteredReport(value)),
      'نوع التقرير غير مدعوم',
    ),
  filters: z.record(z.string().max(80), exportFilterValue).default({}),
  format: z.literal('csv'),
});

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ReportError(
      400,
      'REPORT_VALIDATION_ERROR',
      result.error.issues[0]?.message ?? 'معايير التقرير غير صالحة',
      result.error.flatten()
    );
  }
  return result.data;
};

const has = (user: ReportUser, permission: string): boolean =>
  user.permissions.includes(PERMISSIONS.ADMIN_FULL) || user.permissions.includes(permission);

const isAdmin = (user: ReportUser): boolean => user.permissions.includes(PERMISSIONS.ADMIN_FULL);

export function canAccessReport(user: ReportUser, type: ReportType): boolean {
  switch (type) {
    case 'overview':
      return isAdmin(user) || user.permissions.some((permission) =>
        permission === PERMISSIONS.REPORTS_VIEW || permission === PERMISSIONS.REPORTS_FINANCE
      );
    case 'attendance':
      return has(user, PERMISSIONS.ATTENDANCE_VIEW) || has(user, PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT);
    case 'leaves':
      return has(user, PERMISSIONS.LEAVES_VIEW);
    case 'tasks':
      return has(user, PERMISSIONS.TASKS_VIEW_COMPANY) || has(user, PERMISSIONS.TASKS_VIEW_DEPARTMENT);
    case 'payroll':
      return has(user, PERMISSIONS.PAYROLL_REPORT);
    case 'purchasing':
      return has(user, PERMISSIONS.PURCHASING_REPORT);
    case 'training':
      return has(user, PERMISSIONS.TRAINING_REPORT) && (
        has(user, PERMISSIONS.TRAINING_VIEW_COMPANY) ||
        has(user, PERMISSIONS.TRAINING_VIEW_DEPARTMENT)
      );
    case 'audit':
      return isAdmin(user);
  }
}

const mayExport = (user: ReportUser): boolean =>
  isAdmin(user) || user.permissions.includes(PERMISSIONS.REPORTS_EXPORT);

const scopesFor = (user: ReportUser, type: ReportType): Array<'company' | 'department'> => {
  if (['overview', 'leaves', 'payroll', 'purchasing', 'audit'].includes(type)) return ['company'];
  const companyPermission = type === 'attendance'
    ? PERMISSIONS.ATTENDANCE_VIEW
    : type === 'tasks'
      ? PERMISSIONS.TASKS_VIEW_COMPANY
      : PERMISSIONS.TRAINING_VIEW_COMPANY;
  return has(user, companyPermission) ? ['company', 'department'] : ['department'];
};

const catalogMetadata: Record<ReportType, {
  title: string;
  description: string;
  filters: string[];
  financial: boolean;
  maximumRangeDays: number;
}> = {
  overview: {
    title: 'نظرة عامة',
    description: 'ملخص الأقسام المتاحة حسب صلاحياتك',
    filters: ['from', 'to', 'departmentId'],
    financial: false,
    maximumRangeDays: 366,
  },
  attendance: {
    title: 'الحضور والانصراف',
    description: 'ملخص وسجلات الحضور ضمن نطاقك',
    filters: ['from', 'to', 'departmentId', 'status'],
    financial: false,
    maximumRangeDays: 366,
  },
  leaves: {
    title: 'الإجازات',
    description: 'حالات الإجازات دون الأسباب والملاحظات الخاصة',
    filters: ['from', 'to', 'departmentId', 'employeeId', 'status', 'leaveType'],
    financial: false,
    maximumRangeDays: 366,
  },
  tasks: {
    title: 'المهام',
    description: 'حالات المهام وأعداد الإسناد دون ملاحظات الإنجاز',
    filters: ['from', 'to', 'departmentId', 'employeeId', 'status', 'priority'],
    financial: false,
    maximumRangeDays: 366,
  },
  payroll: {
    title: 'الرواتب',
    description: 'الفترات المعتمدة والمدفوعة مع حماية راتب المالك',
    filters: ['periodId'],
    financial: true,
    maximumRangeDays: 366,
  },
  purchasing: {
    title: 'المشتريات',
    description: 'طلبات وأوامر الشراء من اللقطات المحفوظة',
    filters: ['from', 'to', 'departmentId', 'vendorId', 'requestStatus', 'orderStatus'],
    financial: true,
    maximumRangeDays: 366,
  },
  training: {
    title: 'التدريب والتطوير',
    description: 'مؤشرات الدورات والتكليفات ضمن النطاق المصرح',
    filters: ['from', 'to', 'departmentId', 'courseStatus', 'assignmentStatus', 'category'],
    financial: false,
    maximumRangeDays: 366,
  },
  audit: {
    title: 'سجل التدقيق',
    description: 'الأحداث الإدارية المنقحة من البيانات الخاصة',
    filters: ['from', 'to', 'actionPrefix', 'userId'],
    financial: false,
    maximumRangeDays: 90,
  },
};

export function buildReportCatalog(user: ReportUser): any[] {
  const builtIn = REPORT_TYPES.filter((type) => canAccessReport(user, type)).map((type) => ({
    type,
    title: catalogMetadata[type].title,
    description: catalogMetadata[type].description,
    availableScopes: scopesFor(user, type),
    supportedFilters: catalogMetadata[type].filters,
    exportAvailable: type !== 'overview' && mayExport(user),
    containsFinancialData: catalogMetadata[type].financial,
    maximumRangeDays: catalogMetadata[type].maximumRangeDays,
    source: 'built_in',
  }));
  // Reports published through the Wave 2 registration contract appear in the
  // same catalog shape, filtered by their own permission predicate.
  const registered = listAccessibleRegisteredReports(user).map((definition) => ({
    type: definition.key,
    title: definition.title,
    description: definition.description,
    availableScopes: definition.availableScopes,
    supportedFilters: definition.supportedFilters,
    exportAvailable: definition.exportable && mayExport(user),
    containsFinancialData: definition.containsFinancialData,
    maximumRangeDays: definition.maximumRangeDays,
    source: 'registered',
    module: definition.module,
  }));
  return [...builtIn, ...registered];
}

/**
 * Runs a report published through the registration contract.
 * `canAccess` is re-evaluated here on every request — a hidden catalog entry is
 * never treated as authorization.
 */
async function loadRegisteredReport(
  prisma: any,
  user: ReportUser,
  definition: RegisteredReportDefinition,
  raw: unknown,
  exportMode = false,
): Promise<RegisteredReportResult> {
  if (!definition.canAccess(user)) {
    throw new ReportError(403, 'REPORT_FORBIDDEN', 'لا تملك صلاحية عرض هذا التقرير');
  }
  return definition.load({
    prisma,
    user,
    filters: raw,
    exportMode,
    rowCap: REGISTERED_REPORT_EXPORT_ROW_CAP,
    assertRowLimit,
  });
}

const utcDate = (date: Date): string => date.toISOString().slice(0, 10);

const normalizedRange = (from?: string, to?: string): { from: string; to: string } => {
  if (from && to) return { from, to };
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 29 * 86_400_000);
  return { from: utcDate(start), to: utcDate(end) };
};

const timestamp = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

const rangeWhere = (range: { from: string; to: string }) => ({
  gte: new Date(`${range.from}T00:00:00.000Z`),
  lt: new Date(Date.parse(`${range.to}T00:00:00.000Z`) + 86_400_000),
});

const paginate = <T>(rows: T[], page: number, pageSize: number) => ({
  rows: rows.slice((page - 1) * pageSize, page * pageSize),
  pagination: { page, pageSize, total: rows.length },
});

const parseRolePermissions = (value: string | null | undefined): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
};

const isOwnerUser = (user: any, primaryOwnerUserId: string | null): boolean =>
  user?.id === primaryOwnerUserId ||
  parseRolePermissions(user?.role?.permissions).includes(PERMISSIONS.ADMIN_FULL);

const mayViewOwnerData = (user: ReportUser): boolean =>
  isAdmin(user) || user.permissions.includes(PERMISSIONS.HR_VIEW);

const assertRowLimit = (count: number): void => {
  if (count > 5000) {
    throw new ReportError(
      400,
      'REPORT_ROW_LIMIT_EXCEEDED',
      'يتجاوز التقرير 5000 صف. يرجى تضييق نطاق البحث.'
    );
  }
};

const resolveDepartmentScope = async (
  prisma: any,
  user: ReportUser,
  companyPermission: string,
  departmentPermission: string,
  requestedDepartmentId?: string
): Promise<DepartmentScope> => {
  if (has(user, companyPermission)) {
    if (requestedDepartmentId) {
      const department = await prisma.department.findFirst({
        where: { id: requestedDepartmentId, companyId: user.companyId },
        select: { id: true },
      });
      if (!department) {
        throw new ReportError(404, 'REPORT_DEPARTMENT_NOT_FOUND', 'القسم غير موجود');
      }
    }
    return {
      kind: requestedDepartmentId ? 'department' : 'company',
      departmentIds: requestedDepartmentId ? [requestedDepartmentId] : null,
      selectedDepartmentId: requestedDepartmentId ?? null,
    };
  }
  if (!user.permissions.includes(departmentPermission)) {
    throw new ReportError(403, 'REPORT_FORBIDDEN', 'لا تملك صلاحية عرض هذا التقرير');
  }
  const managedIds = await loadManagedDepartmentIds(prisma, {
    companyId: user.companyId,
    userId: user.id,
  });
  if (requestedDepartmentId && !managedIds.includes(requestedDepartmentId)) {
    throw new ReportError(403, 'REPORT_DEPARTMENT_FORBIDDEN', 'القسم المحدد خارج نطاق إدارتك');
  }
  return {
    kind: 'department',
    departmentIds: requestedDepartmentId ? [requestedDepartmentId] : managedIds,
    selectedDepartmentId: requestedDepartmentId ?? null,
  };
};

const validateCompanyDepartment = async (
  prisma: any,
  user: ReportUser,
  departmentId?: string
): Promise<void> => {
  if (!departmentId) return;
  const department = await prisma.department.findFirst({
    where: { id: departmentId, companyId: user.companyId },
    select: { id: true },
  });
  if (!department) {
    throw new ReportError(404, 'REPORT_DEPARTMENT_NOT_FOUND', 'القسم غير موجود');
  }
};

export async function attendanceReport(
  prisma: any,
  user: ReportUser,
  raw: unknown,
  exportMode = false,
  options?: { allowOverflowProbe?: boolean },
): Promise<ReportDetail> {
  const query = parse(attendanceQuerySchema, raw);
  const range = normalizedRange(query.from, query.to);
  const scope = await resolveDepartmentScope(
    prisma,
    user,
    PERMISSIONS.ATTENDANCE_VIEW,
    PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT,
    query.departmentId
  );
  const rawRows = await prisma.attendance.findMany({
    where: {
      companyId: user.companyId,
      date: rangeWhere(range),
      ...(query.status ? { status: query.status } : {}),
      ...(scope.departmentIds !== null
        ? { employee: { departmentId: { in: scope.departmentIds } } }
        : {}),
    },
    select: {
      id: true,
      employeeId: true,
      date: true,
      clockIn: true,
      clockOut: true,
      status: true,
      employee: {
        select: {
          employeeNum: true,
          departmentId: true,
          department: { select: { name: true } },
          user: { select: { id: true, name: true, role: { select: { permissions: true } } } },
        },
      },
    },
    orderBy: [{ date: 'desc' }, { employeeId: 'asc' }],
    take: 5001,
  });
  if (!options?.allowOverflowProbe && rawRows.length > 5000) assertRowLimit(rawRows.length);
  const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, user.companyId);
  const visible = rawRows.filter(
    (row: any) => mayViewOwnerData(user) || !isOwnerUser(row.employee?.user, primaryOwnerUserId),
  );
  const rows: Array<Record<string, unknown>> = visible.map((row: any) => ({
    id: row.id,
    employeeId: row.employeeId,
    employeeNum: row.employee?.employeeNum ?? '',
    employeeName: row.employee?.user?.name ?? 'موظف',
    departmentId: row.employee?.departmentId ?? null,
    departmentName: row.employee?.department?.name ?? null,
    date: utcDate(new Date(row.date)),
    clockIn: timestamp(row.clockIn),
    clockOut: timestamp(row.clockOut),
    status: row.status,
  }));
  const page = paginate(rows, exportMode ? 1 : query.page, exportMode ? 5000 : query.pageSize);
  return {
    type: 'attendance',
    generatedAt: new Date().toISOString(),
    range,
    scope: { kind: scope.kind, departmentId: scope.selectedDepartmentId },
    summary: {
      recordCount: rows.length,
      presentCount: rows.filter((row) => row.status === 'present').length,
      lateCount: rows.filter((row) => row.status === 'late').length,
      absentCount: rows.filter((row) => row.status === 'absent').length,
    },
    rows: page.rows,
    pagination: page.pagination,
    warnings: ['تعتمد حدود يوم العمل حالياً على التوقيت العالمي UTC.'],
  };
}

export async function leavesReport(
  prisma: any,
  user: ReportUser,
  raw: unknown,
  exportMode = false,
  options?: { allowOverflowProbe?: boolean },
): Promise<ReportDetail> {
  const query = parse(leavesQuerySchema, raw);
  const range = normalizedRange(query.from, query.to);
  await validateCompanyDepartment(prisma, user, query.departmentId);
  if (query.employeeId) {
    const employee = await prisma.employee.findFirst({
      where: { id: query.employeeId, companyId: user.companyId },
      select: { id: true },
    });
    if (!employee) throw new ReportError(404, 'REPORT_EMPLOYEE_NOT_FOUND', 'الموظف غير موجود');
  }
  const rawRows = await prisma.leaveRequest.findMany({
    where: {
      companyId: user.companyId,
      startDate: { lte: new Date(`${range.to}T23:59:59.999Z`) },
      endDate: { gte: new Date(`${range.from}T00:00:00.000Z`) },
      ...(query.departmentId ? { employee: { departmentId: query.departmentId } } : {}),
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.leaveType ? { leaveType: query.leaveType } : {}),
    },
    select: {
      id: true,
      employeeId: true,
      leaveType: true,
      startDate: true,
      endDate: true,
      totalDays: true,
      status: true,
      createdAt: true,
      employee: {
        select: {
          employeeNum: true,
          departmentId: true,
          department: { select: { name: true } },
          user: { select: { id: true, name: true, role: { select: { permissions: true } } } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 5001,
  });
  if (!options?.allowOverflowProbe && rawRows.length > 5000) assertRowLimit(rawRows.length);
  const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, user.companyId);
  const visible = rawRows.filter(
    (row: any) => mayViewOwnerData(user) || !isOwnerUser(row.employee?.user, primaryOwnerUserId),
  );
  const rows: Array<Record<string, unknown>> = visible.map((row: any) => ({
    id: row.id,
    employeeId: row.employeeId,
    employeeNum: row.employee?.employeeNum ?? '',
    employeeName: row.employee?.user?.name ?? 'موظف',
    departmentId: row.employee?.departmentId ?? null,
    departmentName: row.employee?.department?.name ?? null,
    leaveType: row.leaveType,
    startDate: utcDate(new Date(row.startDate)),
    endDate: utcDate(new Date(row.endDate)),
    totalDays: row.totalDays,
    status: row.status,
    createdAt: timestamp(row.createdAt),
  }));
  const page = paginate(rows, exportMode ? 1 : query.page, exportMode ? 5000 : query.pageSize);
  return {
    type: 'leaves',
    generatedAt: new Date().toISOString(),
    range,
    scope: { kind: query.departmentId ? 'department' : 'company', departmentId: query.departmentId ?? null },
    summary: {
      requestCount: rows.length,
      pendingHrCount: rows.filter((row) => row.status === 'pending_hr').length,
      pendingAdminCount: rows.filter((row) => row.status === 'pending_admin').length,
      approvedCount: rows.filter((row) => row.status === 'approved').length,
      rejectedCount: rows.filter((row) => row.status === 'rejected').length,
      cancelledCount: rows.filter((row) => row.status === 'cancelled').length,
      totalDays: rows.reduce((sum, row) => sum + Number(row.totalDays || 0), 0),
    },
    rows: page.rows,
    pagination: page.pagination,
    warnings: [],
  };
}

async function tasksReport(
  prisma: any,
  user: ReportUser,
  raw: unknown,
  exportMode = false
): Promise<ReportDetail> {
  const query = parse(tasksQuerySchema, raw);
  const range = normalizedRange(query.from, query.to);
  const scope = await resolveDepartmentScope(
    prisma,
    user,
    PERMISSIONS.TASKS_VIEW_COMPANY,
    PERMISSIONS.TASKS_VIEW_DEPARTMENT,
    query.departmentId
  );
  const tasks = await loadScopedTasks(prisma, user, {
    scope: has(user, PERMISSIONS.TASKS_VIEW_COMPANY) ? 'company' : 'department',
    status: query.status,
    priority: query.priority,
    from: range.from,
    to: range.to,
    employeeId: query.employeeId,
  });
  const rows = tasks.flatMap((task: any) => {
    const assignments = (task.assignments ?? []).filter((assignment: any) =>
      scope.departmentIds === null || scope.departmentIds.includes(assignment.employee?.departmentId)
    );
    if (assignments.length === 0) return [];
    const count = (status: string) => assignments.filter((row: any) => row.status === status).length;
    return [{
      id: task.id,
      title: task.title,
      priority: task.priority,
      dueDate: task.dueDate ?? null,
      status: task.status,
      assignmentCount: assignments.length,
      assignedCount: count('assigned'),
      inProgressCount: count('in_progress'),
      submittedCount: count('submitted'),
      acceptedCount: count('accepted'),
      returnedCount: count('returned'),
      createdAt: task.createdAt,
    }];
  });
  assertRowLimit(rows.length);
  const page = paginate(rows, exportMode ? 1 : query.page, exportMode ? 5000 : query.pageSize);
  return {
    type: 'tasks',
    generatedAt: new Date().toISOString(),
    range,
    scope: { kind: scope.kind, departmentId: scope.selectedDepartmentId },
    summary: {
      taskCount: rows.length,
      activeCount: rows.filter((row) => row.status === 'active').length,
      completedCount: rows.filter((row) => row.status === 'completed').length,
      cancelledCount: rows.filter((row) => row.status === 'cancelled').length,
      assignmentCount: rows.reduce((sum, row) => sum + Number(row.assignmentCount), 0),
      submittedCount: rows.reduce((sum, row) => sum + Number(row.submittedCount), 0),
      acceptedCount: rows.reduce((sum, row) => sum + Number(row.acceptedCount), 0),
    },
    rows: page.rows,
    pagination: page.pagination,
    warnings: [],
  };
}

async function payrollReport(
  prisma: any,
  user: ReportUser,
  raw: unknown,
  exportMode = false
): Promise<ReportDetail> {
  const query = parse(payrollQuerySchema, raw);
  const source = await buildPayrollReport(prisma, user, query.periodId);
  assertRowLimit(source.rows.length);
  const safeRows = source.rows as Array<Record<string, unknown>>;
  const page = paginate(
    safeRows,
    exportMode ? 1 : query.page,
    exportMode ? 5000 : query.pageSize
  );
  return {
    type: 'payroll',
    generatedAt: new Date().toISOString(),
    range: null,
    scope: { kind: 'company', departmentId: null },
    summary: {
      periodId: source.period.id,
      month: source.period.month,
      year: source.period.year,
      status: source.period.status,
      visibleEmployeeCount: source.visibleSummary?.visibleEmployeeCount ?? 0,
      visibleGross: source.visibleSummary?.visibleGross ?? null,
      visibleDeductions: source.visibleSummary?.visibleDeductions ?? null,
      visibleNet: source.visibleSummary?.visibleNet ?? null,
      currency: source.visibleSummary?.currency ?? 'SAR',
    },
    rows: page.rows,
    pagination: page.pagination,
    warnings: source.protectedRowsHidden
      ? ['توجد صفوف رواتب محمية غير ظاهرة في التقرير والإجماليات.']
      : [],
    protectedRowsHidden: Boolean(source.protectedRowsHidden),
    protectedRowCount: Number(source.protectedRowCount ?? 0),
  };
}

async function purchasingReport(
  prisma: any,
  user: ReportUser,
  raw: unknown,
  exportMode = false
): Promise<ReportDetail> {
  const query = parse(purchasingQuerySchema, raw);
  const range = normalizedRange(query.from, query.to);
  await validateCompanyDepartment(prisma, user, query.departmentId);
  const source = await buildPurchasingReport(prisma, user, {
    from: range.from,
    to: range.to,
    requestStatus: query.requestStatus,
    orderStatus: query.orderStatus,
    vendorId: query.vendorId,
    departmentId: query.departmentId,
  }, 5001);
  if (source.requests.length > 5000 || source.orders.length > 5000) {
    assertRowLimit(5001);
  }
  const rows = [
    ...source.requests.map((row: any) => ({
      recordType: 'request',
      id: row.id,
      referenceNumber: row.requestNumber,
      titleOrVendor: row.title,
      requesterName: row.requesterNameSnapshot,
      departmentName: row.departmentNameSnapshot,
      status: row.status,
      amount: row.totalEstimated,
      currency: 'SAR',
      createdAt: row.createdAt,
    })),
    ...source.orders.map((row: any) => ({
      recordType: 'order',
      id: row.id,
      referenceNumber: row.orderNumber,
      titleOrVendor: row.vendorNameSnapshot,
      requestNumber: row.requestNumber,
      departmentName: null,
      status: row.status,
      amount: row.status === 'cancelled' ? null : row.totalAmount,
      currency: 'SAR',
      createdAt: row.createdAt,
    })),
  ];
  assertRowLimit(rows.length);
  const page = paginate(rows, exportMode ? 1 : query.page, exportMode ? 5000 : query.pageSize);
  return {
    type: 'purchasing',
    generatedAt: new Date().toISOString(),
    range,
    scope: { kind: query.departmentId ? 'department' : 'company', departmentId: query.departmentId ?? null },
    summary: source.summary,
    rows: page.rows,
    pagination: page.pagination,
    warnings: [],
  };
}

async function trainingReport(
  prisma: any,
  user: ReportUser,
  raw: unknown,
  exportMode = false
): Promise<ReportDetail> {
  const query = parse(trainingQuerySchema, raw);
  const range = normalizedRange(query.from, query.to);
  const scope = await resolveDepartmentScope(
    prisma,
    user,
    PERMISSIONS.TRAINING_VIEW_COMPANY,
    PERMISSIONS.TRAINING_VIEW_DEPARTMENT,
    query.departmentId
  );
  const source = await buildTrainingReport(prisma, user, {
    scope: has(user, PERMISSIONS.TRAINING_VIEW_COMPANY) ? 'company' : 'department',
    from: range.from,
    to: range.to,
    courseStatus: query.courseStatus,
    assignmentStatus: query.assignmentStatus,
    category: query.category,
    departmentId: query.departmentId,
  });
  const rows: Array<Record<string, unknown>> = source.report.courses.map((course: any) => ({
    id: course.id,
    courseCode: course.courseCode,
    title: course.title,
    category: course.category,
    deliveryMode: course.deliveryMode,
    startDate: course.startDate,
    endDate: course.endDate,
    status: course.status,
    assignmentCount: course.assignmentSummary?.total ?? 0,
    assignedCount: course.assignmentSummary?.assigned ?? 0,
    inProgressCount: course.assignmentSummary?.in_progress ?? 0,
    submittedCount: course.assignmentSummary?.submitted ?? 0,
    completedCount: course.assignmentSummary?.completed ?? 0,
    returnedCount: course.assignmentSummary?.returned ?? 0,
    cancelledCount: course.assignmentSummary?.cancelled ?? 0,
  }));
  assertRowLimit(rows.length);
  const page = paginate(rows, exportMode ? 1 : query.page, exportMode ? 5000 : query.pageSize);
  return {
    type: 'training',
    generatedAt: new Date().toISOString(),
    range,
    scope: { kind: scope.kind, departmentId: scope.selectedDepartmentId },
    summary: source.report.summary,
    rows: page.rows,
    pagination: page.pagination,
    warnings: [],
  };
}

async function auditReport(
  prisma: any,
  user: ReportUser,
  raw: unknown,
  exportMode = false
): Promise<ReportDetail> {
  const query = parse(auditQuerySchema, raw);
  const range = normalizedRange(query.from, query.to);
  const where = {
    companyId: user.companyId,
    createdAt: rangeWhere(range),
    ...(query.actionPrefix ? { action: { startsWith: query.actionPrefix } } : {}),
    ...(query.userId ? { userId: query.userId } : {}),
  };
  const pageSize = exportMode ? 5000 : query.pageSize;
  const page = exportMode ? 1 : query.page;
  const [rawRows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      select: {
        id: true,
        action: true,
        userId: true,
        details: true,
        createdAt: true,
        user: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: exportMode ? 5001 : pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);
  if (exportMode && (rawRows.length > 5000 || total > 5000)) assertRowLimit(5001);
  const rows = rawRows.slice(0, pageSize).map((row: any) => ({
    id: row.id,
    action: row.action,
    actorUserId: row.userId,
    actorName: row.user?.name ?? 'مستخدم',
    createdAt: timestamp(row.createdAt),
    details: sanitizeAuditDetails(row.details),
  }));
  return {
    type: 'audit',
    generatedAt: new Date().toISOString(),
    range,
    scope: { kind: 'company', departmentId: null },
    summary: { eventCount: total },
    rows,
    pagination: { page, pageSize, total },
    warnings: [],
  };
}

async function loadReport(
  prisma: any,
  user: ReportUser,
  type: Exclude<ReportType, 'overview'>,
  raw: unknown,
  exportMode = false
): Promise<ReportDetail> {
  if (!canAccessReport(user, type)) {
    throw new ReportError(403, 'REPORT_FORBIDDEN', 'لا تملك صلاحية عرض هذا التقرير');
  }
  switch (type) {
    case 'attendance': return attendanceReport(prisma, user, raw, exportMode);
    case 'leaves': return leavesReport(prisma, user, raw, exportMode);
    case 'tasks': return tasksReport(prisma, user, raw, exportMode);
    case 'payroll': return payrollReport(prisma, user, raw, exportMode);
    case 'purchasing': return purchasingReport(prisma, user, raw, exportMode);
    case 'training': return trainingReport(prisma, user, raw, exportMode);
    case 'audit': return auditReport(prisma, user, raw, exportMode);
  }
}

const moduleError = (error: unknown): ReportError | null => {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { status?: unknown; errorCode?: unknown; message?: unknown; details?: unknown };
  if (typeof candidate.status !== 'number' || typeof candidate.errorCode !== 'string') return null;
  return new ReportError(
    candidate.status,
    candidate.errorCode,
    typeof candidate.message === 'string' ? candidate.message : 'تعذر تحميل التقرير',
    candidate.details
  );
};

const sendError = (res: Response, error: unknown): Response => {
  const known = error instanceof ReportError ? error : moduleError(error);
  if (known) {
    return res.status(known.status).json({
      error: known.errorCode,
      message: known.message,
      code: known.status,
      ...(known.details ? { details: known.details } : {}),
    });
  }
  return res.status(500).json({
    error: 'REPORT_OPERATION_FAILED',
    message: 'تعذر تحميل التقرير حالياً',
    code: 500,
  });
};

const isPayrollPeriodNotFound = (error: unknown): boolean => {
  const known = error instanceof ReportError ? error : moduleError(error);
  return known?.errorCode === 'PAYROLL_PERIOD_NOT_FOUND';
};

async function buildOverview(prisma: any, user: ReportUser, raw: unknown): Promise<any> {
  if (!canAccessReport(user, 'overview')) {
    throw new ReportError(403, 'REPORT_FORBIDDEN', 'لا تملك صلاحية عرض النظرة العامة');
  }
  const query = parse(overviewQuerySchema, raw);
  const range = normalizedRange(query.from, query.to);
  await validateCompanyDepartment(prisma, user, query.departmentId);
  const sections: Record<string, unknown> = {};
  const unavailableSections: string[] = [];
  const unavailableSectionCodes: Record<string, string> = {};
  const addSection = async (name: string, loader: () => Promise<Record<string, unknown>>) => {
    try {
      sections[name] = await loader();
    } catch (error) {
      // Missing approved/paid payroll is an empty successful section, not a partial-load failure.
      if (name === 'payroll' && isPayrollPeriodNotFound(error)) {
        sections[name] = { title: 'الرواتب', metrics: {} };
        return;
      }
      const known = error instanceof ReportError ? error : moduleError(error);
      unavailableSections.push(name);
      if (known) unavailableSectionCodes[name] = known.errorCode;
    }
  };

  if (has(user, PERMISSIONS.EMPLOYEES_VIEW)) {
    await addSection('employees', async () => {
      const baseWhere = {
        companyId: user.companyId,
        ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      };
      const [totalEmployeeCount, activeEmployeeCount] = await Promise.all([
        prisma.employee.count({ where: baseWhere }),
        prisma.employee.count({ where: { ...baseWhere, status: 'active' } }),
      ]);
      return {
        title: 'الموظفون',
        metrics: { totalEmployeeCount, activeEmployeeCount },
      };
    });
  }

  const detailFilters = { from: range.from, to: range.to, departmentId: query.departmentId, page: 1, pageSize: 1 };
  const sectionLoaders: Array<[Exclude<ReportType, 'overview' | 'audit'>, string]> = [
    ['attendance', 'الحضور والانصراف'],
    ['leaves', 'الإجازات'],
    ['tasks', 'المهام'],
    ['payroll', 'الرواتب'],
    ['purchasing', 'المشتريات'],
    ['training', 'التدريب والتطوير'],
  ];
  for (const [type, title] of sectionLoaders) {
    if (!canAccessReport(user, type)) continue;
    await addSection(type, async () => {
      const filters = type === 'payroll'
        ? { page: 1, pageSize: 1 }
        : type === 'leaves' || type === 'purchasing'
          ? detailFilters
          : detailFilters;
      const detail = await loadReport(prisma, user, type, filters);
      return {
        title,
        metrics: detail.summary,
        ...(detail.protectedRowsHidden ? { protectedRowsHidden: true } : {}),
      };
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    dateRange: range,
    scope: { kind: query.departmentId ? 'department' : 'company', departmentId: query.departmentId ?? null },
    sections,
    unavailableSections,
    unavailableSectionCodes,
    warnings: unavailableSections.length > 0
      ? ['تعذر تحميل بعض الأقسام المصرح بها. حاول التحديث لاحقاً.']
      : [],
  };
}

interface CsvColumn {
  key: string;
  title: string;
  value?: (row: Record<string, unknown>) => unknown;
}

const csvColumns: Record<Exclude<ReportType, 'overview'>, CsvColumn[]> = {
  attendance: [
    { key: 'employeeNum', title: 'الرقم الوظيفي' },
    { key: 'employeeName', title: 'اسم الموظف' },
    { key: 'departmentName', title: 'القسم' },
    { key: 'date', title: 'التاريخ' },
    { key: 'status', title: 'الحالة' },
    { key: 'clockIn', title: 'وقت الحضور' },
    { key: 'clockOut', title: 'وقت الانصراف' },
  ],
  leaves: [
    { key: 'employeeNum', title: 'الرقم الوظيفي' },
    { key: 'employeeName', title: 'اسم الموظف' },
    { key: 'departmentName', title: 'القسم' },
    { key: 'leaveType', title: 'نوع الإجازة' },
    { key: 'startDate', title: 'تاريخ البداية' },
    { key: 'endDate', title: 'تاريخ النهاية' },
    { key: 'totalDays', title: 'عدد الأيام' },
    { key: 'status', title: 'الحالة' },
  ],
  tasks: [
    { key: 'title', title: 'المهمة' },
    { key: 'priority', title: 'الأولوية' },
    { key: 'dueDate', title: 'تاريخ الاستحقاق' },
    { key: 'status', title: 'حالة المهمة' },
    { key: 'assignmentCount', title: 'عدد الإسنادات' },
    { key: 'inProgressCount', title: 'قيد التنفيذ' },
    { key: 'submittedCount', title: 'مسلمة' },
    { key: 'acceptedCount', title: 'مقبولة' },
    { key: 'returnedCount', title: 'معادة' },
  ],
  payroll: [
    { key: 'employeeNum', title: 'الرقم الوظيفي' },
    { key: 'employeeName', title: 'اسم الموظف' },
    { key: 'departmentName', title: 'القسم' },
    { key: 'grossPay', title: 'الإجمالي' },
    { key: 'totalDeductions', title: 'الخصومات' },
    { key: 'netPay', title: 'الصافي' },
    { key: 'currency', title: 'العملة' },
    { key: 'status', title: 'الحالة' },
  ],
  purchasing: [
    { key: 'recordType', title: 'نوع السجل' },
    { key: 'referenceNumber', title: 'الرقم المرجعي' },
    { key: 'titleOrVendor', title: 'العنوان أو المورد' },
    { key: 'departmentName', title: 'القسم' },
    { key: 'status', title: 'الحالة' },
    { key: 'amount', title: 'المبلغ' },
    { key: 'currency', title: 'العملة' },
    { key: 'createdAt', title: 'تاريخ الإنشاء' },
  ],
  training: [
    { key: 'courseCode', title: 'رمز الدورة' },
    { key: 'title', title: 'الدورة' },
    { key: 'category', title: 'التصنيف' },
    { key: 'startDate', title: 'تاريخ البداية' },
    { key: 'endDate', title: 'تاريخ النهاية' },
    { key: 'status', title: 'الحالة' },
    { key: 'assignmentCount', title: 'عدد التكليفات' },
    { key: 'completedCount', title: 'المكتملة' },
  ],
  audit: [
    { key: 'id', title: 'معرّف الحدث' },
    { key: 'action', title: 'الإجراء' },
    { key: 'actorName', title: 'المنفذ' },
    { key: 'actorUserId', title: 'معرّف المستخدم' },
    { key: 'createdAt', title: 'وقت الحدث' },
    { key: 'details', title: 'تفاصيل منقحة', value: (row) => JSON.stringify(row.details ?? {}) },
  ],
};

export function neutralizeCsvCell(value: unknown): string {
  if (value == null) return '';
  const cleaned = String(value)
    .replace(/\0/g, '')
    .replace(/[\t\r\n]+/g, ' ')
    .trim();
  return /^[=+\-@]/.test(cleaned) ? `'${cleaned}` : cleaned;
}

const quoteCsv = (value: unknown): string => `"${neutralizeCsvCell(value).replace(/"/g, '""')}"`;

/**
 * Shared CSV writer. Registered reports go through the same neutralization and
 * quoting as the built-in ones so a new report can never bypass the
 * formula-injection protection by writing its own file.
 */
export function createCsvFromColumns(
  columns: readonly CsvColumn[],
  rows: Array<Record<string, unknown>>,
): string {
  const lines = [
    columns.map((column) => quoteCsv(column.title)).join(','),
    ...rows.map((row) => columns.map((column) =>
      quoteCsv(column.value ? column.value(row) : row[column.key])
    ).join(',')),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function createCsv(type: Exclude<ReportType, 'overview'>, rows: Array<Record<string, unknown>>): string {
  return createCsvFromColumns(csvColumns[type], rows);
}

const exportFilename = (type: string): string => {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `mawared_${type}_${stamp}.csv`;
};

export function registerReportRoutes({
  app,
  prisma,
  requireAuth,
  exportLimiter = (_req, _res, next) => next(),
}: ReportRouteDeps): void {
  app.get('/api/reports/catalog', requireAuth, (req: ReportRequest, res) => {
    return res.json(buildReportCatalog(req.user!));
  });

  app.get('/api/reports/overview', requireAuth, async (req: ReportRequest, res) => {
    try {
      return res.json(await buildOverview(prisma, req.user!, req.query));
    } catch (error) {
      return sendError(res, error);
    }
  });

  const detailTypes: Array<Exclude<ReportType, 'overview' | 'audit'>> = [
    'attendance',
    'leaves',
    'tasks',
    'payroll',
    'purchasing',
    'training',
  ];
  for (const type of detailTypes) {
    app.get(`/api/reports/${type}`, requireAuth, async (req: ReportRequest, res) => {
      try {
        return res.json(await loadReport(prisma, req.user!, type, req.query));
      } catch (error) {
        return sendError(res, error);
      }
    });
  }

  // Wave 2 registration contract: one detail route per registered report.
  // Registration happens at module import time, so every definition is present
  // before routes are wired.
  for (const definition of listRegisteredReports()) {
    app.get(`/api/reports/${definition.key}`, requireAuth, async (req: ReportRequest, res) => {
      try {
        return res.json(await loadRegisteredReport(prisma, req.user!, definition, req.query));
      } catch (error) {
        return sendError(res, error);
      }
    });
  }

  app.get('/api/audit-logs', requireAuth, async (req: ReportRequest, res) => {
    if (!isAdmin(req.user!)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'لا تملك صلاحية عرض سجل التدقيق',
        code: 403,
      });
    }
    try {
      const report = await auditReport(prisma, req.user!, req.query);
      return res.json({
        items: report.rows,
        page: report.pagination.page,
        pageSize: report.pagination.pageSize,
        total: report.pagination.total,
        range: report.range,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/reports/export', exportLimiter, requireAuth, async (req: ReportRequest, res) => {
    try {
      const body = parse(exportSchema, req.body);
      const registered = getRegisteredReport(body.reportType);
      const builtInType = registered
        ? null
        : (body.reportType as Exclude<ReportType, 'overview'>);
      const allowed = registered
        ? registered.exportable && registered.canAccess(req.user!)
        : canAccessReport(req.user!, builtInType!);
      if (!mayExport(req.user!) || !allowed) {
        throw new ReportError(
          403,
          'REPORT_EXPORT_FORBIDDEN',
          'لا تملك صلاحية تصدير هذا التقرير'
        );
      }
      const detail = registered
        ? await loadRegisteredReport(
            prisma,
            req.user!,
            registered,
            { ...body.filters, page: 1, pageSize: 100 },
            true,
          )
        : await loadReport(
            prisma,
            req.user!,
            builtInType!,
            { ...body.filters, page: 1, pageSize: 100 },
            true
          );
      if (detail.pagination.total > 5000) assertRowLimit(detail.pagination.total);
      const rows = detail.rows;
      const csv = registered
        ? createCsvFromColumns(registered.columns, rows)
        : createCsv(builtInType!, rows);
      const filename = exportFilename(body.reportType);
      await writeAuditRequired(prisma, {
        companyId: req.user!.companyId,
        userId: req.user!.id,
        action: 'report.export',
        details: {
          reportType: body.reportType,
          rowCount: rows.length,
          scope: detail.scope.kind,
          filterKeys: Object.keys(body.filters).sort(),
        },
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', Buffer.byteLength(csv, 'utf8').toString());
      return res.status(200).send(csv);
    } catch (error) {
      return sendError(res, error);
    }
  });
}
