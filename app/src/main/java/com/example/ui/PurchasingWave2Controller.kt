package com.example.ui

import com.example.core.utils.AppResult
import com.example.core.utils.PurchasingQuantity
import com.example.domain.model.OrderReceiptProgressParams
import com.example.domain.model.PurchaseReceiptDraft
import com.example.domain.model.PurchaseReceiptParams
import com.example.domain.model.PurchaseReturnDraft
import com.example.domain.model.PurchaseReturnParams
import com.example.domain.model.PurchaseReturnReasons
import com.example.domain.model.QuotationComparisonParams
import com.example.domain.model.SupplierQuotationDraft
import com.example.domain.model.SupplierQuotationParams
import com.example.domain.repository.PurchaseRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/** Which Wave 2 mutation is currently in flight, so the UI can block a double submit. */
enum class PurchasingWave2Action {
    NONE,
    LOADING_QUOTATIONS,
    CREATING_QUOTATION,
    SUBMITTING_QUOTATION,
    SELECTING_QUOTATION,
    COMPARING_QUOTATIONS,
    LOADING_RECEIPTS,
    RECORDING_RECEIPT,
    CREATING_RETURN,
    REVIEWING_RETURN
}

data class PurchasingWave2UiState(
    val busy: PurchasingWave2Action = PurchasingWave2Action.NONE,
    val quotations: List<SupplierQuotationParams> = emptyList(),
    val comparison: QuotationComparisonParams? = null,
    val receipts: List<PurchaseReceiptParams> = emptyList(),
    val progress: OrderReceiptProgressParams? = null,
    val returns: List<PurchaseReturnParams> = emptyList(),
    val errorMessage: String? = null,
    val successMessage: String? = null
) {
    val isBusy: Boolean get() = busy != PurchasingWave2Action.NONE
}

/**
 * Commercial Wave 2 purchasing actions (Operations Slice E1).
 *
 * Rules this controller enforces on the client, all of which the backend
 * re-checks and remains authoritative for:
 *  - one mutation at a time, so a double tap cannot submit twice;
 *  - a fresh idempotency key per *deliberate* action (a retry of the same
 *    submission reuses the key, so the server replays instead of duplicating);
 *  - quantities are compared with exact integer milli-units, never Double;
 *  - an over-receipt is only ever sent with an explicit OVERRIDE confirmation
 *    and a reason.
 */
