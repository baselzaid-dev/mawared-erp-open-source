import { randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { loadPrimaryOwnerUserId } from './authorization';
import { centsToMoney, moneyToCents, normalizeMoney } from './payrollMoney';
import { PERMISSIONS } from './permissions';

interface PayrollPaymentUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface PayrollPaymentRequest extends Request {
  user?: PayrollPaymentUser;
}

interface PayrollPaymentRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
}

class PayrollPaymentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(messageKey);
  }
}

const idempotencyKeySchema = z.string().trim().min(8).max(120)
  .regex(/^[A-Za-z0-9._:-]+$/);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const paymentVersionSchema = z.number().int().min(0);

const recordPaymentSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  currency: z.string().trim().length(3),
  paymentDate: isoDateSchema,
  reference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
  expectedVersion: paymentVersionSchema,
}).strict();

const voidPaymentSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  expectedVersion: paymentVersionSchema,
}).strict();

const fail = (
  status: number,
  code: string,
  messageKey: string,
  fieldErrors?: Record<string, string>,
): never => {
  throw new PayrollPaymentError(status, code, messageKey, fieldErrors);
};

const iso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

const dateOnly = (value: Date | string): string => new Date(value).toISOString().slice(0, 10);

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

const payrollSummary = (items: any[]) => ({
  visibleEmployeeCount: items.length,
  visibleGross: centsToMoney(items.reduce((sum, item) => sum + moneyToCents(item.grossPay), 0n)),
  visibleDeductions: centsToMoney(
    items.reduce((sum, item) => sum + moneyToCents(item.totalDeductions), 0n),
  ),
  visibleNet: centsToMoney(items.reduce((sum, item) => sum + moneyToCents(item.netPay), 0n)),
  currency: items[0]?.currency ?? 'SAR',
});

