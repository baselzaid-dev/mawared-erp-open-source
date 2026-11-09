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

async function seedAccounts(app: express.Express, token: string) {
  const expense = await request(app)
    .post('/api/v2/finance/chart-of-accounts')
    .set('Authorization', `Bearer ${token}`)
    .send({ code: '5000', name: 'Expense', type: 'Expense' });
  const cash = await request(app)
    .post('/api/v2/finance/chart-of-accounts')
    .set('Authorization', `Bearer ${token}`)
    .send({ code: '1000', name: 'Cash', type: 'Asset' });
  return { expense: expense.body, cash: cash.body };
}

describe('finance journal entries', () => {
  it('creates balanced drafts, posts with idempotency, and reverses immutably', async () => {
    const prisma = makeFakePrisma();
    const app = makeFinanceApp(prisma);
    const token = tokenFor({
      permissions: [
        PERMISSIONS.FINANCE_VIEW,
        PERMISSIONS.FINANCE_CREATE,
        PERMISSIONS.FINANCE_APPROVE,
        PERMISSIONS.FINANCE_MANAGE,
      ],
    });
    const { expense, cash } = await seedAccounts(app, token);

    const unbalanced = await request(app)
      .post('/api/v2/finance/journal-entries')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entryDate: '2026-08-01',
        lines: [
          { accountId: expense.id, debit: '100.00', credit: '0.00' },
          { accountId: cash.id, debit: '0.00', credit: '50.00' },
        ],
      });
    expect(unbalanced.status).toBe(400);

    const created = await request(app)
      .post('/api/v2/finance/journal-entries')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entryDate: '2026-08-01',
        memo: 'Manual entry',
        lines: [
          { accountId: expense.id, debit: '100.00', credit: '0.00' },
          { accountId: cash.id, debit: '0.00', credit: '100.00' },
        ],
      });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('draft');
    expect(created.body.totalDebit).toBe('100.00');

    const posted = await request(app)
      .post(`/api/v2/finance/journal-entries/${created.body.id}/post`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'journal-post-key-001')
      .send({});
    expect(posted.status).toBe(200);
    expect(posted.body.status).toBe('posted');

    const retry = await request(app)
      .post(`/api/v2/finance/journal-entries/${created.body.id}/post`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'journal-post-key-001')
      .send({});
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);

    const patchBlocked = await request(app)
      .patch(`/api/v2/finance/journal-entries/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ memo: 'nope' });
    expect(patchBlocked.status).toBe(409);

    const reversed = await request(app)
      .post(`/api/v2/finance/journal-entries/${created.body.id}/reverse`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'journal-reverse-key-001')
      .send({});
    expect(reversed.status).toBe(201);
    expect(reversed.body.status).toBe('posted');
    expect(reversed.body.reversesJournalEntryId).toBe(created.body.id);
    expect(reversed.body.lines[0].debit).toBe('0.00');
    expect(reversed.body.lines[0].credit).toBe('100.00');

    const original = await request(app)
      .get(`/api/v2/finance/journal-entries/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(original.body.status).toBe('reversed');
  });
});
