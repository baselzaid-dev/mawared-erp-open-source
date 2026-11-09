package com.example.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Campaign
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Reply
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Workspaces
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.example.R
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.domain.model.ChatConversationParams
import com.example.domain.model.ChatDepartmentSummary
import com.example.domain.model.ChatDirectoryUser
import com.example.domain.model.ChatMessageParams
import com.example.domain.model.ChatPinnedMessageParams
import com.example.ui.theme.AmberStatus
import com.example.ui.theme.BlueStatus
import com.example.ui.theme.EmeraldMain
import com.example.ui.theme.RedStatus
import com.example.ui.theme.SlateDark
import com.example.ui.theme.SlateLight
import com.example.ui.theme.SlateMedium
import kotlinx.coroutines.launch
import com.example.ui.ux.MawaredTextField

@Composable
fun MawaredInternalChat(viewModel: MawaredViewModel) {
    val state by viewModel.chatUiState.collectAsState()
    val selected = state.selectedConversation
    val surface = if (viewModel.isDarkTheme) SlateDark else Color(0xFFF8FAFC)
    val textColor = if (viewModel.isDarkTheme) Color.White else SlateDark

    var announcementTitle by remember { mutableStateOf("") }
    var announcementBody by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        viewModel.refreshChat()
    }

    DisposableEffect(Unit) {
        onDispose { viewModel.clearChatDirectoryTransientState() }
    }

    LaunchedEffect(state.isCreatingAnnouncement) {
        if (!state.isCreatingAnnouncement && state.selectedConversation != null) {
            announcementTitle = ""
            announcementBody = ""
        }
    }

    if (!state.canUseChat) {
        ChatAccessDenied(viewModel.isDarkTheme)
        return
    }

    Surface(modifier = Modifier.fillMaxSize(), color = surface) {
        if (selected == null) {
            ChatHome(
                state = state,
                isDark = viewModel.isDarkTheme,
                textColor = textColor,
                canCreateDirect = state.canCreateDirect,
                canCreateDepartment = state.canCreateDepartment,
                canCreateAnnouncement = state.canCreateAnnouncement,
                announcementTitle = announcementTitle,
                announcementBody = announcementBody,
                isCreatingAnnouncement = state.isCreatingAnnouncement,
                onAnnouncementTitleChange = { announcementTitle = it.take(200) },
                onAnnouncementBodyChange = { announcementBody = it.take(4000) },
                onCreateAnnouncement = {
                    viewModel.createChatAnnouncement(
                        announcementTitle.trim(),
                        announcementBody.trim().ifBlank { null }
                    )
                },
                onRefresh = viewModel::refreshChat,
                onQueryChange = viewModel::updateChatDirectoryQuery,
                onSearch = viewModel::searchChatDirectory,
                onEnsureDirectoryBrowse = viewModel::ensureChatDirectoryBrowse,
                onOpenDirect = viewModel::openDirectChat,
                onOpenDepartment = viewModel::openDepartmentChat,
                onOpenConversation = viewModel::openChatConversation,
                onClearError = viewModel::clearChatError
            )
        } else {
            ConversationScreen(
                state = state,
                conversation = selected,
                pins = state.pins,
                replyToMessageId = state.replyToMessageId,
                canPin = state.canPin,
                isPinning = state.isPinning,
                isDark = viewModel.isDarkTheme,
                textColor = textColor,
                onBack = viewModel::closeChatConversation,
                onLoadOlder = viewModel::loadOlderChatMessages,
                onDraftChange = viewModel::updateChatDraft,
                onSend = { viewModel.sendChatMessage(state.replyToMessageId) },
                onClearError = viewModel::clearChatError,
                onVisible = viewModel::setChatConversationVisible,
                onMarkRead = viewModel::markSelectedConversationRead,
                onReply = { messageId -> viewModel.setChatReplyToMessage(messageId) },
                onClearReply = { viewModel.setChatReplyToMessage(null) },
                onPin = viewModel::pinChatMessage,
                onUnpin = viewModel::unpinChatMessage,
                onAttach = { uri -> viewModel.uploadChatAttachment(uri, selected.id) },
                onOpenAttachment = viewModel::openAttachment,
                isAttachmentUploading = viewModel.isAttachmentUploading,
                onRetry = {
                    viewModel.openChatConversation(selected.id)
                    viewModel.refreshChatPins()
                }
            )
        }
    }
}

@Composable
private fun ChatAccessDenied(isDark: Boolean) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Default.Lock, contentDescription = null, tint = SlateLight, modifier = Modifier.size(56.dp))
            Text(
                text = stringResource(R.string.chat_no_permission_title),
                color = if (isDark) Color.White else SlateDark,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center
            )
            Text(
                text = stringResource(R.string.chat_no_permission_detail),
                color = SlateLight,
                fontSize = 12.sp,
                textAlign = TextAlign.Center
            )
        }
    }
}

