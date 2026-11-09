import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { loadManagedDepartmentIds, loadPrimaryOwnerUserId } from './authorization';
import { buildPayrollReport } from './payroll';
import { buildPurchasingReport } from './purchasing';
import { buildTrainingReport } from './training';
import { PERMISSIONS } from './permissions';
import {
  attendanceReport,
  canAccessReport,
  leavesReport,
  type ReportUser,
} from './reports';

/**
 * Sprint 12J — server-owned built-in report template registry.
 *
 * Per ADR-007, the backend owns a versioned allowlist of templates. Clients
 * never send SQL, joins, or field lists — only a builtInKey/version plus
 * server-validated filters/scope. Attendance and leave sections call the
 * authoritative builders exported from reports.ts (no duplicated queries).
 */

export type TemplateModuleKey =
  | 'attendance'
  | 'leaves'
  | 'payroll'
  | 'purchasing'
  | 'training'
  | 'employees'
  | 'payments';

export type TemplateFormat = 'csv' | 'xlsx' | 'pdf';

export type TemplateSectionPolicy = 'require_all' | 'omit_unauthorized';

export interface BuiltInTemplateDefinition {
  builtInKey: string;
  version: number;
  kind: 'single' | 'composite';
  modules: readonly TemplateModuleKey[];
  title: string;
  description: string;
  requiredPermission: string;
  formats: readonly TemplateFormat[];
  maximumRangeDays: number;
  /**
   * require_all (default): hide/reject when any source permission is missing (ADR-007).
   * omit_unauthorized: executive templates only — list when ≥1 module is allowed; skip the rest.
   */
  sectionPolicy?: TemplateSectionPolicy;
  /** Executive templates keep per-module summaries and drop detail rows. */
  summaryOnly?: boolean;
}

export interface TemplateSection {
  module: TemplateModuleKey;
  title: string;
  summary: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  warnings: string[];
}

export interface CompiledTemplateDocument {
  builtInKey: string;
  templateVersion: number;
  generatedAt: string;
  scope: { kind: 'company' | 'department'; departmentId: string | null };
  sections: TemplateSection[];
  warnings: string[];
}

interface TemplateRequest extends Request {
  user?: ReportUser;
}

interface ReportTemplateRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
}

export class ReportTemplateError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const MODULE_TITLES: Record<TemplateModuleKey, string> = {
  attendance: 'الحضور والانصراف',
  leaves: 'الإجازات',
  payroll: 'الرواتب',
  purchasing: 'المشتريات',
  training: 'التدريب والتطوير',
  employees: 'الموظفون',
  payments: 'مدفوعات الرواتب',
};

/**
 * Server-owned allowlist. Adding a template requires a new entry here (and,
 * for composites, an explicit compiler branch below) — never a client field.
 * Tasks+Performance is intentionally absent: Performance does not exist yet.
 */
