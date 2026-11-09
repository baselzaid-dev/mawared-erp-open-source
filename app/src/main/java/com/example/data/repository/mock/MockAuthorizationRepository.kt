package com.example.data.repository.mock

import com.example.core.permissions.Permissions
import com.example.core.utils.AppResult
import com.example.domain.model.*
import com.example.domain.repository.AuthorizationRepository
import java.util.UUID

class MockAuthorizationRepository : AuthorizationRepository {
    private val principal = ManageablePrincipal("demo-manager", "demo-employee", "مدير تجريبي", "demo-department", 1, emptyList())
    private val capabilities = listOf(
        Permissions.EMPLOYEES_PERMISSIONS_MANAGE,
        Permissions.PERMISSIONS_MANAGE_DEPARTMENT,
        Permissions.PERMISSIONS_DELEGATE_TEMPORARY,
        Permissions.TASKS_REVIEW
    )
    private val delegations = mutableListOf<TemporaryDelegation>()

    override suspend fun loadEffective() = AppResult.Success(
        EffectiveAuthorization("demo-owner", 1, true, listOf("demo-department"), emptyList())
    )

    override suspend fun loadManageablePrincipals(departmentId: String?) = AppResult.Success(listOf(principal))

    override suspend fun loadGrantablePermissions(targetUserId: String, departmentId: String?) = AppResult.Success(
        GrantablePermissions(
            targetUserId,
            principal.authorizationVersion,
            AuthorizationScope(if (departmentId == null) "company" else "department", departmentId),
            capabilities
        )
    )

    override suspend fun previewPermissionChanges(
        targetUserId: String,
        expectedVersion: Int,
        reason: String,
        operations: List<PermissionOperation>
    ) = AppResult.Success(
        PermissionPreview(
            "demo-preview-${UUID.randomUUID()}",
            UUID.randomUUID().toString(),
            600,
            targetUserId,
            expectedVersion,
            operations.map { PermissionPreviewChange(it.action, it.capability, it.scopeType, it.departmentId, "absent", "active") }
        )
    )

    override suspend fun applyPermissionChanges(previewId: String) = loadEffective()

    override suspend fun listDelegations() = AppResult.Success(delegations.toList())

    override suspend fun createDelegation(
        recipientUserId: String,
        capabilities: List<String>,
        scope: AuthorizationScope,
        validFrom: String,
        validUntil: String,
        reason: String,
        expectedVersion: Int
    ): AppResult<TemporaryDelegation> {
        val item = TemporaryDelegation(
            UUID.randomUUID().toString(),
            "demo-owner",
            recipientUserId,
            scope.scopeType,
            scope.departmentId,
            validFrom,
            validUntil,
            "active",
            null,
            validFrom,
            true,
            capabilities
        )
        delegations.add(0, item)
        return AppResult.Success(item)
    }

    override suspend fun revokeDelegation(id: String, reason: String, expectedVersion: Int): AppResult<TemporaryDelegation> {
        val index = delegations.indexOfFirst { it.id == id }
        val current = delegations.getOrNull(index)
            ?: return AppResult.Error(Exception("التفويض غير موجود"))
        val revoked = current.copy(status = "revoked", revokedAt = current.validFrom, effective = false)
        delegations[index] = revoked
        return AppResult.Success(revoked)
    }

    override suspend fun previewOwnershipTransfer(targetUserId: String, reason: String, password: String) = AppResult.Success(
        OwnershipTransferPreview(
            "demo-owner-preview-${UUID.randomUUID()}",
            UUID.randomUUID().toString(),
            600,
            "TRANSFER OWNERSHIP",
            "demo-owner",
            principal
        )
    )

    override suspend fun applyOwnershipTransfer(preview: OwnershipTransferPreview, expectedVersion: Int) = AppResult.Success(
        OwnershipTransferResult(UUID.randomUUID().toString(), false, preview.target, true)
    )

    override suspend fun createDelegatedAdmin(
        userId: String,
        capabilities: List<String>,
        reason: String,
        expectedVersion: Int
    ) = AppResult.Success(DelegatedAdminResult(userId, capabilities, expectedVersion + 1))

    override suspend fun revokeDelegatedAdmin(userId: String, reason: String, expectedVersion: Int) = AppResult.Success(Unit)

    override suspend fun listDepartmentManagers(departmentId: String) = AppResult.Success(
        listOf(DepartmentManagerAssignment("demo-membership", departmentId, principal.userId, principal.employeeId, principal.name, 1, "2026-01-01T00:00:00Z"))
    )

    override suspend fun assignDepartmentManager(
        departmentId: String,
        userId: String,
        reason: String,
        expectedVersion: Int
    ) = AppResult.Success(
        DepartmentManagerAssignment(UUID.randomUUID().toString(), departmentId, userId, null, principal.name, expectedVersion + 1, "2026-01-01T00:00:00Z")
    )

    override suspend fun revokeDepartmentManager(
        departmentId: String,
        userId: String,
        reason: String,
        expectedVersion: Int
    ) = AppResult.Success(Unit)
}
