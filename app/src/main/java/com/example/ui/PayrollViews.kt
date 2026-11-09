package com.example.ui

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import com.example.domain.model.canApprove
import com.example.domain.model.canCalculate
import com.example.domain.model.canReport
import com.example.domain.model.PAYROLL_ADMIN_PAID_WARNING
import com.example.domain.model.PAYROLL_PROTECTED_DATA_NOTICE
import com.example.domain.model.PAYROLL_SECOND_PERSON_NOTICE
import com.example.ui.theme.*
import com.example.ui.ux.MawaredScrollableForm
import com.example.ui.ux.MawaredTextField
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

private fun payrollStatusColor(status: String): Color = when (status) {
    "paid", "approved" -> EmeraldMain
    "calculated" -> AmberStatus
    "draft" -> SlateLight
    else -> SlateLight
}

private fun formatPayrollMoney(value: String?): String =
    value?.let { "$it ر.س" } ?: "غير متاح"

private fun arabicMonth(month: Int): String = when (month) {
    1 -> "يناير"; 2 -> "فبراير"; 3 -> "مارس"; 4 -> "أبريل"; 5 -> "مايو"; 6 -> "يونيو"
    7 -> "يوليو"; 8 -> "أغسطس"; 9 -> "سبتمبر"; 10 -> "أكتوبر"; 11 -> "نوفمبر"; 12 -> "ديسمبر"
    else -> month.toString()
}

