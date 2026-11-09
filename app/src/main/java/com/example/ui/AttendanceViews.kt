package com.example.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.Badge
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Login
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PostAdd
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import com.example.R
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.domain.model.AttendanceEligibleEmployee
import com.example.domain.model.AttendanceRangePreset
import com.example.domain.model.AttendanceRecordParams
import com.example.ui.theme.AmberStatus
import com.example.ui.theme.BlueStatus
import com.example.ui.theme.EmeraldBg
import com.example.ui.theme.EmeraldMain
import com.example.ui.theme.RedStatus
import com.example.ui.theme.SlateDark
import com.example.ui.theme.SlateLight
import com.example.ui.theme.SlateMedium
import com.example.ui.ux.MawaredDateField
import com.example.ui.ux.MawaredDateFieldLogic
import com.example.ui.ux.MawaredEmptyState
import com.example.ui.ux.MawaredErrorState
import com.example.ui.ux.MawaredLoadingState
import com.example.ui.ux.MawaredScrollableForm
import com.example.ui.ux.MawaredTextField
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

private fun attendanceStatusColor(status: String): Color = when (status.trim().lowercase()) {
    "حاضر", "present" -> EmeraldMain
    "متأخر", "late" -> AmberStatus
    "غائب", "absent" -> RedStatus
    "إجازة", "on_leave", "on leave" -> BlueStatus
    else -> SlateLight
}

