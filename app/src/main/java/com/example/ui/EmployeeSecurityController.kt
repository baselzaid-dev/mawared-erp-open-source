package com.example.ui

import com.example.core.utils.AppResult
import com.example.domain.model.CreateEmployeeCredentialRequest
import com.example.domain.model.EmployeeArchiveRequest
import com.example.domain.model.EmployeeParams
import com.example.domain.model.OneTimeCredential
import com.example.domain.model.ResetEmployeeCredentialRequest
import com.example.domain.repository.CredentialRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

enum class EmployeeSecurityActionKind {
    CREATE_CREDENTIAL,
    RESET_CREDENTIAL,
    ARCHIVE
}

sealed interface EmployeeSecurityUiState {
    data object Idle : EmployeeSecurityUiState

    data class Submitting(
        val employeeId: String,
        val kind: EmployeeSecurityActionKind
    ) : EmployeeSecurityUiState

    data class OneTimeSecret(
        val employeeId: String,
        val employeeName: String,
        val kind: EmployeeSecurityActionKind,
        val credential: OneTimeCredential
    ) : EmployeeSecurityUiState

    data class SuccessMessage(
        val employeeId: String,
        val message: String
    ) : EmployeeSecurityUiState

    data class Error(
        val employeeId: String,
        val kind: EmployeeSecurityActionKind,
        val message: String
    ) : EmployeeSecurityUiState
}

/**
 * HR credential create/reset and archive actions.
 * Success is reported only after the repository returns [AppResult.Success].
 */