@Composable
private fun ChatHome(
    state: ChatUiState,
    isDark: Boolean,
    textColor: Color,
    canCreateDirect: Boolean,
    canCreateDepartment: Boolean,
    canCreateAnnouncement: Boolean,
    announcementTitle: String,
    announcementBody: String,
    isCreatingAnnouncement: Boolean,
    onAnnouncementTitleChange: (String) -> Unit,
    onAnnouncementBodyChange: (String) -> Unit,
    onCreateAnnouncement: () -> Unit,
    onRefresh: () -> Unit,
    onQueryChange: (String) -> Unit,
    onSearch: () -> Unit,
    onEnsureDirectoryBrowse: () -> Unit,
    onOpenDirect: (String) -> Unit,
    onOpenDepartment: (String) -> Unit,
    onOpenConversation: (String) -> Unit,
    onClearError: () -> Unit
) {
    var selectedTab by remember { mutableStateOf(ChatHomeTab.Conversations) }

    LaunchedEffect(selectedTab, canCreateDirect) {
        if (selectedTab == ChatHomeTab.Directory &&
            ChatUiRules.shouldShowNewChatAction(state.canUseChat) &&
            canCreateDirect
        ) {
            onEnsureDirectoryBrowse()
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        ChatHeader(
            totalUnread = state.totalUnread,
            isPolling = state.isPolling,
            onRefresh = onRefresh,
            textColor = textColor
        )
        if (state.isLoading || state.isOpeningConversation) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth(), color = EmeraldMain)
        }
        ChatErrorBanner(
            state.errorMessage,
            onClearError,
            onRetry = when (selectedTab) {
                ChatHomeTab.Directory -> onSearch
                else -> onRefresh
            }
        )
        // New Chat tab stays visible whenever chat.view is granted (never hidden for empty directory).
        ChatTabRow(
            selectedTab = selectedTab,
            showNewChat = ChatUiRules.shouldShowNewChatAction(state.canUseChat),
            onSelect = { selectedTab = it }
        )

        when (selectedTab) {
            ChatHomeTab.Conversations -> ConversationList(
                conversations = state.conversations,
                isDark = isDark,
                textColor = textColor,
                onOpenConversation = onOpenConversation
            )

            ChatHomeTab.Directory -> DirectoryPanel(
                query = state.directoryQuery,
                results = state.directoryResults,
                directoryHasLoaded = state.directoryHasLoaded,
                isSearching = state.isSearchingDirectory,
                isOpening = state.isOpeningConversation,
                canCreateDirect = canCreateDirect,
                textColor = textColor,
                onQueryChange = onQueryChange,
                onSearch = onSearch,
                onOpenDirect = onOpenDirect
            )

            ChatHomeTab.Departments -> DepartmentPanel(
                departments = state.departments,
                canCreateDepartment = canCreateDepartment,
                isOpening = state.isOpeningConversation,
                textColor = textColor,
                onOpenDepartment = onOpenDepartment
            )

            ChatHomeTab.Announcements -> AnnouncementComposerPanel(
                canCreateAnnouncement = canCreateAnnouncement,
                title = announcementTitle,
                body = announcementBody,
                isCreating = isCreatingAnnouncement,
                textColor = textColor,
                onTitleChange = onAnnouncementTitleChange,
                onBodyChange = onAnnouncementBodyChange,
                onCreate = onCreateAnnouncement
            )
        }
    }
}

@Composable
private fun ChatHeader(
    totalUnread: Int,
    isPolling: Boolean,
    onRefresh: () -> Unit,
    textColor: Color
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Column {
            Text(stringResource(R.string.chat_title), color = textColor, fontSize = 21.sp, fontWeight = FontWeight.Bold)
            Text(
                text = if (isPolling) {
                    stringResource(R.string.chat_polling_active)
                } else {
                    stringResource(R.string.chat_subtitle)
                },
                color = SlateLight,
                fontSize = 12.sp
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (totalUnread > 0) {
                Badge(containerColor = RedStatus) {
                    Text(totalUnread.toString(), color = Color.White, fontSize = 11.sp)
                }
            }
            IconButton(onClick = onRefresh) {
                Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.ux_refresh), tint = EmeraldMain)
            }
        }
    }
}

@Composable
private fun ChatErrorBanner(message: String?, onClearError: () -> Unit, onRetry: (() -> Unit)? = null) {
    if (message == null) return
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = RedStatus.copy(alpha = 0.10f),
        shape = RoundedCornerShape(8.dp)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(
                text = message,
                color = RedStatus,
                fontSize = 12.sp,
                modifier = Modifier.weight(1f)
            )
            if (onRetry != null) {
                TextButton(onClick = onRetry) {
                    Text(stringResource(R.string.ux_retry), color = EmeraldMain)
                }
            }
            TextButton(onClick = onClearError) {
                Text(stringResource(R.string.ux_hide), color = RedStatus)
            }
        }
    }
}

