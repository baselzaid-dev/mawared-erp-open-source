import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionMemory } from '@/auth/sessionMemory';
import { purchasingApi } from './api';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A Response body can only be read once, so every call needs a fresh one. */
const jsonEachCall = (body: unknown, status = 200) =>
  vi.fn(async () => json(body, status));

const authenticate = () =>
  sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture

describe('company web purchasing API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionMemory.clear();
  });

  it('reads requests and orders through the existing company-scoped contracts', async () => {
    authenticate();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ items: [{ id: 'pr-1' }], total: 1 }))
      .mockResolvedValueOnce(json({ items: [{ id: 'po-1' }], total: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await purchasingApi.listRequests({ pageSize: 50 });
    await purchasingApi.listOrders({ status: 'issued' });

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/purchasing/requests?pageSize=50');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/purchasing/orders?status=issued');
    // No companyId is ever sent: the server takes it from the session.
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('companyId');
    expect(fetchMock.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer access-token');
  });

  it('sends an Idempotency-Key for every quantity or award mutation', async () => {
    authenticate();
    const fetchMock = jsonEachCall({ id: 'x' }, 201);
    vi.stubGlobal('fetch', fetchMock);

    await purchasingApi.createQuotation('pr-1', {
      vendorId: 'v-1',
      lines: [{ requestLineId: 'l-1', description: 'x', quantity: '1.000', unit: 'pc', unitPrice: '10.00' }],
    }, 'quotation-create-key-001');
    await purchasingApi.selectQuotation('sq-1', 'best value', 'quotation-select-key-001');
    await purchasingApi.recordReceipt('po-1', {
      lines: [{ purchaseOrderLineId: 'ol-1', quantity: '2.000' }],
    }, 'receipt-key-001');
    await purchasingApi.createReturn('po-1', {
      reasonCode: 'damaged',
      lines: [{ purchaseOrderLineId: 'ol-1', quantity: '1.000' }],
    }, 'return-key-001');
    await purchasingApi.reviewReturn('rt-1', 'approve', null, 'return-review-key-001');

    const keys = fetchMock.mock.calls.map((call) => call[1].headers.get('Idempotency-Key'));
    expect(keys).toEqual([
      'quotation-create-key-001',
      'quotation-select-key-001',
      'receipt-key-001',
      'return-key-001',
      'return-review-key-001',
    ]);
  });

  it('generates a distinct idempotency key per action when none is supplied', async () => {
    authenticate();
    const fetchMock = jsonEachCall({ id: 'x' }, 201);
    vi.stubGlobal('fetch', fetchMock);

    const body = { lines: [{ purchaseOrderLineId: 'ol-1', quantity: '1.000' }] };
    await purchasingApi.recordReceipt('po-1', body);
    await purchasingApi.recordReceipt('po-1', body);

    const [first, second] = fetchMock.mock.calls.map((call) => call[1].headers.get('Idempotency-Key'));
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    // Two deliberate receipts must not silently collapse into one retry.
    expect(first).not.toBe(second);
    expect(first).toMatch(/^receipt-/);
  });

  it('sends the award confirmation and reason the backend requires', async () => {
    authenticate();
    const fetchMock = vi.fn().mockResolvedValue(json({ id: 'sq-1', status: 'selected' }));
    vi.stubGlobal('fetch', fetchMock);

    await purchasingApi.selectQuotation('sq-1', 'lowest total', 'quotation-select-key-002');

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      confirm: true,
      reason: 'lowest total',
    });
  });

  it('passes an over-receipt override through untouched', async () => {
    authenticate();
    const fetchMock = vi.fn().mockResolvedValue(json({ receipt: {}, progress: null }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await purchasingApi.recordReceipt('po-1', {
      lines: [{ purchaseOrderLineId: 'ol-1', quantity: '11.000' }],
      override: { confirmation: 'OVERRIDE', reason: 'supplier over-delivered' },
    }, 'receipt-override-key-001');

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).override).toEqual({
      confirmation: 'OVERRIDE',
      reason: 'supplier over-delivered',
    });
  });

  it('surfaces conflict and forbidden responses instead of inventing success', async () => {
    authenticate();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: 'RECEIPT_EXCEEDS_REMAINING' }, 409))
      .mockResolvedValueOnce(json({ error: 'SELF_SELECTION_BLOCKED' }, 403))
      .mockResolvedValueOnce(json({ error: 'PURCHASE_ORDER_NOT_FOUND' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      purchasingApi.recordReceipt('po-1', { lines: [{ purchaseOrderLineId: 'ol-1', quantity: '99.000' }] }, 'k-1-receipt'),
    ).rejects.toMatchObject({ status: 409, code: 'RECEIPT_EXCEEDS_REMAINING' });

    await expect(purchasingApi.selectQuotation('sq-1', 'mine', 'k-2-select')).rejects.toMatchObject({
      status: 403,
      code: 'SELF_SELECTION_BLOCKED',
    });

    await expect(purchasingApi.listReceipts('po-other')).rejects.toMatchObject({
      status: 404,
      code: 'PURCHASE_ORDER_NOT_FOUND',
    });
  });

  it('keeps the legacy whole-order receive contract unchanged', async () => {
    authenticate();
    const fetchMock = vi.fn().mockResolvedValue(json({ id: 'po-1', status: 'received' }));
    vi.stubGlobal('fetch', fetchMock);

    await purchasingApi.receiveWholeOrder('po-1', 'closed out');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/purchasing/orders/po-1/receive');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ receiptNote: 'closed out' });
    // The legacy endpoint has no client idempotency key.
    expect(fetchMock.mock.calls[0][1].headers.get('Idempotency-Key')).toBeNull();
  });

  it('requests the comparison as a non-mutating read', async () => {
    authenticate();
    const fetchMock = vi.fn().mockResolvedValue(json({ matrix: [], quotations: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await purchasingApi.compareQuotations('pr-1');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v2/purchasing/requests/pr-1/quotations/compare');
    expect(fetchMock.mock.calls[0][1].method ?? 'GET').toBe('GET');
  });
});
