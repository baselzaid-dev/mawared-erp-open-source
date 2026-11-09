package com.example.data.repository.mock

import com.example.core.utils.AppResult
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MockChatRepositoryTest {

    @Test
    fun `directory excludes current user and direct open is idempotent`() = runTest {
        val repo = MockChatRepository()
        repo.setCurrentUser("4", "موظف تجريبي 6", "Employee", "تقنية المعلومات")

        val directory = repo.searchDirectory() as AppResult.Success
        assertTrue(directory.data.none { it.userId == "4" })

        val first = repo.openDirect("1") as AppResult.Success
        val second = repo.openDirect("1") as AppResult.Success
        assertEquals(first.data.id, second.data.id)
        assertEquals("direct", first.data.type)
    }

    @Test
    fun `department list and channel open are scoped to current user`() = runTest {
        val repo = MockChatRepository()
        repo.setCurrentUser("4", "موظف تجريبي 6", "Employee", "تقنية المعلومات")

        val departments = repo.listAccessibleDepartments() as AppResult.Success
        assertEquals(listOf("2"), departments.data.map { it.id })

        val allowed = repo.openDepartment("2") as AppResult.Success
        assertEquals("department", allowed.data.type)
        assertEquals("2", allowed.data.department?.id)

        val denied = repo.openDepartment("1")
        assertTrue(denied is AppResult.Error)
    }

    @Test
    fun `send trims body updates unread then mark read clears count`() = runTest {
        val repo = MockChatRepository()
        repo.setCurrentUser("4", "موظف تجريبي 6", "Employee", "تقنية المعلومات")
        val conversation = (repo.openDirect("1") as AppResult.Success).data

        val sent = repo.sendMessage(conversation.id, "  السلام عليكم  ") as AppResult.Success
        assertEquals("السلام عليكم", sent.data.body)

        val messages = repo.loadMessages(conversation.id) as AppResult.Success
        assertTrue(messages.data.items.any { it.id == sent.data.id && it.isOwn })

        val read = repo.markRead(conversation.id) as AppResult.Success
        assertEquals(0, read.data.unreadCount)
    }

    @Test
    fun `announcement create pins reply and replies disabled send are enforced`() = runTest {
        val repo = MockChatRepository()
        repo.setCurrentUser("1", "موظف تجريبي 3", "HR Manager", "الموارد البشرية")

        val announcement = repo.createAnnouncement("تنبيه عام", "يرجى المراجعة") as AppResult.Success
        assertEquals("announcement", announcement.data.type)
        assertEquals(false, announcement.data.repliesEnabled)

        val blocked = repo.sendMessage(announcement.data.id, "رد")
        assertTrue(blocked is AppResult.Error)

        val direct = (repo.openDirect("4") as AppResult.Success).data
        val parent = (repo.sendMessage(direct.id, "سؤال") as AppResult.Success).data
        val reply = (repo.sendMessage(direct.id, "جواب", replyToMessageId = parent.id) as AppResult.Success).data
        assertEquals(parent.id, reply.replyToMessageId)

        val pin = (repo.pinMessage(direct.id, parent.id) as AppResult.Success).data
        assertEquals(parent.id, pin.messageId)
        val pins = (repo.listPins(direct.id) as AppResult.Success).data
        assertEquals(1, pins.size)
        assertTrue(repo.unpinMessage(direct.id, parent.id) is AppResult.Success)
        assertTrue((repo.listPins(direct.id) as AppResult.Success).data.isEmpty())
    }

    @Test
    fun `clear removes current user scope`() = runTest {
        val repo = MockChatRepository()
        repo.setCurrentUser("4", "موظف تجريبي 6", "Employee", "تقنية المعلومات")
        assertTrue((repo.listAccessibleDepartments() as AppResult.Success).data.isNotEmpty())

        repo.clear()

        assertTrue((repo.listAccessibleDepartments() as AppResult.Success).data.isEmpty())
    }
}
