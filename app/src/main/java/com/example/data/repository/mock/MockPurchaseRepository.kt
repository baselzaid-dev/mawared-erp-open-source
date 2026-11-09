package com.example.data.repository.mock

import com.example.core.utils.AppResult
import com.example.core.utils.PurchasingQuantity
import com.example.domain.model.*
import com.example.domain.repository.PurchaseRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import java.math.BigDecimal
import java.math.RoundingMode
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

private fun mockIsoTimestamp(): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }.format(Date())

class MockPurchaseRepository : PurchaseRepository {
    private val requests = MutableStateFlow<List<PurchaseRequestParams>>(emptyList())
    private val orders = MutableStateFlow<List<PurchaseOrderParams>>(emptyList())
    private val report = MutableStateFlow<PurchasingReportParams?>(null)

    override fun observePurchaseRequests(): Flow<List<PurchaseRequestParams>> = requests
    override fun observePurchaseOrders(): Flow<List<PurchaseOrderParams>> = orders
    override fun observePurchasingReport(): Flow<PurchasingReportParams?> = report

    override fun clear() {
        requests.value = emptyList()
        orders.value = emptyList()
        report.value = null
    }

    override suspend fun refreshPurchaseRequests(filters: PurchaseRequestFilters) = AppResult.Success(Unit)
    override suspend fun refreshPurchaseOrders(filters: PurchaseOrderFilters) = AppResult.Success(Unit)

    override suspend fun loadPurchaseRequest(id: String, scope: String?) = requests.value.find { it.id == id }
        ?.let { AppResult.Success(it) } ?: AppResult.Error(Exception("Purchase request not found"))

    override suspend fun createPurchaseRequest(request: CreatePurchaseRequestParams): AppResult<PurchaseRequestParams> {
        val lines = request.lines.map { input ->
            val total = input.quantity.toBigDecimal().multiply(input.estimatedUnitPrice.toBigDecimal()).setScale(2, RoundingMode.HALF_UP).toPlainString()
            PurchaseRequestLineParams(UUID.randomUUID().toString(), input.description, input.category, input.quantity.toBigDecimal().setScale(3).toPlainString(), input.unit, input.estimatedUnitPrice.toBigDecimal().setScale(2).toPlainString(), total)
        }
        val total = lines.fold(BigDecimal.ZERO) { sum, line -> sum + line.estimatedTotal.toBigDecimal() }.setScale(2).toPlainString()
        val now = mockIsoTimestamp()
        val item = PurchaseRequestParams(
            UUID.randomUUID().toString(), "1", "PR-DEMO-${requests.value.size + 1}", "demo-employee", "موظف تجريبي", "EMP-DEMO",
            null, null, request.title, request.justification, request.neededByDate, "pending_purchasing", total, "SAR", lines,
            null, null, null, emptyList(), now, now
        )
        requests.value = listOf(item) + requests.value
        return AppResult.Success(item)
    }

    private fun updateRequest(id: String, transform: (PurchaseRequestParams) -> PurchaseRequestParams): AppResult<PurchaseRequestParams> {
        val current = requests.value.find { it.id == id } ?: return AppResult.Error(Exception("Purchase request not found"))
        val updated = transform(current)
        requests.value = requests.value.map { if (it.id == id) updated else it }
        return AppResult.Success(updated)
    }

    override suspend fun reviewDepartment(id: String, action: String, note: String?) = updateRequest(id) { it.copy(status = if (action == "approve") "pending_purchasing" else "rejected") }
    override suspend fun reviewPurchasing(id: String, action: String, note: String?) = updateRequest(id) { it.copy(status = if (action == "approve") "approved" else "rejected") }
    override suspend fun cancelPurchaseRequest(id: String, reason: String) = updateRequest(id) { it.copy(status = "cancelled") }

    override suspend fun loadPurchaseOrder(id: String, scope: String?) = orders.value.find { it.id == id }
        ?.let { AppResult.Success(it) } ?: AppResult.Error(Exception("Purchase order not found"))

