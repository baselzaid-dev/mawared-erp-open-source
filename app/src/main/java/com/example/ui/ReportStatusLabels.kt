package com.example.ui

import androidx.annotation.StringRes
import com.example.R

/** Status filter options for Unified Reports — API values unchanged; labels via resources. */
internal fun reportStatusOptionRes(type: String): List<Pair<String?, Int>> = when (type) {
    "attendance" -> listOf(
        null to R.string.reports_all_statuses,
        "present" to R.string.attendance_status_present,
        "late" to R.string.attendance_status_late,
        "absent" to R.string.attendance_status_absent
    )
    "leaves" -> listOf(
        null to R.string.reports_all_statuses,
        "pending_hr" to R.string.status_pending_hr,
        "pending_admin" to R.string.status_pending_admin,
        "approved" to R.string.status_approved,
        "rejected" to R.string.status_rejected,
        "cancelled" to R.string.status_cancelled
    )
    "tasks" -> listOf(
        null to R.string.reports_all_statuses,
        "active" to R.string.reports_status_active_tasks,
        "completed" to R.string.status_completed,
        "cancelled" to R.string.status_cancelled,
        "submitted" to R.string.status_submitted,
        "returned" to R.string.status_returned
    )
    "purchasing" -> listOf(
        null to R.string.reports_all_statuses,
        "pending_department" to R.string.status_pending_department,
        "pending_purchasing" to R.string.status_pending_purchasing,
        "approved" to R.string.status_approved,
        "ordered" to R.string.reports_status_ordered,
        "received" to R.string.reports_status_received,
        "cancelled" to R.string.status_cancelled
    )
    "training" -> listOf(
        null to R.string.reports_all_statuses,
        "draft" to R.string.training_status_draft,
        "published" to R.string.training_status_published,
        "completed" to R.string.training_status_completed,
        "cancelled" to R.string.training_status_cancelled,
        "archived" to R.string.training_status_archived
    )
    else -> emptyList()
}

@StringRes
internal fun reportDisplayValueRes(value: String): Int? = when (value) {
    "present" -> R.string.attendance_status_present
    "late" -> R.string.attendance_status_late
    "absent" -> R.string.attendance_status_absent
    "active" -> R.string.status_active
    "completed" -> R.string.status_completed
    "cancelled" -> R.string.status_cancelled
    "approved" -> R.string.status_approved
    "paid" -> R.string.reports_status_paid
    "request" -> R.string.reports_status_request
    "order" -> R.string.reports_status_order
    "draft" -> R.string.training_status_draft
    "published" -> R.string.training_status_published
    "pending_hr" -> R.string.status_pending_hr
    "pending_admin" -> R.string.status_pending_admin
    "pending_department" -> R.string.status_pending_department
    "pending_purchasing" -> R.string.status_pending_purchasing
    "rejected" -> R.string.status_rejected
    "submitted" -> R.string.status_submitted
    "returned" -> R.string.status_returned
    "ordered" -> R.string.reports_status_ordered
    "received" -> R.string.reports_status_received
    "archived" -> R.string.training_status_archived
    else -> null
}