@Composable
private fun ChatTabRow(
    selectedTab: ChatHomeTab,
    showNewChat: Boolean,
    onSelect: (ChatHomeTab) -> Unit
) {
    val tabs = ChatHomeTab.entries.filter { tab ->
        tab != ChatHomeTab.Directory || showNewChat
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        tabs.forEach { tab ->
            val selected = tab == selectedTab
            AssistChip(
                onClick = { onSelect(tab) },
                label = { Text(tab.label(), fontSize = 12.sp, fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium) },
                leadingIcon = {
                    Icon(
                        imageVector = when (tab) {
                            ChatHomeTab.Conversations -> Icons.Default.ChatBubbleOutline
                            ChatHomeTab.Directory -> Icons.Default.Search
                            ChatHomeTab.Departments -> Icons.Default.Workspaces
                            ChatHomeTab.Announcements -> Icons.Default.Campaign
                        },
                        contentDescription = tab.label(),
                        modifier = Modifier.size(18.dp)
                    )
                },
                colors = androidx.compose.material3.AssistChipDefaults.assistChipColors(
                    containerColor = if (selected) EmeraldMain.copy(alpha = 0.18f) else Color.Transparent,
                    labelColor = if (selected) EmeraldMain else SlateLight,
                    leadingIconContentColor = if (selected) EmeraldMain else SlateLight
                ),
                shape = RoundedCornerShape(8.dp)
            )
        }
    }
}

@Composable
private fun AnnouncementComposerPanel(
    canCreateAnnouncement: Boolean,
    title: String,
    body: String,
    isCreating: Boolean,
    textColor: Color,
    onTitleChange: (String) -> Unit,
    onBodyChange: (String) -> Unit,
    onCreate: () -> Unit
) {
    if (!canCreateAnnouncement) {
        EmptyChatState(
            icon = Icons.Default.Lock,
            title = stringResource(R.string.chat_announcement_no_permission_title),
            body = stringResource(R.string.chat_announcement_no_permission_detail),
            textColor = textColor
        )
        return
    }

    val canSubmit = ChatUiRules.canCreateAnnouncement(canCreateAnnouncement, isCreating, title)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            stringResource(R.string.chat_channel_announcement),
            color = textColor,
            fontWeight = FontWeight.Bold
        )
        Text(
            stringResource(R.string.chat_announcement_replies_hint),
            color = SlateLight,
            fontSize = 12.sp
        )
        MawaredTextField(
            value = title,
            onValueChange = onTitleChange,
            label = stringResource(R.string.chat_announcement_title_label),
            modifier = Modifier.fillMaxWidth(),
            enabled = !isCreating,
            focusedBorderColor = EmeraldMain,
            unfocusedBorderColor = SlateLight.copy(alpha = 0.35f),
            textColor = textColor,
            labelColor = EmeraldMain
        )
        MawaredTextField(
            value = body,
            onValueChange = onBodyChange,
            label = stringResource(R.string.chat_announcement_body_label),
            modifier = Modifier.fillMaxWidth(),
            enabled = !isCreating,
            focusedBorderColor = EmeraldMain,
            unfocusedBorderColor = SlateLight.copy(alpha = 0.35f),
            textColor = textColor,
            labelColor = EmeraldMain
        )
        Button(
            onClick = onCreate,
            enabled = canSubmit,
            colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain),
            shape = RoundedCornerShape(8.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            if (isCreating) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = SlateDark)
                Spacer(modifier = Modifier.width(8.dp))
            }
            Text(
                stringResource(R.string.chat_announcement_publish),
                color = SlateDark,
                fontWeight = FontWeight.Bold
            )
        }
    }
}

@Composable
private fun ConversationList(
    conversations: List<ChatConversationParams>,
    isDark: Boolean,
    textColor: Color,
    onOpenConversation: (String) -> Unit
) {
    if (conversations.isEmpty()) {
        EmptyChatState(
            icon = Icons.Default.ChatBubbleOutline,
            title = stringResource(R.string.chat_empty_conversations_title),
            body = stringResource(R.string.chat_empty_conversations_body),
            textColor = textColor
        )
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        items(conversations, key = { it.id }) { conversation ->
            ConversationRow(
                conversation = conversation,
                isDark = isDark,
                onClick = { onOpenConversation(conversation.id) }
            )
        }
    }
}

@Composable
private fun ConversationRow(conversation: ChatConversationParams, isDark: Boolean, onClick: () -> Unit) {
    ElevatedCard(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(8.dp)
    ) {
        ListItem(
            headlineContent = {
                Text(
                    conversation.title,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    fontWeight = FontWeight.Bold
                )
            },
            supportingContent = {
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(
                        text = conversation.lastMessagePreview ?: stringResource(R.string.chat_no_messages_preview),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        color = SlateLight,
                        fontSize = 12.sp
                    )
                    Text(
                        text = conversation.lastMessageAt?.let(::formatChatTimestamp) ?: stringResource(R.string.chat_ready_preview),
                        color = SlateLight,
                        fontSize = 11.sp
                    )
                }
            },
            leadingContent = {
                ChatTypeIcon(conversation.type)
            },
            trailingContent = {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (conversation.unreadCount > 0) {
                        Badge(containerColor = RedStatus) {
                            Text(conversation.unreadCount.toString(), color = Color.White, fontSize = 10.sp)
                        }
                    }
                    Text(
                        text = conversationTypeLabel(conversation.type),
                        color = if (isDark) Color.White.copy(alpha = 0.72f) else SlateLight,
                        fontSize = 10.sp
                    )
                }
            },
            colors = androidx.compose.material3.ListItemDefaults.colors(
                containerColor = if (isDark) SlateMedium else Color.White
            )
        )
    }
}

