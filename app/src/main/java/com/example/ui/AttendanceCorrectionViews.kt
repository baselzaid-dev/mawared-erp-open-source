package com.example.ui

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.EditCalendar
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.core.permissions.Permissions
import com.example.domain.model.AttendanceCorrection
import com.example.domain.model.AttendanceCorrectionStatus
import com.example.ui.ux.MawaredEmptyState
import com.example.ui.ux.MawaredErrorState
import com.example.ui.ux.MawaredLoadingState
import com.example.ui.ux.MawaredTextField
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

private fun correctionStatusLabel(status: AttendanceCorrectionStatus): String = when (status) {
    AttendanceCorrectionStatus.PENDING -> "قيد المراجعة"
    AttendanceCorrectionStatus.APPROVED -> "مقبول"
    AttendanceCorrectionStatus.REJECTED -> "مرفوض"
    AttendanceCorrectionStatus.CANCELLED -> "ملغى"
}

private fun formatCorrectionTimestamp(raw: String?): String {
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
fun AttendanceCorrectionListScreen(
    state: AttendanceCorrectionUiState,
    feedback: AttendanceCorrectionFeedback,
    actions: AttendanceCorrectionActions,
    permissions: Set<String>,
    currentUserId: String?,
    modifier: Modifier = Modifier,
    onOpenSubmit: ((attendanceId: String, expectedVersion: Int) -> Unit)? = null
) {
    val snackbarHostState = remember { SnackbarHostState() }
    var reviewTarget by remember { mutableStateOf<AttendanceCorrection?>(null) }

    LaunchedEffect(feedback.successMessage, feedback.errorMessage) {
        val message = feedback.successMessage ?: feedback.errorMessage
        if (!message.isNullOrBlank()) {
            snackbarHostState.showSnackbar(message)
            actions.onDismissFeedback()
        }
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Filled.EditCalendar,
                            contentDescription = null,
                            modifier = Modifier.size(22.dp)
                        )
                        Spacer(modifier = Modifier.size(8.dp))
                        Text("تصحيحات الحضور")
                    }
                },
                actions = {
                    IconButton(onClick = actions::onRetry) {
                        Icon(Icons.Filled.Refresh, contentDescription = "تحديث")
                    }
                }
            )
        }
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            when (state) {
                AttendanceCorrectionUiState.Loading -> {
                    MawaredLoadingState(
                        modifier = Modifier.align(Alignment.Center),
                        message = "جاري تحميل طلبات التصحيح..."
                    )
                }

                is AttendanceCorrectionUiState.Error -> {
                    MawaredErrorState(
                        modifier = Modifier.align(Alignment.Center),
                        message = state.message,
                        retryLabel = "إعادة المحاولة",
                        onRetry = actions::onRetry
                    )
                }

                AttendanceCorrectionUiState.Empty -> {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        MawaredEmptyState(
                            title = "لا توجد طلبات تصحيح",
                            detail = "عند إرسال طلب تصحيح لسجل حضور سيظهر هنا."
                        )
                    }
                }

                is AttendanceCorrectionUiState.Content -> {
                    Column(modifier = Modifier.fillMaxSize()) {
                        AttendanceCorrectionStatusFilters(
                            selected = state.selectedStatus,
                            onSelected = actions::onStatusSelected
                        )
                        if (state.items.isEmpty()) {
                            MawaredEmptyState(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 32.dp, start = 16.dp, end = 16.dp),
                                title = "لا توجد طلبات في هذا التصفية",
                                detail = "جرّب تصفية أخرى أو حدّث القائمة."
                            )
                        } else {
                            LazyColumn(
                                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                items(state.items, key = { it.id }) { item ->
                                    AttendanceCorrectionRow(
                                        item = item,
                                        canDecide = AttendanceCorrectionRules.canDecide(
                                            item,
                                            currentUserId,
                                            permissions
                                        ),
                                        isActionInProgress = state.actionCorrectionId == item.id,
                                        onClick = { actions.onCorrectionClick(item.id) },
                                        onReview = { reviewTarget = item }
                                    )
                                }
                                if (state.hasMore) {
                                    item(key = "load-more") {
                                        Box(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .padding(vertical = 8.dp),
                                            contentAlignment = Alignment.Center
                                        ) {
                                            if (state.isLoadingMore) {
                                                MawaredLoadingState(message = "تحميل المزيد...")
                                            } else {
                                                TextButton(onClick = actions::onLoadMore) {
                                                    Text("تحميل المزيد")
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    reviewTarget?.let { target ->
        AttendanceCorrectionReviewDialog(
            correction = target,
            onDismiss = { reviewTarget = null },
            onAccept = { reason ->
                actions.onAccept(target.id, target.version, reason)
                reviewTarget = null
            },
            onReject = { reason ->
                actions.onReject(target.id, target.version, reason)
                reviewTarget = null
            }
        )
    }
}

@Composable
fun AttendanceCorrectionSubmitDialog(
    attendanceId: String,
    expectedAttendanceVersion: Int,
    onDismiss: () -> Unit,
    onSubmit: (clockIn: String?, clockOut: String?, reason: String) -> Unit
) {
    var clockIn by remember { mutableStateOf("") }
    var clockOut by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("طلب تصحيح حضور") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "سجل الحضور: $attendanceId",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                MawaredTextField(
                    value = clockIn,
                    onValueChange = { clockIn = it },
                    label = "وقت الحضور (ISO)",
                    supportingText = "مثال: 2026-07-19T08:00:00.000Z"
                )
                MawaredTextField(
                    value = clockOut,
                    onValueChange = { clockOut = it },
                    label = "وقت الانصراف (ISO)",
                    supportingText = "مثال: 2026-07-19T17:00:00.000Z"
                )
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("سبب التصحيح") },
                    supportingText = { Text("3 أحرف على الأقل") },
                    minLines = 2,
                    maxLines = 4
                )
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    onSubmit(
                        clockIn.trim().takeIf { it.isNotEmpty() },
                        clockOut.trim().takeIf { it.isNotEmpty() },
                        reason
                    )
                }
            ) {
                Text("إرسال للمراجعة")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("إلغاء")
            }
        }
    )
}

@Composable
private fun AttendanceCorrectionReviewDialog(
    correction: AttendanceCorrection,
    onDismiss: () -> Unit,
    onAccept: (String) -> Unit,
    onReject: (String) -> Unit
) {
    var reason by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("مراجعة طلب التصحيح") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("سبب الموظف: ${correction.reason}")
                correction.requestedClockIn?.let {
                    Text("الحضور المطلوب: ${formatCorrectionTimestamp(it)}")
                }
                correction.requestedClockOut?.let {
                    Text("الانصراف المطلوب: ${formatCorrectionTimestamp(it)}")
                }
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("سبب القرار") },
                    minLines = 2
                )
            }
        },
        confirmButton = {
            Button(onClick = { onAccept(reason) }) {
                Text("قبول")
            }
        },
        dismissButton = {
            OutlinedButton(onClick = { onReject(reason) }) {
                Text("رفض")
            }
        }
    )
}

