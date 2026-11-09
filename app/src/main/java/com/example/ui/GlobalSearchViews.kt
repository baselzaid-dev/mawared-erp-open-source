package com.example.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.domain.model.GlobalSearchResult
import com.example.domain.model.GlobalSearchRules
import com.example.ui.ux.MawaredEmptyState
import com.example.ui.ux.MawaredErrorState
import com.example.ui.ux.MawaredLoadingState
import com.example.ui.ux.MawaredStatusChip

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GlobalSearchScreen(
    state: GlobalSearchUiState,
    actions: GlobalSearchActions,
    onResultClick: (GlobalSearchResult) -> Unit,
    modifier: Modifier = Modifier
) {
    var query by rememberSaveable { mutableStateOf("") }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Filled.Search,
                            contentDescription = null,
                            modifier = Modifier.size(22.dp)
                        )
                        Spacer(modifier = Modifier.size(8.dp))
                        Text(
                            text = stringResource(R.string.global_search_title),
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            OutlinedTextField(
                value = query,
                onValueChange = {
                    query = it
                    actions.onQueryChanged(it)
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                singleLine = true,
                placeholder = { Text(stringResource(R.string.global_search_hint)) },
                trailingIcon = {
                    IconButton(
                        onClick = actions::onSearch,
                        enabled = GlobalSearchRules.isQuerySearchable(query)
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Search,
                            contentDescription = stringResource(R.string.global_search_action)
                        )
                    }
                }
            )

            Box(modifier = Modifier.fillMaxSize()) {
                when (state) {
                    is GlobalSearchUiState.Idle -> MawaredEmptyState(
                        modifier = Modifier.align(Alignment.Center),
                        title = stringResource(R.string.global_search_idle_title),
                        detail = stringResource(R.string.global_search_idle_detail)
                    )

                    is GlobalSearchUiState.Loading -> MawaredLoadingState(
                        modifier = Modifier.align(Alignment.Center),
                        message = stringResource(R.string.global_search_loading)
                    )

                    is GlobalSearchUiState.Empty -> MawaredEmptyState(
                        modifier = Modifier.align(Alignment.Center),
                        title = stringResource(R.string.global_search_empty_title),
                        detail = stringResource(R.string.global_search_empty_detail)
                    )

                    is GlobalSearchUiState.Error -> MawaredErrorState(
                        modifier = Modifier.align(Alignment.Center),
                        message = globalSearchErrorText(state.kind),
                        retryLabel = stringResource(R.string.ux_retry),
                        onRetry = actions::onRetry
                    )

                    is GlobalSearchUiState.Content -> GlobalSearchResultList(
                        state = state,
                        actions = actions,
                        onResultClick = onResultClick
                    )
                }
            }
        }
    }
}

@Composable
private fun GlobalSearchResultList(
    state: GlobalSearchUiState.Content,
    actions: GlobalSearchActions,
    onResultClick: (GlobalSearchResult) -> Unit
) {
    val grouped = state.items.groupBy { it.type }
    LazyColumn(
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        grouped.forEach { (type, results) ->
            item(key = "header-$type") {
                Text(
                    text = stringResource(globalSearchTypeLabel(type)),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(top = 8.dp)
                )
            }
            items(results, key = { "${it.type}-${it.id}" }) { result ->
                GlobalSearchResultRow(result = result, onClick = { onResultClick(result) })
            }
        }
        if (state.nextCursor != null) {
            item(key = "load-more") {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 8.dp),
                    contentAlignment = Alignment.Center
                ) {
                    if (state.isLoadingMore) {
                        CircularProgressIndicator(modifier = Modifier.size(28.dp))
                    } else if (state.paginationError != null) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                text = stringResource(R.string.global_search_pagination_error),
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall
                            )
                            TextButton(onClick = actions::onLoadMore) {
                                Text(stringResource(R.string.ux_retry))
                            }
                        }
                    } else {
                        TextButton(onClick = actions::onLoadMore) {
                            Text(stringResource(R.string.global_search_load_more))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GlobalSearchResultRow(
    result: GlobalSearchResult,
    onClick: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp)
        ) {
            Text(
                text = result.title,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            if (!result.subtitle.isNullOrBlank()) {
                Text(
                    text = result.subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
            result.status?.takeIf { it.isNotBlank() }?.let { status ->
                Spacer(modifier = Modifier.size(8.dp))
                MawaredStatusChip(label = stringResource(globalStatusLabel(status)))
            }
        }
    }
}

@Composable
private fun globalSearchErrorText(kind: GlobalSearchErrorKind): String = stringResource(
    when (kind) {
        GlobalSearchErrorKind.QueryLength -> R.string.global_search_error_query_length
        GlobalSearchErrorKind.InvalidRequest -> R.string.global_search_error_invalid
        GlobalSearchErrorKind.Failed -> R.string.global_search_error_failed
        GlobalSearchErrorKind.Connection -> R.string.global_search_error_connection
    }
)

@StringRes
private fun globalSearchTypeLabel(type: String): Int = when (type) {
    "employee" -> R.string.global_search_section_employees
    "vendor" -> R.string.global_search_section_vendors
    "purchase_request" -> R.string.global_search_section_purchase_requests
    "training_course" -> R.string.global_search_section_training
    "task" -> R.string.global_search_section_tasks
    "chat_conversation" -> R.string.global_search_section_chat
    else -> R.string.global_search_section_other
}

@StringRes
internal fun globalStatusLabel(status: String): Int = when (status.lowercase()) {
    "active" -> R.string.status_active
    "inactive" -> R.string.status_inactive
    "archived" -> R.string.status_archived
    "pending_department" -> R.string.status_pending_department
    "pending_purchasing" -> R.string.status_pending_purchasing
    "pending_hr" -> R.string.status_pending_hr
    "pending_admin" -> R.string.status_pending_admin
    "approved" -> R.string.status_approved
    "rejected" -> R.string.status_rejected
    "cancelled" -> R.string.status_cancelled
    "published" -> R.string.status_published
    "draft" -> R.string.status_draft
    "assigned" -> R.string.status_assigned
    "in_progress" -> R.string.status_in_progress
    "submitted" -> R.string.status_submitted
    "completed" -> R.string.status_completed
    "returned" -> R.string.status_returned
    else -> R.string.status_unknown
}
