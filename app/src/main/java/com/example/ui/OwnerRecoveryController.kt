package com.example.ui

import com.example.core.auth.CompanyLoginRules
import com.example.core.auth.OwnerRecoveryDeepLink
import com.example.core.auth.OwnerRecoveryTokenRules
import com.example.core.auth.PasswordPolicy
import com.example.core.utils.AppResult
import com.example.domain.model.OwnerRecoveryConfirmRequest
import com.example.domain.model.OwnerRecoveryInitiateRequest
import com.example.domain.repository.AuthRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

sealed interface OwnerForgotUiState {
    data class Form(
        val companyCode: String = "",
        val ownerEmail: String = "",
        val isSubmitting: Boolean = false,
        val errorMessageKey: String? = null
    ) : OwnerForgotUiState

    data class Accepted(val companyCode: String) : OwnerForgotUiState
}

sealed interface OwnerResetUiState {
    data class Form(
        val companyCode: String? = null,
        val manualToken: String = "",
        val requiresManualToken: Boolean = true,
        val isSubmitting: Boolean = false,
        val errorMessageKey: String? = null,
        val deepLinkRejected: Boolean = false
    ) : OwnerResetUiState

    data object Completed : OwnerResetUiState
}

interface OwnerRecoveryActions {
    fun onForgotCompanyCodeChange(value: String)
    fun onForgotEmailChange(value: String)
    fun submitForgot()
    fun onManualTokenChange(value: String)
    fun onNewPasswordChange(value: String)
    fun onConfirmPasswordChange(value: String)
    fun submitReset(newPassword: String, confirmPassword: String)
    fun clearTransientErrors()
}

/**
 * Company-plane Primary Owner recovery coordinator.
 *
 * The recovery token is held only in this controller's memory — never in
 * SavedStateHandle / Bundle — and is cleared on success, failure, or reset/back.
 */
