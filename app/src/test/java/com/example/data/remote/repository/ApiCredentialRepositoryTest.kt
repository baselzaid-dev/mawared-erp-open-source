package com.example.data.remote.repository

import com.example.core.utils.AppResult
import com.example.data.remote.api.*
import com.example.domain.model.CreateEmployeeCredentialRequest
import com.example.domain.model.EmployeeArchiveRequest
import com.example.domain.model.ForcedPasswordChangeRequest
import com.example.domain.model.ResetEmployeeCredentialRequest
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

class ApiCredentialRepositoryTest {
    @Test
    fun `forced password change maps server result`() = runTest {
        val api = FakeCredentialApi()
        val repository = ApiCredentialRepository(api)

        val result = repository.changeTemporaryPassword(
            ForcedPasswordChangeRequest(
                temporaryPassword = "TempPass1234",
                newPassword = "NewSecurePass1",
                confirmPassword = "NewSecurePass1"
            )
        ) as AppResult.Success

        assertEquals("2026-07-19T12:00:00.000Z", result.data.changedAt)
        assertEquals(3, result.data.sessionsRevoked)
        assertEquals("TempPass1234", api.lastChangeRequest?.temporaryPassword)
    }

    @Test
    fun `create credential preserves one-time DTO fields`() = runTest {
        val api = FakeCredentialApi()
        val repository = ApiCredentialRepository(api)

        val result = repository.createEmployeeCredential(
            employeeId = "emp-1",
            request = CreateEmployeeCredentialRequest(email = "user@fixture-2.example.test")
        ) as AppResult.Success

        assertEquals("OneTimePass24", result.data.temporaryPassword)
        assertTrue(result.data.mustChangePassword)
        assertEquals(1, result.data.credentialVersion)
        assertEquals("user@fixture-2.example.test", api.lastCreateRequest?.email)
    }

    @Test
    fun `reset credential forwards expected version`() = runTest {
        val api = FakeCredentialApi()
        val repository = ApiCredentialRepository(api)

        repository.resetEmployeeCredential(
            employeeId = "emp-1",
            request = ResetEmployeeCredentialRequest(
                reason = "lost device access",
                expectedCredentialVersion = 4
            )
        )

        assertEquals(4, api.lastResetRequest?.expectedCredentialVersion)
        assertEquals("lost device access", api.lastResetRequest?.reason)
    }

    @Test
    fun `archive maps employee response`() = runTest {
        val api = FakeCredentialApi()
        val repository = ApiCredentialRepository(api)

        val result = repository.archiveEmployee(
            employeeId = "emp-1",
            request = EmployeeArchiveRequest(
                reason = "contract ended",
                expectedUpdatedAt = "2026-07-19T10:00:00.000Z"
            )
        ) as AppResult.Success

        assertEquals("emp-1", result.data.employeeId)
        assertEquals("archived", result.data.accountStatus)
        assertEquals("contract ended", api.lastArchiveRequest?.reason)
    }

    @Test
    fun `stale credential version surfaces message key`() = runTest {
        val api = FakeCredentialApi()
        api.resetResponse = Response.error(
            412,
            """{"messageKey":"credentials.stale_credential_version"}"""
                .toResponseBody("application/json".toMediaType())
        )
        val repository = ApiCredentialRepository(api)

        val result = repository.resetEmployeeCredential(
            employeeId = "emp-1",
            request = ResetEmployeeCredentialRequest(
                reason = "rotation required",
                expectedCredentialVersion = 1
            )
        ) as AppResult.Error

        assertEquals("credentials.stale_credential_version", result.exception.message)
    }

    private class FakeCredentialApi : CredentialApi {
        var lastChangeRequest: ChangeTemporaryPasswordRequestDto? = null
        var lastCreateRequest: CreateEmployeeCredentialRequestDto? = null
        var lastResetRequest: ResetEmployeeCredentialRequestDto? = null
        var lastArchiveRequest: EmployeeArchiveRequestDto? = null
        var resetResponse: Response<OneTimeCredentialDto> = Response.success(
            OneTimeCredentialDto(
                temporaryPassword = "ResetPass24",
                mustChangePassword = true,
                expiresAt = "2026-07-20T12:00:00.000Z",
                credentialVersion = 5
            )
        )

        override suspend fun changeTemporaryPassword(
            request: ChangeTemporaryPasswordRequestDto
        ): Response<ChangeTemporaryPasswordResultDto> {
            lastChangeRequest = request
            return Response.success(
                ChangeTemporaryPasswordResultDto(
                    changedAt = "2026-07-19T12:00:00.000Z",
                    sessionsRevoked = 3
                )
            )
        }

        override suspend fun createEmployeeCredential(
            employeeId: String,
            request: CreateEmployeeCredentialRequestDto
        ): Response<OneTimeCredentialDto> {
            lastCreateRequest = request
            return Response.success(
                OneTimeCredentialDto(
                    temporaryPassword = "OneTimePass24",
                    mustChangePassword = true,
                    expiresAt = "2026-07-20T12:00:00.000Z",
                    credentialVersion = 1
                )
            )
        }

        override suspend fun resetEmployeeCredential(
            employeeId: String,
            request: ResetEmployeeCredentialRequestDto
        ): Response<OneTimeCredentialDto> {
            lastResetRequest = request
            return resetResponse
        }

        override suspend fun archiveEmployee(
            employeeId: String,
            request: EmployeeArchiveRequestDto
        ): Response<EmployeeArchiveResponseDto> {
            lastArchiveRequest = request
            return Response.success(
                EmployeeArchiveResponseDto(
                    id = employeeId,
                    archivedAt = "2026-07-19T11:00:00.000Z",
                    archiveReason = request.reason,
                    updatedAt = "2026-07-19T11:00:00.000Z",
                    user = EmployeeArchiveUserDto(accountStatus = "archived")
                )
            )
        }

        override suspend fun reactivateEmployee(
            employeeId: String,
            request: EmployeeArchiveRequestDto
        ): Response<EmployeeArchiveResponseDto> = Response.success(
            EmployeeArchiveResponseDto(
                id = employeeId,
                archivedAt = null,
                archiveReason = null,
                updatedAt = "2026-07-19T12:00:00.000Z",
                user = EmployeeArchiveUserDto(accountStatus = "active")
            )
        )
    }
}
