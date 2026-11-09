package com.example.ui

import com.example.core.permissions.PermissionChecker
import com.example.core.permissions.Permissions
import com.example.core.utils.AppResult
import com.example.domain.model.AttendanceCorrection
import com.example.domain.model.AttendanceCorrectionCreateRequest
import com.example.domain.model.AttendanceCorrectionDecision
import com.example.domain.model.AttendanceCorrectionDecisionRequest
import com.example.domain.model.AttendanceCorrectionStatus
import com.example.domain.repository.AttendanceCorrectionRepository
import com.example.ui.navigation.NavigationCoordinator
import com.example.ui.navigation.ResourceDescriptor
import com.example.ui.navigation.TypedDestination
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

/**
 * Proposed allowlist entries for coordinator wiring (not yet in [ResourceDescriptor]):
 * - `attendance.corrections` + resourceType `attendance` + optional filterJson `{"status":"pending"}`
 * - `attendance_correction.detail` + resourceType `attendance` + resourceId = correction id
 */
object AttendanceCorrectionDestinations {
    fun correctionsQueueDescriptor(status: AttendanceCorrectionStatus? = null): ResourceDescriptor {
        val filterJson = status?.let { """{"status":"${AttendanceCorrectionStatus.toApiFilter(it)}"}""" }
        return ResourceDescriptor.parse(
            routeKey = "attendance.list",
            resourceType = "attendance",
            filterJson = filterJson
        )
    }

    fun correctionDetailDescriptor(correctionId: String): ResourceDescriptor =
        ResourceDescriptor.parse(
            routeKey = "attendance_correction.detail",
            resourceType = "attendance",
            resourceId = correctionId
        )

    fun attendanceTodayDescriptor(): ResourceDescriptor =
        ResourceDescriptor.parse(
            routeKey = "attendance.today",
            resourceType = "attendance"
        )

    fun typedQueueDestination(status: AttendanceCorrectionStatus? = null): TypedDestination =
        NavigationCoordinator.resolveDestination(correctionsQueueDescriptor(status))

    fun typedDetailDestination(correctionId: String): TypedDestination =
        NavigationCoordinator.resolveDestination(correctionDetailDescriptor(correctionId))
}

object AttendanceCorrectionRules {
    fun canReviewCorrections(permissions: Set<String>): Boolean =
        PermissionChecker(permissions).hasPermission(Permissions.ATTENDANCE_REVIEW_CORRECTION)

    fun canDecide(
        correction: AttendanceCorrection,
        currentUserId: String?,
        permissions: Set<String>
    ): Boolean = canReviewCorrections(permissions) &&
        correction.status == AttendanceCorrectionStatus.PENDING &&
        !currentUserId.isNullOrBlank() &&
        correction.requestedByUserId != currentUserId

    fun canSubmitForOthers(permissions: Set<String>): Boolean =
        PermissionChecker(permissions).hasPermission(Permissions.ATTENDANCE_MANAGE_MANUAL)
}

sealed interface AttendanceCorrectionUiState {
    data object Loading : AttendanceCorrectionUiState

    data class Content(
        val items: List<AttendanceCorrection>,
        val selectedStatus: AttendanceCorrectionStatus?,
        val hasMore: Boolean,
        val isLoadingMore: Boolean = false,
        val actionCorrectionId: String? = null,
        val canReview: Boolean = false
    ) : AttendanceCorrectionUiState

    data object Empty : AttendanceCorrectionUiState

    data class Error(val message: String) : AttendanceCorrectionUiState
}

interface AttendanceCorrectionActions {
    fun onRetry()
    fun onStatusSelected(status: AttendanceCorrectionStatus?)
    fun onLoadMore()
    fun onSubmitCorrection(
        attendanceId: String,
        expectedAttendanceVersion: Int,
        clockIn: String?,
        clockOut: String?,
        reason: String
    )
    fun onAccept(correctionId: String, expectedVersion: Int, reason: String)
    fun onReject(correctionId: String, expectedVersion: Int, reason: String)
    fun onDismissFeedback()
    fun onCorrectionClick(correctionId: String)
}

data class AttendanceCorrectionFeedback(
    val successMessage: String? = null,
    val errorMessage: String? = null
)

/**
 * List/submit/review state machine for attendance corrections.
 * Mutations refresh from the server — no optimistic success.
 */
