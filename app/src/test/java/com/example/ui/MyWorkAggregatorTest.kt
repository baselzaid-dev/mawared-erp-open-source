package com.example.ui

import com.example.core.permissions.Permissions
import com.example.domain.model.AttendanceRecordParams
import com.example.domain.model.LeaveRequestParams
import com.example.domain.model.MyWorkActionKind
import com.example.domain.model.MyWorkCategory
import com.example.domain.model.MyWorkPermissions
import com.example.domain.model.MyWorkSnapshot
import com.example.domain.model.TaskAssignmentParams
import com.example.domain.model.TaskParams
import com.example.ui.navigation.TypedDestination
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MyWorkAggregatorTest {

    private val companyId = "company-1"
    private val employeeId = "employee-1"

    private fun permissions(vararg keys: String) =
        MyWorkPermissions.from(keys.toSet())

    private fun leave(
        id: String,
        employee: String = "employee-2",
        rawStatus: String = "pending_hr",
        company: String = companyId
    ) = LeaveRequestParams(
        id = id,
        companyId = company,
        employeeId = employee,
        employeeName = "موظف $employee",
        departmentName = "قسم",
        leaveType = "سنوية",
        startDate = "2026-07-01",
        endDate = "2026-07-02",
        totalDays = 2,
        reason = "",
        status = "قيد المراجعة",
        currentApprovalStep = if (rawStatus == "pending_admin") 2 else 1,
        requestedAt = "2026-07-01T10:00:00Z",
        approvedBy = null,
        approvedAt = null,
        rejectionReason = null,
        createdAt = "2026-07-01T09:00:00Z",
        updatedAt = null,
        rawStatus = rawStatus
    )

    private fun task(
        id: String,
        assignments: List<TaskAssignmentParams>,
        company: String = companyId
    ) = TaskParams(
        id = id,
        companyId = company,
        title = "مهمة $id",
        description = null,
        status = "active",
        priority = "normal",
        assignedToId = assignments.firstOrNull()?.employeeId,
        assignedToName = assignments.firstOrNull()?.employeeName,
        departmentName = "قسم",
        dueDate = "2026-07-15",
        createdById = "manager-1",
        createdByName = "مدير",
        createdAt = "2026-07-01T08:00:00Z",
        updatedAt = "2026-07-01T08:00:00Z",
        assignments = assignments
    )

    private fun assignment(
        id: String,
        taskId: String,
        employee: String,
        status: String
    ) = TaskAssignmentParams(
        id = id,
        taskId = taskId,
        employeeId = employee,
        employeeNum = "E-$employee",
        employeeName = "موظف $employee",
        departmentId = "dept-1",
        departmentName = "قسم",
        status = status,
        completionDetails = null,
        submittedAt = if (status == "submitted") "2026-07-02T12:00:00Z" else null,
        reviewedById = null,
        reviewedByName = null,
        reviewedAt = null,
        reviewNote = null,
        createdAt = "2026-07-01T08:00:00Z",
        updatedAt = "2026-07-01T08:00:00Z"
    )

    private fun attendance(
        id: String,
        employee: String = employeeId,
        clockIn: String? = "08:00",
        clockOut: String? = null,
        company: String = companyId
    ) = AttendanceRecordParams(
        id = id,
        companyId = company,
        employeeId = employee,
        employeeName = "موظف",
        departmentName = "قسم",
        date = "2026-07-19",
        clockInTime = clockIn,
        clockOutTime = clockOut,
        status = "present",
        lateMinutes = 0,
        overtimeMinutes = 0,
        source = "self",
        locationLat = null,
        locationLng = null,
        createdAt = "2026-07-19T08:00:00Z",
        updatedAt = null
    )

    @Test
    fun `review leaves appear only with review permission`() {
        val snapshot = MyWorkSnapshot(
            companyId = companyId,
            employeeId = employeeId,
            leaveReviewQueue = listOf(leave("L-1"), leave("L-2"))
        )

        val allowed = MyWorkAggregator.aggregate(
            snapshot,
            permissions(Permissions.LEAVES_REVIEW)
        )
        val denied = MyWorkAggregator.aggregate(
            snapshot,
            permissions(Permissions.LEAVES_VIEW_OWN)
        )

        assertEquals(2, allowed.size)
        assertTrue(allowed.all { it.category == MyWorkCategory.LEAVES })
        assertTrue(allowed.all { it.actionKind == MyWorkActionKind.REVIEW_LEAVE })
        assertTrue(denied.isEmpty())
    }

    @Test
    fun `own pending hr leave appears for owner with view own permission`() {
        val snapshot = MyWorkSnapshot(
            companyId = companyId,
            employeeId = employeeId,
            ownLeaveRequests = listOf(leave("L-own", employee = employeeId))
        )

        val items = MyWorkAggregator.aggregate(
            snapshot,
            permissions(Permissions.LEAVES_VIEW_OWN)
        )

        assertEquals(1, items.size)
        assertEquals(MyWorkActionKind.TRACK_OWN_LEAVE, items.first().actionKind)
        assertTrue(items.first().destination is TypedDestination.LeaveDetail)
    }

    @Test
    fun `foreign company rows are excluded`() {
        val snapshot = MyWorkSnapshot(
            companyId = companyId,
            employeeId = employeeId,
            leaveReviewQueue = listOf(leave("L-foreign", company = "other-company"))
        )

        val items = MyWorkAggregator.aggregate(
            snapshot,
            permissions(Permissions.LEAVES_REVIEW)
        )

        assertTrue(items.isEmpty())
    }

    @Test
    fun `own actionable tasks and submitted review tasks are separated`() {
        val snapshot = MyWorkSnapshot(
            companyId = companyId,
            employeeId = employeeId,
            tasks = listOf(
                task(
                    id = "T-1",
                    assignments = listOf(
                        assignment("A-1", "T-1", employeeId, "assigned"),
                        assignment("A-2", "T-1", "employee-2", "submitted")
                    )
                )
            )
        )

        val perms = permissions(
            Permissions.TASKS_VIEW_OWN,
            Permissions.TASKS_VIEW_COMPANY,
            Permissions.TASKS_REVIEW
        )
        val items = MyWorkAggregator.aggregate(snapshot, perms)

        assertEquals(2, items.size)
        assertTrue(items.any { it.actionKind == MyWorkActionKind.WORK_ON_TASK })
        assertTrue(items.any { it.actionKind == MyWorkActionKind.REVIEW_TASK })
        assertTrue(items.all { it.destination is TypedDestination.TaskDetail })
    }

    @Test
    fun `attendance clock in suggested when no today record`() {
        val snapshot = MyWorkSnapshot(
            companyId = companyId,
            employeeId = employeeId,
            todayAttendance = emptyList()
        )

        val items = MyWorkAggregator.aggregate(
            snapshot,
            permissions(Permissions.ATTENDANCE_CLOCK)
        )

        assertEquals(1, items.size)
        assertEquals(MyWorkActionKind.CLOCK_IN, items.first().actionKind)
        assertEquals(MyWorkCategory.ATTENDANCE, items.first().category)
        assertTrue(items.first().destination is TypedDestination.Attendance)
    }

    @Test
    fun `attendance clock out suggested when clock in exists without clock out`() {
        val snapshot = MyWorkSnapshot(
            companyId = companyId,
            employeeId = employeeId,
            todayAttendance = listOf(attendance("ATT-1", clockOut = null))
        )

        val items = MyWorkAggregator.aggregate(
            snapshot,
            permissions(Permissions.ATTENDANCE_CLOCK)
        )

        assertEquals(1, items.size)
        assertEquals(MyWorkActionKind.CLOCK_OUT, items.first().actionKind)
    }

    @Test
    fun `category filter keeps only matching items`() {
        val snapshot = MyWorkSnapshot(
            companyId = companyId,
            employeeId = employeeId,
            leaveReviewQueue = listOf(leave("L-1")),
            tasks = listOf(
                task(
                    id = "T-1",
                    assignments = listOf(assignment("A-1", "T-1", employeeId, "assigned"))
                )
            )
        )

        val perms = permissions(
            Permissions.LEAVES_REVIEW,
            Permissions.TASKS_VIEW_OWN
        )
        val leavesOnly = MyWorkAggregator.aggregate(snapshot, perms, categoryFilter = "leaves")
        val tasksOnly = MyWorkAggregator.aggregate(snapshot, perms, categoryFilter = "tasks")

        assertEquals(1, leavesOnly.size)
        assertEquals(MyWorkCategory.LEAVES, leavesOnly.first().category)
        assertEquals(1, tasksOnly.size)
        assertEquals(MyWorkCategory.TASKS, tasksOnly.first().category)
    }

    @Test
    fun `no permissions yields empty list`() {
        val snapshot = MyWorkSnapshot(
            companyId = companyId,
            employeeId = employeeId,
            leaveReviewQueue = listOf(leave("L-1"))
        )

        val items = MyWorkAggregator.aggregate(snapshot, MyWorkPermissions.from(emptySet()))

        assertTrue(items.isEmpty())
    }

    @Test
    fun `admin full cannot self clock`() {
        val snapshot = MyWorkSnapshot(
            companyId = companyId,
            employeeId = employeeId,
            todayAttendance = emptyList()
        )

        val items = MyWorkAggregator.aggregate(
            snapshot,
            permissions(Permissions.ADMIN_FULL)
        )

        assertFalse(items.any { it.category == MyWorkCategory.ATTENDANCE })
    }
}
