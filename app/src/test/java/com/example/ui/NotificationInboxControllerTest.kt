package com.example.ui

import com.example.core.utils.AppResult
import com.example.domain.model.NotificationInboxItem
import com.example.domain.model.NotificationInboxPage
import com.example.domain.model.NotificationPreference
import com.example.domain.model.NotificationPreferenceUpdate
import com.example.domain.repository.NotificationInboxRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class NotificationInboxControllerTest {
    @Test
    fun `load shows content then empty after hide all`() = runTest {
        val repository = FakeNotificationInboxRepository()
        val controller = NotificationInboxController(repository, backgroundScope)

        controller.load()
        runCurrent()

        val content = controller.state.value as NotificationCenterUiState.Content
        assertEquals(2, content.items.size)

        content.items.forEach { controller.onHide(it.id) }
        runCurrent()

        assertEquals(NotificationCenterUiState.Empty, controller.state.value)
    }

    @Test
    fun `server failure surfaces error without optimistic success`() = runTest {
        val repository = FakeNotificationInboxRepository(failLoad = true)
        val controller = NotificationInboxController(repository, backgroundScope)

        controller.load()
        runCurrent()

        val error = controller.state.value as NotificationCenterUiState.Error
        assertTrue(error.message.isNotBlank())
        assertEquals(1, repository.loadCalls)
    }

    @Test
    fun `category filter keeps empty category content state`() = runTest {
        val repository = FakeNotificationInboxRepository()
        val controller = NotificationInboxController(repository, backgroundScope)

        controller.load()
        runCurrent()
        controller.onCategorySelected("security")
        runCurrent()

        val filtered = controller.state.value as NotificationCenterUiState.Content
        assertEquals("security", filtered.selectedCategory)
        assertTrue(filtered.items.isEmpty())
    }

    @Test
    fun `mark read updates item only after success`() = runTest {
        val repository = FakeNotificationInboxRepository()
        val controller = NotificationInboxController(repository, backgroundScope)

        controller.load()
        runCurrent()

        val unreadId = (controller.state.value as NotificationCenterUiState.Content)
            .items
            .first { !it.isRead }
            .id

        controller.onMarkRead(unreadId)
        runCurrent()

        val updated = controller.state.value as NotificationCenterUiState.Content
        assertTrue(updated.items.first { it.id == unreadId }.isRead)
    }

    @Test
    fun `reset clears cached inbox state`() = runTest {
        val repository = FakeNotificationInboxRepository()
        val controller = NotificationInboxController(repository, backgroundScope)

        controller.load()
        runCurrent()
        controller.reset()

        assertEquals(NotificationCenterUiState.Loading, controller.state.value)
        assertNull(controller.preferences.value)
    }

    @Test
    fun `resource descriptor extension maps domain target for navigation`() = runTest {
        val item = NotificationInboxItem(
            id = "n-1",
            title = "Task",
            message = "Assigned",
            category = "task",
            isRead = false,
            createdAtLabel = "now",
            resourceTarget = com.example.domain.model.NotificationResourceTarget(
                routeKey = "task.detail",
                resourceType = "task",
                resourceId = "task-1"
            )
        )

        val descriptor = item.resourceDescriptor
        assertEquals("task.detail", descriptor?.routeKey)
        assertEquals("task-1", descriptor?.resourceId)
    }

    private class FakeNotificationInboxRepository(
        private val failLoad: Boolean = false
    ) : NotificationInboxRepository {
        var loadCalls = 0
        private val items = mutableListOf(
            NotificationInboxItem(
                id = "n-unread",
                title = "Unread",
                message = "Body",
                category = "general",
                isRead = false,
                createdAtLabel = "now"
            ),
            NotificationInboxItem(
                id = "n-read",
                title = "Read",
                message = "Body",
                category = "general",
                isRead = true,
                createdAtLabel = "now"
            )
        )

        override suspend fun loadInbox(
            category: String?,
            read: Boolean?,
            hidden: Boolean,
            cursor: String?,
            limit: Int?
        ): AppResult<NotificationInboxPage> {
            loadCalls += 1
            if (failLoad) {
                return AppResult.Error(Exception("network down"))
            }
            val filtered = if (category == null) {
                items
            } else {
                items.filter { it.category == category }
            }
            return AppResult.Success(NotificationInboxPage(items = filtered))
        }

        override suspend fun markAsRead(id: String): AppResult<NotificationInboxItem> {
            val index = items.indexOfFirst { it.id == id }
            if (index < 0) return AppResult.Error(Exception("notification.not_found"))
            val updated = items[index].copy(isRead = true)
            items[index] = updated
            return AppResult.Success(updated)
        }

        override suspend fun markAllRead(category: String?): AppResult<Int> = AppResult.Success(0)

        override suspend fun hide(id: String): AppResult<Unit> {
            items.removeAll { it.id == id }
            return AppResult.Success(Unit)
        }

        override suspend fun loadPreferences(): AppResult<List<NotificationPreference>> =
            AppResult.Success(emptyList())

        override suspend fun savePreferences(
            preferences: List<NotificationPreferenceUpdate>
        ): AppResult<List<NotificationPreference>> = AppResult.Success(emptyList())
    }
}