const ownerFilteredItems = (
  items: any[],
  permissions: string[],
  primaryOwnerUserId: string | null,
) => {
  const ownerItems = items.filter((item) => isOwnerEmployee(item.employee, primaryOwnerUserId));
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

const loadPeriodPayments = async (client: any, companyId: string, periodId: string): Promise<any[]> =>
  client.payrollPayment.findMany({
    where: { companyId, payrollPeriodId: periodId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

const approvedNetTotalCents = (items: any[]): bigint =>
  items.reduce((sum, item) => sum + moneyToCents(item.netPay), 0n);

const postedPaymentsTotalCents = (payments: any[]): bigint =>
  payments
    .filter((payment) => payment.status === 'posted')
    .reduce((sum, payment) => sum + moneyToCents(payment.amount), 0n);

export const derivePaymentState = (
  paidCents: bigint,
  approvedCents: bigint,
): 'unpaid' | 'partially_paid' | 'paid' => {
  if (paidCents <= 0n) return 'unpaid';
  if (paidCents >= approvedCents && approvedCents > 0n) return 'paid';
  if (paidCents >= approvedCents && approvedCents === 0n) return paidCents > 0n ? 'paid' : 'unpaid';
  return 'partially_paid';
};

const numericLabel = (year: number, month: number): string =>
  `${year}-${String(month).padStart(2, '0')}`;

const paymentShape = (payment: any) => ({
  id: payment.id,
  companyId: payment.companyId,
  payrollPeriodId: payment.payrollPeriodId,
  amount: normalizeMoney(payment.amount) ?? payment.amount.toString(),
  currency: payment.currency,
  paymentDate: dateOnly(payment.paymentDate),
  reference: payment.reference ?? null,
  note: payment.note ?? null,
  status: payment.status,
  idempotencyKey: payment.idempotencyKey,
  recordedByUserId: payment.recordedByUserId,
  createdAt: iso(payment.createdAt),
  voidedAt: iso(payment.voidedAt),
  voidedByUserId: payment.voidedByUserId ?? null,
  voidReason: payment.voidReason ?? null,
  isLegacyMigration: Boolean(payment.isLegacyMigration),
});

const periodPaymentShape = (
  period: any,
  items: any[],
  payments: any[],
  permissions: string[],
  primaryOwnerUserId: string | null,
) => {
  const privacy = ownerFilteredItems(items, permissions, primaryOwnerUserId);
  const approvedCents = approvedNetTotalCents(items);
  const paidCents = postedPaymentsTotalCents(payments);
  const paymentState = derivePaymentState(paidCents, approvedCents);
  const legacyWithoutItems = ['approved', 'paid'].includes(period.status) && items.length === 0;
  const hasItems = items.length > 0;

  return {
    id: period.id,
    companyId: period.companyId,
    month: period.month,
    year: period.year,
    status: period.status,
    numericLabel: numericLabel(period.year, period.month),
    paymentState,
    paymentVersion: period.paymentVersion ?? 0,
    calculationVersion: period.calculationVersion ?? 0,
    createdAt: iso(period.createdAt),
    calculatedAt: iso(period.calculatedAt),
    approvedAt: iso(period.approvedAt),
    paidAt: iso(period.paidAt),
    legacyWithoutItems,
    itemCount: privacy.visibleItems.length,
    visibleSummary: hasItems ? payrollSummary(privacy.visibleItems) : null,
    protectedRowsHidden: privacy.protectedRowsHidden,
    protectedRowCount: privacy.protectedRowCount,
    ...(privacy.mayViewOwner && hasItems
      ? {
          approvedNetTotal: centsToMoney(approvedCents),
          fullSummary: payrollSummary(items),
        }
      : {}),
  };
};

const route = (
  handler: (req: PayrollPaymentRequest, res: Response) => Promise<unknown>,
): RequestHandler => async (request, response, next) => {
  try {
    await handler(request as PayrollPaymentRequest, response);
  } catch (error) {
    if (error instanceof PayrollPaymentError) {
      return response.status(error.status).json({
        code: error.code,
        messageKey: error.messageKey,
        ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      });
    }
    if ((error as { code?: string }).code === 'P2002') {
      return response.status(409).json({
        code: 'PAYROLL_PAYMENT_IDEMPOTENCY_CONFLICT',
        messageKey: 'payroll.payments.idempotency_conflict',
      });
    }
    return next(error);
  }
};

const actorFrom = (req: PayrollPaymentRequest): PayrollPaymentUser => {
  if (!req.user?.id || !req.user.companyId) {
    fail(401, 'Unauthorized', 'payroll.payments.unauthorized');
  }
  return req.user!;
};

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail(400, 'InvalidRequest', 'payroll.payments.invalid_request');
  return parsed.data;
};

const requireIdempotencyKey = (req: Request): string => {
  const header = req.header('Idempotency-Key');
  if (header == null || header.trim() === '') {
    fail(400, 'IdempotencyKeyRequired', 'payroll.payments.idempotency_key_required');
  }
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    fail(400, 'IdempotencyKeyInvalid', 'payroll.payments.idempotency_key_invalid');
  }
  return parsed.data;
};

const lockPeriod = async (tx: any, periodId: string, companyId: string) => {
  await tx.$queryRaw`
    SELECT "id" FROM "PayrollPeriod"
    WHERE "id" = ${periodId} AND "companyId" = ${companyId}
    FOR UPDATE
  `;
  return tx.payrollPeriod.findFirst({
    where: { id: periodId, companyId },
  });
};

const assertPayablePeriod = (period: any): void => {
  if (!period) {
    fail(404, 'PayrollPeriodNotFound', 'payroll.payments.period_not_found');
  }
  if (period.status !== 'approved' && period.status !== 'paid') {
    fail(409, 'PayrollPeriodNotPayable', 'payroll.payments.period_not_payable');
  }
};

const assertPaymentVersion = (period: any, expectedVersion: number): void => {
  const current = period.paymentVersion ?? 0;
  if (expectedVersion !== current) {
    fail(412, 'PayrollPaymentVersionMismatch', 'payroll.payments.version_mismatch');
  }
};

const assertItemsPresent = (items: any[]): void => {
  if (items.length === 0) {
    fail(409, 'PayrollItemsRequired', 'payroll.payments.items_required');
  }
};

const validateRecordMoney = (
  amountInput: string | number,
  currencyInput: string,
  items: any[],
): { amount: string; currency: string; amountCents: bigint } => {
  const amount = normalizeMoney(amountInput);
  if (!amount) {
    fail(400, 'InvalidAmount', 'payroll.payments.invalid_amount');
  }
  const amountCents = moneyToCents(amount);
  if (amountCents <= 0n) {
    fail(400, 'InvalidAmount', 'payroll.payments.amount_must_be_positive');
  }
  const currency = currencyInput.trim().toUpperCase();
  if (currency !== 'SAR') {
    fail(400, 'InvalidCurrency', 'payroll.payments.currency_not_supported');
  }
  const itemCurrency = items[0]?.currency?.toUpperCase?.() ?? 'SAR';
  if (itemCurrency !== currency) {
    fail(400, 'InvalidCurrency', 'payroll.payments.currency_mismatch');
  }
  return { amount, currency, amountCents };
};

const applyPaymentStateToPeriod = async (
  tx: any,
  period: any,
  items: any[],
  payments: any[],
  actorUserId: string,
): Promise<any> => {
  const approvedCents = approvedNetTotalCents(items);
  const paidCents = postedPaymentsTotalCents(payments);
  const paymentState = derivePaymentState(paidCents, approvedCents);
  const data: Record<string, unknown> = {};

  if (paymentState === 'paid' && period.status !== 'paid') {
    data.status = 'paid';
    data.paidAt = new Date();
    data.paidByUserId = actorUserId;
  } else if (paymentState !== 'paid' && period.status === 'paid') {
    data.status = 'approved';
    data.paidAt = null;
    data.paidByUserId = null;
  }

  if (Object.keys(data).length === 0) {
    return period;
  }
  return tx.payrollPeriod.update({
    where: { id: period.id },
    data,
  });
};

const paymentMatchesRequest = (
  payment: any,
  amount: string,
  currency: string,
  paymentDate: string,
): boolean =>
  normalizeMoney(payment.amount) === amount &&
  payment.currency.toUpperCase() === currency.toUpperCase() &&
  dateOnly(payment.paymentDate) === paymentDate;

export function registerPayrollPaymentRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
}: PayrollPaymentRouteDeps): void {
  app.get(
    '/api/v2/payroll/periods/:id/payments',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_PAYMENTS_VIEW),
    route(async (req, res) => {
      const actor = actorFrom(req);
      const period = await prisma.payrollPeriod.findFirst({
        where: { id: req.params.id, companyId: actor.companyId },
      });
      if (!period) {
        fail(404, 'PayrollPeriodNotFound', 'payroll.payments.period_not_found');
      }
      const payments = await prisma.payrollPayment.findMany({
        where: { companyId: actor.companyId, payrollPeriodId: period!.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return res.json(payments.map(paymentShape));
    }),
  );

  app.post(
    '/api/v2/payroll/periods/:id/payments',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_PAYMENTS_RECORD),
    route(async (req, res) => {
      const actor = actorFrom(req);
      const idempotencyKey = requireIdempotencyKey(req);
      const body = parseBody(recordPaymentSchema, req.body);
      const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, actor.companyId);

      const result = await prisma.$transaction(async (tx) => {
        const period = await lockPeriod(tx, req.params.id, actor.companyId);
        assertPayablePeriod(period);

        const existing = await tx.payrollPayment.findFirst({
          where: {
            companyId: actor.companyId,
            payrollPeriodId: period!.id,
            idempotencyKey,
          },
        });
        if (existing) {
          const items = await loadPeriodItems(tx, actor.companyId, period!.id);
          const payments = await loadPeriodPayments(tx, actor.companyId, period!.id);
          const { amount, currency } = validateRecordMoney(body.amount, body.currency, items);
          if (!paymentMatchesRequest(existing, amount, currency, body.paymentDate)) {
            fail(409, 'PayrollPaymentIdempotencyConflict', 'payroll.payments.idempotency_conflict');
          }
          return {
            idempotent: true,
            payment: existing,
            period,
            items,
            payments,
          };
        }

        assertPaymentVersion(period, body.expectedVersion);

        const items = await loadPeriodItems(tx, actor.companyId, period!.id);
        assertItemsPresent(items);
        const { amount, currency, amountCents } = validateRecordMoney(
          body.amount,
          body.currency,
          items,
        );
        const approvedCents = approvedNetTotalCents(items);
        const payments = await loadPeriodPayments(tx, actor.companyId, period!.id);
        const currentPaidCents = postedPaymentsTotalCents(payments);
        if (currentPaidCents + amountCents > approvedCents) {
          fail(409, 'PayrollPaymentOverpay', 'payroll.payments.overpayment');
        }

        const payment = await tx.payrollPayment.create({
          data: {
            id: randomUUID(),
            companyId: actor.companyId,
            payrollPeriodId: period!.id,
            amount,
            currency,
            paymentDate: new Date(`${body.paymentDate}T00:00:00.000Z`),
            reference: body.reference ?? null,
            note: body.note ?? null,
            status: 'posted',
            idempotencyKey,
            recordedByUserId: actor.id,
          },
        });

        const nextVersion = (period!.paymentVersion ?? 0) + 1;
        let updatedPeriod = await tx.payrollPeriod.update({
          where: { id: period!.id },
          data: { paymentVersion: nextVersion },
        });

        const allPayments = [...payments, payment];
        updatedPeriod = await applyPaymentStateToPeriod(
          tx,
          updatedPeriod,
          items,
          allPayments,
          actor.id,
        );

        await writeAuditRequired(tx, {
          companyId: actor.companyId,
          userId: actor.id,
          action: 'payroll.payment.record',
          details: {
            paymentId: payment.id,
            periodId: period!.id,
            amountCents: Number(amountCents),
            currencyCode: currency,
            paymentVersion: nextVersion,
          },
        });

        return {
          idempotent: false,
          payment,
          period: updatedPeriod,
          items,
          payments: allPayments,
        };
      });

      const shapedPeriod = periodPaymentShape(
        result.period,
        result.items,
        result.payments,
        actor.permissions,
        primaryOwnerUserId,
      );

      return res.status(result.idempotent ? 200 : 201).json({
        payment: paymentShape(result.payment),
        period: shapedPeriod,
      });
    }),
  );

  app.post(
    '/api/v2/payroll/periods/:id/payments/:paymentId/void',
    requireAuth,
    checkAnyPermission(PERMISSIONS.PAYROLL_PAYMENTS_VOID),
    route(async (req, res) => {
      const actor = actorFrom(req);
      const body = parseBody(voidPaymentSchema, req.body);
      const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, actor.companyId);

      const result = await prisma.$transaction(async (tx) => {
        const period = await lockPeriod(tx, req.params.id, actor.companyId);
        assertPayablePeriod(period);
        assertPaymentVersion(period, body.expectedVersion);

        const payment = await tx.payrollPayment.findFirst({
          where: {
            id: req.params.paymentId,
            companyId: actor.companyId,
            payrollPeriodId: period!.id,
          },
        });
        if (!payment) {
          fail(404, 'PayrollPaymentNotFound', 'payroll.payments.payment_not_found');
        }
        if (payment!.status === 'voided') {
          const items = await loadPeriodItems(tx, actor.companyId, period!.id);
          const payments = await loadPeriodPayments(tx, actor.companyId, period!.id);
          return {
            payment: payment!,
            period,
            items,
            payments,
          };
        }

        const voidedAt = new Date();
        const voided = await tx.payrollPayment.update({
          where: { id: payment!.id },
          data: {
            status: 'voided',
            voidedAt,
            voidedByUserId: actor.id,
            voidReason: body.reason,
          },
        });

        const nextVersion = (period!.paymentVersion ?? 0) + 1;
        let updatedPeriod = await tx.payrollPeriod.update({
          where: { id: period!.id },
          data: { paymentVersion: nextVersion },
        });

        const items = await loadPeriodItems(tx, actor.companyId, period!.id);
        const payments = await loadPeriodPayments(tx, actor.companyId, period!.id);
        updatedPeriod = await applyPaymentStateToPeriod(
          tx,
          updatedPeriod,
          items,
          payments,
          actor.id,
        );

        await writeAuditRequired(tx, {
          companyId: actor.companyId,
          userId: actor.id,
          action: 'payroll.payment.void',
          details: {
            paymentId: voided.id,
            periodId: period!.id,
            paymentVersion: nextVersion,
          },
        });

        return {
          payment: voided,
          period: updatedPeriod,
          items,
          payments,
        };
      });

      return res.json({
        payment: paymentShape(result.payment),
        period: periodPaymentShape(
          result.period,
          result.items,
          result.payments,
          actor.permissions,
          primaryOwnerUserId,
        ),
      });
    }),
  );
}
