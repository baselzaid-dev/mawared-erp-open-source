package com.example.domain.repository

import com.example.core.utils.AppResult
import com.example.domain.model.*

interface AuthorizationRepository {
    suspend fun loadEffective(): AppResult<EffectiveAuthorization>
    suspend fun loadManageablePrincipals(departmentId: String? = null): AppResult<List<ManageablePrincipal>>
    suspend fun loadGrantablePermissions(targetUserId: String, departmentId: String? = null): AppResult<GrantablePermissions>
    suspend fun previewPermissionChanges(
        targetUserId: String,
        expectedVersion: Int,
        reason: String,
        operations: List<PermissionOperation>
    ): AppResult<PermissionPreview>
    suspend fun applyPermissionChanges(previewId: String): AppResult<EffectiveAuthorization>
    suspend fun listDelegations(): AppResult<List<TemporaryDelegation>>
    suspend fun createDelegation(
        recipientUserId: String,
        capabilities: List<String>,
        scope: AuthorizationScope,
        validFrom: String,
        validUntil: String,
        reason: String,
        expectedVersion: Int
    ): AppResult<TemporaryDelegation>
    suspend fun revokeDelegation(id: String, reason: String, expectedVersion: Int): AppResult<TemporaryDelegation>
    suspend fun previewOwnershipTransfer(targetUserId: String, reason: String, password: String): AppResult<OwnershipTransferPreview>
    suspend fun applyOwnershipTransfer(preview: OwnershipTransferPreview, expectedVersion: Int): AppResult<OwnershipTransferResult>
    suspend fun createDelegatedAdmin(
        userId: String,
        capabilities: List<String>,
        reason: String,
        expectedVersion: Int
    ): AppResult<DelegatedAdminResult>
    suspend fun revokeDelegatedAdmin(userId: String, reason: String, expectedVersion: Int): AppResult<Unit>
    suspend fun listDepartmentManagers(departmentId: String): AppResult<List<DepartmentManagerAssignment>>
    suspend fun assignDepartmentManager(
        departmentId: String,
        userId: String,
        reason: String,
        expectedVersion: Int
    ): AppResult<DepartmentManagerAssignment>
    suspend fun revokeDepartmentManager(
        departmentId: String,
        userId: String,
        reason: String,
        expectedVersion: Int
    ): AppResult<Unit>
}
