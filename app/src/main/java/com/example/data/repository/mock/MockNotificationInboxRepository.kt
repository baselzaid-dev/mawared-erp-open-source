package com.example.data.repository.mock

import com.example.core.utils.AppResult
import com.example.domain.model.NotificationInboxItem
import com.example.domain.model.NotificationInboxPage
import com.example.domain.model.NotificationPreference
import com.example.domain.model.NotificationPreferenceUpdate
import com.example.domain.model.NotificationResourceTarget
import com.example.domain.repository.NotificationInboxRepository

class MockNotificationInboxRepository : NotificationInboxRepository {
    private val preferences = linkedMapOf(
        "general" to NotificationPreference("general", inAppEnabled = true),
        "security" to NotificationPreference("security", inAppEnabled = true, mandatory = true),
        "leave" to NotificationPreference("leave", inAppEnabled = true),
        "task" to NotificationPreference("task", inAppEnabled = true),
        "attendance" to NotificationPreference("attendance", inAppEnabled = true)
    )

    private val items = mutableListOf(
        NotificationInboxItem(
            id = "demo-notification-1",
            title = "طلب إجازة جديد",
            message = "تم تقديم طلب إجازة ويحتاج إلى مراجعتك.",
            category = "leave",
            isRead = false,
            createdAtLabel = "2026-07-19 09:30",
            resourceTarget = NotificationResourceTarget(
                routeKey = "leave.detail",
                resourceType = "leave",
                resourceId = "leave-demo-1"
            )
        ),
        NotificationInboxItem(
            id = "demo-notification-2",
            title = "مهمة جديدة",
            message = "تم تعيين مهمة جديدة لك.",
            category = "task",
            isRead = true,
            createdAtLabel = "2026-07-18 16:00",
            resourceTarget = NotificationResourceTarget(
                routeKey = "task.detail",
                resourceType = "task",
                resourceId = "task-demo-1"
            )
        ),
        NotificationInboxItem(
            id = "demo-notification-3",
            title = "تنبيه أمني",
            message = "تم تسجيل دخول جديد إلى حسابك.",
            category = "security",
            isRead = false,
            createdAtLabel = "2026-07-18 08:15"
        )
    )

    override suspend fun loadInbox(
        category: String?,
        read: Boolean?,
        hidden: Boolean,
        cursor: String?,
        limit: Int?
    ): AppResult<NotificationInboxPage> {
        if (hidden) {
            return AppResult.Success(NotificationInboxPage(items = emptyList()))
        }

        var visible = items.toList()
        if (category != null) {
            visible = visible.filter { it.category == category.lowercase() }
        }
        if (read != null) {
            visible = visible.filter { it.isRead == read }
        }

        val pageSize = limit ?: visible.size
        val startIndex = cursor?.toIntOrNull() ?: 0
        val pageItems = visible.drop(startIndex).take(pageSize)
        val nextCursor = if (startIndex + pageItems.size < visible.size) {
            (startIndex + pageItems.size).toString()
        } else {
            null
        }

        return AppResult.Success(
            NotificationInboxPage(
                items = pageItems,
                nextCursor = nextCursor,
                hasMore = nextCursor != null
            )
        )
    }

    override suspend fun markAsRead(id: String): AppResult<NotificationInboxItem> {
        val index = items.indexOfFirst { it.id == id }
        if (index < 0) {
            return AppResult.Error(Exception("notification.not_found"))
        }
        val updated = items[index].copy(isRead = true)
        items[index] = updated
        return AppResult.Success(updated)
    }

    override suspend fun markAllRead(category: String?): AppResult<Int> {
        var updatedCount = 0
        items.replaceAll { item ->
            val matchesCategory = category == null || item.category == category.lowercase()
            if (matchesCategory && !item.isRead) {
                updatedCount += 1
                item.copy(isRead = true)
            } else {
                item
            }
        }
        return AppResult.Success(updatedCount)
    }

    override suspend fun hide(id: String): AppResult<Unit> {
        val removed = items.removeAll { it.id == id }
        return if (removed) {
            AppResult.Success(Unit)
        } else {
            AppResult.Error(Exception("notification.not_found"))
        }
    }

    override suspend fun loadPreferences(): AppResult<List<NotificationPreference>> =
        AppResult.Success(preferences.values.toList())

    override suspend fun savePreferences(
        preferences: List<NotificationPreferenceUpdate>
    ): AppResult<List<NotificationPreference>> {
        preferences.forEach { update ->
            val existing = this.preferences[update.category]
            if (existing != null && !existing.mandatory) {
                this.preferences[update.category] = existing.copy(inAppEnabled = update.inAppEnabled)
            }
        }
        return AppResult.Success(this.preferences.values.toList())
    }
}
