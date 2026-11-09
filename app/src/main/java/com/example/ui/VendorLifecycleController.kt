package com.example.ui

import com.example.core.utils.AppResult
import com.example.domain.model.Supplier
import com.example.domain.model.VendorArchiveRequest
import com.example.domain.model.VendorLifecycleRules
import com.example.domain.model.VendorReactivateRequest
import com.example.domain.model.isArchived
import com.example.domain.repository.SupplierRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

enum class VendorLifecycleActionKind {
    ARCHIVE,
    REACTIVATE
}

sealed interface VendorLifecycleUiState {
    data object Idle : VendorLifecycleUiState

    data class Submitting(
        val vendorId: String,
        val kind: VendorLifecycleActionKind
    ) : VendorLifecycleUiState

    data class SuccessMessage(
        val vendorId: String,
        val message: String
    ) : VendorLifecycleUiState

    data class Error(
        val vendorId: String,
        val kind: VendorLifecycleActionKind,
        val message: String
    ) : VendorLifecycleUiState
}

/**
 * Vendor archive/reactivate actions (Sprint 12I, M08).
 *
 * Success is reported only after the backend returns [AppResult.Success]. Both
 * actions always re-fetch the authoritative lifecycle record first (the plain
 * vendor list never carries `lifecycleVersion`) so `expectedVersion` reflects
 * the true server state instead of a stale Android-side default.
 */
