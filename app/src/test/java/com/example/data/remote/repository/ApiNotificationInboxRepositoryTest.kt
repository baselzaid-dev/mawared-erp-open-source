package com.example.data.remote.repository

import com.example.core.utils.AppResult
import com.example.data.remote.api.NotificationApi
import com.example.data.remote.api.NotificationDto
import com.example.data.remote.api.NotificationListResponseDto
import com.example.data.remote.api.NotificationPreferenceDto
import com.example.data.remote.api.NotificationPreferencesResponseDto
import com.example.data.remote.api.NotificationReadAllRequestDto
import com.example.data.remote.api.NotificationReadAllResponseDto
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

class ApiNotificationInboxRepositoryTest {
    @Test
    fun `load inbox maps descriptors and pagination`() = runTest {
        val api = FakeNotificationApi()
        val result = ApiNotificationInboxRepository(api).loadInbox(category = "leave") as AppResult.Success

        assertEquals("leave", api.lastCategory)
        assertEquals("false", api.lastHidden)
        assertEquals(1, result.data.items.size)
        assertEquals("leave", result.data.items.single().category)
        assertEquals("task.detail", result.data.items.single().resourceTarget?.routeKey)
        assertTrue(result.data.hasMore)
        assertEquals("cursor-2", result.data.nextCursor)
    }

    @Test
    fun `mark read and hide propagate server failures`() = runTest {
        val api = FakeNotificationApi()
        val repository = ApiNotificationInboxRepository(api)

        api.markReadResponse = Response.error(
            404,
            """{"messageKey":"notification.not_found"}"""
                .toResponseBody("application/json".toMediaType())
        )
        val missing = repository.markAsRead("missing") as AppResult.Error
        assertEquals("notification.not_found", missing.exception.message)

        api.hideResponse = Response.error(
            403,
            """{"messageKey":"notification.unauthorized"}"""
                .toResponseBody("application/json".toMediaType())
        )
        val forbidden = repository.hide("n-1") as AppResult.Error
        assertEquals("notification.unauthorized", forbidden.exception.message)
    }

    @Test
    fun `preferences load and save stay typed`() = runTest {
        val api = FakeNotificationApi()
        val repository = ApiNotificationInboxRepository(api)

        val loaded = repository.loadPreferences() as AppResult.Success
        assertTrue(loaded.data.any { it.category == "security" && it.mandatory })

        val saved = repository.savePreferences(
            listOf(
                com.example.domain.model.NotificationPreferenceUpdate("general", false)
            )
        ) as AppResult.Success
        assertEquals(false, saved.data.first { it.category == "general" }.inAppEnabled)
        assertEquals(1, api.lastPreferenceUpdates.size)
    }

    private class FakeNotificationApi : NotificationApi {
        var lastCategory: String? = null
        var lastHidden: String? = null
        var lastPreferenceUpdates = emptyList<com.example.data.remote.api.NotificationPreferencePutItemDto>()
        var markReadResponse: Response<NotificationDto> = Response.success(
            NotificationDto(
                id = "n-1",
                title = "Updated",
                message = "Updated body",
                isRead = true,
                createdAt = "2026-07-19T09:30:00.000Z",
                category = "general"
            )
        )
        var hideResponse: Response<Map<String, Boolean>> = Response.success(mapOf("hidden" to true))

        override suspend fun getNotifications(): Response<List<NotificationDto>> =
            Response.success(emptyList())

        override suspend fun getUnreadCount() =
            Response.success(com.example.data.remote.api.UnreadCountDto(0))

        override suspend fun markAsRead(id: String): Response<Map<String, Boolean>> =
            Response.success(mapOf("read" to true))

        override suspend fun listV2(
            category: String?,
            read: String?,
            hidden: String?,
            cursor: String?,
            limit: Int?
        ): Response<NotificationListResponseDto> {
            lastCategory = category
            lastHidden = hidden
            return Response.success(
                NotificationListResponseDto(
                    items = listOf(
                        NotificationDto(
                            id = "n-1",
                            title = "Leave update",
                            message = "Needs review",
                            isRead = false,
                            createdAt = "2026-07-19T09:30:00.000Z",
                            category = "leave",
                            descriptor = com.example.data.remote.api.NotificationDescriptorDto(
                                routeKey = "task.detail",
                                resourceType = "task",
                                resourceId = "task-1"
                            )
                        )
                    ),
                    nextCursor = "cursor-2",
                    hasMore = true
                )
            )
        }

        override suspend fun markAsReadV2(id: String): Response<NotificationDto> = markReadResponse

        override suspend fun markAllReadV2(body: NotificationReadAllRequestDto): Response<NotificationReadAllResponseDto> =
            Response.success(NotificationReadAllResponseDto(updatedCount = 2))

        override suspend fun hideV2(id: String): Response<Map<String, Boolean>> = hideResponse

        override suspend fun getPreferencesV2(): Response<NotificationPreferencesResponseDto> =
            Response.success(
                NotificationPreferencesResponseDto(
                    preferences = listOf(
                        NotificationPreferenceDto("general", true),
                        NotificationPreferenceDto("security", true, mandatory = true)
                    )
                )
            )

        override suspend fun putPreferencesV2(
            body: com.example.data.remote.api.NotificationPreferencesPutRequestDto
        ): Response<NotificationPreferencesResponseDto> {
            lastPreferenceUpdates = body.preferences
            return Response.success(
                NotificationPreferencesResponseDto(
                    preferences = body.preferences.map {
                        NotificationPreferenceDto(it.category, it.inAppEnabled)
                    }
                )
            )
        }
    }
}
