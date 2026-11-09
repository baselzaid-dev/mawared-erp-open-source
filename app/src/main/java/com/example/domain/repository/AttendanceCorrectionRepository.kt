package com.example.domain.repository

import com.example.core.utils.AppResult
import com.example.domain.model.AttendanceCorrection
import com.example.domain.model.AttendanceCorrectionCreateRequest
import com.example.domain.model.AttendanceCorrectionDecisionRequest
import com.example.domain.model.AttendanceCorrectionDecisionResult
import com.example.domain.model.AttendanceCorrectionPage

interface AttendanceCorrectionRepository {
    suspend fun createCorrection(
        attendanceId: String,
        request: AttendanceCorrectionCreateRequest
    ): AppResult<AttendanceCorrection>

    suspend fun listCorrections(
        status: String? = null,
        employeeId: String? = null,
        cursor: String? = null,
        limit: Int? = null
    ): AppResult<AttendanceCorrectionPage>

    suspend fun decideCorrection(
        correctionId: String,
        request: AttendanceCorrectionDecisionRequest
    ): AppResult<AttendanceCorrectionDecisionResult>
}