@Composable
fun MawaredAttendanceManager(viewModel: MawaredViewModel) {
    val state by viewModel.attendanceUiState.collectAsState()
    val authState by viewModel.authUiState.collectAsState()
    val permissions = authState.currentSession?.permissions.orEmpty()
    val showCorrections = attendanceCorrectionMenuVisible(permissions)
    val showExemptions = permissions.contains(com.example.core.permissions.Permissions.EMPLOYEES_ATTENDANCE_EXEMPTION_MANAGE) ||
        permissions.contains(com.example.core.permissions.Permissions.ATTENDANCE_VIEW_OWN) ||
        permissions.contains(com.example.core.permissions.Permissions.ATTENDANCE_CLOCK) ||
        permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL)
    var manualDialogOpen by remember { mutableStateOf(false) }
    var startPickerOpen by remember { mutableStateOf(false) }
    var endPickerOpen by remember { mutableStateOf(false) }
    var pendingCustomStart by remember { mutableStateOf(state.fromDate) }
    var submitCorrectionTarget by remember { mutableStateOf<Pair<String, Int>?>(null) }

    if (!state.canView) {
        AttendanceNoPermissionState()
        return
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp)
    ) {
        if (showCorrections || showExemptions) {
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp)
            ) {
                item {
                    FilterChip(
                        selected = viewModel.attendanceWorkflowPanel == MawaredViewModel.AttendanceWorkflowPanel.RECORDS,
                        onClick = {
                            viewModel.selectAttendanceWorkflowPanel(MawaredViewModel.AttendanceWorkflowPanel.RECORDS)
                        },
                        label = { Text("السجلات") },
                        colors = FilterChipDefaults.filterChipColors(selectedContainerColor = EmeraldMain)
                    )
                }
                if (showCorrections) {
                    item {
                        FilterChip(
                            selected = viewModel.attendanceWorkflowPanel == MawaredViewModel.AttendanceWorkflowPanel.CORRECTIONS,
                            onClick = {
                                viewModel.selectAttendanceWorkflowPanel(MawaredViewModel.AttendanceWorkflowPanel.CORRECTIONS)
                            },
                            label = { Text("التصحيحات") },
                            colors = FilterChipDefaults.filterChipColors(selectedContainerColor = EmeraldMain)
                        )
                    }
                }
                if (showExemptions) {
                    item {
                        FilterChip(
                            selected = viewModel.attendanceWorkflowPanel == MawaredViewModel.AttendanceWorkflowPanel.EXEMPTIONS,
                            onClick = {
                                viewModel.selectAttendanceWorkflowPanel(MawaredViewModel.AttendanceWorkflowPanel.EXEMPTIONS)
                            },
                            label = { Text("الإعفاءات") },
                            colors = FilterChipDefaults.filterChipColors(selectedContainerColor = EmeraldMain)
                        )
                    }
                }
            }
        }

        when (viewModel.attendanceWorkflowPanel) {
            MawaredViewModel.AttendanceWorkflowPanel.CORRECTIONS -> {
                AttendanceCorrectionManager(
                    controller = viewModel.attendanceCorrectionController,
                    permissions = permissions,
                    currentUserId = authState.currentSession?.userId,
                    onOpenSubmit = { attendanceId, expectedVersion ->
                        submitCorrectionTarget = attendanceId to expectedVersion
                    }
                )
                submitCorrectionTarget?.let { (attendanceId, expectedVersion) ->
                    AttendanceCorrectionSubmitDialog(
                        attendanceId = attendanceId,
                        expectedAttendanceVersion = expectedVersion,
                        onDismiss = { submitCorrectionTarget = null },
                        onSubmit = { clockIn, clockOut, reason ->
                            viewModel.attendanceCorrectionController.onSubmitCorrection(
                                attendanceId = attendanceId,
                                clockIn = clockIn,
                                clockOut = clockOut,
                                reason = reason,
                                expectedAttendanceVersion = expectedVersion
                            )
                            submitCorrectionTarget = null
                        }
                    )
                }
                return@Column
            }
            MawaredViewModel.AttendanceWorkflowPanel.EXEMPTIONS -> {
                val exemptionState by viewModel.attendanceExemptionController.state.collectAsState()
                AttendanceExemptionScreen(
                    state = exemptionState,
                    actions = viewModel.attendanceExemptionController,
                    modifier = Modifier.fillMaxSize()
                )
                return@Column
            }
            MawaredViewModel.AttendanceWorkflowPanel.RECORDS -> Unit
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = stringResource(R.string.attendance_title),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = if (viewModel.isDarkTheme) Color.White else SlateDark
                )
                Text(
                    text = stringResource(R.string.attendance_date_range, state.fromDate, state.toDate),
                    fontSize = 11.sp,
                    color = SlateLight
                )
            }
            IconButton(onClick = viewModel::refreshAttendance, enabled = !state.isLoading) {
                Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.ux_refresh), tint = EmeraldMain)
            }
            if (state.canManage) {
                IconButton(
                    onClick = { manualDialogOpen = true },
                    enabled = state.eligibleEmployees.isNotEmpty() && !state.isSubmittingManual
                ) {
                    Icon(Icons.Default.PostAdd, contentDescription = stringResource(R.string.attendance_manual_entry_cd), tint = EmeraldMain)
                }
            }
        }

        state.errorMessage?.takeIf { it.isNotBlank() }?.let { message ->
            MawaredErrorState(
                message = message,
                onRetry = viewModel::refreshAttendance,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
            )
        }

        Spacer(modifier = Modifier.height(10.dp))
        AttendanceRangeFilters(
            selected = state.selectedRangePreset,
            onSelect = { preset ->
                if (preset == AttendanceRangePreset.CUSTOM) {
                    pendingCustomStart = state.fromDate
                    startPickerOpen = true
                } else {
                    viewModel.updateAttendanceRangePreset(preset)
                }
            }
        )

        Spacer(modifier = Modifier.height(10.dp))
        AttendanceSummaryRow(state)

        if (state.canClock) {
            Spacer(modifier = Modifier.height(10.dp))
            SelfClockControls(viewModel)
        }

        if (state.canSelectDepartment && state.availableDepartments.isNotEmpty()) {
            Spacer(modifier = Modifier.height(10.dp))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                item {
                    FilterChip(
                        selected = state.selectedDepartmentId == null,
                        onClick = { viewModel.updateAttendanceDepartmentFilter(null) },
                        label = { Text(stringResource(R.string.ux_all)) },
                        colors = FilterChipDefaults.filterChipColors(selectedContainerColor = EmeraldMain)
                    )
                }
                items(state.availableDepartments) { department ->
                    FilterChip(
                        selected = state.selectedDepartmentId == department.id,
                        onClick = { viewModel.updateAttendanceDepartmentFilter(department.id) },
                        label = { Text(department.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        colors = FilterChipDefaults.filterChipColors(selectedContainerColor = EmeraldMain)
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(6.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items(attendanceStatusFilterOptions()) { option ->
                FilterChip(
                    selected = state.selectedStatusFilter == option.filterValue,
                    onClick = { viewModel.updateAttendanceStatusFilter(option.filterValue) },
                    label = { Text(stringResource(option.labelRes)) },
                    colors = FilterChipDefaults.filterChipColors(selectedContainerColor = EmeraldMain)
                )
            }
        }

        Spacer(modifier = Modifier.height(8.dp))
        if (state.isLoading && state.records.isEmpty()) {
            MawaredLoadingState(modifier = Modifier.fillMaxSize())
        } else if (state.records.isEmpty()) {
            MawaredEmptyState(
                title = stringResource(R.string.attendance_empty_title),
                detail = stringResource(R.string.attendance_empty_detail),
                modifier = Modifier.fillMaxSize()
            )
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(state.records, key = { it.id }) { record -> AttendanceRecordCard(record) }
            }
        }
    }

    if (manualDialogOpen) {
        AttendanceManualDialog(
            employees = state.eligibleEmployees,
            isDarkTheme = viewModel.isDarkTheme,
            isSubmitting = state.isSubmittingManual,
            onDismiss = { manualDialogOpen = false },
            onSave = { employeeId, date, status, clockIn, clockOut ->
                viewModel.createManualAttendance(employeeId, date, status, clockIn, clockOut)
                manualDialogOpen = false
            }
        )
    }

    if (startPickerOpen) {
        AttendanceDatePickerDialog(
            initialDate = state.fromDate,
            title = stringResource(R.string.attendance_date_start),
            onDismiss = { startPickerOpen = false },
            onSelect = { selected ->
                pendingCustomStart = selected
                startPickerOpen = false
                endPickerOpen = true
            }
        )
    }
    if (endPickerOpen) {
        AttendanceDatePickerDialog(
            initialDate = state.toDate,
            title = stringResource(R.string.attendance_date_end),
            onDismiss = { endPickerOpen = false },
            onSelect = { selected ->
                endPickerOpen = false
                viewModel.updateAttendanceCustomRange(pendingCustomStart, selected)
            }
        )
    }
}

@Composable
private fun AttendanceNoPermissionState() {
    Box(modifier = Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Default.Lock, contentDescription = null, tint = SlateLight, modifier = Modifier.size(56.dp))
            Text(
                stringResource(R.string.attendance_no_permission),
                color = SlateLight,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 10.dp)
            )
        }
    }
}

