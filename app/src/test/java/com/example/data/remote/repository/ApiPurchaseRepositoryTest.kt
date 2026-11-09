package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.*
import com.example.domain.model.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import retrofit2.Response

private val requestDto = PurchaseRequestDto(
    id = "request-1", companyId = "c1", requestNumber = "PR-202607-ABC12345",
    requestedByEmployeeId = "employee-1", requesterNameSnapshot = "موظف", requesterNumSnapshot = "EMP-1",
    title = "أجهزة", status = "pending_purchasing", totalEstimated = "10.06", currency = "SAR",
    lines = listOf(PurchaseRequestLineDto("line-1", "جهاز", null, "1.005", "قطعة", "10.01", "10.06"))
)

private val orderDto = PurchaseOrderDto(
    id = "order-1", companyId = "c1", orderNumber = "PO-202607-ABC12345", purchaseRequestId = "request-1",
    request = PurchaseOrderRequestSummaryDto("request-1", "PR-202607-ABC12345", "أجهزة", "موظف", null, "ordered"),
    vendorId = "vendor-1", vendorNameSnapshot = "مورد", status = "draft", currency = "SAR",
    subtotal = "10.06", totalAmount = "10.06",
    lines = listOf(PurchaseOrderLineDto("order-line-1", "line-1", "جهاز", null, "1.005", "قطعة", "10.01", "10.06"))
)

// ---- Commercial Wave 2 fixtures ----

private val quotationDto = SupplierQuotationDto(
    id = "quotation-1", companyId = "c1", quotationNumber = "SQ-202608-ABC12345",
    purchaseRequestId = "request-1", vendorId = "vendor-1", vendorNameSnapshot = "مورد",
    status = "draft", version = 1, currency = "SAR", subtotal = "10.06", totalAmount = "10.06",
    validUntilDate = "2026-09-01", leadTimeDays = 14,
    lines = listOf(
        SupplierQuotationLineDto(
            id = "quotation-line-1", requestLineId = "line-1", descriptionSnapshot = "جهاز",
            quantity = "1.005", unitSnapshot = "قطعة", unitPrice = "10.01", lineTotal = "10.06",
            leadTimeDays = 14
        )
    )
)

private val comparisonDto = QuotationComparisonDto(
    generatedAt = "2026-08-08T00:00:00.000Z",
    request = QuotationComparisonRequestDto("request-1", "PR-202607-ABC12345", "أجهزة", "approved", "SAR", "10.06"),
    quotations = listOf(quotationDto),
    matrix = listOf(
        QuotationComparisonRowDto(
            requestLineId = "line-1", description = "جهاز", requestedQuantity = "1.005",
            unit = "قطعة", estimatedUnitPrice = "10.01",
            cells = listOf(
                QuotationComparisonCellDto(
                    quotationId = "quotation-1", quotationNumber = "SQ-202608-ABC12345",
                    vendorId = "vendor-1", vendorNameSnapshot = "مورد", quoted = true,
                    quantity = "1.005", unit = "قطعة", unitPrice = "10.01", lineTotal = "10.06",
                    leadTimeDays = 14
                )
            )
        )
    ),
    totals = QuotationComparisonTotalsDto("SAR", 1, "10.06", "10.06", "0.00"),
    selectedQuotationId = null
)

private val progressDto = OrderReceiptProgressDto(
    purchaseOrderId = "order-1",
    fullyReceived = false,
    anyReceived = true,
    lines = listOf(
        OrderLineProgressDto(
            purchaseOrderLineId = "order-line-1", descriptionSnapshot = "جهاز", unitSnapshot = "قطعة",
            unitPrice = "10.01", orderedQuantity = "10.000", receivedQuantity = "4.000",
            returnedQuantity = "1.000", netReceivedQuantity = "3.000", remainingQuantity = "7.000",
            fullyReceived = false
        )
    )
)

private val receiptDto = PurchaseReceiptDto(
    id = "receipt-1", companyId = "c1", purchaseOrderId = "order-1",
    receiptNumber = "GRN-202608-ABC12345", receiptKind = "partial",
    receivedBy = PurchasingActorDto("user-1", "مستلم"), receivedAt = "2026-08-08T00:00:00.000Z",
    lines = listOf(PurchaseReceiptLineDto("receipt-line-1", "order-line-1", "4.000", null))
)

