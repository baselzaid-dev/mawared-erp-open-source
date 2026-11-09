package com.example.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
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
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.R
import com.example.domain.model.PayrollPeriodParams
import com.example.domain.model.ReportTemplateCatalogItem
import com.example.domain.model.ReportTemplateDocument
import com.example.domain.model.ReportTemplateExportFormat
import com.example.domain.model.ReportTemplateSection
import com.example.domain.model.SavedReportTemplate
import com.example.domain.model.isArchived
import com.example.domain.model.reportTemplateExtraFilterKey
import com.example.domain.model.supportsFormat
import com.example.ui.theme.AmberStatus
import com.example.ui.theme.EmeraldMain
import com.example.ui.theme.SlateDark
import com.example.ui.theme.SlateLight
import com.example.ui.theme.SlateMedium
import com.example.ui.ux.MawaredEmptyState
import com.example.ui.ux.MawaredErrorState
import com.example.ui.ux.MawaredLoadingState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

@Composable
fun ReportTemplatesSection(viewModel: MawaredViewModel) {
    val state by viewModel.reportTemplatesUiState.collectAsState()
    val reportsState by viewModel.reportsUiState.collectAsState()
    val employeesState by viewModel.employeesUiState.collectAsState()
    val context = LocalContext.current
    val shareFailedMessage = stringResource(R.string.reports_share_failed)
    var showFromPicker by remember { mutableStateOf(false) }
    var showToPicker by remember { mutableStateOf(false) }
    var departmentMenu by remember { mutableStateOf(false) }
    var extraFilterMenu by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        if (state.catalog.isEmpty() && !state.isLoading) {
            viewModel.refreshReportTemplates()
        }
    }

    LaunchedEffect(state.pendingShare?.uri) {
        val share = state.pendingShare ?: return@LaunchedEffect
        try {
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = share.mimeType
                putExtra(Intent.EXTRA_STREAM, share.uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(Intent.createChooser(intent, "مشاركة تقرير القالب"))
        } catch (_: Exception) {
            viewModel.showNotification(shareFailedMessage)
        } finally {
            viewModel.consumeReportTemplateShare()
        }
    }

    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (viewModel.isDarkTheme) SlateMedium else androidx.compose.ui.graphics.Color.White
        ),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "قوالب التقارير",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = if (viewModel.isDarkTheme) androidx.compose.ui.graphics.Color.White else SlateDark
                    )
                    Text(
                        "قوالب جاهزة من الخادم — بدون حسابات محلية",
                        color = SlateLight,
                        fontSize = 11.sp
                    )
                }
                IconButton(onClick = viewModel::refreshReportTemplates) {
                    Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.ux_refresh), tint = EmeraldMain)
                }
            }

            if (state.catalog.isEmpty() && !state.isLoading) {
                MawaredEmptyState(
                    title = "لا توجد قوالب",
                    detail = "لا توجد قوالب متاحة لصلاحيات هذا الحساب.",
                    modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)
                )
            } else if (state.catalog.isNotEmpty()) {
                LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(top = 8.dp)
                ) {
                    items(state.catalog, key = { it.builtInKey }) { template ->
                        FilterChip(
                            selected = template.builtInKey == state.selectedTemplate?.builtInKey,
                            onClick = { viewModel.selectReportTemplate(template.builtInKey) },
                            label = { Text(template.title, fontSize = 11.sp) }
                        )
                    }
                }

                state.selectedTemplate?.let { selected ->
                    Text(
                        selected.description,
                        color = SlateLight,
                        fontSize = 11.sp,
                        modifier = Modifier.padding(top = 8.dp)
                    )

                    if (!selected.modules.contains("payroll")) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
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

                    if (employeesState.departments.isNotEmpty()) {
                        Box(modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
                            val selectedDepartment = employeesState.departments
                                .firstOrNull { it.id == state.departmentId }
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
                                        viewModel.updateReportTemplateDepartment(null)
                                    }
                                )
                                employeesState.departments.forEach { department ->
                                    DropdownMenuItem(
                                        text = { Text(department.name) },
                                        onClick = {
                                            departmentMenu = false
                                            viewModel.updateReportTemplateDepartment(department.id)
                                        }
                                    )
                                }
                            }
                        }
                    }

                    templateExtraFilterContent(
                        template = selected,
                        currentValue = state.extraFilter,
                        payrollPeriods = reportsState.payrollPeriods,
                        expanded = extraFilterMenu,
                        onExpandedChange = { extraFilterMenu = it },
                        onSelect = viewModel::updateReportTemplateExtraFilter
                    )

                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Button(
                            onClick = viewModel::previewSelectedReportTemplate,
                            enabled = !state.isLoading,
                            modifier = Modifier.weight(1f)
                        ) {
                            Icon(Icons.Default.Visibility, contentDescription = null)
                            Text("معاينة", modifier = Modifier.padding(start = 6.dp), fontSize = 11.sp)
                        }
                        if (state.canManageSavedTemplates) {
                            OutlinedButton(onClick = viewModel::openSaveReportTemplateDialog) {
                                Icon(Icons.Default.Bookmark, contentDescription = null)
                                Text("حفظ", modifier = Modifier.padding(start = 6.dp), fontSize = 11.sp)
                            }
                        }
                    }

                    if (state.canExportTemplates) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            ReportTemplateExportFormat.entries.forEach { format ->
                                if (selected.supportsFormat(format)) {
                                    OutlinedButton(
                                        onClick = { viewModel.exportSelectedReportTemplate(format) },
                                        enabled = state.exportingFormat == null,
                                        modifier = Modifier.weight(1f)
                                    ) {
                                        if (state.exportingFormat == format) {
                                            CircularProgressIndicator(
                                                modifier = Modifier.height(16.dp),
                                                strokeWidth = 2.dp
                                            )
                                        } else {
                                            Icon(Icons.Default.Download, contentDescription = null)
                                            Text(format.apiValue.uppercase(), modifier = Modifier.padding(start = 4.dp), fontSize = 10.sp)
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (state.canManageSavedTemplates) {
                        OutlinedButton(
                            onClick = { viewModel.toggleSavedReportTemplates(!state.showSavedTemplates) },
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                        ) {
                            Text(if (state.showSavedTemplates) "إخفاء القوالب المحفوظة" else "عرض القوالب المحفوظة")
                        }
                    }
                }
            }

            state.errorMessage?.takeIf { it.isNotBlank() }?.let { message ->
                MawaredErrorState(
                    message = message,
                    onRetry = {
                        if (state.catalog.isEmpty()) viewModel.refreshReportTemplates()
                        else viewModel.previewSelectedReportTemplate()
                    },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                )
            }

            if (state.isLoading) {
                MawaredLoadingState(modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp))
            } else {
                state.preview?.let { preview ->
                    ReportTemplatePreviewContent(preview, viewModel.isDarkTheme)
                }
            }

            if (state.showSavedTemplates) {
                SavedReportTemplatesList(
                    templates = state.savedTemplates,
                    loading = state.savedLoading,
                    isDark = viewModel.isDarkTheme,
                    onApply = viewModel::applySavedReportTemplate,
                    onArchive = viewModel::archiveSavedReportTemplate
                )
            }
        }
    }

    if (showFromPicker) {
        TemplateDatePickerDialog(
            initialDate = state.fromDate,
            onDismiss = { showFromPicker = false },
            onSelect = {
                showFromPicker = false
                viewModel.updateReportTemplateDateRange(it, state.toDate)
            }
        )
    }
    if (showToPicker) {
        TemplateDatePickerDialog(
            initialDate = state.toDate,
            onDismiss = { showToPicker = false },
            onSelect = {
                showToPicker = false
                viewModel.updateReportTemplateDateRange(state.fromDate, it)
            }
        )
    }

    if (state.showSaveDialog) {
        AlertDialog(
            onDismissRequest = viewModel::dismissSaveReportTemplateDialog,
            title = { Text("حفظ القالب") },
            text = {
                OutlinedTextField(
                    value = state.saveName,
                    onValueChange = viewModel::updateSaveReportTemplateName,
                    label = { Text("اسم القالب") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            },
            confirmButton = {
                TextButton(onClick = { viewModel.saveSelectedReportTemplate(null) }) {
                    Text("حفظ")
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::dismissSaveReportTemplateDialog) {
                    Text(stringResource(R.string.ux_cancel))
                }
            }
        )
    }
}

@Composable
private fun templateExtraFilterContent(
    template: ReportTemplateCatalogItem,
    currentValue: String?,
    payrollPeriods: List<PayrollPeriodParams>,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    onSelect: (String?) -> Unit
) {
    val filterKey = reportTemplateExtraFilterKey(template.modules) ?: return
    if (filterKey == "periodId") {
        if (payrollPeriods.isEmpty()) return
        Box(modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
            val selectedPeriod = payrollPeriods.firstOrNull { it.id == currentValue }
            OutlinedButton(onClick = { onExpandedChange(true) }, modifier = Modifier.fillMaxWidth()) {
                Text(
                    selectedPeriod?.let { "${it.month}/${it.year}" } ?: "اختر فترة الرواتب",
                    fontSize = 11.sp
                )
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { onExpandedChange(false) }) {
                payrollPeriods.forEach { period ->
                    DropdownMenuItem(
                        text = { Text("${period.month}/${period.year} (${period.status})") },
                        onClick = {
                            onExpandedChange(false)
                            onSelect(period.id)
                        }
                    )
                }
            }
        }
        return
    }
    val options = reportStatusOptionRes(template.modules.single())
    if (options.isEmpty()) return
    Box(modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
        val selectedRes = options.firstOrNull { it.first == currentValue }?.second
            ?: R.string.reports_all_statuses
        OutlinedButton(onClick = { onExpandedChange(true) }, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(selectedRes))
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { onExpandedChange(false) }) {
            options.forEach { (value, labelRes) ->
                DropdownMenuItem(
                    text = { Text(stringResource(labelRes)) },
                    onClick = {
                        onExpandedChange(false)
                        onSelect(value)
                    }
                )
            }
        }
    }
}

