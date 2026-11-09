package com.example.ui.navigation

/**
 * Typed RC2 navigation targets. These describe where the UI should go, not whether
 * the caller may load underlying data — authorization happens in module endpoints.
 */
sealed interface TypedDestination {

    data object Dashboard : TypedDestination

    data class MyWork(val category: String? = null) : TypedDestination

    data class Notifications(val category: String? = null) : TypedDestination

    data class Attendance(val filterJson: String? = null) : TypedDestination

    data class AttendanceCorrections(val filterJson: String? = null) : TypedDestination

    data class AttendanceCorrectionDetail(val correctionId: String) : TypedDestination

    data class AttendanceExemptions(val filterJson: String? = null) : TypedDestination

    data class LeaveDetail(val leaveId: String) : TypedDestination

    data class TaskDetail(val taskId: String) : TypedDestination

    data class Chat(val conversationId: String? = null) : TypedDestination

    data class Employees(
        val employeeId: String? = null,
        val filterJson: String? = null
    ) : TypedDestination

    data class Purchasing(
        val requestId: String? = null,
        val filterJson: String? = null
    ) : TypedDestination

    data class Vendors(
        val vendorId: String? = null,
        val filterJson: String? = null
    ) : TypedDestination

    data class Training(
        val courseId: String? = null,
        val filterJson: String? = null
    ) : TypedDestination

    data class Payroll(
        val filterJson: String? = null
    ) : TypedDestination

    data object Sessions : TypedDestination

    data class Reports(
        val templateKey: String? = null,
        val savedTemplateId: String? = null
    ) : TypedDestination

    data class Unavailable(val reason: UnavailableReason = UnavailableReason.Unknown) : TypedDestination

    data class Stale(val resourceLabel: String? = null) : TypedDestination
}

enum class UnavailableReason {
    Unknown,
    MalformedDescriptor,
    UnsupportedRoute
}
