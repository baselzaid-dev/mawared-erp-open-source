package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.AttendanceApi
import com.example.data.remote.api.AttendanceDto
import com.example.data.remote.api.AttendanceEligibleEmployeeDto
import com.example.data.remote.api.ManualAttendanceRequestDto
import com.example.domain.model.AttendanceQuery
import com.example.domain.model.AttendanceViewScope
import com.example.domain.model.ManualAttendanceRequest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response
import java.util.Date

private class FakeAttendanceApi : AttendanceApi {
    var myResponse: Response<List<AttendanceDto>> = Response.success(emptyList())
    var allResponse: Response<List<AttendanceDto>> = Response.success(emptyList())
    var eligibleResponse: Response<List<AttendanceEligibleEmployeeDto>> = Response.success(emptyList())
    var manualResponse: Response<AttendanceDto> = Response.success(
        AttendanceDto("a-new", "c1", "e1", "2026-07-01T00:00:00.000Z", null, null, "absent")
    )
    var myCalls = 0
    var allCalls = 0
    var lastFrom: String? = null
    var lastTo: String? = null
    var lastDepartmentId: String? = null
    var lastManualRequest: ManualAttendanceRequestDto? = null

    override suspend fun clockIn(): Response<AttendanceDto> = manualResponse
    override suspend fun clockOut(): Response<AttendanceDto> = manualResponse

    override suspend fun getMyAttendance(from: String?, to: String?): Response<List<AttendanceDto>> {
        myCalls++
        lastFrom = from
        lastTo = to
        return myResponse
    }

    override suspend fun getAllAttendance(
        from: String?,
        to: String?,
        departmentId: String?
    ): Response<List<AttendanceDto>> {
        allCalls++
        lastFrom = from
        lastTo = to
        lastDepartmentId = departmentId
        return allResponse
    }

    override suspend fun getEligibleEmployees(): Response<List<AttendanceEligibleEmployeeDto>> =
        eligibleResponse

    override suspend fun createManualAttendance(
        request: ManualAttendanceRequestDto
    ): Response<AttendanceDto> {
        lastManualRequest = request
        return manualResponse
    }

    override suspend fun createCorrection(
        attendanceId: String,
        body: com.example.data.remote.api.AttendanceCorrectionCreateRequestDto
    ): Response<com.example.data.remote.api.AttendanceCorrectionDto> =
        Response.error(501, "".toResponseBody("application/json".toMediaType()))

    override suspend fun listCorrections(
        status: String?,
        employeeId: String?,
        cursor: String?,
        limit: Int?
    ): Response<com.example.data.remote.api.AttendanceCorrectionListDto> =
        Response.error(501, "".toResponseBody("application/json".toMediaType()))

    override suspend fun decideCorrection(
        correctionId: String,
        idempotencyKey: String,
        body: com.example.data.remote.api.AttendanceCorrectionDecisionRequestDto
    ): Response<com.example.data.remote.api.AttendanceCorrectionDecisionResponseDto> =
        Response.error(501, "".toResponseBody("application/json".toMediaType()))

    override suspend fun listExemptions(
        status: String?,
        targetUserId: String?
    ): Response<com.example.data.remote.api.AttendanceExemptionListDto> =
        Response.error(501, "".toResponseBody("application/json".toMediaType()))

    override suspend fun createExemption(
        idempotencyKey: String,
        body: com.example.data.remote.api.AttendanceExemptionCreateRequestDto
    ): Response<com.example.data.remote.api.AttendanceExemptionDto> =
        Response.error(501, "".toResponseBody("application/json".toMediaType()))

    override suspend fun revokeExemption(
        exemptionId: String,
        idempotencyKey: String,
        body: com.example.data.remote.api.AttendanceExemptionRevokeRequestDto
    ): Response<com.example.data.remote.api.AttendanceExemptionDto> =
        Response.error(501, "".toResponseBody("application/json".toMediaType()))
}

