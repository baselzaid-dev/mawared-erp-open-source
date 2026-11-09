import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { tokenFor } from './helpers';
import {
  APPROVER_PERMISSIONS,
  BUYER_PERMISSIONS,
  approverToken,
  buyerToken,
  createIssuedOrder,
  foreignToken,
  makeW2Prisma,
  w2App,
} from './purchasing_w2_fixture';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const lineOf = (order: any, index: number) => order.lines[index].id;

const receive = (app: any, orderId: string, key: string, body: any) =>
  request(app)
    .post(`/api/v2/purchasing/orders/${orderId}/receipts`)
    .set(auth(buyerToken()))
    .set('Idempotency-Key', key)
    .send(body);

const createReturn = (app: any, orderId: string, token: string, key: string, body: any) =>
  request(app)
    .post(`/api/v2/purchasing/orders/${orderId}/returns`)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send(body);

const reviewReturn = (app: any, returnId: string, token: string, key: string, body: any) =>
  request(app)
    .post(`/api/v2/purchasing/returns/${returnId}/review`)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send(body);

async function receivedOrder(app: any, key = 'return-setup-001') {
  const order = await createIssuedOrder(app, buyerToken());
  const received = await receive(app, order.id, key, {
    lines: [
      { purchaseOrderLineId: lineOf(order, 0), quantity: '10.000' },
      { purchaseOrderLineId: lineOf(order, 1), quantity: '5.000' },
    ],
  });
  expect(received.status).toBe(201);
  return order;
}

const progressLine = (response: any, lineId: string) =>
  response.body.progress.lines.find((line: any) => line.purchaseOrderLineId === lineId);

