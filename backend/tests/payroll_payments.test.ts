import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPayrollPaymentRoutes } from '../src/payrollPayments';
import { PERMISSIONS } from '../src/permissions';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

const period = (overrides: Record<string, unknown> = {}) => ({
  id: 'period-1',
  companyId: 'c1',
  month: 7,
  year: 2026,
  status: 'approved',
  createdByUserId: 'creator-1',
  calculatedByUserId: 'calc-1',
  approvedByUserId: 'approver-1',
  paidByUserId: null,
  calculatedAt: new Date('2026-07-01T00:00:00.000Z'),
  approvedAt: new Date('2026-07-02T00:00:00.000Z'),
  paidAt: null,
  calculationVersion: 1,
  calculationFingerprint: 'fp-1',
  paymentVersion: 0,
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  ...overrides,
});

const employee = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  companyId: 'c1',
  employeeNum: `EMP-${id}`,
  jobTitle: 'Specialist',
  joiningDate: new Date('2025-01-01T00:00:00.000Z'),
  status: 'active',
  departmentId: 'dept-1',
  department: { name: 'Operations' },
  user: { id: `user-${id}`, name: `Employee ${id}`, role: { permissions: '[]' } },
  ...overrides,
});

const ownerEmployee = (id = 'owner-1') => employee(id, {
  employeeNum: 'OWNER-1',
  user: { id: 'owner-user', name: 'Company Owner', role: { permissions: '[]' } },
});

const payrollItem = (
  employeeId: string,
  netPay: string,
  overrides: Record<string, unknown> = {},
) => ({
  id: `item-${employeeId}`,
  companyId: 'c1',
  payrollPeriodId: 'period-1',
  employeeId,
  salaryRecordId: `salary-${employeeId}`,
  employeeNameSnapshot: `Employee ${employeeId}`,
  employeeNumSnapshot: `EMP-${employeeId}`,
  departmentNameSnapshot: 'Operations',
  baseSalary: netPay,
  grossPay: netPay,
  totalDeductions: '0.00',
  netPay,
  currency: 'SAR',
  status: 'calculated',
  calculatedAt: new Date('2026-07-01T00:00:00.000Z'),
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  ...overrides,
});

function extendPrismaWithPayments(base: ReturnType<typeof makeFakePrisma>) {
  const payrollPayments: any[] = [];
  base.payrollPayment = {
    findMany: vi.fn(async ({ where, orderBy }: any = {}) => {
      let rows = payrollPayments.filter((payment) => {
        if (where.companyId !== undefined && payment.companyId !== where.companyId) return false;
        if (where.payrollPeriodId !== undefined && payment.payrollPeriodId !== where.payrollPeriodId) {
          return false;
        }
        return true;
      });
      if (orderBy) {
        rows = rows.sort((left, right) => {
          const createdOrder = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
          if (createdOrder !== 0) return createdOrder;
          return String(left.id).localeCompare(String(right.id));
        });
      }
      return rows;
    }),
    findFirst: vi.fn(async ({ where }: any) =>
      payrollPayments.find((payment) => {
        if (where.id !== undefined && payment.id !== where.id) return false;
        if (where.companyId !== undefined && payment.companyId !== where.companyId) return false;
        if (where.payrollPeriodId !== undefined && payment.payrollPeriodId !== where.payrollPeriodId) {
          return false;
        }
        if (where.idempotencyKey !== undefined && payment.idempotencyKey !== where.idempotencyKey) {
          return false;
        }
        return true;
      }) ?? null),
    create: vi.fn(async ({ data }: any) => {
      const row = {
        id: data.id ?? `payment-${payrollPayments.length + 1}`,
        status: 'posted',
        voidedAt: null,
        voidedByUserId: null,
        voidReason: null,
        isLegacyMigration: false,
        createdAt: new Date(),
        ...data,
      };
      payrollPayments.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = payrollPayments.find((payment) => payment.id === where.id);
      if (!row) return null;
      Object.assign(row, data);
      return row;
    }),
  };
  base._store.payrollPayments = payrollPayments;
  return base;
}

