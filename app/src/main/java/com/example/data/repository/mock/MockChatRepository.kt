package com.example.data.repository.mock

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.domain.model.ChatConversationPage
import com.example.domain.model.ChatConversationParams
import com.example.domain.model.ChatDepartmentSummary
import com.example.domain.model.ChatDirectoryUser
import com.example.domain.model.ChatMessagePage
import com.example.domain.model.ChatMessageParams
import com.example.domain.model.ChatPinnedMessageParams
import com.example.domain.model.ChatReadResult
import com.example.domain.model.ChatReadState
import com.example.domain.model.ChatSender
import com.example.domain.repository.ChatRepository
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

class MockChatRepository : ChatRepository {

    private data class CurrentUser(
        val id: String,
        val name: String,
        val role: String,
        val department: String?
    )

    private val directory = listOf(
        ChatDirectoryUser("1", "موظف تجريبي 3", "مدير الموارد البشرية", "1", "1", "الموارد البشرية", "HR Manager"),
        ChatDirectoryUser("2", "موظف تجريبي 4", "مديرة المالية", "2", "3", "المالية", "Finance Manager"),
        ChatDirectoryUser("3", "موظف تجريبي 5", "مسؤول المشتريات", "3", "4", "المشتريات", "Purchasing Officer"),
        ChatDirectoryUser("4", "موظف تجريبي 6", "موظف", "4", "2", "تقنية المعلومات", "Employee")
    )
    private val departments = listOf(
        ChatDepartmentSummary("1", "الموارد البشرية"),
        ChatDepartmentSummary("2", "تقنية المعلومات"),
        ChatDepartmentSummary("3", "المالية"),
        ChatDepartmentSummary("4", "المشتريات")
    )
    private val directParticipants = mutableMapOf("direct-1-4" to setOf("1", "4"))
    private val conversations = linkedMapOf(
        "direct-1-4" to ChatConversationParams(
            id = "direct-1-4",
            type = "direct",
            title = "محادثة مباشرة",
            peer = null,
            department = null,
            lastMessagePreview = "مرحباً، هل تحتاج إلى مساعدة؟",
            lastMessageAt = "2026-07-10T08:30:00.000Z",
            lastSender = ChatSender("1", "موظف تجريبي 3", "HR Manager", "الموارد البشرية"),
            unreadCount = 0,
            readState = ChatReadState(true, null),
            createdAt = "2026-07-10T08:30:00.000Z",
            repliesEnabled = true
        )
    )
    private val messages = mutableMapOf(
        "direct-1-4" to mutableListOf(
            ChatMessageParams(
                id = "message-1",
                conversationId = "direct-1-4",
                sender = ChatSender("1", "موظف تجريبي 3", "HR Manager", "الموارد البشرية"),
                body = "مرحباً، هل تحتاج إلى مساعدة؟",
                createdAt = "2026-07-10T08:30:00.000Z",
                isOwn = false,
                replyToMessageId = null
            )
        )
    )
    private val pins = mutableMapOf<String, MutableList<ChatPinnedMessageParams>>()
    private val unreadByConversation = mutableMapOf(
        "direct-1-4" to mutableMapOf("4" to 1, "1" to 0)
    )

    @Volatile
    private var currentUser = CurrentUser("", "أنت", "Employee", null)