export const BUILT_IN_REPORT_TEMPLATES: readonly BuiltInTemplateDefinition[] = [
  {
    builtInKey: 'attendance',
    version: 1,
    kind: 'single',
    modules: ['attendance'],
    title: MODULE_TITLES.attendance,
    description: 'قالب مبني على تقرير الحضور والانصراف الحالي',
    requiredPermission: PERMISSIONS.REPORTS_VIEW,
    formats: ['csv', 'xlsx', 'pdf'],
    maximumRangeDays: 366,
  },
  {
    builtInKey: 'leaves',
    version: 1,
    kind: 'single',
    modules: ['leaves'],
    title: MODULE_TITLES.leaves,
    description: 'قالب مبني على تقرير الإجازات الحالي',
    requiredPermission: PERMISSIONS.REPORTS_VIEW,
    formats: ['csv', 'xlsx', 'pdf'],
    maximumRangeDays: 366,
  },
  {
    builtInKey: 'payroll',
    version: 1,
    kind: 'single',
    modules: ['payroll'],
    title: MODULE_TITLES.payroll,
    description: 'قالب مبني على تقرير الرواتب الحالي مع حماية راتب المالك',
    requiredPermission: PERMISSIONS.REPORTS_VIEW,
    formats: ['csv', 'xlsx', 'pdf'],
    maximumRangeDays: 366,
  },
  {
    builtInKey: 'purchasing',
    version: 1,
    kind: 'single',
    modules: ['purchasing'],
    title: MODULE_TITLES.purchasing,
    description: 'قالب مبني على تقرير المشتريات الحالي',
    requiredPermission: PERMISSIONS.REPORTS_VIEW,
    formats: ['csv', 'xlsx', 'pdf'],
    maximumRangeDays: 366,
  },
  {
    builtInKey: 'training',
    version: 1,
    kind: 'single',
    modules: ['training'],
    title: MODULE_TITLES.training,
    description: 'قالب مبني على تقرير التدريب والتطوير الحالي',
    requiredPermission: PERMISSIONS.REPORTS_VIEW,
    formats: ['csv', 'xlsx', 'pdf'],
    maximumRangeDays: 366,
  },
  {
    builtInKey: 'attendance_leaves',
    version: 1,
    kind: 'composite',
    modules: ['attendance', 'leaves'],
    title: 'الحضور والإجازات',
    description: 'قالب مركب يعرض قسمين مستقلين للحضور والإجازات دون دمج الصفوف أو ربطها بجدول واحد',
    requiredPermission: PERMISSIONS.REPORTS_COMPOSITE_VIEW,
    formats: ['csv', 'xlsx', 'pdf'],
    maximumRangeDays: 366,
  },
  {
    builtInKey: 'employees_training',
    version: 1,
    kind: 'composite',
    modules: ['employees', 'training'],
    title: 'الموظفون والتدريب',
    description: 'قالب مركب بقسمين مستقلين لحقول الموظف الآمنة وتقرير التدريب دون دمج الصفوف',
    requiredPermission: PERMISSIONS.REPORTS_COMPOSITE_VIEW,
    formats: ['csv', 'xlsx', 'pdf'],
    maximumRangeDays: 366,
  },
  {
    builtInKey: 'purchasing_payments',
    version: 1,
    kind: 'composite',
    modules: ['purchasing', 'payments'],
    title: 'المشتريات ومدفوعات الرواتب',
    description:
      'قالب مركب بقسمين مستقلين للمشتريات ومدفوعات الرواتب — بدون إجمالي مدمج أو مطابقة بنكية',
    requiredPermission: PERMISSIONS.REPORTS_COMPOSITE_VIEW,
    formats: ['xlsx', 'pdf'],
    maximumRangeDays: 366,
  },
  {
    builtInKey: 'executive_summary',
    version: 1,
    kind: 'composite',
    modules: ['attendance', 'leaves', 'payroll', 'purchasing', 'training'],
    title: 'الملخص التنفيذي',
    description: 'ملخصات مجمّعة للوحدات المصرح بها فقط دون محادثة خاصة ودون إجمالي مدمج مضلل',
    requiredPermission: PERMISSIONS.REPORTS_COMPOSITE_VIEW,
    formats: ['xlsx', 'pdf'],
    maximumRangeDays: 366,
    sectionPolicy: 'omit_unauthorized',
    summaryOnly: true,
  },
  {
    builtInKey: 'executive_all_modules',
    version: 1,
    kind: 'composite',
    modules: ['employees', 'attendance', 'leaves', 'payroll', 'purchasing', 'training', 'payments'],
    title: 'الملخص التنفيذي لكل الوحدات المصرح بها',
    description:
      'يعرض أقسام الوحدات المصرح بها فقط ويحذف غير المصرح — بدون إجمالي مدمج أو محادثة خاصة',
    requiredPermission: PERMISSIONS.REPORTS_COMPOSITE_VIEW,
    formats: ['pdf'],
    maximumRangeDays: 366,
    sectionPolicy: 'omit_unauthorized',
    summaryOnly: true,
  },
];

const TEMPLATE_BY_KEY = new Map(BUILT_IN_REPORT_TEMPLATES.map((def) => [def.builtInKey, def]));

export function getBuiltInTemplate(builtInKey: string): BuiltInTemplateDefinition | undefined {
  return TEMPLATE_BY_KEY.get(builtInKey);
}

const hasPermission = (user: ReportUser, permission: string): boolean =>
  user.permissions.includes(PERMISSIONS.ADMIN_FULL) || user.permissions.includes(permission);

const isAdminUser = (user: ReportUser): boolean => user.permissions.includes(PERMISSIONS.ADMIN_FULL);

export function canAccessTemplateModule(user: ReportUser, module: TemplateModuleKey): boolean {
  switch (module) {
    case 'employees':
      return (
        hasPermission(user, PERMISSIONS.EMPLOYEES_VIEW) ||
        hasPermission(user, PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT)
      );
    case 'payments':
      return hasPermission(user, PERMISSIONS.PAYROLL_PAYMENTS_VIEW);
    default:
      return canAccessReport(user, module);
  }
}

