package com.example.domain.repository

import com.example.core.utils.AppResult
import com.example.domain.model.*

interface CredentialRepository {
    suspend fun changeTemporaryPassword(
        request: ForcedPasswordChangeRequest
    ): AppResult<ForcedPasswordChangeResult>

    suspend fun createEmployeeCredential(
        employeeId: String,
        request: CreateEmployeeCredentialRequest
    ): AppResult<OneTimeCredential>

    suspend fun resetEmployeeCredential(
        employeeId: String,
        request: ResetEmployeeCredentialRequest
    ): AppResult<OneTimeCredential>

    suspend fun archiveEmployee(
        employeeId: String,
        request: EmployeeArchiveRequest
    ): AppResult<EmployeeArchiveResult>

    suspend fun reactivateEmployee(
        employeeId: String,
        request: EmployeeArchiveRequest
    ): AppResult<EmployeeArchiveResult>
}