    override suspend fun createPurchaseOrder(request: PurchaseOrderDraftParams): AppResult<PurchaseOrderParams> {
        val source = requests.value.find { it.id == request.purchaseRequestId }
            ?: return AppResult.Error(Exception("Purchase request not found"))
        if (source.status != "approved") return AppResult.Error(Exception("Purchase request is not approved"))
        val mappedLines = request.lines.map { input ->
            val total = input.quantity.toBigDecimal().multiply(input.unitPrice.toBigDecimal()).setScale(2, RoundingMode.HALF_UP).toPlainString()
            PurchaseOrderLineParams(input.id ?: UUID.randomUUID().toString(), input.requestLineId, input.description, input.category, input.quantity.toBigDecimal().setScale(3).toPlainString(), input.unit, input.unitPrice.toBigDecimal().setScale(2).toPlainString(), total)
        }
        val total = mappedLines.fold(BigDecimal.ZERO) { sum, line -> sum + line.lineTotal.toBigDecimal() }.setScale(2).toPlainString()
        val now = mockIsoTimestamp()
        val order = PurchaseOrderParams(
            UUID.randomUUID().toString(), "1", "PO-DEMO-${orders.value.size + 1}", source.id, source.requestNumber,
            source.title, source.requesterNameSnapshot, source.departmentNameSnapshot, request.vendorId, "مورد تجريبي",
            null, null, null, "draft", "SAR", total, total, mappedLines,
            null, null, null, null, null, now, now
        )
        orders.value = listOf(order) + orders.value
        updateRequest(source.id) { it.copy(status = "ordered") }
        return AppResult.Success(order)
    }

    override suspend fun updatePurchaseOrder(id: String, request: PurchaseOrderDraftParams): AppResult<PurchaseOrderParams> {
        val current = orders.value.find { it.id == id } ?: return AppResult.Error(Exception("Purchase order not found"))
        if (current.status != "draft") return AppResult.Error(Exception("Purchase order is immutable"))
        val mapped = request.lines.map { input ->
            val total = input.quantity.toBigDecimal().multiply(input.unitPrice.toBigDecimal()).setScale(2, RoundingMode.HALF_UP).toPlainString()
            PurchaseOrderLineParams(input.id ?: UUID.randomUUID().toString(), input.requestLineId, input.description, input.category, input.quantity, input.unit, input.unitPrice, total)
        }
        val total = mapped.fold(BigDecimal.ZERO) { sum, line -> sum + line.lineTotal.toBigDecimal() }.setScale(2).toPlainString()
        val updated = current.copy(vendorId = request.vendorId, lines = mapped, subtotal = total, totalAmount = total)
        orders.value = orders.value.map { if (it.id == id) updated else it }
        return AppResult.Success(updated)
    }
    override suspend fun issuePurchaseOrder(id: String) = updateOrder(id, "issued")
    override suspend fun receivePurchaseOrder(id: String, note: String?): AppResult<PurchaseOrderParams> {
        val result = updateOrder(id, "received", note)
        if (result is AppResult.Success) updateRequest(result.data.purchaseRequestId) { it.copy(status = "received") }
        return result
    }
    override suspend fun cancelPurchaseOrder(id: String, reason: String): AppResult<PurchaseOrderParams> {
        val result = updateOrder(id, "cancelled")
        if (result is AppResult.Success) updateRequest(result.data.purchaseRequestId) { it.copy(status = "approved") }
        return result
    }

    private fun updateOrder(id: String, status: String, note: String? = null): AppResult<PurchaseOrderParams> {
        val current = orders.value.find { it.id == id } ?: return AppResult.Error(Exception("Purchase order not found"))
        val updated = current.copy(status = status, receiptNote = note ?: current.receiptNote)
        orders.value = orders.value.map { if (it.id == id) updated else it }
        return AppResult.Success(updated)
    }

    override suspend fun refreshPurchasingReport(from: String?, to: String?): AppResult<Unit> {
        val estimated = requests.value.fold(BigDecimal.ZERO) { sum, item -> sum + item.totalEstimated.toBigDecimal() }.setScale(2).toPlainString()
        report.value = PurchasingReportParams(PurchasingReportSummary(requestCount = requests.value.size, estimatedTotal = estimated))
        return AppResult.Success(Unit)
    }

