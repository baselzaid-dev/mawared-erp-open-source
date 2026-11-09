package com.example.ui

import com.example.domain.model.LeaveRequestParams
import com.example.domain.model.MyWorkActionKind
import com.example.domain.model.MyWorkCategory
import com.example.domain.model.MyWorkItem
import com.example.domain.model.MyWorkPermissions
import com.example.domain.model.MyWorkSnapshot
import com.example.domain.model.TaskParams
import com.example.domain.model.canCancelOwnLeave
import com.example.domain.model.isPendingAdmin
import com.example.domain.model.isPendingHr
import com.example.ui.navigation.NavigationCoordinator
import com.example.ui.navigation.ResourceDescriptor
import com.example.ui.navigation.TypedDestination

/**
 * Missing backend contracts (Sprint 12E — client-side aggregation only):
 * - `GET /api/v2/my-work` federated projection (see RC2_API_CONTRACTS.md).
 * - Allowlisted descriptors for purchasing/training/attendance-correction detail routes.
 * - Dedicated "pending purchasing/training review for me" repository surfaces beyond
 *   module list endpoints (PurchaseRepository / TrainingRepository have no my-work slice).
 *
 * Supported sources today: LeaveRepository (review + own), TaskRepository (assignments),
 * AttendanceRepository (today self clock-in/out only).
 */
object MyWorkAggregator {

    fun aggregate(
        snapshot: MyWorkSnapshot,
        permissions: MyWorkPermissions,
        categoryFilter: String? = null
    ): List<MyWorkItem> {
        if (!permissions.hasAnySource) return emptyList()

        val items = buildList {
            if (permissions.canReviewLeaves) {
                addAll(reviewLeaveItems(snapshot))
            }
            if (permissions.canViewOwnLeaves) {
                addAll(ownLeaveItems(snapshot))
            }
            if (permissions.canViewTasks) {
                addAll(ownTaskItems(snapshot))
            }
            if (permissions.canReviewTasks) {
                addAll(taskReviewItems(snapshot))
            }
            if (permissions.canClockAttendance || permissions.canViewOwnAttendance) {
                addAll(attendanceItems(snapshot, permissions))
            }
        }
            .sortedByDescending { it.sortKey }

        return categoryFilter
            ?.let { filter -> items.filter { it.category.key == filter } }
            ?: items
    }

    private fun reviewLeaveItems(snapshot: MyWorkSnapshot): List<MyWorkItem> =
        snapshot.leaveReviewQueue
            .asSequence()
            .filter { it.companyId == snapshot.companyId }
            .filter { it.isPendingHr() || it.isPendingAdmin() }
            .map { request ->
                val descriptor = leaveDetailDescriptor(request.id)
                MyWorkItem(
                    id = "leave-review-${request.id}",
                    category = MyWorkCategory.LEAVES,
                    title = "مراجعة إجازة: ${request.employeeName}",
                    subtitle = "${request.leaveType} • ${request.startDate} → ${request.endDate}",
                    sortKey = request.requestedAt.ifBlank { request.createdAt },
                    actionKind = MyWorkActionKind.REVIEW_LEAVE,
                    destination = NavigationCoordinator.resolveDestination(descriptor),
                    resourceDescriptor = descriptor
                )
            }
            .toList()

    private fun ownLeaveItems(snapshot: MyWorkSnapshot): List<MyWorkItem> {
        val employeeId = snapshot.employeeId ?: return emptyList()
        return snapshot.ownLeaveRequests
            .asSequence()
            .filter { it.companyId == snapshot.companyId && it.employeeId == employeeId }
            .filter { canCancelOwnLeave(it, employeeId) }
            .map { request ->
                val descriptor = leaveDetailDescriptor(request.id)
                MyWorkItem(
                    id = "leave-own-${request.id}",
                    category = MyWorkCategory.LEAVES,
                    title = "متابعة طلب إجازتي",
                    subtitle = "${request.leaveType} • ${request.startDate} → ${request.endDate}",
                    sortKey = request.requestedAt.ifBlank { request.createdAt },
                    actionKind = MyWorkActionKind.TRACK_OWN_LEAVE,
                    destination = NavigationCoordinator.resolveDestination(descriptor),
                    resourceDescriptor = descriptor
                )
            }
            .toList()
    }