@Composable
private fun AttendanceRangeFilters(
    selected: AttendanceRangePreset,
    onSelect: (AttendanceRangePreset) -> Unit
) {
    val options = listOf(
        AttendanceRangePreset.TODAY to stringResource(R.string.attendance_range_today),
        AttendanceRangePreset.THIS_WEEK to stringResource(R.string.attendance_range_this_week),
        AttendanceRangePreset.THIS_MONTH to stringResource(R.string.attendance_range_this_month),
        AttendanceRangePreset.CUSTOM to stringResource(R.string.attendance_range_custom)
    )
    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        items(options) { (preset, label) ->
            FilterChip(
                selected = selected == preset,
                onClick = { onSelect(preset) },
                label = { Text(label) },
                leadingIcon = if (preset == AttendanceRangePreset.CUSTOM) {
                    { Icon(Icons.Default.CalendarMonth, contentDescription = null, modifier = Modifier.size(16.dp)) }
                } else null,
                colors = FilterChipDefaults.filterChipColors(selectedContainerColor = EmeraldMain)
            )
        }
    }
}

@Composable
private fun AttendanceSummaryRow(state: AttendanceUiState) {
    val summary = state.summary
    val hours = summary.completedWorkMinutes / 60
    val minutes = summary.completedWorkMinutes % 60
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        AttendanceStatChip(stringResource(R.string.attendance_status_present), summary.present.toString(), EmeraldMain)
        AttendanceStatChip(stringResource(R.string.attendance_status_late), summary.late.toString(), AmberStatus)
        AttendanceStatChip(stringResource(R.string.attendance_status_absent), summary.absent.toString(), RedStatus)
        AttendanceStatChip(stringResource(R.string.attendance_stat_missing_clock_out), summary.missingClockOut.toString(), AmberStatus)
        AttendanceStatChip(
            stringResource(R.string.attendance_stat_completed_hours),
            stringResource(R.string.attendance_hours_minutes, hours, minutes),
            SlateLight
        )
    }
}

