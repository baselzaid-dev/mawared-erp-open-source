package com.example.ui

import com.example.core.utils.AppResult
import com.example.domain.model.*
import com.example.domain.repository.AuthorizationRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

data class AuthorizationUiState(
    val isLoading: Boolean = false,
    val effective: EffectiveAuthorization? = null,
    val principals: List<ManageablePrincipal> = emptyList(),
    val grantable: GrantablePermissions? = null,
    val permissionPreview: PermissionPreview? = null,
    val delegations: List<TemporaryDelegation> = emptyList(),
    val departmentManagers: List<DepartmentManagerAssignment> = emptyList(),
    val ownershipPreview: OwnershipTransferPreview? = null,
    val ownershipCompleted: Boolean = false,
    val message: String? = null,
    val errorMessage: String? = null
)

class AuthorizationCoordinator(
    private val repository: AuthorizationRepository,
    private val scope: CoroutineScope
) {
    private val _state = MutableStateFlow(AuthorizationUiState())
    val state: StateFlow<AuthorizationUiState> = _state.asStateFlow()
    private val parentJob = scope.coroutineContext[Job]
    private var sessionJob = SupervisorJob(parentJob)
    private var sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
    private var grantableRequestId = 0L
    private val lifecycleEpoch = AtomicLong(0L)
    private val refreshGeneration = AtomicLong(0L)

    /**
     * Invoked after a successful in-lifecycle effective authorization load.
     * Used by MawaredViewModel for same-identity soft permission refresh.
     */
    var onEffectiveAuthorizationLoaded: ((EffectiveAuthorization) -> Unit)? = null

    fun reset() {
        lifecycleEpoch.incrementAndGet()
        refreshGeneration.incrementAndGet()
        grantableRequestId += 1
        sessionJob.cancel()
        sessionJob = SupervisorJob(parentJob)
        sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
        _state.value = AuthorizationUiState()
    }

    private fun isCurrent(epoch: Long): Boolean = lifecycleEpoch.get() == epoch

    private inline fun updateIfCurrent(
        epoch: Long,
        transform: (AuthorizationUiState) -> AuthorizationUiState
    ) {
        _state.update { state -> if (isCurrent(epoch)) transform(state) else state }
    }

    private fun isCurrentRefresh(epoch: Long, generation: Long): Boolean =
        isCurrent(epoch) && refreshGeneration.get() == generation

    private inline fun updateIfCurrentRefresh(
        epoch: Long,
        generation: Long,
        transform: (AuthorizationUiState) -> AuthorizationUiState
    ) {
        _state.update { state ->
            if (isCurrentRefresh(epoch, generation)) transform(state) else state
        }
    }

    private fun errorText(error: AppResult.Error): String {
        val raw = error.exception.message.orEmpty()
        return when (raw) {
            "authorization.stale_version" -> "تغيّرت الصلاحيات منذ فتح الشاشة. تم إيقاف العملية؛ حدّث البيانات ثم أعد المحاولة."
            "authorization.capability_not_grantable" -> "لا يمكنك منح صلاحية لا تملكها ضمن هذا النطاق."
            "authorization.principal_not_found" -> "المستخدم غير متاح للإدارة ضمن النطاق المحدد."
            "authorization.reauthentication_failed" -> "كلمة المرور غير صحيحة أو يلزم تسجيل الدخول مجددًا."
            "authorization.preview_invalid_or_expired" -> "انتهت صلاحية المعاينة. أنشئ معاينة جديدة قبل التطبيق."
            "authorization.concurrent_conflict", "authorization.ownership_changed" -> "تغيّرت البيانات بالتزامن مع العملية. حدّث الشاشة ثم أعد المحاولة."
            "authorization.grant_already_active" -> "هذه الصلاحية ممنوحة بالفعل."
            "authorization.grant_not_active" -> "هذه الصلاحية ليست ممنوحة مباشرة حتى يتم إلغاؤها."
            "authorization.manager_already_assigned" -> "هذا المستخدم مدير للقسم بالفعل."
            else -> raw.takeIf { it.isNotBlank() } ?: "تعذر إكمال العملية. تحقق من الاتصال وأعد المحاولة."
        }
    }

    private fun begin(epoch: Long): Boolean {
        if (!isCurrent(epoch)) return false
        updateIfCurrent(epoch) { it.copy(isLoading = true, errorMessage = null, message = null) }
        return isCurrent(epoch)
    }

    private fun beginRefresh(epoch: Long, generation: Long): Boolean {
        if (!isCurrentRefresh(epoch, generation)) return false
        updateIfCurrentRefresh(epoch, generation) {
            it.copy(isLoading = true, errorMessage = null, message = null)
        }
        return isCurrentRefresh(epoch, generation)
    }

    private fun fail(epoch: Long, error: AppResult.Error) {
        updateIfCurrent(epoch) { it.copy(isLoading = false, errorMessage = errorText(error)) }
    }

    private fun failRefresh(epoch: Long, generation: Long, error: AppResult.Error) {
        updateIfCurrentRefresh(epoch, generation) {
            it.copy(isLoading = false, errorMessage = errorText(error))
        }
    }

    fun clearMessages() {
        _state.update { it.copy(message = null, errorMessage = null) }
    }

    fun clearOwnershipCompleted() {
        _state.update { it.copy(ownershipCompleted = false) }
    }

    fun refresh(departmentId: String? = null, completionMessage: String? = null) {
        startRefreshForEpoch(departmentId, completionMessage, lifecycleEpoch.get())
    }

    private fun startRefreshForEpoch(
        departmentId: String?,
        completionMessage: String?,
        epoch: Long
    ) {
        if (!isCurrent(epoch)) return
        val generation = refreshGeneration.incrementAndGet()
        refreshForEpoch(departmentId, completionMessage, epoch, generation)
    }

    private fun refreshForEpoch(
        departmentId: String?,
        completionMessage: String?,
        epoch: Long,
        generation: Long
    ) {
        if (!isCurrentRefresh(epoch, generation)) return
        sessionScope.launch {
            if (!beginRefresh(epoch, generation)) return@launch
            val effective = repository.loadEffective()
            if (!isCurrentRefresh(epoch, generation)) return@launch
            if (effective is AppResult.Error) return@launch failRefresh(epoch, generation, effective)
            val principals = repository.loadManageablePrincipals(departmentId)
            if (!isCurrentRefresh(epoch, generation)) return@launch
            if (principals is AppResult.Error) return@launch failRefresh(epoch, generation, principals)
            val delegations = repository.listDelegations()
            if (!isCurrentRefresh(epoch, generation)) return@launch
            if (delegations is AppResult.Error) return@launch failRefresh(epoch, generation, delegations)
            val managers = if (departmentId == null) {
                AppResult.Success(emptyList())
            } else {
                repository.listDepartmentManagers(departmentId)
            }
            if (!isCurrentRefresh(epoch, generation)) return@launch
            if (managers is AppResult.Error) return@launch failRefresh(epoch, generation, managers)
            val effectiveData = (effective as AppResult.Success).data
            updateIfCurrentRefresh(epoch, generation) {
                it.copy(
                    isLoading = false,
                    effective = effectiveData,
                    principals = (principals as AppResult.Success).data,
                    delegations = (delegations as AppResult.Success).data,
                    departmentManagers = (managers as AppResult.Success).data,
                    grantable = null,
                    permissionPreview = null,
                    ownershipPreview = null,
                    message = completionMessage
                )
            }
            if (isCurrentRefresh(epoch, generation)) {
                onEffectiveAuthorizationLoaded?.invoke(effectiveData)
            }
        }
    }

    fun loadGrantable(targetUserId: String, departmentId: String?) {
        val epoch = lifecycleEpoch.get()
        val requestId = ++grantableRequestId
        updateIfCurrent(epoch) {
            it.copy(
                isLoading = true,
                grantable = null,
                permissionPreview = null,
                errorMessage = null,
                message = null
            )
        }
        sessionScope.launch {
            when (val result = repository.loadGrantablePermissions(targetUserId, departmentId)) {
                is AppResult.Success -> updateIfCurrent(epoch) {
                    if (requestId != grantableRequestId || result.data.targetUserId != targetUserId) it
                    else it.copy(isLoading = false, grantable = result.data, permissionPreview = null)
                }
                is AppResult.Error -> if (isCurrent(epoch) && requestId == grantableRequestId) fail(epoch, result)
                AppResult.Loading -> Unit
            }
        }
    }

    fun previewPermissionChanges(action: String, capabilities: Set<String>, reason: String) {
        val grantable = _state.value.grantable ?: return
        val epoch = lifecycleEpoch.get()
        val requestId = grantableRequestId
        val operations = capabilities.sorted().map {
            PermissionOperation(
                action,
                it,
                grantable.scope.scopeType,
                grantable.scope.departmentId
            )
        }
        sessionScope.launch {
            if (!begin(epoch)) return@launch
            when (val result = repository.previewPermissionChanges(
                grantable.targetUserId,
                grantable.targetAuthorizationVersion,
                reason.trim(),
                operations
            )) {
                is AppResult.Success -> updateIfCurrent(epoch) {
                    if (
                        requestId != grantableRequestId ||
                        result.data.targetUserId != grantable.targetUserId ||
                        it.grantable?.targetUserId != grantable.targetUserId
                    ) it else it.copy(
                        isLoading = false,
                        permissionPreview = result.data,
                        message = "المعاينة جاهزة. راجع التغييرات قبل التطبيق."
                    )
                }
                is AppResult.Error -> if (isCurrent(epoch) && requestId == grantableRequestId) fail(epoch, result)
                AppResult.Loading -> Unit
            }
        }
    }

    fun applyPermissionPreview(departmentId: String?) {
        val preview = _state.value.permissionPreview ?: return
        val epoch = lifecycleEpoch.get()
        if (_state.value.grantable?.targetUserId != preview.targetUserId) {
            updateIfCurrent(epoch) {
                it.copy(
                    permissionPreview = null,
                    errorMessage = "تغيّر المستخدم المحدد. أنشئ معاينة جديدة قبل التطبيق."
                )
            }
            return
        }
        sessionScope.launch {
            if (!begin(epoch)) return@launch
            when (val result = repository.applyPermissionChanges(preview.previewId)) {
                is AppResult.Success -> {
                    updateIfCurrent(epoch) { it.copy(permissionPreview = null) }
                    startRefreshForEpoch(departmentId, "تم تطبيق الصلاحيات وتحديث نسخة التفويض.", epoch)
                }
                is AppResult.Error -> fail(epoch, result)
                AppResult.Loading -> Unit
            }
        }
    }

    fun createDelegation(
        target: ManageablePrincipal,
        capabilities: Set<String>,
        departmentId: String?,
        validFrom: String,
        validUntil: String,
        reason: String
    ) {
        val epoch = lifecycleEpoch.get()
        val scopeValue = AuthorizationScope(if (departmentId == null) "company" else "department", departmentId)
        sessionScope.launch {
            if (!begin(epoch)) return@launch
            when (val result = repository.createDelegation(
                target.userId,
                capabilities.sorted(),
                scopeValue,
                validFrom,
                validUntil,
                reason.trim(),
                target.authorizationVersion
            )) {
                is AppResult.Success -> {
                    startRefreshForEpoch(departmentId, "تم إنشاء التفويض المؤقت.", epoch)
                }
                is AppResult.Error -> fail(epoch, result)
                AppResult.Loading -> Unit
            }
        }
    }

    fun revokeDelegation(item: TemporaryDelegation, reason: String, departmentId: String?) {
        val epoch = lifecycleEpoch.get()
        val targetVersion = _state.value.principals.firstOrNull { it.userId == item.recipientUserId }?.authorizationVersion
        if (targetVersion == null) {
            updateIfCurrent(epoch) { it.copy(errorMessage = "حدّث قائمة المستخدمين قبل إلغاء التفويض.") }
            return
        }
        sessionScope.launch {
            if (!begin(epoch)) return@launch
            when (val result = repository.revokeDelegation(item.id, reason.trim(), targetVersion)) {
                is AppResult.Success -> {
                    startRefreshForEpoch(departmentId, "تم إلغاء التفويض المؤقت.", epoch)
                }
                is AppResult.Error -> fail(epoch, result)
                AppResult.Loading -> Unit
            }
        }
    }

    fun previewOwnership(target: ManageablePrincipal, reason: String, password: String) {
        val epoch = lifecycleEpoch.get()
        sessionScope.launch {
            if (!begin(epoch)) return@launch
            when (val result = repository.previewOwnershipTransfer(target.userId, reason.trim(), password)) {
                is AppResult.Success -> updateIfCurrent(epoch) {
                    it.copy(isLoading = false, ownershipPreview = result.data, message = "معاينة نقل الملكية جاهزة. لم يتم تنفيذ النقل بعد.")
                }
                is AppResult.Error -> fail(epoch, result)
                AppResult.Loading -> Unit
            }
        }
    }

    fun applyOwnership() {
        val preview = _state.value.ownershipPreview ?: return
        val actorVersion = _state.value.effective?.authorizationVersion ?: return
        val epoch = lifecycleEpoch.get()
        sessionScope.launch {
            if (!begin(epoch)) return@launch
            when (val result = repository.applyOwnershipTransfer(preview, actorVersion)) {
                is AppResult.Success -> updateIfCurrent(epoch) {
                    it.copy(
                        isLoading = false,
                        ownershipPreview = null,
                        ownershipCompleted = true,
                        message = "تم نقل الملكية وإبطال الجلسات. يلزم تسجيل الدخول مجددًا."
                    )
                }
                is AppResult.Error -> fail(epoch, result)
                AppResult.Loading -> Unit
            }
        }
    }

    fun createDelegatedAdmin(target: ManageablePrincipal, capabilities: Set<String>, reason: String, departmentId: String?) {
        val epoch = lifecycleEpoch.get()
        sessionScope.launch {
            if (!begin(epoch)) return@launch
            when (val result = repository.createDelegatedAdmin(
                target.userId,
                capabilities.sorted(),
                reason.trim(),
                target.authorizationVersion
            )) {
                is AppResult.Success -> {
                    startRefreshForEpoch(departmentId, "تم منح الإدارة المفوضة ضمن الصلاحيات المحددة.", epoch)
                }
                is AppResult.Error -> fail(epoch, result)
                AppResult.Loading -> Unit
            }
        }
    }

    fun revokeDelegatedAdmin(target: ManageablePrincipal, reason: String, departmentId: String?) {
        val epoch = lifecycleEpoch.get()
        sessionScope.launch {
            if (!begin(epoch)) return@launch
            when (val result = repository.revokeDelegatedAdmin(target.userId, reason.trim(), target.authorizationVersion)) {
                is AppResult.Success -> {
                    startRefreshForEpoch(departmentId, "تم إلغاء الإدارة المفوضة.", epoch)
                }
                is AppResult.Error -> fail(epoch, result)
                AppResult.Loading -> Unit
            }
        }
    }

    fun assignDepartmentManager(departmentId: String, target: ManageablePrincipal, reason: String) {
        val epoch = lifecycleEpoch.get()
        sessionScope.launch {
            if (!begin(epoch)) return@launch
            when (val result = repository.assignDepartmentManager(
                departmentId,
                target.userId,
                reason.trim(),
                target.authorizationVersion
            )) {
                is AppResult.Success -> {
                    startRefreshForEpoch(departmentId, "تمت إضافة مدير القسم.", epoch)
                }
                is AppResult.Error -> fail(epoch, result)
                AppResult.Loading -> Unit
            }
        }
    }

    fun revokeDepartmentManager(departmentId: String, manager: DepartmentManagerAssignment, reason: String) {
        val epoch = lifecycleEpoch.get()
        sessionScope.launch {
            if (!begin(epoch)) return@launch
            when (val result = repository.revokeDepartmentManager(
                departmentId,
                manager.userId,
                reason.trim(),
                manager.authorizationVersion
            )) {
                is AppResult.Success -> {
                    startRefreshForEpoch(departmentId, "تم إنهاء تعيين مدير القسم.", epoch)
                }
                is AppResult.Error -> fail(epoch, result)
                AppResult.Loading -> Unit
            }
        }
    }
}