/** Every source module permission must be present — missing any one hides/rejects the whole template (ADR-007). */
export function missingModulePermissions(user: ReportUser, def: BuiltInTemplateDefinition): TemplateModuleKey[] {
  return def.modules.filter((module) => !canAccessTemplateModule(user, module));
}

export function canUseBuiltInTemplate(user: ReportUser, def: BuiltInTemplateDefinition): boolean {
  if (!hasPermission(user, def.requiredPermission)) return false;
  if (def.sectionPolicy === 'omit_unauthorized') {
    return def.modules.some((module) => canAccessTemplateModule(user, module));
  }
  return missingModulePermissions(user, def).length === 0;
}

export const mayExportReportTemplates = (user: ReportUser): boolean =>
  isAdminUser(user) || user.permissions.includes(PERMISSIONS.REPORTS_EXPORT);

const mayManageTemplates = (user: ReportUser): boolean =>
  isAdminUser(user) || user.permissions.includes(PERMISSIONS.REPORTS_TEMPLATES_MANAGE);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'يجب إدخال التاريخ بصيغة yyyy-MM-dd').refine(
  (value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  },
  'التاريخ غير صالح',
);

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ReportTemplateError(
      400,
      'TEMPLATE_VALIDATION_ERROR',
      result.error.issues[0]?.message ?? 'معايير القالب غير صالحة',
      result.error.flatten(),
    );
  }
  return result.data;
};


const timestamp = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

const validateCompanyDepartment = async (prisma: any, user: ReportUser, departmentId?: string): Promise<void> => {
  if (!departmentId) return;
  const department = await prisma.department.findFirst({
    where: { id: departmentId, companyId: user.companyId },
    select: { id: true },
  });
  if (!department) {
    throw new ReportTemplateError(404, 'TEMPLATE_DEPARTMENT_NOT_FOUND', 'القسم غير موجود');
  }
};

async function compileAttendanceSection(
  prisma: any,
  user: ReportUser,
  rawFilters: unknown,
  rowCap: number,
): Promise<TemplateSection> {
  try {
    // allowOverflowProbe: template export owns the 413 row-cap response (not classic report 400).
    const detail = await attendanceReport(prisma, user, rawFilters, true, { allowOverflowProbe: true });
    const total = detail.pagination.total;
    const truncated = total > rowCap;
    return {
      module: 'attendance',
      title: MODULE_TITLES.attendance,
      summary: detail.summary,
      rows: detail.rows.slice(0, rowCap),
      rowCount: total,
      truncated,
      warnings: [
        ...(truncated ? ['تم اقتصار قسم الحضور على الحد الأقصى المسموح من الصفوف.'] : []),
        ...detail.warnings,
      ],
    };
  } catch (error) {
    const known = moduleError(error);
    if (known) throw known;
    throw error;
  }
}

async function compileLeavesSection(
  prisma: any,
  user: ReportUser,
  rawFilters: unknown,
  rowCap: number,
): Promise<TemplateSection> {
  try {
    // allowOverflowProbe: template export owns the 413 row-cap response (not classic report 400).
    const detail = await leavesReport(prisma, user, rawFilters, true, { allowOverflowProbe: true });
    const total = detail.pagination.total;
    const truncated = total > rowCap;
    return {
      module: 'leaves',
      title: MODULE_TITLES.leaves,
      summary: detail.summary,
      rows: detail.rows.slice(0, rowCap),
      rowCount: total,
      truncated,
      warnings: [
        ...(truncated ? ['تم اقتصار قسم الإجازات على الحد الأقصى المسموح من الصفوف.'] : []),
        ...detail.warnings,
      ],
    };
  } catch (error) {
    const known = moduleError(error);
    if (known) throw known;
    throw error;
  }
}

/** Adapts a duck-typed module error (PurchasingError/TrainingError/PayrollRequestError, ...) into ReportTemplateError. */
const moduleError = (error: unknown): ReportTemplateError | null => {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { status?: unknown; errorCode?: unknown; message?: unknown; details?: unknown };
  if (typeof candidate.status !== 'number' || typeof candidate.errorCode !== 'string') return null;
  return new ReportTemplateError(
    candidate.status,
    candidate.errorCode,
    typeof candidate.message === 'string' ? candidate.message : 'تعذر تحميل القالب',
    candidate.details,
  );
};