class ApiAttendanceRepositoryTest {
    @Test
    fun `maps backend attendance statuses to Arabic safely`() {
        assertEquals("حاضر", ApiAttendanceRepository.arabicStatus("present"))
        assertEquals("متأخر", ApiAttendanceRepository.arabicStatus("late"))
        assertEquals("غائب", ApiAttendanceRepository.arabicStatus("absent"))
        assertEquals("custom", ApiAttendanceRepository.arabicStatus("custom"))
    }

    @Test
    fun `normalizes ISO dates and times`() {
        assertEquals("2026-07-01", ApiAttendanceRepository.normalizeDate("2026-07-01T00:00:00.000Z"))
        assertEquals("08:15", ApiAttendanceRepository.displayTime("2026-07-01T08:15:00.000Z"))
        assertEquals("1970-01-01", ApiAttendanceRepository.utcToday(Date(0)))
    }

    @Test
    fun `own scope uses my endpoint and actual today filtering`() = runTest {
        val today = ApiAttendanceRepository.utcToday()
        val api = FakeAttendanceApi().apply {
            myResponse = Response.success(
                listOf(
                    AttendanceDto("today", "c1", "e1", "${today}T00:00:00.000Z", "08:00", null, "present"),
                    AttendanceDto("old", "c1", "e1", "2000-01-01T00:00:00.000Z", "08:00", "17:00", "present")
                )
            )
        }
        val repo = ApiAttendanceRepository(api)
        repo.refreshAttendance(AttendanceQuery(AttendanceViewScope.OWN, today, today))

        assertEquals(1, api.myCalls)
        assertEquals(0, api.allCalls)
        assertEquals(today, api.lastFrom)
        assertEquals(listOf("today"), repo.observeTodayAttendance().first().map { it.id })
    }

    @Test
    fun `department and company scopes use all endpoint with query values`() = runTest {
        val api = FakeAttendanceApi()
        val repo = ApiAttendanceRepository(api)
        repo.refreshAttendance(
            AttendanceQuery(AttendanceViewScope.DEPARTMENT, "2026-07-01", "2026-07-31", "d1")
        )
        repo.refreshAttendance(
            AttendanceQuery(AttendanceViewScope.COMPANY, "2026-07-01", "2026-07-31")
        )
        assertEquals(2, api.allCalls)
        assertEquals(null, api.lastDepartmentId)
    }

    @Test
    fun `eligible employee response is mapped without fabrication`() = runTest {
        val api = FakeAttendanceApi().apply {
            eligibleResponse = Response.success(
                listOf(AttendanceEligibleEmployeeDto("e1", "001", "أحمد", "d1", "الهندسة", "موظف"))
            )
        }
        val repo = ApiAttendanceRepository(api)
        val result = repo.refreshEligibleEmployees()
        assertTrue(result is AppResult.Success)
        assertEquals("أحمد", repo.observeEligibleEmployees().first().single().name)
    }

    @Test
    fun `manual request is sent and duplicate Arabic message is preserved`() = runTest {
        val api = FakeAttendanceApi().apply {
            manualResponse = Response.error(
                409,
                """{"error":"AttendanceAlreadyExists","message":"يوجد سجل حضور لهذا الموظف في هذا اليوم مسبقاً","code":409}"""
                    .toResponseBody("application/json".toMediaType())
            )
        }
        val repo = ApiAttendanceRepository(api)
        val request = ManualAttendanceRequest("e1", "2026-07-01", "present", "08:00", "17:00")
        val result = repo.createManualAttendance(request)

        assertEquals("e1", api.lastManualRequest?.employeeId)
        assertTrue(result is AppResult.Error)
        val error = (result as AppResult.Error).appError as AppError.ServerError
        assertEquals(409, error.code)
        assertEquals("يوجد سجل حضور لهذا الموظف في هذا اليوم مسبقاً", error.message)
    }
}