@Composable
private fun DirectoryPanel(
    query: String,
    results: List<ChatDirectoryUser>,
    directoryHasLoaded: Boolean,
    isSearching: Boolean,
    isOpening: Boolean,
    canCreateDirect: Boolean,
    textColor: Color,
    onQueryChange: (String) -> Unit,
    onSearch: () -> Unit,
    onOpenDirect: (String) -> Unit
) {
    if (!canCreateDirect) {
        EmptyChatState(
            icon = Icons.Default.Lock,
            title = stringResource(R.string.chat_direct_no_permission_title),
            body = stringResource(R.string.chat_direct_no_permission_detail),
            textColor = textColor
        )
        return
    }

    val emptyKind = ChatUiRules.resolveDirectoryEmptyKind(
        canCreateDirect = canCreateDirect,
        directoryHasLoaded = directoryHasLoaded,
        resultsEmpty = results.isEmpty(),
        queryBlank = query.isBlank(),
        isSearching = isSearching
    )

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MawaredTextField(
                value = query,
                onValueChange = onQueryChange,
                label = stringResource(R.string.chat_search_label),
                modifier = Modifier.weight(1f),
                enabled = !isOpening,
                imeAction = ImeAction.Search,
                onImeAction = onSearch,
                focusedBorderColor = EmeraldMain,
                unfocusedBorderColor = SlateLight.copy(alpha = 0.35f),
                textColor = textColor,
                labelColor = EmeraldMain
            )
            Button(
                onClick = onSearch,
                enabled = !isSearching && !isOpening,
                colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain),
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.height(48.dp)
            ) {
                if (isSearching) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = SlateDark)
                } else {
                    Text(stringResource(R.string.ux_search), color = SlateDark, fontWeight = FontWeight.Bold)
                }
            }
        }

        if (isOpening) {
            Text(
                stringResource(R.string.chat_opening_conversation),
                color = SlateLight,
                fontSize = 12.sp
            )
        }

        when (emptyKind) {
            ChatDirectoryEmptyKind.PermissionDenied -> Unit
            ChatDirectoryEmptyKind.IdleBeforeSearch -> EmptyChatState(
                icon = Icons.Default.Search,
                title = stringResource(R.string.chat_empty_search_idle_title),
                body = stringResource(R.string.chat_empty_search_idle_body),
                textColor = textColor,
                compact = true
            )
            ChatDirectoryEmptyKind.NoRecipientsAvailable -> EmptyChatState(
                icon = Icons.Default.ChatBubbleOutline,
                title = stringResource(R.string.chat_no_recipients_available_title),
                body = stringResource(R.string.chat_no_recipients_available_body),
                textColor = textColor,
                compact = true
            )
            ChatDirectoryEmptyKind.SearchedNoResults -> EmptyChatState(
                icon = Icons.Default.Search,
                title = stringResource(R.string.chat_empty_search_title),
                body = stringResource(R.string.chat_empty_search_body),
                textColor = textColor,
                compact = true
            )
            null -> LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(results, key = { it.userId }) { user ->
                    DirectoryRow(
                        user = user,
                        canStart = ChatUiRules.canStartDirect(canCreateDirect, isOpening, user.userId),
                        onOpenDirect = { onOpenDirect(user.userId) }
                    )
                }
            }
        }
    }
}

@Composable
private fun DirectoryRow(
    user: ChatDirectoryUser,
    canStart: Boolean,
    onOpenDirect: () -> Unit
) {
    val isActive = ChatUiRules.isEmployeeActive(user.status)
    ElevatedCard(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(8.dp)) {
        ListItem(
            headlineContent = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(user.displayName, fontWeight = FontWeight.Bold)
                    if (!isActive) {
                        Text(
                            stringResource(R.string.chat_employee_inactive_badge),
                            color = RedStatus,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            },
            supportingContent = {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        listOfNotNull(user.title, user.departmentName, user.roleName).joinToString(" • "),
                        color = SlateLight,
                        fontSize = 12.sp,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                    if (!isActive) {
                        Text(
                            stringResource(R.string.chat_inactive_cannot_message),
                            color = RedStatus,
                            fontSize = 11.sp
                        )
                    }
                }
            },
            leadingContent = { ChatInitials(user.displayName) },
            trailingContent = {
                val startCd = stringResource(R.string.chat_cd_start_direct, user.displayName)
                OutlinedButton(
                    onClick = onOpenDirect,
                    // Managers may open history with inactive employees; send remains blocked in composer/server.
                    enabled = canStart,
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier
                        .height(48.dp)
                        .semantics { contentDescription = startCd }
                ) {
                    Text(
                        stringResource(R.string.chat_start_conversation),
                        color = when {
                            !canStart -> SlateLight
                            isActive -> EmeraldMain
                            else -> AmberStatus
                        }
                    )
                }
            }
        )
    }
}

