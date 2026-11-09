import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFinanceRoutes } from '../src/finance';
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

describe('payroll ledger posting', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let expenseId: string;
  let payableId: string;
  let deductionId: string;

  beforeEach(async () => {
    prisma = makeFakePrisma();
    prisma.companyOwnership.findFirst = vi.fn().mockResolvedValue(null);
    const app = makeApp(prisma);
    const token = tokenFor({
      permissions: [PERMISSIONS.FINANCE_CREATE, PERMISSIONS.FINANCE_APPROVE],
    });
    const expense = await request(app)
      .post('/api/v2/finance/chart-of-accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '5100', name: 'Payroll Expense', type: 'Expense' });
    const payable = await request(app)
      .post('/api/v2/finance/chart-of-accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '2100', name: 'Payroll Payable', type: 'Liability' });
    const deduction = await request(app)
      .post('/api/v2/finance/chart-of-accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '2200', name: 'Payroll Deductions', type: 'Liability' });
    expenseId = expense.body.id;
    payableId = payable.body.id;
    deductionId = deduction.body.id;

    prisma._store.payrollPeriods.push({
      id: 'period-1',
      companyId: 'c1',
      month: 8,
      year: 2026,
      status: 'approved',
      calculationVersion: 2,
      ledgerPostedAt: null,
      ledgerPostingId: null,
    });
    prisma._store.payrollItems.push(
      {
        id: 'item-1',
        companyId: 'c1',
        payrollPeriodId: 'period-1',
        employeeId: 'e1',
        grossPay: '1200.00',
        netPay: '1100.00',
        totalDeductions: '100.00',
      },
      {
        id: 'item-2',
        companyId: 'c1',
        payrollPeriodId: 'period-1',
        employeeId: 'e2',
        grossPay: '800.00',
        netPay: '800.00',
        totalDeductions: '0.00',
      },
    );
  });

  it('posts balanced period-level journal without employee salary detail', async () => {
    const app = makeApp(prisma);
    const token = tokenFor({ permissions: [PERMISSIONS.FINANCE_APPROVE] });

    const missingDeduction = await request(app)
      .post('/api/v2/payroll/periods/period-1/post-to-ledger')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'ledger-key-001')
      .send({ expenseAccountId: expenseId, payableAccountId: payableId });
    expect(missingDeduction.status).toBe(400);

    const posted = await request(app)
      .post('/api/v2/payroll/periods/period-1/post-to-ledger')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'ledger-key-001')
      .send({
        expenseAccountId: expenseId,
        payableAccountId: payableId,
        deductionAccountId: deductionId,
      });
    expect(posted.status).toBe(201);
    expect(posted.body.totalDebit).toBe('2000.00');
    expect(posted.body.totalCredit).toBe('2000.00');
    expect(posted.body.lineCount).toBe(3);
    expect(posted.body).not.toHaveProperty('items');
    expect(posted.body).not.toHaveProperty('employees');
    expect(JSON.stringify(posted.body)).not.toContain('1100.00');
    expect(JSON.stringify(posted.body)).not.toContain('"employeeId"');
    const retry = await request(app)
      .post('/api/v2/payroll/periods/period-1/post-to-ledger')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'ledger-key-001')
      .send({
        expenseAccountId: expenseId,
        payableAccountId: payableId,
        deductionAccountId: deductionId,
      });
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);
    expect(prisma._store.payrollLedgerPostings).toHaveLength(1);
  });

  it('rejects posting when period is not approved', async () => {
    prisma._store.payrollPeriods[0].status = 'calculated';
    const app = makeApp(prisma);
    const token = tokenFor({ permissions: [PERMISSIONS.FINANCE_APPROVE] });
    const res = await request(app)
      .post('/api/v2/payroll/periods/period-1/post-to-ledger')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'ledger-key-002')
      .send({
        expenseAccountId: expenseId,
        payableAccountId: payableId,
        deductionAccountId: deductionId,
      });
    expect(res.status).toBe(409);
  });
});
