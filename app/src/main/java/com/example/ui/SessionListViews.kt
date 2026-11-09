package com.example.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DevicesOther
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.domain.model.SessionSummary
import com.example.ui.ux.MawaredEmptyState
import com.example.ui.ux.MawaredErrorState
import com.example.ui.ux.MawaredLoadingState
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

private fun sessionDeviceLabel(session: SessionSummary): String = when {
    session.isCurrent -> session.deviceLabel ?: "هذا الجهاز"
    session.isLegacyDevice -> "جهاز قديم"
    !session.deviceLabel.isNullOrBlank() -> session.deviceLabel
    !session.platform.isNullOrBlank() -> session.platform
    else -> "جهاز غير معروف"
}

private fun formatSessionTimestamp(raw: String?): String {
    if (raw.isNullOrBlank()) return "—"
    return runCatching {
        val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }
        val display = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale("ar"))
        val normalized = raw.replace("Z", "+00:00").substringBefore("+")
        parser.parse(normalized)?.let { display.format(it) } ?: raw
    }.getOrDefault(raw)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionListScreen(
    state: SessionListUiState,
    feedback: SessionListFeedback,
    actions: SessionListActions,
    modifier: Modifier = Modifier
) {
    val snackbarHostState = remember { SnackbarHostState() }
    var confirmRevokeAll by remember { mutableStateOf(false) }
    var revokeTarget by remember { mutableStateOf<SessionSummary?>(null) }

    LaunchedEffect(feedback.successMessage, feedback.errorMessage) {
        val message = feedback.successMessage ?: feedback.errorMessage
        if (!message.isNullOrBlank()) {
            snackbarHostState.showSnackbar(message)
            actions.onDismissFeedback()
        }
    }

    if (confirmRevokeAll) {
        AlertDialog(
            onDismissRequest = { confirmRevokeAll = false },
            title = { Text("إنهاء جميع الجلسات الأخرى") },
            text = {
                Text("سيتم تسجيل خروج جميع الأجهزة الأخرى المرتبطة بحسابك. الجلسة الحالية ستبقى نشطة.")
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmRevokeAll = false
                        actions.onRevokeAllOthers()
                    }
                ) {
                    Text("تأكيد")
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmRevokeAll = false }) {
                    Text("إلغاء")
                }
            }
        )
    }

    revokeTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { revokeTarget = null },
            title = { Text("إنهاء الجلسة") },
            text = { Text("هل تريد إنهاء جلسة ${sessionDeviceLabel(target)}؟") },
            confirmButton = {
                TextButton(
                    onClick = {
                        actions.onRevokeSession(target.sessionId)
                        revokeTarget = null
                    }
                ) {
                    Text("إنهاء")
                }
            },
            dismissButton = {
                TextButton(onClick = { revokeTarget = null }) {
                    Text("إلغاء")
                }
            }
        )
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Filled.DevicesOther,
                            contentDescription = null,
                            modifier = Modifier.size(22.dp)
                        )
                        Spacer(modifier = Modifier.size(8.dp))
                        Text("جلسات تسجيل الدخول")
                    }
                },
                actions = {
                    IconButton(onClick = actions::onRetry) {
                        Icon(Icons.Filled.Refresh, contentDescription = "تحديث")
                    }
                }
            )
        }
    ) { padding ->
        when (state) {
            SessionListUiState.Loading -> MawaredLoadingState(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            )
            SessionListUiState.Empty -> MawaredEmptyState(
                title = "لا توجد جلسات",
                detail = "لم يتم العثور على أي جلسات مسجلة.",
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            )
            is SessionListUiState.Error -> MawaredErrorState(
                message = state.message,
                onRetry = actions::onRetry,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            )
            is SessionListUiState.Content -> SessionListContent(
                state = state,
                padding = padding,
                onRevokeClick = { revokeTarget = it },
                onRevokeAllClick = { confirmRevokeAll = true }
            )
        }
    }
}

@Composable
private fun SessionListContent(
    state: SessionListUiState.Content,
    padding: PaddingValues,
    onRevokeClick: (SessionSummary) -> Unit,
    onRevokeAllClick: () -> Unit
) {
    val otherActiveCount = state.sessions.count { it.isActive && !it.isCurrent }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(padding),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        if (otherActiveCount > 0) {
            item {
                OutlinedButton(
                    onClick = onRevokeAllClick,
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !state.isRevokingAll
                ) {
                    Text(
                        if (state.isRevokingAll) {
                            "جاري إنهاء الجلسات..."
                        } else {
                            "إنهاء جميع الجلسات الأخرى ($otherActiveCount)"
                        }
                    )
                }
            }
        }

        items(state.sessions, key = { it.sessionId }) { session ->
            SessionRowCard(
                session = session,
                isBusy = state.actionSessionId == session.sessionId,
                onRevokeClick = { onRevokeClick(session) }
            )
        }
    }
}

@Composable
private fun SessionRowCard(
    session: SessionSummary,
    isBusy: Boolean,
    onRevokeClick: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (session.isCurrent) {
                MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.35f)
            } else {
                MaterialTheme.colorScheme.surface
            }
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(
                        imageVector = if (session.isCurrent) {
                            Icons.Filled.PhoneAndroid
                        } else {
                            Icons.Filled.DevicesOther
                        },
                        contentDescription = null,
                        modifier = Modifier.size(20.dp)
                    )
                    Spacer(modifier = Modifier.size(8.dp))
                    Column {
                        Text(
                            text = sessionDeviceLabel(session),
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        if (session.isCurrent) {
                            Text(
                                text = "الجلسة الحالية",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                    }
                }
                Text(
                    text = if (session.isActive) "نشطة" else "منتهية",
                    style = MaterialTheme.typography.labelMedium,
                    color = if (session.isActive) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.outline
                    }
                )
            }
            Text(
                text = "آخر استخدام: ${formatSessionTimestamp(session.lastUsedAt ?: session.createdAt)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (session.isActive && !session.isCurrent) {
                Button(
                    onClick = onRevokeClick,
                    enabled = !isBusy,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(if (isBusy) "جاري الإنهاء..." else "إنهاء الجلسة")
                }
            }
        }
    }
}
