import { randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { loadPrimaryOwnerUserId } from './authorization';
import {
  centsToAuditString,
  centsToMoney,
  isExactMoneyDecimalString,
  moneyToCents,
  normalizeMoney,
} from './payrollMoney';
import {
  computeEmployeePay,
  type ComponentDefinitionInput,
} from './payrollComponentsCalc';
import { PERMISSIONS } from './permissions';

interface PayrollUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface PayrollRequest extends Request {
  user?: PayrollUser;
}

interface PayrollW1aRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
}

class PayrollW1aError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const idempotencyKeySchema = z.string().trim().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/);

/** W1A mutation money: exact decimal strings only (reject JSON numbers). */
const exactPositiveMoneyStringSchema = z.string().superRefine((value, ctx) => {
  if (!isExactMoneyDecimalString(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'المبلغ يجب أن يكون نصاً عشرياً دقيقاً (مثال: "100.00") ضمن DECIMAL(18,2)',
    });
    return;
  }
  const normalized = normalizeMoney(value);
  if (!normalized || moneyToCents(normalized) <= 0n) {
    ctx.addIssue({ code: 'custom', message: 'المبلغ يجب أن يكون موجباً وبمنزلتين عشريتين' });
  }
});

export const payrollReopenConfirmationPhrase = (year: number, month: number): string =>
  `REOPEN-${year}-${String(month).padStart(2, '0')}`;

const createComponentSchema = z.strictObject({
  code: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(200),
  componentType: z.enum(['allowance', 'deduction']),
  calcMethod: z.enum(['fixed', 'percentage']),
  fixedAmount: exactPositiveMoneyStringSchema.optional(),
  rateBps: z.number().int().min(1).max(100000).optional(),
  percentageBasis: z.literal('base_salary').optional(),
  currency: z.string().trim().length(3).default('SAR'),
}).superRefine((value, ctx) => {
  if (value.calcMethod === 'fixed') {
    if (value.fixedAmount == null) {
      ctx.addIssue({ code: 'custom', path: ['fixedAmount'], message: 'المبلغ الثابت مطلوب' });
    }
    if (value.rateBps != null || value.percentageBasis != null) {
      ctx.addIssue({ code: 'custom', message: 'لا تستخدم النسبة مع الطريقة الثابتة' });
    }
  }
  if (value.calcMethod === 'percentage') {
    if (value.rateBps == null) {
      ctx.addIssue({ code: 'custom', path: ['rateBps'], message: 'نقاط الأساس مطلوبة' });
    }
    if (value.percentageBasis !== 'base_salary') {
      ctx.addIssue({
        code: 'custom',
        path: ['percentageBasis'],
        message: 'أساس النسبة المدعوم هو base_salary فقط',
      });
    }
    if (value.fixedAmount != null) {
      ctx.addIssue({ code: 'custom', message: 'لا تستخدم مبلغاً ثابتاً مع النسبة' });
    }
  }
  if (value.currency.toUpperCase() !== 'SAR') {
    ctx.addIssue({ code: 'custom', path: ['currency'], message: 'العملة المدعومة هي SAR فقط' });
  }
});

const patchComponentSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  calcMethod: z.enum(['fixed', 'percentage']).optional(),
  fixedAmount: exactPositiveMoneyStringSchema.nullable().optional(),
  rateBps: z.number().int().min(1).max(100000).nullable().optional(),
  percentageBasis: z.literal('base_salary').nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'لا توجد حقول للتحديث');

const adjustSchema = z.strictObject({
  direction: z.enum(['allowance', 'deduction']),
  amount: exactPositiveMoneyStringSchema,
  reason: z.string().trim().min(1).max(500),
});

const reopenSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
  confirm: z.literal(true),
  confirmationPhrase: z.string().trim().min(1).max(40),
});

const postToLedgerSchema = z.strictObject({
  expenseAccountId: z.string().trim().min(1).max(100),
  payableAccountId: z.string().trim().min(1).max(100),
  deductionAccountId: z.string().trim().min(1).max(100).optional(),
});

const fail = (status: number, code: string, message: string, details?: Record<string, unknown>): never => {
  throw new PayrollW1aError(status, code, message, details);
};

const iso = (value: Date | string | null | undefined): string | null =>
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