@Composable
private fun AttendanceStatChip(label: String, value: String, color: Color) {
    Surface(
        color = color.copy(alpha = 0.12f),
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(1.dp, color.copy(alpha = 0.3f))
    ) {
        Column(
            modifier = Modifier.padding(vertical = 8.dp, horizontal = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(value, fontWeight = FontWeight.Bold, fontSize = 15.sp, color = color)
            Text(label, fontSize = 10.sp, color = SlateLight, maxLines = 1)
        }
    }
}

@Composable
private fun SelfClockControls(viewModel: MawaredViewModel) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = EmeraldBg.copy(alpha = 0.5f)),
        shape = RoundedCornerShape(8.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = viewModel::clockInCurrentUser,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain),
                shape = RoundedCornerShape(8.dp)
            ) {
                Icon(Icons.Default.Login, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(modifier = Modifier.width(6.dp))
                Text(stringResource(R.string.attendance_clock_in))
            }
            Button(
                onClick = viewModel::clockOutCurrentUser,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = AmberStatus),
                shape = RoundedCornerShape(8.dp)
            ) {
                Icon(Icons.Default.Logout, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(modifier = Modifier.width(6.dp))
                Text(stringResource(R.string.attendance_clock_out))
            }
        }
    }
}

@Composable
private fun AttendanceRecordCard(record: AttendanceRecordParams) {
    val statusColor = attendanceStatusColor(record.status)
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = SlateMedium.copy(alpha = 0.55f)),
        shape = RoundedCornerShape(8.dp)
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(record.employeeName, color = Color.White, fontWeight = FontWeight.Bold)
                    Text(
                        listOf(record.departmentName, record.date).filter { it.isNotBlank() }.joinToString(" • "),
                        color = SlateLight,
                        fontSize = 11.sp
                    )
                }
                Surface(color = statusColor.copy(alpha = 0.15f), shape = RoundedCornerShape(6.dp)) {
                    Text(
                        stringResource(attendanceStatusLabelRes(record.status)),
                        color = statusColor,
                        fontWeight = FontWeight.Bold,
                        fontSize = 11.sp,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                    )
                }
            }
            Spacer(modifier = Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                AttendanceTimeValue(stringResource(R.string.attendance_label_clock_in), record.clockInTime)
                AttendanceTimeValue(stringResource(R.string.attendance_label_clock_out), record.clockOutTime)
            }
        }
    }
}