    private fun nowStamp(): String = SimpleDateFormat(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        Locale.US
    ).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }.format(Date())

    private fun <T> error(message: String, code: Int = 400): AppResult<T> = AppResult.Error(
        Exception(message),
        AppError.ServerError(code, message)
    )

    private fun accessibleDepartmentIds(): Set<String> = when (currentUser.id) {
        "1" -> setOf("1")
        "2" -> setOf("3")
        "3" -> setOf("4")
        "4" -> setOf("2")
        else -> emptySet()
    }

    private fun isAccessible(conversation: ChatConversationParams): Boolean = when (conversation.type) {
        "direct" -> directParticipants[conversation.id]?.contains(currentUser.id) == true
        "department" -> conversation.department?.id in accessibleDepartmentIds()
        "announcement" -> currentUser.id.isNotBlank()
        else -> false
    }

    private fun shapeForCurrentUser(conversation: ChatConversationParams): ChatConversationParams {
        val peer = if (conversation.type == "direct") {
            directParticipants[conversation.id]
                ?.firstOrNull { it != currentUser.id }
                ?.let { peerId -> directory.firstOrNull { it.userId == peerId } }
        } else {
            null
        }
        return conversation.copy(
            title = peer?.displayName ?: conversation.title,
            peer = peer,
            unreadCount = unreadByConversation[conversation.id]?.get(currentUser.id) ?: 0
        )
    }

    override suspend fun searchDirectory(
        query: String,
        limit: Int
    ): AppResult<List<ChatDirectoryUser>> {
        delay(80)
        val needle = query.trim()
        val result = directory
            .asSequence()
            .filter { it.userId != currentUser.id }
            .filter { user ->
                needle.isBlank() || listOfNotNull(
                    user.displayName,
                    user.title,
                    user.departmentName,
                    user.roleName
                ).any { it.contains(needle, ignoreCase = true) }
            }
            .take(limit.coerceIn(1, 50))
            .toList()
        return AppResult.Success(result)
    }

    override suspend fun listAccessibleDepartments(): AppResult<List<ChatDepartmentSummary>> {
        delay(60)
        return AppResult.Success(departments.filter { it.id in accessibleDepartmentIds() })
    }

    override suspend fun listConversations(
        limit: Int,
        offset: Int
    ): AppResult<ChatConversationPage> {
        delay(100)
        val accessible = conversations.values
            .filter(::isAccessible)
            .map(::shapeForCurrentUser)
            .sortedWith(compareByDescending<ChatConversationParams> { it.lastMessageAt }.thenBy { it.id })
        val start = offset.coerceAtLeast(0).coerceAtMost(accessible.size)
        val end = (start + limit.coerceIn(1, 50)).coerceAtMost(accessible.size)
        return AppResult.Success(
            ChatConversationPage(
                items = accessible.subList(start, end),
                nextOffset = end.takeIf { it < accessible.size }
            )
        )
    }

    override suspend fun openDirect(userId: String): AppResult<ChatConversationParams> {
        delay(80)
        val recipient = directory.firstOrNull { it.userId == userId && it.userId != currentUser.id }
            ?: return error("المستخدم غير موجود", 404)
        if (currentUser.id.isBlank()) return error("يرجى تسجيل الدخول", 401)
        val pair = listOf(currentUser.id, recipient.userId).sorted()
        val conversationId = "direct-${pair.joinToString("-")}"
        directParticipants[conversationId] = pair.toSet()
        val conversation = conversations.getOrPut(conversationId) {
            ChatConversationParams(
                id = conversationId,
                type = "direct",
                title = recipient.displayName,
                peer = recipient,
                department = null,
                lastMessagePreview = null,
                lastMessageAt = null,
                lastSender = null,
                unreadCount = 0,
                readState = ChatReadState(true, null),
                createdAt = nowStamp(),
                repliesEnabled = true
            )
        }
        messages.putIfAbsent(conversationId, mutableListOf())
        unreadByConversation.putIfAbsent(conversationId, mutableMapOf())
        return AppResult.Success(shapeForCurrentUser(conversation))
    }

    override suspend fun openDepartment(
        departmentId: String
    ): AppResult<ChatConversationParams> {
        delay(80)
        val department = departments.firstOrNull {
            it.id == departmentId && it.id in accessibleDepartmentIds()
        } ?: return error("القسم غير موجود", 404)
        val conversationId = "department-${department.id}"
        val conversation = conversations.getOrPut(conversationId) {
            ChatConversationParams(
                id = conversationId,
                type = "department",
                title = department.name,
                peer = null,
                department = department,
                lastMessagePreview = null,
                lastMessageAt = null,
                lastSender = null,
                unreadCount = 0,
                readState = ChatReadState(true, null),
                createdAt = nowStamp(),
                repliesEnabled = true
            )
        }
        messages.putIfAbsent(conversationId, mutableListOf())
        unreadByConversation.putIfAbsent(conversationId, mutableMapOf())
        return AppResult.Success(shapeForCurrentUser(conversation))
    }

    override suspend fun loadMessages(
        conversationId: String,
        before: String?,
        limit: Int
    ): AppResult<ChatMessagePage> {
        delay(80)
        val conversation = conversations[conversationId]
            ?.takeIf(::isAccessible)
            ?: return error("المحادثة غير موجودة", 404)
        val all = messages[conversation.id].orEmpty()
        val endExclusive = before
            ?.let { cursor -> all.indexOfFirst { it.id == cursor }.takeIf { it >= 0 } }
            ?: all.size
        val start = (endExclusive - limit.coerceIn(1, 50)).coerceAtLeast(0)
        val page = all.subList(start, endExclusive).map { message ->
            message.copy(isOwn = message.sender.userId == currentUser.id)
        }
        return AppResult.Success(
            ChatMessagePage(
                items = page,
                nextCursor = page.firstOrNull()?.id?.takeIf { start > 0 },
                order = "chronological"
            )
        )
    }

    override suspend fun sendMessage(
        conversationId: String,
        body: String,
        replyToMessageId: String?
    ): AppResult<ChatMessageParams> {
        delay(100)
        val normalized = body.trim()
        if (normalized.isEmpty()) return error("لا يمكن إرسال رسالة فارغة")
        if (normalized.length > 4000) return error("يجب ألا تتجاوز الرسالة 4000 حرف")
        val conversation = conversations[conversationId]
            ?.takeIf(::isAccessible)
            ?: return error("المحادثة غير موجودة", 404)
        if (!conversation.repliesEnabled) {
            return error("الردود غير مفعّلة في هذا الإعلان", 403)
        }
        val replyId = replyToMessageId?.trim()?.takeIf { it.isNotEmpty() }
        if (replyId != null) {
            val replyExists = messages[conversationId].orEmpty().any { it.id == replyId }
            if (!replyExists) return error("الرسالة المراد الرد عليها غير موجودة", 404)
        }
        val createdAt = nowStamp()
        val sender = ChatSender(
            userId = currentUser.id,
            displayName = currentUser.name,
            roleName = currentUser.role,
            departmentName = currentUser.department
        )
        val message = ChatMessageParams(
            id = "message-${messages.values.sumOf { it.size } + 1}",
            conversationId = conversationId,
            sender = sender,
            body = normalized,
            createdAt = createdAt,
            isOwn = true,
            replyToMessageId = replyId
        )
        messages.getOrPut(conversationId) { mutableListOf() }.add(message)
        conversations[conversationId] = conversation.copy(
            lastMessagePreview = normalized.take(120),
            lastMessageAt = createdAt,
            lastSender = sender
        )
        if (conversation.type == "direct") {
            directParticipants[conversationId]
                .orEmpty()
                .filter { it != currentUser.id }
                .forEach { recipientId ->
                    val counts = unreadByConversation.getOrPut(conversationId) { mutableMapOf() }
                    counts[recipientId] = (counts[recipientId] ?: 0) + 1
                }
        }
        return AppResult.Success(message)
    }

    override suspend fun createAnnouncement(
        title: String,
        body: String?
    ): AppResult<ChatConversationParams> {
        delay(100)
        if (currentUser.id.isBlank()) return error("يرجى تسجيل الدخول", 401)
        val normalizedTitle = title.trim()
        if (normalizedTitle.isEmpty()) return error("عنوان الإعلان مطلوب")
        if (normalizedTitle.length > 200) return error("يجب ألا يتجاوز عنوان الإعلان 200 حرف")
        val normalizedBody = body?.trim()?.takeIf { it.isNotEmpty() }
        if (normalizedBody != null && normalizedBody.length > 4000) {
            return error("يجب ألا يتجاوز نص الإعلان 4000 حرف")
        }
        val conversationId = "announcement-${UUID.randomUUID()}"
        val createdAt = nowStamp()
        val sender = ChatSender(
            userId = currentUser.id,
            displayName = currentUser.name,
            roleName = currentUser.role,
            departmentName = currentUser.department
        )
        val conversation = ChatConversationParams(
            id = conversationId,
            type = "announcement",
            title = normalizedTitle,
            peer = null,
            department = null,
            lastMessagePreview = normalizedBody?.take(120),
            lastMessageAt = normalizedBody?.let { createdAt },
            lastSender = normalizedBody?.let { sender },
            unreadCount = 0,
            readState = ChatReadState(true, null),
            createdAt = createdAt,
            repliesEnabled = false
        )
        conversations[conversationId] = conversation
        val messageList = mutableListOf<ChatMessageParams>()
        if (normalizedBody != null) {
            messageList.add(
                ChatMessageParams(
                    id = "message-${messages.values.sumOf { it.size } + 1}",
                    conversationId = conversationId,
                    sender = sender,
                    body = normalizedBody,
                    createdAt = createdAt,
                    isOwn = true,
                    replyToMessageId = null
                )
            )
        }
        messages[conversationId] = messageList
        unreadByConversation[conversationId] = mutableMapOf(currentUser.id to 0)
        pins[conversationId] = mutableListOf()
        return AppResult.Success(shapeForCurrentUser(conversation))
    }

    override suspend fun listPins(
        conversationId: String
    ): AppResult<List<ChatPinnedMessageParams>> {
        delay(40)
        val conversation = conversations[conversationId]
            ?.takeIf(::isAccessible)
            ?: return error("المحادثة غير موجودة", 404)
        return AppResult.Success(pins[conversation.id].orEmpty().toList())
    }

    override suspend fun pinMessage(
        conversationId: String,
        messageId: String
    ): AppResult<ChatPinnedMessageParams> {
        delay(60)
        val conversation = conversations[conversationId]
            ?.takeIf(::isAccessible)
            ?: return error("المحادثة غير موجودة", 404)
        val message = messages[conversation.id].orEmpty().firstOrNull { it.id == messageId }
            ?: return error("الرسالة غير موجودة", 404)
        val existing = pins[conversation.id].orEmpty().firstOrNull { it.messageId == message.id }
        if (existing != null) return AppResult.Success(existing)
        val pin = ChatPinnedMessageParams(
            id = "pin-${UUID.randomUUID()}",
            conversationId = conversation.id,
            messageId = message.id,
            pinnedByUserId = currentUser.id,
            pinnedAt = nowStamp()
        )
        pins.getOrPut(conversation.id) { mutableListOf() }.add(0, pin)
        return AppResult.Success(pin)
    }

    override suspend fun unpinMessage(
        conversationId: String,
        messageId: String
    ): AppResult<Unit> {
        delay(40)
        val conversation = conversations[conversationId]
            ?.takeIf(::isAccessible)
            ?: return error("المحادثة غير موجودة", 404)
        val list = pins[conversation.id] ?: return error("التثبيت غير موجود", 404)
        val removed = list.removeAll { it.messageId == messageId }
        if (!removed) return error("التثبيت غير موجود", 404)
        return AppResult.Success(Unit)
    }

    override suspend fun markRead(conversationId: String): AppResult<ChatReadResult> {
        delay(40)
        val conversation = conversations[conversationId]
            ?.takeIf(::isAccessible)
            ?: return error("المحادثة غير موجودة", 404)
        unreadByConversation.getOrPut(conversation.id) { mutableMapOf() }[currentUser.id] = 0
        return AppResult.Success(ChatReadResult(conversation.id, 0))
    }

    override suspend fun getUnreadCount(): AppResult<Int> {
        delay(30)
        val total = conversations.values
            .filter(::isAccessible)
            .sumOf { unreadByConversation[it.id]?.get(currentUser.id) ?: 0 }
        return AppResult.Success(total)
    }

    override fun setCurrentUser(userId: String, name: String, role: String, department: String?) {
        currentUser = CurrentUser(
            id = userId,
            name = name.ifBlank { "أنت" },
            role = role.ifBlank { "Employee" },
            department = department
        )
    }

    override fun clear() {
        currentUser = CurrentUser("", "أنت", "Employee", null)
    }
}
