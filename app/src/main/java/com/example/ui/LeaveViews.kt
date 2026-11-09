package com.example.ui

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.BuildConfig
import com.example.R
import com.example.data.demo.DemoLoginProfiles
import com.example.data.model.Employee
import com.example.data.model.PurchaseOrder
import com.example.data.model.ChatMessage
import com.example.data.model.Task
import com.example.data.model.TrainingCourse
import com.example.data.model.TrainingAssignment
import com.example.domain.model.LeaveRequestParams
import com.example.domain.model.LeaveScreenMode
import com.example.domain.model.canCancelOwnLeave
import com.example.domain.model.isPendingAdmin
import com.example.domain.model.isPendingHr
import com.example.ui.theme.*
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

private fun leaveStatusColor(status: String): Color = when (status) {
    "موافق عليها" -> EmeraldMain
    "قيد المراجعة" -> AmberStatus
    "مرفوضة" -> RedStatus
    "ملغاة" -> SlateLight
    else -> SlateLight
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MawaredLeavesManager(viewModel: MawaredViewModel) {
    val leavesUiState by viewModel.leavesUiState.collectAsState()

    var isRequestDialogOpen by remember { mutableStateOf(false) }
    var rejectTarget by remember { mutableStateOf<LeaveRequestParams?>(null) }
    var draftFrom by remember { mutableStateOf(leavesUiState.fromDate) }
    var draftTo by remember { mutableStateOf(leavesUiState.toDate) }
    var employeeMenuExpanded by remember { mutableStateOf(false) }

    LaunchedEffect(leavesUiState.fromDate, leavesUiState.toDate) {
        draftFrom = leavesUiState.fromDate
        draftTo = leavesUiState.toDate
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        if (!leavesUiState.canView) {
            // Friendly no-permission state: user lacks leaves.view / hr.manage.
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.Lock, contentDescription = "لا توجد صلاحية", tint = SlateLight, modifier = Modifier.size(64.dp))
                    Text(
                        "لا تملك صلاحية عرض طلبات الإجازات.",
                        color = SlateLight,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(top = 12.dp)
                    )
                    Text(
                        "يتطلب الوصول صلاحية (leaves.view).",
                        color = SlateLight,
                        fontSize = 11.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 4.dp)
                    )
                }
            }
        } else {
            // Header
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        text = "إدارة طلبات الإجازات",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = if (viewModel.isDarkTheme) Color.White else SlateDark
                    )
                    Text(
                        "تقديم ومراجعة واعتماد طلبات الإجازات حسب الصلاحية",
                        fontSize = 11.sp,
                        color = SlateLight
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { viewModel.refreshLeaveRequests() }) {
                        Icon(Icons.Default.Refresh, contentDescription = "تحديث", tint = EmeraldMain)
                    }
                    // Create request gated on canCreate.
                    if (leavesUiState.canCreate) {
                        IconButton(onClick = { isRequestDialogOpen = true }) {
                            Icon(Icons.Default.PostAdd, contentDescription = "طلب إجازة", tint = EmeraldMain)
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(10.dp))

            val modes = buildList {
                add(LeaveScreenMode.MY_REQUESTS to "طلباتي")
                if (leavesUiState.canReview) add(LeaveScreenMode.REVIEW to "المراجعة")
                if (leavesUiState.canReport) add(LeaveScreenMode.REPORT to "التقرير")
            }
            ScrollableTabRow(
                selectedTabIndex = modes.indexOfFirst { it.first == leavesUiState.selectedMode }.coerceAtLeast(0),
                edgePadding = 0.dp,
                containerColor = Color.Transparent,
                contentColor = EmeraldMain,
                divider = { HorizontalDivider(color = SlateLight.copy(alpha = 0.18f)) }
            ) {
                modes.forEach { (mode, label) ->
                    Tab(
                        selected = leavesUiState.selectedMode == mode,
                        onClick = {
                            viewModel.clearTypedResourceFocus()
                            viewModel.selectLeaveMode(mode)
                        },
                        text = { Text(label, fontSize = 12.sp, fontWeight = FontWeight.Bold) }
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            val statuses = listOf(
                "all" to "الكل",
                "pending_hr" to "مراجعة الموارد البشرية",
                "pending_admin" to "مراجعة الإدارة",
                "approved" to "موافق عليها",
                "rejected" to "مرفوضة",
                "cancelled" to "ملغاة"
            )
            LazyRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                items(statuses) { (value, label) ->
                    val s = leavesUiState.selectedStatusFilter == value
                    FilterChip(
                        selected = s,
                        onClick = {
                            viewModel.clearTypedResourceFocus()
                            viewModel.updateLeaveStatusFilter(value)
                        },
                        label = { Text(label, fontSize = 11.sp, color = if (s) SlateDark else SlateLight) },
                        colors = FilterChipDefaults.filterChipColors(selectedContainerColor = EmeraldMain)
                    )
                }
            }

            Spacer(modifier = Modifier.height(6.dp))

            val types = listOf(
                "all" to "الكل",
                "annual" to "سنوية",
                "sick" to "مرضية",
                "special" to "طارئة",
                "unpaid" to "بدون راتب",
                "study" to "دراسية"
            )
            LazyRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                items(types) { (value, label) ->
                    val s = leavesUiState.selectedTypeFilter == value
                    FilterChip(
                        selected = s,
                        onClick = {
                            viewModel.clearTypedResourceFocus()
                            viewModel.updateLeaveTypeFilter(value)
                        },
                        label = { Text(label, fontSize = 11.sp, color = if (s) SlateDark else SlateLight) },
                        colors = FilterChipDefaults.filterChipColors(selectedContainerColor = EmeraldMain)
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                IsoDatePickerField(
                    label = stringResource(R.string.leave_date_from),
                    isoValue = draftFrom,
                    onIsoSelected = { draftFrom = it },
                    modifier = Modifier.weight(1f)
                )
                IsoDatePickerField(
                    label = stringResource(R.string.leave_date_to),
                    isoValue = draftTo,
                    onIsoSelected = { draftTo = it },
                    modifier = Modifier.weight(1f)
                )
            }

            if (leavesUiState.selectedMode == LeaveScreenMode.REPORT) {
                val employees = leavesUiState.reportRequests
                    .distinctBy { it.employeeId }
                    .sortedBy { it.employeeName }
                ExposedDropdownMenuBox(
                    expanded = employeeMenuExpanded,
                    onExpandedChange = { employeeMenuExpanded = !employeeMenuExpanded },
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp)
                ) {
                    val selectedName = employees.firstOrNull {
                        it.employeeId == leavesUiState.selectedEmployeeId
                    }?.employeeName ?: "كل الموظفين"
                    OutlinedTextField(
                        value = selectedName,
                        onValueChange = {},
                        readOnly = true,
                        singleLine = true,
                        label = { Text("الموظف") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(employeeMenuExpanded) },
                        modifier = Modifier.menuAnchor().fillMaxWidth()
                    )
                    ExposedDropdownMenu(
                        expanded = employeeMenuExpanded,
                        onDismissRequest = { employeeMenuExpanded = false }
                    ) {
                        DropdownMenuItem(
                            text = { Text("كل الموظفين") },
                            onClick = {
                                viewModel.updateLeaveEmployeeFilter(null)
                                employeeMenuExpanded = false
                            }
                        )
                        employees.forEach { employee ->
                            DropdownMenuItem(
                                text = { Text(employee.employeeName) },
                                onClick = {
                                    viewModel.updateLeaveEmployeeFilter(employee.employeeId)
                                    employeeMenuExpanded = false
                                }
                            )
                        }
                    }
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(onClick = { viewModel.clearLeaveFilters() }) {
                    Icon(
                        Icons.Default.FilterAltOff,
                        contentDescription = stringResource(R.string.leave_filter_reset_cd),
                        tint = SlateLight
                    )
                }
                Button(
                    onClick = {
                        if (viewModel.updateLeaveDateRange(draftFrom, draftTo)) {
                            viewModel.applyLeaveFilters()
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain),
                    shape = RoundedCornerShape(6.dp)
                ) {
                    Icon(Icons.Default.FilterAlt, contentDescription = stringResource(R.string.ux_filter), modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(stringResource(R.string.ux_apply), color = SlateDark)
                }
            }

            if (leavesUiState.selectedMode == LeaveScreenMode.REPORT) {
                LeaveReportSummaryRow(leavesUiState.reportSummary, viewModel.isDarkTheme)
            }

            if (leavesUiState.isLoading) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth().padding(top = 6.dp), color = EmeraldMain)
            }
            leavesUiState.errorMessage?.let { message ->
                Text(
                    message,
                    color = RedStatus,
                    fontSize = 12.sp,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            val displayed = viewModel.focusedLeaveId?.let { focusedId ->
                (
                    leavesUiState.myRequests +
                        leavesUiState.requests +
                        leavesUiState.reportRequests
                    ).distinctBy { it.id }.filter { it.id == focusedId }
            } ?: when (leavesUiState.selectedMode) {
                LeaveScreenMode.MY_REQUESTS -> leavesUiState.myRequests
                LeaveScreenMode.REVIEW -> leavesUiState.requests
                LeaveScreenMode.REPORT -> leavesUiState.reportRequests
            }

            if (displayed.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Default.EventBusy, contentDescription = "فارغ", tint = SlateLight, modifier = Modifier.size(64.dp))
                        Text("لا توجد طلبات إجازات مطابقة لشرط التصفية.", color = SlateLight, modifier = Modifier.padding(top = 10.dp))
                    }
                }
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    items(displayed) { request ->
                        LeaveRequestCard(
                            request = request,
                            mode = leavesUiState.selectedMode,
                            currentEmployeeId = leavesUiState.currentEmployeeId,
                            canApprove = leavesUiState.canApprove,
                            onApprove = { viewModel.approveLeaveRequest(request) },
                            onReject = { rejectTarget = request },
                            onCancel = { viewModel.requestLeaveCancellation(request) },
                            onTimeline = {
                                viewModel.openTimeline(
                                    com.example.domain.model.TimelineKind.LEAVE,
                                    request.id
                                )
                            }
                        )
                    }
                }
            }
        }
    }

    if (isRequestDialogOpen) {
        LeaveRequestDialog(
            isDarkTheme = viewModel.isDarkTheme,
            onDismiss = { isRequestDialogOpen = false },
            onSubmit = { type, start, end, days, reason, exitReentry, visaPaid ->
                viewModel.submitLeaveRequest(type, start, end, days, reason, exitReentry, visaPaid)
                isRequestDialogOpen = false
            }
        )
    }

    rejectTarget?.let { target ->
        LeaveRejectDialog(
            isDarkTheme = viewModel.isDarkTheme,
            onDismiss = { rejectTarget = null },
            onConfirm = { reason ->
                viewModel.rejectLeaveRequest(target, reason)
                rejectTarget = null
            }
        )
    }

    leavesUiState.cancelTarget?.let { request ->
        AlertDialog(
            onDismissRequest = { viewModel.dismissLeaveCancellation() },
            icon = { Icon(Icons.Default.EventBusy, contentDescription = null, tint = RedStatus) },
            title = { Text("إلغاء طلب الإجازة") },
            text = { Text("هل تريد إلغاء طلب ${request.leaveType} من ${request.startDate} إلى ${request.endDate}؟") },
            confirmButton = {
                TextButton(onClick = { viewModel.confirmLeaveCancellation() }) {
                    Text("تأكيد الإلغاء", color = RedStatus)
                }
            },
            dismissButton = {
                TextButton(onClick = { viewModel.dismissLeaveCancellation() }) {
                    Text("التراجع")
                }
            }
        )
    }
}