@Composable
fun MawaredPayrollManager(viewModel: MawaredViewModel) {
    val payrollUiState by viewModel.payrollUiState.collectAsState()
    val context = LocalContext.current

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        if (!payrollUiState.canView) {
            // Friendly no-permission state: user lacks payroll.view / finance.view.
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.Lock, contentDescription = "لا توجد صلاحية", tint = SlateLight, modifier = Modifier.size(64.dp))
                    Text(
                        "لا تملك صلاحية عرض مسير الرواتب.",
                        color = SlateLight,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(top = 12.dp)
                    )
                    Text(
                        "يتطلب الوصول صلاحية payroll.view.",
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
                        text = "مسير الرواتب",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = if (viewModel.isDarkTheme) Color.White else SlateDark
                    )
                    Text(
                        "احتساب واعتماد مسيرات الأجور الشهرية حسب الصلاحية",
                        fontSize = 11.sp,
                        color = SlateLight
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { viewModel.refreshPayroll() }) {
                        Icon(Icons.Default.Refresh, contentDescription = "تحديث", tint = EmeraldMain)
                    }
                    if (payrollUiState.canManage) {
                        IconButton(onClick = { viewModel.openPayrollCreateDialog() }) {
                            Icon(Icons.Default.Add, contentDescription = "إنشاء فترة", tint = EmeraldMain)
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                if (payrollUiState.isLoading) {
                    item { LinearProgressIndicator(modifier = Modifier.fillMaxWidth(), color = EmeraldMain) }
                }
                // Summary cards
                item {
                    val summary = payrollUiState.summary
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        PayrollStatCard("صافي المعتمد", formatPayrollMoney(summary?.totalNetPayroll), EmeraldMain)
                        PayrollStatCard("الفترات", (summary?.totalPeriods ?: 0).toString(), AmberStatus)
                        PayrollStatCard("فترات معتمدة", (summary?.approvedPeriods ?: 0).toString(), EmeraldMain)
                        PayrollStatCard("فترات مدفوعة", (summary?.paidPeriods ?: 0).toString(), MintLight)
                    }
                }

                item {
                    Text(
                        "فترات الرواتب",
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp,
                        color = if (viewModel.isDarkTheme) Color.White else SlateDark
                    )
                }

                if (payrollUiState.periods.isEmpty()) {
                    item {
                        Box(modifier = Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                            Text("لا توجد فترات رواتب. أنشئ فترة جديدة للبدء.", color = SlateLight)
                        }
                    }
                } else {
                    items(payrollUiState.periods) { period ->
                        PayrollPeriodCard(
                            period = period,
                            isSelected = period.id == payrollUiState.selectedPeriodId,
                            canManage = payrollUiState.canManage,
                            canApprove = payrollUiState.canApprove,
                            canReport = payrollUiState.canReport,
                            onSelect = { viewModel.selectPayrollPeriod(period.id) },
                            onCalculate = { viewModel.requestPayrollCalculation(period.id) },
                            onApprove = { viewModel.requestPayrollApproval(period.id) },
                            onReport = { viewModel.loadPayrollReport(period.id) }
                        )
                    }
                }

                payrollUiState.errorMessage?.let { errorMessage ->
                    item {
                        Text(
                            errorMessage,
                            color = RedStatus,
                            fontSize = 12.sp,
                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)
                        )
                    }
                }

                if (payrollUiState.blockers.isNotEmpty() || payrollUiState.protectedEmployeeIssues > 0) {
                    item {
                        Card(colors = CardDefaults.cardColors(containerColor = RedStatus.copy(alpha = 0.08f))) {
                            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("تعذر إكمال الاحتساب", fontWeight = FontWeight.Bold, color = RedStatus)
                                payrollUiState.blockers.forEach { blocker ->
                                    Text(
                                        listOfNotNull(blocker.employeeName, blocker.employeeNum, blocker.message).joinToString(" - "),
                                        fontSize = 11.sp,
                                        color = SlateLight
                                    )
                                }
                                if (payrollUiState.protectedEmployeeIssues > 0) {
                                    Text(
                                        "توجد ${payrollUiState.protectedEmployeeIssues} مشكلة تخص بيانات مالية محمية غير ظاهرة.",
                                        fontSize = 11.sp,
                                        color = SlateLight
                                    )
                                }
                            }
                        }
                    }
                }

                if (payrollUiState.protectedRowsHidden) {
                    item {
                        Text(
                            "$PAYROLL_PROTECTED_DATA_NOTICE (${payrollUiState.protectedRowCount}).",
                            color = AmberStatus,
                            fontSize = 11.sp,
                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)
                        )
                    }
                }

                if (payrollUiState.selectedPeriod?.legacyWithoutItems == true) {
                    item {
                        Text(
                            "هذه فترة قديمة تحتوي بيانات حالة فقط، ولا تتوفر لها عناصر أو إجماليات رواتب.",
                            color = AmberStatus,
                            fontSize = 11.sp,
                            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)
                        )
                    }
                }

                // Selected period items breakdown
                if (payrollUiState.selectedPeriodId != null && payrollUiState.selectedPeriodItems.isNotEmpty()) {
                    val net = payrollUiState.selectedPeriod?.visibleSummary?.net
                    item {
                        Spacer(modifier = Modifier.height(4.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                "تفاصيل المسير المحدد",
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp,
                                color = if (viewModel.isDarkTheme) Color.White else SlateDark
                            )
                            Text("الإجمالي: ${formatPayrollMoney(net)}", fontWeight = FontWeight.Bold, fontSize = 12.sp, color = EmeraldMain)
                        }
                    }
                    items(payrollUiState.selectedPeriodItems) { itemRow ->
                        PayrollItemCard(itemRow)
                    }
                }

                val loadedReport = payrollUiState.report
                    ?.takeIf { it.period.id == payrollUiState.selectedPeriodId }
                if (loadedReport != null) {
                    item {
                        Card(colors = CardDefaults.cardColors(containerColor = EmeraldMain.copy(alpha = 0.08f))) {
                            Column(modifier = Modifier.fillMaxWidth().padding(12.dp)) {
                                Text("تقرير الفترة المعتمد", fontWeight = FontWeight.Bold, color = EmeraldMain)
                                Text(
                                    "${loadedReport.rows.size} صف ظاهر • الصافي ${formatPayrollMoney(loadedReport.visibleSummary?.net)}",
                                    color = SlateLight,
                                    fontSize = 11.sp
                                )
                            }
                        }
                    }
                }

                // Sprint 12H: payroll partial payments (v2) + exports — shown for the
                // selected period, under the item breakdown, when the user can view payments.
                val paymentsPeriod = payrollUiState.periods.firstOrNull { it.id == payrollUiState.selectedPeriodId }
                if (payrollUiState.canViewPayments && paymentsPeriod != null) {
                    item {
                        Spacer(modifier = Modifier.height(4.dp))
                        Card(colors = CardDefaults.cardColors(containerColor = if (isSystemInDarkTheme()) SlateMedium else Color.White)) {
                            Column(modifier = Modifier.fillMaxWidth().padding(12.dp)) {
                                PayrollPaymentsSection(
                                    period = paymentsPeriod,
                                    payments = payrollUiState.payments,
                                    isLoading = payrollUiState.paymentsLoading,
                                    canRecord = payrollUiState.canRecordPayment,
                                    canVoid = payrollUiState.canVoidPayment,
                                    isDarkTheme = viewModel.isDarkTheme,
                                    onRecordPayment = viewModel::openRecordPaymentDialog,
                                    onVoidPayment = viewModel::requestVoidPayment
                                )
                                if (payrollUiState.canExportPayroll) {
                                    PayrollExportActions(
                                        period = paymentsPeriod,
                                        exportingFormat = payrollUiState.exportingFormat,
                                        onExport = viewModel::exportPayrollPeriod
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    LaunchedEffect(payrollUiState.pendingPaymentExportShare?.uri) {
        val share = payrollUiState.pendingPaymentExportShare ?: return@LaunchedEffect
        try {
            val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                type = share.mimeType
                putExtra(android.content.Intent.EXTRA_STREAM, share.uri)
                addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(android.content.Intent.createChooser(intent, "مشاركة ملف مسير الرواتب"))
        } catch (_: Exception) {
            viewModel.showNotification("تعذرت مشاركة ملف التصدير")
        } finally {
            viewModel.consumePayrollExportShare()
        }
    }

    if (payrollUiState.showRecordPaymentDialog) {
        PayrollRecordPaymentDialog(
            isDarkTheme = viewModel.isDarkTheme,
            onDismiss = viewModel::dismissPayrollDialogs,
            onSubmit = { amount, paymentDate, reference, note ->
                viewModel.submitPayrollPayment(amount, paymentDate, reference, note)
            }
        )
    }

    payrollUiState.voidPaymentTarget?.let { target ->
        PayrollVoidPaymentConfirmation(
            payment = target,
            onDismiss = viewModel::dismissPayrollDialogs,
            onConfirm = { reason -> viewModel.confirmVoidPayment(reason) }
        )
    }

    if (payrollUiState.showCreateDialog) {
        PayrollCreatePeriodDialog(
            isDarkTheme = viewModel.isDarkTheme,
            onDismiss = viewModel::dismissPayrollDialogs,
            onCreate = viewModel::createPayrollPeriod
        )
    }

    payrollUiState.calculationTarget?.let { target ->
        PayrollCalculationConfirmation(
            period = target,
            reason = payrollUiState.recalculationReason,
            onReasonChange = viewModel::updatePayrollRecalculationReason,
            onDismiss = viewModel::dismissPayrollDialogs,
            onConfirm = viewModel::confirmPayrollCalculation
        )
    }

    payrollUiState.approvalTarget?.let { target ->
        AlertDialog(
            onDismissRequest = viewModel::dismissPayrollDialogs,
            title = { Text("اعتماد فترة ${target.month}/${target.year}") },
            text = { Text(PAYROLL_SECOND_PERSON_NOTICE) },
            confirmButton = { TextButton(onClick = viewModel::confirmPayrollApproval) { Text("اعتماد") } },
            dismissButton = { TextButton(onClick = viewModel::dismissPayrollDialogs) { Text("إلغاء") } }
        )
    }

    payrollUiState.paidTarget?.let { target ->
        AlertDialog(
            onDismissRequest = viewModel::dismissPayrollDialogs,
            title = { Text("تأكيد دفع ${target.month}/${target.year}") },
            text = { Text(PAYROLL_ADMIN_PAID_WARNING) },
            confirmButton = { TextButton(onClick = viewModel::confirmPayrollPaid) { Text("تأكيد إداري") } },
            dismissButton = { TextButton(onClick = viewModel::dismissPayrollDialogs) { Text("إلغاء") } }
        )
    }
}

@Composable
fun PayrollStatCard(label: String, value: String, color: Color) {
    Surface(
        color = color.copy(alpha = 0.12f),
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, color.copy(alpha = 0.3f))
    ) {
        Column(
            modifier = Modifier.padding(vertical = 10.dp, horizontal = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(value, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp, color = color, maxLines = 1)
            Text(label, fontSize = 10.sp, color = SlateLight)
        }
    }
}

@Composable
fun PayrollPeriodCard(
    period: com.example.domain.model.PayrollPeriodParams,
    isSelected: Boolean,
    canManage: Boolean,
    canApprove: Boolean,
    canReport: Boolean,
    onSelect: () -> Unit,
    onCalculate: () -> Unit,
    onApprove: () -> Unit,
    onReport: () -> Unit
) {
    val statusColor = payrollStatusColor(period.status)
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onSelect() },
        colors = CardDefaults.cardColors(
            containerColor = if (isSystemInDarkTheme()) SlateMedium else Color.White
        ),
        border = if (isSelected) BorderStroke(1.5.dp, EmeraldMain) else null
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        "فترة ${arabicMonth(period.month)} ${period.year}",
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.titleMedium,
                        color = if (isSystemInDarkTheme()) Color.White else SlateDark
                    )
                    Text("العناصر الظاهرة: ${period.itemCount}", fontSize = 10.sp, color = SlateLight)
                    Text(
                        when {
                            period.paidAt != null -> "تأكيد الدفع: ${period.paidAt}"
                            period.approvedAt != null -> "الاعتماد: ${period.approvedAt}"
                            period.calculatedAt != null -> "الاحتساب: ${period.calculatedAt}"
                            else -> "الإنشاء: ${period.createdAt}"
                        },
                        fontSize = 9.sp,
                        color = SlateLight,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Box(
                    modifier = Modifier
                        .background(statusColor.copy(alpha = 0.15f), RoundedCornerShape(8.dp))
                        .padding(vertical = 4.dp, horizontal = 12.dp)
                ) {
                    Text(period.arabicStatus(), fontWeight = FontWeight.Bold, fontSize = 11.sp, color = statusColor)
                }
            }

            if (period.legacyWithoutItems) {
                Spacer(modifier = Modifier.height(8.dp))
                Text("بيانات حالة قديمة بلا عناصر", color = AmberStatus, fontSize = 10.sp)
            }

            if ((canManage && period.canCalculate()) ||
                (canApprove && period.canApprove()) ||
                (canReport && period.canReport())
            ) {
                Spacer(modifier = Modifier.height(12.dp))
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    if (canManage && period.canCalculate()) {
                        OutlinedButton(onClick = onCalculate, shape = RoundedCornerShape(6.dp)) {
                            Icon(Icons.Default.Calculate, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text(if (period.status == "calculated") "إعادة التحقق" else "احتساب", fontSize = 11.sp)
                        }
                    }
                    if (canApprove && period.canApprove()) {
                        Button(onClick = onApprove, shape = RoundedCornerShape(6.dp)) {
                            Icon(Icons.Default.CheckCircle, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("اعتماد", fontSize = 11.sp)
                        }
                    }
                    if (canReport && period.canReport()) {
                        OutlinedButton(onClick = onReport, shape = RoundedCornerShape(6.dp)) {
                            Icon(Icons.Default.Assessment, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("التقرير", fontSize = 11.sp)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun PayrollItemCard(item: com.example.domain.model.PayrollItemParams) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (isSystemInDarkTheme()) SlateMedium.copy(alpha = 0.6f) else Color(0xFFF8FAFC)
        )
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        item.employeeName,
                        fontWeight = FontWeight.Bold,
                        fontSize = 13.sp,
                        color = if (isSystemInDarkTheme()) Color.White else SlateDark
                    )
                    Text(
                        listOfNotNull(item.employeeNum, item.departmentName).joinToString(" • "),
                        fontSize = 10.sp,
                        color = SlateLight
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text("الصافي", fontSize = 9.sp, color = SlateLight)
                    Text(formatPayrollMoney(item.netPay), fontWeight = FontWeight.ExtraBold, fontSize = 13.sp, color = EmeraldMain)
                }
            }
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                "الراتب الأساسي ${formatPayrollMoney(item.baseSalary)} • الإجمالي ${formatPayrollMoney(item.grossPay)}",
                fontSize = 9.sp,
                color = SlateLight
            )
            Text(
                "الخصومات ${formatPayrollMoney(item.totalDeductions)} • العملة ${item.currency}",
                fontSize = 9.sp,
                color = SlateLight
            )
        }
    }
}

@Composable
fun PayrollCreatePeriodDialog(
    isDarkTheme: Boolean,
    onDismiss: () -> Unit,
    onCreate: (month: Int, year: Int) -> Unit
) {
    val today = remember { java.util.Calendar.getInstance() }
    var month by remember { mutableStateOf((today.get(java.util.Calendar.MONTH) + 1).toString()) }
    var year by remember { mutableStateOf(today.get(java.util.Calendar.YEAR).toString()) }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            color = if (isDarkTheme) SlateMedium else Color.White
        ) {
            MawaredScrollableForm(modifier = Modifier.padding(20.dp)) {
                Text(
                    "إنشاء فترة رواتب",
                    fontWeight = FontWeight.Bold,
                    style = MaterialTheme.typography.titleMedium,
                    color = if (isDarkTheme) Color.White else SlateDark
                )
                Spacer(modifier = Modifier.height(12.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    MawaredTextField(
                        value = month,
                        onValueChange = { month = it },
                        label = "الشهر (1-12)",
                        keyboardType = KeyboardType.Number,
                        modifier = Modifier.weight(1f)
                    )
                    MawaredTextField(
                        value = year,
                        onValueChange = { year = it },
                        label = "السنة",
                        keyboardType = KeyboardType.Number,
                        modifier = Modifier.weight(1f)
                    )
                }
                Spacer(modifier = Modifier.height(16.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text("إلغاء", color = SlateLight) }
                    Spacer(modifier = Modifier.width(8.dp))
                    Button(
                        onClick = {
                            val m = month.toIntOrNull()
                            val y = year.toIntOrNull()
                            if (m != null && m in 1..12 && y != null && y in 2020..2100) {
                                onCreate(m, y)
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain)
                    ) {
                        Text("إنشاء مسودة", color = SlateDark, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

@Composable
private fun PayrollCalculationConfirmation(
    period: com.example.domain.model.PayrollPeriodParams,
    reason: String,
    onReasonChange: (String) -> Unit,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(if (period.status == "calculated") "إعادة التحقق من الاحتساب" else "احتساب فترة الرواتب")
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("سيتم احتساب الراتب الأساسي فقط للفترة ${period.month}/${period.year}.")
                Text("لا يشمل هذا الإصدار البدلات أو الخصومات أو الاحتساب الجزئي.", color = SlateLight, fontSize = 11.sp)
                if (period.status == "calculated") {
                    OutlinedTextField(
                        value = reason,
                        onValueChange = onReasonChange,
                        label = { Text("سبب إعادة الاحتساب عند تغير المدخلات") },
                        supportingText = { Text("يمكن تركه فارغاً للتحقق المتطابق فقط") },
                        minLines = 2,
                        maxLines = 4,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text("متابعة") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } }
    )
}

// ---------------- TAB 4: INTERNAL CORPORATE REAL-TIME CHAT (repository-based) ----------------
// Driven entirely by ChatUiState. canUseChat = chat.view; channels are permission-filtered in the
// ViewModel. No legacy MawaredRepository, no Arabic role/name checks (ownership via isMine).
