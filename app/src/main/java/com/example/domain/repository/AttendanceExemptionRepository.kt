package com.example.domain.repository

import com.example.core.utils.AppResult
import com.example.domain.model.AttendanceExemption
import com.example.domain.model.AttendanceExemptionCreateRequest
import com.example.domain.model.AttendanceExemptionPage
import com.example.domain.model.AttendanceExemptionRevokeRequest

interface AttendanceExemptionRepository {
    suspend fun listExemptions(
        status: String? = null,
        targetUserId: String? = null
    ): AppResult<AttendanceExemptionPage>

    suspend fun createExemption(
        request: AttendanceExemptionCreateRequest
    ): AppResult<AttendanceExemption>

    suspend fun revokeExemption(
        exemptionId: String,
        request: AttendanceExemptionRevokeRequest
    ): AppResult<AttendanceExemption>
}
