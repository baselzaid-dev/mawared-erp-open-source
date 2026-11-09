package com.example.data.remote.api

import com.squareup.moshi.JsonClass
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST
import retrofit2.http.Path

@JsonClass(generateAdapter = true)
data class ChangeTemporaryPasswordRequestDto(
    val temporaryPassword: String,
    val newPassword: String,
    val confirmPassword: String
)

@JsonClass(generateAdapter = true)
data class ChangeTemporaryPasswordResultDto(
    val changedAt: String,
    val sessionsRevoked: Int
)

@JsonClass(generateAdapter = true)
data class OneTimeCredentialDto(
    val temporaryPassword: String,
    val mustChangePassword: Boolean = true,
    val expiresAt: String,
    val credentialVersion: Int
)

@JsonClass(generateAdapter = true)
data class CreateEmployeeCredentialRequestDto(
    val email: String
)

@JsonClass(generateAdapter = true)
data class ResetEmployeeCredentialRequestDto(
    val reason: String,
    val expectedCredentialVersion: Int
)

@JsonClass(generateAdapter = true)
data class EmployeeArchiveRequestDto(
    val reason: String,
    val expectedUpdatedAt: String
)

@JsonClass(generateAdapter = true)
data class EmployeeArchiveResponseDto(
    val id: String,
    val archivedAt: String? = null,
    val archiveReason: String? = null,
    val updatedAt: String,
    val user: EmployeeArchiveUserDto? = null
)

@JsonClass(generateAdapter = true)
data class EmployeeArchiveUserDto(
    val accountStatus: String? = null
)

@JsonClass(generateAdapter = true)
data class CredentialErrorResponseDto(
    val messageKey: String? = null,
    val message: String? = null,
    val code: String? = null
)

interface CredentialApi {
    @POST("/api/v2/auth/change-temporary-password")
    suspend fun changeTemporaryPassword(
        @Body request: ChangeTemporaryPasswordRequestDto
    ): Response<ChangeTemporaryPasswordResultDto>

    @POST("/api/v2/employees/{id}/credentials")
    suspend fun createEmployeeCredential(
        @Path("id") employeeId: String,
        @Body request: CreateEmployeeCredentialRequestDto
    ): Response<OneTimeCredentialDto>

    @POST("/api/v2/employees/{id}/credentials/reset")
    suspend fun resetEmployeeCredential(
        @Path("id") employeeId: String,
        @Body request: ResetEmployeeCredentialRequestDto
    ): Response<OneTimeCredentialDto>

    @POST("/api/v2/employees/{id}/archive")
    suspend fun archiveEmployee(
        @Path("id") employeeId: String,
        @Body request: EmployeeArchiveRequestDto
    ): Response<EmployeeArchiveResponseDto>

    @POST("/api/v2/employees/{id}/reactivate")
    suspend fun reactivateEmployee(
        @Path("id") employeeId: String,
        @Body request: EmployeeArchiveRequestDto
    ): Response<EmployeeArchiveResponseDto>
}
