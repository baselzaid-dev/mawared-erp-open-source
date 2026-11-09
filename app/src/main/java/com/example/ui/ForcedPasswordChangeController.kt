package com.example.ui

import com.example.core.utils.AppResult
import com.example.domain.model.ForcedPasswordChangeRequest
import com.example.domain.model.ForcedPasswordChangeResult
import com.example.domain.repository.CredentialRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

sealed interface ForcedPasswordChangeUiState {
    data class Blocking(
        val isSubmitting: Boolean = false,
        val errorMessage: String? = null
    ) : ForcedPasswordChangeUiState

    data class Completed(val result: ForcedPasswordChangeResult) : ForcedPasswordChangeUiState
}

interface ForcedPasswordChangeActions {
    fun onSubmit(temporaryPassword: String, newPassword: String, confirmPassword: String)
    fun onDismissError()
}

/**
 * Blocks navigation until the server confirms a successful forced password change.
 * Coordinator should keep showing [ForcedPasswordChangeUiState.Blocking] until [Completed].
 */
class ForcedPasswordChangeController(
    private val repository: CredentialRepository,
    private val scope: CoroutineScope,
    private val onPasswordChanged: (ForcedPasswordChangeResult) -> Unit = {}
) : ForcedPasswordChangeActions {
    private val _state = MutableStateFlow<ForcedPasswordChangeUiState>(
        ForcedPasswordChangeUiState.Blocking()
    )
    val state: StateFlow<ForcedPasswordChangeUiState> = _state.asStateFlow()

    private val parentJob = scope.coroutineContext[Job]
    private var sessionJob = SupervisorJob(parentJob)
    private var sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
    private val lifecycleEpoch = AtomicLong(0L)

    fun reset() {
        lifecycleEpoch.incrementAndGet()
        sessionJob.cancel()
        sessionJob = SupervisorJob(parentJob)
        sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
        _state.value = ForcedPasswordChangeUiState.Blocking()
    }

    override fun onSubmit(temporaryPassword: String, newPassword: String, confirmPassword: String) {
        val trimmedTemporary = temporaryPassword.trim()
        if (trimmedTemporary.isBlank() || newPassword.isEmpty() || confirmPassword.isEmpty()) {
            _state.value = ForcedPasswordChangeUiState.Blocking(
                errorMessage = "جميع حقول كلمة المرور مطلوبة."
            )
            return
        }
        when (val policy = com.example.core.auth.PasswordPolicy.validateNewPassword(newPassword, confirmPassword)) {
            com.example.core.auth.PasswordPolicy.Validation.Ok -> Unit
            com.example.core.auth.PasswordPolicy.Validation.Blank -> {
                _state.value = ForcedPasswordChangeUiState.Blocking(
                    errorMessage = "جميع حقول كلمة المرور مطلوبة."
                )
                return
            }
            com.example.core.auth.PasswordPolicy.Validation.ConfirmMismatch -> {
                _state.value = ForcedPasswordChangeUiState.Blocking(
                    errorMessage = "كلمة المرور الجديدة وتأكيدها غير متطابقين."
                )
                return
            }
            com.example.core.auth.PasswordPolicy.Validation.TooShort -> {
                _state.value = ForcedPasswordChangeUiState.Blocking(
                    errorMessage = "كلمة المرور الجديدة يجب أن تكون 10 أحرف على الأقل."
                )
                return
            }
            com.example.core.auth.PasswordPolicy.Validation.TooLong -> {
                _state.value = ForcedPasswordChangeUiState.Blocking(
                    errorMessage = "كلمة المرور الجديدة طويلة جداً."
                )
                return
            }
            com.example.core.auth.PasswordPolicy.Validation.ContainsWhitespace -> {
                _state.value = ForcedPasswordChangeUiState.Blocking(
                    errorMessage = "كلمة المرور الجديدة لا يجب أن تحتوي على مسافات."
                )
                return
            }
        }
        if (newPassword == trimmedTemporary) {
            _state.value = ForcedPasswordChangeUiState.Blocking(
                errorMessage = "كلمة المرور الجديدة يجب أن تختلف عن المؤقتة."
            )
            return
        }

        val epoch = lifecycleEpoch.get()
        _state.value = ForcedPasswordChangeUiState.Blocking(isSubmitting = true)
        sessionScope.launch {
            when (
                val result = repository.changeTemporaryPassword(
                    ForcedPasswordChangeRequest(
                        temporaryPassword = trimmedTemporary,
                        newPassword = newPassword,
                        confirmPassword = confirmPassword
                    )
                )
            ) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    _state.value = ForcedPasswordChangeUiState.Completed(result.data)
                    onPasswordChanged(result.data)
                }
                is AppResult.Error -> {
                    if (isCurrent(epoch)) {
                        _state.value = ForcedPasswordChangeUiState.Blocking(
                            errorMessage = errorText(result)
                        )
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    override fun onDismissError() {
        val current = _state.value
        if (current is ForcedPasswordChangeUiState.Blocking && !current.isSubmitting) {
            _state.value = current.copy(errorMessage = null)
        }
    }

    private fun isCurrent(epoch: Long): Boolean = lifecycleEpoch.get() == epoch

    private fun errorText(error: AppResult.Error): String {
        val raw = error.exception.message.orEmpty()
        return when (raw) {
            "password.confirm_mismatch" -> "كلمة المرور الجديدة وتأكيدها غير متطابقين."
            "password.too_short" -> "كلمة المرور الجديدة يجب أن تكون 10 أحرف على الأقل."
            "password.too_long" -> "كلمة المرور الجديدة طويلة جداً."
            "password.contains_whitespace" -> "كلمة المرور الجديدة لا يجب أن تحتوي على مسافات."
            "password.same_as_temporary" -> "كلمة المرور الجديدة يجب أن تختلف عن المؤقتة."
            "auth.temporary_password_invalid" -> "كلمة المرور المؤقتة غير صحيحة."
            "auth.temporary_password_expired" ->
                "انتهت صلاحية كلمة المرور المؤقتة. اطلب كلمة مرور جديدة من المسؤول."
            "auth.password_change_not_required" -> "لا يلزم تغيير كلمة المرور حالياً."
            else -> raw.takeIf { it.isNotBlank() }
                ?: "تعذر تغيير كلمة المرور. تحقق من الاتصال وأعد المحاولة."
        }
    }
}