@Composable
private fun AttendanceCorrectionStatusFilters(
    selected: AttendanceCorrectionStatus?,
    onSelected: (AttendanceCorrectionStatus?) -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        FilterChip(
            selected = selected == null,
            onClick = { onSelected(null) },
            label = { Text("الكل") }
        )
        AttendanceCorrectionStatus.entries.forEach { status ->
            FilterChip(
                selected = selected == status,
                onClick = { onSelected(status) },
                label = { Text(correctionStatusLabel(status)) }
            )
        }
    }
}

@Composable
private fun AttendanceCorrectionRow(
    item: AttendanceCorrection,
    canDecide: Boolean,
    isActionInProgress: Boolean,
    onClick: () -> Unit,
    onReview: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = correctionStatusLabel(item.status),
                    fontWeight = FontWeight.Bold,
                    color = when (item.status) {
                        AttendanceCorrectionStatus.PENDING -> MaterialTheme.colorScheme.primary
                        AttendanceCorrectionStatus.APPROVED -> MaterialTheme.colorScheme.tertiary
                        AttendanceCorrectionStatus.REJECTED -> MaterialTheme.colorScheme.error
                        AttendanceCorrectionStatus.CANCELLED -> MaterialTheme.colorScheme.outline
                    }
                )
                Text(
                    text = formatCorrectionTimestamp(item.createdAt),
                    style = MaterialTheme.typography.bodySmall
                )
            }
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = item.reason,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyMedium
            )
            Spacer(modifier = Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                item.requestedClockIn?.let {
                    Text("حضور: ${formatCorrectionTimestamp(it)}", style = MaterialTheme.typography.bodySmall)
                }
                item.requestedClockOut?.let {
                    Text("انصراف: ${formatCorrectionTimestamp(it)}", style = MaterialTheme.typography.bodySmall)
                }
            }
            item.decisionReason?.let {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "قرار المراجع: $it",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (canDecide && item.status == AttendanceCorrectionStatus.PENDING) {
                Spacer(modifier = Modifier.height(8.dp))
                Button(
                    onClick = onReview,
                    enabled = !isActionInProgress,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(if (isActionInProgress) "جاري المعالجة..." else "مراجعة الطلب")
                }
            }
        }
    }
}

/** Convenience wrapper when coordinator wires controller into MawaredViewModel later. */
@Composable
fun AttendanceCorrectionManager(
    controller: AttendanceCorrectionController,
    permissions: Set<String>,
    currentUserId: String?,
    onOpenSubmit: ((attendanceId: String, expectedVersion: Int) -> Unit)? = null
) {
    val state by controller.state.collectAsStateWithLifecycle()
    val feedback by controller.feedback.collectAsStateWithLifecycle()
    AttendanceCorrectionListScreen(
        state = state,
        feedback = feedback,
        actions = controller,
        permissions = permissions,
        currentUserId = currentUserId,
        onOpenSubmit = onOpenSubmit
    )
}

/** Permission hint for coordinator menu wiring. */
fun attendanceCorrectionMenuVisible(permissions: Set<String>): Boolean =
    permissions.contains(Permissions.ATTENDANCE_REVIEW_CORRECTION) ||
        permissions.contains(Permissions.ATTENDANCE_MANAGE_MANUAL) ||
        permissions.contains(Permissions.ATTENDANCE_VIEW_OWN) ||
        permissions.contains(Permissions.ATTENDANCE_CLOCK)
