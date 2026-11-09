import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { registerFinanceRoutes } from '../src/finance';
import { PERMISSIONS } from '../src/permissions';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

function makeFinanceApp(prisma: ReturnType<typeof makeFakePrisma>) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const header = req.header('Authorization');
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const payload = jwt.verify(header.slice(7), TEST_SECRET) as any;
      (req as any).user = payload;
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
  return app;
}

describe('finance chart of accounts', () => {
  it('creates hierarchical accounts with unique codes and rejects cycles', async () => {
    const prisma = makeFakePrisma();
    const app = makeFinanceApp(prisma);
    const token = tokenFor({
      permissions: [PERMISSIONS.FINANCE_CREATE, PERMISSIONS.FINANCE_MANAGE, PERMISSIONS.FINANCE_VIEW],
    });

    const parent = await request(app)
      .post('/api/v2/finance/chart-of-accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '1000', name: 'Assets', type: 'Asset' });
    expect(parent.status).toBe(201);

    const child = await request(app)
      .post('/api/v2/finance/chart-of-accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: '1100',
        name: 'Cash',
        type: 'Asset',
        parentId: parent.body.id,
      });
    expect(child.status).toBe(201);
    expect(child.body.parentId).toBe(parent.body.id);

    const dup = await request(app)
      .post('/api/v2/finance/chart-of-accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '1000', name: 'Dup', type: 'Asset' });
    expect(dup.status).toBe(409);

    const cycle = await request(app)
      .patch(`/api/v2/finance/chart-of-accounts/${parent.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parentId: child.body.id });
    expect(cycle.status).toBe(400);
    expect(cycle.body.code).toBe('ACCOUNT_CYCLE');
  });

  it('archives leaf accounts only', async () => {
    const prisma = makeFakePrisma();
    const app = makeFinanceApp(prisma);
    const token = tokenFor({ permissions: [PERMISSIONS.FINANCE_CREATE, PERMISSIONS.FINANCE_MANAGE] });

    const parent = await request(app)
      .post('/api/v2/finance/chart-of-accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '2000', name: 'Liabilities', type: 'Liability' });
    await request(app)
      .post('/api/v2/finance/chart-of-accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '2100', name: 'Payables', type: 'Liability', parentId: parent.body.id });

    const blocked = await request(app)
      .post(`/api/v2/finance/chart-of-accounts/${parent.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`);
    expect(blocked.status).toBe(409);
  });
});
