package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.*
import com.example.domain.model.*
import com.example.domain.repository.PurchaseRepository
import com.squareup.moshi.Moshi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.ResponseBody
import retrofit2.Response
import java.io.ByteArrayOutputStream

private const val MAX_PURCHASING_EXPORT_BYTES = 10 * 1024 * 1024

class ApiPurchaseRepository(
    private val api: PurchaseApi
) : PurchaseRepository {

    private val requests = MutableStateFlow<List<PurchaseRequestParams>>(emptyList())
    private val orders = MutableStateFlow<List<PurchaseOrderParams>>(emptyList())
    private val report = MutableStateFlow<PurchasingReportParams?>(null)
    private val errorAdapter = Moshi.Builder().build().adapter(PurchasingErrorDto::class.java)
    private val overrideErrorAdapter = Moshi.Builder().build().adapter(PurchasingOverrideErrorDto::class.java)
    private var requestFilters = PurchaseRequestFilters()
    private var orderFilters = PurchaseOrderFilters()

    private fun PurchaseReviewDto.toParams() = PurchaseReviewParams(
        reviewer = reviewer?.let { PurchasingActor(it.id, it.name) },
        reviewedAt = reviewedAt,
        note = note
    )

    private fun PurchaseRequestDto.toParams() = PurchaseRequestParams(
        id = id,
        companyId = companyId,
        requestNumber = requestNumber,
        requestedByEmployeeId = requestedByEmployeeId,
        requesterNameSnapshot = requesterNameSnapshot,
        requesterNumSnapshot = requesterNumSnapshot,
        departmentId = departmentId,
        departmentNameSnapshot = departmentNameSnapshot,
        title = title,
        justification = justification,
        neededByDate = neededByDate,
        status = status,
        totalEstimated = totalEstimated,
        currency = currency,
        lines = lines.map { line ->
            PurchaseRequestLineParams(
                id = line.id,
                description = line.description,
                category = line.category,
                quantity = line.quantity,
                unit = line.unit,
                estimatedUnitPrice = line.estimatedUnitPrice,
                estimatedTotal = line.estimatedTotal
            )
        },
        departmentReview = departmentReview?.toParams(),
        purchasingReview = purchasingReview?.toParams(),
        rejectedAt = rejectedAt,
        orders = orders.map { order ->
            PurchaseOrderSummaryParams(order.id, order.orderNumber, order.status, order.totalAmount, order.currency, order.createdAt)
        },
        createdAt = createdAt,
        updatedAt = updatedAt
    )

    private fun PurchaseOrderDto.toParams() = PurchaseOrderParams(
        id = id,
        companyId = companyId,
        orderNumber = orderNumber,
        purchaseRequestId = purchaseRequestId,
        requestNumber = request?.requestNumber,
        requestTitle = request?.title,
        requesterNameSnapshot = request?.requesterNameSnapshot,
        departmentNameSnapshot = request?.departmentNameSnapshot,
        vendorId = vendorId,
        vendorNameSnapshot = vendorNameSnapshot,
        vendorContactSnapshot = vendorContactSnapshot,
        vendorEmailSnapshot = vendorEmailSnapshot,
        vendorTaxNumberSnapshot = vendorTaxNumberSnapshot,
        status = status,
        currency = currency,
        subtotal = subtotal,
        totalAmount = totalAmount,
        lines = lines.map { line ->
            PurchaseOrderLineParams(
                line.id, line.requestLineId, line.descriptionSnapshot, line.categorySnapshot,
                line.quantity, line.unitSnapshot, line.unitPrice, line.lineTotal
            )
        },
        issuedAt = issuedAt,
        receivedAt = receivedAt,
        receiptNote = receiptNote,
        cancelledAt = cancelledAt,
        cancellationReason = cancellationReason,
        createdAt = createdAt,
        updatedAt = updatedAt
    )

    private fun <T> error(response: Response<T>, fallback: String): AppResult.Error {
        val payload = try { response.errorBody()?.string()?.let(errorAdapter::fromJson) } catch (_: Exception) { null }
        val message = payload?.message?.takeIf(String::isNotBlank) ?: fallback
        return AppResult.Error(Exception(message), AppError.ServerError(response.code(), message))
    }

    private fun cacheRequest(item: PurchaseRequestParams) {
        requests.value = (requests.value.filterNot { it.id == item.id } + item).sortedByDescending { it.createdAt }
    }

    private fun cacheOrder(item: PurchaseOrderParams) {
        orders.value = (orders.value.filterNot { it.id == item.id } + item).sortedByDescending { it.createdAt }
    }

    private fun PurchaseRequestLineInput.toDto() = PurchaseRequestLineInputDto(
        description.trim(), category?.trim()?.takeIf(String::isNotEmpty), quantity.trim(), unit.trim(), estimatedUnitPrice.trim()
    )

    private fun PurchaseOrderLineInput.toDto() = PurchaseOrderLineInputDto(
        id, requestLineId, description.trim(), category?.trim()?.takeIf(String::isNotEmpty), quantity.trim(), unit.trim(), unitPrice.trim()
    )

    override fun observePurchaseRequests(): Flow<List<PurchaseRequestParams>> = requests.asStateFlow()
    override fun observePurchaseOrders(): Flow<List<PurchaseOrderParams>> = orders.asStateFlow()
    override fun observePurchasingReport(): Flow<PurchasingReportParams?> = report.asStateFlow()

    override suspend fun refreshPurchaseRequests(filters: PurchaseRequestFilters): AppResult<Unit> = try {
        val response = api.getRequests(filters.scope, filters.status, filters.from, filters.to, filters.departmentId, filters.requesterEmployeeId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            requestFilters = filters
            requests.value = body.items.map { it.toParams() }
            AppResult.Success(Unit)
        } else error(response, "تعذر تحميل طلبات الشراء")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun loadPurchaseRequest(id: String, scope: String?): AppResult<PurchaseRequestParams> = try {
        val response = api.getRequest(id, scope)
        val body = response.body()
        if (response.isSuccessful && body != null) body.toParams().also(::cacheRequest).let { AppResult.Success(it) }
        else error(response, "تعذر تحميل تفاصيل طلب الشراء")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun createPurchaseRequest(request: CreatePurchaseRequestParams): AppResult<PurchaseRequestParams> = try {
        val response = api.createRequest(CreatePurchaseRequestDto(
            title = request.title.trim(),
            justification = request.justification?.trim()?.takeIf(String::isNotEmpty),
            neededByDate = request.neededByDate,
            currency = request.currency,
            lines = request.lines.map { it.toDto() }
        ))
        val body = response.body()
        if (response.isSuccessful && body != null) body.toParams().also(::cacheRequest).also { refreshPurchaseRequests(requestFilters) }.let { AppResult.Success(it) }
        else error(response, "تعذر إنشاء طلب الشراء")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    private suspend fun review(id: String, action: String, note: String?, department: Boolean): AppResult<PurchaseRequestParams> = try {
        val payload = PurchasingReviewRequestDto(action, note?.trim()?.takeIf(String::isNotEmpty))
        val response = if (department) api.reviewDepartment(id, payload) else api.reviewPurchasing(id, payload)
        val body = response.body()
        if (response.isSuccessful && body != null) body.toParams().also(::cacheRequest).also { refreshPurchaseRequests(requestFilters) }.let { AppResult.Success(it) }
        else error(response, "تعذرت مراجعة طلب الشراء")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun reviewDepartment(id: String, action: String, note: String?) = review(id, action, note, true)
    override suspend fun reviewPurchasing(id: String, action: String, note: String?) = review(id, action, note, false)

    override suspend fun cancelPurchaseRequest(id: String, reason: String): AppResult<PurchaseRequestParams> = try {
        val response = api.cancelRequest(id, PurchasingCancelRequestDto(reason.trim()))
        val body = response.body()
        if (response.isSuccessful && body != null) body.toParams().also(::cacheRequest).also { refreshPurchaseRequests(requestFilters) }.let { AppResult.Success(it) }
        else error(response, "تعذر إلغاء طلب الشراء")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun refreshPurchaseOrders(filters: PurchaseOrderFilters): AppResult<Unit> = try {
        val response = api.getOrders(filters.scope, filters.status, filters.vendorId, filters.requestId, filters.from, filters.to)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            orderFilters = filters
            orders.value = body.items.map { it.toParams() }
            AppResult.Success(Unit)
        } else error(response, "تعذر تحميل أوامر الشراء")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun loadPurchaseOrder(id: String, scope: String?): AppResult<PurchaseOrderParams> = try {
        val response = api.getOrder(id, scope)
        val body = response.body()
        if (response.isSuccessful && body != null) body.toParams().also(::cacheOrder).let { AppResult.Success(it) }
        else error(response, "تعذر تحميل أمر الشراء")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun createPurchaseOrder(request: PurchaseOrderDraftParams): AppResult<PurchaseOrderParams> = try {
        val response = api.createOrder(CreatePurchaseOrderDto(request.purchaseRequestId, request.vendorId, request.currency, request.lines.map { it.toDto() }))
        val body = response.body()
        if (response.isSuccessful && body != null) body.toParams().also(::cacheOrder).also { refreshPurchaseOrders(orderFilters); refreshPurchaseRequests(requestFilters) }.let { AppResult.Success(it) }
        else error(response, "تعذر إنشاء أمر الشراء")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun updatePurchaseOrder(id: String, request: PurchaseOrderDraftParams): AppResult<PurchaseOrderParams> = try {
        val response = api.updateOrder(id, UpdatePurchaseOrderDto(request.vendorId, request.currency, request.lines.map { it.toDto() }))
        val body = response.body()
        if (response.isSuccessful && body != null) body.toParams().also(::cacheOrder).let { AppResult.Success(it) }
        else error(response, "تعذر تحديث أمر الشراء")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    private suspend fun orderAction(id: String, fallback: String, call: suspend () -> Response<PurchaseOrderDto>): AppResult<PurchaseOrderParams> = try {
        val response = call()
        val body = response.body()
        if (response.isSuccessful && body != null) body.toParams().also(::cacheOrder).also { refreshPurchaseOrders(orderFilters); refreshPurchaseRequests(requestFilters) }.let { AppResult.Success(it) }
        else error(response, fallback)
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun issuePurchaseOrder(id: String) = orderAction(id, "تعذر إصدار أمر الشراء") { api.issueOrder(id) }
    override suspend fun receivePurchaseOrder(id: String, note: String?) = orderAction(id, "تعذر استلام أمر الشراء") { api.receiveOrder(id, ReceivePurchaseOrderDto(note?.trim()?.takeIf(String::isNotEmpty))) }
    override suspend fun cancelPurchaseOrder(id: String, reason: String) = orderAction(id, "تعذر إلغاء أمر الشراء") { api.cancelOrder(id, PurchasingCancelRequestDto(reason.trim())) }

    override fun clear() {
        requests.value = emptyList()
        orders.value = emptyList()
        report.value = null
        requestFilters = PurchaseRequestFilters()
        orderFilters = PurchaseOrderFilters()
    }

    override suspend fun refreshPurchasingReport(from: String?, to: String?): AppResult<Unit> = try {
        val response = api.getReport(from, to)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            report.value = PurchasingReportParams(
                summary = body.summary.run { PurchasingReportSummary(requestCount, pendingDepartmentCount, pendingPurchasingCount, approvedCount, orderedCount, receivedCount, orderCount, estimatedTotal, orderedTotal, receivedTotal, currency) }
            )
            AppResult.Success(Unit)
        } else error(response, "تعذر تحميل تقرير المشتريات")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    /**
     * The override endpoint (unlike the v1 review/cancel routes) only returns a short
     * `messageKey` — never an Arabic message — for its documented failure outcomes.
     * Translate the known keys here so the ViewModel/UI always see Arabic text, same
     * convention as ApiPayrollRepository's payment errors.
     */
    private fun overrideMessageFor(key: String?): String? = when (key) {
        "purchasing.unauthorized" -> "يلزم تسجيل الدخول مجددًا."
        "purchasing.invalid_request" -> "طلب غير صالح. تحقق من البيانات وأعد المحاولة."
        "purchasing.override_idempotency_key_required" -> "مفتاح الطلب مفقود. أعد المحاولة."
        "purchasing.override_idempotency_key_invalid" -> "مفتاح الطلب غير صالح. أعد المحاولة."
        "purchasing.override_idempotency_key_reused" -> "توجد محاولة سابقة بنفس المفتاح ببيانات مختلفة. أعد المحاولة بمفتاح جديد."
        "purchasing.override_not_found" -> "طلب الشراء غير موجود."
        "purchasing.override_self_forbidden" -> "لا يمكنك تنفيذ إجراء إداري على طلب تقدّمت به بنفسك."
        "purchasing.override_updated_at_mismatch" -> "تغيّرت بيانات الطلب منذ فتح الشاشة. حدّث القائمة ثم أعد المحاولة."
        "purchasing.override_illegal_transition" -> "حالة الطلب الحالية لا تسمح بتنفيذ هذا الإجراء."
        "purchasing.override_active_order_exists" -> "لا يمكن الإلغاء لوجود أمر شراء نشط مرتبط بهذا الطلب."
        "purchasing.override_state_conflict" -> "تغيّرت حالة الطلب أثناء التنفيذ. أعد المحاولة."
        else -> null
    }

    override suspend fun overridePurchaseRequest(
        id: String,
        action: String,
        reason: String,
        expectedUpdatedAt: String?,
        idempotencyKey: String
    ): AppResult<PurchaseRequestParams> = try {
        val response = api.overrideRequest(
            id,
            idempotencyKey,
            PurchasingOverrideRequestDto(action = action, reason = reason.trim(), expectedUpdatedAt = expectedUpdatedAt)
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            body.toParams().also(::cacheRequest).also { refreshPurchaseRequests(requestFilters) }.let { AppResult.Success(it) }
        } else {
            val payload = try {
                response.errorBody()?.string()?.let(overrideErrorAdapter::fromJson)
            } catch (_: Exception) {
                null
            }
            val message = overrideMessageFor(payload?.messageKey)
                ?: payload?.message?.takeIf(String::isNotBlank)
                ?: "تعذر تنفيذ الإجراء الإداري"
            AppResult.Error(
                PurchasingOverrideException(
                    message = message,
                    code = payload?.error ?: "Unknown",
                    currentUpdatedAt = payload?.currentUpdatedAt,
                    currentStatus = payload?.currentStatus
                ),
                AppError.ServerError(response.code(), message)
            )
        }
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    // ---- Commercial Wave 2 (Operations Slice E1) ----

    private fun SupplierQuotationDto.toParams() = SupplierQuotationParams(
        id = id,
        companyId = companyId,
        quotationNumber = quotationNumber,
        purchaseRequestId = purchaseRequestId,
        vendorId = vendorId,
        vendorNameSnapshot = vendorNameSnapshot,
        supplierReference = supplierReference,
        status = status,
        version = version,
        currency = currency,
        subtotal = subtotal,
        totalAmount = totalAmount,
        quotationDate = quotationDate,
        validUntilDate = validUntilDate,
        expectedDeliveryDate = expectedDeliveryDate,
        leadTimeDays = leadTimeDays,
        paymentTerms = paymentTerms,
        notes = notes,
        lines = lines.map { line ->
            SupplierQuotationLineParams(
                id = line.id,
                requestLineId = line.requestLineId,
                descriptionSnapshot = line.descriptionSnapshot,
                categorySnapshot = line.categorySnapshot,
                quantity = line.quantity,
                unitSnapshot = line.unitSnapshot,
                unitPrice = line.unitPrice,
                lineTotal = line.lineTotal,
                leadTimeDays = line.leadTimeDays,
                notes = line.notes
            )
        },
        submittedAt = submittedAt,
        selectedAt = selection?.selectedAt,
        selectedBy = selection?.actor?.let { PurchasingActor(it.id, it.name) },
        rejectedAt = rejection?.rejectedAt,
        createdAt = createdAt,
        updatedAt = updatedAt
    )

    private fun OrderReceiptProgressDto.toParams() = OrderReceiptProgressParams(
        purchaseOrderId = purchaseOrderId,
        fullyReceived = fullyReceived,
        anyReceived = anyReceived,
        lines = lines.map { line ->
            OrderLineProgressParams(
                purchaseOrderLineId = line.purchaseOrderLineId,
                descriptionSnapshot = line.descriptionSnapshot,
                unitSnapshot = line.unitSnapshot,
                unitPrice = line.unitPrice,
                orderedQuantity = line.orderedQuantity,
                receivedQuantity = line.receivedQuantity,
                returnedQuantity = line.returnedQuantity,
                netReceivedQuantity = line.netReceivedQuantity,
                remainingQuantity = line.remainingQuantity,
                fullyReceived = line.fullyReceived
            )
        }
    )

    private fun PurchaseReceiptDto.toParams() = PurchaseReceiptParams(
        id = id,
        purchaseOrderId = purchaseOrderId,
        receiptNumber = receiptNumber,
        receiptKind = receiptKind,
        referenceNumber = referenceNumber,
        note = note,
        receivedBy = receivedBy?.let { PurchasingActor(it.id, it.name) },
        receivedAt = receivedAt,
        overrideApplied = overrideApplied,
        lines = lines.map { PurchaseReceiptLineParams(it.id, it.purchaseOrderLineId, it.quantity, it.note) }
    )

    private fun PurchaseReturnDto.toParams() = PurchaseReturnParams(
        id = id,
        purchaseOrderId = purchaseOrderId,
        returnNumber = returnNumber,
        status = status,
        reasonCode = reasonCode,
        note = note,
        createdBy = createdBy?.let { PurchasingActor(it.id, it.name) },
        createdAt = createdAt,
        reviewedBy = review?.actor?.let { PurchasingActor(it.id, it.name) },
        reviewedAt = review?.reviewedAt,
        lines = lines.map { PurchaseReturnLineParams(it.id, it.purchaseOrderLineId, it.quantity, it.note) }
    )

    override suspend fun listQuotations(requestId: String, status: String?): AppResult<List<SupplierQuotationParams>> = try {
        val response = api.getQuotations(requestId, status)
        val body = response.body()
        if (response.isSuccessful && body != null) AppResult.Success(body.items.map { it.toParams() })
        else error(response, "تعذر تحميل عروض الأسعار")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun compareQuotations(requestId: String): AppResult<QuotationComparisonParams> = try {
        val response = api.compareQuotations(requestId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(
                QuotationComparisonParams(
                    generatedAt = body.generatedAt,
                    requestId = body.request.id,
                    requestNumber = body.request.requestNumber,
                    requestTitle = body.request.title,
                    quotations = body.quotations.map { it.toParams() },
                    matrix = body.matrix.map { row ->
                        QuotationComparisonRow(
                            requestLineId = row.requestLineId,
                            description = row.description,
                            requestedQuantity = row.requestedQuantity,
                            unit = row.unit,
                            estimatedUnitPrice = row.estimatedUnitPrice,
                            cells = row.cells.map { cell ->
                                QuotationComparisonCell(
                                    quotationId = cell.quotationId,
                                    quotationNumber = cell.quotationNumber,
                                    vendorId = cell.vendorId,
                                    vendorNameSnapshot = cell.vendorNameSnapshot,
                                    quoted = cell.quoted,
                                    quantity = cell.quantity,
                                    unit = cell.unit,
                                    unitPrice = cell.unitPrice,
                                    lineTotal = cell.lineTotal,
                                    leadTimeDays = cell.leadTimeDays
                                )
                            }
                        )
                    },
                    totals = QuotationComparisonTotals(
                        currency = body.totals.currency,
                        comparableQuotationCount = body.totals.comparableQuotationCount,
                        lowestTotalAmount = body.totals.lowestTotalAmount,
                        highestTotalAmount = body.totals.highestTotalAmount,
                        spreadAmount = body.totals.spreadAmount
                    ),
                    selectedQuotationId = body.selectedQuotationId
                )
            )
        } else error(response, "تعذر تحميل مقارنة عروض الأسعار")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun createQuotation(
        requestId: String,
        draft: SupplierQuotationDraft,
        idempotencyKey: String
    ): AppResult<SupplierQuotationParams> = try {
        val response = api.createQuotation(
            requestId,
            idempotencyKey,
            CreateSupplierQuotationDto(
                vendorId = draft.vendorId,
                supplierReference = draft.supplierReference?.trim()?.takeIf(String::isNotEmpty),
                currency = draft.currency,
                quotationDate = draft.quotationDate,
                validUntilDate = draft.validUntilDate,
                expectedDeliveryDate = draft.expectedDeliveryDate,
                leadTimeDays = draft.leadTimeDays,
                paymentTerms = draft.paymentTerms?.trim()?.takeIf(String::isNotEmpty),
                notes = draft.notes?.trim()?.takeIf(String::isNotEmpty),
                lines = draft.lines.map { line ->
                    SupplierQuotationLineInputDto(
                        requestLineId = line.requestLineId,
                        description = line.description.trim(),
                        category = line.category?.trim()?.takeIf(String::isNotEmpty),
                        quantity = line.quantity.trim(),
                        unit = line.unit.trim(),
                        unitPrice = line.unitPrice.trim(),
                        leadTimeDays = line.leadTimeDays,
                        notes = line.notes?.trim()?.takeIf(String::isNotEmpty)
                    )
                }
            )
        )
        val body = response.body()
        if (response.isSuccessful && body != null) AppResult.Success(body.toParams())
        else error(response, "تعذر تسجيل عرض السعر")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun submitQuotation(quotationId: String): AppResult<SupplierQuotationParams> = try {
        val response = api.submitQuotation(quotationId)
        val body = response.body()
        if (response.isSuccessful && body != null) AppResult.Success(body.toParams())
        else error(response, "تعذر ترحيل عرض السعر")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun rejectQuotation(quotationId: String, reason: String): AppResult<SupplierQuotationParams> = try {
        val response = api.rejectQuotation(quotationId, RejectSupplierQuotationDto(reason.trim()))
        val body = response.body()
        if (response.isSuccessful && body != null) AppResult.Success(body.toParams())
        else error(response, "تعذر رفض عرض السعر")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun selectQuotation(
        quotationId: String,
        reason: String,
        idempotencyKey: String
    ): AppResult<SupplierQuotationParams> = try {
        val response = api.selectQuotation(
            quotationId,
            idempotencyKey,
            SelectSupplierQuotationDto(reason = reason.trim(), confirm = true)
        )
        val body = response.body()
        if (response.isSuccessful && body != null) AppResult.Success(body.toParams())
        else error(response, "تعذر اعتماد عرض السعر")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun loadReceipts(
        orderId: String
    ): AppResult<Pair<List<PurchaseReceiptParams>, OrderReceiptProgressParams?>> = try {
        val response = api.getReceipts(orderId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(body.items.map { it.toParams() } to body.progress?.toParams())
        } else error(response, "تعذر تحميل سجل الاستلام")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun recordReceipt(
        orderId: String,
        draft: PurchaseReceiptDraft,
        idempotencyKey: String
    ): AppResult<PurchaseReceiptResult> = try {
        val response = api.createReceipt(
            orderId,
            idempotencyKey,
            CreatePurchaseReceiptDto(
                lines = draft.lines.map {
                    PurchaseReceiptLineInputDto(
                        it.purchaseOrderLineId,
                        it.quantity.trim(),
                        it.note?.trim()?.takeIf(String::isNotEmpty)
                    )
                },
                referenceNumber = draft.referenceNumber?.trim()?.takeIf(String::isNotEmpty),
                note = draft.note?.trim()?.takeIf(String::isNotEmpty),
                override = draft.override?.let {
                    PurchaseReceiptOverrideDto(reason = it.reason.trim(), confirmation = it.confirmation)
                }
            )
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            refreshPurchaseOrders(orderFilters)
            AppResult.Success(PurchaseReceiptResult(body.receipt.toParams(), body.progress?.toParams()))
        } else error(response, "تعذر تسجيل الاستلام")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun listReturns(orderId: String): AppResult<List<PurchaseReturnParams>> = try {
        val response = api.getReturns(orderId)
        val body = response.body()
        if (response.isSuccessful && body != null) AppResult.Success(body.items.map { it.toParams() })
        else error(response, "تعذر تحميل المرتجعات")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun createReturn(
        orderId: String,
        draft: PurchaseReturnDraft,
        idempotencyKey: String
    ): AppResult<PurchaseReturnParams> = try {
        val response = api.createReturn(
            orderId,
            idempotencyKey,
            CreatePurchaseReturnDto(
                reasonCode = draft.reasonCode,
                note = draft.note?.trim()?.takeIf(String::isNotEmpty),
                lines = draft.lines.map {
                    PurchaseReturnLineInputDto(
                        it.purchaseOrderLineId,
                        it.quantity.trim(),
                        it.note?.trim()?.takeIf(String::isNotEmpty)
                    )
                }
            )
        )
        val body = response.body()
        if (response.isSuccessful && body != null) AppResult.Success(body.toParams())
        else error(response, "تعذر تسجيل المرتجع")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun reviewReturn(
        returnId: String,
        action: String,
        note: String?,
        idempotencyKey: String
    ): AppResult<PurchaseReturnParams> = try {
        val response = api.reviewReturn(
            returnId,
            idempotencyKey,
            ReviewPurchaseReturnDto(action = action, note = note?.trim()?.takeIf(String::isNotEmpty))
        )
        val body = response.body()
        if (response.isSuccessful && body != null) AppResult.Success(body.toParams())
        else error(response, "تعذرت مراجعة المرتجع")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    private fun ResponseBody.readLimitedBytes(maxBytes: Int): ByteArray {
        val output = ByteArrayOutputStream()
        byteStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var total = 0
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                require(total <= maxBytes) { "حجم ملف التصدير يتجاوز الحد المسموح" }
                output.write(buffer, 0, read)
            }
        }
        return output.toByteArray()
    }

    private fun purchasingExportFilename(format: PurchasingExportFormat, disposition: String?): String {
        val pattern = Regex("filename\\*?=\\s*(?:UTF-8''|\")?([^\";]+)", RegexOption.IGNORE_CASE)
        val raw = disposition?.let { pattern.find(it)?.groupValues?.getOrNull(1) }?.trim()
        val safe = raw?.takeIf { Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$").matches(it) }
        return safe ?: "purchasing_export.${format.fileExtension}"
    }

    override suspend fun exportPurchasingReport(
        format: PurchasingExportFormat,
        locale: String
    ): AppResult<ReportExportPayload> = try {
        val response = api.exportPurchasing(PurchasingExportRequestDto(format.apiValue, locale))
        val body = response.body()
        if (!response.isSuccessful || body == null) {
            error(response, "تعذر تصدير تقرير المشتريات")
        } else if (body.contentLength() in 1..Long.MAX_VALUE && body.contentLength() > MAX_PURCHASING_EXPORT_BYTES) {
            AppResult.Error(
                Exception("حجم ملف التصدير يتجاوز الحد المسموح"),
                AppError.ValidationError("حجم ملف التصدير يتجاوز الحد المسموح")
            )
        } else {
            val bytes = body.readLimitedBytes(MAX_PURCHASING_EXPORT_BYTES)
            val filename = purchasingExportFilename(format, response.headers()["Content-Disposition"])
            AppResult.Success(ReportExportPayload(bytes, filename, format.mimeType))
        }
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }
}
