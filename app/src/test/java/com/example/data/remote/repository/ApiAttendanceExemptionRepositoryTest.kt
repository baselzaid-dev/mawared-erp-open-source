package com.example.data.remote.repository

import com.example.core.utils.AppResult
import com.example.data.remote.api.AttendanceApi
import com.example.data.remote.api.AttendanceCorrectionCreateRequestDto
import com.example.data.remote.api.AttendanceCorrectionDecisionRequestDto
import com.example.data.remote.api.AttendanceCorrectionDecisionResponseDto
import com.example.data.remote.api.AttendanceCorrectionDto
import com.example.data.remote.api.AttendanceCorrectionListDto
import com.example.data.remote.api.AttendanceDto
import com.example.data.remote.api.AttendanceEligibleEmployeeDto
import com.example.data.remote.api.AttendanceExemptionCreateRequestDto
import com.example.data.remote.api.AttendanceExemptionDto
import com.example.data.remote.api.AttendanceExemptionListDto
import com.example.data.remote.api.AttendanceExemptionRevokeRequestDto
import com.example.data.remote.api.ManualAttendanceRequestDto
import com.example.domain.model.AttendanceExemptionCreateRequest
import com.example.domain.model.AttendanceExemptionReasonCategory
import com.example.domain.model.AttendanceExemptionRevokeRequest
import com.example.domain.model.AttendanceExemptionStatus
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

class ApiAttendanceExemptionRepositoryTest {
    @Test
    fun `list maps reason category period and status`() = runTest {
        val api = FakeAttendanceExemptionApi()
        val repository = ApiAttendanceExemptionRepository(api)

        val result = repository.listExemptions(status = "active") as AppResult.Success

        assertEquals("active", api.lastListStatus)
        val item = result.data.items.single()
        assertEquals(AttendanceExemptionReasonCategory.REMOTE_WORK, item.reasonCategory)
        assertEquals(AttendanceExemptionStatus.ACTIVE, item.status)
        assertTrue(item.periodLabel.contains("2026-07-01"))
    }

    @Test
    fun `create sends dto fields and maps response`() = runTest {
        val api = FakeAttendanceExemptionApi()
        val repository = ApiAttendanceExemptionRepository(api)

        val result = repository.createExemption(
            AttendanceExemptionCreateRequest(
                targetUserId = "user-1",
                validFrom = "2026-07-01T00:00:00.000Z",
                validUntil = "2026-08-01T00:00:00.000Z",
                reasonCategory = AttendanceExemptionReasonCategory.MEDICAL,
                note = "تقرير طبي"
            )
        ) as AppResult.Success

        assertEquals("user-1", api.lastCreateRequest?.targetUserId)
        assertEquals("medical", api.lastCreateRequest?.reasonCategory)
        assertEquals("user-1", result.data.userId)
    }

    @Test
    fun `revoke preserves version and surfaces server message key`() = runTest {
        val api = FakeAttendanceExemptionApi()
        val repository = ApiAttendanceExemptionRepository(api)

        assertTrue(
            repository.revokeExemption(
                "ex-1",
                AttendanceExemptionRevokeRequest(reason = "انتهى السبب", expectedVersion = 3)
            ) is AppResult.Success
        )
        assertEquals(3, api.lastRevokeRequest?.expectedVersion)

        api.revokeResponse = Response.error(
            412,
            """{"messageKey":"attendance.version_mismatch"}"""
                .toResponseBody("application/json".toMediaType())
        )
        val stale = repository.revokeExemption(
            "ex-1",
            AttendanceExemptionRevokeRequest(reason = "محاولة ثانية", expectedVersion = 3)
        ) as AppResult.Error
        assertEquals("attendance.version_mismatch", stale.exception.message)
    }

    private class FakeAttendanceExemptionApi : AttendanceApi {
        var lastListStatus: String? = null
        var lastCreateRequest: AttendanceExemptionCreateRequestDto? = null
        var lastRevokeRequest: AttendanceExemptionRevokeRequestDto? = null
        var revokeResponse: Response<AttendanceExemptionDto> = Response.success(sampleExemption("revoked", 4))

        override suspend fun clockIn() = unsupported<AttendanceDto>()
        override suspend fun clockOut() = unsupported<AttendanceDto>()
        override suspend fun getMyAttendance(from: String?, to: String?) =
            unsupported<List<AttendanceDto>>()
        override suspend fun getAllAttendance(from: String?, to: String?, departmentId: String?) =
            unsupported<List<AttendanceDto>>()
        override suspend fun getEligibleEmployees() =
            unsupported<List<AttendanceEligibleEmployeeDto>>()
        override suspend fun createManualAttendance(request: ManualAttendanceRequestDto) =
            unsupported<AttendanceDto>()
        override suspend fun createCorrection(
            attendanceId: String,
            body: AttendanceCorrectionCreateRequestDto
        ) = unsupported<AttendanceCorrectionDto>()
        override suspend fun listCorrections(
            status: String?,
            employeeId: String?,
            cursor: String?,
            limit: Int?
        ) = unsupported<AttendanceCorrectionListDto>()
        override suspend fun decideCorrection(
            correctionId: String,
            idempotencyKey: String,
            body: AttendanceCorrectionDecisionRequestDto
        ) = unsupported<AttendanceCorrectionDecisionResponseDto>()

        override suspend fun listExemptions(
            status: String?,
            targetUserId: String?
        ): Response<AttendanceExemptionListDto> {
            lastListStatus = status
            return Response.success(
                AttendanceExemptionListDto(items = listOf(sampleExemption("active", 1)))
            )
        }

        override suspend fun createExemption(
            idempotencyKey: String,
            body: AttendanceExemptionCreateRequestDto
        ): Response<AttendanceExemptionDto> {
            lastCreateRequest = body
            return Response.success(
                sampleExemption("active", 1).copy(
                    userId = body.targetUserId,
                    reasonCategory = body.reasonCategory,
                    note = body.note
                )
            )
        }

        override suspend fun revokeExemption(
            exemptionId: String,
            idempotencyKey: String,
            body: AttendanceExemptionRevokeRequestDto
        ): Response<AttendanceExemptionDto> {
            lastRevokeRequest = body
            return revokeResponse
        }

        private fun sampleExemption(status: String, version: Int) = AttendanceExemptionDto(
            id = "ex-1",
            userId = "user-1",
            employeeId = "emp-1",
            validFrom = "2026-07-01T00:00:00.000Z",
            validUntil = "2026-08-01T00:00:00.000Z",
            reasonCategory = "remote_work",
            note = "عمل عن بُعد",
            status = status,
            version = version,
            createdAt = "2026-07-01T08:00:00.000Z",
            revokedAt = if (status == "revoked") "2026-07-19T12:00:00.000Z" else null
        )

        private fun <T> unsupported(): Response<T> =
            Response.error(501, "".toResponseBody("application/json".toMediaType()))
    }
}