private val returnDto = PurchaseReturnDto(
    id = "return-1", companyId = "c1", purchaseOrderId = "order-1",
    returnNumber = "PRT-202608-ABC12345", status = "pending_approval", reasonCode = "damaged",
    createdBy = PurchasingActorDto("user-1", "مشتريات"), createdAt = "2026-08-08T00:00:00.000Z",
    lines = listOf(PurchaseReturnLineDto("return-line-1", "order-line-1", "1.000", null))
)

private class FakePurchaseApi : PurchaseApi {
    var failCode: Int? = null
    var errorJson = "{}"
    var lastCreateRequest: CreatePurchaseRequestDto? = null
    var lastReview: PurchasingReviewRequestDto? = null
    var lastOrder: CreatePurchaseOrderDto? = null
    var received = false

    // Sprint 12I: purchasing admin override (v2) + purchasing exports (v2).
    var lastOverrideRequest: PurchasingOverrideRequestDto? = null
    var lastOverrideIdempotencyKey: String? = null
    var overrideResult: (() -> Response<PurchaseRequestDto>)? = null
    var lastExportRequest: PurchasingExportRequestDto? = null
    var exportBody: ResponseBody? = null
    var exportDisposition: String? = null

    private fun <T> failure(): Response<T>? = failCode?.let { Response.error(it, errorJson.toResponseBody("application/json".toMediaType())) }
    override suspend fun getRequests(scope: String?, status: String?, from: String?, to: String?, departmentId: String?, requesterEmployeeId: String?) = failure() ?: Response.success(PurchaseRequestPageDto(listOf(requestDto), total = 1))
    override suspend fun getRequest(id: String, scope: String?) = failure() ?: Response.success(requestDto.copy(id = id))
    override suspend fun createRequest(request: CreatePurchaseRequestDto): Response<PurchaseRequestDto> { lastCreateRequest = request; return failure() ?: Response.success(requestDto) }
    override suspend fun reviewDepartment(id: String, request: PurchasingReviewRequestDto): Response<PurchaseRequestDto> { lastReview = request; return failure() ?: Response.success(requestDto.copy(status = "pending_purchasing")) }
    override suspend fun reviewPurchasing(id: String, request: PurchasingReviewRequestDto): Response<PurchaseRequestDto> { lastReview = request; return failure() ?: Response.success(requestDto.copy(status = if (request.action == "approve") "approved" else "rejected")) }
    override suspend fun cancelRequest(id: String, request: PurchasingCancelRequestDto) = failure() ?: Response.success(requestDto.copy(status = "cancelled"))
    override suspend fun getOrders(scope: String?, status: String?, vendorId: String?, requestId: String?, from: String?, to: String?) = failure() ?: Response.success(PurchaseOrderPageDto(listOf(orderDto), total = 1))
    override suspend fun getOrder(id: String, scope: String?) = failure() ?: Response.success(orderDto.copy(id = id))
    override suspend fun createOrder(request: CreatePurchaseOrderDto): Response<PurchaseOrderDto> { lastOrder = request; return failure() ?: Response.success(orderDto) }
    override suspend fun updateOrder(id: String, request: UpdatePurchaseOrderDto) = failure() ?: Response.success(orderDto.copy(id = id))
    override suspend fun issueOrder(id: String) = failure() ?: Response.success(orderDto.copy(id = id, status = "issued"))
    override suspend fun receiveOrder(id: String, request: ReceivePurchaseOrderDto): Response<PurchaseOrderDto> { received = true; return failure() ?: Response.success(orderDto.copy(id = id, status = "received", receiptNote = request.receiptNote)) }
    override suspend fun cancelOrder(id: String, request: PurchasingCancelRequestDto) = failure() ?: Response.success(orderDto.copy(id = id, status = "cancelled"))
    override suspend fun getReport(from: String?, to: String?) = failure() ?: Response.success(PurchasingReportDto(PurchasingReportSummaryDto(requestCount = 1, orderCount = 1, estimatedTotal = "10.06", orderedTotal = "10.06")))

    override suspend fun overrideRequest(id: String, idempotencyKey: String, request: PurchasingOverrideRequestDto): Response<PurchaseRequestDto> {
        lastOverrideRequest = request
        lastOverrideIdempotencyKey = idempotencyKey
        return overrideResult?.invoke() ?: failure() ?: Response.success(
            requestDto.copy(
                status = when (request.action) { "approve" -> "approved"; "reject" -> "rejected"; else -> "cancelled" },
                updatedAt = "2026-07-19T12:00:00.000Z"
            )
        )
    }

