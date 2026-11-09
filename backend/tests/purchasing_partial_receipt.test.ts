import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { tokenFor } from './helpers';
import {
  BUYER_PERMISSIONS,
  buyerToken,
  createIssuedOrder,
  foreignToken,
  makeW2Prisma,
  w2App,
} from './purchasing_w2_fixture';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const lineOf = (order: any, index: number) => order.lines[index].id;

const receive = (app: any, orderId: string, token: string, key: string, body: any) =>
  request(app)
    .post(`/api/v2/purchasing/orders/${orderId}/receipts`)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send(body);

const progressFor = (response: any, lineId: string) =>
  response.body.progress.lines.find((line: any) => line.purchaseOrderLineId === lineId);

describe('W2 partial receipt', () => {
  it('records a partial receipt and reports the exact remaining quantity', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await createIssuedOrder(app, buyerToken());

    const first = await receive(app, order.id, buyerToken(), 'receipt-001-a', {
      referenceNumber: 'DN-1',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '4.500' }],
    });
    expect(first.status).toBe(201);
    expect(first.body.receipt.receiptKind).toBe('partial');
    const lineProgress = progressFor(first, lineOf(order, 0));
    expect(lineProgress.orderedQuantity).toBe('10.000');
    expect(lineProgress.receivedQuantity).toBe('4.500');
    expect(lineProgress.remainingQuantity).toBe('5.500');
    expect(lineProgress.fullyReceived).toBe(false);
    expect(first.body.progress.fullyReceived).toBe(false);

    const orderAfter = await request(app)
      .get(`/api/purchasing/orders/${order.id}`)
      .set(auth(buyerToken()));
    expect(orderAfter.body.status).toBe('partially_received');
    expect(prisma._purchasing.requests[0].status).toBe('ordered');
  });

  it('accumulates multiple partial receipts and closes the order on the final one', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await createIssuedOrder(app, buyerToken());

    await receive(app, order.id, buyerToken(), 'receipt-002-a', {
      lines: [
        { purchaseOrderLineId: lineOf(order, 0), quantity: '6.000' },
        { purchaseOrderLineId: lineOf(order, 1), quantity: '2.000' },
      ],
    });
    const second = await receive(app, order.id, buyerToken(), 'receipt-002-b', {
      lines: [
        { purchaseOrderLineId: lineOf(order, 0), quantity: '4.000' },
        { purchaseOrderLineId: lineOf(order, 1), quantity: '3.000' },
      ],
    });
    expect(second.status).toBe(201);
    expect(second.body.progress.fullyReceived).toBe(true);
    expect(progressFor(second, lineOf(order, 0)).remainingQuantity).toBe('0.000');

    const orderAfter = await request(app)
      .get(`/api/purchasing/orders/${order.id}`)
      .set(auth(buyerToken()));
    expect(orderAfter.body.status).toBe('received');
    expect(prisma._purchasing.requests[0].status).toBe('received');
    expect(prisma._purchasing.receipts).toHaveLength(2);
  });

  it('keeps the legacy whole-order receive working and records it as one event', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await createIssuedOrder(app, buyerToken());

    const legacy = await request(app)
      .post(`/api/purchasing/orders/${order.id}/receive`)
      .set(auth(buyerToken()))
      .send({ receiptNote: 'استلام كامل' });
    expect(legacy.status).toBe(200);
    expect(legacy.body.status).toBe('received');
    expect(prisma._purchasing.requests[0].status).toBe('received');

    const receipts = prisma._purchasing.receipts;
    expect(receipts).toHaveLength(1);
    expect(receipts[0].receiptKind).toBe('full');
    expect(prisma._purchasing.receiptLines).toHaveLength(2);
    const list = await request(app)
      .get(`/api/v2/purchasing/orders/${order.id}/receipts`)
      .set(auth(buyerToken()));
    expect(list.status).toBe(200);
    expect(list.body.progress.fullyReceived).toBe(true);
  });

  it('lets the legacy whole-order path close out a partially received order', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await createIssuedOrder(app, buyerToken());
    await receive(app, order.id, buyerToken(), 'receipt-mix-001', {
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '3.000' }],
    });

    const legacy = await request(app)
      .post(`/api/purchasing/orders/${order.id}/receive`)
      .set(auth(buyerToken()))
      .send({ receiptNote: 'إغلاق المتبقي' });
    expect(legacy.status).toBe(200);
    expect(legacy.body.status).toBe('received');

    const list = await request(app)
      .get(`/api/v2/purchasing/orders/${order.id}/receipts`)
      .set(auth(buyerToken()));
    const first = list.body.progress.lines.find(
      (line: any) => line.purchaseOrderLineId === lineOf(order, 0),
    );
    expect(first.receivedQuantity).toBe('10.000');
    expect(first.remainingQuantity).toBe('0.000');
    // 3.000 from the partial receipt + 7.000 remaining from the legacy close-out.
    expect(prisma._purchasing.receipts).toHaveLength(2);
  });

  it('rejects zero, negative and non-exact quantities', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await createIssuedOrder(app, buyerToken());

    for (const [index, quantity] of ['0', '-1.000', '1.0001', '1e2'].entries()) {
      const response = await receive(app, order.id, buyerToken(), `receipt-bad-00${index}`, {
        lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity }],
      });
      expect(response.status).toBe(400);
    }
    expect(prisma._purchasing.receipts).toHaveLength(0);
  });

  it('rejects an over-receipt without an explicit override', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await createIssuedOrder(app, buyerToken());

    const excess = await receive(app, order.id, buyerToken(), 'receipt-over-001', {
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '10.001' }],
    });
    expect(excess.status).toBe(409);
    expect(excess.body.error).toBe('RECEIPT_EXCEEDS_REMAINING');
    expect(prisma._purchasing.receipts).toHaveLength(0);
  });

  it('allows an over-receipt only with the override permission, confirmation and reason', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await createIssuedOrder(app, buyerToken());

    const withoutPermission = await receive(app, order.id, buyerToken(), 'receipt-over-002', {
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '11.000' }],
      override: { confirmation: 'OVERRIDE', reason: 'المورد سلّم كمية زائدة' },
    });
    expect(withoutPermission.status).toBe(403);
    expect(withoutPermission.body.error).toBe('RECEIPT_OVERRIDE_FORBIDDEN');

    const overrideToken = tokenFor({
      id: 'u-buyer',
      employeeId: '60000000-0000-4000-8000-000000000902',
      permissions: [...BUYER_PERMISSIONS, 'purchasing.admin_override'],
    });
    const wrongConfirmation = await receive(app, order.id, overrideToken, 'receipt-over-003', {
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '11.000' }],
      override: { confirmation: 'YES', reason: 'محاولة' },
    });
    expect(wrongConfirmation.status).toBe(400);

    const applied = await receive(app, order.id, overrideToken, 'receipt-over-004', {
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '11.000' }],
      override: { confirmation: 'OVERRIDE', reason: 'المورد سلّم كمية زائدة' },
    });
    expect(applied.status).toBe(201);
    expect(applied.body.receipt.overrideApplied).toBe(true);
    const line = progressFor(applied, lineOf(order, 0));
    expect(line.receivedQuantity).toBe('11.000');
    expect(line.remainingQuantity).toBe('0.000');

    const auditLog = prisma._store.auditLogs.find(
      (row: any) => row.action === 'purchasing.order.receive_partial',
    );
    const details = JSON.parse(auditLog.details);
    expect(details.overrideApplied).toBe(true);
    expect(details.reasonProvided).toBe(true);
    expect(JSON.stringify(details)).not.toContain('كمية زائدة');
  });

  it('rejects an override that is not needed', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await createIssuedOrder(app, buyerToken());
    const overrideToken = tokenFor({
      id: 'u-buyer',
      employeeId: '60000000-0000-4000-8000-000000000902',
      permissions: [...BUYER_PERMISSIONS, 'purchasing.admin_override'],
    });
    const response = await receive(app, order.id, overrideToken, 'receipt-noop-override', {
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' }],
      override: { confirmation: 'OVERRIDE', reason: 'غير لازم' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('RECEIPT_OVERRIDE_NOT_REQUIRED');
  });

  it('rejects a line that belongs to another order and duplicate lines', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await createIssuedOrder(app, buyerToken());

    const strayLine = await receive(app, order.id, buyerToken(), 'receipt-stray-001', {
      lines: [{ purchaseOrderLineId: '40000000-0000-4000-8000-0000000009ff', quantity: '1.000' }],
    });
    expect(strayLine.status).toBe(400);
    expect(strayLine.body.error).toBe('INVALID_ORDER_LINE');

    const duplicated = await receive(app, order.id, buyerToken(), 'receipt-dupe-001', {
      lines: [
        { purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' },
        { purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' },
      ],
    });
    expect(duplicated.status).toBe(400);
    expect(duplicated.body.error).toBe('DUPLICATE_RECEIPT_LINE');
  });

  it('rejects receiving a draft or cancelled order', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const draft = await request(app)
      .post('/api/purchasing/orders')
      .set(auth(buyerToken()))
      .send({
        purchaseRequestId: '10000000-0000-4000-8000-000000000901',
        vendorId: '70000000-0000-4000-8000-000000000901',
        lines: [{ description: 'حاسوب محمول', quantity: '1.000', unit: 'قطعة', unitPrice: '20.00' }],
      });
    expect(draft.status).toBe(201);

    const onDraft = await receive(app, draft.body.id, buyerToken(), 'receipt-draft-001', {
      lines: [{ purchaseOrderLineId: draft.body.lines[0].id, quantity: '1.000' }],
    });
    expect(onDraft.status).toBe(409);
    expect(onDraft.body.error).toBe('ORDER_RECEIVE_INVALID');

    await request(app)
      .post(`/api/purchasing/orders/${draft.body.id}/cancel`)
      .set(auth(buyerToken()))
      .send({ cancellationReason: 'إلغاء' });
    const onCancelled = await receive(app, draft.body.id, buyerToken(), 'receipt-cancel-001', {
      lines: [{ purchaseOrderLineId: draft.body.lines[0].id, quantity: '1.000' }],
    });
    expect(onCancelled.status).toBe(409);
  });

  it('replays an exact retry and rejects a same-key different payload', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await createIssuedOrder(app, buyerToken());
    const body = { lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '2.000' }] };

    const first = await receive(app, order.id, buyerToken(), 'receipt-retry-001', body);
    const retry = await receive(app, order.id, buyerToken(), 'receipt-retry-001', body);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.receipt.id).toBe(first.body.receipt.id);
    expect(prisma._purchasing.receipts).toHaveLength(1);
    expect(progressFor(retry, lineOf(order, 0)).receivedQuantity).toBe('2.000');

    const conflicting = await receive(app, order.id, buyerToken(), 'receipt-retry-001', {
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '3.000' }],
    });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.error).toBe('IDEMPOTENCY_CONFLICT');
    expect(prisma._purchasing.receipts).toHaveLength(1);
  });

  it('requires purchasing.receive and blocks cross-company access', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await createIssuedOrder(app, buyerToken());

    const weak = tokenFor({
      id: 'u-buyer',
      employeeId: '60000000-0000-4000-8000-000000000902',
      permissions: ['purchasing.view'],
    });
    const forbidden = await receive(app, order.id, weak, 'receipt-perm-001', {
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' }],
    });
    expect(forbidden.status).toBe(403);

    const cross = await receive(app, order.id, foreignToken(), 'receipt-idor-001', {
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' }],
    });
    expect(cross.status).toBe(404);
    expect(cross.body.error).toBe('PURCHASE_ORDER_NOT_FOUND');

    const crossRead = await request(app)
      .get(`/api/v2/purchasing/orders/${order.id}/receipts`)
      .set(auth(foreignToken()));
    expect(crossRead.status).toBe(404);
    expect(prisma._purchasing.receipts).toHaveLength(0);
  });

  it('writes a bounded audit entry for every partial receipt', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const order = await createIssuedOrder(app, buyerToken());
    await receive(app, order.id, buyerToken(), 'receipt-audit-001', {
      note: 'ملاحظة استلام لا يجب تسجيلها',
      lines: [{ purchaseOrderLineId: lineOf(order, 0), quantity: '1.000' }],
    });
    const entry = prisma._store.auditLogs.find(
      (row: any) => row.action === 'purchasing.order.receive_partial',
    );
    expect(entry).toBeTruthy();
    const details = JSON.parse(entry.details);
    expect(details.orderId).toBe(order.id);
    expect(details.newStatus).toBe('partially_received');
    expect(details.lineCount).toBe(1);
    expect(JSON.stringify(details)).not.toContain('ملاحظة استلام');
  });
});
