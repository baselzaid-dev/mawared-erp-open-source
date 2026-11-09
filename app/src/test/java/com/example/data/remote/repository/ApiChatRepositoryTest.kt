package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.ChatApi
import com.example.data.remote.api.ChatConversationDto
import com.example.data.remote.api.ChatConversationPageDto
import com.example.data.remote.api.ChatCreateAnnouncementRequestDto
import com.example.data.remote.api.ChatDepartmentDto
import com.example.data.remote.api.ChatDirectoryUserDto
import com.example.data.remote.api.ChatMessageDto
import com.example.data.remote.api.ChatMessagePageDto
import com.example.data.remote.api.ChatOpenDirectRequestDto
import com.example.data.remote.api.ChatPinMessageRequestDto
import com.example.data.remote.api.ChatPinnedMessageDto
import com.example.data.remote.api.ChatPinnedMessagePageDto
import com.example.data.remote.api.ChatReadResultDto
import com.example.data.remote.api.ChatSendMessageRequestDto
import com.example.data.remote.api.ChatSenderDto
import com.example.data.remote.api.ChatUnreadCountDto
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

private class FakeChatApi : ChatApi {
    var failWith: Int? = null
    var errorJson: String = """{"message":"تعذر تنفيذ الطلب"}"""
    var lastQuery: String? = null
    var lastLimit: Int? = null
    var lastOffset: Int? = null
    var lastOpenDirect: ChatOpenDirectRequestDto? = null
    var lastSent: ChatSendMessageRequestDto? = null
    var lastConversationId: String? = null
    var lastBefore: String? = null
    var lastAnnouncement: ChatCreateAnnouncementRequestDto? = null
    var lastPinRequest: ChatPinMessageRequestDto? = null
    var lastUnpinMessageId: String? = null

    private val peer = ChatDirectoryUserDto("u2", "سارة", "Finance", "e2", "d2", "المالية", "Finance Manager")
    private val sender = ChatSenderDto("u1", "باسل", "Employee", "تقنية المعلومات")

    private fun <T> failure(): Response<T>? = failWith?.let {
        Response.error(it, errorJson.toResponseBody("application/json".toMediaType()))
    }

    override suspend fun searchDirectory(query: String?, limit: Int): Response<List<ChatDirectoryUserDto>> {
        lastQuery = query
        lastLimit = limit
        return failure() ?: Response.success(listOf(peer))
    }

    override suspend fun getAccessibleDepartments(): Response<List<ChatDepartmentDto>> =
        failure() ?: Response.success(listOf(ChatDepartmentDto("d1", "تقنية المعلومات")))

    override suspend fun getConversations(limit: Int, offset: Int): Response<ChatConversationPageDto> {
        lastLimit = limit
        lastOffset = offset
        return failure() ?: Response.success(
            ChatConversationPageDto(
                items = listOf(chatConversationDto()),
                nextOffset = 30
            )
        )
    }

    override suspend fun openDirect(request: ChatOpenDirectRequestDto): Response<ChatConversationDto> {
        lastOpenDirect = request
        return failure() ?: Response.success(chatConversationDto(peer = peer))
    }

    override suspend fun openDepartment(departmentId: String): Response<ChatConversationDto> =
        failure() ?: Response.success(
            chatConversationDto(
                id = "department-d1",
                type = "department",
                title = "تقنية المعلومات",
                peer = null,
                department = ChatDepartmentDto(departmentId, "تقنية المعلومات")
            )
        )

    override suspend fun getMessages(
        conversationId: String,
        before: String?,
        limit: Int
    ): Response<ChatMessagePageDto> {
        lastConversationId = conversationId
        lastBefore = before
        lastLimit = limit
        return failure() ?: Response.success(
            ChatMessagePageDto(
                items = listOf(
                    chatMessageDto(
                        conversationId = conversationId,
                        sender = sender,
                        replyToMessageId = "parent-1"
                    )
                ),
                nextCursor = "cursor-1",
                order = "chronological"
            )
        )
    }