@Composable
private fun ReportTemplatePreviewContent(
    document: ReportTemplateDocument,
    isDark: Boolean
) {
    Column(modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
        document.warnings.forEach { warning ->
            Text(warning, color = AmberStatus, fontSize = 11.sp, modifier = Modifier.padding(bottom = 4.dp))
        }
        document.sections.forEach { section ->
            ReportTemplateSectionCard(section, isDark)
        }
    }
}

@Composable
private fun ReportTemplateSectionCard(section: ReportTemplateSection, isDark: Boolean) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (isDark) SlateDark else androidx.compose.ui.graphics.Color(0xFFF8FAFC)
        ),
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp)) {
            Text(
                section.title,
                fontWeight = FontWeight.Bold,
                color = if (isDark) androidx.compose.ui.graphics.Color.White else SlateDark
            )
            if (section.summary.isNotEmpty()) {
                Spacer(modifier = Modifier.height(6.dp))
                section.summary.filterValues { it != null }.forEach { (key, value) ->
                    TemplateMetricRow(
                        stringResource(MetricLabelResolver.resolveResId(key)),
                        value.orEmpty(),
                        isDark
                    )
                }
            }
            Text(
                "عدد الصفوف: ${section.rowCount}${if (section.truncated) " (مقتص)" else ""}",
                color = SlateLight,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 6.dp)
            )
            section.warnings.forEach { warning ->
                Text(warning, color = AmberStatus, fontSize = 11.sp)
            }
            if (section.rows.isEmpty()) {
                Text(
                    stringResource(R.string.reports_empty_data_detail),
                    color = SlateLight,
                    fontSize = 11.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                )
            } else {
                section.rows.take(5).forEach { row ->
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 8.dp)
                    ) {
                        row.entries
                            .filter { (key, value) -> value != null && key !in hiddenTemplateRowKeys }
                            .take(6)
                            .forEach { (key, value) ->
                                TemplateMetricRow(
                                    stringResource(MetricLabelResolver.resolveResId(key)),
                                    value.orEmpty(),
                                    isDark
                                )
                            }
                    }
                }
                if (section.rows.size > 5) {
                    Text(
                        "… ${section.rows.size - 5} صف إضافي في المعاينة",
                        color = SlateLight,
                        fontSize = 10.sp,
                        modifier = Modifier.padding(top = 4.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun SavedReportTemplatesList(
    templates: List<SavedReportTemplate>,
    loading: Boolean,
    isDark: Boolean,
    onApply: (SavedReportTemplate) -> Unit,
    onArchive: (String) -> Unit
) {
    Column(modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
        Text(
            "القوالب المحفوظة",
            fontWeight = FontWeight.SemiBold,
            color = if (isDark) androidx.compose.ui.graphics.Color.White else SlateDark
        )
        if (loading) {
            MawaredLoadingState(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp))
        } else if (templates.isEmpty()) {
            Text("لا توجد قوالب محفوظة.", color = SlateLight, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
        } else {
            templates.forEach { saved ->
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = if (isDark) SlateDark else androidx.compose.ui.graphics.Color(0xFFF8FAFC)
                    ),
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(10.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(saved.name, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
                            Text(
                                "${saved.builtInKey} • v${saved.templateVersion}",
                                color = SlateLight,
                                fontSize = 10.sp
                            )
                            if (saved.isArchived()) {
                                Text("مؤرشف", color = AmberStatus, fontSize = 10.sp)
                            }
                        }
                        if (!saved.isArchived()) {
                            TextButton(onClick = { onApply(saved) }) { Text("تطبيق") }
                            IconButton(onClick = { onArchive(saved.id) }) {
                                Icon(Icons.Default.Archive, contentDescription = "أرشفة", tint = SlateLight)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TemplateMetricRow(label: String, value: String, isDark: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, color = SlateLight, fontSize = 10.sp, modifier = Modifier.weight(1f))
        Text(
            templateDisplayValueLocalized(value),
            color = if (isDark) androidx.compose.ui.graphics.Color.White else SlateDark,
            fontSize = 10.sp,
            textAlign = TextAlign.End,
            modifier = Modifier.weight(1f)
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TemplateDatePickerDialog(
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

private val hiddenTemplateRowKeys = setOf(
    "id", "employeeId", "departmentId", "actorUserId", "periodId"
)

@Composable
private fun templateDisplayValueLocalized(value: String): String {
    val res = reportDisplayValueRes(value)
    return if (res != null) stringResource(res) else value
}