    override suspend fun exportPurchasing(request: PurchasingExportRequestDto): Response<ResponseBody> {
        lastExportRequest = request
        failure<ResponseBody>()?.let { return it }
        val body = exportBody ?: "purchasing report body".toResponseBody("text/csv".toMediaType())
        val disposition = exportDisposition
        return if (disposition != null) {
            Response.success(body, okhttp3.Headers.headersOf("Content-Disposition", disposition))
        } else {
            Response.success(body)
        }
    }

    // ---- Commercial Wave 2 (Operations Slice E1) ----

    var lastQuotationRequest: CreateSupplierQuotationDto? = null
    var lastQuotationKey: String? = null
    var lastSelectRequest: SelectSupplierQuotationDto? = null
    var lastSelectKey: String? = null
    var lastReceiptRequest: CreatePurchaseReceiptDto? = null
    var lastReceiptKey: String? = null
    var lastReturnRequest: CreatePurchaseReturnDto? = null
    var lastReturnKey: String? = null
    var lastReviewRequest: ReviewPurchaseReturnDto? = null
    var lastReviewKey: String? = null

    override suspend fun getQuotations(requestId: String, status: String?) =
        failure() ?: Response.success(SupplierQuotationPageDto(listOf(quotationDto), total = 1))

    override suspend fun compareQuotations(requestId: String) =
        failure() ?: Response.success(comparisonDto)

    override suspend fun createQuotation(
        requestId: String,
        idempotencyKey: String,
        request: CreateSupplierQuotationDto
    ): Response<SupplierQuotationDto> {
        lastQuotationRequest = request
        lastQuotationKey = idempotencyKey
        return failure() ?: Response.success(quotationDto)
    }

    override suspend fun getQuotation(quotationId: String) =
        failure() ?: Response.success(quotationDto.copy(id = quotationId))

    override suspend fun submitQuotation(quotationId: String, request: Map<String, String>) =
        failure() ?: Response.success(quotationDto.copy(id = quotationId, status = "submitted"))

    override suspend fun rejectQuotation(quotationId: String, request: RejectSupplierQuotationDto) =
        failure() ?: Response.success(quotationDto.copy(id = quotationId, status = "rejected"))

    override suspend fun selectQuotation(
        quotationId: String,
        idempotencyKey: String,
        request: SelectSupplierQuotationDto
    ): Response<SupplierQuotationDto> {
        lastSelectRequest = request
        lastSelectKey = idempotencyKey
        return failure() ?: Response.success(
            quotationDto.copy(
                id = quotationId,
                status = "selected",
                selection = SupplierQuotationSelectionDto(
                    PurchasingActorDto("user-1", "مشتريات"),
                    "2026-08-08T00:00:00.000Z",
                    request.reason
                )
            )
        )
    }

    override suspend fun getReceipts(orderId: String) =
        failure() ?: Response.success(PurchaseReceiptPageDto(listOf(receiptDto), 1, progressDto))

    override suspend fun createReceipt(
        orderId: String,
        idempotencyKey: String,
        request: CreatePurchaseReceiptDto
    ): Response<CreatePurchaseReceiptResponseDto> {
        lastReceiptRequest = request
        lastReceiptKey = idempotencyKey
        return failure() ?: Response.success(CreatePurchaseReceiptResponseDto(receiptDto, progressDto))
    }

    override suspend fun getReturns(orderId: String) =
        failure() ?: Response.success(PurchaseReturnPageDto(listOf(returnDto), total = 1))

    override suspend fun createReturn(
        orderId: String,
        idempotencyKey: String,
        request: CreatePurchaseReturnDto
    ): Response<PurchaseReturnDto> {
        lastReturnRequest = request
        lastReturnKey = idempotencyKey
        return failure() ?: Response.success(returnDto)
    }

