package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.LeaveApi
import com.example.data.remote.api.LeaveDto
import com.example.data.remote.api.LeaveRequestDto
import com.example.data.remote.api.LeaveReportResponseDto
import com.example.data.remote.api.RejectRequestDto
import com.example.domain.model.LeaveRequestParams
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

/** Fake Retrofit LeaveApi — captures the submitted DTO, returns a configurable response. */
private class FakeLeaveApi(
    var submitResult: () -> Response<LeaveDto> = {
        Response.error(
            400,
            """{"error":"الرجاء دفع رسوم التأشيرة ثم تقديم الطلب مرة أخرى"}"""
                .toResponseBody("application/json".toMediaType())
        )
    }
) : LeaveApi {
    var lastRequest: LeaveRequestDto? = null

    override suspend fun submitLeaveRequest(request: LeaveRequestDto): Response<LeaveDto> {
        lastRequest = request
        return submitResult()
    }

    override suspend fun getMyLeaves(
        from: String?,
        to: String?,
        status: String?,
        leaveType: String?
    ): Response<List<LeaveDto>> = Response.success(emptyList())
    override suspend fun getPendingLeaves(): Response<List<LeaveDto>> = Response.success(emptyList())
    override suspend fun getLeaveReport(
        from: String,
        to: String,
        status: String?,
        leaveType: String?,
        employeeId: String?
    ): Response<LeaveReportResponseDto> = throw UnsupportedOperationException("not used")
    override suspend fun cancelLeave(id: String): Response<LeaveDto> =
        throw UnsupportedOperationException("not used")
    override suspend fun hrApprove(id: String): Response<Map<String, String>> =
        throw UnsupportedOperationException("not used")
    override suspend fun hrReject(id: String, request: RejectRequestDto): Response<Map<String, String>> =
        throw UnsupportedOperationException("not used")
    override suspend fun adminApprove(id: String): Response<Map<String, String>> =
        throw UnsupportedOperationException("not used")
    override suspend fun adminReject(id: String, request: RejectRequestDto): Response<Map<String, String>> =
        throw UnsupportedOperationException("not used")
}

private fun annualLeave(exitReentry: Boolean, visaPaid: Boolean) = LeaveRequestParams(
    id = "", companyId = "1", employeeId = "e1", employeeName = "موظف", departmentName = "قسم",
    leaveType = "سنوية", startDate = "2026-08-01", endDate = "2026-08-05", totalDays = 5,
    reason = "سفر", status = "قيد المراجعة", currentApprovalStep = 1, requestedAt = "",
    approvedBy = null, approvedAt = null, rejectionReason = null, createdAt = "", updatedAt = null,
    exitReentryRequested = exitReentry, visaFeePaid = visaPaid
)

class ApiLeaveVisaTest {

    @Test
    fun `visa flags are passed through to the backend DTO`() = runTest {
        val api = FakeLeaveApi()
        val repo = ApiLeaveRepository(api)
        repo.submitLeaveRequest(annualLeave(exitReentry = true, visaPaid = false))
        assertEquals(true, api.lastRequest?.exitReentryRequested)
        assertEquals(false, api.lastRequest?.visaFeePaid)
    }

    @Test
    fun `backend 400 visa message is surfaced to the caller, not swallowed`() = runTest {
        val api = FakeLeaveApi()
        val repo = ApiLeaveRepository(api)
        val result = repo.submitLeaveRequest(annualLeave(exitReentry = true, visaPaid = false))
        assertTrue(result is AppResult.Error)
        val err = (result as AppResult.Error).appError
        assertTrue(err is AppError.ServerError)
        assertEquals(400, (err as AppError.ServerError).code)
        assertEquals("الرجاء دفع رسوم التأشيرة ثم تقديم الطلب مرة أخرى", err.message)
    }

    @Test
    fun `defaults stay false when visa section untouched`() = runTest {
        val api = FakeLeaveApi()
        val repo = ApiLeaveRepository(api)
        repo.submitLeaveRequest(annualLeave(exitReentry = false, visaPaid = false))
        assertEquals(false, api.lastRequest?.exitReentryRequested)
        assertEquals(false, api.lastRequest?.visaFeePaid)
    }

    // Regression: a validation error puts the code in "error" and the human
    // Arabic text in "message". The repo must surface the Arabic "message", not
    // the "ValidationError" code (which then fell back to a generic error and
    // hid the real cause — QA report "حدث خطأ أثناء تقديم طلب إجازة").
    @Test
    fun `prefers the Arabic validation message over the ValidationError code`() = runTest {
        val api = FakeLeaveApi(submitResult = {
            Response.error(
                400,
                """{"error":"ValidationError","message":"صيغة التاريخ غير صحيحة","code":400}"""
                    .toResponseBody("application/json".toMediaType())
            )
        })
        val repo = ApiLeaveRepository(api)
        val result = repo.submitLeaveRequest(annualLeave(exitReentry = false, visaPaid = false))
        val err = (result as AppResult.Error).appError as AppError.ServerError
        assertEquals("صيغة التاريخ غير صحيحة", err.message)
    }

    @Test
    fun `treats a 2xx as success`() = runTest {
        val api = FakeLeaveApi(submitResult = {
            Response.success(
                LeaveDto("LR1", "e1", "سنوية", "2026-08-01", "2026-08-05", 5, "pending_hr", "سفر", null)
            )
        })
        val repo = ApiLeaveRepository(api)
        val result = repo.submitLeaveRequest(annualLeave(exitReentry = false, visaPaid = false))
        assertTrue(result is AppResult.Success)
    }
}
