package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.DepartmentDto
import com.example.data.remote.api.LeaveApi
import com.example.data.remote.api.LeaveDto
import com.example.data.remote.api.LeaveEmployeeSummaryDto
import com.example.data.remote.api.LeaveReportResponseDto
import com.example.data.remote.api.LeaveRequestDto
import com.example.data.remote.api.LeaveSummaryDto
import com.example.data.remote.api.RejectRequestDto
import com.example.domain.model.LeaveApprovalStage
import com.example.domain.model.LeaveQuery
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

private fun <T> apiError(code: Int, json: String): Response<T> = Response.error(
    code,
    json.toResponseBody("application/json".toMediaType())
)

private fun leaveDto(
    id: String = "L1",
    status: String = "pending_hr",
    leaveType: String = "annual"
) = LeaveDto(
    id = id,
    employeeId = "e1",
    leaveType = leaveType,
    startDate = "2026-07-01T00:00:00.000Z",
    endDate = "2026-07-03T00:00:00.000Z",
    totalDays = 3,
    status = status,
    reason = "اختبار",
    rejectionReason = null,
    employee = LeaveEmployeeSummaryDto(
        id = "e1",
        employeeNum = "EMP-1",
        name = "موظف الاختبار",
        departmentId = "d1",
        department = DepartmentDto("d1", "التقنية")
    ),
    exitReentryRequested = true,
    visaFeePaid = true,
    createdAt = "2026-06-20T00:00:00.000Z"
)

private class Sprint5ALeaveApi : LeaveApi {
    data class MyQuery(val from: String?, val to: String?, val status: String?, val type: String?)
    data class ReportQuery(
        val from: String,
        val to: String,
        val status: String?,
        val type: String?,
        val employeeId: String?
    )

    var myResponse: Response<List<LeaveDto>> = Response.success(emptyList())
    var pendingResponse: Response<List<LeaveDto>> = Response.success(emptyList())
    var reportResponse: Response<LeaveReportResponseDto> = Response.success(
        LeaveReportResponseDto(LeaveSummaryDto(0, 0, 0, 0, 0, 0, 0), emptyList())
    )
    var cancelResponse: Response<LeaveDto> = Response.success(leaveDto(status = "cancelled"))
    var hrApproveResponse: Response<Map<String, String>> = Response.success(mapOf("message" to "ok"))
    var adminApproveResponse: Response<Map<String, String>> = Response.success(mapOf("message" to "ok"))
    var hrRejectResponse: Response<Map<String, String>> = Response.success(mapOf("message" to "ok"))
    var adminRejectResponse: Response<Map<String, String>> = Response.success(mapOf("message" to "ok"))

    var myQuery: MyQuery? = null
    var reportQuery: ReportQuery? = null
    var myCalls = 0
    var hrApproveCalls = 0
    var adminApproveCalls = 0
    var hrRejectCalls = 0
    var adminRejectCalls = 0

    override suspend fun submitLeaveRequest(request: LeaveRequestDto): Response<LeaveDto> =
        Response.success(leaveDto())

    override suspend fun getMyLeaves(
        from: String?,
        to: String?,
        status: String?,
        leaveType: String?
    ): Response<List<LeaveDto>> {
        myCalls += 1
        myQuery = MyQuery(from, to, status, leaveType)
        return myResponse
    }

    override suspend fun getPendingLeaves(): Response<List<LeaveDto>> = pendingResponse

    override suspend fun getLeaveReport(
        from: String,
        to: String,
        status: String?,
        leaveType: String?,
        employeeId: String?
    ): Response<LeaveReportResponseDto> {
        reportQuery = ReportQuery(from, to, status, leaveType, employeeId)
        return reportResponse
    }

    override suspend fun cancelLeave(id: String): Response<LeaveDto> = cancelResponse

    override suspend fun hrApprove(id: String): Response<Map<String, String>> {
        hrApproveCalls += 1
        return hrApproveResponse
    }

    override suspend fun hrReject(id: String, request: RejectRequestDto): Response<Map<String, String>> {
        hrRejectCalls += 1
        return hrRejectResponse
    }

    override suspend fun adminApprove(id: String): Response<Map<String, String>> {
        adminApproveCalls += 1
        return adminApproveResponse
    }

    override suspend fun adminReject(id: String, request: RejectRequestDto): Response<Map<String, String>> {
        adminRejectCalls += 1
        return adminRejectResponse
    }
}

class ApiLeaveRepositorySprint5ATest {

