import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { tokenFor } from './helpers';
import {
  APPROVER_PERMISSIONS,
  BUYER_PERMISSIONS,
  FOREIGN_REQUEST_ID,
  REQUEST_ID,
  REQUEST_LINE_A,
  VENDOR_B_ID,
  VENDOR_ID,
  approverToken,
  buyerToken,
  createIssuedOrder,
  foreignToken,
  makeW2Prisma,
  quotationBody,
  w2App,
} from './purchasing_w2_fixture';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createQuotation(app: any, token: string, body: any, key: string) {
  return request(app)
    .post(`/api/v2/purchasing/requests/${REQUEST_ID}/quotations`)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send(body);
}

async function submittedQuotation(app: any, token: string, vendorId: string, priceA: string, priceB: string, key: string) {
  const created = await createQuotation(app, token, quotationBody(vendorId, priceA, priceB), key);
  expect(created.status).toBe(201);
  const submitted = await request(app)
    .post(`/api/v2/purchasing/quotations/${created.body.id}/submit`)
    .set(auth(token))
    .send({});
  expect(submitted.status).toBe(200);
  return submitted.body;
}

describe('W2 supplier quotations', () => {
  it('creates a quotation with exact server-computed totals', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const created = await createQuotation(
      app,
      buyerToken(),
      quotationBody(VENDOR_ID, '19.99', '12.345'.slice(0, 5)),
      'quote-create-001',
    );
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('draft');
    expect(created.body.version).toBe(1);
    // 10.000 × 19.99 = 199.90 ; 5.000 × 12.34 = 61.70 ; total 261.60
    expect(created.body.lines[0].lineTotal).toBe('199.90');
    expect(created.body.lines[1].lineTotal).toBe('61.70');
    expect(created.body.totalAmount).toBe('261.60');
    expect(created.body.currency).toBe('SAR');
  });

  it('rounds a fractional quantity × price with exact integer arithmetic', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const body = quotationBody(VENDOR_ID, '2.22', '1.00');
    body.lines[0].quantity = '3.333';
    const created = await createQuotation(app, buyerToken(), body, 'quote-exact-001');
    expect(created.status).toBe(201);
    // 3.333 × 2.22 = 7.39926 → half-up to 7.40, matching the existing order math.
    expect(created.body.lines[0].lineTotal).toBe('7.40');
  });

  it('rejects JSON-number money and out-of-scale quantities', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const numeric = quotationBody(VENDOR_ID, '10.00', '10.00') as any;
    numeric.lines[0].unitPrice = 10;
    const rejectedNumber = await createQuotation(app, buyerToken(), numeric, 'quote-bad-001');
    expect(rejectedNumber.status).toBe(400);
    expect(rejectedNumber.body.error).toBe('VALIDATION_ERROR');

    const scaled = quotationBody(VENDOR_ID, '10.00', '10.00');
    scaled.lines[0].quantity = '1.0001';
    const rejectedScale = await createQuotation(app, buyerToken(), scaled, 'quote-bad-002');
    expect(rejectedScale.status).toBe(400);

    const scientific = quotationBody(VENDOR_ID, '1e3', '10.00');
    const rejectedScientific = await createQuotation(app, buyerToken(), scientific, 'quote-bad-003');
    expect(rejectedScientific.status).toBe(400);
  });

  it('replays an exact retry and rejects the same key reused on a different endpoint', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const body = quotationBody(VENDOR_ID, '10.00', '10.00');
    const first = await createQuotation(app, buyerToken(), body, 'quote-idem-001');
    expect(first.status).toBe(201);
    const retry = await createQuotation(app, buyerToken(), body, 'quote-idem-001');
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(prisma._purchasing.quotations).toHaveLength(1);

    // Same key on a different action (select) is a cross-operation conflict.
    const conflicting = await request(app)
      .post(`/api/v2/purchasing/quotations/${first.body.id}/select`)
      .set(auth(buyerToken()))
      .set('Idempotency-Key', 'quote-idem-001')
      .send({ confirm: true, reason: 'أفضل سعر' });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.error).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('conflicts on a same-key create with a materially different quotation body', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const first = await createQuotation(app, buyerToken(), quotationBody(VENDOR_ID, '10.00', '10.00'), 'quote-payload-001');
    expect(first.status).toBe(201);

    // Same endpoint, same key — each of these is a different logical payload and
    // must conflict rather than replay the first quotation.
    const differentPrice = quotationBody(VENDOR_ID, '11.00', '10.00');
    const differentVendor = quotationBody(VENDOR_B_ID, '10.00', '10.00');
    const differentReference = quotationBody(VENDOR_ID, '10.00', '10.00');
    differentReference.supplierReference = 'Q-2026-999';
    const differentDate = quotationBody(VENDOR_ID, '10.00', '10.00');
    differentDate.validUntilDate = '2026-10-10';
    const fewerLines = quotationBody(VENDOR_ID, '10.00', '10.00');
    fewerLines.lines = [fewerLines.lines[0]];
    const differentQuantity = quotationBody(VENDOR_ID, '10.00', '10.00');
    differentQuantity.lines[0].quantity = '9.000';

    for (const [label, body] of Object.entries({
      differentPrice,
      differentVendor,
      differentReference,
      differentDate,
      fewerLines,
      differentQuantity,
    })) {
      const conflicting = await createQuotation(app, buyerToken(), body, 'quote-payload-001');
      expect(conflicting.status, label).toBe(409);
      expect(conflicting.body.error, label).toBe('IDEMPOTENCY_CONFLICT');
    }

    // No second quotation was ever created.
    expect(prisma._purchasing.quotations).toHaveLength(1);

    // An exactly-equivalent body still replays, including a trailing-zero form
    // of the same exact quantity — canonicalized before fingerprinting.
    const equivalent = quotationBody(VENDOR_ID, '10.00', '10.00');
    equivalent.lines[0].quantity = '10';
    const replay = await createQuotation(app, buyerToken(), equivalent, 'quote-payload-001');
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(prisma._purchasing.quotations).toHaveLength(1);
  });

  it('requires an idempotency key for create and select', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const missing = await request(app)
      .post(`/api/v2/purchasing/requests/${REQUEST_ID}/quotations`)
      .set(auth(buyerToken()))
      .send(quotationBody(VENDOR_ID, '10.00', '10.00'));
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('rejects an inactive vendor and an unknown request line', async () => {
    const prisma = makeW2Prisma();
    prisma._store.vendors[0].status = 'inactive';
    const app = w2App(prisma);
    const inactive = await createQuotation(app, buyerToken(), quotationBody(VENDOR_ID, '10.00', '10.00'), 'quote-vendor-001');
    expect(inactive.status).toBe(409);
    expect(inactive.body.error).toBe('VENDOR_INACTIVE');

    const strayLine = quotationBody(VENDOR_B_ID, '10.00', '10.00');
    strayLine.lines[0].requestLineId = '20000000-0000-4000-8000-0000000009ff';
    const stray = await createQuotation(app, buyerToken(), strayLine, 'quote-line-001');
    expect(stray.status).toBe(400);
    expect(stray.body.error).toBe('INVALID_REQUEST_LINE');
  });

  it('allows editing while draft or submitted and freezes a selected quotation', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const created = await createQuotation(app, buyerToken(), quotationBody(VENDOR_ID, '10.00', '10.00'), 'quote-edit-001');
    // A quotation update keeps its supplier: `vendorId` is not an accepted field.
    const { vendorId: _omitted, ...updateBody } = quotationBody(VENDOR_ID, '9.00', '9.00');
    const updated = await request(app)
      .patch(`/api/v2/purchasing/quotations/${created.body.id}`)
      .set(auth(buyerToken()))
      .send(updateBody);
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(2);
    expect(updated.body.totalAmount).toBe('135.00');
    expect(updated.body.lines).toHaveLength(2);

    const submitted = await request(app)
      .post(`/api/v2/purchasing/quotations/${created.body.id}/submit`)
      .set(auth(buyerToken()))
      .send({});
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('submitted');

    const selected = await request(app)
      .post(`/api/v2/purchasing/quotations/${created.body.id}/select`)
      .set(auth(buyerToken()))
      .set('Idempotency-Key', 'quote-edit-select-001')
      .send({ confirm: true, reason: 'المورد الوحيد المتاح' });
    expect(selected.status).toBe(200);
    expect(selected.body.status).toBe('selected');

    const { vendorId: _frozenOmitted, ...frozenBody } = quotationBody(VENDOR_ID, '1.00', '1.00');
    const frozen = await request(app)
      .patch(`/api/v2/purchasing/quotations/${created.body.id}`)
      .set(auth(buyerToken()))
      .send(frozenBody);
    expect(frozen.status).toBe(409);
    expect(frozen.body.error).toBe('QUOTATION_IMMUTABLE');
  });

  it('keeps only one selected quotation per request and preserves rejected history', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const first = await submittedQuotation(app, buyerToken(), VENDOR_ID, '10.00', '10.00', 'quote-win-001');
    const second = await submittedQuotation(app, buyerToken(), VENDOR_B_ID, '11.00', '11.00', 'quote-win-002');

    const selected = await request(app)
      .post(`/api/v2/purchasing/quotations/${first.id}/select`)
      .set(auth(buyerToken()))
      .set('Idempotency-Key', 'quote-win-select-001')
      .send({ confirm: true, reason: 'أقل إجمالي' });
    expect(selected.status).toBe(200);

    const blocked = await request(app)
      .post(`/api/v2/purchasing/quotations/${second.id}/select`)
      .set(auth(buyerToken()))
      .set('Idempotency-Key', 'quote-win-select-002')
      .send({ confirm: true, reason: 'محاولة ثانية' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('QUOTATION_ALREADY_SELECTED');

    const rejected = await request(app)
      .post(`/api/v2/purchasing/quotations/${second.id}/reject`)
      .set(auth(buyerToken()))
      .send({ reason: 'سعر أعلى' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');

    const list = await request(app)
      .get(`/api/v2/purchasing/requests/${REQUEST_ID}/quotations`)
      .set(auth(buyerToken()));
    expect(list.status).toBe(200);
    // The losing quotation is preserved, not deleted.
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items.map((item: any) => item.status).sort()).toEqual(['rejected', 'selected']);
  });

  it('replays an exact select retry without a second selection', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const quotation = await submittedQuotation(app, buyerToken(), VENDOR_ID, '10.00', '10.00', 'quote-retry-001');
    const body = { confirm: true, reason: 'أفضل عرض' };
    const first = await request(app)
      .post(`/api/v2/purchasing/quotations/${quotation.id}/select`)
      .set(auth(buyerToken()))
      .set('Idempotency-Key', 'quote-select-retry')
      .send(body);
    const retry = await request(app)
      .post(`/api/v2/purchasing/quotations/${quotation.id}/select`)
      .set(auth(buyerToken()))
      .set('Idempotency-Key', 'quote-select-retry')
      .send(body);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(
      prisma._purchasing.quotations.filter((row: any) => row.status === 'selected'),
    ).toHaveLength(1);
  });

  it('conflicts on a same-key award with a changed reason or a different quotation', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const winner = await submittedQuotation(app, buyerToken(), VENDOR_ID, '10.00', '10.00', 'quote-award-a');
    const other = await submittedQuotation(app, buyerToken(), VENDOR_B_ID, '11.00', '11.00', 'quote-award-b');

    const first = await request(app)
      .post(`/api/v2/purchasing/quotations/${winner.id}/select`)
      .set(auth(buyerToken()))
      .set('Idempotency-Key', 'award-key-001')
      .send({ confirm: true, reason: 'أقل إجمالي' });
    expect(first.status).toBe(200);

    // Same key, same quotation, different reason → conflict, not a false replay.
    const changedReason = await request(app)
      .post(`/api/v2/purchasing/quotations/${winner.id}/select`)
      .set(auth(buyerToken()))
      .set('Idempotency-Key', 'award-key-001')
      .send({ confirm: true, reason: 'سبب مختلف' });
    expect(changedReason.status).toBe(409);
    expect(changedReason.body.error).toBe('IDEMPOTENCY_CONFLICT');

    // Same key, different quotation → conflict.
    const differentQuotation = await request(app)
      .post(`/api/v2/purchasing/quotations/${other.id}/select`)
      .set(auth(buyerToken()))
      .set('Idempotency-Key', 'award-key-001')
      .send({ confirm: true, reason: 'أقل إجمالي' });
    expect(differentQuotation.status).toBe(409);
    expect(differentQuotation.body.error).toBe('IDEMPOTENCY_CONFLICT');

    // Exactly one selection persists and it is the first winner.
    const selected = prisma._purchasing.quotations.filter((row: any) => row.status === 'selected');
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(winner.id);
  });

  it('blocks the requester from awarding their own request', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const quotation = await submittedQuotation(app, buyerToken(), VENDOR_ID, '10.00', '10.00', 'quote-self-001');
    const selfToken = tokenFor({
      id: 'u-requester',
      employeeId: '60000000-0000-4000-8000-000000000901',
      permissions: BUYER_PERMISSIONS,
    });
    const blocked = await request(app)
      .post(`/api/v2/purchasing/quotations/${quotation.id}/select`)
      .set(auth(selfToken))
      .set('Idempotency-Key', 'quote-self-select')
      .send({ confirm: true, reason: 'أعتمد طلبي' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('SELF_SELECTION_BLOCKED');
  });

  it('requires the quotation permissions', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const weak = tokenFor({ id: 'u-buyer', employeeId: '60000000-0000-4000-8000-000000000902', permissions: ['purchasing.view'] });
    const forbidden = await createQuotation(app, weak, quotationBody(VENDOR_ID, '10.00', '10.00'), 'quote-perm-001');
    expect(forbidden.status).toBe(403);

    // quotation.compare alone must not grant capture/award authority.
    const compareOnly = tokenFor({
      id: 'u-approver',
      employeeId: '60000000-0000-4000-8000-000000000903',
      permissions: APPROVER_PERMISSIONS,
    });
    const stillForbidden = await createQuotation(app, compareOnly, quotationBody(VENDOR_ID, '10.00', '10.00'), 'quote-perm-002');
    expect(stillForbidden.status).toBe(403);
  });

  it('builds a comparison from captured facts without nominating a winner', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    await submittedQuotation(app, buyerToken(), VENDOR_ID, '10.00', '10.00', 'compare-001');
    await submittedQuotation(app, buyerToken(), VENDOR_B_ID, '12.00', '8.00', 'compare-002');

    const compare = await request(app)
      .get(`/api/v2/purchasing/requests/${REQUEST_ID}/quotations/compare`)
      .set(auth(approverToken()));
    expect(compare.status).toBe(200);
    expect(compare.body.quotations).toHaveLength(2);
    expect(compare.body.matrix).toHaveLength(2);
    expect(compare.body.matrix[0].cells).toHaveLength(2);
    expect(compare.body.matrix[0].cells[0].unitPrice).toBe('10.00');
    expect(compare.body.matrix[0].cells[1].unitPrice).toBe('12.00');
    // 10×10 + 5×10 = 150.00 ; 10×12 + 5×8 = 160.00
    expect(compare.body.totals.lowestTotalAmount).toBe('150.00');
    expect(compare.body.totals.highestTotalAmount).toBe('160.00');
    expect(compare.body.totals.spreadAmount).toBe('10.00');
    expect(compare.body.selectedQuotationId).toBeNull();
    // No scoring / recommendation fields are published.
    expect(Object.keys(compare.body.totals)).not.toContain('recommendedQuotationId');
    expect(Object.keys(compare.body)).not.toContain('bestSupplier');
    expect(compare.body.quotations[0].coverage.unquotedRequestLineIds).toEqual([]);
  });

  it('keeps quotation comparison behind its own permission', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const manageOnly = tokenFor({
      id: 'u-buyer',
      employeeId: '60000000-0000-4000-8000-000000000902',
      permissions: ['purchasing.view', 'purchasing.quotation.manage'],
    });
    const allowed = await request(app)
      .get(`/api/v2/purchasing/requests/${REQUEST_ID}/quotations/compare`)
      .set(auth(manageOnly));
    expect(allowed.status).toBe(403);
  });

  it('hides another company quotation behind an opaque 404', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const mine = await createQuotation(app, buyerToken(), quotationBody(VENDOR_ID, '10.00', '10.00'), 'idor-001');
    expect(mine.status).toBe(201);

    const crossRead = await request(app)
      .get(`/api/v2/purchasing/quotations/${mine.body.id}`)
      .set(auth(foreignToken()));
    expect(crossRead.status).toBe(404);
    expect(crossRead.body.error).toBe('SUPPLIER_QUOTATION_NOT_FOUND');

    const crossList = await request(app)
      .get(`/api/v2/purchasing/requests/${REQUEST_ID}/quotations`)
      .set(auth(foreignToken()));
    expect(crossList.status).toBe(404);

    const crossCompare = await request(app)
      .get(`/api/v2/purchasing/requests/${FOREIGN_REQUEST_ID}/quotations/compare`)
      .set(auth(buyerToken()));
    expect(crossCompare.status).toBe(404);
  });

  it('refuses quotations once the request left the sourcing window', async () => {
    const prisma = makeW2Prisma('cancelled');
    const app = w2App(prisma);
    const blocked = await createQuotation(app, buyerToken(), quotationBody(VENDOR_ID, '10.00', '10.00'), 'quote-state-001');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('QUOTATION_REQUEST_STATE_INVALID');
  });

  it('writes bounded audit metadata for create and select', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const quotation = await submittedQuotation(app, buyerToken(), VENDOR_ID, '10.00', '10.00', 'audit-001');
    await request(app)
      .post(`/api/v2/purchasing/quotations/${quotation.id}/select`)
      .set(auth(buyerToken()))
      .set('Idempotency-Key', 'audit-select-001')
      .send({ confirm: true, reason: 'سبب سري لا يجب تسجيله' });

    const actions = prisma._store.auditLogs.map((row: any) => row.action);
    expect(actions).toContain('purchasing.quotation.create');
    expect(actions).toContain('purchasing.quotation.select');
    const selectLog = prisma._store.auditLogs.find(
      (row: any) => row.action === 'purchasing.quotation.select',
    );
    const details = JSON.parse(selectLog.details);
    expect(details.quotationId).toBe(quotation.id);
    expect(details.status).toBe('selected');
    expect(details.reasonProvided).toBe(true);
    expect(JSON.stringify(details)).not.toContain('سبب سري');
  });

  it('links a selected quotation to the resulting purchase order', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const quotation = await submittedQuotation(app, buyerToken(), VENDOR_ID, '20.00', '20.00', 'link-001');
    const selected = await request(app)
      .post(`/api/v2/purchasing/quotations/${quotation.id}/select`)
      .set(auth(buyerToken()))
      .set('Idempotency-Key', 'link-select-001')
      .send({ confirm: true, reason: 'الأفضل تسليماً' });
    expect(selected.status).toBe(200);

    const order = await createIssuedOrder(app, buyerToken(), quotation.id);
    expect(order.supplierQuotationId).toBe(quotation.id);
  });

  it('refuses to link an unselected or foreign quotation to an order', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const quotation = await submittedQuotation(app, buyerToken(), VENDOR_ID, '20.00', '20.00', 'link-bad-001');

    const unselected = await request(app)
      .post('/api/purchasing/orders')
      .set(auth(buyerToken()))
      .send({
        purchaseRequestId: REQUEST_ID,
        vendorId: VENDOR_ID,
        supplierQuotationId: quotation.id,
        lines: [{ requestLineId: REQUEST_LINE_A, description: 'حاسوب محمول', quantity: '10.000', unit: 'قطعة', unitPrice: '20.00' }],
      });
    expect(unselected.status).toBe(409);
    expect(unselected.body.error).toBe('QUOTATION_NOT_SELECTED');

    const unknown = await request(app)
      .post('/api/purchasing/orders')
      .set(auth(buyerToken()))
      .send({
        purchaseRequestId: REQUEST_ID,
        vendorId: VENDOR_ID,
        supplierQuotationId: 'a0000000-0000-4000-8000-0000000009ff',
        lines: [{ requestLineId: REQUEST_LINE_A, description: 'حاسوب محمول', quantity: '10.000', unit: 'قطعة', unitPrice: '20.00' }],
      });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('SUPPLIER_QUOTATION_NOT_FOUND');
  });
});
