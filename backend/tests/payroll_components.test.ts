import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { registerPayrollW1aRoutes } from '../src/payrollW1a';
import { percentageOfBaseCents, computeEmployeePay } from '../src/payrollComponentsCalc';
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

describe('payroll components', () => {
  it('computes percentage components with truncate-toward-zero exact cents', () => {
    // 1000.00 * 1250 bps / 10000 = 125.00
    expect(percentageOfBaseCents(100000n, 1250)).toBe(12500n);
    // 100.33 * 3333 / 10000 truncates toward zero
    expect(percentageOfBaseCents(10033n, 3333)).toBe(3343n);

    const pay = computeEmployeePay(
      '1000.00',
      [{
        id: 'd1',
        code: 'HRA',
        name: 'Housing',
        componentType: 'allowance',
        calcMethod: 'percentage',
        fixedAmount: null,
        rateBps: 2500,
        percentageBasis: 'base_salary',
        version: 1,
        currency: 'SAR',
        status: 'active',
      }, {
        id: 'd2',
        code: 'DED',
        name: 'Loan',
        componentType: 'deduction',
        calcMethod: 'fixed',
        fixedAmount: '50.00',
        rateBps: null,
        percentageBasis: null,
        version: 1,
        currency: 'SAR',
        status: 'active',
      }],
      [],
    );
    expect(pay.grossPay).toBe('1250.00');
    expect(pay.totalDeductions).toBe('50.00');
    expect(pay.netPay).toBe('1200.00');
  });

  it('creates and archives component definitions via API', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const token = tokenFor({
      permissions: [PERMISSIONS.PAYROLL_VIEW, PERMISSIONS.PAYROLL_MANAGE],
    });

    const created = await request(app)
      .post('/api/v2/payroll/component-definitions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: 'HRA',
        name: 'Housing',
        componentType: 'allowance',
        calcMethod: 'percentage',
        rateBps: 2500,
        percentageBasis: 'base_salary',
      });
    expect(created.status).toBe(201);
    expect(created.body.version).toBe(1);

    const rejectedBasis = await request(app)
      .post('/api/v2/payroll/component-definitions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: 'BAD',
        name: 'Bad',
        componentType: 'allowance',
        calcMethod: 'percentage',
        rateBps: 1000,
        percentageBasis: 'gross',
      });
    expect(rejectedBasis.status).toBe(400);

    const patched = await request(app)
      .patch(`/api/v2/payroll/component-definitions/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rateBps: 3000, calcMethod: 'percentage', percentageBasis: 'base_salary' });
    expect(patched.status).toBe(200);
    expect(patched.body.version).toBe(2);

    const archived = await request(app)
      .post(`/api/v2/payroll/component-definitions/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`);
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('archived');
  });
});