const requireIdempotencyKey = (req: Request): string => {
  const raw = req.header('Idempotency-Key') ?? req.header('idempotency-key');
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'مفتاح التكرار مطلوب وصالح');
  return parsed.data;
};

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    fail(400, 'VALIDATION_ERROR', 'بيانات الطلب غير صالحة', {
      fieldErrors: parsed.error.flatten().fieldErrors,
    });
  }
  return parsed.data;
};

const sendError = (res: Response, error: unknown): Response => {
  if (error instanceof PayrollW1aError) {
    return res.status(error.status).json({
      error: error.code,
      message: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  return res.status(500).json({
    error: 'PayrollW1aOperationFailed',
    message: 'تعذر إكمال عملية الرواتب حالياً',
    code: 'PAYROLL_W1A_OPERATION_FAILED',
  });
};

const route = (
  handler: (req: PayrollRequest, res: Response) => Promise<unknown>,
): RequestHandler => async (req, res) => {
  try {
    await handler(req as PayrollRequest, res);
  } catch (error) {
    sendError(res, error);
  }
};

const componentShape = (row: any) => ({
  id: row.id,
  companyId: row.companyId,
  code: row.code,
  name: row.name,
  componentType: row.componentType,
  calcMethod: row.calcMethod,
  fixedAmount: row.fixedAmount == null
    ? null
    : (normalizeMoney(row.fixedAmount) ?? row.fixedAmount.toString()),
  rateBps: row.rateBps ?? null,
  percentageBasis: row.percentageBasis ?? null,
  version: row.version,
  status: row.status,
  currency: row.currency,
  archivedAt: iso(row.archivedAt),
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

const adjustmentShape = (row: any, redact: boolean) => ({
  id: row.id,
  payrollPeriodId: row.payrollPeriodId,
  employeeId: row.employeeId,
  payrollItemId: row.payrollItemId ?? null,
  direction: row.direction,
  amount: redact ? null : (normalizeMoney(row.amount) ?? row.amount.toString()),
  reason: redact ? null : row.reason,
  status: row.status,
  createdAt: iso(row.createdAt),
  redacted: redact,
});

const materialComponentChange = (existing: any, body: z.infer<typeof patchComponentSchema>) => {
  const nextMethod = body.calcMethod ?? existing.calcMethod;
  const nextFixed = body.fixedAmount !== undefined
    ? body.fixedAmount
    : existing.fixedAmount;
  const nextRate = body.rateBps !== undefined ? body.rateBps : existing.rateBps;
  const nextBasis = body.percentageBasis !== undefined
    ? body.percentageBasis
    : existing.percentageBasis;
  const fixedChanged = normalizeMoney(nextFixed ?? '') !== normalizeMoney(existing.fixedAmount ?? '');
  return (
    nextMethod !== existing.calcMethod
    || fixedChanged
    || nextRate !== existing.rateBps
    || nextBasis !== existing.percentageBasis
  );
};

export function registerPayrollW1aRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
}: PayrollW1aRouteDeps): void {
  app.get(
    '/api/v2/payroll/component-definitions',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_VIEW),
    route(async (req, res) => {
      const rows = await prisma.payrollComponentDefinition.findMany({
        where: { companyId: req.user!.companyId },
        orderBy: [{ code: 'asc' }],
      });
      return res.json(rows.map(componentShape));
    }),
  );

  app.post(
    '/api/v2/payroll/component-definitions',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_MANAGE),
    route(async (req, res) => {
      const body = parseBody(createComponentSchema, req.body);
      const created = await prisma.$transaction(async (tx) => {
        const duplicate = await tx.payrollComponentDefinition.findFirst({
          where: { companyId: req.user!.companyId, code: body.code },
        });
        if (duplicate) fail(409, 'COMPONENT_CODE_EXISTS', 'رمز المكوّن مستخدم مسبقاً');
        const row = await tx.payrollComponentDefinition.create({
          data: {
            id: randomUUID(),
            companyId: req.user!.companyId,
            code: body.code,
            name: body.name,
            componentType: body.componentType,
            calcMethod: body.calcMethod,
            fixedAmount: body.calcMethod === 'fixed'
              ? normalizeMoney(body.fixedAmount!)
              : null,
            rateBps: body.calcMethod === 'percentage' ? body.rateBps! : null,
            percentageBasis: body.calcMethod === 'percentage' ? 'base_salary' : null,
            version: 1,
            status: 'active',
            currency: 'SAR',
            createdByUserId: req.user!.id,
          },
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'payroll.component.create',
          details: {
            componentDefinitionId: row.id,
            componentType: row.componentType,
            calcMethod: row.calcMethod,
            rateBps: row.rateBps ?? undefined,
            percentageBasis: row.percentageBasis ?? undefined,
          },
        });
        return row;
      });
      return res.status(201).json(componentShape(created));
    }),
  );

  app.patch(
    '/api/v2/payroll/component-definitions/:id',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_MANAGE),
    route(async (req, res) => {
      const body = parseBody(patchComponentSchema, req.body);
      const updated = await prisma.$transaction(async (tx) => {
        const existing = await tx.payrollComponentDefinition.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
        });
        if (!existing) fail(404, 'COMPONENT_NOT_FOUND', 'مكوّن الرواتب غير موجود');
        if (existing.status !== 'active') fail(409, 'COMPONENT_ARCHIVED', 'لا يمكن تعديل مكوّن مؤرشف');

        const nextMethod = body.calcMethod ?? existing.calcMethod;
        let fixedAmount: string | null = existing.fixedAmount == null
          ? null
          : (normalizeMoney(existing.fixedAmount) ?? existing.fixedAmount.toString());
        let rateBps = existing.rateBps;
        let percentageBasis = existing.percentageBasis;
        if (nextMethod === 'fixed') {
          if (body.fixedAmount !== undefined) {
            fixedAmount = body.fixedAmount == null ? null : normalizeMoney(body.fixedAmount);
          }
          if (fixedAmount == null) fail(400, 'VALIDATION_ERROR', 'المبلغ الثابت مطلوب');
          rateBps = null;
          percentageBasis = null;
        } else {
          if (body.rateBps !== undefined) rateBps = body.rateBps;
          percentageBasis = 'base_salary';
          if (rateBps == null) fail(400, 'VALIDATION_ERROR', 'نقاط الأساس مطلوبة');
          fixedAmount = null;
        }

        const bumpVersion = materialComponentChange(existing, body);
        const row = await tx.payrollComponentDefinition.update({
          where: { id: existing.id },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            calcMethod: nextMethod,
            fixedAmount,
            rateBps,
            percentageBasis,
            ...(bumpVersion ? { version: existing.version + 1 } : {}),
          },
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'payroll.component.update',
          details: {
            componentDefinitionId: row.id,
            calcMethod: row.calcMethod,
            rateBps: row.rateBps ?? undefined,
            percentageBasis: row.percentageBasis ?? undefined,
          },
        });
        return row;
      });
      return res.json(componentShape(updated));
    }),
  );

  app.post(
    '/api/v2/payroll/component-definitions/:id/archive',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_MANAGE),
    route(async (req, res) => {
      const updated = await prisma.$transaction(async (tx) => {
        const existing = await tx.payrollComponentDefinition.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
        });
        if (!existing) fail(404, 'COMPONENT_NOT_FOUND', 'مكوّن الرواتب غير موجود');
        if (existing.status === 'archived') return existing;
        const row = await tx.payrollComponentDefinition.update({
          where: { id: existing.id },
          data: {
            status: 'archived',
            archivedAt: new Date(),
            archivedByUserId: req.user!.id,
          },
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'payroll.component.archive',
          details: { componentDefinitionId: row.id },
        });
        return row;
      });
      return res.json(componentShape(updated));
    }),
  );

  const sameAdjustmentPayload = (
    row: {
      payrollPeriodId: string;
      employeeId: string;
      payrollItemId: string | null;
      direction: string;
      amount: { toString(): string } | string;
      reason: string;
    },
    expected: {
      periodId: string;
      employeeId: string;
      payrollItemId: string;
      direction: string;
      amount: string;
      reason: string;
    },
  ): boolean =>
    row.payrollPeriodId === expected.periodId
    && row.employeeId === expected.employeeId
    && row.payrollItemId === expected.payrollItemId
    && row.direction === expected.direction
    && normalizeMoney(row.amount) === expected.amount
    && row.reason === expected.reason;

  const computePayWithAdjustments = async (
    client: PrismaClient | any,
    companyId: string,
    periodId: string,
    item: any,
    extraAdjustments: Array<{
      id: string;
      employeeId: string;
      direction: string;
      amount: string;
      status: string;
    }> = [],
  ) => {
    const definitions = await client.payrollComponentDefinition.findMany({
      where: { companyId, status: 'active' },
    }) as ComponentDefinitionInput[];
    const existingAdjustments = await client.payrollItemAdjustment.findMany({
      where: {
        companyId,
        payrollPeriodId: periodId,
        employeeId: item.employeeId,
        status: 'applied',
      },
    });
    try {
      return computeEmployeePay(
        normalizeMoney(item.baseSalary) ?? item.baseSalary.toString(),
        definitions,
        [...existingAdjustments, ...extraAdjustments],
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'NET_PAY_NEGATIVE') {
        fail(409, 'PAYROLL_NET_NEGATIVE', 'صافي الراتب لا يمكن أن يكون سالباً بعد التعديل');
      }
      throw error;
    }
  };

  app.post(
    '/api/v2/payroll/periods/:id/items/:itemId/adjust/preview',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_ITEM_ADJUST),
    route(async (req, res) => {
      const body = parseBody(adjustSchema, req.body);
      const period = await prisma.payrollPeriod.findFirst({
        where: { id: req.params.id, companyId: req.user!.companyId },
      });
      if (!period) fail(404, 'PAYROLL_PERIOD_NOT_FOUND', 'فترة الرواتب غير موجودة');
      if (period.status !== 'calculated') {
        fail(409, 'PAYROLL_ADJUST_NOT_ALLOWED', 'التعديل مسموح فقط قبل الاعتماد على فترة محتسبة');
      }
      if (period.status === 'paid' || period.paidAt) {
        fail(409, 'PAYROLL_PERIOD_PAID', 'لا يمكن التعديل على فترة مدفوعة');
      }
      if (period.ledgerPostedAt || period.ledgerPostingId) {
        fail(409, 'PAYROLL_LEDGER_POSTED', 'لا يمكن التعديل بعد الترحيل إلى دفتر اليومية');
      }
      const item = await prisma.payrollItem.findFirst({
        where: {
          id: req.params.itemId,
          companyId: req.user!.companyId,
          payrollPeriodId: period.id,
        },
        include: {
          employee: {
            select: {
              user: { select: { id: true, role: { select: { permissions: true } } } },
            },
          },
        },
      });
      if (!item) fail(404, 'PAYROLL_ITEM_NOT_FOUND', 'عنصر الرواتب غير موجود');

      const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
      const ownerProtected = isOwnerEmployee(item.employee, primaryOwnerUserId)
        && !hasOwnerSalaryPermission(req.user!.permissions);
      const amount = normalizeMoney(body.amount)!;
      const computed = await computePayWithAdjustments(
        prisma,
        req.user!.companyId,
        period.id,
        item,
        [{
          id: 'preview',
          employeeId: item.employeeId,
          direction: body.direction,
          amount,
          status: 'applied',
        }],
      );
      return res.json({
        preview: true,
        direction: body.direction,
        amount: ownerProtected ? null : amount,
        resultingGross: ownerProtected ? null : computed.grossPay,
        resultingDeductions: ownerProtected ? null : computed.totalDeductions,
        resultingNet: ownerProtected ? null : computed.netPay,
        redacted: ownerProtected,
        requiresRecalculation: true,
      });
    }),
  );

  app.post(
    '/api/v2/payroll/periods/:id/items/:itemId/adjust',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_ITEM_ADJUST),
    route(async (req, res) => {
      const idempotencyKey = requireIdempotencyKey(req);
      const body = parseBody(adjustSchema, req.body);
      const amount = normalizeMoney(body.amount)!;

      // Serialize all same-company Idempotency-Key attempts before period lock/insert.
      // Cross-period concurrent same-key races cannot recover safely inside a TX after P2002
      // (PostgreSQL aborts the failed transaction), so avoid in-TX unique-violation recovery.
      const result = await prisma.$transaction(async (tx) => {
        const advisoryKey = `payroll-item-adjust-idem:${req.user!.companyId}:${idempotencyKey}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${advisoryKey}))`;

        await tx.$queryRaw`
          SELECT "id" FROM "PayrollPeriod"
          WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId}
          FOR UPDATE
        `;
        const period = await tx.payrollPeriod.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
        });
        if (!period) fail(404, 'PAYROLL_PERIOD_NOT_FOUND', 'فترة الرواتب غير موجودة');
        if (period.status !== 'calculated') {
          fail(409, 'PAYROLL_ADJUST_NOT_ALLOWED', 'التعديل مسموح فقط قبل الاعتماد على فترة محتسبة');
        }
        if (period.status === 'paid' || period.paidAt) {
          fail(409, 'PAYROLL_PERIOD_PAID', 'لا يمكن التعديل على فترة مدفوعة');
        }
        if (period.ledgerPostedAt || period.ledgerPostingId) {
          fail(409, 'PAYROLL_LEDGER_POSTED', 'لا يمكن التعديل بعد الترحيل إلى دفتر اليومية');
        }

        const item = await tx.payrollItem.findFirst({
          where: {
            id: req.params.itemId,
            companyId: req.user!.companyId,
            payrollPeriodId: period.id,
          },
          include: {
            employee: {
              select: {
                user: { select: { id: true, role: { select: { permissions: true } } } },
              },
            },
          },
        });
        if (!item) fail(404, 'PAYROLL_ITEM_NOT_FOUND', 'عنصر الرواتب غير موجود');

        const expected = {
          periodId: period.id,
          employeeId: item.employeeId,
          payrollItemId: item.id,
          direction: body.direction,
          amount,
          reason: body.reason,
        };

        const existingByKey = await tx.payrollItemAdjustment.findFirst({
          where: { companyId: req.user!.companyId, idempotencyKey },
        });
        if (existingByKey) {
          if (!sameAdjustmentPayload(existingByKey, expected)) {
            fail(409, 'IDEMPOTENCY_CONFLICT', 'مفتاح التكرار مستخدم لطلب تعديل مختلف');
          }
          return { row: existingByKey, item, idempotent: true };
        }

        // Re-validate net after lock (authoritative preview inside TX).
        await computePayWithAdjustments(tx, req.user!.companyId, period.id, item, [{
          id: 'preview',
          employeeId: item.employeeId,
          direction: body.direction,
          amount,
          status: 'applied',
        }]);

        const row = await tx.payrollItemAdjustment.create({
          data: {
            id: randomUUID(),
            companyId: req.user!.companyId,
            payrollPeriodId: period.id,
            employeeId: item.employeeId,
            payrollItemId: item.id,
            direction: body.direction,
            amount,
            reason: body.reason,
            createdByUserId: req.user!.id,
            status: 'applied',
            idempotencyKey,
          },
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'payroll.item.adjust',
          details: {
            adjustmentId: row.id,
            periodId: period.id,
            payrollItemId: item.id,
            direction: body.direction,
            reasonProvided: true,
            amountCents: centsToAuditString(moneyToCents(amount)),
            idempotent: false,
          },
        });
        return { row, item, idempotent: false };
      });

      const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
      const ownerProtected = isOwnerEmployee(result.item.employee, primaryOwnerUserId)
        && !hasOwnerSalaryPermission(req.user!.permissions);
      // Applied adjustments already include this row — do not add a second preview copy.
      const computed = await computePayWithAdjustments(
        prisma,
        req.user!.companyId,
        result.row.payrollPeriodId,
        result.item,
      );

      return res.status(result.idempotent ? 200 : 201).json({
        idempotent: result.idempotent,
        adjustment: adjustmentShape(result.row, ownerProtected),
        requiresRecalculation: true,
        resultingGross: ownerProtected ? null : computed.grossPay,
        resultingDeductions: ownerProtected ? null : computed.totalDeductions,
        resultingNet: ownerProtected ? null : computed.netPay,
        redacted: ownerProtected,
      });
    }),
  );

  app.post(
    '/api/v2/payroll/periods/:id/reopen',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_PERIOD_REOPEN),
    route(async (req, res) => {
      const body = parseBody(reopenSchema, req.body);
      const updated = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "PayrollPeriod"
          WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId}
          FOR UPDATE
        `;
        const period = await tx.payrollPeriod.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
        });
        if (!period) fail(404, 'PAYROLL_PERIOD_NOT_FOUND', 'فترة الرواتب غير موجودة');
        if (period.status === 'paid' || period.paidAt) {
          fail(409, 'PAYROLL_PERIOD_PAID', 'لا يمكن إعادة فتح فترة مدفوعة');
        }
        if (period.ledgerPostedAt || period.ledgerPostingId) {
          fail(409, 'PAYROLL_LEDGER_POSTED', 'لا يمكن إعادة فتح فترة مرحّلة إلى الدفتر');
        }
        if (period.status !== 'approved') {
          fail(409, 'PAYROLL_REOPEN_NOT_ALLOWED', 'إعادة الفتح مسموحة فقط من حالة معتمدة');
        }
        const expectedPhrase = payrollReopenConfirmationPhrase(period.year, period.month);
        if (body.confirmationPhrase !== expectedPhrase) {
          fail(400, 'REOPEN_CONFIRMATION_MISMATCH', 'عبارة التأكيد غير مطابقة لفترة الرواتب');
        }
        const row = await tx.payrollPeriod.update({
          where: { id: period.id },
          data: {
            status: 'calculated',
            approvedByUserId: null,
            approvedAt: null,
            reopenedByUserId: req.user!.id,
            reopenedAt: new Date(),
            reopenReason: body.reason,
          },
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'payroll.period.reopen',
          details: {
            periodId: period.id,
            previousStatus: 'approved',
            newStatus: 'calculated',
            confirmationProvided: true,
            reopenReasonProvided: true,
            calculationVersion: period.calculationVersion,
          },
        });
        return row;
      });
      return res.json({
        id: updated.id,
        status: updated.status,
        calculationVersion: updated.calculationVersion,
        reopenedAt: iso(updated.reopenedAt),
        message: 'تم إعادة فتح فترة الرواتب للاعتماد من جديد',
      });
    }),
  );

  app.post(
    '/api/v2/payroll/periods/:id/post-to-ledger',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_APPROVE, PERMISSIONS.FINANCE_MANAGE),
    route(async (req, res) => {
      const idempotencyKey = requireIdempotencyKey(req);
      const body = parseBody(postToLedgerSchema, req.body);
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "PayrollPeriod"
          WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId}
          FOR UPDATE
        `;
        const period = await tx.payrollPeriod.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
        });
        if (!period) fail(404, 'PAYROLL_PERIOD_NOT_FOUND', 'فترة الرواتب غير موجودة');
        if (period.status !== 'approved' && period.status !== 'paid') {
          fail(409, 'PAYROLL_PERIOD_NOT_APPROVED', 'يجب اعتماد الفترة قبل الترحيل إلى الدفتر');
        }

        const existingByKey = await tx.payrollLedgerPosting.findFirst({
          where: { companyId: req.user!.companyId, idempotencyKey },
        });
        if (existingByKey) {
          if (
            existingByKey.payrollPeriodId === period.id
            && existingByKey.calculationVersion === period.calculationVersion
          ) {
            const journal = await tx.journalEntry.findFirst({
              where: { id: existingByKey.journalEntryId, companyId: req.user!.companyId },
            });
            const lines = journal
              ? await tx.journalEntryLine.findMany({
                  where: { companyId: req.user!.companyId, journalEntryId: journal.id },
                  orderBy: [{ lineNo: 'asc' }],
                })
              : [];
            return { posting: existingByKey, journal, lines, idempotent: true };
          }
          fail(409, 'IDEMPOTENCY_CONFLICT', 'مفتاح التكرار مستخدم لترحيل آخر');
        }

        const existingVersion = await tx.payrollLedgerPosting.findFirst({
          where: {
            companyId: req.user!.companyId,
            payrollPeriodId: period.id,
            calculationVersion: period.calculationVersion,
          },
        });
        if (existingVersion) {
          fail(409, 'PAYROLL_ALREADY_LEDGER_POSTED', 'تم ترحيل هذه النسخة الاحتسابية مسبقاً');
        }

        const items = await tx.payrollItem.findMany({
          where: { companyId: req.user!.companyId, payrollPeriodId: period.id },
        });
        if (items.length === 0) fail(409, 'PAYROLL_ITEMS_REQUIRED', 'لا توجد عناصر للترحيل');

        let grossCents = 0n;
        let netCents = 0n;
        let deductionCents = 0n;
        for (const item of items) {
          grossCents += moneyToCents(item.grossPay);
          netCents += moneyToCents(item.netPay);
          deductionCents += moneyToCents(item.totalDeductions);
        }
        if (grossCents !== netCents + deductionCents) {
          fail(409, 'PAYROLL_AMOUNTS_INCONSISTENT', 'مجاميع الرواتب غير متسقة للترحيل');
        }
        if (deductionCents > 0n && !body.deductionAccountId) {
          fail(400, 'DEDUCTION_ACCOUNT_REQUIRED', 'حساب الخصومات مطلوب عند وجود خصومات');
        }

        const expense = await tx.chartOfAccount.findFirst({
          where: { id: body.expenseAccountId, companyId: req.user!.companyId, status: 'active' },
        });
        const payable = await tx.chartOfAccount.findFirst({
          where: { id: body.payableAccountId, companyId: req.user!.companyId, status: 'active' },
        });
        if (!expense || expense.type !== 'Expense') {
          fail(400, 'INVALID_EXPENSE_ACCOUNT', 'حساب المصروف يجب أن يكون من نوع Expense');
        }
        if (!payable || payable.type !== 'Liability') {
          fail(400, 'INVALID_PAYABLE_ACCOUNT', 'حساب المستحقات يجب أن يكون من نوع Liability');
        }
        let deductionAccount = null as any;
        if (body.deductionAccountId) {
          deductionAccount = await tx.chartOfAccount.findFirst({
            where: {
              id: body.deductionAccountId,
              companyId: req.user!.companyId,
              status: 'active',
            },
          });
          if (!deductionAccount || deductionAccount.type !== 'Liability') {
            fail(400, 'INVALID_DEDUCTION_ACCOUNT', 'حساب الخصومات يجب أن يكون من نوع Liability');
          }
        }

        const now = new Date();
        const journalId = randomUUID();
        const lines = [
          {
            lineNo: 1,
            accountId: expense!.id,
            debit: centsToMoney(grossCents),
            credit: '0.00',
          },
          {
            lineNo: 2,
            accountId: payable!.id,
            debit: '0.00',
            credit: centsToMoney(netCents),
          },
        ];
        if (deductionCents > 0n) {
          lines.push({
            lineNo: 3,
            accountId: deductionAccount!.id,
            debit: '0.00',
            credit: centsToMoney(deductionCents),
          });
        }

        const journal = await tx.journalEntry.create({
          data: {
            id: journalId,
            companyId: req.user!.companyId,
            status: 'posted',
            entryDate: now,
            reference: `PAYROLL-${period.year}-${String(period.month).padStart(2, '0')}`,
            memo: `Payroll period ${period.year}-${String(period.month).padStart(2, '0')} posting`,
            currency: 'SAR',
            totalDebit: centsToMoney(grossCents),
            totalCredit: centsToMoney(grossCents),
            postedAt: now,
            postedByUserId: req.user!.id,
            idempotencyKey,
            sourceType: 'payroll',
            sourcePayrollPeriodId: period.id,
            sourceCalculationVersion: period.calculationVersion,
            createdByUserId: req.user!.id,
          },
        });
        await tx.journalEntryLine.createMany({
          data: lines.map((line) => ({
            id: randomUUID(),
            companyId: req.user!.companyId,
            journalEntryId: journal.id,
            lineNo: line.lineNo,
            accountId: line.accountId,
            costCenterId: null,
            debit: line.debit,
            credit: line.credit,
            lineMemo: null,
          })),
        });
        const posting = await tx.payrollLedgerPosting.create({
          data: {
            id: randomUUID(),
            companyId: req.user!.companyId,
            payrollPeriodId: period.id,
            calculationVersion: period.calculationVersion,
            journalEntryId: journal.id,
            postedByUserId: req.user!.id,
            postedAt: now,
            idempotencyKey,
          },
        });
        await tx.payrollPeriod.update({
          where: { id: period.id },
          data: {
            ledgerPostedAt: now,
            ledgerPostingId: posting.id,
          },
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'payroll.ledger.post',
          details: {
            postingId: posting.id,
            journalEntryId: journal.id,
            periodId: period.id,
            calculationVersion: period.calculationVersion,
            debitCents: centsToAuditString(grossCents),
            creditCents: centsToAuditString(grossCents),
            lineCount: lines.length,
            sourceType: 'payroll',
          },
        });
        const storedLines = await tx.journalEntryLine.findMany({
          where: { companyId: req.user!.companyId, journalEntryId: journal.id },
          orderBy: [{ lineNo: 'asc' }],
        });
        return { posting, journal, lines: storedLines, idempotent: false };
      });

      return res.status(result.idempotent ? 200 : 201).json({
        idempotent: result.idempotent,
        postingId: result.posting.id,
        journalEntryId: result.journal?.id ?? result.posting.journalEntryId,
        calculationVersion: result.posting.calculationVersion,
        totalDebit: result.journal
          ? (normalizeMoney(result.journal.totalDebit) ?? result.journal.totalDebit.toString())
          : null,
        totalCredit: result.journal
          ? (normalizeMoney(result.journal.totalCredit) ?? result.journal.totalCredit.toString())
          : null,
        lineCount: result.lines.length,
        // Period-level totals only — never embed employee salary rows.
      });
    }),
  );
}