class AttendanceCorrectionController(
    private val repository: AttendanceCorrectionRepository,
    private val scope: CoroutineScope,
    private val permissionsProvider: () -> Set<String> = { emptySet() },
    private val currentUserIdProvider: () -> String? = { null },
    private val onNavigate: (ResourceDescriptor?) -> Unit = {}
) : AttendanceCorrectionActions {
    private val _state = MutableStateFlow<AttendanceCorrectionUiState>(AttendanceCorrectionUiState.Loading)
    val state: StateFlow<AttendanceCorrectionUiState> = _state.asStateFlow()

    private val _feedback = MutableStateFlow(AttendanceCorrectionFeedback())
    val feedback: StateFlow<AttendanceCorrectionFeedback> = _feedback.asStateFlow()

    private val parentJob = scope.coroutineContext[Job]
    private var sessionJob = SupervisorJob(parentJob)
    private var sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)

    private var selectedStatus: AttendanceCorrectionStatus? = null
    private var cachedItems: List<AttendanceCorrection> = emptyList()
    private var nextCursor: String? = null
    private var hasMore = false
    private var hasLoadedOnce = false
    private val lifecycleEpoch = AtomicLong(0L)
    private val refreshGeneration = AtomicLong(0L)

    fun reset() {
        lifecycleEpoch.incrementAndGet()
        refreshGeneration.incrementAndGet()
        sessionJob.cancel()
        sessionJob = SupervisorJob(parentJob)
        sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
        selectedStatus = null
        cachedItems = emptyList()
        nextCursor = null
        hasMore = false
        hasLoadedOnce = false
        _state.value = AttendanceCorrectionUiState.Loading
        _feedback.value = AttendanceCorrectionFeedback()
    }

    fun load() {
        refresh()
    }

    override fun onRetry() {
        refresh()
    }

    override fun onStatusSelected(status: AttendanceCorrectionStatus?) {
        selectedStatus = status
        cachedItems = emptyList()
        nextCursor = null
        hasMore = false
        refresh()
    }

    override fun onLoadMore() {
        if (!hasMore || nextCursor == null) return
        val epoch = lifecycleEpoch.get()
        val generation = refreshGeneration.get()
        updateContentIfCurrent(epoch) { it.copy(isLoadingMore = true) }
        sessionScope.launch {
            when (
                val result = repository.listCorrections(
                    status = AttendanceCorrectionStatus.toApiFilter(selectedStatus),
                    cursor = nextCursor,
                    limit = PAGE_SIZE
                )
            ) {
                is AppResult.Success -> {
                    if (!isCurrentRefresh(epoch, generation)) return@launch
                    cachedItems = cachedItems + result.data.items
                    nextCursor = result.data.nextCursor
                    hasMore = result.data.hasMore
                    publishContentState(epoch)
                }
                is AppResult.Error -> {
                    if (isCurrent(epoch)) {
                        _feedback.value = AttendanceCorrectionFeedback(errorMessage = errorText(result))
                        updateContentIfCurrent(epoch) { it.copy(isLoadingMore = false) }
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    override fun onSubmitCorrection(
        attendanceId: String,
        expectedAttendanceVersion: Int,
        clockIn: String?,
        clockOut: String?,
        reason: String
    ) {
        val trimmedReason = reason.trim()
        if (trimmedReason.length < 3) {
            _feedback.value = AttendanceCorrectionFeedback(
                errorMessage = "سبب التصحيح يجب أن يكون 3 أحرف على الأقل."
            )
            return
        }
        if (clockIn.isNullOrBlank() && clockOut.isNullOrBlank()) {
            _feedback.value = AttendanceCorrectionFeedback(
                errorMessage = "أدخل وقت حضور أو انصراف واحد على الأقل."
            )
            return
        }
        val epoch = lifecycleEpoch.get()
        sessionScope.launch {
            when (
                val result = repository.createCorrection(
                    attendanceId,
                    AttendanceCorrectionCreateRequest(
                        clockIn = clockIn?.trim()?.takeIf { it.isNotEmpty() },
                        clockOut = clockOut?.trim()?.takeIf { it.isNotEmpty() },
                        reason = trimmedReason,
                        expectedAttendanceVersion = expectedAttendanceVersion
                    )
                )
            ) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    _feedback.value = AttendanceCorrectionFeedback(
                        successMessage = "تم إرسال طلب التصحيح للمراجعة."
                    )
                    refreshAfterMutation(epoch)
                }
                is AppResult.Error -> {
                    if (isCurrent(epoch)) {
                        _feedback.value = AttendanceCorrectionFeedback(errorMessage = errorText(result))
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    override fun onAccept(correctionId: String, expectedVersion: Int, reason: String) {
        decide(
            correctionId = correctionId,
            expectedVersion = expectedVersion,
            reason = reason,
            decision = AttendanceCorrectionDecision.ACCEPT,
            successMessage = "تم قبول طلب التصحيح."
        )
    }

    override fun onReject(correctionId: String, expectedVersion: Int, reason: String) {
        decide(
            correctionId = correctionId,
            expectedVersion = expectedVersion,
            reason = reason,
            decision = AttendanceCorrectionDecision.REJECT,
            successMessage = "تم رفض طلب التصحيح."
        )
    }

    override fun onDismissFeedback() {
        _feedback.value = AttendanceCorrectionFeedback()
    }

    override fun onCorrectionClick(correctionId: String) {
        onNavigate(AttendanceCorrectionDestinations.correctionDetailDescriptor(correctionId))
    }

    private fun decide(
        correctionId: String,
        expectedVersion: Int,
        reason: String,
        decision: AttendanceCorrectionDecision,
        successMessage: String
    ) {
        val trimmedReason = reason.trim()
        if (trimmedReason.length < 3) {
            _feedback.value = AttendanceCorrectionFeedback(
                errorMessage = "سبب القرار يجب أن يكون 3 أحرف على الأقل."
            )
            return
        }
        val item = cachedItems.firstOrNull { it.id == correctionId }
        if (item != null && !AttendanceCorrectionRules.canDecide(
                item,
                currentUserIdProvider(),
                permissionsProvider()
            )
        ) {
            _feedback.value = AttendanceCorrectionFeedback(
                errorMessage = "لا تملك صلاحية مراجعة هذا الطلب."
            )
            return
        }
        val epoch = lifecycleEpoch.get()
        updateContentIfCurrent(epoch) { it.copy(actionCorrectionId = correctionId) }
        sessionScope.launch {
            when (
                val result = repository.decideCorrection(
                    correctionId,
                    AttendanceCorrectionDecisionRequest(
                        decision = decision,
                        reason = trimmedReason,
                        expectedVersion = expectedVersion
                    )
                )
            ) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    _feedback.value = AttendanceCorrectionFeedback(successMessage = successMessage)
                    refreshAfterMutation(epoch)
                }
                is AppResult.Error -> {
                    if (isCurrent(epoch)) {
                        _feedback.value = AttendanceCorrectionFeedback(errorMessage = errorText(result))
                        updateContentIfCurrent(epoch) { it.copy(actionCorrectionId = null) }
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    private fun refresh() {
        startRefresh(lifecycleEpoch.get())
    }

    private fun refreshAfterMutation(epoch: Long) {
        cachedItems = emptyList()
        nextCursor = null
        hasMore = false
        startRefresh(epoch)
    }

    private fun startRefresh(epoch: Long) {
        if (!isCurrent(epoch)) return
        val generation = refreshGeneration.incrementAndGet()
        if (!hasLoadedOnce) {
            _state.value = AttendanceCorrectionUiState.Loading
        }
        sessionScope.launch {
            if (!isCurrentRefresh(epoch, generation)) return@launch
            when (
                val result = repository.listCorrections(
                    status = AttendanceCorrectionStatus.toApiFilter(selectedStatus),
                    cursor = null,
                    limit = PAGE_SIZE
                )
            ) {
                is AppResult.Success -> {
                    if (!isCurrentRefresh(epoch, generation)) return@launch
                    cachedItems = result.data.items
                    nextCursor = result.data.nextCursor
                    hasMore = result.data.hasMore
                    hasLoadedOnce = true
                    publishContentState(epoch)
                }
                is AppResult.Error -> {
                    if (isCurrentRefresh(epoch, generation)) {
                        _state.value = AttendanceCorrectionUiState.Error(errorText(result))
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    private fun publishContentState(epoch: Long) {
        if (!isCurrent(epoch)) return
        val canReview = AttendanceCorrectionRules.canReviewCorrections(permissionsProvider())
        _state.value = when {
            cachedItems.isEmpty() && selectedStatus == null -> AttendanceCorrectionUiState.Empty
            else -> AttendanceCorrectionUiState.Content(
                items = cachedItems,
                selectedStatus = selectedStatus,
                hasMore = hasMore,
                isLoadingMore = false,
                actionCorrectionId = null,
                canReview = canReview
            )
        }
    }

    private fun updateContentIfCurrent(
        epoch: Long,
        transform: (AttendanceCorrectionUiState.Content) -> AttendanceCorrectionUiState.Content
    ) {
        if (!isCurrent(epoch)) return
        _state.update { current ->
            when (current) {
                is AttendanceCorrectionUiState.Content -> transform(current)
                else -> current
            }
        }
    }

    private fun isCurrent(epoch: Long): Boolean = lifecycleEpoch.get() == epoch

    private fun isCurrentRefresh(epoch: Long, generation: Long): Boolean =
        isCurrent(epoch) && refreshGeneration.get() == generation

    private fun errorText(error: AppResult.Error): String {
        val raw = error.exception.message.orEmpty()
        return when (raw) {
            "attendance.pending_correction_exists" ->
                "يوجد طلب تصحيح معلّق لهذا السجل. انتظر قرار المراجع."
            "attendance.correction_already_decided" ->
                "تم البت في هذا الطلب مسبقاً. حدّث القائمة."
            "attendance.version_mismatch" ->
                "تغيّر السجل منذ فتح الشاشة. حدّث البيانات ثم أعد المحاولة."
            "attendance.self_review_forbidden" ->
                "لا يمكنك مراجعة طلبك الخاص."
            "attendance.forbidden" ->
                "لا تملك صلاحية تنفيذ هذه العملية."
            "attendance.not_found" ->
                "تعذر العثور على طلب التصحيح."
            else -> raw.takeIf { it.isNotBlank() }
                ?: "تعذر إكمال العملية. تحقق من الاتصال وأعد المحاولة."
        }
    }

    private companion object {
        const val PAGE_SIZE = 50
    }
}
