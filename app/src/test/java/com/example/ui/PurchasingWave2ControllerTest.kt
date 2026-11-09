package com.example.ui

import com.example.core.utils.AppResult
import com.example.domain.model.*
import com.example.domain.repository.PurchaseRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun progress(
    ordered: String = "10.000",
    received: String = "4.000",
    returned: String = "0.000",
    net: String = "4.000",
    remaining: String = "6.000"
) = OrderReceiptProgressParams(
    purchaseOrderId = "order-1",
    fullyReceived = false,
    anyReceived = true,
    lines = listOf(
        OrderLineProgressParams(
            purchaseOrderLineId = "line-1",
            descriptionSnapshot = "جهاز",
            unitSnapshot = "قطعة",
            unitPrice = "10.00",
            orderedQuantity = ordered,
            receivedQuantity = received,
            returnedQuantity = returned,
            netReceivedQuantity = net,
            remainingQuantity = remaining,
            fullyReceived = false
        )
    )
)

private fun quotation(status: String = "submitted") = SupplierQuotationParams(
    id = "quotation-1", companyId = "c1", quotationNumber = "SQ-1", purchaseRequestId = "request-1",
    vendorId = "vendor-1", vendorNameSnapshot = "مورد", supplierReference = null, status = status,
    version = 1, currency = "SAR", subtotal = "100.00", totalAmount = "100.00", quotationDate = null,
    validUntilDate = null, expectedDeliveryDate = null, leadTimeDays = null, paymentTerms = null,
    notes = null, lines = emptyList(), submittedAt = null, selectedAt = null, selectedBy = null,
    rejectedAt = null, createdAt = null, updatedAt = null
)

private fun purchaseReturn(status: String = "pending_approval") = PurchaseReturnParams(
    id = "return-1", purchaseOrderId = "order-1", returnNumber = "PRT-1", status = status,
    reasonCode = PurchaseReturnReasons.DAMAGED, note = null, createdBy = null, createdAt = null,
    reviewedBy = null, reviewedAt = null, lines = emptyList()
)

/** Fake [PurchaseRepository] — only the Wave 2 members are exercised here. */
private class FakeWave2Repository : PurchaseRepository {
    var receiptKeys = mutableListOf<String>()
    var returnKeys = mutableListOf<String>()
    var selectKeys = mutableListOf<String>()
    var lastReceiptDraft: PurchaseReceiptDraft? = null
    var lastReturnDraft: PurchaseReturnDraft? = null
    var receiptResult: AppResult<PurchaseReceiptResult> = AppResult.Success(
        PurchaseReceiptResult(
            PurchaseReceiptParams(
                "receipt-1", "order-1", "GRN-1", "partial", null, null, null, null, false, emptyList()
            ),
            progress(received = "8.000", net = "8.000", remaining = "2.000")
        )
    )
    var progressResult: OrderReceiptProgressParams? = progress()

    override fun observePurchaseRequests(): Flow<List<PurchaseRequestParams>> = MutableStateFlow(emptyList())
    override fun observePurchaseOrders(): Flow<List<PurchaseOrderParams>> = MutableStateFlow(emptyList())
    override fun observePurchasingReport(): Flow<PurchasingReportParams?> = MutableStateFlow(null)
    override suspend fun refreshPurchaseRequests(filters: PurchaseRequestFilters) = error("unused")
    override suspend fun loadPurchaseRequest(id: String, scope: String?) = error("unused")
    override suspend fun createPurchaseRequest(request: CreatePurchaseRequestParams) = error("unused")
    override suspend fun reviewDepartment(id: String, action: String, note: String?) = error("unused")
    override suspend fun reviewPurchasing(id: String, action: String, note: String?) = error("unused")
    override suspend fun cancelPurchaseRequest(id: String, reason: String) = error("unused")
    override suspend fun refreshPurchaseOrders(filters: PurchaseOrderFilters) = error("unused")
    override suspend fun loadPurchaseOrder(id: String, scope: String?) = error("unused")
    override suspend fun createPurchaseOrder(request: PurchaseOrderDraftParams) = error("unused")
    override suspend fun updatePurchaseOrder(id: String, request: PurchaseOrderDraftParams) = error("unused")
    override suspend fun issuePurchaseOrder(id: String) = error("unused")
    override suspend fun receivePurchaseOrder(id: String, note: String?) = error("unused")
    override suspend fun cancelPurchaseOrder(id: String, reason: String) = error("unused")
    override suspend fun refreshPurchasingReport(from: String?, to: String?) = error("unused")
    override suspend fun overridePurchaseRequest(
        id: String, action: String, reason: String, expectedUpdatedAt: String?, idempotencyKey: String
    ) = error("unused")
    override suspend fun exportPurchasingReport(format: PurchasingExportFormat, locale: String) = error("unused")
    override fun clear() = Unit