class EmployeeSecurityController(
    private val repository: CredentialRepository,
    private val scope: CoroutineScope,
    private val onMutated: suspend () -> Unit = {}
) {
    private val _state = MutableStateFlow<EmployeeSecurityUiState>(EmployeeSecurityUiState.Idle)
    val state: StateFlow<EmployeeSecurityUiState> = _state.asStateFlow()

    private val parentJob = scope.coroutineContext[Job]
    private var sessionJob = SupervisorJob(parentJob)
    private var sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
    private val lifecycleEpoch = AtomicLong(0L)

    fun reset() {
        lifecycleEpoch.incrementAndGet()
        sessionJob.cancel()
        sessionJob = SupervisorJob(parentJob)
        sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
        _state.value = EmployeeSecurityUiState.Idle
    }

    fun dismissFeedback() {
        _state.value = EmployeeSecurityUiState.Idle
    }

    fun createCredential(
        employee: EmployeeParams,
        email: String,
        permissions: Set<String>
    ) {
        if (!EmployeeCredentialRules.canCreateCredentialFor(employee, permissions)) {
            _state.value = EmployeeSecurityUiState.Error(
                employeeId = employee.id,
                kind = EmployeeSecurityActionKind.CREATE_CREDENTIAL,
                message = "لا تملك صلاحية إنشاء بيانات الدخول لهذا الموظف."
            )
            return
        }
        val trimmedEmail = email.trim()
        if (trimmedEmail.isBlank()) {
            _state.value = EmployeeSecurityUiState.Error(
                employeeId = employee.id,
                kind = EmployeeSecurityActionKind.CREATE_CREDENTIAL,
                message = "البريد الإلكتروني مطلوب لإنشاء بيانات الدخول."
            )
            return
        }
        val epoch = lifecycleEpoch.get()
        _state.value = EmployeeSecurityUiState.Submitting(
            employeeId = employee.id,
            kind = EmployeeSecurityActionKind.CREATE_CREDENTIAL
        )
        sessionScope.launch {
            when (
                val result = repository.createEmployeeCredential(
                    employee.id,
                    CreateEmployeeCredentialRequest(email = trimmedEmail)
                )
            ) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    onMutated()
                    if (!isCurrent(epoch)) return@launch
                    _state.value = EmployeeSecurityUiState.OneTimeSecret(
                        employeeId = employee.id,
                        employeeName = employee.fullName,
                        kind = EmployeeSecurityActionKind.CREATE_CREDENTIAL,
                        credential = result.data
                    )
                }
                is AppResult.Error -> {
                    if (isCurrent(epoch)) {
                        _state.value = EmployeeSecurityUiState.Error(
                            employeeId = employee.id,
                            kind = EmployeeSecurityActionKind.CREATE_CREDENTIAL,
                            message = errorText(result, "تعذر إنشاء بيانات الدخول.")
                        )
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    fun resetCredential(
        employee: EmployeeParams,
        reason: String,
        currentUserId: String?,
        actorEmployeeId: String?,
        permissions: Set<String>,
        isPrimaryOwnerTarget: Boolean = false
    ) {
        if (!EmployeeCredentialRules.canResetCredentialFor(
                employee,
                currentUserId,
                actorEmployeeId,
                permissions,
                isPrimaryOwnerTarget = isPrimaryOwnerTarget
            )
        ) {
            _state.value = EmployeeSecurityUiState.Error(
                employeeId = employee.id,
                kind = EmployeeSecurityActionKind.RESET_CREDENTIAL,
                message = "لا تملك صلاحية إعادة تعيين كلمة المرور لهذا الموظف."
            )
            return
        }
        val trimmedReason = reason.trim()
        if (trimmedReason.length < 3) {
            _state.value = EmployeeSecurityUiState.Error(
                employeeId = employee.id,
                kind = EmployeeSecurityActionKind.RESET_CREDENTIAL,
                message = "سبب إعادة التعيين يجب أن يكون 3 أحرف على الأقل."
            )
            return
        }
        val version = employee.credentialVersion
        if (version == null || version < 1) {
            _state.value = EmployeeSecurityUiState.Error(
                employeeId = employee.id,
                kind = EmployeeSecurityActionKind.RESET_CREDENTIAL,
                message = "حدّث قائمة الموظفين ثم أعد المحاولة."
            )
            return
        }
        val epoch = lifecycleEpoch.get()
        _state.value = EmployeeSecurityUiState.Submitting(
            employeeId = employee.id,
            kind = EmployeeSecurityActionKind.RESET_CREDENTIAL
        )
        sessionScope.launch {
            when (
                val result = repository.resetEmployeeCredential(
                    employee.id,
                    ResetEmployeeCredentialRequest(
                        reason = trimmedReason,
                        expectedCredentialVersion = version
                    )
                )
            ) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    onMutated()
                    if (!isCurrent(epoch)) return@launch
                    _state.value = EmployeeSecurityUiState.OneTimeSecret(
                        employeeId = employee.id,
                        employeeName = employee.fullName,
                        kind = EmployeeSecurityActionKind.RESET_CREDENTIAL,
                        credential = result.data
                    )
                }
                is AppResult.Error -> {
                    if (isCurrent(epoch)) {
                        _state.value = EmployeeSecurityUiState.Error(
                            employeeId = employee.id,
                            kind = EmployeeSecurityActionKind.RESET_CREDENTIAL,
                            message = errorText(result, "تعذر إعادة تعيين كلمة المرور.")
                        )
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    fun archiveEmployee(
        employee: EmployeeParams,
        reason: String,
        currentUserId: String?,
        actorEmployeeId: String?,
        isPrimaryOwnerTarget: Boolean,
        permissions: Set<String>
    ) {
        if (!EmployeeCredentialRules.canArchiveEmployeeRecord(
                employee,
                currentUserId,
                actorEmployeeId,
                isPrimaryOwnerTarget,
                permissions
            )
        ) {
            _state.value = EmployeeSecurityUiState.Error(
                employeeId = employee.id,
                kind = EmployeeSecurityActionKind.ARCHIVE,
                message = "لا تملك صلاحية أرشفة هذا الموظف."
            )
            return
        }
        val trimmedReason = reason.trim()
        if (trimmedReason.length < 3) {
            _state.value = EmployeeSecurityUiState.Error(
                employeeId = employee.id,
                kind = EmployeeSecurityActionKind.ARCHIVE,
                message = "سبب الأرشفة يجب أن يكون 3 أحرف على الأقل."
            )
            return
        }
        val expectedUpdatedAt = employee.updatedAtIso?.trim().orEmpty()
        if (expectedUpdatedAt.isBlank()) {
            _state.value = EmployeeSecurityUiState.Error(
                employeeId = employee.id,
                kind = EmployeeSecurityActionKind.ARCHIVE,
                message = "حدّث قائمة الموظفين ثم أعد المحاولة."
            )
            return
        }
        val epoch = lifecycleEpoch.get()
        _state.value = EmployeeSecurityUiState.Submitting(
            employeeId = employee.id,
            kind = EmployeeSecurityActionKind.ARCHIVE
        )
        sessionScope.launch {
            when (
                val result = repository.archiveEmployee(
                    employee.id,
                    EmployeeArchiveRequest(
                        reason = trimmedReason,
                        expectedUpdatedAt = expectedUpdatedAt
                    )
                )
            ) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    onMutated()
                    if (!isCurrent(epoch)) return@launch
                    _state.value = EmployeeSecurityUiState.SuccessMessage(
                        employeeId = employee.id,
                        message = "تمت أرشفة الموظف ${employee.fullName} بنجاح."
                    )
                }
                is AppResult.Error -> {
                    if (isCurrent(epoch)) {
                        _state.value = EmployeeSecurityUiState.Error(
                            employeeId = employee.id,
                            kind = EmployeeSecurityActionKind.ARCHIVE,
                            message = errorText(result, "تعذر أرشفة الموظف.")
                        )
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    private fun isCurrent(epoch: Long): Boolean = lifecycleEpoch.get() == epoch

    private fun errorText(error: AppResult.Error, fallback: String): String {
        val raw = error.exception.message.orEmpty()
        return when (raw) {
            "employees.credential_already_exists" -> "هذا الموظف لديه بيانات دخول بالفعل."
            "employees.inactive_employee" -> "لا يمكن تنفيذ العملية على موظف غير نشط."
            "employees.employee_not_found" -> "الموظف غير موجود أو خارج نطاق صلاحيتك."
            "employees.forbidden" -> "لا تملك صلاحية تنفيذ هذه العملية."
            "employees.stale_employee_version",
            "credentials.stale_credential_version" ->
                "تغيّرت بيانات الموظف. حدّث القائمة ثم أعد المحاولة."
            "employees.invalid_request",
            "credentials.invalid_request" -> "البيانات المرسلة غير صالحة."
            "employees.login_identity_conflict" -> "البريد الإلكتروني مستخدم بالفعل داخل الشركة."
            else -> raw.takeIf { it.isNotBlank() && it.any { ch -> ch in '\u0600'..'\u06ff' } }
                ?: fallback
        }
    }
}