    override suspend fun reviewReturn(
        returnId: String,
        idempotencyKey: String,
        request: ReviewPurchaseReturnDto
    ): Response<PurchaseReturnDto> {
        lastReviewRequest = request
        lastReviewKey = idempotencyKey
        return failure() ?: Response.success(
            returnDto.copy(
                status = if (request.action == "approve") "approved" else "rejected",
                review = PurchaseReturnReviewDto(PurchasingActorDto("user-2", "مالية"), "2026-08-08T00:00:00.000Z", request.note)
            )
        )
    }
}

class ApiPurchaseRepositoryTest {
    @Test
    fun `request mapping preserves raw status and exact decimal strings`() = runTest {
        val repository = ApiPurchaseRepository(FakePurchaseApi())
        assertTrue(repository.refreshPurchaseRequests() is AppResult.Success)
        val request = repository.observePurchaseRequests().first().single()
        assertEquals("pending_purchasing", request.status)
        assertEquals("10.06", request.totalEstimated)
        assertEquals("1.005", request.lines.single().quantity)
        assertEquals("10.01", request.lines.single().estimatedUnitPrice)
    }

    @Test
    fun `create and review call supported endpoints without fake 501`() = runTest {
        val api = FakePurchaseApi()
        val repository = ApiPurchaseRepository(api)
        val created = repository.createPurchaseRequest(CreatePurchaseRequestParams(
            title = "طلب", lines = listOf(PurchaseRequestLineInput("بند", quantity = "1.005", unit = "قطعة", estimatedUnitPrice = "10.01"))
        ))
        assertTrue(created is AppResult.Success)
        assertEquals("1.005", api.lastCreateRequest?.lines?.single()?.quantity)
        assertTrue(repository.reviewPurchasing("request-1", "approve", null) is AppResult.Success)
        assertEquals("approve", api.lastReview?.action)
    }

    @Test
    fun `order workflow maps decimal strings and receive action`() = runTest {
        val api = FakePurchaseApi()
        val repository = ApiPurchaseRepository(api)
        val draft = PurchaseOrderDraftParams("request-1", "vendor-1", listOf(PurchaseOrderLineInput(requestLineId = "line-1", description = "بند", quantity = "1.005", unit = "قطعة", unitPrice = "10.01")))
        assertTrue(repository.createPurchaseOrder(draft) is AppResult.Success)
        assertEquals("10.01", api.lastOrder?.lines?.single()?.unitPrice)
        val received = repository.receivePurchaseOrder("order-1", "استلام كامل")
        assertTrue(received is AppResult.Success)
        assertTrue(api.received)
        assertEquals("received", (received as AppResult.Success).data.status)
    }

    @Test
    fun `Arabic backend errors remain visible and never become success`() = runTest {
        val api = FakePurchaseApi().apply { failCode = 403; errorJson = "{\"error\":\"Forbidden\",\"message\":\"لا تملك صلاحية تنفيذ هذا الإجراء\",\"code\":403}" }
        val result = ApiPurchaseRepository(api).refreshPurchaseRequests()
        assertTrue(result is AppResult.Error)
        assertEquals(403, ((result as AppResult.Error).appError as AppError.ServerError).code)
        assertTrue(result.exception.message.orEmpty().contains("لا تملك صلاحية"))
    }

    @Test
    fun `override sends idempotency key header and OVERRIDE confirmation with the chosen action`() = runTest {
        val api = FakePurchaseApi()
        val repository = ApiPurchaseRepository(api)
        val result = repository.overridePurchaseRequest(
            id = "request-1",
            action = "approve",
            reason = "قرار إداري استثنائي",
            expectedUpdatedAt = "2026-07-18T00:00:00.000Z",
            idempotencyKey = "override-key-123"
        )
        assertTrue(result is AppResult.Success)
        assertEquals("approved", (result as AppResult.Success).data.status)
        assertEquals("OVERRIDE", api.lastOverrideRequest?.confirmation)
        assertEquals("approve", api.lastOverrideRequest?.action)
        assertEquals("قرار إداري استثنائي", api.lastOverrideRequest?.reason)
        assertEquals("2026-07-18T00:00:00.000Z", api.lastOverrideRequest?.expectedUpdatedAt)
        assertEquals("override-key-123", api.lastOverrideIdempotencyKey)
    }