@Composable
private fun DepartmentPanel(
    departments: List<ChatDepartmentSummary>,
    canCreateDepartment: Boolean,
    isOpening: Boolean,
    textColor: Color,
    onOpenDepartment: (String) -> Unit
) {
    if (!canCreateDepartment) {
        EmptyChatState(
            icon = Icons.Default.Lock,
            title = stringResource(R.string.chat_department_no_permission_title),
            body = stringResource(R.string.chat_department_no_permission_detail),
            textColor = textColor
        )
        return
    }

    if (departments.isEmpty()) {
        EmptyChatState(
            icon = Icons.Default.Workspaces,
            title = stringResource(R.string.chat_empty_departments_title),
            body = stringResource(R.string.chat_empty_departments_body),
            textColor = textColor
        )
        return
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (isOpening) {
            Text(
                stringResource(R.string.chat_opening_conversation),
                color = SlateLight,
                fontSize = 12.sp
            )
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(departments, key = { it.id }) { department ->
                val canStart = ChatUiRules.canStartDepartment(
                    canCreateDepartment,
                    isOpening,
                    department.id
                )
                ElevatedCard(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(8.dp)) {
                    ListItem(
                        headlineContent = { Text(department.name, fontWeight = FontWeight.Bold) },
                        supportingContent = {
                            Text(
                                stringResource(R.string.chat_department_channel_label),
                                color = SlateLight,
                                fontSize = 12.sp
                            )
                        },
                        leadingContent = { ChatTypeIcon("department") },
                        trailingContent = {
                            val openCd = stringResource(R.string.chat_cd_open_department, department.name)
                            OutlinedButton(
                                onClick = { onOpenDepartment(department.id) },
                                enabled = canStart,
                                shape = RoundedCornerShape(8.dp),
                                modifier = Modifier
                                    .height(48.dp)
                                    .semantics { contentDescription = openCd }
                            ) {
                                Text(
                                    stringResource(R.string.ux_open),
                                    color = if (canStart) EmeraldMain else SlateLight
                                )
                            }
                        }
                    )
                }
            }
        }
    }
}

@Composable
private fun ConversationScreen(
    state: ChatUiState,
    conversation: ChatConversationParams,
    pins: List<ChatPinnedMessageParams>,
    replyToMessageId: String?,
    canPin: Boolean,
    isPinning: Boolean,
    isDark: Boolean,
    textColor: Color,
    onBack: () -> Unit,
    onLoadOlder: () -> Unit,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onClearError: () -> Unit,
    onVisible: (Boolean) -> Unit,
    onMarkRead: () -> Unit,
    onReply: (String) -> Unit,
    onClearReply: () -> Unit,
    onPin: (String) -> Unit,
    onUnpin: (String) -> Unit,
    onAttach: (android.net.Uri) -> Unit,
    onOpenAttachment: (String) -> Unit,
    isAttachmentUploading: Boolean,
    onRetry: () -> Unit
) {
    DisposableEffect(conversation.id) {
        onVisible(true)
        onMarkRead()
        onDispose { onVisible(false) }
    }

    val pinnedIds = remember(pins) { pins.map { it.messageId }.toSet() }
    val replyPreview = ChatUiRules.findReplyPreview(state.messages, replyToMessageId)
    val peerStatus = conversation.peer?.status
    val showInactiveBanner = ChatUiRules.shouldShowInactivePeerBanner(conversation.type, peerStatus)
    val composerRepliesEnabled = ChatUiRules.canComposeWithPeer(conversation.repliesEnabled, peerStatus)

    Column(modifier = Modifier.fillMaxSize()) {
        ConversationTopBar(conversation = conversation, textColor = textColor, onBack = onBack)
        if (state.isLoadingMessages) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth(), color = EmeraldMain)
        }
        ChatErrorBanner(state.errorMessage, onClearError, onRetry = onRetry)
        if (showInactiveBanner) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = AmberStatus.copy(alpha = 0.14f)
            ) {
                Text(
                    stringResource(R.string.chat_peer_inactive_banner),
                    color = AmberStatus,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)
                )
            }
        }
        PinnedMessagesBar(
            pins = pins,
            messages = state.messages,
            canPin = canPin,
            isPinning = isPinning,
            textColor = textColor,
            onUnpin = onUnpin
        )
        MessagesList(
            conversation = conversation,
            messages = state.messages,
            pinnedIds = pinnedIds,
            nextCursor = state.nextMessageCursor,
            isLoadingOlder = state.isLoadingOlder,
            canPin = canPin,
            isPinning = isPinning,
            repliesEnabled = composerRepliesEnabled,
            isDark = isDark,
            textColor = textColor,
            onLoadOlder = onLoadOlder,
            onReply = onReply,
            onPin = onPin,
            onUnpin = onUnpin,
            onOpenAttachment = onOpenAttachment,
            modifier = Modifier.weight(1f)
        )
        if (replyPreview != null && composerRepliesEnabled) {
            ReplyPreviewBar(preview = replyPreview, onClear = onClearReply, textColor = textColor)
        }
        ChatComposer(
            draft = state.messageDraft,
            isSending = state.isSending,
            conversationId = conversation.id,
            repliesEnabled = composerRepliesEnabled,
            textColor = textColor,
            isAttachmentUploading = isAttachmentUploading,
            onDraftChange = onDraftChange,
            onSend = onSend,
            onAttach = onAttach
        )
    }
}

