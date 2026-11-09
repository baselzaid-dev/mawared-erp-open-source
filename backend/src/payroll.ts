import { createHash } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { writeAuditRequired } from './audit';
import { loadPrimaryOwnerUserId } from './authorization';
import { PERMISSIONS } from './permissions';
import {
  CALCULATION_RULES_VERSION,
  computeEmployeePay,
  fingerprintAdjustments,
  fingerprintDefinitions,
  type AdjustmentInput,
  type ComponentDefinitionInput,
} from './payrollComponentsCalc';
import { probeW1bUnsupported } from './payrollW1b';
import {
  payrollCalculationSchema,
  payrollPeriodSchema,
  payrollReportQuerySchema,
  validateBody,
  validateQuery,
} from './validation';

export interface PayrollUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface PayrollRequest extends Request {
  user?: PayrollUser;
}

interface PayrollRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
}

interface PayrollIssue {
  code: string;
  message: string;
  employeeId?: string;
  employeeNum?: string;
  employeeName?: string;
  protected?: boolean;
}

interface PayrollInput {
  employee: any;
  salaryRecord: any;
  baseSalary: string;
  owner: boolean;
}

class PayrollRequestError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

const dateOnly = (value: Date | string): string => new Date(value).toISOString().slice(0, 10);
const timestamp = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

const parseRolePermissions = (value: string | null | undefined): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((permission): permission is string => typeof permission === 'string')
      : [];
  } catch {
    return [];
  }
};

const isOwnerEmployee = (employee: any, primaryOwnerUserId: string | null): boolean =>
  employee?.user?.id === primaryOwnerUserId ||
  parseRolePermissions(employee?.user?.role?.permissions).includes(PERMISSIONS.ADMIN_FULL);

const hasOwnerSalaryPermission = (permissions: string[]): boolean =>
  permissions.includes(PERMISSIONS.SALARY_VIEW_OWNER);

const normalizeMoney = (value: { toString(): string } | string | number): string | null => {
  const raw = value.toString().trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n || cents > 1_000_000_000n) return null;
  return `${whole}.${fraction.padEnd(2, '0')}`;
};

const moneyToCents = (value: { toString(): string } | string | number): bigint => {
  const raw = value.toString();
  const match = raw.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error('Invalid stored payroll money');
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
};