    @Test
    fun `override self-forbidden 403 surfaces the exact backend outcome code and Arabic message`() = runTest {
        val api = FakePurchaseApi().apply {
            overrideResult = {
                Response.error(
                    403,
                    "{\"error\":\"Forbidden\",\"code\":403,\"messageKey\":\"purchasing.override_self_forbidden\"}"
                        .toResponseBody("application/json".toMediaType())
                )
            }
        }
        val result = ApiPurchaseRepository(api).overridePurchaseRequest("request-1", "approve", "سبب", null, "key-1")
        assertTrue(result is AppResult.Error)
        val exception = (result as AppResult.Error).exception as PurchasingOverrideException
        assertEquals("Forbidden", exception.code)
        assertTrue(exception.message.orEmpty().contains("لا يمكنك"))
        assertEquals(403, (result.appError as AppError.ServerError).code)
    }

    @Test
    fun `override stale version 412 surfaces currentUpdatedAt for a clean retry`() = runTest {
        val api = FakePurchaseApi().apply {
            overrideResult = {
                Response.error(
                    412,
                    "{\"error\":\"VersionMismatch\",\"code\":412,\"messageKey\":\"purchasing.override_updated_at_mismatch\",\"currentUpdatedAt\":\"2026-07-19T09:00:00.000Z\"}"
                        .toResponseBody("application/json".toMediaType())
                )
            }
        }
        val result = ApiPurchaseRepository(api).overridePurchaseRequest("request-1", "cancel", "سبب", "2026-07-18T00:00:00.000Z", "key-1")
        assertTrue(result is AppResult.Error)
        val exception = (result as AppResult.Error).exception as PurchasingOverrideException
        assertEquals("VersionMismatch", exception.code)
        assertEquals("2026-07-19T09:00:00.000Z", exception.currentUpdatedAt)
        assertTrue(exception.message.orEmpty().contains("تغيّرت بيانات الطلب"))
    }

    @Test
    fun `override illegal transition 409 surfaces currentStatus instead of a generic error`() = runTest {
        val api = FakePurchaseApi().apply {
            overrideResult = {
                Response.error(
                    409,
                    "{\"error\":\"IllegalTransition\",\"code\":409,\"messageKey\":\"purchasing.override_illegal_transition\",\"currentStatus\":\"cancelled\"}"
                        .toResponseBody("application/json".toMediaType())
                )
            }
        }
        val result = ApiPurchaseRepository(api).overridePurchaseRequest("request-1", "reject", "سبب", null, "key-1")
        assertTrue(result is AppResult.Error)
        val exception = (result as AppResult.Error).exception as PurchasingOverrideException
        assertEquals("IllegalTransition", exception.code)
        assertEquals("cancelled", exception.currentStatus)
        assertTrue(exception.message.orEmpty().contains("لا تسمح"))
    }

    @Test
    fun `export sends format and locale and maps the response body to a share payload`() = runTest {
        val api = FakePurchaseApi().apply {
            exportBody = "id,name\n1,test".toResponseBody("text/csv".toMediaType())
            exportDisposition = "attachment; filename=\"purchasing-2026-07-19.csv\""
        }
        val result = ApiPurchaseRepository(api).exportPurchasingReport(PurchasingExportFormat.CSV, "en")
        assertTrue(result is AppResult.Success)
        val payload = (result as AppResult.Success).data
        assertEquals("text/csv", payload.mimeType)
        assertEquals("purchasing-2026-07-19.csv", payload.filename)
        assertTrue(payload.bytes.isNotEmpty())
        assertEquals("csv", api.lastExportRequest?.format)
        assertEquals("en", api.lastExportRequest?.locale)
    }

    @Test
    fun `export forbidden 403 (missing reports export permission) is never treated as success`() = runTest {
        val api = FakePurchaseApi().apply { failCode = 403; errorJson = "{\"error\":\"Forbidden\",\"message\":\"لا تملك صلاحية تصدير تقرير المشتريات\",\"code\":403}" }
        val result = ApiPurchaseRepository(api).exportPurchasingReport(PurchasingExportFormat.PDF)
        assertTrue(result is AppResult.Error)
        assertEquals(403, ((result as AppResult.Error).appError as AppError.ServerError).code)
    }