    override suspend fun listQuotations(requestId: String, status: String?) =
        AppResult.Success(listOf(quotation()))

    override suspend fun compareQuotations(requestId: String) = AppResult.Success(
        QuotationComparisonParams(
            generatedAt = "2026-08-08T00:00:00.000Z",
            requestId = requestId,
            requestNumber = "PR-1",
            requestTitle = "أجهزة",
            quotations = listOf(quotation()),
            matrix = emptyList(),
            totals = QuotationComparisonTotals(comparableQuotationCount = 1, lowestTotalAmount = "100.00"),
            selectedQuotationId = null
        )
    )

    override suspend fun createQuotation(requestId: String, draft: SupplierQuotationDraft, idempotencyKey: String) =
        AppResult.Success(quotation(status = "draft"))

    override suspend fun submitQuotation(quotationId: String) = AppResult.Success(quotation())

    override suspend fun rejectQuotation(quotationId: String, reason: String) =
        AppResult.Success(quotation(status = "rejected"))

    override suspend fun selectQuotation(quotationId: String, reason: String, idempotencyKey: String):
        AppResult<SupplierQuotationParams> {
        selectKeys += idempotencyKey
        return AppResult.Success(quotation(status = "selected"))
    }

    override suspend fun loadReceipts(orderId: String) =
        AppResult.Success(emptyList<PurchaseReceiptParams>() to progressResult)

    override suspend fun recordReceipt(orderId: String, draft: PurchaseReceiptDraft, idempotencyKey: String):
        AppResult<PurchaseReceiptResult> {
        receiptKeys += idempotencyKey
        lastReceiptDraft = draft
        return receiptResult
    }

    override suspend fun listReturns(orderId: String) = AppResult.Success(listOf(purchaseReturn()))

    override suspend fun createReturn(orderId: String, draft: PurchaseReturnDraft, idempotencyKey: String):
        AppResult<PurchaseReturnParams> {
        returnKeys += idempotencyKey
        lastReturnDraft = draft
        return AppResult.Success(purchaseReturn())
    }

    override suspend fun reviewReturn(returnId: String, action: String, note: String?, idempotencyKey: String) =
        AppResult.Success(purchaseReturn(status = if (action == "approve") "approved" else "rejected"))
}

@OptIn(ExperimentalCoroutinesApi::class)
class PurchasingWave2ControllerTest {

    @Test
    fun `loads quotations and the comparison without inventing a winner`() = runTest {
        val repository = FakeWave2Repository()
        val controller = PurchasingWave2Controller(repository, backgroundScope)

        controller.loadQuotations("request-1")
        runCurrent()
        assertEquals(1, controller.state.value.quotations.size)

        controller.compareQuotations("request-1")
        runCurrent()
        val comparison = controller.state.value.comparison
        assertNotNull(comparison)
        assertEquals("100.00", comparison?.totals?.lowestTotalAmount)
        assertNull(comparison?.selectedQuotationId)
    }

    @Test
    fun `awarding requires a reason and sends a fresh idempotency key`() = runTest {
        val repository = FakeWave2Repository()
        val controller = PurchasingWave2Controller(repository, backgroundScope)

        controller.selectQuotation("quotation-1", "   ")
        runCurrent()
        assertEquals(0, repository.selectKeys.size)
        assertNotNull(controller.state.value.errorMessage)

        controller.dismissFeedback()
        controller.selectQuotation("quotation-1", "أقل إجمالي")
        runCurrent()
        assertEquals(1, repository.selectKeys.size)
        assertTrue(repository.selectKeys.single().startsWith("quotation-select-"))
    }

    @Test
    fun `a second tap while a receipt is in flight is ignored`() = runTest {
        val repository = FakeWave2Repository()
        val controller = PurchasingWave2Controller(repository, backgroundScope)
        controller.loadReceipts("order-1")
        runCurrent()

        controller.recordReceipt("order-1", listOf("line-1" to "1.000"), null, null, null, null, canOverride = false)
        controller.recordReceipt("order-1", listOf("line-1" to "1.000"), null, null, null, null, canOverride = false)
        runCurrent()

        // Exactly one submission reached the repository.
        assertEquals(1, repository.receiptKeys.size)
    }

    @Test
    fun `two deliberate receipts use different idempotency keys`() = runTest {
        val repository = FakeWave2Repository()
        val controller = PurchasingWave2Controller(repository, backgroundScope)
        controller.loadReceipts("order-1")
        runCurrent()

        controller.recordReceipt("order-1", listOf("line-1" to "1.000"), null, null, null, null, canOverride = false)
        runCurrent()
        controller.recordReceipt("order-1", listOf("line-1" to "1.000"), null, null, null, null, canOverride = false)
        runCurrent()

        assertEquals(2, repository.receiptKeys.size)
        assertNotEquals(repository.receiptKeys[0], repository.receiptKeys[1])
    }