class OwnerRecoveryController(
    private val authRepository: AuthRepository,
    private val scope: CoroutineScope,
    private val onConfirmSuccess: () -> Unit = {},
    private val mapMessageKey: (String) -> String = { it }
) : OwnerRecoveryActions {
    private val _forgotState = MutableStateFlow<OwnerForgotUiState>(OwnerForgotUiState.Form())
    val forgotState: StateFlow<OwnerForgotUiState> = _forgotState.asStateFlow()

    private val _resetState = MutableStateFlow<OwnerResetUiState>(
        OwnerResetUiState.Form()
    )
    val resetState: StateFlow<OwnerResetUiState> = _resetState.asStateFlow()

    /** Opaque recovery token — ViewModel/memory only; never persisted. */
    @Volatile
    private var resetTokenInMemory: String? = null

    /** New password draft kept only while the reset form is open. */
    @Volatile
    private var newPasswordDraft: String = ""
    @Volatile
    private var confirmPasswordDraft: String = ""

    private val parentJob = scope.coroutineContext[Job]
    private var sessionJob = SupervisorJob(parentJob)
    private var sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
    private val lifecycleEpoch = AtomicLong(0L)

    fun retainedCompanyCode(): String? = when (val state = _forgotState.value) {
        is OwnerForgotUiState.Form -> state.companyCode.takeIf { it.isNotBlank() }
        is OwnerForgotUiState.Accepted -> state.companyCode.takeIf { it.isNotBlank() }
    } ?: (_resetState.value as? OwnerResetUiState.Form)?.companyCode

    fun hasInMemoryToken(): Boolean = !resetTokenInMemory.isNullOrBlank()

    /** Test/inspection helper — never log the value. */
    internal fun peekTokenForTests(): String? = resetTokenInMemory

    fun reset() {
        lifecycleEpoch.incrementAndGet()
        sessionJob.cancel()
        sessionJob = SupervisorJob(parentJob)
        sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
        clearToken()
        newPasswordDraft = ""
        confirmPasswordDraft = ""
        _forgotState.value = OwnerForgotUiState.Form()
        _resetState.value = OwnerResetUiState.Form()
    }

    fun openForgot(companyCode: String) {
        clearToken()
        val normalized = CompanyLoginRules.normalizeCompanyCode(companyCode)
            .filter { it in 'A'..'Z' || it in '0'..'9' || it == '-' }
            .take(32)
        _forgotState.value = OwnerForgotUiState.Form(companyCode = normalized)
    }

    fun openReset(
        companyCode: String?,
        tokenFromDeepLink: String?,
        deepLinkRejected: Boolean = false
    ) {
        clearToken()
        newPasswordDraft = ""
        confirmPasswordDraft = ""
        val retained = companyCode
            ?.let { CompanyLoginRules.normalizeCompanyCode(it) }
            ?.takeIf { it.isNotBlank() }
        if (!tokenFromDeepLink.isNullOrBlank() && OwnerRecoveryTokenRules.isValid(tokenFromDeepLink)) {
            resetTokenInMemory = tokenFromDeepLink
            _resetState.value = OwnerResetUiState.Form(
                companyCode = retained,
                manualToken = "",
                requiresManualToken = false,
                deepLinkRejected = false
            )
        } else {
            _resetState.value = OwnerResetUiState.Form(
                companyCode = retained,
                requiresManualToken = true,
                deepLinkRejected = deepLinkRejected ||
                    (!tokenFromDeepLink.isNullOrBlank() && !OwnerRecoveryTokenRules.isValid(tokenFromDeepLink))
            )
        }
    }

    override fun onForgotCompanyCodeChange(value: String) {
        val current = _forgotState.value as? OwnerForgotUiState.Form ?: return
        if (current.isSubmitting) return
        val sanitized = value.uppercase()
            .filter { it in 'A'..'Z' || it in '0'..'9' || it == '-' }
            .take(32)
        _forgotState.value = current.copy(companyCode = sanitized, errorMessageKey = null)
    }

    override fun onForgotEmailChange(value: String) {
        val current = _forgotState.value as? OwnerForgotUiState.Form ?: return
        if (current.isSubmitting) return
        _forgotState.value = current.copy(ownerEmail = value.take(320), errorMessageKey = null)
    }

    override fun submitForgot() {
        val current = _forgotState.value as? OwnerForgotUiState.Form ?: return
        if (current.isSubmitting) return
        if (!CompanyLoginRules.isValidCompanyCode(current.companyCode) ||
            !CompanyLoginRules.isValidIdentifier(current.ownerEmail)
        ) {
            _forgotState.value = current.copy(errorMessageKey = "owner_recovery.fields_required")
            return
        }
        val epoch = lifecycleEpoch.get()
        _forgotState.value = current.copy(isSubmitting = true, errorMessageKey = null)
        sessionScope.launch {
            when (
                val result = authRepository.initiateOwnerRecovery(
                    OwnerRecoveryInitiateRequest(
                        companyCode = current.companyCode,
                        ownerEmail = current.ownerEmail.trim()
                    )
                )
            ) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    // Generic accepted — never branch on whether the owner exists.
                    _forgotState.value = OwnerForgotUiState.Accepted(
                        companyCode = CompanyLoginRules.normalizeCompanyCode(current.companyCode)
                    )
                }
                is AppResult.Error -> {
                    if (!isCurrent(epoch)) return@launch
                    // Still present the generic accepted surface on soft failures.
                    _forgotState.value = OwnerForgotUiState.Accepted(
                        companyCode = CompanyLoginRules.normalizeCompanyCode(current.companyCode)
                    )
                }
                AppResult.Loading -> Unit
            }
        }
    }

    override fun onManualTokenChange(value: String) {
        val current = _resetState.value as? OwnerResetUiState.Form ?: return
        if (current.isSubmitting) return
        val sanitized = value.filter { it.isLetterOrDigit() || it == '_' || it == '-' }.take(OwnerRecoveryTokenRules.MAX_LENGTH)
        // Keep token only in memory when the user finishes typing a valid value.
        if (OwnerRecoveryTokenRules.isValid(sanitized)) {
            resetTokenInMemory = sanitized
        } else {
            resetTokenInMemory = null
        }
        _resetState.value = current.copy(
            manualToken = sanitized,
            errorMessageKey = null,
            deepLinkRejected = false
        )
    }

    override fun onNewPasswordChange(value: String) {
        newPasswordDraft = value.take(PasswordPolicy.MAX_LENGTH)
    }

    override fun onConfirmPasswordChange(value: String) {
        confirmPasswordDraft = value.take(PasswordPolicy.MAX_LENGTH)
    }

    override fun submitReset(newPassword: String, confirmPassword: String) {
        val current = _resetState.value as? OwnerResetUiState.Form ?: return
        if (current.isSubmitting) return

        val token = resetTokenInMemory?.takeIf { OwnerRecoveryTokenRules.isValid(it) }
            ?: current.manualToken.takeIf { OwnerRecoveryTokenRules.isValid(it) }
        if (token.isNullOrBlank()) {
            _resetState.value = current.copy(
                errorMessageKey = OwnerRecoveryDeepLink.MESSAGE_KEY_INVALID
            )
            return
        }
        when (val policy = PasswordPolicy.validateNewPassword(newPassword, confirmPassword)) {
            PasswordPolicy.Validation.Ok -> Unit
            PasswordPolicy.Validation.Blank -> {
                _resetState.value = current.copy(errorMessageKey = "password.required")
                return
            }
            PasswordPolicy.Validation.TooShort -> {
                _resetState.value = current.copy(errorMessageKey = "password.too_short")
                return
            }
            PasswordPolicy.Validation.TooLong -> {
                _resetState.value = current.copy(errorMessageKey = "password.too_long")
                return
            }
            PasswordPolicy.Validation.ContainsWhitespace -> {
                _resetState.value = current.copy(errorMessageKey = "password.contains_whitespace")
                return
            }
            PasswordPolicy.Validation.ConfirmMismatch -> {
                _resetState.value = current.copy(errorMessageKey = "password.confirm_mismatch")
                return
            }
        }

        resetTokenInMemory = token
        val epoch = lifecycleEpoch.get()
        _resetState.value = current.copy(isSubmitting = true, errorMessageKey = null)
        sessionScope.launch {
            when (
                val result = authRepository.confirmOwnerRecovery(
                    OwnerRecoveryConfirmRequest(
                        resetToken = token,
                        newPassword = newPassword
                    )
                )
            ) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    clearToken()
                    newPasswordDraft = ""
                    confirmPasswordDraft = ""
                    // No auto-login — repository already cleared remembered sessions.
                    authRepository.clearLocalSessions()
                    _resetState.value = OwnerResetUiState.Completed
                    onConfirmSuccess()
                }
                is AppResult.Error -> {
                    if (!isCurrent(epoch)) return@launch
                    clearToken()
                    val key = result.exception.message
                        ?.takeIf { it.startsWith("owner_recovery.") || it.startsWith("password.") }
                        ?: OwnerRecoveryDeepLink.MESSAGE_KEY_INVALID
                    _resetState.value = current.copy(
                        isSubmitting = false,
                        requiresManualToken = true,
                        manualToken = "",
                        errorMessageKey = key
                    )
                }
                AppResult.Loading -> Unit
            }
        }
    }

    override fun clearTransientErrors() {
        val forgot = _forgotState.value
        if (forgot is OwnerForgotUiState.Form && !forgot.isSubmitting) {
            _forgotState.value = forgot.copy(errorMessageKey = null)
        }
        val reset = _resetState.value
        if (reset is OwnerResetUiState.Form && !reset.isSubmitting) {
            _resetState.value = reset.copy(errorMessageKey = null, deepLinkRejected = false)
        }
    }

    fun leaveReset() {
        clearToken()
        newPasswordDraft = ""
        confirmPasswordDraft = ""
        _resetState.value = OwnerResetUiState.Form()
    }

    private fun clearToken() {
        resetTokenInMemory = null
    }

    private fun isCurrent(epoch: Long): Boolean = lifecycleEpoch.get() == epoch

    fun resolveMessage(messageKey: String?): String {
        if (messageKey.isNullOrBlank()) return ""
        return mapMessageKey(messageKey)
    }
}
