package com.example.ui

import com.example.domain.model.ChatMessageParams

internal enum class ChatDirectoryEmptyKind {
    IdleBeforeSearch,
    SearchedNoResults,
    NoRecipientsAvailable,
    PermissionDenied
}

internal object ChatUiRules {
    fun canSend(
        draft: String,
        isSending: Boolean,
        conversationId: String?,
        repliesEnabled: Boolean = true
    ): Boolean = conversationId != null &&
        repliesEnabled &&
        !isSending &&
        draft.trim().let { it.isNotEmpty() && it.length <= 4000 }

    fun canComposeReply(repliesEnabled: Boolean): Boolean = repliesEnabled

    fun canCreateAnnouncement(
        hasPermission: Boolean,
        isSubmitting: Boolean,
        titleDraft: String
    ): Boolean = hasPermission &&
        !isSubmitting &&
        titleDraft.trim().let { it.isNotEmpty() && it.length <= 200 }

    fun canPinMessage(
        hasPermission: Boolean,
        isPinning: Boolean,
        messageId: String?,
        alreadyPinned: Boolean
    ): Boolean = hasPermission && !isPinning && !messageId.isNullOrBlank() && !alreadyPinned

    fun canUnpinMessage(
        hasPermission: Boolean,
        isPinning: Boolean,
        messageId: String?,
        isPinned: Boolean
    ): Boolean = hasPermission && !isPinning && !messageId.isNullOrBlank() && isPinned

    fun isAnnouncement(type: String): Boolean = type.equals("announcement", ignoreCase = true)

    fun isPinned(messageId: String, pinnedMessageIds: Set<String>): Boolean =
        messageId in pinnedMessageIds

    fun shouldPoll(
        isVisible: Boolean,
        canUseChat: Boolean,
        conversationId: String?,
        requestInProgress: Boolean
    ): Boolean = isVisible && canUseChat && conversationId != null && !requestInProgress

    fun mergeMessages(
        current: List<ChatMessageParams>,
        incoming: List<ChatMessageParams>
    ): List<ChatMessageParams> = (current + incoming)
        .distinctBy { it.id }
        .sortedWith(compareBy<ChatMessageParams> { it.createdAt }.thenBy { it.id })

    fun findReplyPreview(
        messages: List<ChatMessageParams>,
        replyToMessageId: String?
    ): ChatMessageParams? = replyToMessageId
        ?.takeIf { it.isNotBlank() }
        ?.let { target -> messages.firstOrNull { it.id == target } }

    /** New Chat / Directory tab stays discoverable whenever chat.view is granted. */
    fun shouldShowNewChatAction(canUseChat: Boolean): Boolean = canUseChat

    fun isEmployeeActive(status: String?): Boolean =
        status.isNullOrBlank() || status.equals("active", ignoreCase = true)

    fun isDirectoryRecipientSelectable(userId: String?): Boolean = !userId.isNullOrBlank()

    /**
     * Start/open a direct conversation from the directory.
     * Inactive peers remain selectable so managers can open history; send stays gated separately.
     */
    fun canStartDirect(
        canCreateDirect: Boolean,
        isOpening: Boolean,
        userId: String?,
        isLoadingMessages: Boolean = false
    ): Boolean = canCreateDirect &&
        !isOpening &&
        !isLoadingMessages &&
        isDirectoryRecipientSelectable(userId)

    fun canStartDepartment(
        canCreateDepartment: Boolean,
        isOpening: Boolean,
        departmentId: String?,
        isLoadingMessages: Boolean = false
    ): Boolean = canCreateDepartment &&
        !isOpening &&
        !isLoadingMessages &&
        !departmentId.isNullOrBlank()

    fun canComposeWithPeer(
        repliesEnabled: Boolean,
        peerStatus: String?
    ): Boolean = repliesEnabled && isEmployeeActive(peerStatus)

    fun shouldShowInactivePeerBanner(
        conversationType: String,
        peerStatus: String?
    ): Boolean = conversationType.equals("direct", ignoreCase = true) &&
        !peerStatus.isNullOrBlank() &&
        !isEmployeeActive(peerStatus)

    fun resolveDirectoryEmptyKind(
        canCreateDirect: Boolean,
        directoryHasLoaded: Boolean,
        resultsEmpty: Boolean,
        queryBlank: Boolean,
        isSearching: Boolean
    ): ChatDirectoryEmptyKind? {
        if (!canCreateDirect) return ChatDirectoryEmptyKind.PermissionDenied
        if (isSearching || !resultsEmpty) return null
        if (!directoryHasLoaded) return ChatDirectoryEmptyKind.IdleBeforeSearch
        if (queryBlank) return ChatDirectoryEmptyKind.NoRecipientsAvailable
        return ChatDirectoryEmptyKind.SearchedNoResults
    }
}
