package com.example.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.example.R
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.domain.model.ReportCatalogItem
import com.example.domain.model.ReportDetailParams
import com.example.domain.model.ReportOverview
import com.example.ui.ux.MawaredEmptyState
import com.example.ui.ux.MawaredErrorState
import com.example.ui.ux.MawaredLoadingState
import com.example.ui.theme.AmberStatus
import com.example.ui.theme.EmeraldMain
import com.example.ui.theme.SlateDark
import com.example.ui.theme.SlateLight
import com.example.ui.theme.SlateMedium
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UnifiedReportsCenter(viewModel: MawaredViewModel) {
    val state by viewModel.reportsUiState.collectAsState()
    val employeesState by viewModel.employeesUiState.collectAsState()
    val context = LocalContext.current
    val shareCsvChooser = stringResource(R.string.reports_share_csv_chooser)
    val shareFailedMessage = stringResource(R.string.reports_share_failed)
    val selectedItem = state.catalog.firstOrNull { it.type == state.selectedReportType }
    var showFromPicker by remember { mutableStateOf(false) }
    var showToPicker by remember { mutableStateOf(false) }
    var departmentMenu by remember { mutableStateOf(false) }
    var statusMenu by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        if (state.catalog.isEmpty() && !state.isLoading) viewModel.refreshReports()
    }

    LaunchedEffect(state.pendingShare?.uri) {
        val share = state.pendingShare ?: return@LaunchedEffect
        try {
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = share.mimeType
                putExtra(Intent.EXTRA_STREAM, share.uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(Intent.createChooser(intent, shareCsvChooser))
        } catch (_: Exception) {
            viewModel.showNotification(shareFailedMessage)
        } finally {
            viewModel.consumeReportShare()
        }
    }

    if (!state.canViewReports) {
        Box(
            modifier = Modifier.fillMaxSize().padding(24.dp),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Default.Lock, contentDescription = null, tint = SlateLight)
                Text(
                    stringResource(R.string.reports_no_permission),
                    modifier = Modifier.padding(top = 12.dp),
                    textAlign = TextAlign.Center,
                    color = SlateLight
                )
            }
        }
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        stringResource(R.string.reports_title),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = if (viewModel.isDarkTheme) androidx.compose.ui.graphics.Color.White else SlateDark
                    )
                    selectedItem?.let {
                        Text(it.description, color = SlateLight, fontSize = 11.sp)
                    }
                }
                IconButton(onClick = viewModel::refreshReportPreview) {
                    Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.ux_refresh), tint = EmeraldMain)
                }
            }
        }

        item {
            ReportTemplatesSection(viewModel)
        }

        if (state.catalog.isNotEmpty()) {
            item {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(state.catalog, key = { it.type }) { report ->
                        FilterChip(
                            selected = report.type == state.selectedReportType,
                            onClick = { viewModel.selectReportType(report.type) },
                            label = { Text(report.title, fontSize = 11.sp) }
                        )
                    }
                }
            }
        }

        if (selectedItem?.supportedFilters?.contains("from") == true) {
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    OutlinedButton(
                        onClick = { showFromPicker = true },
                        modifier = Modifier.weight(1f)
                    ) {
                        Icon(Icons.Default.CalendarMonth, contentDescription = null)
                        Text(state.fromDate, modifier = Modifier.padding(start = 6.dp), fontSize = 11.sp)
                    }
                    OutlinedButton(
                        onClick = { showToPicker = true },
                        modifier = Modifier.weight(1f)
                    ) {
                        Icon(Icons.Default.CalendarMonth, contentDescription = null)
                        Text(state.toDate, modifier = Modifier.padding(start = 6.dp), fontSize = 11.sp)
                    }
                }
            }
        }

        if (selectedItem != null && selectedItem.availableScopes.contains("department") &&
            employeesState.departments.isNotEmpty()
        ) {
            item {
                Box(modifier = Modifier.fillMaxWidth()) {
                    val selectedDepartment = employeesState.departments
                        .firstOrNull { it.id == state.selectedDepartmentId }
                    OutlinedButton(
                        onClick = { departmentMenu = true },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(selectedDepartment?.name ?: stringResource(R.string.reports_all_departments))
                    }
                    DropdownMenu(
                        expanded = departmentMenu,
                        onDismissRequest = { departmentMenu = false }
                    ) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.reports_all_departments)) },
                            onClick = {
                                departmentMenu = false
                                viewModel.updateReportDepartment(null)
                            }
                        )
                        employeesState.departments.forEach { department ->
                            DropdownMenuItem(
                                text = { Text(department.name) },
                                onClick = {
                                    departmentMenu = false
                                    viewModel.updateReportDepartment(department.id)
                                }
                            )
                        }
                    }
                }
            }
        }

        val statusOptions = reportStatusOptionRes(state.selectedReportType)
        if (statusOptions.isNotEmpty()) {
            item {
                Box(modifier = Modifier.fillMaxWidth()) {
                    val selectedLabel = statusOptions.firstOrNull {
                        it.first == state.selectedStatus
                    }?.let { stringResource(it.second) } ?: stringResource(R.string.reports_all_statuses)
                    OutlinedButton(
                        onClick = { statusMenu = true },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(selectedLabel)
                    }
                    DropdownMenu(
                        expanded = statusMenu,
                        onDismissRequest = { statusMenu = false }
                    ) {
                        statusOptions.forEach { (value, labelRes) ->
                            DropdownMenuItem(
                                text = { Text(stringResource(labelRes)) },
                                onClick = {
                                    statusMenu = false
                                    viewModel.updateReportStatus(value)
                                }
                            )
                        }
                    }
                }
            }
        }

        if (selectedItem?.exportAvailable == true && selectedItem.type != "overview") {
            item {
                Button(
                    onClick = viewModel::exportSelectedReport,
                    enabled = !state.isExporting,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    if (state.isExporting) {
                        CircularProgressIndicator(
                            modifier = Modifier.height(18.dp),
                            strokeWidth = 2.dp
                        )
                    } else {
                        Icon(Icons.Default.Download, contentDescription = null)
                        Text(stringResource(R.string.reports_export_csv), modifier = Modifier.padding(start = 8.dp))
                    }
                }
            }
        }

        state.errorMessage?.takeIf { it.isNotBlank() }?.let { message ->
            item {
                MawaredErrorState(
                    message = message,
                    onRetry = {
                        if (state.catalog.isEmpty() || state.selectedReportType.isBlank()) {
                            viewModel.refreshReports()
                        } else {
                            viewModel.refreshReportPreview()
                        }
                    },
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)
                )
            }
        }

        if (state.isLoading) {
            item {
                MawaredLoadingState(modifier = Modifier.fillMaxWidth().padding(vertical = 32.dp))
            }
        } else if (state.selectedReportType == "overview") {
            state.overview?.let { overview ->
                overviewContent(
                    overview = overview,
                    isDark = viewModel.isDarkTheme,
                    onRetry = viewModel::refreshReportPreview
                )
            }
        } else {
            state.detail?.let { detail -> detailContent(detail, viewModel.isDarkTheme) }
        }

        item { Spacer(modifier = Modifier.height(24.dp)) }
    }

    if (showFromPicker) {
        ReportDatePickerDialog(
            initialDate = state.fromDate,
            onDismiss = { showFromPicker = false },
            onSelect = {
                showFromPicker = false
                viewModel.updateReportDateRange(it, state.toDate)
            }
        )
    }
    if (showToPicker) {
        ReportDatePickerDialog(
            initialDate = state.toDate,
            onDismiss = { showToPicker = false },
            onSelect = {
                showToPicker = false
                viewModel.updateReportDateRange(state.fromDate, it)
            }
        )
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.overviewContent(
    overview: ReportOverview,
    isDark: Boolean,
    onRetry: () -> Unit
) {
    if (overview.sections.isEmpty()) {
        item {
            MawaredEmptyState(
                title = stringResource(R.string.reports_empty_sections_title),
                detail = stringResource(R.string.reports_empty_sections_detail),
                modifier = Modifier.fillMaxWidth()
            )
        }
    } else {
        overview.sections.forEach { (type, section) ->
            item(key = type) {
                ReportSummaryCard(
                    title = section.title,
                    metrics = section.metrics,
                    isDark = isDark,
                    protectedRowsHidden = section.protectedRowsHidden
                )
            }
        }
    }
    if (overview.unavailableSections.isNotEmpty()) {
        item {
            val sectionLabels = overview.unavailableSections.map {
                stringResource(ReportSectionLabelResolver.resolveResId(it))
            }
            Text(
                text = sectionLabels.joinToString(
                    prefix = stringResource(R.string.reports_unavailable_sections_prefix),
                    separator = "، "
                ),
                color = AmberStatus,
                fontSize = 11.sp
            )
        }
    }
    if (overview.warnings.isNotEmpty()) {
        item {
            Column(modifier = Modifier.fillMaxWidth()) {
                overview.warnings.forEach { warning ->
                    Text(warning, color = AmberStatus, fontSize = 11.sp)
                }
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedButton(onClick = onRetry) {
                    Text(stringResource(R.string.ux_retry))
                }
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.detailContent(
    detail: ReportDetailParams,
    isDark: Boolean
) {
    if (detail.summary.isNotEmpty()) {
        item {
            ReportSummaryCard(
                title = stringResource(R.string.reports_summary_title),
                metrics = detail.summary,
                isDark = isDark,
                protectedRowsHidden = detail.protectedRowsHidden
            )
        }
    }
    if (detail.rows.isEmpty()) {
        item {
            MawaredEmptyState(
                title = stringResource(R.string.reports_empty_data_title),
                detail = stringResource(R.string.reports_empty_data_detail),
                modifier = Modifier.fillMaxWidth()
            )
        }
    } else {
        items(detail.rows) { row ->
            Card(
                colors = CardDefaults.cardColors(
                    containerColor = if (isDark) SlateMedium else androidx.compose.ui.graphics.Color.White
                )
            ) {
                Column(modifier = Modifier.fillMaxWidth().padding(12.dp)) {
                    row.entries
                        .filter { (key, value) -> value != null && key !in hiddenRowKeys }
                        .take(7)
                        .forEach { (key, value) ->
                            ReportMetricRow(
                                stringResource(MetricLabelResolver.resolveResId(key)),
                                value.orEmpty(),
                                isDark
                            )
                        }
                }
            }
        }
    }
    detail.warnings.forEach { warning ->
        item { Text(warning, color = AmberStatus, fontSize = 11.sp) }
    }
}

@Composable
private fun ReportSummaryCard(
    title: String,
    metrics: Map<String, String?>,
    isDark: Boolean,
    protectedRowsHidden: Boolean
) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (isDark) SlateMedium else androidx.compose.ui.graphics.Color.White
        )
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Text(
                title,
                fontWeight = FontWeight.Bold,
                color = if (isDark) androidx.compose.ui.graphics.Color.White else SlateDark
            )
            Spacer(modifier = Modifier.height(8.dp))
            metrics.filterValues { it != null }.forEach { (key, value) ->
                ReportMetricRow(
                    stringResource(MetricLabelResolver.resolveResId(key)),
                    value.orEmpty(),
                    isDark
                )
            }
            if (protectedRowsHidden) {
                Text(
                    stringResource(R.string.reports_protected_payroll_hidden),
                    color = AmberStatus,
                    fontSize = 11.sp,
                    modifier = Modifier.padding(top = 8.dp)
                )
            }
        }
    }
}

@Composable
private fun ReportMetricRow(label: String, value: String, isDark: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, color = SlateLight, fontSize = 11.sp, modifier = Modifier.weight(1f))
        Text(
            reportDisplayValueLocalized(value),
            color = if (isDark) androidx.compose.ui.graphics.Color.White else SlateDark,
            fontWeight = FontWeight.SemiBold,
            fontSize = 11.sp,
            textAlign = TextAlign.End,
            modifier = Modifier.weight(1f)
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReportDatePickerDialog(
    initialDate: String,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit
) {
    val formatter = remember {
        SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
            isLenient = false
            timeZone = TimeZone.getTimeZone("UTC")
        }
    }
    val initialMillis = remember(initialDate) {
        runCatching { formatter.parse(initialDate)?.time }.getOrNull()
    }
    val pickerState = rememberDatePickerState(initialSelectedDateMillis = initialMillis)
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                onClick = {
                    pickerState.selectedDateMillis?.let { onSelect(formatter.format(Date(it))) }
                },
                enabled = pickerState.selectedDateMillis != null
            ) { Text(stringResource(R.string.ux_date_confirm)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.ux_cancel)) } }
    ) {
        DatePicker(state = pickerState)
    }
}

private val hiddenRowKeys = setOf(
    "id", "employeeId", "departmentId", "actorUserId", "periodId"
)

@Composable
private fun reportDisplayValueLocalized(value: String): String {
    val res = reportDisplayValueRes(value)
    return if (res != null) stringResource(res) else value
}