    @Test
    fun `purchasing DTO and domain money fields are never Double or Float`() {
        val classes = listOf(
            PurchaseRequestLineDto::class.java, PurchaseRequestDto::class.java,
            PurchaseOrderLineDto::class.java, PurchaseOrderDto::class.java,
            PurchaseRequestLineParams::class.java, PurchaseRequestParams::class.java,
            PurchaseOrderLineParams::class.java, PurchaseOrderParams::class.java,
            PurchasingReportSummary::class.java,
            // Commercial Wave 2 quantity/money carriers.
            SupplierQuotationLineDto::class.java, SupplierQuotationDto::class.java,
            OrderLineProgressDto::class.java, PurchaseReceiptLineDto::class.java,
            PurchaseReturnLineDto::class.java, QuotationComparisonCellDto::class.java,
            QuotationComparisonTotalsDto::class.java,
            SupplierQuotationLineParams::class.java, SupplierQuotationParams::class.java,
            OrderLineProgressParams::class.java, PurchaseReceiptLineParams::class.java,
            PurchaseReturnLineParams::class.java, QuotationComparisonCell::class.java,
            QuotationComparisonTotals::class.java
        )
        classes.flatMap { it.declaredFields.toList() }.forEach { field ->
            assertFalse("${field.declaringClass.simpleName}.${field.name}", field.type == Double::class.javaPrimitiveType || field.type == Float::class.javaPrimitiveType || field.type == java.lang.Double::class.java || field.type == java.lang.Float::class.java)
        }
    }

    // ---- Commercial Wave 2 (Operations Slice E1) ----

    @Test
    fun `quotation mapping preserves exact decimal strings and selection metadata`() = runTest {
        val repository = ApiPurchaseRepository(FakePurchaseApi())
        val listed = repository.listQuotations("request-1")
        assertTrue(listed is AppResult.Success)
        val quotation = (listed as AppResult.Success).data.single()
        assertEquals("SQ-202608-ABC12345", quotation.quotationNumber)
        assertEquals("10.06", quotation.totalAmount)
        assertEquals("1.005", quotation.lines.single().quantity)
        assertEquals("10.01", quotation.lines.single().unitPrice)
        assertEquals(14, quotation.leadTimeDays)
        assertFalse(quotation.isSelected)
        assertTrue(quotation.isEditable)
    }

    @Test
    fun `awarding a quotation sends the confirmation, reason and idempotency key`() = runTest {
        val api = FakePurchaseApi()
        val result = ApiPurchaseRepository(api).selectQuotation("quotation-1", " أقل إجمالي ", "quotation-select-key-001")
        assertTrue(result is AppResult.Success)
        assertEquals(true, api.lastSelectRequest?.confirm)
        assertEquals("أقل إجمالي", api.lastSelectRequest?.reason)
        assertEquals("quotation-select-key-001", api.lastSelectKey)
        val awarded = (result as AppResult.Success).data
        assertTrue(awarded.isSelected)
        assertEquals("user-1", awarded.selectedBy?.id)
    }

    @Test
    fun `creating a quotation forwards every captured field with its idempotency key`() = runTest {
        val api = FakePurchaseApi()
        val result = ApiPurchaseRepository(api).createQuotation(
            "request-1",
            SupplierQuotationDraft(
                vendorId = "vendor-1",
                supplierReference = " Q-1 ",
                validUntilDate = "2026-09-01",
                leadTimeDays = 14,
                lines = listOf(
                    SupplierQuotationLineInput(
                        requestLineId = "line-1", description = "جهاز",
                        quantity = "1.005", unit = "قطعة", unitPrice = "10.01"
                    )
                )
            ),
            "quotation-create-key-001"
        )
        assertTrue(result is AppResult.Success)
        assertEquals("quotation-create-key-001", api.lastQuotationKey)
        assertEquals("Q-1", api.lastQuotationRequest?.supplierReference)
        assertEquals("1.005", api.lastQuotationRequest?.lines?.single()?.quantity)
        assertEquals("SAR", api.lastQuotationRequest?.currency)
    }

    @Test
    fun `comparison maps the matrix and objective totals without a recommended supplier`() = runTest {
        val result = ApiPurchaseRepository(FakePurchaseApi()).compareQuotations("request-1")
        assertTrue(result is AppResult.Success)
        val comparison = (result as AppResult.Success).data
        assertEquals(1, comparison.matrix.size)
        assertEquals("10.06", comparison.matrix.single().cells.single().lineTotal)
        assertEquals("10.06", comparison.totals.lowestTotalAmount)
        assertEquals("0.00", comparison.totals.spreadAmount)
        assertNull(comparison.selectedQuotationId)
        // The contract carries no ranking/recommendation field at all.
        assertFalse(
            QuotationComparisonTotals::class.java.declaredFields.any {
                it.name.contains("recommended", ignoreCase = true) || it.name.contains("score", ignoreCase = true)
            }
        )
    }