    // Sprint 12I: purchasing admin override (v2) + purchasing exports (v2) — demo/offline stubs.
    override suspend fun overridePurchaseRequest(
        id: String,
        action: String,
        reason: String,
        expectedUpdatedAt: String?,
        idempotencyKey: String
    ): AppResult<PurchaseRequestParams> {
        val current = requests.value.find { it.id == id }
            ?: return AppResult.Error(Exception("Purchase request not found"))
        if (current.requestedByEmployeeId == "demo-employee") {
            return AppResult.Error(
                PurchasingOverrideException(
                    message = "لا يمكنك تنفيذ إجراء إداري على طلب تقدّمت به بنفسك.",
                    code = "Forbidden"
                )
            )
        }
        if (expectedUpdatedAt != null && expectedUpdatedAt != current.updatedAt) {
            return AppResult.Error(
                PurchasingOverrideException(
                    message = "تغيّرت بيانات الطلب منذ فتح الشاشة. حدّث القائمة ثم أعد المحاولة.",
                    code = "VersionMismatch",
                    currentUpdatedAt = current.updatedAt
                )
            )
        }
        if (action !in purchasingOverrideLegalActionsFor(current.status)) {
            return AppResult.Error(
                PurchasingOverrideException(
                    message = "حالة الطلب الحالية لا تسمح بتنفيذ هذا الإجراء.",
                    code = "IllegalTransition",
                    currentStatus = current.status
                )
            )
        }
        val newStatus = when (action) {
            "approve" -> "approved"
            "reject" -> "rejected"
            "cancel" -> "cancelled"
            else -> current.status
        }
        val now = mockIsoTimestamp()
        val updated = current.copy(
            status = newStatus,
            rejectedAt = if (action == "reject") now else current.rejectedAt,
            updatedAt = now
        )
        requests.value = requests.value.map { if (it.id == id) updated else it }
        return AppResult.Success(updated)
    }

    override suspend fun exportPurchasingReport(
        format: PurchasingExportFormat,
        locale: String
    ): AppResult<ReportExportPayload> {
        val bytes = "mock-purchasing-export".toByteArray()
        return AppResult.Success(ReportExportPayload(bytes, "purchasing_export.${format.fileExtension}", format.mimeType))
    }

    // ---- Commercial Wave 2 (Operations Slice E1) demo state ----
    //
    // DEMO_MODE never talks to a server, so this fake enforces the same
    // invariants the backend does: no over-receipt without an override, no
    // over-return, one winning quotation per request, and idempotent retries.

    private val quotations = mutableListOf<SupplierQuotationParams>()
    private val receipts = mutableListOf<PurchaseReceiptParams>()
    private val purchaseReturns = mutableListOf<PurchaseReturnParams>()
    private val usedIdempotencyKeys = mutableMapOf<String, String>()

    private fun demoActor() = PurchasingActor("demo-user", "مستخدم تجريبي")

    private fun orderLines(orderId: String): List<PurchaseOrderLineParams> =
        orders.value.find { it.id == orderId }?.lines ?: emptyList()

    private fun progressFor(orderId: String): OrderReceiptProgressParams {
        val lines = orderLines(orderId).map { line ->
            val received = receipts
                .filter { it.purchaseOrderId == orderId }
                .flatMap { it.lines }
                .filter { it.purchaseOrderLineId == line.id }
                .fold(java.math.BigInteger.ZERO) { total, row ->
                    total.add(PurchasingQuantity.parseMilli(row.quantity) ?: java.math.BigInteger.ZERO)
                }
            val returned = purchaseReturns
                .filter { it.purchaseOrderId == orderId && it.status != "rejected" }
                .flatMap { it.lines }
                .filter { it.purchaseOrderLineId == line.id }
                .fold(java.math.BigInteger.ZERO) { total, row ->
                    total.add(PurchasingQuantity.parseMilli(row.quantity) ?: java.math.BigInteger.ZERO)
                }
            val ordered = PurchasingQuantity.parseMilli(line.quantity) ?: java.math.BigInteger.ZERO
            val net = received.subtract(returned)
            val remainingRaw = ordered.subtract(net)
            val remaining = if (remainingRaw.signum() > 0) remainingRaw else java.math.BigInteger.ZERO
            OrderLineProgressParams(
                purchaseOrderLineId = line.id,
                descriptionSnapshot = line.descriptionSnapshot,
                unitSnapshot = line.unitSnapshot,
                unitPrice = line.unitPrice,
                orderedQuantity = PurchasingQuantity.milliToString(ordered),
                receivedQuantity = PurchasingQuantity.milliToString(received),
                returnedQuantity = PurchasingQuantity.milliToString(returned),
                netReceivedQuantity = PurchasingQuantity.milliToString(net),
                remainingQuantity = PurchasingQuantity.milliToString(remaining),
                fullyReceived = net >= ordered
            )
        }
        return OrderReceiptProgressParams(
            purchaseOrderId = orderId,
            fullyReceived = lines.isNotEmpty() && lines.all { it.fullyReceived },
            anyReceived = lines.any { PurchasingQuantity.isPositive(it.receivedQuantity) },
            lines = lines
        )
    }