    override suspend fun sendMessage(
        conversationId: String,
        request: ChatSendMessageRequestDto
    ): Response<ChatMessageDto> {
        lastConversationId = conversationId
        lastSent = request
        return failure() ?: Response.success(
            chatMessageDto(
                conversationId = conversationId,
                sender = sender,
                body = request.body,
                replyToMessageId = request.replyToMessageId
            )
        )
    }

    override suspend fun markRead(conversationId: String): Response<ChatReadResultDto> {
        lastConversationId = conversationId
        return failure() ?: Response.success(ChatReadResultDto(conversationId, 0))
    }

    override suspend fun getUnreadCount(): Response<ChatUnreadCountDto> =
        failure() ?: Response.success(ChatUnreadCountDto(2))

    override suspend fun createAnnouncement(
        request: ChatCreateAnnouncementRequestDto
    ): Response<ChatConversationDto> {
        lastAnnouncement = request
        return failure() ?: Response.success(
            chatConversationDto(
                id = "announcement-1",
                type = "announcement",
                title = request.title,
                peer = null,
                repliesEnabled = false
            )
        )
    }

    override suspend fun getPins(conversationId: String): Response<ChatPinnedMessagePageDto> {
        lastConversationId = conversationId
        return failure() ?: Response.success(
            ChatPinnedMessagePageDto(
                items = listOf(
                    ChatPinnedMessageDto(
                        id = "pin-1",
                        conversationId = conversationId,
                        messageId = "m1",
                        pinnedByUserId = "u1",
                        pinnedAt = "2026-07-10T09:00:00.000Z"
                    )
                )
            )
        )
    }

    override suspend fun pinMessage(
        conversationId: String,
        request: ChatPinMessageRequestDto
    ): Response<ChatPinnedMessageDto> {
        lastConversationId = conversationId
        lastPinRequest = request
        return failure() ?: Response.success(
            ChatPinnedMessageDto(
                id = "pin-1",
                conversationId = conversationId,
                messageId = request.messageId,
                pinnedByUserId = "u1",
                pinnedAt = "2026-07-10T09:00:00.000Z"
            )
        )
    }

    override suspend fun unpinMessage(
        conversationId: String,
        messageId: String
    ): Response<Unit> {
        lastConversationId = conversationId
        lastUnpinMessageId = messageId
        failWith?.let { return failure()!! }
        return Response.success(Unit)
    }
}

private fun chatConversationDto(
    id: String = "direct-u1-u2",
    type: String = "direct",
    title: String = "سارة",
    peer: ChatDirectoryUserDto? = ChatDirectoryUserDto("u2", "سارة", "Finance", "e2", "d2", "المالية", "Finance Manager"),
    department: ChatDepartmentDto? = null,
    repliesEnabled: Boolean? = null
) = ChatConversationDto(
    id = id,
    type = type,
    title = title,
    peer = peer,
    department = department,
    lastMessagePreview = "مرحبا",
    lastMessageAt = "2026-07-10T08:00:00.000Z",
    lastSender = ChatSenderDto("u2", "سارة", "Finance Manager", "المالية"),
    unreadCount = 1,
    createdAt = "2026-07-10T08:00:00.000Z",
    repliesEnabled = repliesEnabled
)

private fun chatMessageDto(
    conversationId: String,
    sender: ChatSenderDto,
    body: String = "مرحبا",
    replyToMessageId: String? = null
) = ChatMessageDto(
    id = "m1",
    conversationId = conversationId,
    sender = sender,
    body = body,
    createdAt = "2026-07-10T08:05:00.000Z",
    isOwn = true,
    replyToMessageId = replyToMessageId
)

class ApiChatRepositoryTest {

    @Test
    fun `directory and conversation mappings keep safe fields and raw type`() = runTest {
        val api = FakeChatApi()
        val repo = ApiChatRepository(api)

        val directory = repo.searchDirectory("  سارة  ", limit = 99) as AppResult.Success
        assertEquals("سارة", directory.data.single().displayName)
        assertEquals("سارة", api.lastQuery)
        assertEquals(50, api.lastLimit)

        val conversations = repo.listConversations(limit = 99, offset = -5) as AppResult.Success
        assertEquals("direct", conversations.data.items.single().type)
        assertTrue(conversations.data.items.single().repliesEnabled)
        assertEquals(50, api.lastLimit)
        assertEquals(0, api.lastOffset)
        assertEquals(30, conversations.data.nextOffset)
    }