@Composable
private fun AttendanceTimeValue(label: String, value: String?) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Default.AccessTime, contentDescription = null, tint = SlateLight, modifier = Modifier.size(15.dp))
        Spacer(modifier = Modifier.width(4.dp))
        Text("$label: ${value ?: "—"}", color = SlateLight, fontSize = 11.sp)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AttendanceManualDialog(
    employees: List<AttendanceEligibleEmployee>,
    isDarkTheme: Boolean,
    isSubmitting: Boolean,
    onDismiss: () -> Unit,
    onSave: (String, String, String, String?, String?) -> Unit
) {
    var selectedEmployeeId by remember { mutableStateOf<String?>(null) }
    var employeeMenuOpen by remember { mutableStateOf(false) }
    var workDate by remember { mutableStateOf(todayIso()) }
    var workDatePickerOpen by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("present") }
    var clockIn by remember { mutableStateOf("") }
    var clockOut by remember { mutableStateOf("") }
    val selectedEmployee = employees.firstOrNull { it.employeeId == selectedEmployeeId }
    val validClockIn = status == "absent" || isValidAttendanceTime(clockIn)
    val validClockOut = clockOut.isBlank() || isValidAttendanceTime(clockOut)
    val orderedTimes = clockOut.isBlank() || clockIn.isBlank() || clockOut >= clockIn
    val canSave = selectedEmployee != null && workDate <= todayIso() &&
        validClockIn && validClockOut && orderedTimes && !isSubmitting

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(8.dp),
            color = if (isDarkTheme) SlateMedium else Color.White
        ) {
            MawaredScrollableForm(
                modifier = Modifier.padding(18.dp),
                bottomAction = {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        TextButton(onClick = onDismiss) { Text(stringResource(R.string.ux_cancel)) }
                        Spacer(modifier = Modifier.width(8.dp))
                        Button(
                            enabled = canSave,
                            onClick = {
                                onSave(
                                    selectedEmployeeId!!,
                                    workDate,
                                    status,
                                    clockIn.ifBlank { null },
                                    clockOut.ifBlank { null }
                                )
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain)
                        ) {
                            Text(if (isSubmitting) stringResource(R.string.ux_saving) else stringResource(R.string.attendance_save_record))
                        }
                    }
                }
            ) {
                Text(stringResource(R.string.attendance_manual_title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(12.dp))

                ExposedDropdownMenuBox(
                    expanded = employeeMenuOpen,
                    onExpandedChange = { employeeMenuOpen = !employeeMenuOpen }
                ) {
                    OutlinedTextField(
                        value = selectedEmployee?.let { "${it.name} • ${it.departmentName}" }.orEmpty(),
                        onValueChange = {},
                        readOnly = true,
                        label = { Text(stringResource(R.string.attendance_employee)) },
                        leadingIcon = { Icon(Icons.Default.Badge, contentDescription = null) },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(employeeMenuOpen) },
                        modifier = Modifier.menuAnchor().fillMaxWidth()
                    )
                    ExposedDropdownMenu(
                        expanded = employeeMenuOpen,
                        onDismissRequest = { employeeMenuOpen = false }
                    ) {
                        employees.forEach { employee ->
                            DropdownMenuItem(
                                text = {
                                    Column {
                                        Text(employee.name)
                                        Text(employee.departmentName, fontSize = 11.sp, color = SlateLight)
                                    }
                                },
                                onClick = {
                                    selectedEmployeeId = employee.employeeId
                                    employeeMenuOpen = false
                                }
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.height(10.dp))
                MawaredDateField(
                    isoDate = workDate,
                    label = stringResource(R.string.attendance_work_date),
                    isError = workDate > todayIso(),
                    supportingText = if (workDate > todayIso()) stringResource(R.string.attendance_future_date_error) else null,
                    displayText = MawaredDateFieldLogic.formatDisplayDdMmYyyy(workDate),
                    onOpenPicker = { workDatePickerOpen = true }
                )

                Spacer(modifier = Modifier.height(10.dp))
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    attendanceManualStatusOptions().forEach { option ->
                        FilterChip(
                            selected = status == option.first,
                            onClick = {
                                status = option.first
                                if (status == "absent") {
                                    clockIn = ""
                                    clockOut = ""
                                }
                            },
                            label = { Text(stringResource(option.second)) },
                            colors = FilterChipDefaults.filterChipColors(selectedContainerColor = EmeraldMain)
                        )
                    }
                }

                if (status != "absent") {
                    Spacer(modifier = Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        AttendanceTimeField(stringResource(R.string.attendance_time_in_hint), clockIn, { clockIn = it }, Modifier.weight(1f))
                        AttendanceTimeField(stringResource(R.string.attendance_time_out_hint), clockOut, { clockOut = it }, Modifier.weight(1f))
                    }
                }

                if (!orderedTimes) {
                    Text(stringResource(R.string.attendance_clock_out_order_error), color = RedStatus, fontSize = 11.sp)
                }
            }
        }
    }

    if (workDatePickerOpen) {
        AttendanceDatePickerDialog(
            initialDate = workDate,
            title = stringResource(R.string.attendance_work_date),
            onDismiss = { workDatePickerOpen = false },
            onSelect = { selected ->
                workDate = selected
                workDatePickerOpen = false
            }
        )
    }
}

@Composable
private fun AttendanceTimeField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    MawaredTextField(
        value = value,
        onValueChange = { next ->
            if (next.length <= 5 && next.all { it.isDigit() || it == ':' }) onValueChange(next)
        },
        label = label,
        isError = value.isNotBlank() && !isValidAttendanceTime(value),
        forceLtr = true,
        modifier = modifier
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AttendanceDatePickerDialog(
    initialDate: String,
    title: String,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit
) {
    val pickerState = rememberDatePickerState(initialSelectedDateMillis = isoToUtcMillis(initialDate))
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                enabled = pickerState.selectedDateMillis != null,
                onClick = { pickerState.selectedDateMillis?.let { onSelect(utcMillisToIso(it)) } }
            ) { Text(stringResource(R.string.ux_date_confirm)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.ux_cancel)) } }
    ) {
        DatePicker(state = pickerState, title = { Text(title, modifier = Modifier.padding(16.dp)) })
    }
}

private fun isValidAttendanceTime(value: String): Boolean =
    Regex("^([01]\\d|2[0-3]):[0-5]\\d$").matches(value)

private fun todayIso(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
}.format(Date())

private fun isoToUtcMillis(value: String): Long? = try {
    SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
        isLenient = false
        timeZone = TimeZone.getTimeZone("UTC")
    }.parse(value)?.time
} catch (_: Exception) {
    null
}

private fun utcMillisToIso(value: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
}.format(Date(value))
