package com.example.ui.navigation

/**
 * Pure structural mapping from allowlisted descriptors to typed destinations.
 * Never loads data, never grants access, and never executes linked actions.
 */
object NavigationCoordinator {

    enum class TargetLoadState {
        Normal,
        Stale,
        Revoked
    }

    fun resolveDestination(descriptor: ResourceDescriptor): TypedDestination =
        resolveDestination(descriptor, TargetLoadState.Normal)

    fun resolveDestination(
        descriptor: ResourceDescriptor,
        targetLoadState: TargetLoadState
    ): TypedDestination {
        if (descriptor.isUnavailable()) {
            val reason = descriptor.resourceId
                ?.let { runCatching { UnavailableReason.valueOf(it) }.getOrNull() }
                ?: UnavailableReason.Unknown
            return TypedDestination.Unavailable(reason = reason)
        }

        if (targetLoadState == TargetLoadState.Stale || targetLoadState == TargetLoadState.Revoked) {
            return TypedDestination.Stale(resourceLabel = descriptor.routeKey)
        }

        return mapKnownDescriptor(descriptor)
    }

    private fun mapKnownDescriptor(descriptor: ResourceDescriptor): TypedDestination =
        when (descriptor.routeKey) {
            "dashboard.home" -> TypedDestination.Dashboard
            "my_work.list" -> TypedDestination.MyWork(category = readFilterValue(descriptor, "category"))
            "notifications.inbox" -> TypedDestination.Notifications(
                category = readFilterValue(descriptor, "category")
            )
            "employees.list" -> TypedDestination.Employees(
                employeeId = descriptor.resourceId ?: readFilterValue(descriptor, "employeeId"),
                filterJson = descriptor.filterJson
            )
            "attendance.today", "attendance.list" -> TypedDestination.Attendance(
                filterJson = descriptor.filterJson
            )
            "attendance.corrections" -> TypedDestination.AttendanceCorrections(
                filterJson = descriptor.filterJson
            )
            "attendance_correction.detail" -> TypedDestination.AttendanceCorrectionDetail(
                correctionId = descriptor.resourceId.orEmpty()
            )
            "attendance.exemptions" -> TypedDestination.AttendanceExemptions(
                filterJson = descriptor.filterJson
            )
            "leaves.pending" -> TypedDestination.MyWork(
                category = readFilterValue(descriptor, "category") ?: "leaves"
            )
            "leave.detail" -> TypedDestination.LeaveDetail(
                leaveId = descriptor.resourceId.orEmpty()
            )
            "task.detail" -> TypedDestination.TaskDetail(
                taskId = descriptor.resourceId.orEmpty()
            )
            "chat.conversation" -> TypedDestination.Chat(
                conversationId = descriptor.resourceId
            )
            "reports.builder" -> TypedDestination.Reports(
                templateKey = readFilterValue(descriptor, "templateKey"),
                savedTemplateId = null
            )
            "reports.saved" -> TypedDestination.Reports(
                templateKey = readFilterValue(descriptor, "templateKey"),
                savedTemplateId = descriptor.resourceId
            )
            "purchasing.requests", "purchasing.requests.detail" -> TypedDestination.Purchasing(
                requestId = descriptor.resourceId ?: readFilterValue(descriptor, "requestId"),
                filterJson = descriptor.filterJson
            )
            "vendors.list" -> TypedDestination.Vendors(
                vendorId = descriptor.resourceId ?: readFilterValue(descriptor, "vendorId"),
                filterJson = descriptor.filterJson
            )
            "training.courses" -> TypedDestination.Training(
                courseId = descriptor.resourceId ?: readFilterValue(descriptor, "courseId"),
                filterJson = descriptor.filterJson
            )
            "payroll.list" -> TypedDestination.Payroll(
                filterJson = descriptor.filterJson
            )
            "employees.profile" -> TypedDestination.Employees(
                employeeId = descriptor.resourceId,
                filterJson = descriptor.filterJson
            )
            "auth.sessions" -> TypedDestination.Sessions
            else -> TypedDestination.Unavailable(reason = UnavailableReason.UnsupportedRoute)
        }

    private fun readFilterValue(descriptor: ResourceDescriptor, key: String): String? {
        val raw = descriptor.filterJson ?: return null
        val pattern = Regex(""""$key"\s*:\s*"([^"\\]+)"""")
        return pattern.find(raw)?.groupValues?.getOrNull(1)?.takeIf { it.isNotBlank() }
    }
}