    @Test
    fun `an over-receipt is refused without the override permission`() = runTest {
        val repository = FakeWave2Repository()
        val controller = PurchasingWave2Controller(repository, backgroundScope)
        controller.loadReceipts("order-1")
        runCurrent()

        // Remaining is 6.000; 7.000 needs an audited override.
        controller.recordReceipt("order-1", listOf("line-1" to "7.000"), null, null, null, null, canOverride = false)
        runCurrent()

        assertEquals(0, repository.receiptKeys.size)
        assertNotNull(controller.state.value.errorMessage)
    }

    @Test
    fun `an over-receipt still needs the typed confirmation and a reason`() = runTest {
        val repository = FakeWave2Repository()
        val controller = PurchasingWave2Controller(repository, backgroundScope)
        controller.loadReceipts("order-1")
        runCurrent()

        controller.recordReceipt("order-1", listOf("line-1" to "7.000"), null, null, "reason", "YES", canOverride = true)
        runCurrent()
        assertEquals(0, repository.receiptKeys.size)

        controller.dismissFeedback()
        controller.recordReceipt("order-1", listOf("line-1" to "7.000"), null, null, "supplier over-delivered", "OVERRIDE", canOverride = true)
        runCurrent()
        assertEquals(1, repository.receiptKeys.size)
        assertEquals("OVERRIDE", repository.lastReceiptDraft?.override?.confirmation)
        assertEquals("supplier over-delivered", repository.lastReceiptDraft?.override?.reason)
    }

    @Test
    fun `a receipt within the remainder never sends an override`() = runTest {
        val repository = FakeWave2Repository()
        val controller = PurchasingWave2Controller(repository, backgroundScope)
        controller.loadReceipts("order-1")
        runCurrent()

        controller.recordReceipt("order-1", listOf("line-1" to "6.000"), null, null, "unused", "OVERRIDE", canOverride = true)
        runCurrent()

        assertEquals(1, repository.receiptKeys.size)
        assertNull(repository.lastReceiptDraft?.override)
    }

    @Test
    fun `zero and malformed quantities are rejected before any request`() = runTest {
        val repository = FakeWave2Repository()
        val controller = PurchasingWave2Controller(repository, backgroundScope)
        controller.loadReceipts("order-1")
        runCurrent()

        listOf("0", "0.000", "-1.000", "1.0001", "abc").forEach { value ->
            controller.dismissFeedback()
            controller.recordReceipt("order-1", listOf("line-1" to value), null, null, null, null, canOverride = false)
            runCurrent()
        }
        assertEquals(0, repository.receiptKeys.size)
    }

    @Test
    fun `a return cannot exceed the net received quantity`() = runTest {
        val repository = FakeWave2Repository()
        val controller = PurchasingWave2Controller(repository, backgroundScope)
        controller.loadReceipts("order-1")
        runCurrent()

        // Net received is 4.000.
        controller.createReturn("order-1", PurchaseReturnReasons.DAMAGED, null, listOf("line-1" to "5.000"))
        runCurrent()
        assertEquals(0, repository.returnKeys.size)

        controller.dismissFeedback()
        controller.createReturn("order-1", PurchaseReturnReasons.DAMAGED, null, listOf("line-1" to "4.000"))
        runCurrent()
        assertEquals(1, repository.returnKeys.size)
        assertEquals("damaged", repository.lastReturnDraft?.reasonCode)
    }

    @Test
    fun `an unknown return reason never reaches the server`() = runTest {
        val repository = FakeWave2Repository()
        val controller = PurchasingWave2Controller(repository, backgroundScope)
        controller.loadReceipts("order-1")
        runCurrent()

        controller.createReturn("order-1", "because_i_said_so", null, listOf("line-1" to "1.000"))
        runCurrent()

        assertEquals(0, repository.returnKeys.size)
        assertNotNull(controller.state.value.errorMessage)
    }

    @Test
    fun `reset clears state so a new session starts clean`() = runTest {
        val repository = FakeWave2Repository()
        val controller = PurchasingWave2Controller(repository, backgroundScope)
        controller.loadQuotations("request-1")
        runCurrent()
        assertEquals(1, controller.state.value.quotations.size)

        controller.reset()
        assertEquals(0, controller.state.value.quotations.size)
        assertNull(controller.state.value.comparison)
        assertNull(controller.state.value.errorMessage)
    }
}
