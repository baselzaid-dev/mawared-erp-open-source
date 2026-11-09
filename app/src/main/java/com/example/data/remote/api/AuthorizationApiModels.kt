package com.example.data.remote.api

import com.squareup.moshi.JsonClass

@JsonClass(generateAdapter = true)
data class AuthorizationScopeDto(val scopeType: String, val departmentId: String? = null)

@JsonClass(generateAdapter = true)
data class EffectiveCapabilityDto(
    val capability: String,
    val scopeType: String,
    val departmentId: String? = null,
    val source: String,
    val validUntil: String? = null
)

@JsonClass(generateAdapter = true)
data class EffectiveAuthorizationDto(
    val userId: String,
    val authorizationVersion: Int,
    val isPrimaryOwner: Boolean,
    val managedDepartmentIds: List<String> = emptyList(),
    val capabilities: List<EffectiveCapabilityDto> = emptyList(),
    val flatPermissions: List<String> = emptyList(),
    val idempotent: Boolean? = null
)

@JsonClass(generateAdapter = true)
data class ManageablePrincipalDto(
    val userId: String,
    val employeeId: String? = null,
    val name: String,
    val departmentId: String? = null,
    val authorizationVersion: Int,
    val managedDepartmentIds: List<String> = emptyList()
)

@JsonClass(generateAdapter = true)
data class GrantablePermissionsDto(
    val targetUserId: String,
    val targetAuthorizationVersion: Int,
    val scope: AuthorizationScopeDto,
    val capabilities: List<String> = emptyList()
)

@JsonClass(generateAdapter = true)
data class PermissionOperationDto(
    val action: String,
    val capability: String,
    val scopeType: String,
    val departmentId: String? = null
)

@JsonClass(generateAdapter = true)
data class PermissionPreviewRequestDto(
    val targetUserId: String,
    val expectedAuthorizationVersion: Int,
    val reason: String,
    val operations: List<PermissionOperationDto>
)

@JsonClass(generateAdapter = true)
data class PermissionPreviewChangeDto(
    val action: String,
    val capability: String,
    val scopeType: String,
    val departmentId: String? = null,
    val before: String,
    val after: String
)

@JsonClass(generateAdapter = true)
data class PermissionPreviewDto(
    val previewId: String,
    val previewDigest: String,
    val expiresInSeconds: Int,
    val targetUserId: String,
    val expectedAuthorizationVersion: Int,
    val changes: List<PermissionPreviewChangeDto> = emptyList()
)

@JsonClass(generateAdapter = true)
data class PermissionApplyRequestDto(val previewId: String, val idempotencyKey: String)

@JsonClass(generateAdapter = true)
data class TemporaryDelegationDto(
    val id: String,
    val delegatorUserId: String? = null,
    val recipientUserId: String,
    val scopeType: String,
    val departmentId: String? = null,
    val validFrom: String,
    val validUntil: String,
    val status: String,
    val revokedAt: String? = null,
    val createdAt: String? = null,
    val effective: Boolean = false,
    val capabilities: List<String> = emptyList()
)

@JsonClass(generateAdapter = true)
data class DelegationCreateRequestDto(
    val recipientUserId: String,
    val capabilities: List<String>,
    val scopeType: String,
    val departmentId: String? = null,
    val validFrom: String,
    val validUntil: String,
    val reason: String,
    val expectedAuthorizationVersion: Int,
    val idempotencyKey: String
)

@JsonClass(generateAdapter = true)
data class DelegationRevokeRequestDto(val reason: String, val expectedAuthorizationVersion: Int)

@JsonClass(generateAdapter = true)
data class OwnershipPreviewRequestDto(val targetUserId: String, val reason: String, val password: String)

@JsonClass(generateAdapter = true)
data class OwnershipTransferPreviewDto(
    val previewId: String,
    val previewDigest: String,
    val expiresInSeconds: Int,
    val confirmationText: String,
    val fromUserId: String,
    val target: ManageablePrincipalDto
)

@JsonClass(generateAdapter = true)
data class OwnershipApplyRequestDto(
    val previewId: String,
    val confirmationText: String,
    val expectedVersion: Int,
    val idempotencyKey: String
)

@JsonClass(generateAdapter = true)
data class OwnershipTransferResultDto(
    val transferId: String,
    val idempotent: Boolean,
    val owner: ManageablePrincipalDto? = null,
    val sessionsRevoked: Boolean
)

@JsonClass(generateAdapter = true)
data class DelegatedAdminRequestDto(
    val userId: String? = null,
    val capabilities: List<String> = emptyList(),
    val reason: String,
    val expectedVersion: Int,
    val idempotencyKey: String
)

@JsonClass(generateAdapter = true)
data class DelegatedAdminRevokeRequestDto(
    val reason: String,
    val expectedVersion: Int,
    val idempotencyKey: String
)

@JsonClass(generateAdapter = true)
data class DelegatedAdminResultDto(
    val userId: String,
    val capabilities: List<String> = emptyList(),
    val authorizationVersion: Int
)

@JsonClass(generateAdapter = true)
data class DepartmentManagerRequestDto(
    val userId: String? = null,
    val reason: String,
    val expectedAuthorizationVersion: Int
)

@JsonClass(generateAdapter = true)
data class DepartmentManagerDto(
    val id: String,
    val departmentId: String? = null,
    val userId: String,
    val employeeId: String? = null,
    val name: String? = null,
    val authorizationVersion: Int,
    val assignedAt: String
)

@JsonClass(generateAdapter = true)
data class AuthorizationErrorResponseDto(
    val error: String? = null,
    val message: String? = null,
    val messageKey: String? = null,
    val code: Int? = null
)