    @Test
    fun `open direct department messages send read and unread call expected endpoints`() = runTest {
        val api = FakeChatApi()
        val repo = ApiChatRepository(api)

        assertTrue(repo.openDirect("u2") is AppResult.Success)
        assertEquals("u2", api.lastOpenDirect?.userId)

        val department = repo.openDepartment("d1") as AppResult.Success
        assertEquals("department", department.data.type)

        val messages = repo.loadMessages("c1", before = "cursor", limit = 100) as AppResult.Success
        assertEquals("cursor", api.lastBefore)
        assertEquals(50, api.lastLimit)
        assertEquals("cursor-1", messages.data.nextCursor)
        assertEquals("parent-1", messages.data.items.single().replyToMessageId)

        val sent = repo.sendMessage("c1", "  نص آمن  ", replyToMessageId = " parent-1 ") as AppResult.Success
        assertEquals("نص آمن", api.lastSent?.body)
        assertEquals("parent-1", api.lastSent?.replyToMessageId)
        assertEquals("نص آمن", sent.data.body)
        assertEquals("parent-1", sent.data.replyToMessageId)

        val read = repo.markRead("c1") as AppResult.Success
        assertEquals(0, read.data.unreadCount)
        assertEquals(2, (repo.getUnreadCount() as AppResult.Success).data)
    }

    @Test
    fun `announcement pin and unpin map contract fields including repliesEnabled false`() = runTest {
        val api = FakeChatApi()
        val repo = ApiChatRepository(api)

        val announcement = repo.createAnnouncement("  تنبيه  ", "  نص  ") as AppResult.Success
        assertEquals("تنبيه", api.lastAnnouncement?.title)
        assertEquals("نص", api.lastAnnouncement?.body)
        assertEquals("announcement", announcement.data.type)
        assertFalse(announcement.data.repliesEnabled)

        val pins = repo.listPins("c1") as AppResult.Success
        assertEquals("m1", pins.data.single().messageId)

        val pin = repo.pinMessage("c1", "  m9  ") as AppResult.Success
        assertEquals("m9", api.lastPinRequest?.messageId)
        assertEquals("m9", pin.data.messageId)

        assertTrue(repo.unpinMessage("c1", "m9") is AppResult.Success)
        assertEquals("m9", api.lastUnpinMessageId)
        assertEquals("c1", api.lastConversationId)
    }

    @Test
    fun `null repliesEnabled from backend defaults to true`() = runTest {
        val conversation = ApiChatRepository(FakeChatApi()).openDirect("u2") as AppResult.Success
        assertTrue(conversation.data.repliesEnabled)
    }

    @Test
    fun `blank and oversized messages are blocked locally`() = runTest {
        val repo = ApiChatRepository(FakeChatApi())
        assertTrue(repo.sendMessage("c1", "   ") is AppResult.Error)
        assertTrue(repo.sendMessage("c1", "x".repeat(4001)) is AppResult.Error)
        assertTrue(repo.createAnnouncement("   ") is AppResult.Error)
        assertTrue(repo.createAnnouncement("x".repeat(201)) is AppResult.Error)
    }

    @Test
    fun `Arabic backend errors remain failures and never become fake success`() = runTest {
        val api = FakeChatApi().apply {
            failWith = 403
            errorJson = """{"error":"ChatForbidden","message":"لا تملك صلاحية الوصول إلى هذه المحادثة","code":403}"""
        }
        val result = ApiChatRepository(api).openDirect("u2")
        assertTrue(result is AppResult.Error)
        result as AppResult.Error
        val error = result.appError as AppError.ServerError
        assertEquals(403, error.code)
        assertEquals("لا تملك صلاحية الوصول إلى هذه المحادثة", error.message)

        val pinFail = ApiChatRepository(api).pinMessage("c1", "m1")
        assertTrue(pinFail is AppResult.Error)
    }
}
