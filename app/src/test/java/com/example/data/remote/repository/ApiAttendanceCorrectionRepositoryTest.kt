package com.example.data.remote.repository

import com.example.core.utils.AppResult
import com.example.data.remote.api.*
import com.example.domain.model.AttendanceCorrectionDecision
import com.example.domain.model.AttendanceCorrectionDecisionRequest
import com.example.domain.model.AttendanceCorrectionStatus
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

class ApiAttendanceCorrectionRepositoryTest {
    @Test
    fun `list maps correction statuses and pagination`() = runTest {
        val api = FakeAttendanceCorrectionApi()
        val result = ApiAttendanceCorrectionRepository(api).listCorrections(status = "pending") as AppResult.Success

        assertEquals(1, result.data.items.size)
        assertEquals(AttendanceCorrectionStatus.PENDING, result.data.items.single().status)
        assertTrue(result.data.hasMore)
        assertEquals("cursor-2", result.data.nextCursor)
        assertEquals("pending", api.lastListStatus)
    }

    @Test
    fun `create sends expected attendance version`() = runTest {
        val api = FakeAttendanceCorrectionApi()
        val repository = ApiAttendanceCorrectionRepository(api)

        val result = repository.createCorrection(
            attendanceId = "att-1",
            request = com.example.domain.model.AttendanceCorrectionCreateRequest(
                clockIn = "2026-07-19T08:00:00.000Z",
                clockOut = null,
                reason = "forgot to clock in",
                expectedAttendanceVersion = 4
            )
        ) as AppResult.Success

        assertEquals("corr-1", result.data.id)
        assertEquals(4, api.lastCreateRequest?.expectedAttendanceVersion)
        assertEquals("att-1", api.lastCreateAttendanceId)
    }

    @Test
    fun `decide maps attendance version from response`() = runTest {
        val api = FakeAttendanceCorrectionApi()
        val repository = ApiAttendanceCorrectionRepository(api)

        val result = repository.decideCorrection(
            correctionId = "corr-1",
            request = AttendanceCorrectionDecisionRequest(
                decision = AttendanceCorrectionDecision.ACCEPT,
                reason = "verified with team lead",
                expectedVersion = 2
            )
        ) as AppResult.Success

        assertEquals(AttendanceCorrectionStatus.APPROVED, result.data.correction.status)
        assertEquals(5, result.data.updatedAttendanceVersion)
        assertEquals("accept", api.lastDecisionRequest?.decision)
    }

    @Test
    fun `server messageKey surfaces on stale version`() = runTest {
        val api = FakeAttendanceCorrectionApi()
        api.decideResponse = Response.error(
            412,
            """{"messageKey":"attendance.version_mismatch"}"""
                .toResponseBody("application/json".toMediaType())
        )
        val stale = ApiAttendanceCorrectionRepository(api).decideCorrection(
            correctionId = "corr-1",
            request = AttendanceCorrectionDecisionRequest(
                decision = AttendanceCorrectionDecision.REJECT,
                reason = "not justified",
                expectedVersion = 1
            )
        ) as AppResult.Error

        assertEquals("attendance.version_mismatch", stale.exception.message)
    }

    private class FakeAttendanceCorrectionApi : AttendanceApi {
        var lastListStatus: String? = null
        var lastCreateAttendanceId: String? = null
        var lastCreateRequest: AttendanceCorrectionCreateRequestDto? = null
        var lastDecisionRequest: AttendanceCorrectionDecisionRequestDto? = null
        var decideResponse: Response<AttendanceCorrectionDecisionResponseDto> = Response.success(
            AttendanceCorrectionDecisionResponseDto(
                correction = AttendanceCorrectionDto(
                    id = "corr-1",
                    attendanceId = "att-1",
                    employeeId = "emp-1",
                    requestedByUserId = "user-1",
                    requestedClockIn = "2026-07-19T08:00:00.000Z",
                    requestedClockOut = null,
                    reason = "forgot",
                    status = "approved",
                    version = 3,
                    reviewedAt = "2026-07-19T10:00:00.000Z",
                    decisionReason = "verified",
                    createdAt = "2026-07-19T09:00:00.000Z",
                    updatedAt = "2026-07-19T10:00:00.000Z"
                ),
                attendance = AttendanceDto(
                    id = "att-1",
                    employeeId = "emp-1",
                    date = "2026-07-19",
                    clockIn = "2026-07-19T08:00:00.000Z",
                    clockOut = null,
                    status = "present",
                    version = 5
                )
            )
        )

