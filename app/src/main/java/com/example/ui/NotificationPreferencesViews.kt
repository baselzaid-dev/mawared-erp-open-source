package com.example.ui

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.NotificationsActive
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.ui.ux.MawaredErrorState
import com.example.ui.ux.MawaredLoadingState

/**
 * Callback surface for notification preference actions. Coordinator wiring
 * can implement this without changing these views.
 */
interface NotificationPreferencesActions {
    fun onToggle(category: String, enabled: Boolean)
    fun onSave()
    fun onRetry()
    fun onDismissSaveFeedback()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationPreferencesScreen(
    state: NotificationPreferencesUiState,
    actions: NotificationPreferencesActions,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null
) {
    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = { NotificationPreferencesTopBar(onBack = onBack) }
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            when (state) {
                NotificationPreferencesUiState.Loading -> {
                    MawaredLoadingState(
                        modifier = Modifier.align(Alignment.Center),
                        message = stringResource(R.string.notification_prefs_loading)
                    )
                }

                is NotificationPreferencesUiState.Error -> {
                    MawaredErrorState(
                        modifier = Modifier.align(Alignment.Center),
                        message = state.message,
                        retryLabel = stringResource(R.string.ux_retry),
                        onRetry = actions::onRetry
                    )
                }

                is NotificationPreferencesUiState.Content -> {
                    NotificationPreferencesContent(
                        content = state.content,
                        actions = actions
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NotificationPreferencesTopBar(onBack: (() -> Unit)? = null) {
    TopAppBar(
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = Icons.Filled.Settings,
                    contentDescription = null,
                    modifier = Modifier.size(22.dp)
                )
                Spacer(modifier = Modifier.size(8.dp))
                Text(text = stringResource(R.string.notification_prefs_title), fontWeight = FontWeight.Bold)
            }
        },
        navigationIcon = {
            if (onBack != null) {
                IconButton(onClick = onBack) {
                    Icon(
                        imageVector = Icons.Filled.ArrowBack,
                        contentDescription = "رجوع"
                    )
                }
            }
        }
    )
}

@Composable
private fun NotificationPreferencesContent(
    content: NotificationPreferencesContentState,
    actions: NotificationPreferencesActions
) {
    Column(modifier = Modifier.fillMaxSize()) {
        SaveFeedbackBanner(
            saveState = content.saveState,
            errorMessage = content.saveErrorMessage,
            onDismiss = actions::onDismissSaveFeedback
        )

        Text(
            text = stringResource(R.string.notification_prefs_intro),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
        )

        LazyColumn(
            modifier = Modifier.weight(1f),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(content.items, key = { it.category }) { item ->
                NotificationPreferenceRow(
                    item = item,
                    enabled = content.saveState != NotificationPreferencesSaveState.Saving,
                    onToggle = { enabled -> actions.onToggle(item.category, enabled) }
                )
            }
        }

        NotificationPreferencesSaveBar(
            isDirty = content.isDirty,
            saveState = content.saveState,
            onSave = actions::onSave
        )
    }
}

@Composable
private fun SaveFeedbackBanner(
    saveState: NotificationPreferencesSaveState,
    errorMessage: String?,
    onDismiss: () -> Unit
) {
    when (saveState) {
        NotificationPreferencesSaveState.Saving -> {
            FeedbackCard(
                containerColor = MaterialTheme.colorScheme.surfaceVariant,
                content = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        Text(text = stringResource(R.string.notification_prefs_saving), style = MaterialTheme.typography.bodyMedium)
                    }
                }
            )
        }

        NotificationPreferencesSaveState.Saved -> {
            FeedbackCard(
                containerColor = MaterialTheme.colorScheme.primaryContainer,
                content = {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = stringResource(R.string.notification_prefs_saved),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onPrimaryContainer
                        )
                        TextButton(onClick = onDismiss) {
                            Text(text = "إغلاق")
                        }
                    }
                }
            )
        }

        NotificationPreferencesSaveState.Failed -> {
            FeedbackCard(
                containerColor = MaterialTheme.colorScheme.errorContainer,
                content = {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        Text(
                            text = errorMessage ?: stringResource(R.string.notification_prefs_save_failed),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onErrorContainer
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        TextButton(onClick = onDismiss) {
                            Text(text = "إغلاق")
                        }
                    }
                }
            )
        }

        NotificationPreferencesSaveState.Idle -> Unit
    }
}

@Composable
private fun FeedbackCard(
    containerColor: androidx.compose.ui.graphics.Color,
    content: @Composable () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        colors = CardDefaults.cardColors(containerColor = containerColor)
    ) {
        Box(modifier = Modifier.padding(12.dp)) {
            content()
        }
    }
}

@Composable
private fun NotificationPreferenceRow(
    item: NotificationPreferenceItem,
    enabled: Boolean,
    onToggle: (Boolean) -> Unit
) {
    val rowDescription = buildString {
        append(notificationCategoryLabel(item.category))
        append(if (item.inAppEnabled) "، مفعّل" else "، متوقف")
        if (item.mandatory) append("، إلزامي")
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .semantics { contentDescription = rowDescription },
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = Icons.Filled.NotificationsActive,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(22.dp)
            )
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 12.dp)
            ) {
                Text(
                    text = notificationCategoryLabel(item.category),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Medium
                )
                Text(
                    text = if (item.mandatory) {
                        stringResource(R.string.notification_prefs_mandatory_hint)
                    } else {
                        stringResource(R.string.notification_prefs_in_app)
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Switch(
                checked = item.inAppEnabled,
                onCheckedChange = onToggle,
                enabled = enabled && !item.mandatory
            )
        }
    }
}

@Composable
private fun NotificationPreferencesSaveBar(
    isDirty: Boolean,
    saveState: NotificationPreferencesSaveState,
    onSave: () -> Unit
) {
    val isSaving = saveState == NotificationPreferencesSaveState.Saving
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(16.dp)
    ) {
        Button(
            onClick = onSave,
            enabled = isDirty && !isSaving,
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
        ) {
            if (isSaving) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary
                )
                Spacer(modifier = Modifier.size(8.dp))
                Text(text = stringResource(R.string.notification_prefs_saving_cta))
            } else {
                Text(text = stringResource(R.string.notification_prefs_save_cta))
            }
        }
    }
}

fun notificationCategoryLabel(category: String): String = when (category.lowercase()) {
    "general" -> "عام"
    "security" -> "الأمان"
    "workflow" -> "سير العمل"
    "leave" -> "الإجازات"
    "task" -> "المهام"
    "attendance" -> "الحضور"
    "payroll" -> "الرواتب"
    "chat" -> "المحادثات"
    else -> category
}