class VendorLifecycleController(
    private val repository: SupplierRepository,
    private val scope: CoroutineScope,
    private val onMutated: suspend () -> Unit = {}
) {
    private val _state = MutableStateFlow<VendorLifecycleUiState>(VendorLifecycleUiState.Idle)
    val state: StateFlow<VendorLifecycleUiState> = _state.asStateFlow()

    private val parentJob = scope.coroutineContext[Job]
    private var sessionJob = SupervisorJob(parentJob)
    private var sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
    private val lifecycleEpoch = AtomicLong(0L)

    fun reset() {
        lifecycleEpoch.incrementAndGet()
        sessionJob.cancel()
        sessionJob = SupervisorJob(parentJob)
        sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
        _state.value = VendorLifecycleUiState.Idle
    }

    fun dismissFeedback() {
        _state.value = VendorLifecycleUiState.Idle
    }

    fun archiveVendor(vendor: Supplier, reason: String, hasArchivePermission: Boolean) {
        if (!VendorLifecycleRules.canArchive(vendor, hasArchivePermission)) {
            _state.value = VendorLifecycleUiState.Error(
                vendorId = vendor.id,
                kind = VendorLifecycleActionKind.ARCHIVE,
                message = "لا تملك صلاحية أرشفة هذا المورد."
            )
            return
        }
        val trimmedReason = reason.trim()
        if (trimmedReason.isEmpty()) {
            _state.value = VendorLifecycleUiState.Error(
                vendorId = vendor.id,
                kind = VendorLifecycleActionKind.ARCHIVE,
                message = "سبب الأرشفة مطلوب."
            )
            return
        }
        val epoch = lifecycleEpoch.get()
        _state.value = VendorLifecycleUiState.Submitting(vendor.id, VendorLifecycleActionKind.ARCHIVE)
        sessionScope.launch {
            when (val lifecycleResult = repository.loadSupplierLifecycle(vendor.id)) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    val fresh = lifecycleResult.data
                    if (fresh.isArchived) {
                        onMutated()
                        if (isCurrent(epoch)) {
                            _state.value = VendorLifecycleUiState.Error(
                                vendorId = vendor.id,
                                kind = VendorLifecycleActionKind.ARCHIVE,
                                message = "المورد مؤرشف بالفعل."
                            )
                        }
                        return@launch
                    }
                    when (
                        val result = repository.archiveSupplier(
                            vendor.id,
                            VendorArchiveRequest(reason = trimmedReason, expectedVersion = fresh.lifecycleVersion)
                        )
                    ) {
                        is AppResult.Success -> {
                            if (!isCurrent(epoch)) return@launch
                            onMutated()
                            if (!isCurrent(epoch)) return@launch
                            _state.value = VendorLifecycleUiState.SuccessMessage(
                                vendorId = vendor.id,
                                message = "تمت أرشفة المورد ${vendor.name} بنجاح."
                            )
                        }
                        is AppResult.Error -> if (isCurrent(epoch)) {
                            _state.value = VendorLifecycleUiState.Error(
                                vendorId = vendor.id,
                                kind = VendorLifecycleActionKind.ARCHIVE,
                                message = errorText(result, "تعذر أرشفة المورد.")
                            )
                        }
                        AppResult.Loading -> Unit
                    }
                }
                is AppResult.Error -> if (isCurrent(epoch)) {
                    _state.value = VendorLifecycleUiState.Error(
                        vendorId = vendor.id,
                        kind = VendorLifecycleActionKind.ARCHIVE,
                        message = errorText(lifecycleResult, "تعذر تحميل بيانات المورد.")
                    )
                }
                AppResult.Loading -> Unit
            }
        }
    }

    fun reactivateVendor(vendor: Supplier, reason: String?, hasArchivePermission: Boolean) {
        if (!VendorLifecycleRules.canReactivate(vendor, hasArchivePermission)) {
            _state.value = VendorLifecycleUiState.Error(
                vendorId = vendor.id,
                kind = VendorLifecycleActionKind.REACTIVATE,
                message = "لا تملك صلاحية إعادة تفعيل هذا المورد."
            )
            return
        }
        val trimmedReason = reason?.trim()?.ifEmpty { null }
        val epoch = lifecycleEpoch.get()
        _state.value = VendorLifecycleUiState.Submitting(vendor.id, VendorLifecycleActionKind.REACTIVATE)
        sessionScope.launch {
            when (val lifecycleResult = repository.loadSupplierLifecycle(vendor.id)) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    val fresh = lifecycleResult.data
                    if (!fresh.isArchived) {
                        onMutated()
                        if (isCurrent(epoch)) {
                            _state.value = VendorLifecycleUiState.Error(
                                vendorId = vendor.id,
                                kind = VendorLifecycleActionKind.REACTIVATE,
                                message = "المورد غير مؤرشف."
                            )
                        }
                        return@launch
                    }
                    when (
                        val result = repository.reactivateSupplier(
                            vendor.id,
                            VendorReactivateRequest(expectedVersion = fresh.lifecycleVersion, reason = trimmedReason)
                        )
                    ) {
                        is AppResult.Success -> {
                            if (!isCurrent(epoch)) return@launch
                            onMutated()
                            if (!isCurrent(epoch)) return@launch
                            _state.value = VendorLifecycleUiState.SuccessMessage(
                                vendorId = vendor.id,
                                message = "تمت إعادة تفعيل المورد ${vendor.name} بنجاح."
                            )
                        }
                        is AppResult.Error -> if (isCurrent(epoch)) {
                            _state.value = VendorLifecycleUiState.Error(
                                vendorId = vendor.id,
                                kind = VendorLifecycleActionKind.REACTIVATE,
                                message = errorText(result, "تعذر إعادة تفعيل المورد.")
                            )
                        }
                        AppResult.Loading -> Unit
                    }
                }
                is AppResult.Error -> if (isCurrent(epoch)) {
                    _state.value = VendorLifecycleUiState.Error(
                        vendorId = vendor.id,
                        kind = VendorLifecycleActionKind.REACTIVATE,
                        message = errorText(lifecycleResult, "تعذر تحميل بيانات المورد.")
                    )
                }
                AppResult.Loading -> Unit
            }
        }
    }

    private fun isCurrent(epoch: Long): Boolean = lifecycleEpoch.get() == epoch

    private fun errorText(error: AppResult.Error, fallback: String): String {
        val raw = error.exception.message.orEmpty()
        return when (raw) {
            "VENDOR_NOT_FOUND" -> "المورد غير موجود أو خارج نطاق صلاحيتك."
            "VENDOR_ALREADY_ARCHIVED" -> "المورد مؤرشف بالفعل."
            "VENDOR_NOT_ARCHIVED" -> "المورد غير مؤرشف."
            "VENDOR_VERSION_MISMATCH" -> "تغيّرت بيانات المورد. حدّث القائمة ثم أعد المحاولة."
            "VENDOR_NAME_DUPLICATE" -> "لا يمكن إعادة تفعيل المورد لوجود مورد نشط بالاسم نفسه."
            "VALIDATION_ERROR" -> "البيانات المدخلة غير صالحة."
            "Forbidden" -> "لا تملك صلاحية تنفيذ هذه العملية على المورد."
            else -> raw.takeIf { it.isNotBlank() && it.any { ch -> ch in '\u0600'..'\u06ff' } }
                ?: fallback
        }
    }
}