function makePayrollPaymentsApp(prisma: ReturnType<typeof makeFakePrisma>) {
  const app = express();
  app.use(express.json());

  const requireAuth = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const header = req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const payload = jwt.verify(header.slice(7), TEST_SECRET) as {
        id: string;
        companyId: string;
        employeeId: string | null;
        permissions: string[];
      };
      (req as express.Request & { user?: typeof payload }).user = payload;
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };

  const checkAnyPermission = (...requiredPermissions: string[]) =>
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const permissions = (req as express.Request & { user?: { permissions?: string[] } }).user?.permissions ?? [];
      if (
        permissions.includes(PERMISSIONS.ADMIN_FULL)
        || requiredPermissions.some((permission) => permissions.includes(permission))
      ) {
        return next();
      }
      return res.status(403).json({ error: 'Forbidden' });
    };

  registerPayrollPaymentRoutes({ app, prisma, requireAuth, checkAnyPermission });
  return app;
}

describe('payroll payment routes', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let app: express.Express;

  beforeEach(() => {
    prisma = extendPrismaWithPayments(makeFakePrisma());
    app = makePayrollPaymentsApp(prisma);
    prisma._store.payrollPeriods.push(period());
    prisma._store.employees.push(employee('employee-1'), ownerEmployee());
    prisma._store.payrollItems.push(
      payrollItem('employee-1', '1000.00'),
      payrollItem('owner-1', '5000.00'),
    );
  });

  const paymentsToken = (
    permissions: string[],
    id = 'finance-1',
    companyId = 'c1',
  ) => tokenFor({ id, companyId, employeeId: 'e-finance', permissions });

  const recordPayment = (
    body: Record<string, unknown>,
    permissions: string[] = [PERMISSIONS.PAYROLL_PAYMENTS_RECORD, PERMISSIONS.SALARY_VIEW_OWNER],
    idempotencyKey = 'record-key-001',
  ) =>
    request(app)
      .post('/api/v2/payroll/periods/period-1/payments')
      .set('Authorization', `Bearer ${paymentsToken(permissions)}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);

  const voidPayment = (
    paymentId: string,
    body: Record<string, unknown>,
    permissions: string[] = [PERMISSIONS.PAYROLL_PAYMENTS_VOID, PERMISSIONS.SALARY_VIEW_OWNER],
  ) =>
    request(app)
      .post(`/api/v2/payroll/periods/period-1/payments/${paymentId}/void`)
      .set('Authorization', `Bearer ${paymentsToken(permissions)}`)
      .send(body);

  it('requires payroll.payments.view to list payments', async () => {
    const denied = await request(app)
      .get('/api/v2/payroll/periods/period-1/payments')
      .set('Authorization', `Bearer ${paymentsToken([PERMISSIONS.PAYROLL_VIEW])}`);
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .get('/api/v2/payroll/periods/period-1/payments')
      .set('Authorization', `Bearer ${paymentsToken([PERMISSIONS.PAYROLL_PAYMENTS_VIEW])}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual([]);
  });

  it('requires payroll.payments.record and rejects missing Idempotency-Key', async () => {
    const denied = await request(app)
      .post('/api/v2/payroll/periods/period-1/payments')
      .set('Authorization', `Bearer ${paymentsToken([PERMISSIONS.PAYROLL_VIEW])}`)
      .send({
        amount: '100.00',
        currency: 'SAR',
        paymentDate: '2026-07-10',
        expectedVersion: 0,
      });
    expect(denied.status).toBe(403);

    const missingKey = await recordPayment({
      amount: '100.00',
      currency: 'SAR',
      paymentDate: '2026-07-10',
      expectedVersion: 0,
    }, [PERMISSIONS.PAYROLL_PAYMENTS_RECORD], '');
    expect(missingKey.status).toBe(400);
    expect(missingKey.body.messageKey).toBe('payroll.payments.idempotency_key_required');
  });

  it('records a payment and replays the same idempotency key safely', async () => {
    const first = await recordPayment({
      amount: '1000.00',
      currency: 'SAR',
      paymentDate: '2026-07-10',
      reference: 'TRX-001',
      expectedVersion: 0,
    });
    expect(first.status).toBe(201);
    expect(first.body.payment).toMatchObject({
      amount: '1000.00',
      currency: 'SAR',
      status: 'posted',
      idempotencyKey: 'record-key-001',
    });
    expect(first.body.period).toMatchObject({
      paymentState: 'partially_paid',
      paymentVersion: 1,
      numericLabel: '2026-07',
      approvedNetTotal: '6000.00',
    });
    expect(prisma._store.payrollPayments).toHaveLength(1);
    expect(prisma._store.auditLogs.some((entry: any) => entry.action === 'payroll.payment.record')).toBe(true);

    const replay = await recordPayment({
      amount: '1000.00',
      currency: 'SAR',
      paymentDate: '2026-07-10',
      reference: 'TRX-001',
      expectedVersion: 1,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.payment.id).toBe(first.body.payment.id);
    expect(prisma._store.payrollPayments).toHaveLength(1);
  });

  it('rejects overpayment, zero amount, wrong currency, and stale expectedVersion', async () => {
    const overpay = await recordPayment({
      amount: '7000.00',
      currency: 'SAR',
      paymentDate: '2026-07-10',
      expectedVersion: 0,
    }, [PERMISSIONS.PAYROLL_PAYMENTS_RECORD, PERMISSIONS.SALARY_VIEW_OWNER], 'overpay-key-001');
    expect(overpay.status).toBe(409);
    expect(overpay.body.messageKey).toBe('payroll.payments.overpayment');

    const zero = await recordPayment({
      amount: '0.00',
      currency: 'SAR',
      paymentDate: '2026-07-10',
      expectedVersion: 0,
    }, [PERMISSIONS.PAYROLL_PAYMENTS_RECORD, PERMISSIONS.SALARY_VIEW_OWNER], 'zero-key-001');
    expect(zero.status).toBe(400);
    expect(zero.body.messageKey).toBe('payroll.payments.amount_must_be_positive');

    const wrongCurrency = await recordPayment({
      amount: '100.00',
      currency: 'USD',
      paymentDate: '2026-07-10',
      expectedVersion: 0,
    }, [PERMISSIONS.PAYROLL_PAYMENTS_RECORD, PERMISSIONS.SALARY_VIEW_OWNER], 'usd-key-001');
    expect(wrongCurrency.status).toBe(400);
    expect(wrongCurrency.body.messageKey).toBe('payroll.payments.currency_not_supported');

    await recordPayment({
      amount: '1000.00',
      currency: 'SAR',
      paymentDate: '2026-07-10',
      expectedVersion: 0,
    }, [PERMISSIONS.PAYROLL_PAYMENTS_RECORD, PERMISSIONS.SALARY_VIEW_OWNER], 'stale-key-001');

    const stale = await recordPayment({
      amount: '500.00',
      currency: 'SAR',
      paymentDate: '2026-07-11',
      expectedVersion: 0,
    }, [PERMISSIONS.PAYROLL_PAYMENTS_RECORD, PERMISSIONS.SALARY_VIEW_OWNER], 'stale-key-002');
    expect(stale.status).toBe(412);
    expect(stale.body.messageKey).toBe('payroll.payments.version_mismatch');
  });

  it('rejects a second payment that would overpay after an earlier posted payment', async () => {
    const first = await recordPayment({
      amount: '5500.00',
      currency: 'SAR',
      paymentDate: '2026-07-10',
      expectedVersion: 0,
    }, [PERMISSIONS.PAYROLL_PAYMENTS_RECORD, PERMISSIONS.SALARY_VIEW_OWNER], 'partial-key-001');
    expect(first.status).toBe(201);

    const second = await recordPayment({
      amount: '600.00',
      currency: 'SAR',
      paymentDate: '2026-07-11',
      expectedVersion: 1,
    }, [PERMISSIONS.PAYROLL_PAYMENTS_RECORD, PERMISSIONS.SALARY_VIEW_OWNER], 'partial-key-002');
    expect(second.status).toBe(409);
    expect(second.body.messageKey).toBe('payroll.payments.overpayment');
    expect(prisma._store.payrollPayments).toHaveLength(1);
  });

  it('requires payroll.payments.void, preserves history, and rederives payment state', async () => {
    const full = await recordPayment({
      amount: '6000.00',
      currency: 'SAR',
      paymentDate: '2026-07-10',
      expectedVersion: 0,
    }, [PERMISSIONS.PAYROLL_PAYMENTS_RECORD, PERMISSIONS.SALARY_VIEW_OWNER], 'full-key-001');
    expect(full.status).toBe(201);
    expect(full.body.period.paymentState).toBe('paid');
    expect(full.body.period.status).toBe('paid');
    const paymentId = full.body.payment.id;

    const denied = await voidPayment(paymentId, {
      reason: 'Duplicate transfer',
      expectedVersion: 1,
    }, [PERMISSIONS.PAYROLL_PAYMENTS_VIEW]);
    expect(denied.status).toBe(403);

    const voided = await voidPayment(paymentId, {
      reason: 'Duplicate transfer',
      expectedVersion: 1,
    });
    expect(voided.status).toBe(200);
    expect(voided.body.payment).toMatchObject({
      id: paymentId,
      status: 'voided',
      voidReason: 'Duplicate transfer',
    });
    expect(voided.body.period).toMatchObject({
      paymentState: 'unpaid',
      status: 'approved',
      paymentVersion: 2,
    });
    expect(prisma._store.payrollPayments).toHaveLength(1);
    expect(prisma._store.auditLogs.some((entry: any) => entry.action === 'payroll.payment.void')).toBe(true);
  });

  it('hides approvedNetTotal without salary.view_owner while still enforcing full net ceiling server-side', async () => {
    prisma.companyOwnership.findFirst.mockResolvedValue({ userId: 'owner-user' });

    const hidden = await recordPayment({
      amount: '1000.00',
      currency: 'SAR',
      paymentDate: '2026-07-10',
      expectedVersion: 0,
    }, [PERMISSIONS.PAYROLL_PAYMENTS_RECORD]);
    expect(hidden.status).toBe(201);
    expect(hidden.body.period.approvedNetTotal).toBeUndefined();
    expect(hidden.body.period.fullSummary).toBeUndefined();
    expect(hidden.body.period.visibleSummary.visibleNet).toBe('1000.00');
    expect(hidden.body.period.protectedRowsHidden).toBe(true);

    const overpay = await recordPayment({
      amount: '5500.00',
      currency: 'SAR',
      paymentDate: '2026-07-11',
      expectedVersion: 1,
    }, [PERMISSIONS.PAYROLL_PAYMENTS_RECORD], 'hidden-overpay-key');
    expect(overpay.status).toBe(409);
    expect(overpay.body.messageKey).toBe('payroll.payments.overpayment');
  });

  it('returns opaque 404 for another company period', async () => {
    prisma._store.payrollPeriods.push(period({ id: 'foreign-period', companyId: 'c2' }));

    const list = await request(app)
      .get('/api/v2/payroll/periods/foreign-period/payments')
      .set('Authorization', `Bearer ${paymentsToken([PERMISSIONS.PAYROLL_PAYMENTS_VIEW], 'finance-1', 'c1')}`);
    expect(list.status).toBe(404);

    const record = await request(app)
      .post('/api/v2/payroll/periods/foreign-period/payments')
      .set('Authorization', `Bearer ${paymentsToken([PERMISSIONS.PAYROLL_PAYMENTS_RECORD])}`)
      .set('Idempotency-Key', 'foreign-key-001')
      .send({
        amount: '100.00',
        currency: 'SAR',
        paymentDate: '2026-07-10',
        expectedVersion: 0,
      });
    expect(record.status).toBe(404);
    expect(record.body.messageKey).toBe('payroll.payments.period_not_found');
  });
});
