package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.*
import com.example.domain.model.*
import com.example.domain.repository.CredentialRepository
import com.squareup.moshi.Moshi
import retrofit2.Response

class ApiCredentialRepository(
    private val api: CredentialApi
) : CredentialRepository {

    private val errorAdapter = Moshi.Builder().build().adapter(CredentialErrorResponseDto::class.java)

    private fun OneTimeCredentialDto.toDomain() = OneTimeCredential(
        temporaryPassword = temporaryPassword,
        mustChangePassword = mustChangePassword,
        expiresAt = expiresAt,
        credentialVersion = credentialVersion
    )

    private fun ChangeTemporaryPasswordResultDto.toDomain() = ForcedPasswordChangeResult(
        changedAt = changedAt,
        sessionsRevoked = sessionsRevoked
    )

    private fun EmployeeArchiveResponseDto.toDomain() = EmployeeArchiveResult(
        employeeId = id,
        archivedAt = archivedAt,
        archiveReason = archiveReason,
        updatedAt = updatedAt,
        accountStatus = user?.accountStatus
    )

    private fun <T> responseError(response: Response<T>, fallback: String): AppResult.Error {
        val payload = try {
            response.errorBody()?.string()?.let(errorAdapter::fromJson)
        } catch (_: Exception) {
            null
        }
        val message = payload?.messageKey?.takeIf(String::isNotBlank)
            ?: payload?.message?.takeIf(String::isNotBlank)
            ?: fallback
        val appError = when (response.code()) {
            401 -> AppError.Unauthorized
            403 -> AppError.Forbidden
            400, 409, 412 -> AppError.ValidationError(message)
            else -> AppError.ServerError(response.code(), message)
        }
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

    override suspend fun changeTemporaryPassword(
        request: ForcedPasswordChangeRequest
    ): AppResult<ForcedPasswordChangeResult> = request(
        fallback = "تعذر تغيير كلمة المرور",
        call = {
            api.changeTemporaryPassword(
                ChangeTemporaryPasswordRequestDto(
                    temporaryPassword = request.temporaryPassword,
                    newPassword = request.newPassword,
                    confirmPassword = request.confirmPassword
                )
            )
        },
        map = { it.toDomain() }
    )

    override suspend fun createEmployeeCredential(
        employeeId: String,
        request: CreateEmployeeCredentialRequest
    ): AppResult<OneTimeCredential> = request(
        fallback = "تعذر إنشاء بيانات الدخول",
        call = {
            api.createEmployeeCredential(
                employeeId,
                CreateEmployeeCredentialRequestDto(email = request.email.trim())
            )
        },
        map = { it.toDomain() }
    )

    override suspend fun resetEmployeeCredential(
        employeeId: String,
        request: ResetEmployeeCredentialRequest
    ): AppResult<OneTimeCredential> = request(
        fallback = "تعذر إعادة تعيين كلمة المرور",
        call = {
            api.resetEmployeeCredential(
                employeeId,
                ResetEmployeeCredentialRequestDto(
                    reason = request.reason.trim(),
                    expectedCredentialVersion = request.expectedCredentialVersion
                )
            )
        },
        map = { it.toDomain() }
    )

    override suspend fun archiveEmployee(
        employeeId: String,
        request: EmployeeArchiveRequest
    ): AppResult<EmployeeArchiveResult> = request(
        fallback = "تعذر أرشفة الموظف",
        call = {
            api.archiveEmployee(
                employeeId,
                EmployeeArchiveRequestDto(
                    reason = request.reason.trim(),
                    expectedUpdatedAt = request.expectedUpdatedAt
                )
            )
        },
        map = { it.toDomain() }
    )

    override suspend fun reactivateEmployee(
        employeeId: String,
        request: EmployeeArchiveRequest
    ): AppResult<EmployeeArchiveResult> = request(
        fallback = "تعذر إعادة تفعيل الموظف",
        call = {
            api.reactivateEmployee(
                employeeId,
                EmployeeArchiveRequestDto(
                    reason = request.reason.trim(),
                    expectedUpdatedAt = request.expectedUpdatedAt
                )
            )
        },
        map = { it.toDomain() }
    )
}
