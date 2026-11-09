package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.ChatApi
import com.example.data.remote.api.ChatConversationDto
import com.example.data.remote.api.ChatCreateAnnouncementRequestDto
import com.example.data.remote.api.ChatDepartmentDto
import com.example.data.remote.api.ChatDirectoryUserDto
import com.example.data.remote.api.ChatErrorResponseDto
import com.example.data.remote.api.ChatMessageDto
import com.example.data.remote.api.ChatOpenDirectRequestDto
import com.example.data.remote.api.ChatPinMessageRequestDto
import com.example.data.remote.api.ChatPinnedMessageDto
import com.example.data.remote.api.ChatReadStateDto
import com.example.data.remote.api.ChatSendMessageRequestDto
import com.example.data.remote.api.ChatSenderDto
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
import com.squareup.moshi.Moshi
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import retrofit2.Response

class ApiChatRepository(
    private val chatApi: ChatApi
) : ChatRepository {

    private val errorAdapter = Moshi.Builder().build().adapter(ChatErrorResponseDto::class.java)
    private val sendMutex = Mutex()

    private fun ChatDirectoryUserDto.toParams() = ChatDirectoryUser(
        userId = userId,
        displayName = displayName,
        title = title,
        employeeId = employeeId,
        departmentId = departmentId,
        departmentName = departmentName,
        roleName = roleName,
        status = status ?: "active"
    )

    private fun ChatSenderDto.toParams() = ChatSender(
        userId = userId,
        displayName = displayName,
        roleName = roleName,
        departmentName = departmentName
    )

    private fun ChatDepartmentDto.toParams() = ChatDepartmentSummary(id = id, name = name)

    private fun ChatReadStateDto.toParams() = ChatReadState(
        active = active,
        lastReadAt = lastReadAt
    )

    private fun ChatConversationDto.toParams() = ChatConversationParams(
        id = id,
        type = type,
        title = title,
        peer = peer?.toParams(),
        department = department?.toParams(),
        lastMessagePreview = lastMessagePreview,
        lastMessageAt = lastMessageAt,
        lastSender = lastSender?.toParams(),
        unreadCount = unreadCount,
        readState = readState?.toParams(),
        createdAt = createdAt,
        repliesEnabled = repliesEnabled != false
    )

    private fun ChatMessageDto.toParams() = ChatMessageParams(
        id = id,
        conversationId = conversationId,
        sender = sender.toParams(),
        body = body,
        createdAt = createdAt,
        isOwn = isOwn,
        replyToMessageId = replyToMessageId,
        attachments = attachments.map {
            com.example.domain.model.ChatAttachmentParams(
                id = it.id,
                originalFilename = it.originalFilename,
                contentType = it.contentType,
                byteSize = it.byteSize
            )
        }
    )

    private fun ChatPinnedMessageDto.toParams() = ChatPinnedMessageParams(
        id = id,
        conversationId = conversationId,
        messageId = messageId,
        pinnedByUserId = pinnedByUserId,
        pinnedAt = pinnedAt
    )

    private fun validationError(message: String): AppResult.Error = AppResult.Error(
        IllegalArgumentException(message),
        AppError.ServerError(400, message)
    )

    private fun <T> responseError(response: Response<T>, fallback: String): AppResult.Error {
        val payload = try {
            response.errorBody()?.string()?.let(errorAdapter::fromJson)
        } catch (_: Exception) {
            null
        }
        val message = payload?.message?.takeIf { it.isNotBlank() }
            ?: payload?.error?.takeIf { it.isNotBlank() }
            ?: fallback
        return AppResult.Error(
            Exception(message),
            AppError.ServerError(response.code(), message)
        )
    }

    private suspend fun <Dto, Domain> execute(
        fallback: String,
        call: suspend () -> Response<Dto>,
        map: (Dto) -> Domain
    ): AppResult<Domain> = try {
        val response = call()
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(map(body))
        } else {
            responseError(response, fallback)
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    private suspend fun executeNoBody(
        fallback: String,
        call: suspend () -> Response<Unit>
    ): AppResult<Unit> = try {
        val response = call()
        if (response.isSuccessful) {
            AppResult.Success(Unit)
        } else {
            responseError(response, fallback)
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun searchDirectory(
        query: String,
        limit: Int
    ): AppResult<List<ChatDirectoryUser>> {
        val normalized = query.trim()
        if (normalized.length > 100) return validationError("نص البحث طويل جداً")
        return execute(
            fallback = "تعذّر تحميل دليل الموظفين",
            call = { chatApi.searchDirectory(normalized.takeIf { it.isNotEmpty() }, limit.coerceIn(1, 50)) },
            map = { users -> users.map { it.toParams() } }
        )
    }

    override suspend fun listAccessibleDepartments(): AppResult<List<ChatDepartmentSummary>> =
        execute(
            fallback = "تعذّر تحميل قنوات الأقسام",
            call = { chatApi.getAccessibleDepartments() },
            map = { departments -> departments.map { it.toParams() } }
        )

    override suspend fun listConversations(
        limit: Int,
        offset: Int
    ): AppResult<ChatConversationPage> = execute(
        fallback = "تعذّر تحميل المحادثات",
        call = { chatApi.getConversations(limit.coerceIn(1, 50), offset.coerceAtLeast(0)) },
        map = { page ->
            ChatConversationPage(
                items = page.items.map { it.toParams() },
                nextOffset = page.nextOffset
            )
        }
    )

    override suspend fun openDirect(userId: String): AppResult<ChatConversationParams> {
        if (userId.isBlank()) return validationError("اختر موظفاً لبدء المحادثة")
        return execute(
            fallback = "تعذّر فتح المحادثة المباشرة",
            call = { chatApi.openDirect(ChatOpenDirectRequestDto(userId.trim())) },
            map = { it.toParams() }
        )
    }

    override suspend fun openDepartment(
        departmentId: String
    ): AppResult<ChatConversationParams> {
        if (departmentId.isBlank()) return validationError("القسم غير صالح")
        return execute(
            fallback = "تعذّر فتح قناة القسم",
            call = { chatApi.openDepartment(departmentId.trim()) },
            map = { it.toParams() }
        )
    }

    override suspend fun loadMessages(
        conversationId: String,
        before: String?,
        limit: Int
    ): AppResult<ChatMessagePage> = execute(
        fallback = "تعذّر تحميل الرسائل",
        call = {
            chatApi.getMessages(
                conversationId = conversationId,
                before = before,
                limit = limit.coerceIn(1, 50)
            )
        },
        map = { page ->
            ChatMessagePage(
                items = page.items.map { it.toParams() },
                nextCursor = page.nextCursor,
                order = page.order
            )
        }
    )

    override suspend fun sendMessage(
        conversationId: String,
        body: String,
        replyToMessageId: String?
    ): AppResult<ChatMessageParams> {
        val normalized = body.trim()
        if (normalized.isEmpty()) return validationError("لا يمكن إرسال رسالة فارغة")
        if (normalized.length > 4000) return validationError("يجب ألا تتجاوز الرسالة 4000 حرف")
        val replyId = replyToMessageId?.trim()?.takeIf { it.isNotEmpty() }
        return sendMutex.withLock {
            execute(
                fallback = "تعذّر إرسال الرسالة",
                call = {
                    chatApi.sendMessage(
                        conversationId,
                        ChatSendMessageRequestDto(
                            body = normalized,
                            replyToMessageId = replyId
                        )
                    )
                },
                map = { it.toParams() }
            )
        }
    }

    override suspend fun createAnnouncement(
        title: String,
        body: String?
    ): AppResult<ChatConversationParams> {
        val normalizedTitle = title.trim()
        if (normalizedTitle.isEmpty()) return validationError("عنوان الإعلان مطلوب")
        if (normalizedTitle.length > 200) return validationError("يجب ألا يتجاوز عنوان الإعلان 200 حرف")
        val normalizedBody = body?.trim()?.takeIf { it.isNotEmpty() }
        if (normalizedBody != null && normalizedBody.length > 4000) {
            return validationError("يجب ألا يتجاوز نص الإعلان 4000 حرف")
        }
        return execute(
            fallback = "تعذّر إنشاء الإعلان",
            call = {
                chatApi.createAnnouncement(
                    ChatCreateAnnouncementRequestDto(
                        title = normalizedTitle,
                        body = normalizedBody
                    )
                )
            },
            map = { it.toParams() }
        )
    }

    override suspend fun listPins(
        conversationId: String
    ): AppResult<List<ChatPinnedMessageParams>> {
        if (conversationId.isBlank()) return validationError("المحادثة غير صالحة")
        return execute(
            fallback = "تعذّر تحميل الرسائل المثبتة",
            call = { chatApi.getPins(conversationId.trim()) },
            map = { page -> page.items.map { it.toParams() } }
        )
    }

    override suspend fun pinMessage(
        conversationId: String,
        messageId: String
    ): AppResult<ChatPinnedMessageParams> {
        if (conversationId.isBlank()) return validationError("المحادثة غير صالحة")
        if (messageId.isBlank()) return validationError("الرسالة غير صالحة")
        return execute(
            fallback = "تعذّر تثبيت الرسالة",
            call = {
                chatApi.pinMessage(
                    conversationId.trim(),
                    ChatPinMessageRequestDto(messageId.trim())
                )
            },
            map = { it.toParams() }
        )
    }

    override suspend fun unpinMessage(
        conversationId: String,
        messageId: String
    ): AppResult<Unit> {
        if (conversationId.isBlank()) return validationError("المحادثة غير صالحة")
        if (messageId.isBlank()) return validationError("الرسالة غير صالحة")
        return executeNoBody(
            fallback = "تعذّر إلغاء تثبيت الرسالة",
            call = { chatApi.unpinMessage(conversationId.trim(), messageId.trim()) }
        )
    }

    override suspend fun markRead(conversationId: String): AppResult<ChatReadResult> = execute(
        fallback = "تعذّر تحديث حالة القراءة",
        call = { chatApi.markRead(conversationId) },
        map = { ChatReadResult(it.conversationId, it.unreadCount) }
    )

    override suspend fun getUnreadCount(): AppResult<Int> = execute(
        fallback = "تعذّر تحميل عدد الرسائل غير المقروءة",
        call = { chatApi.getUnreadCount() },
        map = { it.unreadCount }
    )

    override fun setCurrentUser(userId: String, name: String, role: String, department: String?) = Unit

    override fun clear() = Unit
}
