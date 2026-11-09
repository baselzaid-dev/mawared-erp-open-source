package com.example.domain.model

data class OneTimeCredential(
    val temporaryPassword: String,
    val mustChangePassword: Boolean = true,
    val expiresAt: String,
    val credentialVersion: Int
)

data class SessionSummary(
    val sessionId: String,
    val deviceLabel: String?,
    val platform: String?,
    val createdAt: String,
    val lastUsedAt: String?,
    val revokedAt: String?,
    val isCurrent: Boolean,
    val isLegacyDevice: Boolean
) {
    val isActive: Boolean get() = revokedAt.isNullOrBlank()
}

data class ForcedPasswordChangeRequest(
    val temporaryPassword: String,
    val newPassword: String,
    val confirmPassword: String
)

data class ForcedPasswordChangeResult(
    val changedAt: String,
    val sessionsRevoked: Int
)

data class CreateEmployeeCredentialRequest(
    val email: String
)

data class ResetEmployeeCredentialRequest(
    val reason: String,
    val expectedCredentialVersion: Int
)

data class EmployeeArchiveRequest(
    val reason: String,
    val expectedUpdatedAt: String
)

data class EmployeeArchiveResult(
    val employeeId: String,
    val archivedAt: String?,
    val archiveReason: String?,
    val updatedAt: String,
    val accountStatus: String?
)

data class RevokeAllSessionsRequest(
    val exceptCurrent: Boolean = true
)

data class RevokeAllSessionsResult(
    val revokedCount: Int
)

/** Public company Primary Owner recovery initiate (enumeration-safe). */
data class OwnerRecoveryInitiateRequest(
    val companyCode: String,
    val ownerEmail: String
)

data class OwnerRecoveryInitiateResult(
    val status: String,
    val requestId: String
)

/** Public company Primary Owner recovery confirm — does not establish a session. */
data class OwnerRecoveryConfirmRequest(
    val resetToken: String,
    val newPassword: String
)

data class OwnerRecoveryConfirmResult(
    val status: String,
    val requestId: String
)
