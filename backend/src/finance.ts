import { randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import {
  centsToAuditString,
  centsToMoney,
  isExactMoneyDecimalString,
  moneyToCents,
  normalizeMoney,
} from './payrollMoney';
import { PERMISSIONS } from './permissions';

interface FinanceUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface FinanceRequest extends Request {
  user?: FinanceUser;
}

interface FinanceRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
}

class FinanceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'] as const;
const idempotencyKeySchema = z.string().trim().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/);
/** W1A journal money: exact decimal strings only (reject JSON numbers). */
const moneySchema = z.string().superRefine((value, ctx) => {
  if (!isExactMoneyDecimalString(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'المبلغ يجب أن يكون نصاً عشرياً دقيقاً (مثال: "100.00") ضمن DECIMAL(18,2)',
    });
    return;
  }
  if (normalizeMoney(value) == null) {
    ctx.addIssue({ code: 'custom', message: 'المبلغ غير صالح' });
  }
});
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createAccountSchema = z.strictObject({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  type: z.enum(ACCOUNT_TYPES),
  parentId: z.string().trim().min(1).max(100).nullable().optional(),
});

const patchAccountSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  parentId: z.string().trim().min(1).max(100).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'لا توجد حقول للتحديث');

const createCostCenterSchema = z.strictObject({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(500).nullable().optional(),
});

const patchCostCenterSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(500).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'لا توجد حقول للتحديث');

const journalLineSchema = z.strictObject({
  accountId: z.string().trim().min(1).max(100),
  costCenterId: z.string().trim().min(1).max(100).nullable().optional(),
  debit: moneySchema,
  credit: moneySchema,
  lineMemo: z.string().trim().min(1).max(500).nullable().optional(),
});

const createJournalSchema = z.strictObject({
  entryDate: isoDateSchema,
  reference: z.string().trim().min(1).max(120).nullable().optional(),
  memo: z.string().trim().min(1).max(500).nullable().optional(),
  currency: z.string().trim().length(3).default('SAR'),
  lines: z.array(journalLineSchema).min(2).max(200),
});

const patchJournalSchema = z.strictObject({
  entryDate: isoDateSchema.optional(),
  reference: z.string().trim().min(1).max(120).nullable().optional(),
  memo: z.string().trim().min(1).max(500).nullable().optional(),
  lines: z.array(journalLineSchema).min(2).max(200).optional(),
}).refine((value) => Object.keys(value).length > 0, 'لا توجد حقول للتحديث');

const fail = (status: number, code: string, message: string, details?: Record<string, unknown>): never => {
  throw new FinanceError(status, code, message, details);
};

const iso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

const dateOnly = (value: Date | string): string => new Date(value).toISOString().slice(0, 10);

