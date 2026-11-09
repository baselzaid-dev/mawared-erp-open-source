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
import com.example.data.demo.DemoLoginProfiles
import com.example.data.model.Employee
import com.example.data.model.PurchaseOrder
import com.example.data.model.ChatMessage
import com.example.data.model.Task
import com.example.data.model.TrainingCourse
import com.example.data.model.TrainingAssignment
import com.example.domain.model.arabicStatus
import com.example.domain.model.PAYROLL_PROTECTED_DATA_NOTICE
import com.example.ui.theme.*
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

private fun formatReportMoney(value: String?): String =
    value?.let { "$it ر.س" } ?: "غير متاح"

@Composable
fun MawaredFinancialReports(viewModel: MawaredViewModel) {
    // Reports screen is driven entirely by ReportsUiState (totals computed in the ViewModel).
    // Authorization is canViewReports / canViewFinancialReports (from CurrentSession.permissions
    // via PermissionChecker). No legacy aliases, no inline calculations, no role/name checks.
    val state by viewModel.reportsUiState.collectAsState()

    val accessibleTypes = buildList {
        if (state.canViewReports) { add("ملخص"); add("أقسام") }
        if (state.canViewFinancialReports) add("مالي")
    }
    val effectiveType = if (state.selectedReportType in accessibleTypes) state.selectedReportType
        else accessibleTypes.firstOrNull() ?: "ملخص"

    if (!state.canViewReports && !state.canViewFinancialReports) {
        Box(modifier = Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Default.Lock, contentDescription = "لا توجد صلاحية", tint = SlateLight, modifier = Modifier.size(64.dp))
                Text("لا تملك صلاحية عرض التقارير.", color = SlateLight, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 12.dp))
                Text(
                    "يتطلب الوصول صلاحية reports.view أو reports.finance أو payroll.report.",
                    color = SlateLight, fontSize = 11.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp)
                )
            }
        }
        return
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "نظام التقارير الموحّدة",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = if (viewModel.isDarkTheme) Color.White else SlateDark
                    )
                    Text(
                        "تقارير موحّدة من الموظفين والمشتريات والحضور والإجازات والرواتب",
                        fontSize = 11.sp,
                        color = SlateLight
                    )
                }
                IconButton(onClick = { viewModel.refreshReports() }) {
                    Icon(Icons.Default.Refresh, contentDescription = "تحديث", tint = EmeraldMain)
                }
            }
        }

        // Report type selector (only tabs the user is allowed to see)
        item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(accessibleTypes) { t ->
                    val s = effectiveType == t
                    FilterChip(
                        selected = s,
                        onClick = { viewModel.updateSelectedReportType(t) },
                        label = { Text(t, fontSize = 11.sp, color = if (s) SlateDark else SlateLight) },
                        colors = FilterChipDefaults.filterChipColors(selectedContainerColor = EmeraldMain)
                    )
                }
            }
        }

        when (effectiveType) {
            "ملخص" -> reportsSummarySection(state, viewModel.isDarkTheme)
            "أقسام" -> reportsDepartmentsSection(state, viewModel.isDarkTheme)
            "مالي" -> reportsFinancialSection(state, viewModel)
        }
    }
}

private fun LazyListScope.reportsSummarySection(state: ReportsUiState, isDark: Boolean) {
    val s = state.summary
    item {
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            PayrollStatCard("إجمالي الموظفين", s.totalEmployees.toString(), EmeraldMain)
            PayrollStatCard("نشطون", s.activeEmployees.toString(), EmeraldMain)
            PayrollStatCard("حضور اليوم", s.attendanceTodayCount.toString(), AmberStatus)
            PayrollStatCard("غياب اليوم", s.absentTodayCount.toString(), RedStatus)
        }
    }
    item {
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            PayrollStatCard("إجازات معلقة", s.pendingLeaves.toString(), AmberStatus)
            PayrollStatCard("إجازات معتمدة", s.approvedLeaves.toString(), EmeraldMain)
            PayrollStatCard("طلبات شراء", s.totalPurchaseOrders.toString(), MintLight)
            PayrollStatCard("شراء معلق", s.pendingPurchaseOrders.toString(), AmberStatus)
            PayrollStatCard("شراء معتمد", s.approvedPurchaseOrders.toString(), EmeraldMain)
        }
    }
    if (state.canViewPayrollReport) {
        item {
            Card(colors = CardDefaults.cardColors(containerColor = if (isDark) SlateMedium else Color.White)) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        "نظرة عامة على الرواتب",
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.titleMedium,
                        color = if (isDark) Color.White else SlateDark
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    ReportLedgerRow("عدد فترات الرواتب", s.payrollPeriodsCount.toString(), isDark)
                    ReportLedgerRow("صافي آخر تقرير معتمد", formatReportMoney(s.latestPayrollNetTotal), isDark, textTint = EmeraldMain)
                    ReportLedgerRow("إجمالي صافي الفترات المعتمدة والمدفوعة", formatReportMoney(s.totalPayrollNetAmount), isDark, textTint = EmeraldMain)
                }
            }
        }
    }
}

private fun LazyListScope.reportsDepartmentsSection(state: ReportsUiState, isDark: Boolean) {
    if (state.departmentReports.isEmpty()) {
        item {
            Box(modifier = Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                Text("لا توجد بيانات أقسام متاحة.", color = SlateLight)
            }
        }
    } else {
        items(state.departmentReports) { dept ->
            DepartmentReportCard(dept, isDark)
        }
    }
}

