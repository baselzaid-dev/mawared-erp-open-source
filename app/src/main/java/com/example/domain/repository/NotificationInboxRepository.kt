package com.example.domain.repository

import com.example.core.utils.AppResult
import com.example.domain.model.NotificationInboxItem
import com.example.domain.model.NotificationInboxPage
import com.example.domain.model.NotificationPreference
import com.example.domain.model.NotificationPreferenceUpdate

interface NotificationInboxRepository {
    suspend fun loadInbox(
        category: String? = null,
        read: Boolean? = null,
        hidden: Boolean = false,
        cursor: String? = null,
        limit: Int? = null
    ): AppResult<NotificationInboxPage>

    suspend fun markAsRead(id: String): AppResult<NotificationInboxItem>

    suspend fun markAllRead(category: String? = null): AppResult<Int>

    suspend fun hide(id: String): AppResult<Unit>

    suspend fun loadPreferences(): AppResult<List<NotificationPreference>>

    suspend fun savePreferences(
        preferences: List<NotificationPreferenceUpdate>
    ): AppResult<List<NotificationPreference>>
}
