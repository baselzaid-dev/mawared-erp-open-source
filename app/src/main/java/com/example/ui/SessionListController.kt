package com.example.ui

import com.example.core.network.UserSafeErrorMessages
import com.example.core.utils.AppResult
import com.example.domain.model.RevokeAllSessionsRequest
import com.example.domain.model.SessionSummary
import com.example.domain.repository.SessionRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

sealed interface SessionListUiState {
    data object Loading : SessionListUiState

    data class Content(
        val sessions: List<SessionSummary>,
        val actionSessionId: String? = null,
        val isRevokingAll: Boolean = false
    ) : SessionListUiState

    data object Empty : SessionListUiState

    data class Error(val message: String) : SessionListUiState
}

data class SessionListFeedback(
    val successMessage: String? = null,
    val errorMessage: String? = null
)

interface SessionListActions {
    fun onRetry()
    fun onRevokeSession(sessionId: String)
    fun onRevokeAllOthers()
    fun onDismissFeedback()
}

/**
 * Lists active sessions and revokes one or all other devices.
 * Mutations refresh from the server — no optimistic success.
 */
class SessionListController(
    private val repository: SessionRepository,
    private val scope: CoroutineScope
) : SessionListActions {
    private val _state = MutableStateFlow<SessionListUiState>(SessionListUiState.Loading)
    val state: StateFlow<SessionListUiState> = _state.asStateFlow()

    private val _feedback = MutableStateFlow(SessionListFeedback())
    val feedback: StateFlow<SessionListFeedback> = _feedback.asStateFlow()

    private val parentJob = scope.coroutineContext[Job]
    private var sessionJob = SupervisorJob(parentJob)
    private var sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
    private val lifecycleEpoch = AtomicLong(0L)
    private val refreshGeneration = AtomicLong(0L)

    fun reset() {
        lifecycleEpoch.incrementAndGet()
        refreshGeneration.incrementAndGet()
        sessionJob.cancel()
        sessionJob = SupervisorJob(parentJob)
        sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
        _state.value = SessionListUiState.Loading
        _feedback.value = SessionListFeedback()
    }

    fun load() {
        refresh()
    }

    override fun onRetry() {
        refresh()
    }

    override fun onRevokeSession(sessionId: String) {
        val current = _state.value as? SessionListUiState.Content ?: return
        val target = current.sessions.firstOrNull { it.sessionId == sessionId } ?: return
        if (!target.isActive || target.isCurrent) {
            _feedback.value = SessionListFeedback(
                errorMessage = if (target.isCurrent) {
                    "لا يمكن إنهاء الجلسة الحالية من هذه الشاشة."
                } else {
                    "هذه الجلسة منتهية بالفعل."
                }
            )
            return
        }
        val epoch = lifecycleEpoch.get()
        updateContentIfCurrent(epoch) { it.copy(actionSessionId = sessionId) }
        sessionScope.launch {
            when (val result = repository.revokeSession(sessionId)) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    _feedback.value = SessionListFeedback(successMessage = "تم إنهاء الجلسة.")
                    refreshAfterMutation(epoch)
                }
                is AppResult.Error -> {
                    if (isCurrent(epoch)) {
                        _feedback.value = SessionListFeedback(errorMessage = errorText(result))
                        updateContentIfCurrent(epoch) { it.copy(actionSessionId = null) }
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    override fun onRevokeAllOthers() {
        val current = _state.value as? SessionListUiState.Content ?: return
        val revokableCount = current.sessions.count { it.isActive && !it.isCurrent }
        if (revokableCount == 0) {
            _feedback.value = SessionListFeedback(errorMessage = "لا توجد جلسات أخرى نشطة.")
            return
        }
        val epoch = lifecycleEpoch.get()
        updateContentIfCurrent(epoch) { it.copy(isRevokingAll = true) }
        sessionScope.launch {
            when (
                val result = repository.revokeAllOtherSessions(
                    RevokeAllSessionsRequest(exceptCurrent = true)
                )
            ) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    val count = result.data.revokedCount
                    _feedback.value = SessionListFeedback(
                        successMessage = if (count > 0) {
                            "تم إنهاء $count جلسة أخرى."
                        } else {
                            "لا توجد جلسات أخرى نشطة."
                        }
                    )
                    refreshAfterMutation(epoch)
                }
                is AppResult.Error -> {
                    if (isCurrent(epoch)) {
                        _feedback.value = SessionListFeedback(errorMessage = errorText(result))
                        updateContentIfCurrent(epoch) { it.copy(isRevokingAll = false) }
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    override fun onDismissFeedback() {
        _feedback.value = SessionListFeedback()
    }

    private fun refresh() {
        startRefresh(lifecycleEpoch.get())
    }

    private fun refreshAfterMutation(epoch: Long) {
        startRefresh(epoch)
    }

    private fun startRefresh(epoch: Long) {
        if (!isCurrent(epoch)) return
        val generation = refreshGeneration.incrementAndGet()
        if (_state.value !is SessionListUiState.Content) {
            _state.value = SessionListUiState.Loading
        }
        sessionScope.launch {
            if (!isCurrentRefresh(epoch, generation)) return@launch
            when (val result = repository.listSessions()) {
                is AppResult.Success -> {
                    if (!isCurrentRefresh(epoch, generation)) return@launch
                    publishContent(result.data)
                }
                is AppResult.Error -> {
                    if (isCurrentRefresh(epoch, generation)) {
                        _state.value = SessionListUiState.Error(errorText(result))
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    private fun publishContent(sessions: List<SessionSummary>) {
        _state.value = if (sessions.isEmpty()) {
            SessionListUiState.Empty
        } else {
            SessionListUiState.Content(
                sessions = sessions,
                actionSessionId = null,
                isRevokingAll = false
            )
        }
    }

    private fun updateContentIfCurrent(
        epoch: Long,
        transform: (SessionListUiState.Content) -> SessionListUiState.Content
    ) {
        if (!isCurrent(epoch)) return
        _state.update { current ->
            when (current) {
                is SessionListUiState.Content -> transform(current)
                else -> current
            }
        }
    }

    private fun isCurrent(epoch: Long): Boolean = lifecycleEpoch.get() == epoch

    private fun isCurrentRefresh(epoch: Long, generation: Long): Boolean =
        isCurrent(epoch) && refreshGeneration.get() == generation

    private fun errorText(error: AppResult.Error): String {
        val serverError = error.appError as? com.example.core.utils.AppError.ServerError
        if (serverError != null && UserSafeErrorMessages.shouldExposeSupportId(serverError.code)) {
            return UserSafeErrorMessages.unexpectedServerError(serverError.supportRequestId)
        }
        val raw = error.exception.message.orEmpty()
        return when (raw) {
            "auth.session_not_found" -> "تعذر العثور على الجلسة."
            "auth.session_revoke_current_forbidden" -> "لا يمكن إنهاء الجلسة الحالية."
            "auth.session_revoke_all_invalid" -> "طلب إنهاء الجلسات غير صالح."
            else -> raw.takeIf { it.isNotBlank() }
                ?: "تعذر إكمال العملية. تحقق من الاتصال وأعد المحاولة."
        }
    }
}
