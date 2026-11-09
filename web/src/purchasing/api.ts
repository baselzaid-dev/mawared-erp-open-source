import { authenticatedRequest } from '@/api/client';
import { createIdempotencyKey } from '@/payroll/money';
import type {
  OrderReceiptProgress,
  PurchaseOrderRecord,
  PurchaseRequestRecord,
  PurchaseReturnRecord,
  QuotationComparison,
  QuotationInput,
  QuotationRecord,
  ReceiptInput,
  ReceiptRecord,
  ReturnInput,
  VendorRecord,
} from './types';

type Paged<T> = { items: T[]; page?: number; pageSize?: number; total: number };

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
};

const id = (value: string) => encodeURIComponent(value);

export const purchasingApi = {
  // ---- existing Wave 1 contracts (reused, never duplicated) ----
  listRequests(params: { status?: string; page?: number; pageSize?: number } = {}): Promise<Paged<PurchaseRequestRecord>> {
    return authenticatedRequest(`/api/purchasing/requests${query(params)}`);
  },

  getRequest(requestId: string): Promise<PurchaseRequestRecord> {
    return authenticatedRequest(`/api/purchasing/requests/${id(requestId)}`);
  },

  listOrders(params: { status?: string; requestId?: string; vendorId?: string; page?: number; pageSize?: number } = {}): Promise<Paged<PurchaseOrderRecord>> {
    return authenticatedRequest(`/api/purchasing/orders${query(params)}`);
  },

  getOrder(orderId: string): Promise<PurchaseOrderRecord> {
    return authenticatedRequest(`/api/purchasing/orders/${id(orderId)}`);
  },

  listVendors(params: { status?: string; search?: string; page?: number; pageSize?: number } = {}): Promise<Paged<VendorRecord>> {
    return authenticatedRequest(`/api/vendors${query(params)}`);
  },

  setVendorStatus(vendorId: string, status: 'active' | 'inactive', reason?: string): Promise<VendorRecord> {
    return authenticatedRequest(`/api/vendors/${id(vendorId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, ...(reason ? { reason } : {}) }),
    });
  },

  /** Legacy whole-order receive; still the fastest way to close out an order. */
  receiveWholeOrder(orderId: string, receiptNote?: string | null): Promise<PurchaseOrderRecord> {
    return authenticatedRequest(`/api/purchasing/orders/${id(orderId)}/receive`, {
      method: 'POST',
      body: JSON.stringify({ receiptNote: receiptNote ?? null }),
    });
  },

  // ---- Wave 2 quotations ----
  listQuotations(requestId: string, status?: string): Promise<Paged<QuotationRecord>> {
    return authenticatedRequest(
      `/api/v2/purchasing/requests/${id(requestId)}/quotations${query({ status })}`,
    );
  },

  compareQuotations(requestId: string): Promise<QuotationComparison> {
    return authenticatedRequest(
      `/api/v2/purchasing/requests/${id(requestId)}/quotations/compare`,
    );
  },

  createQuotation(
    requestId: string,
    input: QuotationInput,
    idempotencyKey = createIdempotencyKey('quotation-create'),
  ): Promise<QuotationRecord> {
    return authenticatedRequest(`/api/v2/purchasing/requests/${id(requestId)}/quotations`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ currency: 'SAR', ...input }),
    });
  },

  getQuotation(quotationId: string): Promise<QuotationRecord> {
    return authenticatedRequest(`/api/v2/purchasing/quotations/${id(quotationId)}`);
  },

  updateQuotation(quotationId: string, input: Omit<QuotationInput, 'vendorId'>): Promise<QuotationRecord> {
    return authenticatedRequest(`/api/v2/purchasing/quotations/${id(quotationId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ currency: 'SAR', ...input }),
    });
  },

  submitQuotation(quotationId: string): Promise<QuotationRecord> {
    return authenticatedRequest(`/api/v2/purchasing/quotations/${id(quotationId)}/submit`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  rejectQuotation(quotationId: string, reason: string): Promise<QuotationRecord> {
    return authenticatedRequest(`/api/v2/purchasing/quotations/${id(quotationId)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  /** Awarding requires an explicit confirmation, a reason and an idempotency key. */
  selectQuotation(
    quotationId: string,
    reason: string,
    idempotencyKey = createIdempotencyKey('quotation-select'),
  ): Promise<QuotationRecord> {
    return authenticatedRequest(`/api/v2/purchasing/quotations/${id(quotationId)}/select`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ confirm: true, reason }),
    });
  },

  // ---- Wave 2 receipts ----
  listReceipts(orderId: string): Promise<{ items: ReceiptRecord[]; total: number; progress: OrderReceiptProgress }> {
    return authenticatedRequest(`/api/v2/purchasing/orders/${id(orderId)}/receipts`);
  },

  recordReceipt(
    orderId: string,
    input: ReceiptInput,
    idempotencyKey = createIdempotencyKey('receipt'),
  ): Promise<{ receipt: ReceiptRecord; progress: OrderReceiptProgress | null }> {
    return authenticatedRequest(`/api/v2/purchasing/orders/${id(orderId)}/receipts`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
  },

  // ---- Wave 2 returns ----
  listReturns(orderId: string): Promise<Paged<PurchaseReturnRecord>> {
    return authenticatedRequest(`/api/v2/purchasing/orders/${id(orderId)}/returns`);
  },

  createReturn(
    orderId: string,
    input: ReturnInput,
    idempotencyKey = createIdempotencyKey('return-create'),
  ): Promise<PurchaseReturnRecord> {
    return authenticatedRequest(`/api/v2/purchasing/orders/${id(orderId)}/returns`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
  },

  reviewReturn(
    returnId: string,
    action: 'approve' | 'reject',
    note?: string | null,
    idempotencyKey = createIdempotencyKey('return-review'),
  ): Promise<PurchaseReturnRecord> {
    return authenticatedRequest(`/api/v2/purchasing/returns/${id(returnId)}/review`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ action, note: note ?? null }),
    });
  },
};