    override suspend fun listQuotations(requestId: String, status: String?): AppResult<List<SupplierQuotationParams>> =
        AppResult.Success(
            quotations.filter { it.purchaseRequestId == requestId && (status == null || it.status == status) }
        )

    override suspend fun compareQuotations(requestId: String): AppResult<QuotationComparisonParams> {
        val request = requests.value.find { it.id == requestId }
            ?: return AppResult.Error(Exception("Purchase request not found"))
        val rows = quotations.filter { it.purchaseRequestId == requestId }
        val comparable = rows.filter { it.status != "rejected" }.mapNotNull { it.totalAmount.toBigDecimalOrNull() }
        return AppResult.Success(
            QuotationComparisonParams(
                generatedAt = mockIsoTimestamp(),
                requestId = request.id,
                requestNumber = request.requestNumber,
                requestTitle = request.title,
                quotations = rows,
                matrix = request.lines.map { line ->
                    QuotationComparisonRow(
                        requestLineId = line.id,
                        description = line.description,
                        requestedQuantity = line.quantity,
                        unit = line.unit,
                        estimatedUnitPrice = line.estimatedUnitPrice,
                        cells = rows.map { quotation ->
                            val match = quotation.lines.find { it.requestLineId == line.id }
                            QuotationComparisonCell(
                                quotationId = quotation.id,
                                quotationNumber = quotation.quotationNumber,
                                vendorId = quotation.vendorId,
                                vendorNameSnapshot = quotation.vendorNameSnapshot,
                                quoted = match != null,
                                quantity = match?.quantity,
                                unit = match?.unitSnapshot,
                                unitPrice = match?.unitPrice,
                                lineTotal = match?.lineTotal,
                                leadTimeDays = match?.leadTimeDays ?: quotation.leadTimeDays
                            )
                        }
                    )
                },
                totals = QuotationComparisonTotals(
                    comparableQuotationCount = comparable.size,
                    lowestTotalAmount = comparable.minOrNull()?.setScale(2)?.toPlainString(),
                    highestTotalAmount = comparable.maxOrNull()?.setScale(2)?.toPlainString(),
                    spreadAmount = if (comparable.isEmpty()) null else
                        comparable.max().subtract(comparable.min()).setScale(2).toPlainString()
                ),
                selectedQuotationId = rows.find { it.isSelected }?.id
            )
        )
    }

    override suspend fun createQuotation(
        requestId: String,
        draft: SupplierQuotationDraft,
        idempotencyKey: String
    ): AppResult<SupplierQuotationParams> {
        usedIdempotencyKeys[idempotencyKey]?.let { existing ->
            return quotations.find { it.id == existing }
                ?.let { AppResult.Success(it) } ?: AppResult.Error(Exception("Quotation not found"))
        }
        var total = BigDecimal.ZERO
        val lines = draft.lines.map { input ->
            val quantity = PurchasingQuantity.normalize(input.quantity)
                ?: return AppResult.Error(Exception("Invalid quantity"))
            val price = input.unitPrice.toBigDecimalOrNull()?.setScale(2, RoundingMode.HALF_UP)
                ?: return AppResult.Error(Exception("Invalid amount"))
            val lineTotal = quantity.toBigDecimal().multiply(price).setScale(2, RoundingMode.HALF_UP)
            total = total.add(lineTotal)
            SupplierQuotationLineParams(
                id = UUID.randomUUID().toString(),
                requestLineId = input.requestLineId,
                descriptionSnapshot = input.description,
                categorySnapshot = input.category,
                quantity = quantity,
                unitSnapshot = input.unit,
                unitPrice = price.toPlainString(),
                lineTotal = lineTotal.toPlainString(),
                leadTimeDays = input.leadTimeDays,
                notes = input.notes
            )
        }
        val now = mockIsoTimestamp()
        val quotation = SupplierQuotationParams(
            id = UUID.randomUUID().toString(),
            companyId = "1",
            quotationNumber = "SQ-DEMO-${quotations.size + 1}",
            purchaseRequestId = requestId,
            vendorId = draft.vendorId,
            vendorNameSnapshot = "مورد تجريبي",
            supplierReference = draft.supplierReference,
            status = "draft",
            version = 1,
            currency = draft.currency,
            subtotal = total.setScale(2).toPlainString(),
            totalAmount = total.setScale(2).toPlainString(),
            quotationDate = draft.quotationDate,
            validUntilDate = draft.validUntilDate,
            expectedDeliveryDate = draft.expectedDeliveryDate,
            leadTimeDays = draft.leadTimeDays,
            paymentTerms = draft.paymentTerms,
            notes = draft.notes,
            lines = lines,
            submittedAt = null,
            selectedAt = null,
            selectedBy = null,
            rejectedAt = null,
            createdAt = now,
            updatedAt = now
        )
        quotations += quotation
        usedIdempotencyKeys[idempotencyKey] = quotation.id
        return AppResult.Success(quotation)
    }

