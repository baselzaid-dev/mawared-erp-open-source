package com.example.ui

import com.example.core.permissions.Permissions
import com.example.core.utils.AppResult
import com.example.domain.model.AttendanceExemption
import com.example.domain.model.AttendanceExemptionCreateRequest
import com.example.domain.model.AttendanceExemptionReasonCategory
import com.example.domain.model.AttendanceExemptionRevokeRequest
import com.example.domain.model.AttendanceExemptionStatus
import com.example.domain.model.AttendanceExemptionStatusFilter
import com.example.domain.model.AttendanceExemptionTarget
import com.example.domain.repository.AttendanceExemptionRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

sealed interface AttendanceExemptionListState {
    data object Loading : AttendanceExemptionListState

    data class Content(
        val items: List<AttendanceExemption>,
        val statusFilter: AttendanceExemptionStatusFilter
    ) : AttendanceExemptionListState

    data object Empty : AttendanceExemptionListState

    data class Error(val message: String) : AttendanceExemptionListState
}

data class AttendanceExemptionScreenState(
    val canManage: Boolean = false,
    val canView: Boolean = true,
    val listState: AttendanceExemptionListState = AttendanceExemptionListState.Loading,
    val isSubmitting: Boolean = false,
    val successMessage: String? = null,
    val actionErrorMessage: String? = null,
    val eligibleTargets: List<AttendanceExemptionTarget> = emptyList(),
    val showCreateDialog: Boolean = false,
    val revokingExemption: AttendanceExemption? = null
)

interface AttendanceExemptionActions {
    fun onRetry()
    fun onRefresh()
    fun onStatusFilterSelected(filter: AttendanceExemptionStatusFilter)
    fun onOpenCreateDialog()
    fun onDismissCreateDialog()
    fun onCreateExemption(
        targetUserId: String,
        validFrom: String,
        validUntil: String?,
        reasonCategory: AttendanceExemptionReasonCategory,
        note: String?
    )
    fun onOpenRevokeDialog(exemption: AttendanceExemption)
    fun onDismissRevokeDialog()
    fun onRevokeExemption(reason: String)
    fun clearMessages()
}

/**
 * State machine for attendance exemption list/create/revoke wiring.
 * Keeps loading/empty/error/retry transitions testable without MawaredViewModel.
 */
