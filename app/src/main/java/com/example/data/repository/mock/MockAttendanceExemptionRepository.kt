package com.example.data.repository.mock

import com.example.core.utils.AppResult
import com.example.domain.model.AttendanceExemption
import com.example.domain.model.AttendanceExemptionCreateRequest
import com.example.domain.model.AttendanceExemptionPage
import com.example.domain.model.AttendanceExemptionReasonCategory
import com.example.domain.model.AttendanceExemptionRevokeRequest
import com.example.domain.model.AttendanceExemptionStatus
import com.example.domain.repository.AttendanceExemptionRepository
import java.util.UUID

class MockAttendanceExemptionRepository : AttendanceExemptionRepository {
    private val exemptions = mutableListOf(
        AttendanceExemption(
            id = "demo-exemption-1",
            userId = "demo-employee-user",
            employeeId = "demo-employee",
            validFrom = "2026-07-01T00:00:00.000Z",
            validUntil = "2026-12-31T23:59:59.000Z",
            reasonCategory = AttendanceExemptionReasonCategory.FIELD_ASSIGNMENT,
            note = "مهمة ميدانية طويلة",
            status = AttendanceExemptionStatus.ACTIVE,
            version = 1,
            createdAt = "2026-07-01T08:00:00.000Z",
            revokedAt = null
        ),
        AttendanceExemption(
            id = "demo-exemption-2",
            userId = "demo-manager-user",
            employeeId = "demo-manager",
            validFrom = "2026-01-01T00:00:00.000Z",
            validUntil = null,
            reasonCategory = AttendanceExemptionReasonCategory.ADMIN_ACCOUNT,
            note = null,
            status = AttendanceExemptionStatus.REVOKED,
            version = 2,
            createdAt = "2026-01-01T08:00:00.000Z",
            revokedAt = "2026-06-01T10:00:00.000Z"
        )
    )

    var failRevoke: Boolean = false
    var failCreate: Boolean = false
    var failList: Boolean = false

    override suspend fun listExemptions(
        status: String?,
        targetUserId: String?
    ): AppResult<AttendanceExemptionPage> {
        if (failList) {
            return AppResult.Error(Exception("attendance.network_error"))
        }
        val filtered = status?.let { filterStatus ->
            exemptions.filter { it.status.apiValue == filterStatus }
        } ?: exemptions.toList()
        return AppResult.Success(AttendanceExemptionPage(items = filtered))
    }

    override suspend fun createExemption(
        request: AttendanceExemptionCreateRequest
    ): AppResult<AttendanceExemption> {
        if (failCreate) {
            return AppResult.Error(Exception("attendance.exemption_overlap"))
        }
        val created = AttendanceExemption(
            id = "demo-exemption-${UUID.randomUUID()}",
            userId = request.targetUserId,
            employeeId = null,
            validFrom = request.validFrom,
            validUntil = request.validUntil,
            reasonCategory = request.reasonCategory,
            note = request.note,
            status = AttendanceExemptionStatus.ACTIVE,
            version = 1,
            createdAt = request.validFrom,
            revokedAt = null
        )
        exemptions.add(0, created)
        return AppResult.Success(created)
    }

    override suspend fun revokeExemption(
        exemptionId: String,
        request: AttendanceExemptionRevokeRequest
    ): AppResult<AttendanceExemption> {
        if (failRevoke) {
            return AppResult.Error(Exception("attendance.version_mismatch"))
        }
        val index = exemptions.indexOfFirst { it.id == exemptionId }
        if (index < 0) {
            return AppResult.Error(Exception("attendance.not_found"))
        }
        val current = exemptions[index]
        if (current.version != request.expectedVersion) {
            return AppResult.Error(Exception("attendance.version_mismatch"))
        }
        val revoked = current.copy(
            status = AttendanceExemptionStatus.REVOKED,
            version = current.version + 1,
            revokedAt = "2026-07-19T12:00:00.000Z"
        )
        exemptions[index] = revoked
        return AppResult.Success(revoked)
    }
}