@Composable
private fun ConversationTopBar(conversation: ChatConversationParams, textColor: Color, onBack: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            IconButton(onClick = onBack) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = stringResource(R.string.ux_back),
                    tint = textColor
                )
            }
            ChatTypeIcon(conversation.type)
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    conversation.title,
                    color = textColor,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    conversationChannelLabel(conversation.type),
                    color = SlateLight,
                    fontSize = 12.sp
                )
            }
            if (conversation.unreadCount == 0) {
                Icon(Icons.Default.DoneAll, contentDescription = null, tint = EmeraldMain, modifier = Modifier.size(20.dp))
            }
        }
        HorizontalDivider(color = SlateLight.copy(alpha = 0.18f))
    }
}

@Composable
private fun PinnedMessagesBar(
    pins: List<ChatPinnedMessageParams>,
    messages: List<ChatMessageParams>,
    canPin: Boolean,
    isPinning: Boolean,
    textColor: Color,
    onUnpin: (String) -> Unit
) {
    if (pins.isEmpty()) return
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(BlueStatus.copy(alpha = 0.08f))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text(
            stringResource(R.string.chat_pinned),
            color = textColor,
            fontWeight = FontWeight.Bold,
            fontSize = 12.sp
        )
        pins.forEach { pin ->
            val preview = messages.firstOrNull { it.id == pin.messageId }?.body
                ?: stringResource(R.string.chat_pinned_message)
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Icon(Icons.Default.PushPin, contentDescription = null, tint = BlueStatus, modifier = Modifier.size(16.dp))
                Text(
                    preview,
                    color = textColor,
                    fontSize = 12.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                if (ChatUiRules.canUnpinMessage(canPin, isPinning, pin.messageId, true)) {
                    TextButton(onClick = { onUnpin(pin.messageId) }) {
                        Text(stringResource(R.string.chat_unpin), color = EmeraldMain, fontSize = 11.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun ReplyPreviewBar(preview: ChatMessageParams, onClear: () -> Unit, textColor: Color) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = EmeraldMain.copy(alpha = 0.10f)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Icon(Icons.Default.Reply, contentDescription = null, tint = EmeraldMain, modifier = Modifier.size(18.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    stringResource(R.string.chat_replying_to, preview.sender.displayName),
                    color = EmeraldMain,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    preview.body,
                    color = textColor,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            IconButton(onClick = onClear) {
                Icon(Icons.Default.Close, contentDescription = stringResource(R.string.ux_hide), tint = SlateLight)
            }
        }
    }
}

@Composable
private fun MessagesList(
    conversation: ChatConversationParams,
    messages: List<ChatMessageParams>,
    pinnedIds: Set<String>,
    nextCursor: String?,
    isLoadingOlder: Boolean,
    canPin: Boolean,
    isPinning: Boolean,
    repliesEnabled: Boolean,
    isDark: Boolean,
    textColor: Color,
    onLoadOlder: () -> Unit,
    onReply: (String) -> Unit,
    onPin: (String) -> Unit,
    onUnpin: (String) -> Unit,
    onOpenAttachment: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    LazyColumn(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        item {
            Spacer(modifier = Modifier.height(4.dp))
            if (nextCursor != null) {
                TextButton(
                    onClick = onLoadOlder,
                    enabled = !isLoadingOlder,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        if (isLoadingOlder) {
                            stringResource(R.string.chat_loading_older)
                        } else {
                            stringResource(R.string.chat_load_older)
                        },
                        color = EmeraldMain
                    )
                }
            }
        }

        if (messages.isEmpty()) {
            item {
                EmptyChatState(
                    icon = Icons.Default.ChatBubbleOutline,
                    title = stringResource(R.string.chat_empty_messages_title),
                    body = stringResource(R.string.chat_empty_messages_body),
                    textColor = textColor
                )
            }
        } else {
            items(messages, key = { it.id }) { message ->
                MessageBubble(
                    message = message,
                    showSender = conversation.type != "direct",
                    isDark = isDark,
                    repliesEnabled = repliesEnabled,
                    canPin = canPin,
                    isPinning = isPinning,
                    isPinned = ChatUiRules.isPinned(message.id, pinnedIds),
                    onReply = { onReply(message.id) },
                    onPin = { onPin(message.id) },
                    onUnpin = { onUnpin(message.id) },
                    onOpenAttachment = onOpenAttachment
                )
            }
        }
    }
}

@Composable
private fun MessageBubble(
    message: ChatMessageParams,
    showSender: Boolean,
    isDark: Boolean,
    repliesEnabled: Boolean,
    canPin: Boolean,
    isPinning: Boolean,
    isPinned: Boolean,
    onReply: () -> Unit,
    onPin: () -> Unit,
    onUnpin: () -> Unit,
    onOpenAttachment: (String) -> Unit
) {
    val own = message.isOwn
    val bubbleColor = when {
        own -> EmeraldMain.copy(alpha = 0.22f)
        isDark -> SlateMedium
        else -> Color.White
    }
    val canReply = ChatUiRules.canComposeReply(repliesEnabled)
    val canPinThis = ChatUiRules.canPinMessage(canPin, isPinning, message.id, alreadyPinned = isPinned)
    val canUnpinThis = ChatUiRules.canUnpinMessage(canPin, isPinning, message.id, isPinned = isPinned)
    val bodyIsAttachmentOnly = message.attachments.isNotEmpty() &&
        message.body.trim().startsWith("مرفق:")

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = if (own) Alignment.End else Alignment.Start
    ) {
        if (showSender && !own) {
            Text(
                text = message.sender.displayName,
                color = SlateLight,
                fontSize = 11.sp,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
            )
        }
        Surface(
            color = bubbleColor,
            shape = RoundedCornerShape(
                topStart = 8.dp,
                topEnd = 8.dp,
                bottomStart = if (own) 8.dp else 2.dp,
                bottomEnd = if (own) 2.dp else 8.dp
            ),
            tonalElevation = 1.dp
        ) {
            Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp)) {
                if (message.replyToMessageId != null) {
                    Text(
                        stringResource(R.string.chat_reply),
                        color = EmeraldMain,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
                if (!bodyIsAttachmentOnly && message.body.isNotBlank()) {
                    Text(
                        text = message.body,
                        color = if (isDark) Color.White else SlateDark,
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
                message.attachments.forEach { attachment ->
                    ChatAttachmentRow(
                        filename = attachment.originalFilename,
                        byteSize = attachment.byteSize,
                        isDark = isDark,
                        onClick = { onOpenAttachment(attachment.id) }
                    )
                }
                Text(
                    text = formatChatTimestamp(message.createdAt),
                    color = SlateLight,
                    fontSize = 10.sp,
                    modifier = Modifier.padding(top = 4.dp)
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (canReply) {
                TextButton(onClick = onReply) {
                    Text(stringResource(R.string.chat_reply), color = EmeraldMain, fontSize = 11.sp)
                }
            }
            when {
                canPinThis -> TextButton(onClick = onPin) {
                    Text(stringResource(R.string.chat_pin), color = BlueStatus, fontSize = 11.sp)
                }
                canUnpinThis -> TextButton(onClick = onUnpin) {
                    Text(stringResource(R.string.chat_unpin), color = BlueStatus, fontSize = 11.sp)
                }
            }
        }
    }
}

@Composable
private fun ChatAttachmentRow(
    filename: String,
    byteSize: Int,
    isDark: Boolean,
    onClick: () -> Unit
) {
    val sizeKb = ((byteSize + 1023) / 1024).coerceAtLeast(1)
    Surface(
        onClick = onClick,
        color = if (isDark) Color.Black.copy(alpha = 0.25f) else EmeraldMain.copy(alpha = 0.10f),
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 6.dp)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Icon(
                Icons.Default.AttachFile,
                contentDescription = stringResource(R.string.attachment_file_label),
                tint = EmeraldMain,
                modifier = Modifier.size(18.dp)
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    stringResource(R.string.attachment_file_label),
                    color = EmeraldMain,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    filename,
                    color = if (isDark) Color.White else SlateDark,
                    fontSize = 13.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    stringResource(R.string.attachment_size_kb, sizeKb),
                    color = SlateLight,
                    fontSize = 10.sp
                )
            }
            Text(
                stringResource(R.string.attachment_open),
                color = EmeraldMain,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold
            )
        }
    }
}

@Composable
private fun ChatComposer(
    draft: String,
    isSending: Boolean,
    conversationId: String?,
    repliesEnabled: Boolean,
    textColor: Color,
    isAttachmentUploading: Boolean,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onAttach: (android.net.Uri) -> Unit
) {
    val canSend = ChatUiRules.canSend(draft, isSending, conversationId, repliesEnabled)
    val remaining = 4000 - draft.length
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null || conversationId.isNullOrBlank() || isAttachmentUploading) return@rememberLauncherForActivityResult
        onAttach(uri)
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.White.copy(alpha = 0.02f))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        if (!repliesEnabled) {
            Text(
                stringResource(R.string.chat_replies_disabled),
                color = SlateLight,
                fontSize = 12.sp
            )
        }
        if (isAttachmentUploading) {
            Text(stringResource(R.string.attachment_uploading), color = SlateLight, fontSize = 12.sp)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            IconButton(
                onClick = { picker.launch("*/*") },
                enabled = !isSending && !isAttachmentUploading && repliesEnabled && !conversationId.isNullOrBlank()
            ) {
                Icon(
                    Icons.Default.AttachFile,
                    contentDescription = stringResource(R.string.attachment_pick),
                    tint = EmeraldMain
                )
            }
            MawaredTextField(
                value = draft,
                onValueChange = { onDraftChange(it.take(4000)) },
                label = stringResource(R.string.chat_message_placeholder),
                modifier = Modifier.weight(1f),
                enabled = !isSending && repliesEnabled,
                isError = remaining < 0,
                supportingText = if (remaining < 200) stringResource(R.string.chat_chars_remaining, remaining) else null,
                imeAction = ImeAction.Send,
                onImeAction = { if (canSend) onSend() },
                focusedBorderColor = EmeraldMain,
                unfocusedBorderColor = SlateLight.copy(alpha = 0.35f),
                textColor = textColor,
                labelColor = EmeraldMain
            )
            IconButton(
                onClick = onSend,
                enabled = canSend,
                modifier = Modifier
                    .size(48.dp)
                    .background(if (canSend) EmeraldMain else SlateLight.copy(alpha = 0.35f), CircleShape)
            ) {
                if (isSending) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = SlateDark)
                } else {
                    Icon(Icons.Default.Send, contentDescription = stringResource(R.string.ux_send), tint = SlateDark)
                }
            }
        }
        Text(
            text = if (remaining < 200) {
                stringResource(R.string.chat_chars_remaining, remaining)
            } else {
                stringResource(R.string.chat_text_only_hint)
            },
            color = if (remaining < 0) RedStatus else SlateLight,
            fontSize = 11.sp,
            textAlign = TextAlign.End,
            modifier = Modifier.fillMaxWidth()
        )
    }
}

