package com.example.data.remote.repository

import com.example.core.network.ApiErrorSupport
import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.*
import com.example.domain.model.*
import com.example.domain.repository.AuthorizationRepository
import com.squareup.moshi.Moshi
import retrofit2.Response
import java.util.UUID

class ApiAuthorizationRepository(
    private val api: AuthorizationApi
) : AuthorizationRepository {
    private val errorAdapter = Moshi.Builder().build().adapter(AuthorizationErrorResponseDto::class.java)

    private fun EffectiveCapabilityDto.toDomain() = EffectiveCapability(
        capability, scopeType, departmentId, source, validUntil
    )

    private fun EffectiveAuthorizationDto.toDomain() = EffectiveAuthorization(
        userId,
        authorizationVersion,
        isPrimaryOwner,
        managedDepartmentIds,
        capabilities.map { it.toDomain() },
        flatPermissions
    )

    private fun ManageablePrincipalDto.toDomain() = ManageablePrincipal(
        userId,
        employeeId,
        name,
        departmentId,
        authorizationVersion,
        managedDepartmentIds
    )

    private fun TemporaryDelegationDto.toDomain() = TemporaryDelegation(
        id,
        delegatorUserId.orEmpty(),
        recipientUserId,
        scopeType,
        departmentId,
        validFrom,
        validUntil,
        status,
        revokedAt,
        createdAt,
        effective,
        capabilities
    )

    private fun DepartmentManagerDto.toDomain() = DepartmentManagerAssignment(
        id,
        departmentId,
        userId,
        employeeId,
        name,
        authorizationVersion,
        assignedAt
    )

    private fun <T> responseError(response: Response<T>, fallback: String): AppResult.Error {
        val rawBody = try {
            response.errorBody()?.string().orEmpty()
        } catch (_: Exception) {
            ""
        }
        val payload = try {
            rawBody.takeIf { it.isNotBlank() }?.let(errorAdapter::fromJson)
        } catch (_: Exception) {
            null
        }
        val message = payload?.messageKey?.takeIf(String::isNotBlank)
            ?: payload?.message?.takeIf(String::isNotBlank)
            ?: fallback
        val appError = ApiErrorSupport.mapHttpFailure(
            response,
            fallback = message,
            parsedMessage = message,
            errorBody = rawBody,
        )
        return AppResult.Error(Exception(message), appError)
    }

    private suspend fun <D, T> request(
        fallback: String,
        call: suspend () -> Response<D>,
        map: (D) -> T
    ): AppResult<T> = try {
        val response = call()
        val body = response.body()
        if (response.isSuccessful && body != null) AppResult.Success(map(body))
        else responseError(response, fallback)
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    private suspend fun requestNoBody(
        fallback: String,
        call: suspend () -> Response<Unit>
    ): AppResult<Unit> = try {
        val response = call()
        if (response.isSuccessful) AppResult.Success(Unit)
        else responseError(response, fallback)
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadEffective() = request(
        "تعذر تحميل الصلاحيات الفعالة",
        api::getEffective
    ) { it.toDomain() }

    override suspend fun loadManageablePrincipals(departmentId: String?) = request(
        "تعذر تحميل المستخدمين المتاحين للإدارة",
        { api.getManageablePrincipals(departmentId) }
    ) { rows -> rows.map { it.toDomain() } }

    override suspend fun loadGrantablePermissions(targetUserId: String, departmentId: String?) = request(
        "تعذر تحميل الصلاحيات القابلة للمنح",
        { api.getGrantablePermissions(targetUserId, departmentId) }
    ) { dto ->
        GrantablePermissions(
            dto.targetUserId,
            dto.targetAuthorizationVersion,
            AuthorizationScope(dto.scope.scopeType, dto.scope.departmentId),
            dto.capabilities
        )
    }

    override suspend fun previewPermissionChanges(
        targetUserId: String,
        expectedVersion: Int,
        reason: String,
        operations: List<PermissionOperation>
    ) = request(
        "تعذر إنشاء معاينة تغيير الصلاحيات",
        {
            api.previewPermissionChanges(
                PermissionPreviewRequestDto(
                    targetUserId,
                    expectedVersion,
                    reason,
                    operations.map {
                        PermissionOperationDto(it.action, it.capability, it.scopeType, it.departmentId)
                    }
                )
            )
        }
    ) { dto ->
        PermissionPreview(
            dto.previewId,
            dto.previewDigest,
            dto.expiresInSeconds,
            dto.targetUserId,
            dto.expectedAuthorizationVersion,
            dto.changes.map {
                PermissionPreviewChange(it.action, it.capability, it.scopeType, it.departmentId, it.before, it.after)
            }
        )
    }

    override suspend fun applyPermissionChanges(previewId: String) = request(
        "تعذر تطبيق تغيير الصلاحيات",
        { api.applyPermissionChanges(PermissionApplyRequestDto(previewId, UUID.randomUUID().toString())) }
    ) { it.toDomain() }

    override suspend fun listDelegations() = request(
        "تعذر تحميل التفويضات المؤقتة",
        api::getDelegations
    ) { rows -> rows.map { it.toDomain() } }

    override suspend fun createDelegation(
        recipientUserId: String,
        capabilities: List<String>,
        scope: AuthorizationScope,
        validFrom: String,
        validUntil: String,
        reason: String,
        expectedVersion: Int
    ) = request(
        "تعذر إنشاء التفويض المؤقت",
        {
            api.createDelegation(
                DelegationCreateRequestDto(
                    recipientUserId,
                    capabilities,
                    scope.scopeType,
                    scope.departmentId,
                    validFrom,
                    validUntil,
                    reason,
                    expectedVersion,
                    UUID.randomUUID().toString()
                )
            )
        }
    ) { it.toDomain() }

    override suspend fun revokeDelegation(id: String, reason: String, expectedVersion: Int) = request(
        "تعذر إلغاء التفويض المؤقت",
        { api.revokeDelegation(id, DelegationRevokeRequestDto(reason, expectedVersion)) }
    ) { it.toDomain() }

    override suspend fun previewOwnershipTransfer(targetUserId: String, reason: String, password: String) = request(
        "تعذر إنشاء معاينة نقل الملكية",
        { api.previewOwnershipTransfer(OwnershipPreviewRequestDto(targetUserId, reason, password)) }
    ) { dto ->
        OwnershipTransferPreview(
            dto.previewId,
            dto.previewDigest,
            dto.expiresInSeconds,
            dto.confirmationText,
            dto.fromUserId,
            dto.target.toDomain()
        )
    }

    override suspend fun applyOwnershipTransfer(preview: OwnershipTransferPreview, expectedVersion: Int) = request(
        "تعذر نقل الملكية الأساسية",
        {
            api.applyOwnershipTransfer(
                OwnershipApplyRequestDto(
                    preview.previewId,
                    preview.confirmationText,
                    expectedVersion,
                    UUID.randomUUID().toString()
                )
            )
        }
    ) { dto ->
        OwnershipTransferResult(
            dto.transferId,
            dto.idempotent,
            dto.owner?.toDomain(),
            dto.sessionsRevoked
        )
    }

    override suspend fun createDelegatedAdmin(
        userId: String,
        capabilities: List<String>,
        reason: String,
        expectedVersion: Int
    ) = request(
        "تعذر منح الإدارة المفوضة",
        {
            api.createDelegatedAdmin(
                DelegatedAdminRequestDto(
                    userId,
                    capabilities,
                    reason,
                    expectedVersion,
                    UUID.randomUUID().toString()
                )
            )
        }
    ) { DelegatedAdminResult(it.userId, it.capabilities, it.authorizationVersion) }

    override suspend fun revokeDelegatedAdmin(userId: String, reason: String, expectedVersion: Int): AppResult<Unit> =
        requestNoBody(
            "تعذر إلغاء الإدارة المفوضة",
            {
                api.revokeDelegatedAdmin(
                    userId,
                    DelegatedAdminRevokeRequestDto(
                        reason = reason,
                        expectedVersion = expectedVersion,
                        idempotencyKey = UUID.randomUUID().toString()
                    )
                )
            }
        )

    override suspend fun listDepartmentManagers(departmentId: String) = request(
        "تعذر تحميل مديري القسم",
        { api.getDepartmentManagers(departmentId) }
    ) { rows -> rows.map { it.toDomain() } }

    override suspend fun assignDepartmentManager(
        departmentId: String,
        userId: String,
        reason: String,
        expectedVersion: Int
    ) = request(
        "تعذر تعيين مدير القسم",
        {
            api.assignDepartmentManager(
                departmentId,
                DepartmentManagerRequestDto(userId, reason, expectedVersion)
            )
        }
    ) { it.toDomain() }

    override suspend fun revokeDepartmentManager(
        departmentId: String,
        userId: String,
        reason: String,
        expectedVersion: Int
    ): AppResult<Unit> = requestNoBody(
        "تعذر إنهاء تعيين مدير القسم",
        {
            api.revokeDepartmentManager(
                departmentId,
                userId,
                DepartmentManagerRequestDto(reason = reason, expectedAuthorizationVersion = expectedVersion)
            )
        }
    )
}