class AttendanceExemptionController(
    private val repository: AttendanceExemptionRepository,
    private val scope: CoroutineScope,
    private var permissionsProvider: () -> Set<String> = { emptySet() }
) : AttendanceExemptionActions {

    private val _state = MutableStateFlow(AttendanceExemptionScreenState())
    val state: StateFlow<AttendanceExemptionScreenState> = _state.asStateFlow()

    private val parentJob = scope.coroutineContext[Job]
    private var sessionJob = SupervisorJob(parentJob)
    private var sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)

    private var cachedItems: List<AttendanceExemption> = emptyList()
    private var statusFilter: AttendanceExemptionStatusFilter = AttendanceExemptionStatusFilter.ALL
    private var hasLoadedOnce = false
    private val lifecycleEpoch = AtomicLong(0L)
    private val refreshGeneration = AtomicLong(0L)

    fun reset() {
        lifecycleEpoch.incrementAndGet()
        refreshGeneration.incrementAndGet()
        sessionJob.cancel()
        sessionJob = SupervisorJob(parentJob)
        sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
        cachedItems = emptyList()
        statusFilter = AttendanceExemptionStatusFilter.ALL
        hasLoadedOnce = false
        _state.value = AttendanceExemptionScreenState(
            canManage = canManageExemptions(),
            canView = true,
            listState = AttendanceExemptionListState.Loading
        )
    }

    fun updatePermissions(permissions: Set<String>) {
        permissionsProvider = { permissions }
        _state.update {
            it.copy(canManage = hasManagePermission(permissions))
        }
    }

    fun setEligibleTargets(targets: List<AttendanceExemptionTarget>) {
        _state.update { it.copy(eligibleTargets = targets) }
    }

    fun load() {
        refreshPermissions()
        startRefresh(lifecycleEpoch.get())
    }

    override fun onRetry() {
        startRefresh(lifecycleEpoch.get())
    }

    override fun onRefresh() {
        refreshPermissions()
        startRefresh(lifecycleEpoch.get())
    }

    override fun onStatusFilterSelected(filter: AttendanceExemptionStatusFilter) {
        statusFilter = filter
        publishListState()
    }

    override fun onOpenCreateDialog() {
        if (!_state.value.canManage) return
        _state.update {
            it.copy(showCreateDialog = true, actionErrorMessage = null, successMessage = null)
        }
    }

    override fun onDismissCreateDialog() {
        _state.update { it.copy(showCreateDialog = false) }
    }

    override fun onCreateExemption(
        targetUserId: String,
        validFrom: String,
        validUntil: String?,
        reasonCategory: AttendanceExemptionReasonCategory,
        note: String?
    ) {
        if (!_state.value.canManage || _state.value.isSubmitting) return
        val epoch = lifecycleEpoch.get()
        _state.update {
            it.copy(isSubmitting = true, actionErrorMessage = null, successMessage = null)
        }
        sessionScope.launch {
            when (
                val result = repository.createExemption(
                    AttendanceExemptionCreateRequest(
                        targetUserId = targetUserId,
                        validFrom = validFrom,
                        validUntil = validUntil?.takeIf { it.isNotBlank() },
                        reasonCategory = reasonCategory,
                        note = note?.trim()?.takeIf { it.isNotBlank() }
                    )
                )
            ) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    cachedItems = listOf(result.data) + cachedItems.filterNot { it.id == result.data.id }
                    _state.update {
                        it.copy(
                            isSubmitting = false,
                            showCreateDialog = false,
                            successMessage = "تم إنشاء إعفاء الحضور بنجاح.",
                            actionErrorMessage = null
                        )
                    }
                    publishListState()
                }
                is AppResult.Error -> {
                    if (!isCurrent(epoch)) return@launch
                    _state.update {
                        it.copy(
                            isSubmitting = false,
                            actionErrorMessage = errorText(result),
                            successMessage = null
                        )
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    override fun onOpenRevokeDialog(exemption: AttendanceExemption) {
        if (!_state.value.canManage || exemption.status != AttendanceExemptionStatus.ACTIVE) return
        _state.update {
            it.copy(revokingExemption = exemption, actionErrorMessage = null, successMessage = null)
        }
    }

    override fun onDismissRevokeDialog() {
        _state.update { it.copy(revokingExemption = null) }
    }

    override fun onRevokeExemption(reason: String) {
        val exemption = _state.value.revokingExemption ?: return
        if (!_state.value.canManage || _state.value.isSubmitting) return
        val trimmedReason = reason.trim()
        if (trimmedReason.length < 3) {
            _state.update { it.copy(actionErrorMessage = "سبب الإلغاء يجب أن يكون 3 أحرف على الأقل.") }
            return
        }

        val epoch = lifecycleEpoch.get()
        _state.update {
            it.copy(isSubmitting = true, actionErrorMessage = null, successMessage = null)
        }
        sessionScope.launch {
            when (
                val result = repository.revokeExemption(
                    exemption.id,
                    AttendanceExemptionRevokeRequest(
                        reason = trimmedReason,
                        expectedVersion = exemption.version
                    )
                )
            ) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    cachedItems = cachedItems.map { item ->
                        if (item.id == result.data.id) result.data else item
                    }
                    _state.update {
                        it.copy(
                            isSubmitting = false,
                            revokingExemption = null,
                            successMessage = "تم إلغاء إعفاء الحضور بنجاح.",
                            actionErrorMessage = null
                        )
                    }
                    publishListState()
                }
                is AppResult.Error -> {
                    if (!isCurrent(epoch)) return@launch
                    _state.update {
                        it.copy(
                            isSubmitting = false,
                            actionErrorMessage = errorText(result),
                            successMessage = null
                        )
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    override fun clearMessages() {
        _state.update { it.copy(successMessage = null, actionErrorMessage = null) }
    }

    private fun refreshPermissions() {
        _state.update { it.copy(canManage = canManageExemptions(), canView = true) }
    }

    private fun canManageExemptions(): Boolean = hasManagePermission(permissionsProvider())

    private fun hasManagePermission(permissions: Set<String>): Boolean =
        Permissions.ADMIN_FULL in permissions ||
            Permissions.EMPLOYEES_ATTENDANCE_EXEMPTION_MANAGE in permissions

    private fun startRefresh(epoch: Long) {
        if (!isCurrent(epoch)) return
        val generation = refreshGeneration.incrementAndGet()
        if (!hasLoadedOnce) {
            _state.update {
                it.copy(listState = AttendanceExemptionListState.Loading, actionErrorMessage = null)
            }
        }
        sessionScope.launch {
            if (!isCurrentRefresh(epoch, generation)) return@launch
            when (val result = repository.listExemptions(status = statusFilter.apiValue)) {
                is AppResult.Success -> {
                    if (!isCurrentRefresh(epoch, generation)) return@launch
                    cachedItems = result.data.items
                    hasLoadedOnce = true
                    publishListState()
                }
                is AppResult.Error -> {
                    if (!isCurrentRefresh(epoch, generation)) return@launch
                    _state.update {
                        it.copy(listState = AttendanceExemptionListState.Error(errorText(result)))
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    private fun publishListState() {
        val filtered = filterItems(cachedItems, statusFilter)
        val listState = when {
            cachedItems.isEmpty() && statusFilter == AttendanceExemptionStatusFilter.ALL ->
                AttendanceExemptionListState.Empty
            filtered.isEmpty() ->
                AttendanceExemptionListState.Content(emptyList(), statusFilter)
            else ->
                AttendanceExemptionListState.Content(filtered, statusFilter)
        }
        _state.update { it.copy(listState = listState) }
    }

    private fun filterItems(
        items: List<AttendanceExemption>,
        filter: AttendanceExemptionStatusFilter
    ): List<AttendanceExemption> = when (filter.apiValue) {
        null -> items
        else -> items.filter { it.status.apiValue == filter.apiValue }
    }

    private fun isCurrent(epoch: Long): Boolean = lifecycleEpoch.get() == epoch

    private fun isCurrentRefresh(epoch: Long, generation: Long): Boolean =
        isCurrent(epoch) && refreshGeneration.get() == generation

    private fun errorText(error: AppResult.Error): String {
        val raw = error.exception.message.orEmpty()
        return when (raw) {
            "attendance.unauthorized" -> "يلزم تسجيل الدخول مجددًا."
            "attendance.forbidden" -> "لا تملك صلاحية إدارة إعفاءات الحضور."
            "attendance.not_found" -> "إعفاء الحضور غير متاح."
            "attendance.invalid_request" -> "طلب غير صالح. حدّث الشاشة ثم أعد المحاولة."
            "attendance.exemption_overlap" -> "يوجد إعفاء نشط يتداخل مع هذه الفترة."
            "attendance.exemption_self_forbidden" -> "لا يمكن منح إعفاء لحسابك."
            "attendance.version_mismatch" -> "تغيّرت البيانات منذ فتح الشاشة. حدّث القائمة ثم أعد المحاولة."
            "attendance.concurrent_conflict" -> "تعارض متزامن. حدّث القائمة ثم أعد المحاولة."
            "attendance.idempotency_key_required" -> "مفتاح الطلب مفقود. أعد المحاولة."
            else -> raw.takeIf { it.isNotBlank() }
                ?: "تعذر إكمال العملية. تحقق من الاتصال وأعد المحاولة."
        }
    }
}