@Composable
private fun EmptyChatState(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    body: String,
    textColor: Color,
    compact: Boolean = false
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = if (compact) 12.dp else 32.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(icon, contentDescription = null, tint = SlateLight, modifier = Modifier.size(if (compact) 32.dp else 42.dp))
            Text(title, color = textColor, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
            Text(body, color = SlateLight, fontSize = 12.sp, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun ChatTypeIcon(type: String) {
    val isDepartment = type == "department"
    val isAnnouncement = ChatUiRules.isAnnouncement(type)
    Box(
        modifier = Modifier
            .size(40.dp)
            .background(
                color = when {
                    isAnnouncement -> BlueStatus.copy(alpha = 0.14f)
                    isDepartment -> BlueStatus.copy(alpha = 0.14f)
                    else -> EmeraldMain.copy(alpha = 0.16f)
                },
                shape = CircleShape
            ),
        contentAlignment = Alignment.Center
    ) {
        Icon(
            imageVector = when {
                isAnnouncement -> Icons.Default.Campaign
                isDepartment -> Icons.Default.Group
                else -> Icons.Default.ChatBubbleOutline
            },
            contentDescription = null,
            tint = if (isDepartment || isAnnouncement) BlueStatus else EmeraldMain,
            modifier = Modifier.size(21.dp)
        )
    }
}

@Composable
private fun ChatInitials(name: String) {
    val initials = name.trim().take(2).ifBlank { "م" }
    Box(
        modifier = Modifier
            .size(40.dp)
            .background(EmeraldMain.copy(alpha = 0.18f), CircleShape),
        contentAlignment = Alignment.Center
    ) {
        Text(initials, color = EmeraldMain, fontWeight = FontWeight.Bold, fontSize = 13.sp)
    }
}

private enum class ChatHomeTab {
    Conversations,
    Directory,
    Departments,
    Announcements;

    @Composable
    fun label(): String = when (this) {
        Conversations -> stringResource(R.string.chat_tab_conversations)
        Directory -> stringResource(R.string.chat_tab_directory)
        Departments -> stringResource(R.string.chat_tab_departments)
        Announcements -> stringResource(R.string.chat_tab_announcements)
    }
}

@Composable
private fun conversationTypeLabel(type: String): String = when {
    ChatUiRules.isAnnouncement(type) -> stringResource(R.string.chat_type_announcement)
    type == "department" -> stringResource(R.string.chat_type_department)
    else -> stringResource(R.string.chat_type_direct)
}

@Composable
private fun conversationChannelLabel(type: String): String = when {
    ChatUiRules.isAnnouncement(type) -> stringResource(R.string.chat_channel_announcement)
    type == "department" -> stringResource(R.string.chat_channel_department)
    else -> stringResource(R.string.chat_channel_direct)
}

private fun formatChatTimestamp(value: String): String {
    val cleaned = value.replace("T", " ").replace("Z", "")
    return when {
        cleaned.length >= 16 -> cleaned.substring(0, 16)
        cleaned.isNotBlank() -> cleaned
        else -> ""
    }
}
