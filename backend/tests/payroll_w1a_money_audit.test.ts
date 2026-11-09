import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeAuditDetails } from '../src/audit';
import { registerFinanceRoutes } from '../src/finance';
import { centsToAuditString } from '../src/payrollMoney';
import { registerPayrollW1aRoutes } from '../src/payrollW1a';
import { PERMISSIONS } from '../src/permissions';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

function makeApp(prisma: ReturnType<typeof makeFakePrisma>) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const header = req.header('Authorization');
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
      (req as any).user = jwt.verify(header.slice(7), TEST_SECRET);
      return next();
    } catch {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  };
  const checkAnyPermission = (...required: string[]) => (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const permissions = (req as any).user?.permissions ?? [];
    if (
      permissions.includes(PERMISSIONS.ADMIN_FULL)
      || required.some((permission) => permissions.includes(permission))
    ) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden' });
  };
  registerFinanceRoutes({ app, prisma: prisma as any, requireAuth, checkAnyPermission });
  registerPayrollW1aRoutes({ app, prisma: prisma as any, requireAuth, checkAnyPermission });
  return app;
}

describe('W1A exact money boundary and audit cents', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;

  beforeEach(() => {
    prisma = makeFakePrisma();
    prisma.companyOwnership.findFirst = vi.fn().mockResolvedValue(null);
  });

  it('accepts decimal-string journal amounts and rejects JSON numbers', async () => {
    const app = makeApp(prisma);
    const token = tokenFor({
      permissions: [PERMISSIONS.FINANCE_CREATE, PERMISSIONS.FINANCE_APPROVE],
    });
    const expense = await request(app)
      .post('/api/v2/finance/chart-of-accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '5100', name: 'Expense', type: 'Expense' });
    const liability = await request(app)
      .post('/api/v2/finance/chart-of-accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '2100', name: 'Payable', type: 'Liability' });

    const ok = await request(app)
      .post('/api/v2/finance/journal-entries')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entryDate: '2026-08-07',
        lines: [
          { accountId: expense.body.id, debit: '100.00', credit: '0.00' },
          { accountId: liability.body.id, debit: '0.00', credit: '100.00' },
        ],
      });
    expect(ok.status).toBe(201);

    const numeric = await request(app)
      .post('/api/v2/finance/journal-entries')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entryDate: '2026-08-07',
        lines: [
          { accountId: expense.body.id, debit: 100.00, credit: 0 },
          { accountId: liability.body.id, debit: 0, credit: 100.00 },
        ],
      });
    expect(numeric.status).toBe(400);

    const oversized = await request(app)
      .post('/api/v2/finance/journal-entries')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entryDate: '2026-08-07',
        lines: [
          { accountId: expense.body.id, debit: '10000000000000000.00', credit: '0.00' },
          { accountId: liability.body.id, debit: '0.00', credit: '10000000000000000.00' },
        ],
      });
    expect(oversized.status).toBe(400);

    const sci = await request(app)
      .post('/api/v2/finance/journal-entries')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entryDate: '2026-08-07',
        lines: [
          { accountId: expense.body.id, debit: '1e6', credit: '0.00' },
          { accountId: liability.body.id, debit: '0.00', credit: '1e6' },
        ],
      });
    expect(sci.status).toBe(400);
  });

  it('rejects JSON numeric adjustment amounts and accepts exact strings', async () => {
    const app = makeApp(prisma);
    prisma._store.payrollPeriods.push({
      id: 'period-1',
      companyId: 'c1',
      month: 8,
      year: 2026,
      status: 'calculated',
      calculationVersion: 1,
      ledgerPostedAt: null,
      ledgerPostingId: null,
      paidAt: null,
    });
    prisma._store.payrollItems.push({
      id: 'item-1',
      companyId: 'c1',
      payrollPeriodId: 'period-1',
      employeeId: 'emp-1',
      baseSalary: '1000.00',
      grossPay: '1000.00',
      totalDeductions: '0.00',
      netPay: '1000.00',
      employee: { user: { id: 'u-emp', role: { permissions: '[]' } } },
    });
    const token = tokenFor({ permissions: [PERMISSIONS.PAYROLL_ITEM_ADJUST] });

    const rejected = await request(app)
      .post('/api/v2/payroll/periods/period-1/items/item-1/adjust')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'adjust-num-reject-01')
      .send({ direction: 'allowance', amount: 10.5, reason: 'numeric' });
    expect(rejected.status).toBe(400);

    const accepted = await request(app)
      .post('/api/v2/payroll/periods/period-1/items/item-1/adjust')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'adjust-str-accept-01')
      .send({ direction: 'allowance', amount: '10.50', reason: 'string money' });
    expect(accepted.status).toBe(201);
    expect(accepted.body.adjustment.amount).toBe('10.50');
  });

  it('preserves exact audit cents above Number.MAX_SAFE_INTEGER', () => {
    const huge = 9007199254740993n; // MAX_SAFE_INTEGER + 2
    expect(String(Number(huge))).not.toBe(huge.toString());
    const exact = centsToAuditString(huge);
    expect(exact).toBe('9007199254740993');
    const sanitized = sanitizeAuditDetails({
      debitCents: exact,
      creditCents: exact,
      amountCents: exact,
    });
    expect(sanitized).toEqual({
      debitCents: '9007199254740993',
      creditCents: '9007199254740993',
      amountCents: '9007199254740993',
    });
  });
});