async function compilePayrollSection(
  prisma: any,
  user: ReportUser,
  rawFilters: Record<string, unknown>,
  rowCap: number,
): Promise<TemplateSection> {
  const periodId = typeof rawFilters.periodId === 'string' ? rawFilters.periodId : undefined;
  try {
    const source = await buildPayrollReport(prisma, user, periodId);
    const rows = source.rows as Array<Record<string, unknown>>;
    const truncated = rows.length > rowCap;
    return {
      module: 'payroll',
      title: MODULE_TITLES.payroll,
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
      rows: rows.slice(0, rowCap),
      rowCount: rows.length,
      truncated,
      warnings: source.protectedRowsHidden ? ['توجد صفوف رواتب محمية غير ظاهرة في التقرير والإجماليات.'] : [],
    };
  } catch (error) {
    const known = moduleError(error);
    if (known) throw known;
    throw error;
  }
}

async function compilePurchasingSection(
  prisma: any,
  user: ReportUser,
  rawFilters: Record<string, unknown>,
  rowCap: number,
): Promise<TemplateSection> {
  try {
    const source = await buildPurchasingReport(prisma, user, rawFilters, rowCap + 1);
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
    const truncated = rows.length > rowCap;
    return {
      module: 'purchasing',
      title: MODULE_TITLES.purchasing,
      summary: source.summary,
      rows: rows.slice(0, rowCap),
      rowCount: rows.length,
      truncated,
      warnings: [],
    };
  } catch (error) {
    const known = moduleError(error);
    if (known) throw known;
    throw error;
  }
}

