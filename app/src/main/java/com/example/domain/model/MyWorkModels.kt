package com.example.domain.model

import androidx.annotation.StringRes
import com.example.R
import com.example.ui.navigation.ResourceDescriptor
import com.example.ui.navigation.TypedDestination

enum class MyWorkCategory(val key: String, @StringRes val labelRes: Int) {
    LEAVES("leaves", R.string.my_work_category_leaves),
    TASKS("tasks", R.string.my_work_category_tasks),
    ATTENDANCE("attendance", R.string.my_work_category_attendance)
}

enum class MyWorkActionKind {
    REVIEW_LEAVE,
    TRACK_OWN_LEAVE,
    WORK_ON_TASK,
    REVIEW_TASK,
    CLOCK_IN,
    CLOCK_OUT
}

data class MyWorkItem(
    val id: String,
    val category: MyWorkCategory,
    val title: String,
    val subtitle: String,
    val sortKey: String,
    val actionKind: MyWorkActionKind,
    val destination: TypedDestination,
    val resourceDescriptor: ResourceDescriptor
)

/**
 * In-memory inputs for [com.example.ui.MyWorkAggregator]. Lists must already be
 * tenant-scoped by their repositories; the aggregator re-checks [companyId].
 */
data class MyWorkSnapshot(
    val companyId: String,
    val employeeId: String?,
    val leaveReviewQueue: List<LeaveRequestParams> = emptyList(),
    val ownLeaveRequests: List<LeaveRequestParams> = emptyList(),
    val tasks: List<TaskParams> = emptyList(),
    val todayAttendance: List<AttendanceRecordParams> = emptyList()
)

data class MyWorkPermissions(
    val canReviewLeaves: Boolean,
    val canViewOwnLeaves: Boolean,
    val canViewTasks: Boolean,
    val canReviewTasks: Boolean,
    val canClockAttendance: Boolean,
    val canViewOwnAttendance: Boolean
) {
    val hasAnySource: Boolean =
        canReviewLeaves ||
            canViewOwnLeaves ||
            canViewTasks ||
            canReviewTasks ||
            canClockAttendance ||
            canViewOwnAttendance

    companion object {
        fun from(permissions: Set<String>): MyWorkPermissions {
            val isAdmin = com.example.core.permissions.Permissions.ADMIN_FULL in permissions
            return MyWorkPermissions(
                canReviewLeaves = isAdmin ||
                    com.example.core.permissions.Permissions.LEAVES_REVIEW in permissions,
                canViewOwnLeaves = isAdmin ||
                    com.example.core.permissions.Permissions.LEAVES_VIEW_OWN in permissions ||
                    com.example.core.permissions.Permissions.LEAVES_CREATE in permissions,
                canViewTasks = isAdmin ||
                    com.example.core.permissions.Permissions.TASKS_VIEW_OWN in permissions ||
                    com.example.core.permissions.Permissions.TASKS_VIEW_DEPARTMENT in permissions ||
                    com.example.core.permissions.Permissions.TASKS_VIEW_COMPANY in permissions,
                canReviewTasks = isAdmin ||
                    com.example.core.permissions.Permissions.TASKS_REVIEW in permissions,
                canClockAttendance =
                    com.example.core.permissions.Permissions.ATTENDANCE_CLOCK in permissions && !isAdmin,
                canViewOwnAttendance = isAdmin ||
                    com.example.core.permissions.Permissions.ATTENDANCE_VIEW_OWN in permissions ||
                    com.example.core.permissions.Permissions.ATTENDANCE_CLOCK in permissions
            )
        }
    }
}
