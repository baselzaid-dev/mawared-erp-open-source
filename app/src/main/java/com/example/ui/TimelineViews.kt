package com.example.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.History
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.domain.model.TimelineEvent
import com.example.domain.model.TimelineKind
import com.example.domain.model.TimelineRules
import com.example.ui.ux.MawaredErrorState
import com.example.ui.ux.MawaredLoadingState
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Root-hosted timeline dialog. Rendered once (MawaredViews) and driven by
 * TimelineController — screens only call openTimeline(kind, id, title).
 */
@Composable
fun TimelineDialogHost(
    state: TimelineUiState,
    onDismiss: () -> Unit,
    onRetry: () -> Unit
) {
    if (state is TimelineUiState.Hidden) return
    val kind = when (state) {
        is TimelineUiState.Loading -> state.kind
        is TimelineUiState.Content -> state.kind
        is TimelineUiState.Error -> state.kind
        TimelineUiState.Hidden -> return
    }
    val title = stringResource(timelineTitle(kind))
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.timeline_close))
            }
        },
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = Icons.Filled.History,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp)
                )
                Spacer(modifier = Modifier.size(8.dp))
                Text(text = title, fontWeight = FontWeight.Bold)
            }
        },
        text = {
            when (state) {
                is TimelineUiState.Loading -> MawaredLoadingState(
                    message = stringResource(R.string.timeline_loading)
                )

                is TimelineUiState.Error -> MawaredErrorState(
                    message = timelineErrorText(state.reason),
                    retryLabel = stringResource(R.string.ux_retry),
                    onRetry = onRetry
                )

                is TimelineUiState.Content -> {
                    if (state.events.isEmpty()) {
                        Text(stringResource(R.string.timeline_empty))
                    } else {
                        LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                            itemsIndexed(
                                state.events,
                                key = { index, event -> "$index-${event.type}-${event.at}" }
                            ) { _, event ->
                                TimelineEventRow(event)
                            }
                        }
                    }
                }

                TimelineUiState.Hidden -> Unit
            }
        }
    )
}

@Composable
private fun TimelineEventRow(event: TimelineEvent) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = timelineEventLabel(event),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f)
            )
            if (event.override) {
                Text(
                    text = stringResource(R.string.timeline_override_badge),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error
                )
            }
        }
        Text(
            text = formatTimelineDate(event),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        event.actorName?.let { actor ->
            val role = event.actorRole?.takeIf { it.isNotBlank() }
            Text(
                text = if (role != null) "$actor — $role" else actor,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        if (event.fromStatus != null || event.toStatus != null) {
            val fromStatus = event.fromStatus?.let { stringResource(globalStatusLabel(it)) }
            val toStatus = event.toStatus?.let { stringResource(globalStatusLabel(it)) }
            Text(
                text = when {
                    fromStatus != null && toStatus != null ->
                        stringResource(R.string.timeline_transition, fromStatus, toStatus)
                    toStatus != null -> stringResource(R.string.timeline_transition_to, toStatus)
                    else -> stringResource(R.string.timeline_transition_from, fromStatus.orEmpty())
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary
            )
        }
        event.reason?.takeIf { it.isNotBlank() }?.let { reason ->
            Text(
                text = stringResource(R.string.timeline_reason_prefix, reason),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

internal fun formatTimelineDate(event: TimelineEvent, locale: Locale = Locale.getDefault()): String {
    val iso = event.at
    if (TimelineRules.isDateOnly(event)) {
        val date = runCatching {
            SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }.parse(iso.take(10))
        }.getOrNull() ?: return iso.take(10)
        return DateFormat.getDateInstance(DateFormat.MEDIUM, locale).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(date)
    }
    val utcPatterns = listOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ss'Z'"
    )
    val parsed = utcPatterns.firstNotNullOfOrNull { pattern ->
        runCatching {
            SimpleDateFormat(pattern, Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }.parse(iso)
        }.getOrNull()
    } ?: return iso
    return DateFormat.getDateTimeInstance(
        DateFormat.MEDIUM,
        DateFormat.SHORT,
        locale
    ).format(parsed)
}

@Composable
private fun timelineErrorText(reason: TimelineErrorKind): String = stringResource(
    when (reason) {
        TimelineErrorKind.Unavailable -> R.string.timeline_error_unavailable
        TimelineErrorKind.Failed -> R.string.timeline_error_failed
        TimelineErrorKind.Connection -> R.string.timeline_error_connection
    }
)

@StringRes
private fun timelineTitle(kind: TimelineKind): Int = when (kind) {
    TimelineKind.LEAVE -> R.string.timeline_title_leave
    TimelineKind.PURCHASE_REQUEST -> R.string.timeline_title_purchase
    TimelineKind.EMPLOYEE -> R.string.timeline_title_employee
    TimelineKind.TRAINING_ASSIGNMENT -> R.string.timeline_title_training
}

@Composable
private fun timelineEventLabel(event: TimelineEvent): String {
    val resource = timelineEventLabelResource(event.type)
    return if (resource == null) event.summary else stringResource(resource)
}

@StringRes
private fun timelineEventLabelResource(type: String): Int? = when (type) {
    "leave.submitted" -> R.string.timeline_event_leave_submitted
    "leave.hr_approve" -> R.string.timeline_event_leave_hr_approve
    "leave.hr_reject" -> R.string.timeline_event_leave_hr_reject
    "leave.admin_approve" -> R.string.timeline_event_leave_admin_approve
    "leave.admin_reject" -> R.string.timeline_event_leave_admin_reject
    "leave.escalate" -> R.string.timeline_event_leave_escalate
    "leave.override_approve", "purchase_request.override_approve" ->
        R.string.timeline_event_override_approve
    "leave.override_reject", "purchase_request.override_reject" ->
        R.string.timeline_event_override_reject
    "leave.override_cancel", "purchase_request.override_cancel" ->
        R.string.timeline_event_override_cancel
    "purchase_request.created" -> R.string.timeline_event_purchase_created
    "purchase_request.department_reviewed" -> R.string.timeline_event_purchase_department_reviewed
    "purchase_request.purchasing_reviewed" -> R.string.timeline_event_purchase_reviewed
    "purchase_request.rejected" -> R.string.timeline_event_purchase_rejected
    "purchase_request.cancelled" -> R.string.timeline_event_purchase_cancelled
    "employee.created" -> R.string.timeline_event_employee_created
    "employee.joined" -> R.string.timeline_event_employee_joined
    "employee.archived" -> R.string.timeline_event_employee_archived
    "employee.reactivated" -> R.string.timeline_event_employee_reactivated
    "assignment.assigned" -> R.string.timeline_event_assignment_assigned
    "assignment.started" -> R.string.timeline_event_assignment_started
    "assignment.submitted" -> R.string.timeline_event_assignment_submitted
    "assignment.reviewed" -> R.string.timeline_event_assignment_reviewed
    "assignment.returned" -> R.string.timeline_event_assignment_returned
    "assignment.completed" -> R.string.timeline_event_assignment_completed
    "assignment.cancelled" -> R.string.timeline_event_assignment_cancelled
    else -> null
}
