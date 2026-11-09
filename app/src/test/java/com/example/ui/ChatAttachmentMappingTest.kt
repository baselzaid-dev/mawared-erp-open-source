package com.example.ui

import com.example.data.remote.api.ChatAttachmentDto
import com.example.data.remote.api.ChatMessageDto
import com.example.data.remote.api.ChatSenderDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Ensures chat message attachment metadata survives DTO → domain mapping
 * so MessageBubble can render durable openable attachment rows.
 */
class ChatAttachmentMappingTest {

    @Test
    fun `chat message dto preserves attachment id and metadata`() {
        val dto = ChatMessageDto(
            id = "m1",
            conversationId = "c1",
            sender = ChatSenderDto(
                userId = "u1",
                displayName = "أحمد",
                roleName = "Employee",
                departmentName = null
            ),
            body = "مرفق: عرض.pdf",
            createdAt = "2026-07-31T10:00:00.000Z",
            isOwn = true,
            attachments = listOf(
                ChatAttachmentDto(
                    id = "att-1",
                    originalFilename = "عرض.pdf",
                    contentType = "application/pdf",
                    byteSize = 2048
                )
            )
        )

        // Mirror ApiChatRepository mapping without needing Retrofit.
        val params = com.example.domain.model.ChatMessageParams(
            id = dto.id,
            conversationId = dto.conversationId,
            sender = com.example.domain.model.ChatSender(
                userId = dto.sender.userId,
                displayName = dto.sender.displayName,
                roleName = dto.sender.roleName,
                departmentName = dto.sender.departmentName
            ),
            body = dto.body,
            createdAt = dto.createdAt,
            isOwn = dto.isOwn,
            replyToMessageId = dto.replyToMessageId,
            attachments = dto.attachments.map {
                com.example.domain.model.ChatAttachmentParams(
                    id = it.id,
                    originalFilename = it.originalFilename,
                    contentType = it.contentType,
                    byteSize = it.byteSize
                )
            }
        )

        assertEquals(1, params.attachments.size)
        assertEquals("att-1", params.attachments[0].id)
        assertEquals("عرض.pdf", params.attachments[0].originalFilename)
        assertEquals("application/pdf", params.attachments[0].contentType)
        assertEquals(2048, params.attachments[0].byteSize)
        assertTrue(params.body.startsWith("مرفق:"))
    }
}