    @Test
    fun `filtered My Requests forwards query and preserves raw status and visa fields`() = runTest {
        val api = Sprint5ALeaveApi().apply {
            myResponse = Response.success(listOf(leaveDto(status = "pending_admin", leaveType = "annual")))
        }
        val repo = ApiLeaveRepository(api)
        val result = repo.refreshMyLeaveRequests(
            LeaveQuery("2026-07-01", "2026-07-31", "pending_admin", "annual")
        )
        assertTrue(result is AppResult.Success)
        assertEquals(
            Sprint5ALeaveApi.MyQuery("2026-07-01", "2026-07-31", "pending_admin", "annual"),
            api.myQuery
        )
        val mapped = repo.observeMyLeaveRequests("e1").first().single()
        assertEquals("pending_admin", mapped.rawStatus)
        assertEquals(2, mapped.currentApprovalStep)
        assertEquals("سنوية", mapped.leaveType)
        assertTrue(mapped.exitReentryRequested)
        assertTrue(mapped.visaFeePaid)
    }

    @Test
    fun `report forwards all filters and maps summary`() = runTest {
        val api = Sprint5ALeaveApi().apply {
            reportResponse = Response.success(
                LeaveReportResponseDto(
                    LeaveSummaryDto(7, 1, 1, 2, 1, 2, 19),
                    listOf(leaveDto(status = "approved"))
                )
            )
        }
        val repo = ApiLeaveRepository(api)
        val result = repo.refreshLeaveReport(
            LeaveQuery("2026-01-01", "2026-12-31", "approved", "annual", "e1")
        )
        assertTrue(result is AppResult.Success)
        assertEquals(
            Sprint5ALeaveApi.ReportQuery("2026-01-01", "2026-12-31", "approved", "annual", "e1"),
            api.reportQuery
        )
        val report = repo.observeLeaveReport().first()
        assertEquals(7, report.summary.total)
        assertEquals(19, report.summary.totalDays)
        assertEquals("approved", report.requests.single().rawStatus)
    }

    @Test
    fun `cancel success refreshes My Requests and Arabic validation detail is surfaced`() = runTest {
        val api = Sprint5ALeaveApi().apply {
            myResponse = Response.success(listOf(leaveDto(status = "cancelled")))
        }
        val repo = ApiLeaveRepository(api)
        val success = repo.cancelLeaveRequest("L1")
        assertTrue(success is AppResult.Success)
        assertEquals("cancelled", (success as AppResult.Success).data.rawStatus)
        assertEquals(1, api.myCalls)

        api.cancelResponse = apiError(
            409,
            """{"error":"ValidationError","details":[{"message":"لا يمكن إلغاء الطلب"}]}"""
        )
        val failure = repo.cancelLeaveRequest("L1") as AppResult.Error
        assertEquals(409, (failure.appError as AppError.ServerError).code)
        assertEquals("لا يمكن إلغاء الطلب", (failure.appError as AppError.ServerError).message)
    }

    @Test
    fun `approval and rejection use only the requested stage with no fallback`() = runTest {
        val api = Sprint5ALeaveApi().apply {
            hrApproveResponse = apiError(500, """{"error":"خطأ الخادم"}""")
            hrRejectResponse = apiError(500, """{"error":"خطأ الخادم"}""")
        }
        val repo = ApiLeaveRepository(api)

        assertTrue(repo.approveLeaveRequest("L1", stage = LeaveApprovalStage.HR) is AppResult.Error)
        assertEquals(1, api.hrApproveCalls)
        assertEquals(0, api.adminApproveCalls)

        assertTrue(repo.approveLeaveRequest("L1", stage = LeaveApprovalStage.ADMIN) is AppResult.Success)
        assertEquals(1, api.adminApproveCalls)

        assertTrue(repo.rejectLeaveRequest("L1", "سبب", LeaveApprovalStage.HR) is AppResult.Error)
        assertEquals(1, api.hrRejectCalls)
        assertEquals(0, api.adminRejectCalls)

        assertTrue(repo.rejectLeaveRequest("L1", "سبب", LeaveApprovalStage.ADMIN) is AppResult.Success)
        assertEquals(1, api.adminRejectCalls)
    }

    @Test
    fun `review 403 does not break successful My Requests refresh`() = runTest {
        val api = Sprint5ALeaveApi().apply {
            myResponse = Response.success(listOf(leaveDto()))
            pendingResponse = apiError(403, """{"error":"Forbidden"}""")
        }
        val repo = ApiLeaveRepository(api)
        val result = repo.refreshLeaveRequests()
        assertTrue(result is AppResult.Success)
        assertEquals(1, repo.observeMyLeaveRequests("e1").first().size)
        assertTrue(repo.observeLeaveRequests().first().isEmpty())
    }
}
