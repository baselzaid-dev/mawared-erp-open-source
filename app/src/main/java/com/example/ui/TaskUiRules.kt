package com.example.ui

import com.example.core.permissions.Permissions

internal fun taskModeLabel(mode: String): String = when (mode) {
    "department" -> "مهام القسم"
    "company" -> "مهام الشركة"
    else -> "مهامي"
}

internal fun taskStatusLabel(status: String): String = when (status) {
    "active" -> "نشطة"
    "completed" -> "مكتملة"
    "cancelled" -> "ملغاة"
    "assigned" -> "مسندة"
    "in_progress" -> "قيد التنفيذ"
    "submitted" -> "بانتظار المراجعة"
    "accepted" -> "مقبولة"
    "returned" -> "معادة"
    else -> status
}

internal fun taskPriorityLabel(priority: String?): String = when (priority) {
    "low" -> "منخفضة"
    "high" -> "عالية"
    "urgent" -> "عاجلة"
    else -> "عادية"
}

internal fun canStartTaskAssignment(status: String): Boolean =
    status == "assigned" || status == "returned"

internal fun canSubmitTaskAssignment(status: String): Boolean =
    status == "assigned" || status == "in_progress" || status == "returned"

internal fun canReviewTaskAssignment(status: String): Boolean = status == "submitted"

internal fun canShowTaskReview(canReview: Boolean, ownAssignment: Boolean, status: String): Boolean =
    canReview && !ownAssignment && canReviewTaskAssignment(status)

internal fun isAcceptedTaskAssignmentImmutable(status: String): Boolean = status == "accepted"

internal fun isTaskCreateVisible(permissions: Set<String>): Boolean =
    Permissions.ADMIN_FULL in permissions || Permissions.TASKS_CREATE in permissions

internal fun isTaskReviewVisible(permissions: Set<String>): Boolean =
    Permissions.ADMIN_FULL in permissions || Permissions.TASKS_REVIEW in permissions

internal fun isReturnNoteValid(action: String, note: String): Boolean =
    action != "return" || note.isNotBlank()
