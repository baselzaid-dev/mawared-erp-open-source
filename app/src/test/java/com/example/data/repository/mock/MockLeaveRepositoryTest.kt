package com.example.data.repository.mock

import com.example.core.utils.AppResult
import com.example.domain.model.LeaveRequestParams
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Leave state-machine tests: approve / reject / cancel act ONLY on a pending
 * ("قيد المراجعة") request — no fake success on terminal states.
 */
class MockLeaveRepositoryTest {

    private fun newRequest(employeeId: String = "4") = LeaveRequestParams(
        id = "ignored",
        companyId = "1",
        employeeId = employeeId,
        employeeName = "موظف اختبار",
        departmentName = "تقنية المعلومات",
        leaveType = "طارئة",
        startDate = "2026-08-01",
        endDate = "2026-08-05",
        totalDays = 5,
        reason = "اختبار",
        status = "أي حالة", // repository must force pending
        currentApprovalStep = 9,
        requestedAt = "",
        approvedBy = "لا يجب أن يبقى",
        approvedAt = "لا يجب أن يبقى",
        rejectionReason = "لا يجب أن يبقى",
        createdAt = "",
        updatedAt = null
    )

    @Test
    fun `submit always creates a pending request with clean approval fields`() = runTest {
        val repo = MockLeaveRepository()
        val result = repo.submitLeaveRequest(newRequest())
        assertTrue(result is AppResult.Success)
        val created = (result as AppResult.Success).data
        assertEquals("قيد المراجعة", created.status)
        assertEquals(1, created.currentApprovalStep)
        assertEquals(null, created.approvedBy)
        assertEquals(null, created.rejectionReason)
    }

    @Test
    fun `approve moves a pending request to approved`() = runTest {
        val repo = MockLeaveRepository()
        val created = (repo.submitLeaveRequest(newRequest()) as AppResult.Success).data
        val result = repo.approveLeaveRequest(created.id, "مدير الموارد البشرية")
        assertTrue(result is AppResult.Success)
        assertEquals("موافق عليها", (result as AppResult.Success).data.status)
    }

    @Test
    fun `approve is refused on an already-approved request`() = runTest {
        val repo = MockLeaveRepository()
        val created = (repo.submitLeaveRequest(newRequest()) as AppResult.Success).data
        repo.approveLeaveRequest(created.id, null)
        val second = repo.approveLeaveRequest(created.id, null)
        assertTrue("approving twice must fail", second is AppResult.Error)
    }

    @Test
    fun `reject moves a pending request to rejected with the reason`() = runTest {
        val repo = MockLeaveRepository()
        val created = (repo.submitLeaveRequest(newRequest()) as AppResult.Success).data
        val result = repo.rejectLeaveRequest(created.id, "ضغط العمل")
        assertTrue(result is AppResult.Success)
        val rejected = (result as AppResult.Success).data
        assertEquals("مرفوضة", rejected.status)
        assertEquals("ضغط العمل", rejected.rejectionReason)
    }

    @Test
    fun `reject is refused on a cancelled request`() = runTest {
        val repo = MockLeaveRepository()
        val created = (repo.submitLeaveRequest(newRequest()) as AppResult.Success).data
        repo.cancelLeaveRequest(created.id)
        val result = repo.rejectLeaveRequest(created.id, "سبب")
        assertTrue("rejecting a cancelled request must fail", result is AppResult.Error)
    }

    @Test
    fun `cancel only works while pending`() = runTest {
        val repo = MockLeaveRepository()
        val created = (repo.submitLeaveRequest(newRequest()) as AppResult.Success).data
        assertTrue(repo.cancelLeaveRequest(created.id) is AppResult.Success)
        assertTrue("cancelling twice must fail", repo.cancelLeaveRequest(created.id) is AppResult.Error)
    }

    @Test
    fun `acting on an unknown request id fails honestly`() = runTest {
        val repo = MockLeaveRepository()
        assertTrue(repo.approveLeaveRequest("LV-does-not-exist", null) is AppResult.Error)
        assertTrue(repo.rejectLeaveRequest("LV-does-not-exist", "سبب") is AppResult.Error)
        assertTrue(repo.cancelLeaveRequest("LV-does-not-exist") is AppResult.Error)
    }
}
