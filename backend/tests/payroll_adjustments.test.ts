import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPayrollW1aRoutes, payrollReopenConfirmationPhrase } from '../src/payrollW1a';
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
  registerPayrollW1aRoutes({ app, prisma: prisma as any, requireAuth, checkAnyPermission });
  return app;
}

describe('payroll adjustments and reopen', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;

  beforeEach(() => {
    prisma = makeFakePrisma();
    prisma.companyOwnership.findFirst = vi.fn().mockResolvedValue({ userId: 'owner-user' });
    prisma._store.payrollPeriods.push({
      id: 'period-1',
      companyId: 'c1',
      month: 8,
      year: 2026,
      status: 'calculated',
      calculationVersion: 1,
      calculationFingerprint: 'fp',
      ledgerPostedAt: null,
      ledgerPostingId: null,
      paidAt: null,
      approvedAt: null,
      approvedByUserId: null,
    });
    prisma._store.employees.push({
      id: 'emp-1',
      companyId: 'c1',
      employeeNum: 'EMP-1',
      user: { id: 'user-emp', name: 'Emp', role: { permissions: '[]' } },
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
      currency: 'SAR',
      employee: {
        user: { id: 'user-emp', name: 'Emp', role: { permissions: '[]' } },
      },
    });
  });

  it('previews and applies adjustments with Idempotency-Key on calculated periods', async () => {
    const app = makeApp(prisma);
    const token = tokenFor({ permissions: [PERMISSIONS.PAYROLL_ITEM_ADJUST] });

    const preview = await request(app)
      .post('/api/v2/payroll/periods/period-1/items/item-1/adjust/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ direction: 'allowance', amount: '100.00', reason: 'bonus' });
    expect(preview.status).toBe(200);
    expect(preview.body.resultingGross).toBe('1100.00');

    const applied = await request(app)
      .post('/api/v2/payroll/periods/period-1/items/item-1/adjust')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'adjust-key-0001')
      .send({ direction: 'deduction', amount: '25.50', reason: 'advance recovery' });
    expect(applied.status).toBe(201);
    expect(applied.body.adjustment.amount).toBe('25.50');
    expect(applied.body.idempotent).toBe(false);
    expect(prisma._store.payrollItemAdjustments).toHaveLength(1);

    const retry = await request(app)
      .post('/api/v2/payroll/periods/period-1/items/item-1/adjust')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'adjust-key-0001')
      .send({ direction: 'deduction', amount: '25.50', reason: 'advance recovery' });
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);
    expect(prisma._store.payrollItemAdjustments).toHaveLength(1);

    const conflict = await request(app)
      .post('/api/v2/payroll/periods/period-1/items/item-1/adjust')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'adjust-key-0001')
      .send({ direction: 'allowance', amount: '25.50', reason: 'advance recovery' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');

    prisma._store.payrollPeriods[0].status = 'approved';
    const blocked = await request(app)
      .post('/api/v2/payroll/periods/period-1/items/item-1/adjust')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'adjust-key-0002')
      .send({ direction: 'allowance', amount: '10.00', reason: 'late' });
    expect(blocked.status).toBe(409);
  });

  it('requires Idempotency-Key for apply', async () => {
    const app = makeApp(prisma);
    const token = tokenFor({ permissions: [PERMISSIONS.PAYROLL_ITEM_ADJUST] });
    const missing = await request(app)
      .post('/api/v2/payroll/periods/period-1/items/item-1/adjust')
      .set('Authorization', `Bearer ${token}`)
      .send({ direction: 'allowance', amount: '10.00', reason: 'missing key' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('reopens approved unpaid non-ledger periods with phrase confirmation', async () => {
    const app = makeApp(prisma);
    prisma._store.payrollPeriods[0].status = 'approved';
    prisma._store.payrollPeriods[0].approvedByUserId = 'approver';
    prisma._store.payrollPeriods[0].approvedAt = new Date();
    const token = tokenFor({ permissions: [PERMISSIONS.PAYROLL_PERIOD_REOPEN] });
    const phrase = payrollReopenConfirmationPhrase(2026, 8);
    expect(phrase).toBe('REOPEN-2026-08');

    const missingConfirm = await request(app)
      .post('/api/v2/payroll/periods/period-1/reopen')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'fix amount' });
    expect(missingConfirm.status).toBe(400);

    const wrongPhrase = await request(app)
      .post('/api/v2/payroll/periods/period-1/reopen')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'fix amount', confirm: true, confirmationPhrase: 'REOPEN-WRONG' });
    expect(wrongPhrase.status).toBe(400);
    expect(wrongPhrase.body.code).toBe('REOPEN_CONFIRMATION_MISMATCH');

    const reopened = await request(app)
      .post('/api/v2/payroll/periods/period-1/reopen')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'fix amount', confirm: true, confirmationPhrase: phrase });
    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe('calculated');
    expect(prisma._store.payrollPeriods[0].approvedByUserId).toBeNull();

    prisma._store.payrollPeriods[0].status = 'approved';
    prisma._store.payrollPeriods[0].ledgerPostedAt = new Date();
    const ledgerBlocked = await request(app)
      .post('/api/v2/payroll/periods/period-1/reopen')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'too late', confirm: true, confirmationPhrase: phrase });
    expect(ledgerBlocked.status).toBe(409);
    expect(ledgerBlocked.body.code).toBe('PAYROLL_LEDGER_POSTED');
  });

  it('redacts owner adjustment amounts without salary.view_owner', async () => {
    const app = makeApp(prisma);
    prisma._store.payrollItems[0].employeeId = 'owner-emp';
    prisma._store.payrollItems[0].employee = {
      user: { id: 'owner-user', name: 'Owner', role: { permissions: '[]' } },
    };
    prisma._store.employees[0].id = 'owner-emp';
    prisma._store.employees[0].user = {
      id: 'owner-user',
      name: 'Owner',
      role: { permissions: '[]' },
    };
    const token = tokenFor({ permissions: [PERMISSIONS.PAYROLL_ITEM_ADJUST] });

    const applied = await request(app)
      .post('/api/v2/payroll/periods/period-1/items/item-1/adjust')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'adjust-owner-redact-01')
      .send({ direction: 'allowance', amount: '10.00', reason: 'owner adj' });
    expect(applied.status).toBe(201);
    expect(applied.body.redacted).toBe(true);
    expect(applied.body.adjustment.amount).toBeNull();
  });
});
