package com.example.domain.model

/**
 * Commercial Wave 2 — Operations Slice E1 domain models.
 *
 * Quantities and money are decimal strings from end to end. The Android app
 * never converts them to Double: all arithmetic belongs to the backend, which
 * re-derives every position inside its purchase-order row lock. `PurchasingQuantity`
 * provides the only comparison/formatting the UI needs, on integer milli-units.
 */

/** Bounded return reasons, mirroring the backend `PurchaseReturn_reason_code_check`. */
object PurchaseReturnReasons {
    const val DAMAGED = "damaged"
    const val WRONG_ITEM = "wrong_item"
    const val EXCESS_QUANTITY = "excess_quantity"
    const val QUALITY_REJECTED = "quality_rejected"
    const val EXPIRED = "expired"
    const val OTHER = "other"

    val all: List<String> = listOf(DAMAGED, WRONG_ITEM, EXCESS_QUANTITY, QUALITY_REJECTED, EXPIRED, OTHER)
}

/** Purchase order statuses, including the Wave 2 `partially_received` state. */
object PurchaseOrderStatuses {
    const val DRAFT = "draft"
    const val ISSUED = "issued"
    const val PARTIALLY_RECEIVED = "partially_received"
    const val RECEIVED = "received"
    const val CANCELLED = "cancelled"
}

data class SupplierQuotationLineParams(
    val id: String,
    val requestLineId: String?,
    val descriptionSnapshot: String,
    val categorySnapshot: String?,
    val quantity: String,
    val unitSnapshot: String,
    val unitPrice: String,
    val lineTotal: String,
    val leadTimeDays: Int?,
    val notes: String?
)

data class SupplierQuotationParams(
    val id: String,
    val companyId: String,
    val quotationNumber: String,
    val purchaseRequestId: String,
    val vendorId: String,
    val vendorNameSnapshot: String,
    val supplierReference: String?,
    val status: String,
    val version: Int,
    val currency: String,
    val subtotal: String,
    val totalAmount: String,
    val quotationDate: String?,
    val validUntilDate: String?,
    val expectedDeliveryDate: String?,
    val leadTimeDays: Int?,
    val paymentTerms: String?,
    val notes: String?,
    val lines: List<SupplierQuotationLineParams>,
    val submittedAt: String?,
    val selectedAt: String?,
    val selectedBy: PurchasingActor?,
    val rejectedAt: String?,
    val createdAt: String?,
    val updatedAt: String?
) {
    val isSelected: Boolean get() = status == "selected"
    val isEditable: Boolean get() = status == "draft" || status == "submitted"
}

data class SupplierQuotationLineInput(
    val requestLineId: String?,
    val description: String,
    val category: String? = null,
    val quantity: String,
    val unit: String,
    val unitPrice: String,
    val leadTimeDays: Int? = null,
    val notes: String? = null
)

data class SupplierQuotationDraft(
    val vendorId: String,
    val supplierReference: String? = null,
    val quotationDate: String? = null,
    val validUntilDate: String? = null,
    val expectedDeliveryDate: String? = null,
    val leadTimeDays: Int? = null,
    val paymentTerms: String? = null,
    val notes: String? = null,
    val lines: List<SupplierQuotationLineInput>,
    val currency: String = "SAR"
)

data class QuotationComparisonCell(
    val quotationId: String,
    val quotationNumber: String,
    val vendorId: String,
    val vendorNameSnapshot: String,
    val quoted: Boolean,
    val quantity: String?,
    val unit: String?,
    val unitPrice: String?,
    val lineTotal: String?,
    val leadTimeDays: Int?
)

data class QuotationComparisonRow(
    val requestLineId: String,
    val description: String,
    val requestedQuantity: String,
    val unit: String,
    val estimatedUnitPrice: String,
    val cells: List<QuotationComparisonCell>
)

/** Facts and objective aggregates only — never a recommended supplier. */
data class QuotationComparisonTotals(
    val currency: String = "SAR",
    val comparableQuotationCount: Int = 0,
    val lowestTotalAmount: String? = null,
    val highestTotalAmount: String? = null,
    val spreadAmount: String? = null
)

data class QuotationComparisonParams(
    val generatedAt: String,
    val requestId: String,
    val requestNumber: String,
    val requestTitle: String,
    val quotations: List<SupplierQuotationParams>,
    val matrix: List<QuotationComparisonRow>,
    val totals: QuotationComparisonTotals,
    val selectedQuotationId: String?
)

data class OrderLineProgressParams(
    val purchaseOrderLineId: String,
    val descriptionSnapshot: String,
    val unitSnapshot: String,
    val unitPrice: String,
    val orderedQuantity: String,
    val receivedQuantity: String,
    val returnedQuantity: String,
    val netReceivedQuantity: String,
    val remainingQuantity: String,
    val fullyReceived: Boolean
)

data class OrderReceiptProgressParams(
    val purchaseOrderId: String,
    val fullyReceived: Boolean,
    val anyReceived: Boolean,
    val lines: List<OrderLineProgressParams>
)

data class PurchaseReceiptLineParams(
    val id: String,
    val purchaseOrderLineId: String,
    val quantity: String,
    val note: String?
)

data class PurchaseReceiptParams(
    val id: String,
    val purchaseOrderId: String,
    val receiptNumber: String,
    val receiptKind: String,
    val referenceNumber: String?,
    val note: String?,
    val receivedBy: PurchasingActor?,
    val receivedAt: String?,
    val overrideApplied: Boolean,
    val lines: List<PurchaseReceiptLineParams>
)

data class PurchaseReceiptLineInput(
    val purchaseOrderLineId: String,
    val quantity: String,
    val note: String? = null
)

/** Only supplied when the quantity genuinely exceeds the remaining quantity. */
data class PurchaseReceiptOverride(
    val reason: String,
    val confirmation: String = "OVERRIDE"
)

data class PurchaseReceiptDraft(
    val lines: List<PurchaseReceiptLineInput>,
    val referenceNumber: String? = null,
    val note: String? = null,
    val override: PurchaseReceiptOverride? = null
)

data class PurchaseReceiptResult(
    val receipt: PurchaseReceiptParams,
    val progress: OrderReceiptProgressParams?
)

data class PurchaseReturnLineParams(
    val id: String,
    val purchaseOrderLineId: String,
    val quantity: String,
    val note: String?
)

data class PurchaseReturnParams(
    val id: String,
    val purchaseOrderId: String,
    val returnNumber: String,
    val status: String,
    val reasonCode: String,
    val note: String?,
    val createdBy: PurchasingActor?,
    val createdAt: String?,
    val reviewedBy: PurchasingActor?,
    val reviewedAt: String?,
    val lines: List<PurchaseReturnLineParams>
) {
    val isPendingApproval: Boolean get() = status == "pending_approval"
}

data class PurchaseReturnLineInput(
    val purchaseOrderLineId: String,
    val quantity: String,
    val note: String? = null
)

data class PurchaseReturnDraft(
    val reasonCode: String,
    val note: String? = null,
    val lines: List<PurchaseReturnLineInput>
)