async function compileTrainingSection(
  prisma: any,
  user: ReportUser,
  rawFilters: Record<string, unknown>,
  rowCap: number,
): Promise<TemplateSection> {
  try {
    const scope = hasPermission(user, PERMISSIONS.TRAINING_VIEW_COMPANY) ? 'company' : 'department';
    const source = await buildTrainingReport(prisma, user, { ...rawFilters, scope }, rowCap + 1);
    const rows = source.report.courses.map((course: any) => ({
      id: course.id,
      courseCode: course.courseCode,
      title: course.title,
      category: course.category,
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
    const truncated = rows.length > rowCap;
    return {
      module: 'training',
      title: MODULE_TITLES.training,
      summary: source.report.summary,
      rows: rows.slice(0, rowCap),
      rowCount: rows.length,
      truncated,
      warnings: [],
    };
  } catch (error) {
    const known = moduleError(error);
    if (known) throw known;
    throw error;
  }
}

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

const mayViewOwnerRows = (user: ReportUser): boolean =>
  isAdminUser(user) || user.permissions.includes(PERMISSIONS.HR_VIEW);

async function resolveEmployeeDepartmentScope(
  prisma: any,
  user: ReportUser,
  requestedDepartmentId?: string,
): Promise<{ departmentIds: string[] | null }> {
  if (hasPermission(user, PERMISSIONS.EMPLOYEES_VIEW)) {
    if (requestedDepartmentId) {
      await validateCompanyDepartment(prisma, user, requestedDepartmentId);
      return { departmentIds: [requestedDepartmentId] };
    }
    return { departmentIds: null };
  }
  if (!hasPermission(user, PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT)) {
    throw new ReportTemplateError(403, 'TEMPLATE_SOURCE_FORBIDDEN', 'لا تملك صلاحية عرض الموظفين');
  }
  const managed = await loadManagedDepartmentIds(prisma, {
    companyId: user.companyId,
    userId: user.id,
  });
  if (requestedDepartmentId) {
    if (!managed.includes(requestedDepartmentId)) {
      throw new ReportTemplateError(403, 'TEMPLATE_SCOPE_FORBIDDEN', 'القسم خارج نطاق صلاحيتك');
    }
    return { departmentIds: [requestedDepartmentId] };
  }
  return { departmentIds: managed };
}

/** Safe employee fields only — no contactInfo, credentials, or private notes. Archived visibility is explicit. */
async function compileEmployeesSection(
  prisma: any,
  user: ReportUser,
  rawFilters: Record<string, unknown>,
  rowCap: number,
): Promise<TemplateSection> {
  const departmentId = typeof rawFilters.departmentId === 'string' ? rawFilters.departmentId : undefined;
  const includeArchived = rawFilters.includeArchived === true || rawFilters.includeArchived === 'true';
  const scope = await resolveEmployeeDepartmentScope(prisma, user, departmentId);
  const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, user.companyId);
  const rawRows = await prisma.employee.findMany({
    where: {
      companyId: user.companyId,
      ...(scope.departmentIds !== null ? { departmentId: { in: scope.departmentIds } } : {}),
      ...(includeArchived ? {} : { archivedAt: null }),
    },
    select: {
      id: true,
      employeeNum: true,
      jobTitle: true,
      status: true,
      departmentId: true,
      archivedAt: true,
      joiningDate: true,
      department: { select: { name: true } },
      user: { select: { id: true, name: true, role: { select: { permissions: true } } } },
    },
    orderBy: [{ employeeNum: 'asc' }],
    take: rowCap + 1,
  });
  const visible = rawRows.filter(
    (row: any) => mayViewOwnerRows(user) || !isOwnerUser(row.user, primaryOwnerUserId),
  );
  const rows = visible.map((row: any) => ({
    id: row.id,
    employeeNum: row.employeeNum,
    employeeName: row.user?.name ?? 'موظف',
    jobTitle: row.jobTitle,
    departmentId: row.departmentId ?? null,
    departmentName: row.department?.name ?? null,
    status: row.status,
    joiningDate: row.joiningDate ? new Date(row.joiningDate).toISOString().slice(0, 10) : null,
    isArchived: row.archivedAt != null,
    archivedAt: timestamp(row.archivedAt),
  }));
  const truncated = rows.length > rowCap;
  const capped = rows.slice(0, rowCap);
  return {
    module: 'employees',
    title: MODULE_TITLES.employees,
    summary: {
      employeeCount: rows.length,
      activeCount: rows.filter((row) => row.status === 'active' && !row.isArchived).length,
      archivedCount: rows.filter((row) => row.isArchived).length,
      includeArchived,
    },
    rows: capped,
    rowCount: rows.length,
    truncated,
    warnings: truncated ? ['تم اقتصار قسم الموظفين على الحد الأقصى المسموح من الصفوف.'] : [],
  };
}

/** PayrollPayment ledger rows — independent from purchasing; no blended totals. */
async function compilePaymentsSection(
  prisma: any,
  user: ReportUser,
  rawFilters: Record<string, unknown>,
  rowCap: number,
): Promise<TemplateSection> {
  if (!hasPermission(user, PERMISSIONS.PAYROLL_PAYMENTS_VIEW)) {
    throw new ReportTemplateError(403, 'TEMPLATE_SOURCE_FORBIDDEN', 'لا تملك صلاحية عرض مدفوعات الرواتب');
  }
  const periodId = typeof rawFilters.periodId === 'string' ? rawFilters.periodId : undefined;
  const from = typeof rawFilters.from === 'string' ? rawFilters.from : undefined;
  const to = typeof rawFilters.to === 'string' ? rawFilters.to : undefined;
  if (periodId) {
    const period = await prisma.payrollPeriod.findFirst({
      where: { id: periodId, companyId: user.companyId },
      select: { id: true },
    });
    if (!period) {
      throw new ReportTemplateError(404, 'TEMPLATE_PERIOD_NOT_FOUND', 'فترة الرواتب غير موجودة');
    }
  }
  const rawRows = await prisma.payrollPayment.findMany({
    where: {
      companyId: user.companyId,
      ...(periodId ? { payrollPeriodId: periodId } : {}),
      ...(from || to
        ? {
            paymentDate: {
              ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
              ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
    },
    select: {
      id: true,
      payrollPeriodId: true,
      amount: true,
      currency: true,
      paymentDate: true,
      reference: true,
      status: true,
      createdAt: true,
      voidedAt: true,
      isLegacyMigration: true,
    },
    orderBy: [{ paymentDate: 'desc' }, { id: 'asc' }],
    take: rowCap + 1,
  });
  const rows = rawRows.map((row: any) => ({
    id: row.id,
    payrollPeriodId: row.payrollPeriodId,
    amount: row.amount?.toString?.() ?? String(row.amount),
    currency: row.currency,
    paymentDate: new Date(row.paymentDate).toISOString().slice(0, 10),
    reference: row.reference ?? null,
    status: row.status,
    createdAt: timestamp(row.createdAt),
    voidedAt: timestamp(row.voidedAt),
    isLegacyMigration: Boolean(row.isLegacyMigration),
  }));
  const truncated = rows.length > rowCap;
  const posted = rows.filter((row) => row.status === 'posted');
  return {
    module: 'payments',
    title: MODULE_TITLES.payments,
    summary: {
      paymentCount: rows.length,
      postedCount: posted.length,
      voidedCount: rows.filter((row) => row.status === 'voided').length,
      periodId: periodId ?? null,
      // Intentionally no blended purchasing+payments total.
    },
    rows: rows.slice(0, rowCap),
    rowCount: rows.length,
    truncated,
    warnings: truncated ? ['تم اقتصار قسم المدفوعات على الحد الأقصى المسموح من الصفوف.'] : [],
  };
}

async function compileModuleSection(
  module: TemplateModuleKey,
  prisma: any,
  user: ReportUser,
  rawFilters: Record<string, unknown>,
  rowCap: number,
): Promise<TemplateSection> {
  switch (module) {
    case 'attendance': return compileAttendanceSection(prisma, user, rawFilters, rowCap);
    case 'leaves': return compileLeavesSection(prisma, user, rawFilters, rowCap);
    case 'payroll': return compilePayrollSection(prisma, user, rawFilters, rowCap);
    case 'purchasing': return compilePurchasingSection(prisma, user, rawFilters, rowCap);
    case 'training': return compileTrainingSection(prisma, user, rawFilters, rowCap);
    case 'employees': return compileEmployeesSection(prisma, user, rawFilters, rowCap);
    case 'payments': return compilePaymentsSection(prisma, user, rawFilters, rowCap);
  }
}

/**
 * Compiles a built-in template into a canonical, capped document. Used by
 * both the preview endpoint (rowCap 200/section) and the export endpoint
 * (rowCap 5000 total). Never accepts client SQL/joins/fields — only the
 * server-defined filter shape per module.
 */
export async function compileBuiltInTemplate(
  prisma: any,
  user: ReportUser,
  def: BuiltInTemplateDefinition,
  options: { filters?: Record<string, unknown>; departmentId?: string; rowCapPerSection: number },
): Promise<CompiledTemplateDocument> {
  const filters = { ...(options.filters ?? {}) };
  if (options.departmentId) filters.departmentId = options.departmentId;
  // Composite templates only forward shared, unambiguous fields that are present.
  // periodId / includeArchived are optional; never send undefined keys into strict module schemas.
  const dispatchFilters = def.kind === 'composite'
    ? {
        ...(filters.from !== undefined ? { from: filters.from } : {}),
        ...(filters.to !== undefined ? { to: filters.to } : {}),
        ...(filters.departmentId !== undefined ? { departmentId: filters.departmentId } : {}),
        ...(filters.periodId !== undefined ? { periodId: filters.periodId } : {}),
        ...(filters.includeArchived !== undefined ? { includeArchived: filters.includeArchived } : {}),
      }
    : filters;
  const sections: TemplateSection[] = [];
  for (const module of def.modules) {
    if (def.sectionPolicy === 'omit_unauthorized' && !canAccessTemplateModule(user, module)) {
      continue;
    }
    let section = await compileModuleSection(module, prisma, user, dispatchFilters, options.rowCapPerSection);
    if (def.summaryOnly) {
      section = {
        ...section,
        rows: [],
        rowCount: 0,
        truncated: false,
      };
    }
    sections.push(section);
  }
  if (sections.length === 0) {
    throw new ReportTemplateError(403, 'TEMPLATE_SOURCE_FORBIDDEN', 'لا تملك صلاحية أحد مصادر بيانات هذا القالب');
  }
  const warnings = sections.flatMap((section) => section.warnings);
  if (def.builtInKey === 'purchasing_payments') {
    warnings.push('قسم المشتريات وقسم المدفوعات مستقلان — لا يوجد إجمالي مدمج أو مطابقة بنكية.');
  }
  if (def.sectionPolicy === 'omit_unauthorized') {
    warnings.push('تم عرض الأقسام المصرح بها فقط — لا يوجد إجمالي مدمج عبر الوحدات.');
  }
  return {
    builtInKey: def.builtInKey,
    templateVersion: def.version,
    generatedAt: new Date().toISOString(),
    scope: { kind: options.departmentId ? 'department' : 'company', departmentId: options.departmentId ?? null },
    sections,
    warnings,
  };
}

const scopeSchema = z.strictObject({
  departmentId: z.string().uuid('معرّف القسم غير صالح').optional(),
}).optional();

const filtersSchema = z
  .record(z.string().max(80), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  .optional()
  .default({});

const previewBodySchema = z.strictObject({
  builtInKey: z.string().trim().min(1).max(60),
  templateVersion: z.coerce.number().int().min(1),
  scope: scopeSchema,
  filters: filtersSchema,
});

export const PREVIEW_ROW_CAP_PER_SECTION = 200;
export const EXPORT_ROW_CAP_TOTAL = 5000;

/** Resolves the definition + authorization for a preview/export request, or throws ReportTemplateError. */
export function resolveAuthorizedTemplate(
  user: ReportUser,
  builtInKey: string,
  templateVersion: number,
): BuiltInTemplateDefinition {
  const def = getBuiltInTemplate(builtInKey);
  if (!def) {
    throw new ReportTemplateError(404, 'TEMPLATE_NOT_FOUND', 'القالب غير موجود');
  }
  if (def.version !== templateVersion) {
    throw new ReportTemplateError(
      409,
      'TEMPLATE_VERSION_MISMATCH',
      'إصدار القالب غير مطابق للإصدار الحالي. يرجى إعادة التحقق من القالب.',
      { currentVersion: def.version },
    );
  }
  if (!hasPermission(user, def.requiredPermission)) {
    throw new ReportTemplateError(403, 'TEMPLATE_FORBIDDEN', 'لا تملك صلاحية استخدام هذا القالب');
  }
  if (def.sectionPolicy === 'omit_unauthorized') {
    if (!def.modules.some((module) => canAccessTemplateModule(user, module))) {
      throw new ReportTemplateError(403, 'TEMPLATE_SOURCE_FORBIDDEN', 'لا تملك صلاحية أحد مصادر بيانات هذا القالب');
    }
  } else {
    const missing = missingModulePermissions(user, def);
    if (missing.length > 0) {
      throw new ReportTemplateError(403, 'TEMPLATE_SOURCE_FORBIDDEN', 'لا تملك صلاحية أحد مصادر بيانات هذا القالب');
    }
  }
  return def;
}

const sendError = (res: Response, error: unknown): Response => {
  const known = error instanceof ReportTemplateError ? error : moduleError(error);
  if (known) {
    return res.status(known.status).json({
      error: known.errorCode,
      message: known.message,
      code: known.status,
      ...(known.details ? { details: known.details } : {}),
    });
  }
  return res.status(500).json({
    error: 'TEMPLATE_OPERATION_FAILED',
    message: 'تعذر تنفيذ العملية على القالب حالياً',
    code: 500,
  });
};

const savedTemplateFilterValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

const createSavedTemplateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  builtInKey: z.string().trim().min(1).max(60),
  templateVersion: z.coerce.number().int().min(1).optional(),
  scope: scopeSchema,
  filters: z.record(z.string().max(80), savedTemplateFilterValue).optional().default({}),
  preferredFormat: z.enum(['csv', 'xlsx', 'pdf']).optional(),
});

function savedTemplateShape(row: any) {
  return {
    id: row.id,
    name: row.name,
    builtInKey: row.builtInKey,
    templateVersion: row.templateVersion,
    scope: { kind: row.scopeKind, departmentId: row.departmentId },
    filters: row.filtersJson ?? {},
    preferredFormat: row.preferredFormat,
    archivedAt: timestamp(row.archivedAt),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
  };
}

export function registerReportTemplateRoutes({
  app,
  prisma,
  requireAuth,
}: ReportTemplateRouteDeps): void {
  app.get('/api/v2/reports/templates', requireAuth, (req: TemplateRequest, res) => {
    const user = req.user!;
    const visible = BUILT_IN_REPORT_TEMPLATES.filter((def) => canUseBuiltInTemplate(user, def));
    return res.json(
      visible.map((def) => ({
        builtInKey: def.builtInKey,
        version: def.version,
        kind: def.kind,
        modules: def.modules,
        title: def.title,
        description: def.description,
        formats: def.formats,
        maximumRangeDays: def.maximumRangeDays,
      })),
    );
  });

  app.post('/api/v2/reports/templates/preview', requireAuth, async (req: TemplateRequest, res) => {
    try {
      const user = req.user!;
      const body = parse(previewBodySchema, req.body);
      const def = resolveAuthorizedTemplate(user, body.builtInKey, body.templateVersion);
      const document = await compileBuiltInTemplate(prisma, user, def, {
        filters: body.filters,
        departmentId: body.scope?.departmentId,
        rowCapPerSection: PREVIEW_ROW_CAP_PER_SECTION,
      });
      await writeAuditRequired(prisma, {
        companyId: user.companyId,
        userId: user.id,
        action: 'template.preview',
        details: {
          reportType: def.builtInKey,
          templateVersion: def.version,
          scope: document.scope.kind,
          sectionCount: document.sections.length,
          rowCount: document.sections.reduce((sum, section) => sum + section.rowCount, 0),
        },
      });
      return res.json(document);
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/v2/reports/saved-templates', requireAuth, async (req: TemplateRequest, res) => {
    try {
      const user = req.user!;
      if (!mayManageTemplates(user)) {
        throw new ReportTemplateError(403, 'SAVED_TEMPLATE_FORBIDDEN', 'لا تملك صلاحية إدارة قوالب التقارير');
      }
      const includeArchived = req.query.includeArchived === 'true';
      const rows = await prisma.savedReportTemplate.findMany({
        where: {
          companyId: user.companyId,
          ownerUserId: user.id,
          ...(includeArchived ? {} : { archivedAt: null }),
        },
        orderBy: { createdAt: 'desc' },
      });
      return res.json(rows.map(savedTemplateShape));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/v2/reports/saved-templates', requireAuth, async (req: TemplateRequest, res) => {
    try {
      const user = req.user!;
      if (!mayManageTemplates(user)) {
        throw new ReportTemplateError(403, 'SAVED_TEMPLATE_FORBIDDEN', 'لا تملك صلاحية إدارة قوالب التقارير');
      }
      const body = parse(createSavedTemplateSchema, req.body);
      const def = getBuiltInTemplate(body.builtInKey);
      if (!def) {
        throw new ReportTemplateError(400, 'SAVED_TEMPLATE_UNKNOWN_KEY', 'مفتاح القالب غير معروف');
      }
      if (!canUseBuiltInTemplate(user, def)) {
        throw new ReportTemplateError(403, 'SAVED_TEMPLATE_FORBIDDEN', 'لا تملك صلاحية استخدام هذا القالب');
      }
      if (body.templateVersion !== undefined && body.templateVersion !== def.version) {
        throw new ReportTemplateError(
          409,
          'SAVED_TEMPLATE_VERSION_MISMATCH',
          'إصدار القالب غير مطابق للإصدار الحالي',
          { currentVersion: def.version },
        );
      }
      if (body.scope?.departmentId) {
        await validateCompanyDepartment(prisma, user, body.scope.departmentId);
      }
      const created = await prisma.savedReportTemplate.create({
        data: {
          companyId: user.companyId,
          ownerUserId: user.id,
          name: body.name,
          builtInKey: def.builtInKey,
          templateVersion: def.version,
          scopeKind: body.scope?.departmentId ? 'department' : 'company',
          departmentId: body.scope?.departmentId ?? null,
          filtersJson: body.filters,
          preferredFormat: body.preferredFormat ?? null,
        },
      });
      await writeAuditRequired(prisma, {
        companyId: user.companyId,
        userId: user.id,
        action: 'template.save',
        details: {
          reportType: def.builtInKey,
          templateVersion: def.version,
          savedTemplateId: created.id,
          scope: created.scopeKind,
          format: created.preferredFormat,
        },
      });
      return res.status(201).json(savedTemplateShape(created));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/v2/reports/saved-templates/:id/archive', requireAuth, async (req: TemplateRequest, res) => {
    try {
      const user = req.user!;
      if (!mayManageTemplates(user)) {
        throw new ReportTemplateError(403, 'SAVED_TEMPLATE_FORBIDDEN', 'لا تملك صلاحية إدارة قوالب التقارير');
      }
      const existing = await prisma.savedReportTemplate.findFirst({
        where: { id: req.params.id, companyId: user.companyId, ownerUserId: user.id },
      });
      if (!existing) {
        throw new ReportTemplateError(404, 'SAVED_TEMPLATE_NOT_FOUND', 'القالب المحفوظ غير موجود');
      }
      if (existing.archivedAt) {
        return res.json(savedTemplateShape(existing));
      }
      const updated = await prisma.savedReportTemplate.update({
        where: { id: existing.id },
        data: { archivedAt: new Date() },
      });
      await writeAuditRequired(prisma, {
        companyId: user.companyId,
        userId: user.id,
        action: 'template.archive',
        details: {
          reportType: existing.builtInKey,
          savedTemplateId: existing.id,
        },
      });
      return res.json(savedTemplateShape(updated));
    } catch (error) {
      return sendError(res, error);
    }
  });
}
