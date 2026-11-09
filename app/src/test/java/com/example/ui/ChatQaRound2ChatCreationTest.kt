package com.example.ui

import com.example.domain.model.ChatConversationParams
import com.example.domain.model.ChatDirectoryUser
import com.example.domain.model.ChatReadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Focused QA Round 2 coverage for New Chat creation UX rules and string wiring.
 */
class ChatQaRound2ChatCreationTest {

    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    @Test
    fun `new chat stays discoverable with chat view regardless of empty directory`() {
        assertTrue(ChatUiRules.shouldShowNewChatAction(true))
        // Empty directory must not hide the action — visibility is view-gated only.
        val emptyDirectory = ChatUiState(
            canUseChat = true,
            canCreateDirect = true,
            directoryHasLoaded = true,
            directoryResults = emptyList()
        )
        assertTrue(ChatUiRules.shouldShowNewChatAction(emptyDirectory.canUseChat))
        assertEquals(
            ChatDirectoryEmptyKind.NoRecipientsAvailable,
            ChatUiRules.resolveDirectoryEmptyKind(
                canCreateDirect = emptyDirectory.canCreateDirect,
                directoryHasLoaded = emptyDirectory.directoryHasLoaded,
                resultsEmpty = emptyDirectory.directoryResults.isEmpty(),
                queryBlank = emptyDirectory.directoryQuery.isBlank(),
                isSearching = false
            )
        )
    }

    @Test
    fun `canCreateDirect gating blocks start without permission`() {
        assertFalse(ChatUiRules.canStartDirect(canCreateDirect = false, isOpening = false, userId = "u1"))
        assertTrue(ChatUiRules.canStartDirect(canCreateDirect = true, isOpening = false, userId = "u1"))
    }

    @Test
    fun `double submit prevention blocks second start while opening`() {
        val first = ChatUiRules.canStartDirect(true, isOpening = false, userId = "u1")
        val second = ChatUiRules.canStartDirect(true, isOpening = true, userId = "u1")
        assertTrue(first)
        assertFalse(second)
        assertFalse(ChatUiRules.canStartDepartment(true, isOpening = true, departmentId = "d1"))
    }

    @Test
    fun `inactive recipient remains openable for history but composer is disabled`() {
        val inactive = ChatDirectoryUser(
            userId = "9",
            displayName = "Former Employee",
            title = null,
            employeeId = "e9",
            departmentId = "1",
            departmentName = "HR",
            roleName = "Employee",
            status = "inactive"
        )
        // Start/open still allowed so managers can review history.
        assertTrue(ChatUiRules.canStartDirect(true, false, inactive.userId))
        assertFalse(ChatUiRules.isEmployeeActive(inactive.status))
        assertFalse(ChatUiRules.canComposeWithPeer(true, inactive.status))

        val conversation = ChatConversationParams(
            id = "direct-1-9",
            type = "direct",
            title = inactive.displayName,
            peer = inactive,
            department = null,
            lastMessagePreview = "آخر رسالة",
            lastMessageAt = "2026-07-10T08:30:00.000Z",
            lastSender = null,
            unreadCount = 0,
            readState = ChatReadState(true, null),
            createdAt = "2026-07-01T08:00:00.000Z",
            repliesEnabled = true
        )
        assertTrue(
            ChatUiRules.shouldShowInactivePeerBanner(conversation.type, conversation.peer?.status)
        )
        assertFalse(
            ChatUiRules.canComposeWithPeer(conversation.repliesEnabled, conversation.peer?.status)
        )
        assertFalse(
            ChatUiRules.canSend(
                draft = "hello",
                isSending = false,
                conversationId = conversation.id,
                repliesEnabled = ChatUiRules.canComposeWithPeer(
                    conversation.repliesEnabled,
                    conversation.peer?.status
                )
            )
        )
    }

    @Test
    fun `empty recipient directory messaging string is present in ar and en`() {
        val ar = File(appRoot, "src/main/res/values/strings.xml").readText()
        val en = File(appRoot, "src/main/res/values-en/strings.xml").readText()
        assertTrue(en.contains("name=\"chat_no_recipients_available_body\""))
        assertTrue(ar.contains("name=\"chat_no_recipients_available_body\""))
        assertTrue(ar.contains("لا يوجد موظفون أو أقسام متاحة لبدء محادثة حاليًا"))
        assertTrue(en.contains("name=\"chat_direct_no_permission_title\""))
        assertTrue(ar.contains("name=\"chat_direct_no_permission_title\""))
        // Localized permission copy must not leak raw permission keys.
        val arDirectDetail = ar.substringAfter("chat_direct_no_permission_detail\">")
            .substringBefore("</string>")
        assertFalse(arDirectDetail.contains("chat.create_direct"))
    }

    @Test
    fun `chat views wire create permissions opening flag and inactive banner`() {
        val source = File(appRoot, "src/main/java/com/example/ui/ChatViews.kt").readText()
        assertTrue(source.contains("canCreateDirect"))
        assertTrue(source.contains("canCreateDepartment"))
        assertTrue(source.contains("isOpeningConversation") || source.contains("isOpening"))
        assertTrue(source.contains("chat_no_recipients_available_body"))
        assertTrue(source.contains("chat_peer_inactive_banner"))
        assertTrue(source.contains("Icons.AutoMirrored.Filled.ArrowBack"))
        assertTrue(source.contains("ensureChatDirectoryBrowse") || source.contains("onEnsureDirectoryBrowse"))
        assertTrue(source.contains("ChatUiRules.canStartDirect"))
        assertTrue(source.contains("ChatUiRules.canStartDepartment"))
        assertTrue(source.contains("repliesEnabled = composerRepliesEnabled"))
    }

    @Test
    fun `view model exposes create flags and opening conversation guard`() {
        val source = File(appRoot, "src/main/java/com/example/ui/MawaredViewModel.kt").readText()
        assertTrue(source.contains("canCreateDirect"))
        assertTrue(source.contains("canCreateDepartment"))
        assertTrue(source.contains("isOpeningConversation"))
        assertTrue(source.contains("CHAT_CREATE_DIRECT"))
        assertTrue(source.contains("CHAT_CREATE_DEPARTMENT"))
        assertTrue(source.contains("directoryHasLoaded"))
        assertTrue(source.contains("ensureChatDirectoryBrowse"))
        assertTrue(source.contains("clearChatDirectoryTransientState"))
        assertTrue(source.contains("ChatUiRules.canStartDirect"))
        assertTrue(source.contains("ChatUiRules.canStartDepartment"))
        assertTrue(source.contains("isLoadingMessages = state.isLoadingMessages"))
        assertTrue(source.contains("ChatUiRules.canComposeWithPeer"))
    }

    @Test
    fun `duplicate conversation open remains gated by opening flag not blank recipient`() {
        // Idempotent backend open is still client-gated: second tap while opening is ignored.
        assertTrue(ChatUiRules.canStartDirect(true, false, "u1"))
        assertFalse(ChatUiRules.canStartDirect(true, true, "u1"))
        // Malformed targets never start.
        assertFalse(ChatUiRules.canStartDirect(true, false, ""))
        assertFalse(ChatUiRules.canStartDepartment(true, false, " "))
    }
}