    private fun replaceQuotation(updated: SupplierQuotationParams): AppResult<SupplierQuotationParams> {
        val index = quotations.indexOfFirst { it.id == updated.id }
        if (index < 0) return AppResult.Error(Exception("Quotation not found"))
        quotations[index] = updated
        return AppResult.Success(updated)
    }

    override suspend fun submitQuotation(quotationId: String): AppResult<SupplierQuotationParams> {
        val current = quotations.find { it.id == quotationId }
            ?: return AppResult.Error(Exception("Quotation not found"))
        if (current.status == "submitted") return AppResult.Success(current)
        if (current.status != "draft") return AppResult.Error(Exception("Quotation is not editable"))
        return replaceQuotation(current.copy(status = "submitted", submittedAt = mockIsoTimestamp(), updatedAt = mockIsoTimestamp()))
    }

    override suspend fun rejectQuotation(quotationId: String, reason: String): AppResult<SupplierQuotationParams> {
        val current = quotations.find { it.id == quotationId }
            ?: return AppResult.Error(Exception("Quotation not found"))
        if (!current.isEditable) return AppResult.Error(Exception("Quotation is not editable"))
        return replaceQuotation(current.copy(status = "rejected", rejectedAt = mockIsoTimestamp(), updatedAt = mockIsoTimestamp()))
    }

    override suspend fun selectQuotation(
        quotationId: String,
        reason: String,
        idempotencyKey: String
    ): AppResult<SupplierQuotationParams> {
        usedIdempotencyKeys[idempotencyKey]?.let { existing ->
            return quotations.find { it.id == existing }
                ?.let { AppResult.Success(it) } ?: AppResult.Error(Exception("Quotation not found"))
        }
        val current = quotations.find { it.id == quotationId }
            ?: return AppResult.Error(Exception("Quotation not found"))
        if (current.status != "submitted") return AppResult.Error(Exception("Quotation is not submitted"))
        if (quotations.any { it.purchaseRequestId == current.purchaseRequestId && it.isSelected }) {
            return AppResult.Error(Exception("A quotation is already selected for this request"))
        }
        val now = mockIsoTimestamp()
        val result = replaceQuotation(
            current.copy(status = "selected", selectedAt = now, selectedBy = demoActor(), updatedAt = now)
        )
        if (result is AppResult.Success) usedIdempotencyKeys[idempotencyKey] = quotationId
        return result
    }

    override suspend fun loadReceipts(
        orderId: String
    ): AppResult<Pair<List<PurchaseReceiptParams>, OrderReceiptProgressParams?>> =
        AppResult.Success(receipts.filter { it.purchaseOrderId == orderId } to progressFor(orderId))

