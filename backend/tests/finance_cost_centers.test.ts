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
  return app;
}

describe('finance cost centers', () => {
  it('creates, lists, patches, and archives cost centers', async () => {
    const prisma = makeFakePrisma();
    const app = makeFinanceApp(prisma);
    const token = tokenFor({
      permissions: [PERMISSIONS.FINANCE_VIEW, PERMISSIONS.FINANCE_CREATE, PERMISSIONS.FINANCE_MANAGE],
    });

    const created = await request(app)
      .post('/api/v2/finance/cost-centers')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'OPS', name: 'Operations', description: 'Ops center' });
    expect(created.status).toBe(201);
    expect(created.body.code).toBe('OPS');

    const listed = await request(app)
      .get('/api/v2/finance/cost-centers')
      .set('Authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);

    const patched = await request(app)
      .patch(`/api/v2/finance/cost-centers/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ops Renamed' });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe('Ops Renamed');

    const archived = await request(app)
      .post(`/api/v2/finance/cost-centers/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`);
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('archived');
  });
});
