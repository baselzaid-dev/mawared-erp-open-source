package com.example.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.domain.model.NotificationCategory
import com.example.domain.model.NotificationInboxItem
import com.example.ui.navigation.ResourceDescriptor
import com.example.ui.ux.MawaredEmptyState
import com.example.ui.ux.MawaredErrorState
import com.example.ui.ux.MawaredLoadingState

/**
 * Callback surface for Notification Center actions. Coordinator/ViewModel wiring
 * can implement this interface without changing these views.
 */
interface NotificationCenterActions {
    fun onNotificationClick(notificationId: String, descriptor: ResourceDescriptor?)
    fun onMarkRead(notificationId: String)
    fun onHide(notificationId: String)
    fun onMarkAllRead(category: String?)
    fun onRetry()
    fun onCategorySelected(category: String?)
    fun onOpenPreferences() {}
}

sealed interface NotificationCenterUiState {
    data object Loading : NotificationCenterUiState

    data class Content(
        val items: List<NotificationInboxItem>,
        val selectedCategory: String? = null
    ) : NotificationCenterUiState

    data object Empty : NotificationCenterUiState

    data class Error(val message: String) : NotificationCenterUiState
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationCenterScreen(
    state: NotificationCenterUiState,
    actions: NotificationCenterActions,
    modifier: Modifier = Modifier
) {
    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            NotificationCenterTopBar(
                selectedCategory = (state as? NotificationCenterUiState.Content)?.selectedCategory,
                onMarkAllRead = { actions.onMarkAllRead((state as? NotificationCenterUiState.Content)?.selectedCategory) },
                onOpenPreferences = actions::onOpenPreferences
            )
        }
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            when (state) {
                NotificationCenterUiState.Loading -> {
                    MawaredLoadingState(
                        modifier = Modifier.align(Alignment.Center),
                        message = stringResource(R.string.notification_loading)
                    )
                }

                is NotificationCenterUiState.Error -> {
                    MawaredErrorState(
                        modifier = Modifier.align(Alignment.Center),
                        message = state.message,
                        retryLabel = stringResource(R.string.ux_retry),
                        onRetry = actions::onRetry
                    )
                }

                NotificationCenterUiState.Empty -> {
                    MawaredEmptyState(
                        modifier = Modifier.align(Alignment.Center),
                        title = stringResource(R.string.notification_empty_title),
                        detail = stringResource(R.string.notification_empty_detail)
                    )
                }

                is NotificationCenterUiState.Content -> {
                    Column(modifier = Modifier.fillMaxSize()) {
                        NotificationCategoryFilters(
                            selectedCategory = state.selectedCategory,
                            onCategorySelected = actions::onCategorySelected
                        )
                        if (state.items.isEmpty()) {
                            MawaredEmptyState(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 32.dp),
                                title = stringResource(R.string.notification_empty_category_title),
                                detail = stringResource(R.string.notification_empty_category_detail)
                            )
                        } else {
                            LazyColumn(
                                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                items(state.items, key = { it.id }) { item ->
                                    NotificationRow(
                                        item = item,
                                        onClick = {
                                            actions.onNotificationClick(item.id, item.resourceDescriptor)
                                        },
                                        onMarkRead = { actions.onMarkRead(item.id) },
                                        onHide = { actions.onHide(item.id) }
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NotificationCenterTopBar(
    selectedCategory: String?,
    onMarkAllRead: () -> Unit,
    onOpenPreferences: () -> Unit
) {
    TopAppBar(
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = Icons.Filled.Notifications,
                    contentDescription = null,
                    modifier = Modifier.size(22.dp)
                )
                Spacer(modifier = Modifier.size(8.dp))
                Text(text = stringResource(R.string.notification_center_title), fontWeight = FontWeight.Bold)
            }
        },
        actions = {
            IconButton(onClick = onOpenPreferences) {
                Icon(
                    imageVector = Icons.Filled.Settings,
                    contentDescription = stringResource(R.string.notification_prefs_title)
                )
            }
            TextButton(onClick = onMarkAllRead) {
                Icon(
                    imageVector = Icons.Filled.DoneAll,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp)
                )
                Spacer(modifier = Modifier.size(4.dp))
                Text(text = stringResource(R.string.notification_mark_all_read))
            }
        }
    )
}

@Composable
private fun NotificationCategoryFilters(
    selectedCategory: String?,
    onCategorySelected: (String?) -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        FilterChip(
            selected = selectedCategory == null,
            onClick = { onCategorySelected(null) },
            label = { Text(stringResource(R.string.ux_all)) }
        )
        NotificationCategory.entries.forEach { category ->
            FilterChip(
                selected = selectedCategory == category.name.lowercase(),
                onClick = { onCategorySelected(category.name.lowercase()) },
                label = { Text(category.arabicLabel) }
            )
        }
    }
}

@Composable
private fun NotificationRow(
    item: NotificationInboxItem,
    onClick: () -> Unit,
    onMarkRead: () -> Unit,
    onHide: () -> Unit
) {
    val rowDescription = if (item.isRead) {
        "إشعار مقروء: ${item.title}"
    } else {
        "إشعار غير مقروء: ${item.title}"
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .semantics { contentDescription = rowDescription }
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = if (item.isRead) {
                MaterialTheme.colorScheme.surface
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            }
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.Top
        ) {
            if (!item.isRead) {
                Box(
                    modifier = Modifier
                        .padding(top = 6.dp, end = 10.dp)
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary)
                )
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = item.title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = if (item.isRead) FontWeight.Normal else FontWeight.Bold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = item.message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis
                )
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    text = item.createdAtLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                if (!item.isRead) {
                    TextButton(onClick = onMarkRead) {
                        Text(text = stringResource(R.string.notification_mark_read))
                    }
                }
                IconButton(onClick = onHide) {
                    Icon(
                        imageVector = Icons.Outlined.VisibilityOff,
                        contentDescription = stringResource(R.string.notification_hide_cd)
                    )
                }
            }
        }
    }
}