    override suspend fun recordReceipt(
        orderId: String,
        draft: PurchaseReceiptDraft,
        idempotencyKey: String
    ): AppResult<PurchaseReceiptResult> {
        usedIdempotencyKeys[idempotencyKey]?.let { existing ->
            val prior = receipts.find { it.id == existing }
                ?: return AppResult.Error(Exception("Receipt not found"))
            return AppResult.Success(PurchaseReceiptResult(prior, progressFor(orderId)))
        }
        val progress = progressFor(orderId)
        for (line in draft.lines) {
            val position = progress.lines.find { it.purchaseOrderLineId == line.purchaseOrderLineId }
                ?: return AppResult.Error(Exception("Line does not belong to this order"))
            if (!PurchasingQuantity.isPositive(line.quantity)) {
                return AppResult.Error(Exception("Invalid quantity"))
            }
            if (PurchasingQuantity.exceeds(line.quantity, position.remainingQuantity) && draft.override == null) {
                return AppResult.Error(Exception("Receipt exceeds the remaining quantity"))
            }
        }
        val receipt = PurchaseReceiptParams(
            id = UUID.randomUUID().toString(),
            purchaseOrderId = orderId,
            receiptNumber = "GRN-DEMO-${receipts.size + 1}",
            receiptKind = "partial",
            referenceNumber = draft.referenceNumber,
            note = draft.note,
            receivedBy = demoActor(),
            receivedAt = mockIsoTimestamp(),
            overrideApplied = draft.override != null,
            lines = draft.lines.map {
                PurchaseReceiptLineParams(
                    UUID.randomUUID().toString(),
                    it.purchaseOrderLineId,
                    PurchasingQuantity.normalize(it.quantity) ?: it.quantity,
                    it.note
                )
            }
        )
        receipts += receipt
        usedIdempotencyKeys[idempotencyKey] = receipt.id
        val after = progressFor(orderId)
        orders.value = orders.value.map {
            if (it.id == orderId) {
                it.copy(status = if (after.fullyReceived) PurchaseOrderStatuses.RECEIVED else PurchaseOrderStatuses.PARTIALLY_RECEIVED)
            } else it
        }
        return AppResult.Success(PurchaseReceiptResult(receipt, after))
    }

    override suspend fun listReturns(orderId: String): AppResult<List<PurchaseReturnParams>> =
        AppResult.Success(purchaseReturns.filter { it.purchaseOrderId == orderId })

    override suspend fun createReturn(
        orderId: String,
        draft: PurchaseReturnDraft,
        idempotencyKey: String
    ): AppResult<PurchaseReturnParams> {
        usedIdempotencyKeys[idempotencyKey]?.let { existing ->
            return purchaseReturns.find { it.id == existing }
                ?.let { AppResult.Success(it) } ?: AppResult.Error(Exception("Return not found"))
        }
        if (draft.reasonCode !in PurchaseReturnReasons.all) {
            return AppResult.Error(Exception("Invalid return reason"))
        }
        val progress = progressFor(orderId)
        for (line in draft.lines) {
            val position = progress.lines.find { it.purchaseOrderLineId == line.purchaseOrderLineId }
                ?: return AppResult.Error(Exception("Line does not belong to this order"))
            if (!PurchasingQuantity.isPositive(line.quantity)) {
                return AppResult.Error(Exception("Invalid quantity"))
            }
            if (!PurchasingQuantity.isPositive(position.receivedQuantity)) {
                return AppResult.Error(Exception("Nothing was received for this line"))
            }
            if (PurchasingQuantity.exceeds(line.quantity, position.netReceivedQuantity)) {
                return AppResult.Error(Exception("Return exceeds the received quantity"))
            }
        }
        val row = PurchaseReturnParams(
            id = UUID.randomUUID().toString(),
            purchaseOrderId = orderId,
            returnNumber = "PRT-DEMO-${purchaseReturns.size + 1}",
            status = "pending_approval",
            reasonCode = draft.reasonCode,
            note = draft.note,
            createdBy = demoActor(),
            createdAt = mockIsoTimestamp(),
            reviewedBy = null,
            reviewedAt = null,
            lines = draft.lines.map {
                PurchaseReturnLineParams(
                    UUID.randomUUID().toString(),
                    it.purchaseOrderLineId,
                    PurchasingQuantity.normalize(it.quantity) ?: it.quantity,
                    it.note
                )
            }
        )
        purchaseReturns += row
        usedIdempotencyKeys[idempotencyKey] = row.id
        return AppResult.Success(row)
    }

    override suspend fun reviewReturn(
        returnId: String,
        action: String,
        note: String?,
        idempotencyKey: String
    ): AppResult<PurchaseReturnParams> {
        usedIdempotencyKeys[idempotencyKey]?.let { existing ->
            return purchaseReturns.find { it.id == existing }
                ?.let { AppResult.Success(it) } ?: AppResult.Error(Exception("Return not found"))
        }
        val index = purchaseReturns.indexOfFirst { it.id == returnId }
        if (index < 0) return AppResult.Error(Exception("Return not found"))
        val current = purchaseReturns[index]
        if (!current.isPendingApproval) return AppResult.Error(Exception("Return was already reviewed"))
        val updated = current.copy(
            status = if (action == "approve") "approved" else "rejected",
            reviewedBy = demoActor(),
            reviewedAt = mockIsoTimestamp()
        )
        purchaseReturns[index] = updated
        usedIdempotencyKeys[idempotencyKey] = returnId
        return AppResult.Success(updated)
    }
}
