package com.example.data.repository.mock

import com.example.core.utils.AppResult
import com.example.domain.model.*
import com.example.domain.repository.AttendanceCorrectionRepository
import java.util.UUID

class MockAttendanceCorrectionRepository : AttendanceCorrectionRepository {
    private val corrections = mutableListOf(
        AttendanceCorrection(
            id = "corr-demo-1",
            attendanceId = "att-demo-1",
            employeeId = "emp-demo-1",
            requestedByUserId = "user-demo-employee",
            requestedClockIn = "2026-07-19T08:00:00.000Z",
            requestedClockOut = null,
            reason = "نسيت تسجيل الحضور صباحاً",
            status = AttendanceCorrectionStatus.PENDING,
            version = 1,
            reviewedAt = null,
            decisionReason = null,
            createdAt = "2026-07-19T09:00:00.000Z",
            updatedAt = "2026-07-19T09:00:00.000Z"
        ),
        AttendanceCorrection(
            id = "corr-demo-2",
            attendanceId = "att-demo-2",
            employeeId = "emp-demo-2",
            requestedByUserId = "user-demo-employee-2",
            requestedClockIn = null,
            requestedClockOut = "2026-07-18T17:30:00.000Z",
            reason = "انقطع الاتصال قبل تسجيل الانصراف",
            status = AttendanceCorrectionStatus.APPROVED,
            version = 2,
            reviewedAt = "2026-07-18T18:00:00.000Z",
            decisionReason = "تم التحقق من سجل الدخول",
            createdAt = "2026-07-18T17:45:00.000Z",
            updatedAt = "2026-07-18T18:00:00.000Z"
        )
    )

    override suspend fun createCorrection(
        attendanceId: String,
        request: AttendanceCorrectionCreateRequest
    ): AppResult<AttendanceCorrection> {
        if (request.reason.isBlank()) {
            return AppResult.Error(
                Exception("attendance.invalid_reason"),
                com.example.core.utils.AppError.ValidationError("attendance.invalid_reason")
            )
        }
        val pending = corrections.any {
            it.attendanceId == attendanceId && it.status == AttendanceCorrectionStatus.PENDING
        }
        if (pending) {
            return AppResult.Error(
                Exception("attendance.pending_correction_exists"),
                com.example.core.utils.AppError.ValidationError("attendance.pending_correction_exists")
            )
        }
        val created = AttendanceCorrection(
            id = "corr-${UUID.randomUUID()}",
            attendanceId = attendanceId,
            employeeId = "emp-demo-1",
            requestedByUserId = "user-demo-employee",
            requestedClockIn = request.clockIn,
            requestedClockOut = request.clockOut,
            reason = request.reason,
            status = AttendanceCorrectionStatus.PENDING,
            version = 1,
            reviewedAt = null,
            decisionReason = null,
            createdAt = "2026-07-19T10:00:00.000Z",
            updatedAt = "2026-07-19T10:00:00.000Z"
        )
        corrections.add(0, created)
        return AppResult.Success(created)
    }

    override suspend fun listCorrections(
        status: String?,
        employeeId: String?,
        cursor: String?,
        limit: Int?
    ): AppResult<AttendanceCorrectionPage> {
        var rows = corrections.toList()
        if (status != null) {
            val filter = AttendanceCorrectionStatus.fromApi(status)
            rows = rows.filter { it.status == filter }
        }
        if (employeeId != null) {
            rows = rows.filter { it.employeeId == employeeId }
        }
        val pageSize = limit ?: 50
        val startIndex = cursor?.toIntOrNull() ?: 0
        val slice = rows.drop(startIndex).take(pageSize)
        val nextIndex = startIndex + slice.size
        val hasMore = nextIndex < rows.size
        return AppResult.Success(
            AttendanceCorrectionPage(
                items = slice,
                nextCursor = if (hasMore) nextIndex.toString() else null,
                hasMore = hasMore
            )
        )
    }

    override suspend fun decideCorrection(
        correctionId: String,
        request: AttendanceCorrectionDecisionRequest
    ): AppResult<AttendanceCorrectionDecisionResult> {
        val index = corrections.indexOfFirst { it.id == correctionId }
        if (index < 0) {
            return AppResult.Error(
                Exception("attendance.not_found"),
                com.example.core.utils.AppError.ValidationError("attendance.not_found")
            )
        }
        val current = corrections[index]
        if (current.status != AttendanceCorrectionStatus.PENDING) {
            return AppResult.Error(
                Exception("attendance.correction_already_decided"),
                com.example.core.utils.AppError.ValidationError("attendance.correction_already_decided")
            )
        }
        if (current.version != request.expectedVersion) {
            return AppResult.Error(
                Exception("attendance.version_mismatch"),
                com.example.core.utils.AppError.ValidationError("attendance.version_mismatch")
            )
        }
        val nextStatus = when (request.decision) {
            AttendanceCorrectionDecision.ACCEPT -> AttendanceCorrectionStatus.APPROVED
            AttendanceCorrectionDecision.REJECT -> AttendanceCorrectionStatus.REJECTED
        }
        val updated = current.copy(
            status = nextStatus,
            version = current.version + 1,
            reviewedAt = "2026-07-19T11:00:00.000Z",
            decisionReason = request.reason,
            updatedAt = "2026-07-19T11:00:00.000Z"
        )
        corrections[index] = updated
        return AppResult.Success(
            AttendanceCorrectionDecisionResult(
                correction = updated,
                updatedAttendanceVersion = request.expectedVersion + 1
            )
        )
    }
}
