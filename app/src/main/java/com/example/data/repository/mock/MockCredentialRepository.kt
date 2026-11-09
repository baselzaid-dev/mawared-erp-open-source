package com.example.data.repository.mock

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.domain.model.*
import com.example.domain.repository.CredentialRepository
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class MockCredentialRepository : CredentialRepository {
    private var credentialVersion = 1

    override suspend fun changeTemporaryPassword(
        request: ForcedPasswordChangeRequest
    ): AppResult<ForcedPasswordChangeResult> {
        if (request.newPassword != request.confirmPassword) {
            return AppResult.Error(
                Exception("password.confirm_mismatch"),
                AppError.ValidationError("password.confirm_mismatch")
            )
        }
        if (request.newPassword.length < 10) {
            return AppResult.Error(
                Exception("password.too_short"),
                AppError.ValidationError("password.too_short")
            )
        }
        if (request.temporaryPassword != DEMO_TEMP_PASSWORD) {
            return AppResult.Error(
                Exception("auth.temporary_password_invalid"),
                AppError.Unauthorized
            )
        }
        credentialVersion += 1
        return AppResult.Success(
            ForcedPasswordChangeResult(
                changedAt = mockIsoTimestamp(),
                sessionsRevoked = 2
            )
        )
    }

    override suspend fun createEmployeeCredential(
        employeeId: String,
        request: CreateEmployeeCredentialRequest
    ): AppResult<OneTimeCredential> {
        if (request.email.isBlank()) {
            return AppResult.Error(
                Exception("employees.invalid_request"),
                AppError.ValidationError("employees.invalid_request")
            )
        }
        credentialVersion = 1
        return AppResult.Success(demoCredential())
    }

    override suspend fun resetEmployeeCredential(
        employeeId: String,
        request: ResetEmployeeCredentialRequest
    ): AppResult<OneTimeCredential> {
        if (request.reason.length < 3) {
            return AppResult.Error(
                Exception("credentials.invalid_request"),
                AppError.ValidationError("credentials.invalid_request")
            )
        }
        if (request.expectedCredentialVersion != credentialVersion) {
            return AppResult.Error(
                Exception("credentials.stale_credential_version"),
                AppError.ValidationError("credentials.stale_credential_version")
            )
        }
        credentialVersion += 1
        return AppResult.Success(demoCredential())
    }

    override suspend fun archiveEmployee(
        employeeId: String,
        request: EmployeeArchiveRequest
    ): AppResult<EmployeeArchiveResult> {
        if (request.reason.length < 3) {
            return AppResult.Error(
                Exception("employees.invalid_request"),
                AppError.ValidationError("employees.invalid_request")
            )
        }
        val now = mockIsoTimestamp()
        return AppResult.Success(
            EmployeeArchiveResult(
                employeeId = employeeId,
                archivedAt = now,
                archiveReason = request.reason,
                updatedAt = now,
                accountStatus = "archived"
            )
        )
    }

    override suspend fun reactivateEmployee(
        employeeId: String,
        request: EmployeeArchiveRequest
    ): AppResult<EmployeeArchiveResult> {
        if (request.reason.length < 3) {
            return AppResult.Error(
                Exception("employees.invalid_request"),
                AppError.ValidationError("employees.invalid_request")
            )
        }
        val now = mockIsoTimestamp()
        return AppResult.Success(
            EmployeeArchiveResult(
                employeeId = employeeId,
                archivedAt = null,
                archiveReason = null,
                updatedAt = now,
                accountStatus = "active"
            )
        )
    }

    private fun demoCredential() = OneTimeCredential(
        temporaryPassword = "DemoTempPass24",
        mustChangePassword = true,
        expiresAt = mockIsoTimestamp(System.currentTimeMillis() + 86_400_000L),
        credentialVersion = credentialVersion
    )

    companion object {
        const val DEMO_TEMP_PASSWORD = "TempPass1234"

        private fun mockIsoTimestamp(atMillis: Long = System.currentTimeMillis()): String =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }.format(Date(atMillis))
    }
}
