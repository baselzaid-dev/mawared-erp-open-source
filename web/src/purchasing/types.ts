/** Company Web types for the Commercial Wave 2 purchasing contract. */

export type PurchaseRequestStatus =
  | 'pending_department'
  | 'pending_purchasing'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'ordered'
  | 'received';

export type PurchaseOrderStatus =
  | 'draft'
  | 'issued'
  | 'partially_received'
  | 'received'
  | 'cancelled';

export type QuotationStatus = 'draft' | 'submitted' | 'selected' | 'rejected';

export type ReturnStatus = 'pending_approval' | 'approved' | 'rejected';

export const RETURN_REASON_CODES = [
  'damaged',
  'wrong_item',
  'excess_quantity',
  'quality_rejected',
  'expired',
  'other',
] as const;

export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];

export type PurchasingActor = { id: string; name: string } | null;

export interface PurchaseRequestLineRecord {
  id: string;
  description: string;
  category: string | null;
  quantity: string;
  unit: string;
  estimatedUnitPrice: string;
  estimatedTotal: string;
}

export interface PurchaseRequestRecord {
  id: string;
  requestNumber: string;
  requesterNameSnapshot: string;
  departmentNameSnapshot: string | null;
  title: string;
  neededByDate: string | null;
  status: PurchaseRequestStatus;
  totalEstimated: string;
  currency: string;
  lines: PurchaseRequestLineRecord[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PurchaseOrderLineRecord {
  id: string;
  requestLineId: string | null;
  descriptionSnapshot: string;
  categorySnapshot: string | null;
  quantity: string;
  unitSnapshot: string;
  unitPrice: string;
  lineTotal: string;
}

export interface PurchaseOrderRecord {
  id: string;
  orderNumber: string;
  purchaseRequestId: string;
  supplierQuotationId: string | null;
  vendorId: string;
  vendorNameSnapshot: string;
  status: PurchaseOrderStatus;
  currency: string;
  subtotal: string;
  totalAmount: string;
  lines: PurchaseOrderLineRecord[];
  request: {
    id: string;
    requestNumber: string;
    title: string;
    requesterNameSnapshot: string;
    departmentNameSnapshot: string | null;
    status: PurchaseRequestStatus;
  } | null;
  issuedAt: string | null;
  receivedAt: string | null;
  receiptNote: string | null;
  cancelledAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface QuotationLineRecord {
  id: string;
  requestLineId: string | null;
  descriptionSnapshot: string;
  categorySnapshot: string | null;
  quantity: string;
  unitSnapshot: string;
  unitPrice: string;
  lineTotal: string;
  leadTimeDays: number | null;
  notes: string | null;
}

export interface QuotationRecord {
  id: string;
  quotationNumber: string;
  purchaseRequestId: string;
  vendorId: string;
  vendorNameSnapshot: string;
  supplierReference: string | null;
  status: QuotationStatus;
  version: number;
  currency: string;
  subtotal: string;
  totalAmount: string;
  quotationDate: string | null;
  validUntilDate: string | null;
  expectedDeliveryDate: string | null;
  leadTimeDays: number | null;
  paymentTerms: string | null;
  notes: string | null;
  lines: QuotationLineRecord[];
  createdBy: PurchasingActor;
  submittedAt: string | null;
  selection: { actor: PurchasingActor; selectedAt: string | null; reason: string | null } | null;
  rejection: { actor: PurchasingActor; rejectedAt: string | null; reason: string | null } | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface QuotationComparisonCell {
  quotationId: string;
  quotationNumber: string;
  vendorId: string;
  vendorNameSnapshot: string;
  quoted: boolean;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  lineTotal: string | null;
  leadTimeDays: number | null;
  notes: string | null;
}

export interface QuotationComparison {
  generatedAt: string;
  request: {
    id: string;
    requestNumber: string;
    title: string;
    status: PurchaseRequestStatus;
    currency: string;
    totalEstimated: string;
  };
  requestLines: Array<{
    id: string;
    description: string;
    category: string | null;
    quantity: string;
    unit: string;
    estimatedUnitPrice: string;
    estimatedTotal: string;
  }>;
  quotations: Array<
    QuotationRecord & {
      isSelected: boolean;
      validityExpired: boolean | null;
      coverage: {
        requestLineCount: number;
        quotedRequestLineCount: number;
        unquotedRequestLineIds: string[];
      };
    }
  >;
  matrix: Array<{
    requestLineId: string;
    description: string;
    requestedQuantity: string;
    unit: string;
    estimatedUnitPrice: string;
    cells: QuotationComparisonCell[];
  }>;
  /** Objective aggregates only — the backend never nominates a winner. */
  totals: {
    currency: string;
    comparableQuotationCount: number;
    lowestTotalAmount: string | null;
    highestTotalAmount: string | null;
    spreadAmount: string | null;
  };
  selectedQuotationId: string | null;
}

export interface OrderLineProgress {
  purchaseOrderLineId: string;
  descriptionSnapshot: string;
  unitSnapshot: string;
  unitPrice: string;
  orderedQuantity: string;
  receivedQuantity: string;
  returnedQuantity: string;
  netReceivedQuantity: string;
  remainingQuantity: string;
  fullyReceived: boolean;
}

export interface OrderReceiptProgress {
  purchaseOrderId: string;
  fullyReceived: boolean;
  anyReceived: boolean;
  lines: OrderLineProgress[];
}

export interface ReceiptRecord {
  id: string;
  purchaseOrderId: string;
  receiptNumber: string;
  receiptKind: 'partial' | 'full';
  referenceNumber: string | null;
  note: string | null;
  receivedBy: PurchasingActor;
  receivedAt: string | null;
  overrideApplied: boolean;
  overrideReason: string | null;
  lines: Array<{ id: string; purchaseOrderLineId: string; quantity: string; note: string | null }>;
  createdAt: string | null;
}

export interface PurchaseReturnRecord {
  id: string;
  purchaseOrderId: string;
  returnNumber: string;
  status: ReturnStatus;
  reasonCode: ReturnReasonCode;
  note: string | null;
  createdBy: PurchasingActor;
  createdAt: string | null;
  review: { actor: PurchasingActor; reviewedAt: string | null; note: string | null } | null;
  lines: Array<{ id: string; purchaseOrderLineId: string; quantity: string; note: string | null }>;
  updatedAt: string | null;
}

export interface VendorRecord {
  id: string;
  name: string;
  contact: string | null;
  email: string | null;
  taxNumber: string | null;
  category: string | null;
  status: string;
  deactivatedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface QuotationLineInput {
  requestLineId: string | null;
  description: string;
  category?: string | null;
  quantity: string;
  unit: string;
  unitPrice: string;
  leadTimeDays?: number | null;
  notes?: string | null;
}

export interface QuotationInput {
  vendorId: string;
  supplierReference?: string | null;
  currency?: 'SAR';
  quotationDate?: string | null;
  validUntilDate?: string | null;
  expectedDeliveryDate?: string | null;
  leadTimeDays?: number | null;
  paymentTerms?: string | null;
  notes?: string | null;
  lines: QuotationLineInput[];
}

export interface ReceiptInput {
  lines: Array<{ purchaseOrderLineId: string; quantity: string; note?: string | null }>;
  referenceNumber?: string | null;
  note?: string | null;
  override?: { confirmation: 'OVERRIDE'; reason: string };
}

export interface ReturnInput {
  reasonCode: ReturnReasonCode;
  note?: string | null;
  lines: Array<{ purchaseOrderLineId: string; quantity: string; note?: string | null }>;
}