private fun LazyListScope.reportsFinancialSection(state: ReportsUiState, viewModel: MawaredViewModel) {
    val f = state.financial
    val isDark = viewModel.isDarkTheme

    val reportablePeriods = state.payrollPeriods.filter { it.status == "approved" || it.status == "paid" }

    // Immutable report period selector.
    item {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("فترة تقرير الرواتب", fontWeight = FontWeight.Bold, color = if (isDark) Color.White else SlateDark)
            if (reportablePeriods.isEmpty()) {
                Text("لا توجد فترة رواتب معتمدة أو مدفوعة متاحة للتقرير.", color = SlateLight, fontSize = 11.sp)
            } else {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(reportablePeriods) { period ->
                        FilterChip(
                            selected = state.payrollReport?.period?.id == period.id,
                            onClick = { viewModel.loadPayrollReport(period.id) },
                            label = { Text("${period.month}/${period.year} • ${period.arabicStatus()}") }
                        )
                    }
                }
            }
        }
    }

    if (!state.canViewPayrollReport) {
        item {
            Text("عرض تقرير الرواتب يتطلب صلاحية payroll.report.", color = SlateLight, fontSize = 11.sp)
        }
    } else if (state.payrollReport == null) {
        item {
            Text("اختر فترة معتمدة أو مدفوعة لعرض بيانات التقرير.", color = SlateLight, fontSize = 11.sp)
        }
    } else {
        item {
            Card(colors = CardDefaults.cardColors(containerColor = if (isDark) SlateMedium else Color.White)) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("تفاصيل مسير الرواتب المعتمد", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium, color = if (isDark) Color.White else SlateDark)
                    Spacer(modifier = Modifier.height(12.dp))
                    ReportLedgerRow("إجمالي الرواتب", formatReportMoney(state.payrollReport.visibleSummary?.gross), isDark)
                    ReportLedgerRow("إجمالي الخصومات", formatReportMoney(f.totalDeductions), isDark, textTint = RedStatus)
                    ReportLedgerRow("صافي الرواتب", formatReportMoney(f.totalPayroll), isDark, textTint = EmeraldMain)
                    ReportLedgerRow("البدلات والحوافز", "غير مطبقة في الإصدار الحالي", isDark)
                    Divider(modifier = Modifier.padding(vertical = 8.dp))
                    ReportLedgerRow("الفترة", f.latestPayrollPeriod ?: "غير متاح", isDark)
                }
            }
        }
        if (state.payrollReport.protectedRowsHidden) {
            item {
                Text(
                    "$PAYROLL_PROTECTED_DATA_NOTICE (${state.payrollReport.protectedRowCount}).",
                    color = AmberStatus,
                    fontSize = 11.sp
                )
            }
        }
        items(state.payrollReport.rows) { row ->
            Card(colors = CardDefaults.cardColors(containerColor = if (isDark) SlateMedium else Color.White)) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(row.employeeName, fontWeight = FontWeight.Bold, color = if (isDark) Color.White else SlateDark)
                        Text(listOfNotNull(row.employeeNum, row.departmentName).joinToString(" • "), fontSize = 10.sp, color = SlateLight)
                    }
                    Text(formatReportMoney(row.netPay), fontWeight = FontWeight.Bold, color = EmeraldMain)
                }
            }
        }
    }

    // Procurement budget
    item {
        Card(colors = CardDefaults.cardColors(containerColor = if (isDark) SlateMedium else Color.White)) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("ميزانية المشتريات التشغيلية", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium, color = if (isDark) Color.White else SlateDark)
                Spacer(modifier = Modifier.height(12.dp))
                ReportLedgerRow("المشتريات المعتمدة المصروفة", formatCurrency(f.totalPurchasing), isDark, textTint = EmeraldMain)
            }
        }
    }

    if (f.estimatedNetCost != null) {
        item {
            Card(colors = CardDefaults.cardColors(containerColor = EmeraldBg)) {
                Row(
                    modifier = Modifier.padding(16.dp).fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("التكلفة الصافية التقديرية (رواتب + مشتريات)", fontWeight = FontWeight.Bold, color = Color.White, modifier = Modifier.weight(1f))
                    Text(formatReportMoney(f.estimatedNetCost), fontWeight = FontWeight.ExtraBold, color = MintLight, style = MaterialTheme.typography.titleMedium)
                }
            }
        }
    }
}

@Composable
fun DepartmentReportCard(dept: com.example.domain.model.DepartmentReportParams, isDark: Boolean) {
    Card(colors = CardDefaults.cardColors(containerColor = if (isDark) SlateMedium else Color.White)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(dept.departmentName, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium, color = if (isDark) Color.White else SlateDark)
                Text(formatReportMoney(dept.payrollTotal), fontWeight = FontWeight.ExtraBold, fontSize = 13.sp, color = EmeraldMain)
            }
            Spacer(modifier = Modifier.height(8.dp))
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("موظفون: ${dept.employeeCount}", fontSize = 11.sp, color = SlateLight)
                Text("حضور: ${dept.attendanceCount}", fontSize = 11.sp, color = EmeraldMain)
                Text("إجازات: ${dept.leaveCount}", fontSize = 11.sp, color = AmberStatus)
            }
        }
    }
}

@Composable
fun ReportLedgerRow(title: String, amount: String, isDark: Boolean, textTint: Color? = null) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 5.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(title, fontSize = 12.sp, color = SlateLight)
        Text(
            amount,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            color = textTint ?: if (isDark) Color.White else SlateDark
        )
    }
}


// ---------------- TAB 5: DAILY TASKS & ALERTS ----------------