@Composable
private fun LeaveReportSummaryRow(
    summary: com.example.domain.model.LeaveReportSummary,
    isDarkTheme: Boolean
) {
    val stats = listOf(
        "الإجمالي" to summary.total,
        "لدى الموارد" to summary.pendingHr,
        "لدى الإدارة" to summary.pendingAdmin,
        "معتمدة" to summary.approved,
        "مرفوضة" to summary.rejected,
        "ملغاة" to summary.cancelled,
        "مجموع الأيام" to summary.totalDays
    )
    LazyRow(
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        items(stats) { (label, value) ->
            Card(
                modifier = Modifier.width(112.dp),
                shape = RoundedCornerShape(6.dp),
                colors = CardDefaults.cardColors(
                    containerColor = if (isDarkTheme) SlateMedium else EmeraldBg.copy(alpha = 0.45f)
                )
            ) {
                Column(modifier = Modifier.padding(10.dp)) {
                    Text(label, fontSize = 10.sp, color = SlateLight, maxLines = 1)
                    Text(value.toString(), fontWeight = FontWeight.Bold, color = EmeraldMain, fontSize = 18.sp)
                }
            }
        }
    }
}

@Composable
fun LeaveRequestCard(
    request: LeaveRequestParams,
    mode: LeaveScreenMode,
    currentEmployeeId: String?,
    canApprove: Boolean,
    onApprove: () -> Unit,
    onReject: () -> Unit,
    onCancel: () -> Unit,
    onTimeline: (() -> Unit)? = null
) {
    val statusColor = leaveStatusColor(request.status)
    val isPending = request.isPendingHr() || request.isPendingAdmin()
    val isOwnRequest = request.employeeId == currentEmployeeId
    val canCancel = mode == LeaveScreenMode.MY_REQUESTS && canCancelOwnLeave(request, currentEmployeeId)
    val canReview = mode == LeaveScreenMode.REVIEW && canApprove && isPending && !isOwnRequest
    val statusLabel = when {
        request.isPendingHr() -> "قيد مراجعة الموارد البشرية"
        request.isPendingAdmin() -> "بانتظار موافقة الإدارة"
        else -> request.status
    }
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (isSystemInDarkTheme()) SlateMedium else Color.White
        )
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        request.employeeName,
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.titleMedium,
                        color = if (isSystemInDarkTheme()) Color.White else SlateDark
                    )
                    Text(
                        "${request.departmentName} • ${request.leaveType}",
                        fontSize = 11.sp,
                        color = SlateLight
                    )
                }
                Box(
                    modifier = Modifier
                        .background(statusColor.copy(alpha = 0.15f), RoundedCornerShape(8.dp))
                        .padding(vertical = 4.dp, horizontal = 12.dp)
                ) {
                    Text(statusLabel, fontWeight = FontWeight.Bold, fontSize = 11.sp, color = statusColor)
                }
            }

            Spacer(modifier = Modifier.height(10.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.DateRange, contentDescription = "التاريخ", tint = SlateLight, modifier = Modifier.size(14.dp))
                Spacer(modifier = Modifier.width(4.dp))
                Text("${request.startDate} ← ${request.endDate}", fontSize = 12.sp, color = SlateLight)
                Spacer(modifier = Modifier.width(12.dp))
                Text("${request.totalDays} يوم", fontSize = 12.sp, color = EmeraldMain, fontWeight = FontWeight.Bold)
            }

            if (request.reason.isNotBlank()) {
                Spacer(modifier = Modifier.height(6.dp))
                Text("السبب: ${request.reason}", fontSize = 11.sp, color = SlateLight)
            }

            request.approvedBy?.let {
                Spacer(modifier = Modifier.height(4.dp))
                Text("اعتمد بواسطة: $it", fontSize = 10.sp, color = EmeraldMain)
            }
            request.rejectionReason?.let {
                Spacer(modifier = Modifier.height(4.dp))
                Text("سبب الرفض: $it", fontSize = 10.sp, color = RedStatus)
            }

            onTimeline?.let { openTimeline ->
                Spacer(modifier = Modifier.height(4.dp))
                TextButton(onClick = openTimeline, contentPadding = PaddingValues(0.dp)) {
                    Icon(
                        Icons.Default.History,
                        contentDescription = null,
                        tint = SlateLight,
                        modifier = Modifier.size(14.dp)
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(
                        stringResource(R.string.timeline_action),
                        fontSize = 11.sp,
                        color = SlateLight
                    )
                }
            }

            if (canCancel || canReview) {
                Spacer(modifier = Modifier.height(12.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    if (canCancel) {
                        TextButton(onClick = onCancel) {
                            Icon(Icons.Default.EventBusy, contentDescription = null, tint = RedStatus, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("إلغاء الطلب", color = RedStatus, fontSize = 11.sp)
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                    }
                    if (canReview) {
                        Button(
                            onClick = onReject,
                            colors = ButtonDefaults.buttonColors(containerColor = RedStatus.copy(alpha = 0.2f)),
                            shape = RoundedCornerShape(6.dp),
                            modifier = Modifier.padding(end = 8.dp)
                        ) {
                            Text("رفض", color = RedStatus, fontSize = 11.sp)
                        }
                        Button(
                            onClick = onApprove,
                            colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain),
                            shape = RoundedCornerShape(6.dp)
                        ) {
                            Icon(Icons.Default.CheckCircle, contentDescription = "موافقة", tint = SlateDark, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("اعتماد", color = SlateDark, fontWeight = FontWeight.Bold, fontSize = 11.sp)
                        }
                    }
                }
            } else if (mode == LeaveScreenMode.REVIEW && isPending && isOwnRequest) {
                Spacer(modifier = Modifier.height(8.dp))
                Text("لا يمكنك اعتماد أو رفض طلبك الشخصي.", color = AmberStatus, fontSize = 11.sp)
            }
        }
    }
}

@Composable
fun LeaveRequestDialog(
    isDarkTheme: Boolean,
    onDismiss: () -> Unit,
    onSubmit: (type: String, start: String, end: String, days: Int, reason: String, exitReentryRequested: Boolean, visaFeePaid: Boolean) -> Unit
) {
    // Dates are chosen via date pickers and stored as ISO yyyy-MM-dd (UTC), which
    // is exactly what the backend expects. Manual typing is no longer possible,
    // removing the class of "bad date format" 400 errors.
    val todayIso = remember { com.example.core.utils.DateUtils.todayIso() }
    var type by remember { mutableStateOf("سنوية") }
    var start by remember { mutableStateOf(todayIso) }
    var end by remember { mutableStateOf(todayIso) }
    // Days are auto-calculated from the selected range (inclusive) and shown read-only.
    val days = remember(start, end) { com.example.core.utils.DateUtils.inclusiveDayCount(start, end) }
    var reason by remember { mutableStateOf("") }
    // Exit/re-entry visa applies to annual leave only (backend contract).
    var exitReentryRequested by remember { mutableStateOf(false) }
    var visaFeePaid by remember { mutableStateOf(false) }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
            shape = RoundedCornerShape(16.dp),
            color = if (isDarkTheme) SlateMedium else Color.White
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text(
                    "تقديم طلب إجازة",
                    fontWeight = FontWeight.Bold,
                    style = MaterialTheme.typography.titleMedium,
                    color = if (isDarkTheme) Color.White else SlateDark
                )
                Spacer(modifier = Modifier.height(12.dp))

                Text("نوع الإجازة:", style = MaterialTheme.typography.bodySmall, color = SlateLight)
                val types = listOf("سنوية", "مرضية", "طارئة", "بدون راتب", "دراسية")
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    types.forEach { t ->
                        val s = type == t
                        FilterChip(
                            selected = s,
                            onClick = {
                                type = t
                                if (t != "سنوية") {
                                    exitReentryRequested = false
                                    visaFeePaid = false
                                }
                            },
                            label = { Text(t, fontSize = 11.sp) }
                        )
                    }
                }
                Spacer(modifier = Modifier.height(8.dp))

                if (type == "سنوية") {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Checkbox(
                            checked = exitReentryRequested,
                            onCheckedChange = {
                                exitReentryRequested = it
                                if (!it) visaFeePaid = false
                            }
                        )
                        Text("خروج وعودة", color = if (isDarkTheme) Color.White else SlateDark, fontSize = 13.sp)
                    }
                    if (exitReentryRequested) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Checkbox(
                                checked = visaFeePaid,
                                onCheckedChange = { visaFeePaid = it }
                            )
                            Text("تم دفع رسوم التأشيرة", color = if (isDarkTheme) Color.White else SlateDark, fontSize = 13.sp)
                        }
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                }

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    IsoDatePickerField(
                        label = stringResource(R.string.leave_date_from),
                        isoValue = start,
                        onIsoSelected = { picked ->
                            start = picked
                            // Keep end on/after start.
                            if (!com.example.ui.ux.MawaredDateFieldLogic.isStartOnOrBeforeEnd(picked, end) && end.isNotBlank()) {
                                end = picked
                            }
                        },
                        modifier = Modifier.weight(1f)
                    )
                    IsoDatePickerField(
                        label = stringResource(R.string.leave_date_to),
                        isoValue = end,
                        onIsoSelected = { picked ->
                            if (start.isNotBlank() &&
                                !com.example.ui.ux.MawaredDateFieldLogic.isStartOnOrBeforeEnd(start, picked)
                            ) {
                                end = start
                            } else {
                                end = picked
                            }
                        },
                        modifier = Modifier.weight(1f)
                    )
                }
                Spacer(modifier = Modifier.height(8.dp))

                OutlinedTextField(
                    value = days.toString(),
                    onValueChange = { },
                    label = { Text("عدد الأيام (يُحتسب تلقائياً)") },
                    readOnly = true,
                    enabled = false,
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(8.dp))

                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it },
                    label = { Text("سبب الإجازة") },
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(modifier = Modifier.height(16.dp))

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text("إلغاء", color = SlateLight) }
                    Spacer(modifier = Modifier.width(8.dp))
                    Button(
                        onClick = {
                            if (start.isNotBlank() && end.isNotBlank()) {
                                onSubmit(type, start.trim(), end.trim(), days, reason.trim(), exitReentryRequested, visaFeePaid)
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain)
                    ) {
                        Text("إرسال الطلب", color = SlateDark, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

@Composable
fun LeaveRejectDialog(
    isDarkTheme: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (reason: String) -> Unit
) {
    var reason by remember { mutableStateOf("") }
    Dialog(onDismissRequest = onDismiss) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            color = if (isDarkTheme) SlateMedium else Color.White
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text(
                    "رفض طلب الإجازة",
                    fontWeight = FontWeight.Bold,
                    style = MaterialTheme.typography.titleMedium,
                    color = if (isDarkTheme) Color.White else SlateDark
                )
                Spacer(modifier = Modifier.height(12.dp))
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it },
                    label = { Text("سبب الرفض") },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(16.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text("تراجع", color = SlateLight) }
                    Spacer(modifier = Modifier.width(8.dp))
                    Button(
                        onClick = { onConfirm(reason.trim()) },
                        colors = ButtonDefaults.buttonColors(containerColor = RedStatus)
                    ) {
                        Text("تأكيد الرفض", color = Color.White, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

/**
 * Read-only field that opens a Material date picker and returns the picked date
 * as ISO yyyy-MM-dd. Replaces manual date typing (source of "bad date" 400s).
 * Sprint 12D: wraps shared [com.example.ui.ux.MawaredDateField].
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IsoDatePickerField(
    label: String,
    isoValue: String,
    onIsoSelected: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    var showPicker by remember { mutableStateOf(false) }
    val isValid = isoValue.isBlank() || com.example.ui.ux.MawaredDateFieldLogic.isValidIso(isoValue)
    val displayText = if (isoValue.isBlank()) {
        ""
    } else {
        com.example.ui.ux.MawaredDateFieldLogic.formatDisplayDdMmYyyy(isoValue)
    }

    com.example.ui.ux.MawaredDateField(
        isoDate = isoValue,
        label = label,
        modifier = modifier,
        isError = !isValid,
        supportingText = if (!isValid) stringResource(R.string.ux_date_invalid_iso) else null,
        displayText = displayText,
        onOpenPicker = { showPicker = true }
    )

    if (showPicker) {
        val initialMillis = com.example.core.utils.DateUtils.epochMillisFromIso(isoValue)
        val state = rememberDatePickerState(initialSelectedDateMillis = initialMillis)
        DatePickerDialog(
            onDismissRequest = { showPicker = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { onIsoSelected(com.example.core.utils.DateUtils.isoFromEpochMillis(it)) }
                    showPicker = false
                }) { Text(stringResource(R.string.ux_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { showPicker = false }) {
                    Text(stringResource(R.string.ux_cancel))
                }
            }
        ) {
            DatePicker(
                state = state,
                title = {
                    Text(
                        stringResource(R.string.ux_date_picker_title),
                        modifier = Modifier.padding(start = 24.dp, end = 12.dp, top = 16.dp)
                    )
                }
            )
        }
    }
}

// ---------------- TAB 11: PAYROLL (مسير الرواتب) ----------------
// Driven entirely by PayrollUiState. Authorization is canView / canCalculate / canApprove
// (derived from CurrentSession.permissions via PermissionChecker). No role/name checks.
