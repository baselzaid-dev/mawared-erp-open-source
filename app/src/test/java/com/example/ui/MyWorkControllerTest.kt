package com.example.ui

import com.example.core.permissions.Permissions
import com.example.domain.model.CurrentSession
import com.example.domain.model.LeaveRequestParams
import com.example.domain.model.MyWorkPermissions
import com.example.domain.model.MyWorkSnapshot
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MyWorkControllerTest {

    private fun session(permissions: Set<String>, employeeId: String = "employee-1") =
        CurrentSession(
            companyId = "company-1",
            companyCode = "CMP",
            companyName = "Demo",
            userId = "user-1",
            employeeId = employeeId,
            roleId = "role-1",
            departmentId = null,
            permissions = permissions
        )

    private fun pendingLeave(id: String) = LeaveRequestParams(
        id = id,
        companyId = "company-1",
        employeeId = "employee-2",
        employeeName = "موظف",
        departmentName = "قسم",
        leaveType = "سنوية",
        startDate = "2026-07-01",
        endDate = "2026-07-02",
        totalDays = 2,
        reason = "",
        status = "قيد المراجعة",
        currentApprovalStep = 1,
        requestedAt = "2026-07-01T10:00:00Z",
        approvedBy = null,
        approvedAt = null,
        rejectionReason = null,
        createdAt = "2026-07-01T09:00:00Z",
        updatedAt = null,
        rawStatus = "pending_hr"
    )

    @Test
    fun `preloaded snapshot returns content state`() = runTest {
        val controller = MyWorkController()
        val snapshot = MyWorkSnapshot(
            companyId = "company-1",
            employeeId = "employee-1",
            leaveReviewQueue = listOf(pendingLeave("L-1"))
        )

        val state = controller.load(
            MyWorkController.LoadRequest(
                session = session(setOf(Permissions.LEAVES_REVIEW)),
                snapshot = snapshot
            )
        )

        assertTrue(state is MyWorkUiState.Content)
        assertEquals(1, (state as MyWorkUiState.Content).items.size)
    }

    @Test
    fun `preloaded snapshot with no items returns empty`() = runTest {
        val controller = MyWorkController()
        val snapshot = MyWorkSnapshot(
            companyId = "company-1",
            employeeId = "employee-1"
        )

        val state = controller.load(
            MyWorkController.LoadRequest(
                session = session(setOf(Permissions.LEAVES_REVIEW)),
                snapshot = snapshot
            )
        )

        assertEquals(MyWorkUiState.Empty, state)
    }

    @Test
    fun `repository load without wiring returns error`() = runTest {
        val controller = MyWorkController()
        val state = controller.load(
            MyWorkController.LoadRequest(
                session = session(setOf(Permissions.LEAVES_REVIEW))
            )
        )

        assertTrue(state is MyWorkUiState.Error)
    }

    @Test
    fun `buildFromSnapshot respects category filter`() {
        val controller = MyWorkController()
        val snapshot = MyWorkSnapshot(
            companyId = "company-1",
            employeeId = "employee-1",
            leaveReviewQueue = listOf(pendingLeave("L-1"))
        )
        val permissions = MyWorkPermissions.from(setOf(Permissions.LEAVES_REVIEW))

        val state = controller.buildFromSnapshot(snapshot, permissions, category = "tasks")

        assertTrue(state is MyWorkUiState.Content)
        assertTrue((state as MyWorkUiState.Content).items.isEmpty())
        assertEquals("tasks", state.selectedCategory)
    }
}