describe('W2 purchase returns', () => {
  it('creates a partial return that holds quantity against the received line', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await receivedOrder(app);

    const created = await createReturn(app, order.id, buyerToken(), 'return-001-a', {
      reasonCode: 'damaged',
      note: 'وصلت تالفة',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '3.000' }],
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending_approval');
    expect(created.body.reasonCode).toBe('damaged');
    expect(created.body.lines[0].quantity).toBe('3.000');

    const receipts = await request(app)
      .get(`/api/v2/purchasing/orders/${order.id}/receipts`)
      .set(auth(buyerToken()));
    const line = progressLine(receipts, lineOf(order, 0));
    expect(line.receivedQuantity).toBe('10.000');
    expect(line.returnedQuantity).toBe('3.000');
    expect(line.netReceivedQuantity).toBe('7.000');
    // A return re-opens the line for a replacement delivery.
    expect(line.remainingQuantity).toBe('3.000');
  });

  it('accumulates multiple returns and refuses to over-return', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await receivedOrder(app);

    const first = await createReturn(app, order.id, buyerToken(), 'return-002-a', {
      reasonCode: 'damaged',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '6.000' }],
    });
    expect(first.status).toBe(201);
    const second = await createReturn(app, order.id, buyerToken(), 'return-002-b', {
      reasonCode: 'wrong_item',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '4.000' }],
    });
    expect(second.status).toBe(201);

    // 6 + 4 = 10 already held; one more unit is over-returning.
    const excess = await createReturn(app, order.id, buyerToken(), 'return-002-c', {
      reasonCode: 'other',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '0.001' }],
    });
    expect(excess.status).toBe(409);
    expect(excess.body.error).toBe('RETURN_EXCEEDS_RECEIVED');
    expect(prisma._purchasing.returns).toHaveLength(2);
  });

  it('refuses to return a quantity that was never received', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await createIssuedOrder(app, buyerToken());
    await receive(app, order.id, 'return-003-receipt', {
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '2.000' }],
    });

    const unreceivedLine = await createReturn(app, order.id, buyerToken(), 'return-003-a', {
      reasonCode: 'damaged',
      lines: [{ purchaseOrderLineId: lineOf(order, 1), quantity: '1.000' }],
    });
    expect(unreceivedLine.status).toBe(409);
    expect(unreceivedLine.body.error).toBe('RETURN_WITHOUT_RECEIPT');

    const tooMuch = await createReturn(app, order.id, buyerToken(), 'return-003-b', {
      reasonCode: 'damaged',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '2.001' }],
    });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toBe('RETURN_EXCEEDS_RECEIVED');
  });

  it('releases held quantity when a return is rejected and keeps receipt history', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await receivedOrder(app);
    const created = await createReturn(app, order.id, buyerToken(), 'return-004-a', {
      reasonCode: 'quality_rejected',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '10.000' }],
    });

    const rejected = await reviewReturn(app, created.body.id, approverToken(), 'return-004-review', {
      action: 'reject',
      note: 'الفحص أثبت المطابقة',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');

    const receipts = await request(app)
      .get(`/api/v2/purchasing/orders/${order.id}/receipts`)
      .set(auth(buyerToken()));
    const line = progressLine(receipts, lineOf(order, 0));
    expect(line.receivedQuantity).toBe('10.000');
    expect(line.returnedQuantity).toBe('0.000');
    expect(line.netReceivedQuantity).toBe('10.000');
    // The receipt event itself is untouched.
    expect(prisma._purchasing.receipts).toHaveLength(1);
    expect(prisma._purchasing.receiptLines).toHaveLength(2);
  });

  it('keeps an approved return holding its quantity', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await receivedOrder(app);
    const created = await createReturn(app, order.id, buyerToken(), 'return-005-a', {
      reasonCode: 'expired',
      lines: [{ purchaseOrderLineId: lineOf(order, 1), quantity: '5.000' }],
    });
    const approved = await reviewReturn(app, created.body.id, approverToken(), 'return-005-review', {
      action: 'approve',
    });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.review.actor.id).toBe('u-approver');

    const receipts = await request(app)
      .get(`/api/v2/purchasing/orders/${order.id}/receipts`)
      .set(auth(buyerToken()));
    const line = progressLine(receipts, lineOf(order, 1));
    expect(line.returnedQuantity).toBe('5.000');
    expect(line.netReceivedQuantity).toBe('0.000');
  });

  it('separates raising a return from approving it', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await receivedOrder(app);
    const created = await createReturn(app, order.id, buyerToken(), 'return-006-a', {
      reasonCode: 'damaged',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' }],
    });

    // The creator, even if granted the approve permission, cannot approve.
    const selfApprover = tokenFor({
      id: 'u-buyer',
      employeeId: '60000000-0000-4000-8000-000000000902',
      permissions: [...BUYER_PERMISSIONS, 'purchasing.return.approve'],
    });
    const blocked = await reviewReturn(app, created.body.id, selfApprover, 'return-006-self', {
      action: 'approve',
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('SELF_REVIEW_BLOCKED');

    // Creating requires purchasing.return.create.
    const noCreate = await createReturn(app, order.id, approverToken(), 'return-006-perm', {
      reasonCode: 'damaged',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' }],
    });
    expect(noCreate.status).toBe(403);

    // Reviewing requires purchasing.return.approve.
    const noApprove = await reviewReturn(app, created.body.id, buyerToken(), 'return-006-perm2', {
      action: 'approve',
    });
    expect(noApprove.status).toBe(403);
  });

  it('rejects a second review of an already reviewed return', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await receivedOrder(app);
    const created = await createReturn(app, order.id, buyerToken(), 'return-007-a', {
      reasonCode: 'damaged',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' }],
    });
    await reviewReturn(app, created.body.id, approverToken(), 'return-007-r1', { action: 'approve' });
    const again = await reviewReturn(app, created.body.id, approverToken(), 'return-007-r2', {
      action: 'reject',
      note: 'تغيير الرأي',
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('RETURN_REVIEW_INVALID');
  });

  it('replays exact retries for create and review', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await receivedOrder(app);
    const body = {
      reasonCode: 'damaged' as const,
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '2.000' }],
    };
    const first = await createReturn(app, order.id, buyerToken(), 'return-008-a', body);
    const retry = await createReturn(app, order.id, buyerToken(), 'return-008-a', body);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(prisma._purchasing.returns).toHaveLength(1);

    const conflicting = await createReturn(app, order.id, buyerToken(), 'return-008-a', {
      reasonCode: 'other' as const,
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '2.000' }],
    });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.error).toBe('IDEMPOTENCY_CONFLICT');

    const reviewBody = { action: 'approve' as const };
    const review1 = await reviewReturn(app, first.body.id, approverToken(), 'return-008-review', reviewBody);
    const review2 = await reviewReturn(app, first.body.id, approverToken(), 'return-008-review', reviewBody);
    expect(review1.status).toBe(200);
    expect(review2.status).toBe(200);
    expect(review2.body.status).toBe('approved');
  });

  it('conflicts when a review key is reused with a different action', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await receivedOrder(app);
    const created = await createReturn(app, order.id, buyerToken(), 'return-review-conflict-a', {
      reasonCode: 'damaged',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '2.000' }],
    });

    const approved = await reviewReturn(app, created.body.id, approverToken(), 'review-key-1', { action: 'approve' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    // Same key, opposite action MUST NOT replay the approved row as a success.
    const flipped = await reviewReturn(app, created.body.id, approverToken(), 'review-key-1', {
      action: 'reject',
      note: 'رفض بعد الاعتماد',
    });
    expect(flipped.status).toBe(409);
    expect(flipped.body.error).toBe('IDEMPOTENCY_CONFLICT');

    // Same key with a different note is also a different logical review.
    const changedNote = await reviewReturn(app, created.body.id, approverToken(), 'review-key-1', {
      action: 'approve',
      note: 'ملاحظة مختلفة',
    });
    expect(changedNote.status).toBe(409);
    expect(changedNote.body.error).toBe('IDEMPOTENCY_CONFLICT');

    // The persisted state is still the FIRST logical review: approved.
    expect(prisma._purchasing.returns[0].status).toBe('approved');
  });

  it('conflicts when a reject key is reused to approve', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await receivedOrder(app);
    const created = await createReturn(app, order.id, buyerToken(), 'return-review-conflict-b', {
      reasonCode: 'damaged',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '2.000' }],
    });

    const rejected = await reviewReturn(app, created.body.id, approverToken(), 'review-key-2', {
      action: 'reject',
      note: 'الفحص أثبت المطابقة',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');

    const flipped = await reviewReturn(app, created.body.id, approverToken(), 'review-key-2', { action: 'approve' });
    expect(flipped.status).toBe(409);
    expect(flipped.body.error).toBe('IDEMPOTENCY_CONFLICT');

    expect(prisma._purchasing.returns[0].status).toBe('rejected');
  });

  it('rejects returns on draft and cancelled orders and unknown lines', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await receivedOrder(app);

    const strayLine = await createReturn(app, order.id, buyerToken(), 'return-009-a', {
      reasonCode: 'damaged',
      lines: [{ purchaseOrderLineId: '40000000-0000-4000-8000-0000000009ff', quantity: '1.000' }],
    });
    expect(strayLine.status).toBe(400);
    expect(strayLine.body.error).toBe('INVALID_ORDER_LINE');

    const duplicate = await createReturn(app, order.id, buyerToken(), 'return-009-b', {
      reasonCode: 'damaged',
      lines: [
        { purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' },
        { purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' },
      ],
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toBe('DUPLICATE_RETURN_LINE');

    const badReason = await createReturn(app, order.id, buyerToken(), 'return-009-c', {
      reasonCode: 'because_i_said_so',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' }],
    });
    expect(badReason.status).toBe(400);
  });

  it('hides another company order and return behind an opaque 404', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await receivedOrder(app);
    const created = await createReturn(app, order.id, buyerToken(), 'return-010-a', {
      reasonCode: 'damaged',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' }],
    });

    const crossCreate = await createReturn(app, order.id, foreignToken(), 'return-010-idor', {
      reasonCode: 'damaged',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' }],
    });
    expect(crossCreate.status).toBe(404);

    const crossList = await request(app)
      .get(`/api/v2/purchasing/orders/${order.id}/returns`)
      .set(auth(foreignToken()));
    expect(crossList.status).toBe(404);

    const foreignApprover = tokenFor({
      id: 'u-foreign',
      companyId: 'c2',
      employeeId: '60000000-0000-4000-8000-0000000009f1',
      permissions: APPROVER_PERMISSIONS,
    });
    const crossReview = await reviewReturn(app, created.body.id, foreignApprover, 'return-010-idor2', {
      action: 'approve',
    });
    expect(crossReview.status).toBe(404);
    expect(prisma._purchasing.returns).toHaveLength(1);
    expect(prisma._purchasing.returns[0].status).toBe('pending_approval');
  });

  it('writes bounded audit metadata for create and review', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await receivedOrder(app);
    const created = await createReturn(app, order.id, buyerToken(), 'return-011-a', {
      reasonCode: 'wrong_item',
      note: 'ملاحظة سرية عن المورد',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' }],
    });
    await reviewReturn(app, created.body.id, approverToken(), 'return-011-review', { action: 'approve' });

    const actions = prisma._store.auditLogs.map((row: any) => row.action);
    expect(actions).toContain('purchasing.return.create');
    expect(actions).toContain('purchasing.return.approve');
    const createLog = prisma._store.auditLogs.find(
      (row: any) => row.action === 'purchasing.return.create',
    );
    const details = JSON.parse(createLog.details);
    expect(details.reasonCode).toBe('wrong_item');
    expect(details.lineCount).toBe(1);
    expect(JSON.stringify(details)).not.toContain('ملاحظة سرية');
  });
});