    @Test
    fun `receipt progress maps exact quantities and the derived remainder`() = runTest {
        val result = ApiPurchaseRepository(FakePurchaseApi()).loadReceipts("order-1")
        assertTrue(result is AppResult.Success)
        val (receipts, progress) = (result as AppResult.Success).data
        assertEquals("GRN-202608-ABC12345", receipts.single().receiptNumber)
        val line = progress?.lines?.single()
        assertEquals("10.000", line?.orderedQuantity)
        assertEquals("4.000", line?.receivedQuantity)
        assertEquals("1.000", line?.returnedQuantity)
        assertEquals("3.000", line?.netReceivedQuantity)
        assertEquals("7.000", line?.remainingQuantity)
        assertEquals(false, line?.fullyReceived)
    }

    @Test
    fun `a partial receipt sends its lines and idempotency key, and omits an unused override`() = runTest {
        val api = FakePurchaseApi()
        val result = ApiPurchaseRepository(api).recordReceipt(
            "order-1",
            PurchaseReceiptDraft(lines = listOf(PurchaseReceiptLineInput("order-line-1", "4.000")), referenceNumber = " DN-1 "),
            "receipt-key-001"
        )
        assertTrue(result is AppResult.Success)
        assertEquals("receipt-key-001", api.lastReceiptKey)
        assertEquals("4.000", api.lastReceiptRequest?.lines?.single()?.quantity)
        assertEquals("DN-1", api.lastReceiptRequest?.referenceNumber)
        assertNull(api.lastReceiptRequest?.override)
    }

    @Test
    fun `an over-receipt carries the OVERRIDE confirmation and reason`() = runTest {
        val api = FakePurchaseApi()
        ApiPurchaseRepository(api).recordReceipt(
            "order-1",
            PurchaseReceiptDraft(
                lines = listOf(PurchaseReceiptLineInput("order-line-1", "11.000")),
                override = PurchaseReceiptOverride(reason = "المورد سلّم كمية زائدة")
            ),
            "receipt-key-002"
        )
        assertEquals("OVERRIDE", api.lastReceiptRequest?.override?.confirmation)
        assertEquals("المورد سلّم كمية زائدة", api.lastReceiptRequest?.override?.reason)
    }

    @Test
    fun `returns are created and reviewed through their own idempotent endpoints`() = runTest {
        val api = FakePurchaseApi()
        val repository = ApiPurchaseRepository(api)
        val created = repository.createReturn(
            "order-1",
            PurchaseReturnDraft(reasonCode = PurchaseReturnReasons.DAMAGED, lines = listOf(PurchaseReturnLineInput("order-line-1", "1.000"))),
            "return-key-001"
        )
        assertTrue(created is AppResult.Success)
        assertEquals("return-key-001", api.lastReturnKey)
        assertEquals("damaged", api.lastReturnRequest?.reasonCode)
        assertTrue((created as AppResult.Success).data.isPendingApproval)

        val reviewed = repository.reviewReturn("return-1", "approve", null, "return-review-key-001")
        assertTrue(reviewed is AppResult.Success)
        assertEquals("approve", api.lastReviewRequest?.action)
        assertEquals("return-review-key-001", api.lastReviewKey)
        assertEquals("approved", (reviewed as AppResult.Success).data.status)
    }

    @Test
    fun `wave 2 failures are surfaced instead of being treated as success`() = runTest {
        val api = FakePurchaseApi().apply {
            failCode = 409
            errorJson = "{\"error\":\"RECEIPT_EXCEEDS_REMAINING\",\"message\":\"الكمية المستلمة تتجاوز الكمية المتبقية\",\"code\":409}"
        }
        val result = ApiPurchaseRepository(api).recordReceipt(
            "order-1",
            PurchaseReceiptDraft(lines = listOf(PurchaseReceiptLineInput("order-line-1", "99.000"))),
            "receipt-key-003"
        )
        assertTrue(result is AppResult.Error)
        assertEquals(409, ((result as AppResult.Error).appError as AppError.ServerError).code)
    }
}
