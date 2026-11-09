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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.EventNote
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Work
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.domain.model.MyWorkCategory
import com.example.domain.model.MyWorkItem
import com.example.ui.ux.MawaredEmptyState
import com.example.ui.ux.MawaredErrorState
import com.example.ui.ux.MawaredLoadingState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MyWorkScreen(
    state: MyWorkUiState,
    actions: MyWorkActions,
    modifier: Modifier = Modifier
) {
    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Filled.Work,
                            contentDescription = null,
                            modifier = Modifier.size(22.dp)
                        )
                        Spacer(modifier = Modifier.size(8.dp))
                        Text(text = stringResource(R.string.my_work_title), fontWeight = FontWeight.Bold)
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
                MyWorkUiState.Loading -> {
                    MawaredLoadingState(
                        modifier = Modifier.align(Alignment.Center),
                        message = stringResource(R.string.my_work_loading)
                    )
                }

                is MyWorkUiState.Error -> {
                    MawaredErrorState(
                        modifier = Modifier.align(Alignment.Center),
                        message = state.message,
                        retryLabel = stringResource(R.string.ux_retry),
                        onRetry = actions::onRetry
                    )
                }

                MyWorkUiState.Empty -> {
                    MawaredEmptyState(
                        modifier = Modifier.align(Alignment.Center),
                        title = stringResource(R.string.my_work_empty_title),
                        detail = stringResource(R.string.my_work_empty_detail)
                    )
                }

                is MyWorkUiState.Content -> {
                    Column(modifier = Modifier.fillMaxSize()) {
                        MyWorkCategoryFilters(
                            selectedCategory = state.selectedCategory,
                            onCategorySelected = actions::onCategorySelected
                        )
                        if (state.items.isEmpty()) {
                            MawaredEmptyState(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 32.dp),
                                title = stringResource(R.string.my_work_empty_category_title),
                                detail = stringResource(R.string.my_work_empty_category_detail)
                            )
                        } else {
                            LazyColumn(
                                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                items(state.items, key = { it.id }) { item ->
                                    MyWorkRow(
                                        item = item,
                                        onClick = { actions.onItemClick(item) }
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

@Composable
private fun MyWorkCategoryFilters(
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
        MyWorkCategory.entries.forEach { category ->
            FilterChip(
                selected = selectedCategory == category.key,
                onClick = { onCategorySelected(category.key) },
                label = { Text(stringResource(category.labelRes)) }
            )
        }
    }
}

@Composable
private fun MyWorkRow(
    item: MyWorkItem,
    onClick: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = categoryIcon(item.category),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(24.dp)
            )
            Spacer(modifier = Modifier.size(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = item.title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    text = item.subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

private fun categoryIcon(category: MyWorkCategory): ImageVector = when (category) {
    MyWorkCategory.LEAVES -> Icons.Filled.EventNote
    MyWorkCategory.TASKS -> Icons.Filled.Assignment
    MyWorkCategory.ATTENDANCE -> Icons.Filled.Schedule
}