        override suspend fun clockIn(): Response<AttendanceDto> =
            Response.success(sampleAttendance())

        override suspend fun clockOut(): Response<AttendanceDto> =
            Response.success(sampleAttendance())

        override suspend fun getMyAttendance(from: String?, to: String?): Response<List<AttendanceDto>> =
            Response.success(emptyList())

        override suspend fun getAllAttendance(
            from: String?,
            to: String?,
            departmentId: String?
        ): Response<List<AttendanceDto>> = Response.success(emptyList())

        override suspend fun getEligibleEmployees(): Response<List<AttendanceEligibleEmployeeDto>> =
            Response.success(emptyList())

        override suspend fun createManualAttendance(
            request: ManualAttendanceRequestDto
        ): Response<AttendanceDto> = Response.success(sampleAttendance())

        override suspend fun createCorrection(
            attendanceId: String,
            body: AttendanceCorrectionCreateRequestDto
        ): Response<AttendanceCorrectionDto> {
            lastCreateAttendanceId = attendanceId
            lastCreateRequest = body
            return Response.success(
                AttendanceCorrectionDto(
                    id = "corr-1",
                    attendanceId = attendanceId,
                    employeeId = "emp-1",
                    requestedByUserId = "user-1",
                    requestedClockIn = body.clockIn,
                    requestedClockOut = body.clockOut,
                    reason = body.reason,
                    status = "pending",
                    version = 1,
                    reviewedAt = null,
                    decisionReason = null,
                    createdAt = "2026-07-19T09:00:00.000Z",
                    updatedAt = "2026-07-19T09:00:00.000Z"
                )
            )
        }

        override suspend fun listCorrections(
            status: String?,
            employeeId: String?,
            cursor: String?,
            limit: Int?
        ): Response<AttendanceCorrectionListDto> {
            lastListStatus = status
            return Response.success(
                AttendanceCorrectionListDto(
                    items = listOf(
                        AttendanceCorrectionDto(
                            id = "corr-1",
                            attendanceId = "att-1",
                            employeeId = "emp-1",
                            requestedByUserId = "user-1",
                            requestedClockIn = "2026-07-19T08:00:00.000Z",
                            requestedClockOut = null,
                            reason = "forgot",
                            status = "pending",
                            version = 1,
                            reviewedAt = null,
                            decisionReason = null,
                            createdAt = "2026-07-19T09:00:00.000Z",
                            updatedAt = "2026-07-19T09:00:00.000Z"
                        )
                    ),
                    nextCursor = "cursor-2",
                    hasMore = true
                )
            )
        }

        override suspend fun decideCorrection(
            correctionId: String,
            idempotencyKey: String,
            body: AttendanceCorrectionDecisionRequestDto
        ): Response<AttendanceCorrectionDecisionResponseDto> {
            lastDecisionRequest = body
            return decideResponse
        }

        override suspend fun listExemptions(
            status: String?,
            targetUserId: String?
        ): Response<AttendanceExemptionListDto> = Response.success(
            AttendanceExemptionListDto(emptyList(), null, false)
        )

        override suspend fun createExemption(
            idempotencyKey: String,
            body: AttendanceExemptionCreateRequestDto
        ): Response<AttendanceExemptionDto> = throw UnsupportedOperationException()

        override suspend fun revokeExemption(
            exemptionId: String,
            idempotencyKey: String,
            body: AttendanceExemptionRevokeRequestDto
        ): Response<AttendanceExemptionDto> = throw UnsupportedOperationException()

        private fun sampleAttendance() = AttendanceDto(
            id = "att-1",
            employeeId = "emp-1",
            date = "2026-07-19",
            clockIn = null,
            clockOut = null,
            status = "present",
            version = 1
        )
    }
}