    private fun ownTaskItems(snapshot: MyWorkSnapshot): List<MyWorkItem> {
        val employeeId = snapshot.employeeId ?: return emptyList()
        return snapshot.tasks
            .asSequence()
            .filter { it.companyId == snapshot.companyId }
            .flatMap { task -> task.assignments.asSequence().map { assignment -> task to assignment } }
            .filter { (_, assignment) ->
                assignment.employeeId == employeeId && isOwnTaskActionable(assignment.status)
            }
            .map { (task, assignment) ->
                val descriptor = taskDetailDescriptor(task.id)
                MyWorkItem(
                    id = "task-own-${assignment.id}",
                    category = MyWorkCategory.TASKS,
                    title = task.title,
                    subtitle = "مهمتي • ${taskStatusLabel(assignment.status)}",
                    sortKey = assignment.updatedAt ?: assignment.createdAt ?: task.createdAt.orEmpty(),
                    actionKind = MyWorkActionKind.WORK_ON_TASK,
                    destination = NavigationCoordinator.resolveDestination(descriptor),
                    resourceDescriptor = descriptor
                )
            }
            .toList()
    }

    private fun taskReviewItems(snapshot: MyWorkSnapshot): List<MyWorkItem> {
        val employeeId = snapshot.employeeId
        return snapshot.tasks
            .asSequence()
            .filter { it.companyId == snapshot.companyId }
            .flatMap { task -> task.assignments.asSequence().map { assignment -> task to assignment } }
            .filter { (_, assignment) ->
                canReviewTaskAssignment(assignment.status) &&
                    !employeeId.isNullOrBlank() &&
                    assignment.employeeId != employeeId
            }
            .map { (task, assignment) ->
                val descriptor = taskDetailDescriptor(task.id)
                MyWorkItem(
                    id = "task-review-${assignment.id}",
                    category = MyWorkCategory.TASKS,
                    title = "مراجعة مهمة: ${assignment.employeeName}",
                    subtitle = "${task.title} • ${taskStatusLabel(assignment.status)}",
                    sortKey = assignment.submittedAt ?: assignment.updatedAt.orEmpty(),
                    actionKind = MyWorkActionKind.REVIEW_TASK,
                    destination = NavigationCoordinator.resolveDestination(descriptor),
                    resourceDescriptor = descriptor
                )
            }
            .toList()
    }

    private fun attendanceItems(
        snapshot: MyWorkSnapshot,
        permissions: MyWorkPermissions
    ): List<MyWorkItem> {
        if (!permissions.canClockAttendance) return emptyList()
        val employeeId = snapshot.employeeId ?: return emptyList()
        val ownRecord = snapshot.todayAttendance
            .firstOrNull { record ->
                record.companyId == snapshot.companyId && record.employeeId == employeeId
            }

        return when {
            ownRecord == null || ownRecord.clockInTime.isNullOrBlank() -> {
                listOf(clockItem("attendance-clock-in", MyWorkActionKind.CLOCK_IN, "تسجيل حضور اليوم", "لم يتم تسجيل حضورك بعد."))
            }
            ownRecord.clockOutTime.isNullOrBlank() -> {
                listOf(
                    clockItem(
                        "attendance-clock-out-${ownRecord.id}",
                        MyWorkActionKind.CLOCK_OUT,
                        "تسجيل انصراف اليوم",
                        "تم تسجيل حضورك الساعة ${ownRecord.clockInTime}."
                    )
                )
            }
            else -> emptyList()
        }
    }

    private fun clockItem(
        id: String,
        actionKind: MyWorkActionKind,
        title: String,
        subtitle: String
    ): MyWorkItem {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "attendance.today",
            resourceType = "attendance"
        )
        return MyWorkItem(
            id = id,
            category = MyWorkCategory.ATTENDANCE,
            title = title,
            subtitle = subtitle,
            sortKey = "9999-attendance",
            actionKind = actionKind,
            destination = NavigationCoordinator.resolveDestination(descriptor),
            resourceDescriptor = descriptor
        )
    }

    private fun isOwnTaskActionable(status: String): Boolean =
        canStartTaskAssignment(status) || canSubmitTaskAssignment(status)

    private fun leaveDetailDescriptor(leaveId: String): ResourceDescriptor =
        ResourceDescriptor.parse(
            routeKey = "leave.detail",
            resourceType = "leave",
            resourceId = leaveId
        )

    private fun taskDetailDescriptor(taskId: String): ResourceDescriptor =
        ResourceDescriptor.parse(
            routeKey = "task.detail",
            resourceType = "task",
            resourceId = taskId
        )
}