const requireIdempotencyKey = (req: Request): string => {
  const raw = req.header('Idempotency-Key') ?? req.header('idempotency-key');
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) {
    fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'مفتاح التكرار مطلوب وصالح');
  }
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
  if (error instanceof FinanceError) {
    return res.status(error.status).json({
      error: error.code,
      message: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  return res.status(500).json({
    error: 'FinanceOperationFailed',
    message: 'تعذر إكمال العملية المالية حالياً',
    code: 'FINANCE_OPERATION_FAILED',
  });
};

const route = (
  handler: (req: FinanceRequest, res: Response) => Promise<unknown>,
): RequestHandler => async (req, res) => {
  try {
    await handler(req as FinanceRequest, res);
  } catch (error) {
    sendError(res, error);
  }
};

const exactLineMoney = (debitRaw: string | number, creditRaw: string | number) => {
  const debit = normalizeMoney(debitRaw);
  const credit = normalizeMoney(creditRaw);
  if (!debit || !credit) fail(400, 'INVALID_MONEY', 'مبالغ القيود غير صالحة');
  const debitCents = moneyToCents(debit);
  const creditCents = moneyToCents(credit);
  if (debitCents < 0n || creditCents < 0n) fail(400, 'INVALID_MONEY', 'المبالغ يجب أن تكون غير سالبة');
  const debitPositive = debitCents > 0n;
  const creditPositive = creditCents > 0n;
  if (debitPositive === creditPositive) {
    fail(400, 'JOURNAL_LINE_ONE_SIDE_REQUIRED', 'كل سطر يجب أن يحتوي مدين أو دائن فقط');
  }
  return { debit, credit, debitCents, creditCents };
};

const assertBalanced = (lines: Array<{ debitCents: bigint; creditCents: bigint }>) => {
  const totalDebit = lines.reduce((sum, line) => sum + line.debitCents, 0n);
  const totalCredit = lines.reduce((sum, line) => sum + line.creditCents, 0n);
  if (totalDebit !== totalCredit || totalDebit === 0n) {
    fail(400, 'JOURNAL_UNBALANCED', 'القيد يجب أن يكون متوازناً وبمبالغ موجبة');
  }
  return { totalDebit, totalCredit };
};

const accountShape = (row: any) => ({
  id: row.id,
  companyId: row.companyId,
  code: row.code,
  name: row.name,
  type: row.type,
  parentId: row.parentId ?? null,
  status: row.status,
  archivedAt: iso(row.archivedAt),
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

const costCenterShape = (row: any) => ({
  id: row.id,
  companyId: row.companyId,
  code: row.code,
  name: row.name,
  description: row.description ?? null,
  status: row.status,
  archivedAt: iso(row.archivedAt),
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

const journalLineShape = (row: any) => ({
  id: row.id,
  lineNo: row.lineNo,
  accountId: row.accountId,
  costCenterId: row.costCenterId ?? null,
  debit: normalizeMoney(row.debit) ?? row.debit.toString(),
  credit: normalizeMoney(row.credit) ?? row.credit.toString(),
  lineMemo: row.lineMemo ?? null,
});

const journalShape = (row: any, lines: any[] = []) => ({
  id: row.id,
  companyId: row.companyId,
  status: row.status,
  entryDate: dateOnly(row.entryDate),
  reference: row.reference ?? null,
  memo: row.memo ?? null,
  currency: row.currency,
  totalDebit: normalizeMoney(row.totalDebit) ?? row.totalDebit.toString(),
  totalCredit: normalizeMoney(row.totalCredit) ?? row.totalCredit.toString(),
  postedAt: iso(row.postedAt),
  reversedAt: iso(row.reversedAt),
  reversesJournalEntryId: row.reversesJournalEntryId ?? null,
  sourceType: row.sourceType ?? null,
  sourcePayrollPeriodId: row.sourcePayrollPeriodId ?? null,
  sourceCalculationVersion: row.sourceCalculationVersion ?? null,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  lines: lines.map(journalLineShape),
});

async function assertNoCycle(
  client: any,
  companyId: string,
  accountId: string,
  parentId: string | null | undefined,
): Promise<void> {
  if (!parentId) return;
  if (parentId === accountId) {
    fail(400, 'ACCOUNT_SELF_PARENT', 'لا يمكن أن يكون الحساب أباً لنفسه');
  }
  let cursor: string | null = parentId;
  const seen = new Set<string>([accountId]);
  while (cursor) {
    if (seen.has(cursor)) {
      fail(400, 'ACCOUNT_CYCLE', 'هيكل الحسابات يحتوي دورة');
    }
    seen.add(cursor);
    const parent = await client.chartOfAccount.findFirst({
      where: { id: cursor, companyId },
      select: { parentId: true },
    });
    if (!parent) {
      fail(400, 'ACCOUNT_PARENT_NOT_FOUND', 'الحساب الأب غير موجود في نفس الشركة');
    }
    cursor = parent.parentId ?? null;
  }
}

async function resolveParent(
  client: any,
  companyId: string,
  parentId: string | null | undefined,
): Promise<string | null> {
  if (parentId == null || parentId === undefined) return null;
  const parent = await client.chartOfAccount.findFirst({
    where: { id: parentId, companyId, status: 'active' },
  });
  if (!parent) fail(400, 'ACCOUNT_PARENT_NOT_FOUND', 'الحساب الأب غير موجود أو مؤرشف');
  return parent.id;
}

async function normalizeJournalLines(
  client: any,
  companyId: string,
  rawLines: z.infer<typeof journalLineSchema>[],
) {
  const normalized = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index];
    const money = exactLineMoney(raw.debit, raw.credit);
    const account = await client.chartOfAccount.findFirst({
      where: { id: raw.accountId, companyId, status: 'active' },
    });
    if (!account) fail(400, 'ACCOUNT_NOT_FOUND', 'الحساب غير موجود أو غير نشط');
    let costCenterId: string | null = null;
    if (raw.costCenterId) {
      const costCenter = await client.costCenter.findFirst({
        where: { id: raw.costCenterId, companyId, status: 'active' },
      });
      if (!costCenter) fail(400, 'COST_CENTER_NOT_FOUND', 'مركز التكلفة غير موجود أو غير نشط');
      costCenterId = costCenter.id;
    }
    normalized.push({
      lineNo: index + 1,
      accountId: account.id,
      costCenterId,
      debit: money.debit,
      credit: money.credit,
      debitCents: money.debitCents,
      creditCents: money.creditCents,
      lineMemo: raw.lineMemo ?? null,
    });
  }
  const totals = assertBalanced(normalized);
  return { lines: normalized, totals };
}

export function registerFinanceRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
}: FinanceRouteDeps): void {
  app.get(
    '/api/v2/finance/chart-of-accounts',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_VIEW),
    route(async (req, res) => {
      const rows = await prisma.chartOfAccount.findMany({
        where: { companyId: req.user!.companyId },
        orderBy: [{ code: 'asc' }],
      });
      return res.json(rows.map(accountShape));
    }),
  );

  app.post(
    '/api/v2/finance/chart-of-accounts',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_CREATE),
    route(async (req, res) => {
      const body = parseBody(createAccountSchema, req.body);
      const created = await prisma.$transaction(async (tx) => {
        const parentId = await resolveParent(tx, req.user!.companyId, body.parentId);
        const duplicate = await tx.chartOfAccount.findFirst({
          where: { companyId: req.user!.companyId, code: body.code },
        });
        if (duplicate) fail(409, 'ACCOUNT_CODE_EXISTS', 'رمز الحساب مستخدم مسبقاً');
        const row = await tx.chartOfAccount.create({
          data: {
            id: randomUUID(),
            companyId: req.user!.companyId,
            code: body.code,
            name: body.name,
            type: body.type,
            parentId,
            status: 'active',
          },
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'finance.account.create',
          details: { accountId: row.id },
        });
        return row;
      });
      return res.status(201).json(accountShape(created));
    }),
  );

  app.patch(
    '/api/v2/finance/chart-of-accounts/:id',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_MANAGE),
    route(async (req, res) => {
      const body = parseBody(patchAccountSchema, req.body);
      const updated = await prisma.$transaction(async (tx) => {
        const existing = await tx.chartOfAccount.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
        });
        if (!existing) fail(404, 'ACCOUNT_NOT_FOUND', 'الحساب غير موجود');
        if (existing.status !== 'active') fail(409, 'ACCOUNT_ARCHIVED', 'لا يمكن تعديل حساب مؤرشف');
        const parentId = body.parentId !== undefined
          ? await resolveParent(tx, req.user!.companyId, body.parentId)
          : existing.parentId;
        await assertNoCycle(tx, req.user!.companyId, existing.id, parentId);
        const row = await tx.chartOfAccount.update({
          where: { id: existing.id },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.type !== undefined ? { type: body.type } : {}),
            ...(body.parentId !== undefined ? { parentId } : {}),
          },
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'finance.account.update',
          details: { accountId: row.id },
        });
        return row;
      });
      return res.json(accountShape(updated));
    }),
  );

  app.post(
    '/api/v2/finance/chart-of-accounts/:id/archive',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_MANAGE),
    route(async (req, res) => {
      const updated = await prisma.$transaction(async (tx) => {
        const existing = await tx.chartOfAccount.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
        });
        if (!existing) fail(404, 'ACCOUNT_NOT_FOUND', 'الحساب غير موجود');
        if (existing.status === 'archived') return existing;
        const child = await tx.chartOfAccount.findFirst({
          where: { companyId: req.user!.companyId, parentId: existing.id, status: 'active' },
        });
        if (child) fail(409, 'ACCOUNT_HAS_CHILDREN', 'لا يمكن أرشفة حساب له أبناء نشطون');
        const row = await tx.chartOfAccount.update({
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
          action: 'finance.account.archive',
          details: { accountId: row.id },
        });
        return row;
      });
      return res.json(accountShape(updated));
    }),
  );

  app.get(
    '/api/v2/finance/cost-centers',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_VIEW),
    route(async (req, res) => {
      const rows = await prisma.costCenter.findMany({
        where: { companyId: req.user!.companyId },
        orderBy: [{ code: 'asc' }],
      });
      return res.json(rows.map(costCenterShape));
    }),
  );

  app.post(
    '/api/v2/finance/cost-centers',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_CREATE),
    route(async (req, res) => {
      const body = parseBody(createCostCenterSchema, req.body);
      const created = await prisma.$transaction(async (tx) => {
        const duplicate = await tx.costCenter.findFirst({
          where: { companyId: req.user!.companyId, code: body.code },
        });
        if (duplicate) fail(409, 'COST_CENTER_CODE_EXISTS', 'رمز مركز التكلفة مستخدم مسبقاً');
        const row = await tx.costCenter.create({
          data: {
            id: randomUUID(),
            companyId: req.user!.companyId,
            code: body.code,
            name: body.name,
            description: body.description ?? null,
            status: 'active',
          },
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'finance.cost_center.create',
          details: { costCenterId: row.id },
        });
        return row;
      });
      return res.status(201).json(costCenterShape(created));
    }),
  );

  app.patch(
    '/api/v2/finance/cost-centers/:id',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_MANAGE),
    route(async (req, res) => {
      const body = parseBody(patchCostCenterSchema, req.body);
      const updated = await prisma.$transaction(async (tx) => {
        const existing = await tx.costCenter.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
        });
        if (!existing) fail(404, 'COST_CENTER_NOT_FOUND', 'مركز التكلفة غير موجود');
        if (existing.status !== 'active') fail(409, 'COST_CENTER_ARCHIVED', 'لا يمكن تعديل مركز تكلفة مؤرشف');
        const row = await tx.costCenter.update({
          where: { id: existing.id },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
          },
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'finance.cost_center.update',
          details: { costCenterId: row.id },
        });
        return row;
      });
      return res.json(costCenterShape(updated));
    }),
  );

  app.post(
    '/api/v2/finance/cost-centers/:id/archive',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_MANAGE),
    route(async (req, res) => {
      const updated = await prisma.$transaction(async (tx) => {
        const existing = await tx.costCenter.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
        });
        if (!existing) fail(404, 'COST_CENTER_NOT_FOUND', 'مركز التكلفة غير موجود');
        if (existing.status === 'archived') return existing;
        const row = await tx.costCenter.update({
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
          action: 'finance.cost_center.archive',
          details: { costCenterId: row.id },
        });
        return row;
      });
      return res.json(costCenterShape(updated));
    }),
  );

  app.get(
    '/api/v2/finance/journal-entries',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_VIEW),
    route(async (req, res) => {
      const rows = await prisma.journalEntry.findMany({
        where: { companyId: req.user!.companyId },
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
        take: 200,
      });
      // List omits employee salary detail; lines available on detail endpoint.
      return res.json(rows.map((row) => journalShape(row, [])));
    }),
  );

  app.get(
    '/api/v2/finance/journal-entries/:id',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_VIEW),
    route(async (req, res) => {
      const row = await prisma.journalEntry.findFirst({
        where: { id: req.params.id, companyId: req.user!.companyId },
      });
      if (!row) fail(404, 'JOURNAL_NOT_FOUND', 'القيد غير موجود');
      const lines = await prisma.journalEntryLine.findMany({
        where: { companyId: req.user!.companyId, journalEntryId: row!.id },
        orderBy: [{ lineNo: 'asc' }],
      });
      return res.json(journalShape(row, lines));
    }),
  );

  app.post(
    '/api/v2/finance/journal-entries',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_CREATE),
    route(async (req, res) => {
      const body = parseBody(createJournalSchema, req.body);
      if (body.currency.toUpperCase() !== 'SAR') {
        fail(400, 'UNSUPPORTED_CURRENCY', 'العملة المدعومة هي SAR فقط');
      }
      const created = await prisma.$transaction(async (tx) => {
        const { lines, totals } = await normalizeJournalLines(tx, req.user!.companyId, body.lines);
        const entry = await tx.journalEntry.create({
          data: {
            id: randomUUID(),
            companyId: req.user!.companyId,
            status: 'draft',
            entryDate: new Date(`${body.entryDate}T00:00:00.000Z`),
            reference: body.reference ?? null,
            memo: body.memo ?? null,
            currency: 'SAR',
            totalDebit: centsToMoney(totals.totalDebit),
            totalCredit: centsToMoney(totals.totalCredit),
            sourceType: 'manual',
            createdByUserId: req.user!.id,
          },
        });
        await tx.journalEntryLine.createMany({
          data: lines.map((line) => ({
            id: randomUUID(),
            companyId: req.user!.companyId,
            journalEntryId: entry.id,
            lineNo: line.lineNo,
            accountId: line.accountId,
            costCenterId: line.costCenterId,
            debit: line.debit,
            credit: line.credit,
            lineMemo: line.lineMemo,
          })),
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'finance.journal.create',
          details: {
            journalEntryId: entry.id,
            lineCount: lines.length,
            debitCents: centsToAuditString(totals.totalDebit),
            creditCents: centsToAuditString(totals.totalCredit),
            sourceType: 'manual',
          },
        });
        const storedLines = await tx.journalEntryLine.findMany({
          where: { companyId: req.user!.companyId, journalEntryId: entry.id },
          orderBy: [{ lineNo: 'asc' }],
        });
        return { entry, lines: storedLines };
      });
      return res.status(201).json(journalShape(created.entry, created.lines));
    }),
  );

  app.patch(
    '/api/v2/finance/journal-entries/:id',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_CREATE, PERMISSIONS.FINANCE_MANAGE),
    route(async (req, res) => {
      const body = parseBody(patchJournalSchema, req.body);
      const updated = await prisma.$transaction(async (tx) => {
        const existing = await tx.journalEntry.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
        });
        if (!existing) fail(404, 'JOURNAL_NOT_FOUND', 'القيد غير موجود');
        if (existing.status !== 'draft') fail(409, 'JOURNAL_NOT_DRAFT', 'يمكن تعديل المسودات فقط');
        let totals = {
          totalDebit: moneyToCents(existing.totalDebit),
          totalCredit: moneyToCents(existing.totalCredit),
        };
        if (body.lines) {
          const normalized = await normalizeJournalLines(tx, req.user!.companyId, body.lines);
          totals = normalized.totals;
          await tx.journalEntryLine.deleteMany({
            where: { companyId: req.user!.companyId, journalEntryId: existing.id },
          });
          await tx.journalEntryLine.createMany({
            data: normalized.lines.map((line) => ({
              id: randomUUID(),
              companyId: req.user!.companyId,
              journalEntryId: existing.id,
              lineNo: line.lineNo,
              accountId: line.accountId,
              costCenterId: line.costCenterId,
              debit: line.debit,
              credit: line.credit,
              lineMemo: line.lineMemo,
            })),
          });
        }
        const entry = await tx.journalEntry.update({
          where: { id: existing.id },
          data: {
            ...(body.entryDate !== undefined
              ? { entryDate: new Date(`${body.entryDate}T00:00:00.000Z`) }
              : {}),
            ...(body.reference !== undefined ? { reference: body.reference } : {}),
            ...(body.memo !== undefined ? { memo: body.memo } : {}),
            ...(body.lines
              ? {
                  totalDebit: centsToMoney(totals.totalDebit),
                  totalCredit: centsToMoney(totals.totalCredit),
                }
              : {}),
          },
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'finance.journal.update',
          details: { journalEntryId: entry.id },
        });
        const lines = await tx.journalEntryLine.findMany({
          where: { companyId: req.user!.companyId, journalEntryId: entry.id },
          orderBy: [{ lineNo: 'asc' }],
        });
        return { entry, lines };
      });
      return res.json(journalShape(updated.entry, updated.lines));
    }),
  );

  app.post(
    '/api/v2/finance/journal-entries/:id/post',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_APPROVE),
    route(async (req, res) => {
      const idempotencyKey = requireIdempotencyKey(req);
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "JournalEntry"
          WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId}
          FOR UPDATE
        `;
        const existing = await tx.journalEntry.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
        });
        if (!existing) fail(404, 'JOURNAL_NOT_FOUND', 'القيد غير موجود');

        const byKey = await tx.journalEntry.findFirst({
          where: { companyId: req.user!.companyId, idempotencyKey },
        });
        if (byKey && byKey.id !== existing.id) {
          fail(409, 'IDEMPOTENCY_CONFLICT', 'مفتاح التكرار مستخدم لقيد آخر');
        }
        if (existing.status === 'posted' && existing.idempotencyKey === idempotencyKey) {
          const lines = await tx.journalEntryLine.findMany({
            where: { companyId: req.user!.companyId, journalEntryId: existing.id },
            orderBy: [{ lineNo: 'asc' }],
          });
          return { entry: existing, lines, idempotent: true };
        }
        if (existing.status !== 'draft') {
          fail(409, 'JOURNAL_NOT_DRAFT', 'يمكن ترحيل المسودات فقط');
        }
        if (moneyToCents(existing.totalDebit) !== moneyToCents(existing.totalCredit)
          || moneyToCents(existing.totalDebit) <= 0n) {
          fail(409, 'JOURNAL_UNBALANCED', 'القيد يجب أن يكون متوازناً قبل الترحيل');
        }
        const lines = await tx.journalEntryLine.findMany({
          where: { companyId: req.user!.companyId, journalEntryId: existing.id },
          orderBy: [{ lineNo: 'asc' }],
        });
        if (lines.length < 2) fail(409, 'JOURNAL_LINES_REQUIRED', 'القيد يحتاج سطرين على الأقل');
        const postedAt = new Date();
        const entry = await tx.journalEntry.update({
          where: { id: existing.id },
          data: {
            status: 'posted',
            postedAt,
            postedByUserId: req.user!.id,
            idempotencyKey,
          },
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'finance.journal.post',
          details: {
            journalEntryId: entry.id,
            previousStatus: 'draft',
            newStatus: 'posted',
            lineCount: lines.length,
            debitCents: centsToAuditString(moneyToCents(entry.totalDebit)),
            creditCents: centsToAuditString(moneyToCents(entry.totalCredit)),
          },
        });
        return { entry, lines, idempotent: false };
      });
      return res.json({
        ...journalShape(result.entry, result.lines),
        idempotent: result.idempotent,
      });
    }),
  );

  app.post(
    '/api/v2/finance/journal-entries/:id/reverse',
    requireAuth,
    checkAnyPermission(PERMISSIONS.FINANCE_APPROVE),
    route(async (req, res) => {
      const idempotencyKey = requireIdempotencyKey(req);
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "JournalEntry"
          WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId}
          FOR UPDATE
        `;
        const existing = await tx.journalEntry.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
        });
        if (!existing) fail(404, 'JOURNAL_NOT_FOUND', 'القيد غير موجود');

        const byKey = await tx.journalEntry.findFirst({
          where: { companyId: req.user!.companyId, idempotencyKey },
        });
        if (byKey) {
          if (byKey.reversesJournalEntryId === existing.id && byKey.status === 'posted') {
            const lines = await tx.journalEntryLine.findMany({
              where: { companyId: req.user!.companyId, journalEntryId: byKey.id },
              orderBy: [{ lineNo: 'asc' }],
            });
            return { entry: byKey, lines, idempotent: true };
          }
          fail(409, 'IDEMPOTENCY_CONFLICT', 'مفتاح التكرار مستخدم لقيد آخر');
        }
        if (existing.status !== 'posted') {
          fail(409, 'JOURNAL_NOT_POSTED', 'يمكن عكس القيود المرحّلة فقط');
        }
        const originalLines = await tx.journalEntryLine.findMany({
          where: { companyId: req.user!.companyId, journalEntryId: existing.id },
          orderBy: [{ lineNo: 'asc' }],
        });
        const now = new Date();
        const reversing = await tx.journalEntry.create({
          data: {
            id: randomUUID(),
            companyId: req.user!.companyId,
            status: 'posted',
            entryDate: existing.entryDate,
            reference: existing.reference,
            memo: existing.memo ? `Reversal of ${existing.id}` : `Reversal of ${existing.id}`,
            currency: existing.currency,
            totalDebit: existing.totalCredit,
            totalCredit: existing.totalDebit,
            postedAt: now,
            postedByUserId: req.user!.id,
            reversesJournalEntryId: existing.id,
            idempotencyKey,
            sourceType: existing.sourceType,
            sourcePayrollPeriodId: existing.sourcePayrollPeriodId,
            sourceCalculationVersion: existing.sourceCalculationVersion,
            createdByUserId: req.user!.id,
          },
        });
        await tx.journalEntryLine.createMany({
          data: originalLines.map((line) => ({
            id: randomUUID(),
            companyId: req.user!.companyId,
            journalEntryId: reversing.id,
            lineNo: line.lineNo,
            accountId: line.accountId,
            costCenterId: line.costCenterId,
            debit: normalizeMoney(line.credit) ?? line.credit.toString(),
            credit: normalizeMoney(line.debit) ?? line.debit.toString(),
            lineMemo: line.lineMemo,
          })),
        });
        await tx.journalEntry.update({
          where: { id: existing.id },
          data: {
            status: 'reversed',
            reversedAt: now,
            reversedByUserId: req.user!.id,
          },
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'finance.journal.reverse',
          details: {
            journalEntryId: reversing.id,
            previousStatus: 'posted',
            newStatus: 'reversed',
            lineCount: originalLines.length,
          },
        });
        const lines = await tx.journalEntryLine.findMany({
          where: { companyId: req.user!.companyId, journalEntryId: reversing.id },
          orderBy: [{ lineNo: 'asc' }],
        });
        return { entry: reversing, lines, idempotent: false };
      });
      return res.status(result.idempotent ? 200 : 201).json({
        ...journalShape(result.entry, result.lines),
        idempotent: result.idempotent,
      });
    }),
  );
}
