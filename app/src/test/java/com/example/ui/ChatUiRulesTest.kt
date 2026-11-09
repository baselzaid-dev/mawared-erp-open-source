package com.example.ui

import com.example.domain.model.ChatMessageParams
import com.example.domain.model.ChatSender
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatUiRulesTest {

    @Test
    fun `send is allowed only for active conversation nonblank bounded draft and idle sender`() {
        assertTrue(ChatUiRules.canSend("مرحبا", isSending = false, conversationId = "c1"))
        assertFalse(ChatUiRules.canSend("   ", isSending = false, conversationId = "c1"))
        assertFalse(ChatUiRules.canSend("مرحبا", isSending = true, conversationId = "c1"))
        assertFalse(ChatUiRules.canSend("مرحبا", isSending = false, conversationId = null))
        assertFalse(ChatUiRules.canSend("x".repeat(4001), isSending = false, conversationId = "c1"))
    }

    @Test
    fun `send is blocked when replies are disabled`() {
        assertFalse(
            ChatUiRules.canSend(
                draft = "مرحبا",
                isSending = false,
                conversationId = "announcement-1",
                repliesEnabled = false
            )
        )
        assertTrue(
            ChatUiRules.canSend(
                draft = "مرحبا",
                isSending = false,
                conversationId = "direct-1",
                repliesEnabled = true
            )
        )
    }

    @Test
    fun `reply compose follows repliesEnabled flag`() {
        assertTrue(ChatUiRules.canComposeReply(true))
        assertFalse(ChatUiRules.canComposeReply(false))
    }

    @Test
    fun `announcement create requires permission idle sender and nonblank title`() {
        assertTrue(ChatUiRules.canCreateAnnouncement(true, false, "إعلان مهم"))
        assertFalse(ChatUiRules.canCreateAnnouncement(false, false, "إعلان مهم"))
        assertFalse(ChatUiRules.canCreateAnnouncement(true, true, "إعلان مهم"))
        assertFalse(ChatUiRules.canCreateAnnouncement(true, false, "   "))
        assertFalse(ChatUiRules.canCreateAnnouncement(true, false, "x".repeat(201)))
    }

    @Test
    fun `pin and unpin gating respects permission pinning state and pin presence`() {
        assertTrue(ChatUiRules.canPinMessage(true, false, "m1", alreadyPinned = false))
        assertFalse(ChatUiRules.canPinMessage(false, false, "m1", alreadyPinned = false))
        assertFalse(ChatUiRules.canPinMessage(true, true, "m1", alreadyPinned = false))
        assertFalse(ChatUiRules.canPinMessage(true, false, "m1", alreadyPinned = true))
        assertFalse(ChatUiRules.canPinMessage(true, false, null, alreadyPinned = false))

        assertTrue(ChatUiRules.canUnpinMessage(true, false, "m1", isPinned = true))
        assertFalse(ChatUiRules.canUnpinMessage(true, false, "m1", isPinned = false))
        assertFalse(ChatUiRules.canUnpinMessage(false, false, "m1", isPinned = true))
    }

    @Test
    fun `announcement type and pin lookup helpers`() {
        assertTrue(ChatUiRules.isAnnouncement("announcement"))
        assertTrue(ChatUiRules.isAnnouncement("ANNOUNCEMENT"))
        assertFalse(ChatUiRules.isAnnouncement("direct"))
        assertTrue(ChatUiRules.isPinned("m1", setOf("m1", "m2")))
        assertFalse(ChatUiRules.isPinned("m3", setOf("m1", "m2")))
    }

    @Test
    fun `polling starts only when visible permitted selected and idle`() {
        assertTrue(ChatUiRules.shouldPoll(true, true, "c1", false))
        assertFalse(ChatUiRules.shouldPoll(false, true, "c1", false))
        assertFalse(ChatUiRules.shouldPoll(true, false, "c1", false))
        assertFalse(ChatUiRules.shouldPoll(true, true, null, false))
        assertFalse(ChatUiRules.shouldPoll(true, true, "c1", true))
    }

    @Test
    fun `merge messages de-duplicates and keeps chronological order`() {
        val sender = ChatSender("u1", "Basel", "Employee", null)
        val older = ChatMessageParams("m1", "c1", sender, "one", "2026-07-10T08:00:00.000Z", false)
        val newer = ChatMessageParams("m2", "c1", sender, "two", "2026-07-10T09:00:00.000Z", true)

        val merged = ChatUiRules.mergeMessages(listOf(newer), listOf(older, newer))

        assertEquals(listOf("m1", "m2"), merged.map { it.id })
    }

    @Test
    fun `reply preview resolves from message list`() {
        val sender = ChatSender("u1", "Basel", "Employee", null)
        val older = ChatMessageParams("m1", "c1", sender, "one", "2026-07-10T08:00:00.000Z", false)
        val newer = ChatMessageParams(
            id = "m2",
            conversationId = "c1",
            sender = sender,
            body = "two",
            createdAt = "2026-07-10T09:00:00.000Z",
            isOwn = true,
            replyToMessageId = "m1"
        )

        assertEquals("one", ChatUiRules.findReplyPreview(listOf(older, newer), "m1")?.body)
        assertNull(ChatUiRules.findReplyPreview(listOf(older, newer), "missing"))
        assertNull(ChatUiRules.findReplyPreview(listOf(older, newer), null))
    }

    @Test
    fun `new chat action stays visible with chat view even when directory empty`() {
        assertTrue(ChatUiRules.shouldShowNewChatAction(canUseChat = true))
        assertFalse(ChatUiRules.shouldShowNewChatAction(canUseChat = false))
    }

    @Test
    fun `canStartDirect requires create permission idle opener and selectable recipient`() {
        assertTrue(ChatUiRules.canStartDirect(true, false, "u1"))
        assertFalse(ChatUiRules.canStartDirect(false, false, "u1"))
        assertFalse(ChatUiRules.canStartDirect(true, true, "u1"))
        assertFalse(ChatUiRules.canStartDirect(true, false, "  "))
        assertFalse(ChatUiRules.canStartDirect(true, false, null))
    }

    @Test
    fun `canStartDirect double-submit blocked while opening`() {
        assertTrue(ChatUiRules.canStartDirect(true, isOpening = false, userId = "u1"))
        assertFalse(ChatUiRules.canStartDirect(true, isOpening = true, userId = "u1"))
        assertFalse(ChatUiRules.canStartDepartment(true, isOpening = true, departmentId = "d1"))
        assertTrue(ChatUiRules.canStartDepartment(true, isOpening = false, departmentId = "d1"))
        assertFalse(
            ChatUiRules.canStartDirect(
                canCreateDirect = true,
                isOpening = false,
                userId = "u1",
                isLoadingMessages = true
            )
        )
        assertFalse(
            ChatUiRules.canStartDepartment(
                canCreateDepartment = true,
                isOpening = false,
                departmentId = "d1",
                isLoadingMessages = true
            )
        )
    }

    @Test
    fun `inactive peer banner and composer gating`() {
        assertTrue(ChatUiRules.shouldShowInactivePeerBanner("direct", "inactive"))
        assertFalse(ChatUiRules.shouldShowInactivePeerBanner("direct", "active"))
        assertFalse(ChatUiRules.shouldShowInactivePeerBanner("department", "inactive"))
        assertFalse(ChatUiRules.canComposeWithPeer(repliesEnabled = true, peerStatus = "inactive"))
        assertTrue(ChatUiRules.canComposeWithPeer(repliesEnabled = true, peerStatus = "active"))
        assertFalse(ChatUiRules.canComposeWithPeer(repliesEnabled = false, peerStatus = "active"))
        // Null peer status (department/announcement) keeps composer open when replies allowed.
        assertTrue(ChatUiRules.canComposeWithPeer(repliesEnabled = true, peerStatus = null))
    }

    @Test
    fun `directory empty kinds distinguish idle searched and no recipients`() {
        assertEquals(
            ChatDirectoryEmptyKind.PermissionDenied,
            ChatUiRules.resolveDirectoryEmptyKind(
                canCreateDirect = false,
                directoryHasLoaded = false,
                resultsEmpty = true,
                queryBlank = true,
                isSearching = false
            )
        )
        assertEquals(
            ChatDirectoryEmptyKind.IdleBeforeSearch,
            ChatUiRules.resolveDirectoryEmptyKind(
                canCreateDirect = true,
                directoryHasLoaded = false,
                resultsEmpty = true,
                queryBlank = true,
                isSearching = false
            )
        )
        assertEquals(
            ChatDirectoryEmptyKind.NoRecipientsAvailable,
            ChatUiRules.resolveDirectoryEmptyKind(
                canCreateDirect = true,
                directoryHasLoaded = true,
                resultsEmpty = true,
                queryBlank = true,
                isSearching = false
            )
        )
        assertEquals(
            ChatDirectoryEmptyKind.SearchedNoResults,
            ChatUiRules.resolveDirectoryEmptyKind(
                canCreateDirect = true,
                directoryHasLoaded = true,
                resultsEmpty = true,
                queryBlank = false,
                isSearching = false
            )
        )
        assertNull(
            ChatUiRules.resolveDirectoryEmptyKind(
                canCreateDirect = true,
                directoryHasLoaded = true,
                resultsEmpty = false,
                queryBlank = true,
                isSearching = false
            )
        )
        assertNull(
            ChatUiRules.resolveDirectoryEmptyKind(
                canCreateDirect = true,
                directoryHasLoaded = true,
                resultsEmpty = true,
                queryBlank = true,
                isSearching = true
            )
        )
    }
}
