package com.example.domain.model

data class AuthorizationScope(
    val scopeType: String,
    val departmentId: String? = null
)

data class EffectiveCapability(
    val capability: String,
    val scopeType: String,
    val departmentId: String? = null,
    val source: String,
    val validUntil: String? = null
)

data class EffectiveAuthorization(
    val userId: String,
    val authorizationVersion: Int,
    val isPrimaryOwner: Boolean,
    val managedDepartmentIds: List<String>,
    val capabilities: List<EffectiveCapability>,
    val flatPermissions: List<String> = emptyList()
)

data class ManageablePrincipal(
    val userId: String,
    val employeeId: String?,
    val name: String,
    val departmentId: String?,
    val authorizationVersion: Int,
    val managedDepartmentIds: List<String>
)

data class GrantablePermissions(
    val targetUserId: String,
    val targetAuthorizationVersion: Int,
    val scope: AuthorizationScope,
    val capabilities: List<String>
)

data class PermissionOperation(
    val action: String,
    val capability: String,
    val scopeType: String,
    val departmentId: String? = null
)

data class PermissionPreviewChange(
    val action: String,
    val capability: String,
    val scopeType: String,
    val departmentId: String?,
    val before: String,
    val after: String
)

data class PermissionPreview(
    val previewId: String,
    val previewDigest: String,
    val expiresInSeconds: Int,
    val targetUserId: String,
    val expectedAuthorizationVersion: Int,
    val changes: List<PermissionPreviewChange>
)

data class TemporaryDelegation(
    val id: String,
    val delegatorUserId: String,
    val recipientUserId: String,
    val scopeType: String,
    val departmentId: String?,
    val validFrom: String,
    val validUntil: String,
    val status: String,
    val revokedAt: String?,
    val createdAt: String?,
    val effective: Boolean,
    val capabilities: List<String>
)

data class OwnershipTransferPreview(
    val previewId: String,
    val previewDigest: String,
    val expiresInSeconds: Int,
    val confirmationText: String,
    val fromUserId: String,
    val target: ManageablePrincipal
)

data class OwnershipTransferResult(
    val transferId: String,
    val idempotent: Boolean,
    val owner: ManageablePrincipal?,
    val sessionsRevoked: Boolean
)

data class DepartmentManagerAssignment(
    val id: String,
    val departmentId: String? = null,
    val userId: String,
    val employeeId: String? = null,
    val name: String? = null,
    val authorizationVersion: Int,
    val assignedAt: String
)

data class DelegatedAdminResult(
    val userId: String,
    val capabilities: List<String>,
    val authorizationVersion: Int
)