const centsToMoney = (cents: bigint): string =>
  `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;

const periodBounds = (year: number, month: number) => ({
  start: new Date(Date.UTC(year, month - 1, 1)),
  end: new Date(Date.UTC(year, month, 0)),
});

const periodShape = (period: any, legacyWithoutItems = false) => ({
  id: period.id,
  companyId: period.companyId,
  month: period.month,
  year: period.year,
  status: period.status,
  calculationVersion: period.calculationVersion ?? 0,
  createdAt: timestamp(period.createdAt),
  calculatedAt: timestamp(period.calculatedAt),
  approvedAt: timestamp(period.approvedAt),
  paidAt: timestamp(period.paidAt),
  reopenedAt: timestamp(period.reopenedAt),
  ledgerPostedAt: timestamp(period.ledgerPostedAt),
  legacyWithoutItems,
});

const itemShape = (item: any) => ({
  id: item.id,
  payrollPeriodId: item.payrollPeriodId,
  employeeId: item.employeeId,
  employeeName: item.employeeNameSnapshot,
  employeeNum: item.employeeNumSnapshot,
  departmentName: item.departmentNameSnapshot ?? null,
  baseSalary: normalizeMoney(item.baseSalary) ?? item.baseSalary.toString(),
  grossPay: normalizeMoney(item.grossPay) ?? item.grossPay.toString(),
  totalDeductions: item.totalDeductions.toString() === '0'
    ? '0.00'
    : (normalizeMoney(item.totalDeductions) ?? item.totalDeductions.toString()),
  netPay: normalizeMoney(item.netPay) ?? item.netPay.toString(),
  currency: item.currency,
  status: item.status,
  calculatedAt: timestamp(item.calculatedAt),
});

const payrollSummary = (items: any[]) => ({
  visibleEmployeeCount: items.length,
  visibleGross: centsToMoney(items.reduce((sum, item) => sum + moneyToCents(item.grossPay), 0n)),
  visibleDeductions: centsToMoney(
    items.reduce((sum, item) => sum + moneyToCents(item.totalDeductions), 0n)
  ),
  visibleNet: centsToMoney(items.reduce((sum, item) => sum + moneyToCents(item.netPay), 0n)),
  currency: 'SAR',
});

const ownerFilteredItems = (
  items: any[],
  permissions: string[],
  primaryOwnerUserId: string | null,
) => {
  const ownerItems = items.filter((item) =>
    isOwnerEmployee(item.employee, primaryOwnerUserId)
  );
  const mayViewOwner = hasOwnerSalaryPermission(permissions);
  return {
    visibleItems: mayViewOwner
      ? items
      : items.filter((item) => !isOwnerEmployee(item.employee, primaryOwnerUserId)),
    protectedRowsHidden: !mayViewOwner && ownerItems.length > 0,
    protectedRowCount: mayViewOwner ? 0 : ownerItems.length,
    mayViewOwner,
  };
};

const loadPeriodItems = async (client: any, companyId: string, periodId: string): Promise<any[]> =>
  client.payrollItem.findMany({
    where: { companyId, payrollPeriodId: periodId },
    include: {
      employee: {
        select: {
          user: { select: { id: true, role: { select: { permissions: true } } } },
        },
      },
    },
    orderBy: [{ employeeNameSnapshot: 'asc' }, { employeeNumSnapshot: 'asc' }],
  });

const periodWithPrivacy = (
  period: any,
  items: any[],
  permissions: string[],
  primaryOwnerUserId: string | null,
) => {
  const privacy = ownerFilteredItems(items, permissions, primaryOwnerUserId);
  const legacyWithoutItems = ['approved', 'paid'].includes(period.status) && items.length === 0;
  const hasItems = items.length > 0;
  return {
    ...periodShape(period, legacyWithoutItems),
    itemCount: privacy.visibleItems.length,
    visibleSummary: hasItems ? payrollSummary(privacy.visibleItems) : null,
    protectedRowsHidden: privacy.protectedRowsHidden,
    protectedRowCount: privacy.protectedRowCount,
    ...(privacy.mayViewOwner && hasItems ? { fullSummary: payrollSummary(items) } : {}),
  };
};

const itemsWithPrivacy = (
  period: any,
  items: any[],
  permissions: string[],
  primaryOwnerUserId: string | null,
) => {
  const privacy = ownerFilteredItems(items, permissions, primaryOwnerUserId);
  return {
    period: periodWithPrivacy(period, items, permissions, primaryOwnerUserId),
    items: privacy.visibleItems.map(itemShape),
    visibleSummary: items.length > 0 ? payrollSummary(privacy.visibleItems) : null,
    protectedRowsHidden: privacy.protectedRowsHidden,
    protectedRowCount: privacy.protectedRowCount,
    ...(privacy.mayViewOwner && items.length > 0 ? { fullSummary: payrollSummary(items) } : {}),
  };
};

export async function buildPayrollReport(
  client: any,
  user: PayrollUser,
  periodId?: string
): Promise<any> {
  const period = periodId
    ? await client.payrollPeriod.findFirst({
        where: { id: periodId, companyId: user.companyId },
      })
    : await client.payrollPeriod.findFirst({
        where: { companyId: user.companyId, status: { in: ['approved', 'paid'] } },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
      });
  if (!period) {
    throw new PayrollRequestError(404, 'PAYROLL_PERIOD_NOT_FOUND', 'فترة الرواتب غير موجودة');
  }
  if (period.status !== 'approved' && period.status !== 'paid') {
    throw new PayrollRequestError(
      409,
      'PAYROLL_REPORT_NOT_AVAILABLE',
      'يتوفر تقرير الرواتب بعد اعتماد الفترة فقط'
    );
  }
  const items = await loadPeriodItems(client, period.companyId, period.id);
  const primaryOwnerUserId = await loadPrimaryOwnerUserId(client, user.companyId);
  const payload = itemsWithPrivacy(period, items, user.permissions, primaryOwnerUserId);
  return {
    period: payload.period,
    rows: payload.items,
    visibleSummary: payload.visibleSummary,
    protectedRowsHidden: payload.protectedRowsHidden,
    protectedRowCount: payload.protectedRowCount,
    ...('fullSummary' in payload ? { fullSummary: payload.fullSummary } : {}),
  };
}

const safeEmployeeIssue = (
  employee: any,
  code: string,
  message: string,
  primaryOwnerUserId: string | null,
): PayrollIssue => ({
  code,
  message,
  employeeId: employee.id,
  employeeNum: employee.employeeNum,
  employeeName: employee.user?.name ?? 'موظف',
  protected: isOwnerEmployee(employee, primaryOwnerUserId),
});

const rangesOverlap = (left: any, right: any): boolean => {
  const leftStart = new Date(left.effectiveFrom).getTime();
  const leftEnd = left.effectiveTo ? new Date(left.effectiveTo).getTime() : Number.POSITIVE_INFINITY;
  const rightStart = new Date(right.effectiveFrom).getTime();
  const rightEnd = right.effectiveTo ? new Date(right.effectiveTo).getTime() : Number.POSITIVE_INFINITY;
  return leftStart <= rightEnd && rightStart <= leftEnd;
};

const resolvePayrollInputs = async (client: any, period: any) => {
  const { start, end } = periodBounds(period.year, period.month);
  const primaryOwnerUserId = await loadPrimaryOwnerUserId(client, period.companyId);
  const employees = await client.employee.findMany({
    where: {
      companyId: period.companyId,
      status: 'active',
      joiningDate: { lte: end },
    },
    include: {
      user: { select: { id: true, name: true, role: { select: { permissions: true } } } },
      department: { select: { name: true } },
    },
    orderBy: [{ employeeNum: 'asc' }],
  });

  const issues: PayrollIssue[] = [];
  const eligibleEmployees = employees.filter(
    (employee: any) => new Date(employee.joiningDate).getTime() <= start.getTime()
  );
  const partialMonthEmployees = employees.filter((employee: any) => {
    const joined = new Date(employee.joiningDate).getTime();
    return joined > start.getTime() && joined <= end.getTime();
  });

  for (const employee of partialMonthEmployees) {
    issues.push(safeEmployeeIssue(
      employee,
      'PARTIAL_MONTH_EMPLOYEE',
      'لا يمكن احتساب موظف التحق خلال الشهر دون سياسة احتساب جزئي',
      primaryOwnerUserId,
    ));
  }

  if (eligibleEmployees.length === 0 && partialMonthEmployees.length === 0) {
    issues.push({ code: 'NO_ELIGIBLE_EMPLOYEES', message: 'لا يوجد موظفون مؤهلون لهذه الفترة' });
  }

  const salaryRecords = eligibleEmployees.length === 0
    ? []
    : await client.salaryRecord.findMany({
      where: {
        companyId: period.companyId,
        employeeId: { in: eligibleEmployees.map((employee: any) => employee.id) },
      },
      orderBy: [{ employeeId: 'asc' }, { effectiveFrom: 'asc' }],
    });

  const inputs: PayrollInput[] = [];
  for (const employee of eligibleEmployees) {
    const employeeRecords = salaryRecords.filter((record: any) => record.employeeId === employee.id);
    const periodRecords = employeeRecords.filter((record: any) => {
      const effectiveFrom = new Date(record.effectiveFrom).getTime();
      const effectiveTo = record.effectiveTo
        ? new Date(record.effectiveTo).getTime()
        : Number.POSITIVE_INFINITY;
      return effectiveFrom <= end.getTime() && effectiveTo >= start.getTime();
    });

    if (periodRecords.length === 0) {
      issues.push(safeEmployeeIssue(employee, 'MISSING_SALARY', 'لا يوجد راتب يغطي فترة الرواتب كاملة', primaryOwnerUserId));
      continue;
    }

    const overlap = periodRecords.some((record: any, index: number) =>
      periodRecords.slice(index + 1).some((other: any) => rangesOverlap(record, other))
    );
    if (overlap) {
      issues.push(safeEmployeeIssue(employee, 'OVERLAPPING_SALARY_RECORDS', 'توجد سجلات راتب متداخلة', primaryOwnerUserId));
      continue;
    }

    const hasMidMonthBoundary = periodRecords.some((record: any) => {
      const effectiveFrom = new Date(record.effectiveFrom).getTime();
      const effectiveTo = record.effectiveTo ? new Date(record.effectiveTo).getTime() : null;
      return (effectiveFrom > start.getTime() && effectiveFrom <= end.getTime()) ||
        (effectiveTo !== null && effectiveTo >= start.getTime() && effectiveTo < end.getTime());
    });
    if (hasMidMonthBoundary) {
      issues.push(safeEmployeeIssue(employee, 'MID_MONTH_SALARY_CHANGE', 'توجد بداية أو نهاية راتب داخل شهر الرواتب', primaryOwnerUserId));
      continue;
    }

    const coveringRecords = periodRecords.filter((record: any) =>
      new Date(record.effectiveFrom).getTime() <= start.getTime() &&
      (record.effectiveTo == null || new Date(record.effectiveTo).getTime() >= end.getTime())
    );
    if (coveringRecords.length !== 1) {
      issues.push(safeEmployeeIssue(employee, 'MISSING_WHOLE_PERIOD_SALARY', 'لا يوجد راتب واحد يغطي الفترة كاملة', primaryOwnerUserId));
      continue;
    }

    const salaryRecord = coveringRecords[0];
    if (salaryRecord.currency !== 'SAR') {
      issues.push(safeEmployeeIssue(employee, 'UNSUPPORTED_CURRENCY', 'العملة المدعومة للرواتب هي SAR فقط', primaryOwnerUserId));
      continue;
    }
    const baseSalary = normalizeMoney(salaryRecord.baseSalary);
    if (!baseSalary) {
      issues.push(safeEmployeeIssue(employee, 'INVALID_SALARY_AMOUNT', 'قيمة الراتب غير صالحة للاحتساب', primaryOwnerUserId));
      continue;
    }
    inputs.push({
      employee,
      salaryRecord,
      baseSalary,
      owner: isOwnerEmployee(employee, primaryOwnerUserId),
    });
  }

  inputs.sort((left, right) => left.employee.id.localeCompare(right.employee.id));
  return { inputs, issues, start, end };
};

const calculationFingerprint = (
  period: any,
  inputs: PayrollInput[],
  definitions: ComponentDefinitionInput[],
  adjustments: AdjustmentInput[],
): string => {
  const canonical = {
    rulesVersion: CALCULATION_RULES_VERSION,
    companyId: period.companyId,
    period: { id: period.id, year: period.year, month: period.month },
    employees: inputs.map((input) => ({
      employeeId: input.employee.id,
      salaryRecordId: input.salaryRecord.id,
      effectiveFrom: dateOnly(input.salaryRecord.effectiveFrom),
      effectiveTo: input.salaryRecord.effectiveTo ? dateOnly(input.salaryRecord.effectiveTo) : null,
      baseSalary: input.baseSalary,
    })),
    componentDefinitions: fingerprintDefinitions(definitions),
    adjustments: fingerprintAdjustments(adjustments),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
};

const publicIssues = (issues: PayrollIssue[], permissions: string[]) => {
  const mayViewOwner = hasOwnerSalaryPermission(permissions);
  const protectedIssues = issues.filter((issue) => issue.protected);
  return {
    issues: issues
      .filter((issue) => mayViewOwner || !issue.protected)
      .map(({ protected: _protected, ...issue }) => issue),
    protectedEmployeeIssues: mayViewOwner ? 0 : protectedIssues.length,
  };
};

const itemMatchesInput = (
  item: any,
  input: PayrollInput,
  definitions: ComponentDefinitionInput[],
  adjustments: AdjustmentInput[],
): boolean => {
  try {
    const employeeAdjustments = adjustments.filter(
      (row) => row.employeeId === input.employee.id && row.status === 'applied',
    );
    const computed = computeEmployeePay(input.baseSalary, definitions, employeeAdjustments);
    return (
      item.employeeId === input.employee.id &&
      item.salaryRecordId === input.salaryRecord.id &&
      moneyToCents(item.baseSalary) === moneyToCents(computed.baseSalary) &&
      moneyToCents(item.grossPay) === moneyToCents(computed.grossPay) &&
      moneyToCents(item.totalDeductions) === moneyToCents(computed.totalDeductions) &&
      moneyToCents(item.netPay) === moneyToCents(computed.netPay) &&
      item.currency === 'SAR'
    );
  } catch {
    return false;
  }
};

const loadActiveDefinitions = async (
  client: any,
  companyId: string,
): Promise<ComponentDefinitionInput[]> =>
  client.payrollComponentDefinition.findMany({
    where: { companyId, status: 'active' },
    orderBy: [{ code: 'asc' }],
  });

const loadAppliedAdjustments = async (
  client: any,
  companyId: string,
  periodId: string,
): Promise<AdjustmentInput[]> =>
  client.payrollItemAdjustment.findMany({
    where: { companyId, payrollPeriodId: periodId, status: 'applied' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

const verifyStoredCalculation = async (
  client: any,
  period: any,
  items: any[],
  permissions: string[]
): Promise<void> => {
  const resolved = await resolvePayrollInputs(client, period);
  if (resolved.issues.length > 0) {
    throw new PayrollRequestError(
      409,
      'PAYROLL_ELIGIBILITY_BLOCKED',
      'تعذر اعتماد الرواتب حتى معالجة بيانات الموظفين والرواتب',
      publicIssues(resolved.issues, permissions)
    );
  }
  const definitions = await loadActiveDefinitions(client, period.companyId);
  const adjustments = await loadAppliedAdjustments(client, period.companyId, period.id);
  const fingerprint = calculationFingerprint(period, resolved.inputs, definitions, adjustments);
  if (!period.calculationFingerprint || period.calculationFingerprint !== fingerprint) {
    throw new PayrollRequestError(
      409,
      'PAYROLL_CALCULATION_STALE',
      'تغيرت مدخلات الرواتب ويجب إعادة الاحتساب قبل الاعتماد'
    );
  }
  const consistent = items.length === resolved.inputs.length &&
    resolved.inputs.every((input) => {
      const item = items.find((candidate) => candidate.employeeId === input.employee.id);
      return item != null && itemMatchesInput(item, input, definitions, adjustments);
    });
  if (!consistent) {
    throw new PayrollRequestError(
      409,
      'PAYROLL_ITEMS_INCONSISTENT',
      'عناصر الرواتب الحالية غير متطابقة وتتطلب مراجعة إدارية'
    );
  }
};

const sendError = (res: Response, error: unknown): Response => {
  if (error instanceof PayrollRequestError) {
    return res.status(error.status).json({
      error: error.errorCode,
      message: error.message,
      code: error.errorCode,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  return res.status(500).json({
    error: 'PayrollOperationFailed',
    message: 'تعذر إكمال عملية الرواتب حالياً',
    code: 'PAYROLL_OPERATION_FAILED',
  });
};

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';

export function registerPayrollRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
}: PayrollRouteDeps): void {
  app.get(
    '/api/payroll/periods',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_VIEW),
    async (req: PayrollRequest, res) => {
      try {
        const periods = await prisma.payrollPeriod.findMany({
          where: { companyId: req.user!.companyId },
          orderBy: [{ year: 'desc' }, { month: 'desc' }],
        });
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        const shaped = await Promise.all(periods.map(async (period) => {
          const items = await loadPeriodItems(prisma, req.user!.companyId, period.id);
          return periodWithPrivacy(
            period,
            items,
            req.user!.permissions,
            primaryOwnerUserId,
          );
        }));
        return res.json(shaped);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/payroll/periods',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_MANAGE),
    async (req: PayrollRequest, res) => {
      const body = validateBody(payrollPeriodSchema, req, res);
      if (!body) return;
      try {
        const period = await prisma.$transaction(async (tx) => {
          const duplicate = await tx.payrollPeriod.findFirst({
            where: { companyId: req.user!.companyId, year: body.year, month: body.month },
          });
          if (duplicate) {
            throw new PayrollRequestError(
              409,
              'PAYROLL_PERIOD_EXISTS',
              'فترة الرواتب موجودة مسبقاً'
            );
          }
          const created = await tx.payrollPeriod.create({
            data: {
              companyId: req.user!.companyId,
              month: body.month,
              year: body.year,
              status: 'draft',
              createdByUserId: req.user!.id,
            },
          });
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'payroll.period.create',
            details: { periodId: created.id },
          });
          return created;
        });
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        return res.status(201).json(periodWithPrivacy(
          period,
          [],
          req.user!.permissions,
          primaryOwnerUserId,
        ));
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return sendError(res, new PayrollRequestError(
            409,
            'PAYROLL_PERIOD_EXISTS',
            'فترة الرواتب موجودة مسبقاً'
          ));
        }
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/payroll/periods/:id/calculate',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_MANAGE),
    async (req: PayrollRequest, res) => {
      const body = validateBody(payrollCalculationSchema, req, res);
      if (!body) return;
      try {
        const result = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "PayrollPeriod"
            WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId}
            FOR UPDATE
          `;
          const period = await tx.payrollPeriod.findFirst({
            where: { id: req.params.id, companyId: req.user!.companyId },
          });
          if (!period) {
            throw new PayrollRequestError(404, 'PAYROLL_PERIOD_NOT_FOUND', 'فترة الرواتب غير موجودة');
          }
          if (period.status === 'approved' || period.status === 'paid') {
            throw new PayrollRequestError(
              409,
              'PAYROLL_PERIOD_IMMUTABLE',
              'لا يمكن تعديل فترة رواتب معتمدة أو مدفوعة'
            );
          }
          if (period.status !== 'draft' && period.status !== 'calculated') {
            throw new PayrollRequestError(409, 'PAYROLL_INVALID_STATUS', 'حالة فترة الرواتب لا تسمح بالاحتساب');
          }

          const resolved = await resolvePayrollInputs(tx, period);
          if (resolved.issues.length > 0) {
            const details = publicIssues(resolved.issues, req.user!.permissions);
            throw new PayrollRequestError(
              409,
              'PAYROLL_ELIGIBILITY_BLOCKED',
              'تعذر احتساب الرواتب حتى معالجة بيانات الموظفين والرواتب',
              details
            );
          }

          // W1B regulated features remain fail-closed / not applied.
          void probeW1bUnsupported('overtime');
          void probeW1bUnsupported('gosi');
          void probeW1bUnsupported('attendance_auto_deduction');

          const definitions = await loadActiveDefinitions(tx, period.companyId);
          const adjustments = await loadAppliedAdjustments(tx, period.companyId, period.id);
          const fingerprint = calculationFingerprint(
            period,
            resolved.inputs,
            definitions,
            adjustments,
          );
          const existingItems = await loadPeriodItems(tx, period.companyId, period.id);
          if (period.status === 'calculated' && period.calculationFingerprint === fingerprint) {
            const consistent = existingItems.length === resolved.inputs.length &&
              resolved.inputs.every((input) => {
                const item = existingItems.find((candidate) => candidate.employeeId === input.employee.id);
                return item != null && itemMatchesInput(item, input, definitions, adjustments);
              });
            if (!consistent) {
              throw new PayrollRequestError(
                409,
                'PAYROLL_ITEMS_INCONSISTENT',
                'عناصر الرواتب الحالية غير متطابقة وتتطلب مراجعة إدارية'
              );
            }
            return { period, idempotent: true, recalculated: false };
          }

          const recalculated = period.status === 'calculated';
          if (recalculated && !body.recalculationReason) {
            throw new PayrollRequestError(
              409,
              'PAYROLL_RECALCULATION_REASON_REQUIRED',
              'سبب إعادة احتساب الرواتب مطلوب'
            );
          }
          if (!recalculated && existingItems.length > 0) {
            throw new PayrollRequestError(
              409,
              'PAYROLL_ITEMS_INCONSISTENT',
              'توجد عناصر رواتب غير متوقعة في فترة المسودة'
            );
          }

          const computedByEmployee = new Map<string, ReturnType<typeof computeEmployeePay>>();
          for (const input of resolved.inputs) {
            const employeeAdjustments = adjustments.filter(
              (row) => row.employeeId === input.employee.id,
            );
            try {
              computedByEmployee.set(
                input.employee.id,
                computeEmployeePay(input.baseSalary, definitions, employeeAdjustments),
              );
            } catch (error) {
              if (error instanceof Error && error.message === 'NET_PAY_NEGATIVE') {
                throw new PayrollRequestError(
                  409,
                  'PAYROLL_NET_NEGATIVE',
                  'صافي الراتب لا يمكن أن يكون سالباً بعد البدلات والخصومات',
                  { employeeId: input.employee.id },
                );
              }
              throw error;
            }
          }

          if (recalculated) {
            // Detach adjustments from old PayrollItem IDs before delete (FK ON DELETE RESTRICT).
            await tx.payrollItemAdjustment.updateMany({
              where: {
                companyId: period.companyId,
                payrollPeriodId: period.id,
                payrollItemId: { not: null },
              },
              data: { payrollItemId: null },
            });
            await tx.payrollItemComponentLine.deleteMany({
              where: { companyId: period.companyId, payrollPeriodId: period.id },
            });
            await tx.payrollItem.deleteMany({
              where: { companyId: period.companyId, payrollPeriodId: period.id },
            });
          }
          const calculatedAt = new Date();
          await tx.payrollItem.createMany({
            data: resolved.inputs.map((input) => {
              const computed = computedByEmployee.get(input.employee.id)!;
              return {
                companyId: period.companyId,
                payrollPeriodId: period.id,
                employeeId: input.employee.id,
                salaryRecordId: input.salaryRecord.id,
                employeeNameSnapshot: input.employee.user?.name ?? 'موظف',
                employeeNumSnapshot: input.employee.employeeNum,
                departmentNameSnapshot: input.employee.department?.name ?? null,
                baseSalary: computed.baseSalary,
                grossPay: computed.grossPay,
                totalDeductions: computed.totalDeductions,
                netPay: computed.netPay,
                currency: 'SAR',
                status: 'calculated',
                calculatedAt,
              };
            }),
          });
          const createdItems = await loadPeriodItems(tx, period.companyId, period.id);
          if (recalculated) {
            // Re-link applied adjustments to the new PayrollItem for the same employee.
            for (const item of createdItems) {
              await tx.payrollItemAdjustment.updateMany({
                where: {
                  companyId: period.companyId,
                  payrollPeriodId: period.id,
                  employeeId: item.employeeId,
                  status: 'applied',
                  payrollItemId: null,
                },
                data: { payrollItemId: item.id },
              });
            }
          }
          const componentRows = [];
          for (const item of createdItems) {
            const computed = computedByEmployee.get(item.employeeId);
            if (!computed) continue;
            for (const line of computed.componentLines) {
              componentRows.push({
                companyId: period.companyId,
                payrollItemId: item.id,
                payrollPeriodId: period.id,
                employeeId: item.employeeId,
                definitionId: line.definitionId,
                definitionCode: line.definitionCode,
                definitionVersion: line.definitionVersion,
                componentType: line.componentType,
                calcMethod: line.calcMethod,
                percentageBasis: line.percentageBasis,
                rateBps: line.rateBps,
                fixedAmountSnapshot: line.fixedAmountSnapshot,
                amount: line.amount,
                currency: 'SAR',
              });
            }
          }
          if (componentRows.length > 0) {
            await tx.payrollItemComponentLine.createMany({ data: componentRows });
          }
          const calculationVersion = recalculated
            ? Math.max(period.calculationVersion ?? 0, 1) + 1
            : 1;
          const updated = await tx.payrollPeriod.update({
            where: { id: period.id },
            data: {
              status: 'calculated',
              calculationVersion,
              calculationFingerprint: fingerprint,
              calculatedByUserId: req.user!.id,
              calculatedAt,
            },
          });
          await writeAuditRequired(tx, {
            companyId: period.companyId,
            userId: req.user!.id,
            action: recalculated ? 'payroll.period.recalculate' : 'payroll.period.calculate',
            details: {
              periodId: period.id,
              calculationVersion,
              itemCount: resolved.inputs.length,
              rulesVersion: CALCULATION_RULES_VERSION,
              ...(recalculated ? { recalculationReasonProvided: true } : {}),
            },
          });
          return { period: updated, idempotent: false, recalculated };
        });

        const items = await loadPeriodItems(prisma, req.user!.companyId, result.period.id);
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        return res.json({
          ...itemsWithPrivacy(
            result.period,
            items,
            req.user!.permissions,
            primaryOwnerUserId,
          ),
          idempotent: result.idempotent,
          recalculated: result.recalculated,
          protectedEmployeeIssues: 0,
        });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.get(
    '/api/payroll/periods/:id/items',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_VIEW),
    async (req: PayrollRequest, res) => {
      try {
        const period = await prisma.payrollPeriod.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
        });
        if (!period) {
          throw new PayrollRequestError(404, 'PAYROLL_PERIOD_NOT_FOUND', 'فترة الرواتب غير موجودة');
        }
        const items = await loadPeriodItems(prisma, req.user!.companyId, period.id);
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        const privacy = ownerFilteredItems(
          items,
          req.user!.permissions,
          primaryOwnerUserId,
        );
        await writeAuditRequired(prisma, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'payroll.items.read',
          details: { periodId: period.id, visibleItemCount: privacy.visibleItems.length },
        });
        return res.json(itemsWithPrivacy(
          period,
          items,
          req.user!.permissions,
          primaryOwnerUserId,
        ));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/payroll/periods/:id/approve',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_APPROVE),
    async (req: PayrollRequest, res) => {
      try {
        const updated = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "PayrollPeriod"
            WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId}
            FOR UPDATE
          `;
          const period = await tx.payrollPeriod.findFirst({
            where: { id: req.params.id, companyId: req.user!.companyId },
          });
          if (!period) {
            throw new PayrollRequestError(404, 'PAYROLL_PERIOD_NOT_FOUND', 'فترة الرواتب غير موجودة');
          }
          if (period.status === 'approved' || period.status === 'paid') {
            throw new PayrollRequestError(
              409,
              'PAYROLL_PERIOD_ALREADY_APPROVED',
              period.status === 'paid' ? 'فترة الرواتب مدفوعة مسبقاً' : 'فترة الرواتب معتمدة مسبقاً'
            );
          }
          if (period.status !== 'calculated') {
            throw new PayrollRequestError(
              409,
              'PAYROLL_PERIOD_NOT_CALCULATED',
              'يجب احتساب فترة الرواتب قبل اعتمادها'
            );
          }
          const items = await loadPeriodItems(tx, period.companyId, period.id);
          if (items.length === 0) {
            throw new PayrollRequestError(
              409,
              'PAYROLL_ITEMS_REQUIRED',
              'لا يمكن اعتماد فترة رواتب بلا عناصر محتسبة'
            );
          }
          if (!period.calculatedByUserId) {
            throw new PayrollRequestError(
              409,
              'PAYROLL_CALCULATOR_MISSING',
              'بيانات منفذ احتساب الرواتب غير مكتملة'
            );
          }
          if (period.calculatedByUserId === req.user!.id) {
            throw new PayrollRequestError(
              409,
              'PAYROLL_SELF_APPROVAL_FORBIDDEN',
              'لا يمكن لمن احتسب الرواتب اعتماد الاحتساب نفسه'
            );
          }
          await verifyStoredCalculation(tx, period, items, req.user!.permissions);
          const approvedAt = new Date();
          const approved = await tx.payrollPeriod.update({
            where: { id: period.id },
            data: {
              status: 'approved',
              approvedByUserId: req.user!.id,
              approvedAt,
            },
          });
          await writeAuditRequired(tx, {
            companyId: period.companyId,
            userId: req.user!.id,
            action: 'payroll.period.approve',
            details: { periodId: period.id, calculationVersion: period.calculationVersion },
          });
          return approved;
        });
        return res.json({
          period: periodShape(updated, false),
          message: 'تم اعتماد فترة الرواتب',
        });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/payroll/periods/:id/mark-paid',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_PAY),
    async (req: PayrollRequest, res) => {
      try {
        const updated = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "PayrollPeriod"
            WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId}
            FOR UPDATE
          `;
          const period = await tx.payrollPeriod.findFirst({
            where: { id: req.params.id, companyId: req.user!.companyId },
          });
          if (!period) {
            throw new PayrollRequestError(404, 'PAYROLL_PERIOD_NOT_FOUND', 'فترة الرواتب غير موجودة');
          }
          if (period.status === 'paid') {
            // Idempotent compatibility for already-paid legacy periods.
            return period;
          }
          if (period.status === 'approved') {
            throw new PayrollRequestError(
              409,
              'PAYROLL_MARK_PAID_USE_V2_PAYMENTS',
              'Use /api/v2/payroll/periods/:id/payments to record payments for approved periods'
            );
          }
          throw new PayrollRequestError(
            409,
            'PAYROLL_PERIOD_NOT_APPROVED',
            'يجب اعتماد فترة الرواتب قبل تأكيد الدفع'
          );
        });
        return res.json({
          period: periodShape(updated, false),
          message: 'تم تأكيد حالة الدفع إدارياً',
          bankTransferProof: false,
        });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.get(
    '/api/payroll/report',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_REPORT),
    async (req: PayrollRequest, res) => {
      const query = validateQuery(payrollReportQuerySchema, req, res);
      if (!query) return;
      try {
        const payload = await buildPayrollReport(prisma, req.user!, query.periodId);
        await writeAuditRequired(prisma, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'payroll.report.read',
          details: { periodId: payload.period.id, visibleRowCount: payload.rows.length },
        });
        return res.json(payload);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );
}
