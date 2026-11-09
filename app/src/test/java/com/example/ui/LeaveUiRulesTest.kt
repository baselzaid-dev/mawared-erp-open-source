package com.example.ui

import com.example.core.permissions.Permissions
import com.example.domain.model.LeaveRequestParams
import com.example.domain.model.canCancelOwnLeave
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private fun ruleRequest(employeeId: String = "e1", rawStatus: String = "pending_hr") =
    LeaveRequestParams(
        id = "L1",
        companyId = "c1",
        employeeId = employeeId,
        employeeName = "موظف",
        departmentName = "قسم",
        leaveType = "سنوية",
        startDate = "2026-07-01",
        endDate = "2026-07-02",
        totalDays = 2,
        reason = "",
        status = if (rawStatus.startsWith("pending")) "قيد المراجعة" else "منتهي",
        currentApprovalStep = if (rawStatus == "pending_admin") 2 else 1,
        requestedAt = "",
        approvedBy = null,
        approvedAt = null,
        rejectionReason = null,
        createdAt = "",
        updatedAt = null,
        rawStatus = rawStatus,
        rawLeaveType = "annual"
    )

class LeaveUiRulesTest {
    @Test
    fun `cancel is visible only for owner pending_hr`() {
        assertTrue(canCancelOwnLeave(ruleRequest(), "e1"))
        assertFalse(canCancelOwnLeave(ruleRequest(rawStatus = "pending_admin"), "e1"))
        assertFalse(canCancelOwnLeave(ruleRequest(rawStatus = "approved"), "e1"))
        assertFalse(canCancelOwnLeave(ruleRequest(employeeId = "e2"), "e1"))
    }

    @Test
    fun `review and report visibility require direct permissions`() {
        assertFalse(canReviewLeaves(setOf(Permissions.LEAVES_VIEW_OWN)))
        assertFalse(canViewLeaveReport(setOf(Permissions.LEAVES_VIEW_OWN)))
        assertTrue(canReviewLeaves(setOf(Permissions.LEAVES_REVIEW)))
        assertTrue(canViewLeaveReport(setOf(Permissions.LEAVES_VIEW)))
        assertTrue(canReviewLeaves(setOf(Permissions.ADMIN_FULL)))
        assertTrue(canViewLeaveReport(setOf(Permissions.ADMIN_FULL)))
    }
}