class PurchasingWave2Controller(
    private val repository: PurchaseRepository,
    private val scope: CoroutineScope
) {
    private val _state = MutableStateFlow(PurchasingWave2UiState())
    val state: StateFlow<PurchasingWave2UiState> = _state.asStateFlow()

    private val parentJob = scope.coroutineContext[Job]
    private var sessionJob = SupervisorJob(parentJob)
    private var sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
    private val epoch = AtomicLong(0L)

    /** Key for the submission currently being retried, cleared once it succeeds. */
    private var pendingReceiptKey: String? = null
    private var pendingReturnKey: String? = null
    private var pendingQuotationKey: String? = null

    fun reset() {
        epoch.incrementAndGet()
        sessionJob.cancel()
        sessionJob = SupervisorJob(parentJob)
        sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
        pendingReceiptKey = null
        pendingReturnKey = null
        pendingQuotationKey = null
        _state.value = PurchasingWave2UiState()
    }

    fun dismissFeedback() {
        _state.value = _state.value.copy(errorMessage = null, successMessage = null)
    }

    fun clearComparison() {
        _state.value = _state.value.copy(comparison = null)
    }

    private fun isCurrent(value: Long): Boolean = epoch.get() == value

    private fun newKey(prefix: String): String =
        "$prefix-${UUID.randomUUID()}".replace(Regex("[^A-Za-z0-9._:-]"), "-").take(120)

    private fun fail(message: String) {
        _state.value = _state.value.copy(busy = PurchasingWave2Action.NONE, errorMessage = message)
    }

    private fun errorText(error: AppResult.Error, fallback: String): String {
        val raw = error.exception.message.orEmpty()
        return raw.takeIf { it.isNotBlank() && it.any { ch -> ch in '؀'..'ۿ' } } ?: fallback
    }

    private inline fun <T> run(
        action: PurchasingWave2Action,
        crossinline call: suspend () -> AppResult<T>,
        crossinline onSuccess: (T) -> Unit,
        fallbackError: String
    ) {
        if (_state.value.isBusy) return
        val current = epoch.get()
        _state.value = _state.value.copy(busy = action, errorMessage = null, successMessage = null)
        sessionScope.launch {
            when (val result = call()) {
                is AppResult.Success -> if (isCurrent(current)) {
                    onSuccess(result.data)
                    _state.value = _state.value.copy(busy = PurchasingWave2Action.NONE)
                }
                is AppResult.Error -> if (isCurrent(current)) fail(errorText(result, fallbackError))
                AppResult.Loading -> Unit
            }
        }
    }

    fun loadQuotations(requestId: String) = run(
        PurchasingWave2Action.LOADING_QUOTATIONS,
        { repository.listQuotations(requestId) },
        { rows -> _state.value = _state.value.copy(quotations = rows) },
        "تعذر تحميل عروض الأسعار"
    )

    fun compareQuotations(requestId: String) = run(
        PurchasingWave2Action.COMPARING_QUOTATIONS,
        { repository.compareQuotations(requestId) },
        { comparison -> _state.value = _state.value.copy(comparison = comparison) },
        "تعذر تحميل مقارنة عروض الأسعار"
    )

    fun createQuotation(requestId: String, draft: SupplierQuotationDraft) {
        if (draft.lines.isEmpty()) {
            fail("اختر بندًا واحدًا على الأقل.")
            return
        }
        if (draft.lines.any { !PurchasingQuantity.isPositive(it.quantity) }) {
            fail("الكمية غير صالحة.")
            return
        }
        val key = pendingQuotationKey ?: newKey("quotation-create").also { pendingQuotationKey = it }
        run(
            PurchasingWave2Action.CREATING_QUOTATION,
            { repository.createQuotation(requestId, draft, key) },
            { quotation ->
                pendingQuotationKey = null
                _state.value = _state.value.copy(
                    quotations = _state.value.quotations.filterNot { it.id == quotation.id } + quotation,
                    successMessage = "تم تسجيل عرض السعر."
                )
            },
            "تعذر تسجيل عرض السعر"
        )
    }

    fun submitQuotation(quotationId: String) = run(
        PurchasingWave2Action.SUBMITTING_QUOTATION,
        { repository.submitQuotation(quotationId) },
        { quotation ->
            _state.value = _state.value.copy(
                quotations = _state.value.quotations.map { if (it.id == quotation.id) quotation else it }
            )
        },
        "تعذر ترحيل عرض السعر"
    )

    /** Awarding always carries a reason; the backend records it as a human decision. */
    fun selectQuotation(quotationId: String, reason: String) {
        val trimmed = reason.trim()
        if (trimmed.isEmpty()) {
            fail("سبب الاعتماد مطلوب.")
            return
        }
        val key = newKey("quotation-select")
        run(
            PurchasingWave2Action.SELECTING_QUOTATION,
            { repository.selectQuotation(quotationId, trimmed, key) },
            { quotation ->
                _state.value = _state.value.copy(
                    quotations = _state.value.quotations.map { if (it.id == quotation.id) quotation else it },
                    successMessage = "تم اعتماد عرض السعر."
                )
            },
            "تعذر اعتماد عرض السعر"
        )
    }

    fun loadReceipts(orderId: String) = run(
        PurchasingWave2Action.LOADING_RECEIPTS,
        { repository.loadReceipts(orderId) },
        { (rows, progress) -> _state.value = _state.value.copy(receipts = rows, progress = progress) },
        "تعذر تحميل سجل الاستلام"
    )

    /**
     * Records a partial receipt. `canOverride` reflects purchasing.admin_override;
     * without it the client refuses to send an over-receipt at all rather than
     * letting the user discover the 403 after typing a reason.
     */
    fun recordReceipt(
        orderId: String,
        lines: List<Pair<String, String>>,
        referenceNumber: String?,
        note: String?,
        overrideReason: String?,
        overrideConfirmation: String?,
        canOverride: Boolean
    ) {
        if (lines.isEmpty()) {
            fail("اختر بندًا واحدًا على الأقل.")
            return
        }
        if (lines.any { !PurchasingQuantity.isPositive(it.second) }) {
            fail("الكمية غير صالحة.")
            return
        }
        val progress = _state.value.progress
        val needsOverride = progress != null && lines.any { (lineId, quantity) ->
            val position = progress.lines.find { it.purchaseOrderLineId == lineId }
            position != null && PurchasingQuantity.exceeds(quantity, position.remainingQuantity)
        }
        if (needsOverride && !canOverride) {
            fail("الكمية تتجاوز المتبقي، ولا تملك صلاحية التجاوز.")
            return
        }
        if (needsOverride && (overrideConfirmation != "OVERRIDE" || overrideReason.isNullOrBlank())) {
            fail("يتطلب التجاوز تأكيد OVERRIDE وسببًا موثقًا.")
            return
        }
        val key = pendingReceiptKey ?: newKey("receipt").also { pendingReceiptKey = it }
        run(
            PurchasingWave2Action.RECORDING_RECEIPT,
            {
                repository.recordReceipt(
                    orderId,
                    PurchaseReceiptDraft(
                        lines = lines.map { (lineId, quantity) ->
                            com.example.domain.model.PurchaseReceiptLineInput(lineId, quantity)
                        },
                        referenceNumber = referenceNumber,
                        note = note,
                        override = if (needsOverride) {
                            com.example.domain.model.PurchaseReceiptOverride(reason = overrideReason.orEmpty())
                        } else null
                    ),
                    key
                )
            },
            { result ->
                pendingReceiptKey = null
                _state.value = _state.value.copy(
                    receipts = _state.value.receipts.filterNot { it.id == result.receipt.id } + result.receipt,
                    progress = result.progress ?: _state.value.progress,
                    successMessage = "تم تسجيل الاستلام."
                )
            },
            "تعذر تسجيل الاستلام"
        )
    }

    fun loadReturns(orderId: String) = run(
        PurchasingWave2Action.LOADING_RECEIPTS,
        { repository.listReturns(orderId) },
        { rows -> _state.value = _state.value.copy(returns = rows) },
        "تعذر تحميل المرتجعات"
    )

    fun createReturn(orderId: String, reasonCode: String, note: String?, lines: List<Pair<String, String>>) {
        if (reasonCode !in PurchaseReturnReasons.all) {
            fail("سبب الإرجاع غير صالح.")
            return
        }
        if (lines.isEmpty()) {
            fail("اختر بندًا واحدًا على الأقل.")
            return
        }
        if (lines.any { !PurchasingQuantity.isPositive(it.second) }) {
            fail("الكمية غير صالحة.")
            return
        }
        val progress = _state.value.progress
        if (progress != null && lines.any { (lineId, quantity) ->
                val position = progress.lines.find { it.purchaseOrderLineId == lineId }
                position != null && PurchasingQuantity.exceeds(quantity, position.netReceivedQuantity)
            }
        ) {
            fail("الكمية المرتجعة تتجاوز الكمية المستلمة.")
            return
        }
        val key = pendingReturnKey ?: newKey("return-create").also { pendingReturnKey = it }
        run(
            PurchasingWave2Action.CREATING_RETURN,
            {
                repository.createReturn(
                    orderId,
                    PurchaseReturnDraft(
                        reasonCode = reasonCode,
                        note = note,
                        lines = lines.map { (lineId, quantity) ->
                            com.example.domain.model.PurchaseReturnLineInput(lineId, quantity)
                        }
                    ),
                    key
                )
            },
            { row ->
                pendingReturnKey = null
                _state.value = _state.value.copy(
                    returns = _state.value.returns.filterNot { it.id == row.id } + row,
                    successMessage = "تم تسجيل المرتجع."
                )
            },
            "تعذر تسجيل المرتجع"
        )
    }

    fun reviewReturn(returnId: String, action: String, note: String?) {
        val key = newKey("return-review")
        run(
            PurchasingWave2Action.REVIEWING_RETURN,
            { repository.reviewReturn(returnId, action, note, key) },
            { row ->
                _state.value = _state.value.copy(
                    returns = _state.value.returns.map { if (it.id == row.id) row else it },
                    successMessage = if (action == "approve") "تم اعتماد المرتجع." else "تم رفض المرتجع."
                )
            },
            "تعذرت مراجعة المرتجع"
        )
    }
}
