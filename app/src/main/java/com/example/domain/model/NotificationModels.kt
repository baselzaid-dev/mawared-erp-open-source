package com.example.domain.model

/**
 * Sprint 12E notification inbox models. UI deep-link mapping stays in the UI layer.
 */
data class NotificationInboxItem(
    val id: String,
    val title: String,
    val message: String,
    val category: String,
    val isRead: Boolean,
    val createdAtLabel: String,
    val resourceTarget: NotificationResourceTarget? = null
)

data class NotificationResourceTarget(
    val routeKey: String,
    val resourceType: String,
    val resourceId: String? = null,
    val filterJson: String? = null
)

data class NotificationInboxPage(
    val items: List<NotificationInboxItem>,
    val nextCursor: String? = null,
    val hasMore: Boolean = false
)

data class NotificationPreference(
    val category: String,
    val inAppEnabled: Boolean,
    val mandatory: Boolean = false
)

data class NotificationPreferenceUpdate(
    val category: String,
    val inAppEnabled: Boolean
)

enum class NotificationCategory(val arabicLabel: String) {
    General("عام"),
    Attendance("الحضور"),
    Leave("الإجازات"),
    Task("المهام"),
    Security("الأمان")
}
