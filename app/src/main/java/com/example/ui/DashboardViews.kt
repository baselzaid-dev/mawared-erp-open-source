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
import com.example.ui.navigation.ResourceDescriptor
import com.example.ui.theme.*
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

private fun formatDashboardPayrollMoney(value: String?): String =
    value?.let { "$it ر.س" } ?: "غير متاح"

@Composable
fun MawaredGeneralDashboard(
    viewModel: MawaredViewModel,
    user: LoggedInState.Authenticated,
    onMetricClick: ((ResourceDescriptor) -> Unit)? = null
) {
    // Dashboard is driven by DashboardUiState (consolidated in the ViewModel). No legacy aliases,
    // no inline totals. `user` is used for the greeting DISPLAY only (no role/name checks).
    val dash by viewModel.dashboardUiState.collectAsState()
    val s = dash.summary
    val payrollAmount = s.latestPayrollNetTotal?.toBigDecimalOrNull()
    val purchaseAmount = s.approvedPurchaseAmount.toBigDecimalOrNull() ?: java.math.BigDecimal.ZERO
    val totalBudget = payrollAmount?.add(purchaseAmount)
    val payrollRatio = if (payrollAmount != null && totalBudget != null && totalBudget.signum() > 0) {
        payrollAmount.divide(totalBudget, 6, java.math.RoundingMode.HALF_UP).toFloat()
    } else {
        null
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Quick interactive welcome card — dark keeps emerald hero; light uses soft mint container
        item {
            val welcomeContainer =
                if (viewModel.isDarkTheme) EmeraldBg else MaterialTheme.colorScheme.primaryContainer
            val welcomeTitle =
                if (viewModel.isDarkTheme) Color.White else MaterialTheme.colorScheme.onPrimaryContainer
            val welcomeSubtitle =
                if (viewModel.isDarkTheme) MintLight else MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.82f)
            val welcomeIconTint =
                if (viewModel.isDarkTheme) Color.White else MaterialTheme.colorScheme.onPrimaryContainer
            Card(
                colors = CardDefaults.cardColors(containerColor = welcomeContainer),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier
                        .padding(16.dp)
                        .fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "أهلاً بك مجدداً، ${user.userName} 👋",
                            style = MaterialTheme.typography.titleMedium,
                            color = welcomeTitle,
                            fontWeight = FontWeight.Bold
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                modifier = Modifier
                                    .background(EmeraldMain.copy(alpha = 0.2f), RoundedCornerShape(8.dp))
                                    .padding(vertical = 4.dp, horizontal = 10.dp)
                            ) {
                                Text(
                                    "صلاحية: ${user.userRole}",
                                    fontSize = 11.sp,
                                    color = EmeraldMain,
                                    fontWeight = FontWeight.Bold
                                )
                            }
                            IconButton(onClick = { viewModel.refreshDashboard() }, modifier = Modifier.size(32.dp)) {
                                Icon(Icons.Default.Refresh, contentDescription = "تحديث", tint = welcomeIconTint, modifier = Modifier.size(18.dp))
                            }
                        }
                    }
                    Text(
                        text = "نظام موارد يتابع العمليات اللحظية لكافة قطاعات الموظفين والمشتريات بأمان فائق.",
                        style = MaterialTheme.typography.bodySmall,
                        color = welcomeSubtitle,
                        modifier = Modifier.padding(top = 6.dp)
                    )
                }
            }
        }

        // Stats Ledger Rows (from DashboardUiState.summary)
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                DashboardStatCard(
                    title = stringResource(R.string.dashboard_metric_total_employees),
                    value = stringResource(R.string.dashboard_metric_employees_count, s.totalEmployees),
                    icon = Icons.Default.Groups,
                    color = BlueStatus,
                    modifier = Modifier.weight(1f),
                    onClick = dashboardMetricClickHandler(
                        metric = DashboardMetric.TotalEmployees,
                        onMetricClick = onMetricClick
                    )
                )
                DashboardStatCard(
                    title = stringResource(R.string.dashboard_metric_present_today),
                    value = stringResource(R.string.dashboard_metric_present_count, s.presentToday),
                    icon = Icons.Default.AccessTime,
                    color = EmeraldMain,
                    modifier = Modifier.weight(1f),
                    onClick = dashboardMetricClickHandler(
                        metric = DashboardMetric.PresentToday,
                        onMetricClick = onMetricClick
                    )
                )
            }
        }

        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                DashboardStatCard(
                    title = stringResource(R.string.dashboard_metric_pending_leaves),
                    value = stringResource(R.string.dashboard_metric_requests_count, s.pendingLeaves),
                    icon = Icons.Default.EventNote,
                    color = AmberStatus,
                    modifier = Modifier.weight(1f),
                    onClick = dashboardMetricClickHandler(
                        metric = DashboardMetric.PendingLeaves,
                        onMetricClick = onMetricClick
                    )
                )
                DashboardStatCard(
                    title = stringResource(R.string.dashboard_metric_pending_purchases),
                    value = stringResource(R.string.dashboard_metric_requests_count, s.pendingPurchaseRequests),
                    icon = Icons.Default.AddTask,
                    color = AmberStatus,
                    modifier = Modifier.weight(1f),
                    onClick = dashboardMetricClickHandler(
                        metric = DashboardMetric.PendingPurchases,
                        onMetricClick = onMetricClick
                    )
                )
            }
        }

        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                DashboardStatCard(
                    title = "صافي آخر مسير رواتب",
                    value = formatDashboardPayrollMoney(s.latestPayrollNetTotal),
                    icon = Icons.Default.AccountBalanceWallet,
                    color = EmeraldMain,
                    modifier = Modifier.weight(1f),
                    onClick = dashboardMetricClickHandler(
                        metric = DashboardMetric.LatestPayrollNet,
                        onMetricClick = onMetricClick
                    )
                )
                DashboardStatCard(
                    title = "النفقات المعتمدة",
                    value = formatCurrency(s.approvedPurchaseAmount),
                    icon = Icons.Default.Analytics,
                    color = RedStatus,
                    modifier = Modifier.weight(1f),
                    onClick = dashboardMetricClickHandler(
                        metric = DashboardMetric.ApprovedSpend,
                        onMetricClick = onMetricClick
                    )
                )
            }
        }

        // Budget ring chart (values come from DashboardUiState.summary; only ratios drawn here)
        item {
            Card(
                colors = CardDefaults.cardColors(
                    containerColor = if (viewModel.isDarkTheme) SlateMedium else Color.White
                ),
                border = BorderStroke(1.dp, if (viewModel.isDarkTheme) SlateMedium else Color(0xFFE2E8F0)),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "التقرير التحليلي اللحظي للموازنة",
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.titleMedium,
                        color = if (viewModel.isDarkTheme) Color.White else SlateDark
                    )
                    Text(
                        text = "توزيع الموارد المالية بين الرواتب والإنفاق المشترياتي المعتمد",
                        fontSize = 11.sp,
                        color = SlateLight,
                        modifier = Modifier.padding(bottom = 16.dp)
                    )

                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(130.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        if (payrollRatio != null) {
                            Canvas(modifier = Modifier.size(110.dp)) {
                                val sweepSalaries = payrollRatio * 360f
                                val sweepPurchases = (1f - payrollRatio) * 360f
                                drawArc(
                                    color = EmeraldMain,
                                    startAngle = -90f,
                                    sweepAngle = sweepSalaries,
                                    useCenter = false,
                                    style = Stroke(width = 18f, cap = StrokeCap.Round)
                                )
                                drawArc(
                                    color = RedStatus,
                                    startAngle = -90f + sweepSalaries,
                                    sweepAngle = sweepPurchases,
                                    useCenter = false,
                                    style = Stroke(width = 18f, cap = StrokeCap.Round)
                                )
                            }
                        }

                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("السيولة النشطة", style = MaterialTheme.typography.bodySmall, color = SlateLight, fontSize = 10.sp)
                            Text(
                                totalBudget?.setScale(2, java.math.RoundingMode.HALF_UP)?.toPlainString()?.let { "$it ر.س" }
                                    ?: "لا يتوفر تقرير رواتب معتمد",
                                fontWeight = FontWeight.Bold,
                                style = MaterialTheme.typography.bodySmall,
                                color = if (viewModel.isDarkTheme) Color.White else SlateDark
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceAround
                    ) {
                        LegendLabel(color = EmeraldMain, label = "كتلة الرواتب والتعويضات")
                        LegendLabel(color = RedStatus, label = "اعتمادات المشتريات المباشرة")
                    }
                }
            }
        }

        // Alerts (from DashboardUiState.alerts)
        item {
            Card(
                colors = CardDefaults.cardColors(containerColor = if (viewModel.isDarkTheme) SlateMedium else Color.White),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        "التنبيهات والإجراءات المطلوبة",
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.titleMedium,
                        color = if (viewModel.isDarkTheme) Color.White else SlateDark
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    if (dash.alerts.isEmpty()) {
                        Text("لا توجد تنبيهات حالياً. كل العمليات تحت السيطرة.", fontSize = 12.sp, color = SlateLight, modifier = Modifier.padding(vertical = 8.dp))
                    } else {
                        dash.alerts.forEach { alert ->
                            val priorityColor = if (alert.priority == "عالية") RedStatus else AmberStatus
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Box(modifier = Modifier.size(8.dp).background(priorityColor, CircleShape))
                                Spacer(modifier = Modifier.width(10.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(alert.title, fontSize = 12.sp, fontWeight = FontWeight.Bold, color = if (viewModel.isDarkTheme) Color.White else SlateDark)
                                    Text(alert.message, fontSize = 10.sp, color = SlateLight)
                                }
                            }
                        }
                    }
                }
            }
        }

        // Quick actions (from DashboardUiState.quickActions; enabled = module canView)
        item {
            Column {
                Text(
                    "وصول سريع",
                    fontWeight = FontWeight.Bold,
                    style = MaterialTheme.typography.titleMedium,
                    color = if (viewModel.isDarkTheme) Color.White else SlateDark,
                    modifier = Modifier.padding(bottom = 8.dp)
                )
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(dash.quickActions) { action ->
                        Button(
                            onClick = { viewModel.currentSelectedTab = action.targetTab },
                            enabled = action.enabled,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = EmeraldMain,
                                disabledContainerColor = SlateLight.copy(alpha = 0.2f)
                            ),
                            shape = RoundedCornerShape(10.dp)
                        ) {
                            Text(
                                action.title,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold,
                                color = if (action.enabled) SlateDark else SlateLight
                            )
                        }
                    }
                }
            }
        }

        // Scoped Training summary from the API-backed repository state.
        item {
            val trainingState by viewModel.trainingUiState.collectAsState()
            val trainingSummary = trainingDashboardSummary(trainingState)

            if (trainingState.canView) Card(
                colors = CardDefaults.cardColors(
                    containerColor = if (viewModel.isDarkTheme) SlateMedium else Color.White
                ),
                border = BorderStroke(1.dp, if (viewModel.isDarkTheme) SlateMedium else Color(0xFFE2E8F0)),
                onClick = {
                    if (trainingState.canView) viewModel.currentSelectedTab = MawaredNavigation.TAB_TRAINING
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier
                        .padding(16.dp)
                        .fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Row(
                        modifier = Modifier.weight(1f),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Box(
                            modifier = Modifier
                                .background(EmeraldMain.copy(alpha = 0.15f), RoundedCornerShape(10.dp))
                                .padding(12.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.School,
                                contentDescription = null,
                                tint = EmeraldMain,
                                modifier = Modifier.size(24.dp)
                            )
                        }
                        Spacer(modifier = Modifier.width(12.dp))
                        Column {
                            Text(
                                text = "برامج التدريب والتأهيل المستمر",
                                fontWeight = FontWeight.Bold,
                                style = MaterialTheme.typography.titleMedium,
                                color = if (viewModel.isDarkTheme) Color.White else SlateDark
                            )
                            Text(
                                text = trainingSummary,
                                fontSize = 11.sp,
                                color = SlateLight
                            )
                        }
                    }

                    Icon(
                        imageVector = Icons.Default.ArrowBack,
                        contentDescription = "الانتقال للتدريب",
                        tint = EmeraldMain,
                        modifier = Modifier
                            .size(20.dp)
                            .rotate(180f)
                    )
                }
            }
        }

        item { Spacer(modifier = Modifier.height(20.dp)) }
    }
}

internal fun trainingDashboardSummary(state: TrainingUiState): String = when {
    !state.canView -> "لا توجد صلاحية لعرض التدريب."
    state.canReview -> {
        val pending = state.assignments.count { it.status == "submitted" }
        "طلبات إكمال بانتظار المراجعة: $pending"
    }
    state.canViewDepartment && state.report != null ->
        "تكليفات القسم المتأخرة: ${state.report.summary.overdueCount}"
    state.canViewDepartment && state.selectedMode == "department" ->
        "تكليفات القسم الظاهرة: ${state.assignments.size}"
    else -> {
        val active = state.assignments.count { it.status in setOf("assigned", "in_progress", "returned") }
        "دوراتي المسندة أو قيد التدريب: $active"
    }
}

internal fun dashboardMetricClickHandler(
    metric: DashboardMetric,
    onMetricClick: ((ResourceDescriptor) -> Unit)?
): (() -> Unit)? {
    if (onMetricClick == null) return null
    val descriptor = DashboardMetricDeepLinks.clickableDescriptor(metric) ?: return null
    return { onMetricClick(descriptor) }
}

@Composable
fun DashboardStatCard(
    title: String,
    value: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    color: Color,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null
) {
    val cardModifier = if (onClick != null) {
        modifier.clickable(onClick = onClick)
    } else {
        modifier
    }
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, color.copy(alpha = 0.15f)),
        modifier = cardModifier
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Icon(
                imageVector = icon,
                contentDescription = title,
                tint = color,
                modifier = Modifier.size(24.dp)
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(title, fontSize = 11.sp, color = SlateLight)
            Text(
                value,
                fontWeight = FontWeight.ExtraBold,
                fontSize = 15.sp,
                color = if (isSystemInDarkTheme()) Color.White else SlateDark,
                modifier = Modifier.padding(top = 4.dp),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
fun LegendLabel(color: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .background(color, CircleShape)
        )
        Spacer(modifier = Modifier.width(6.dp))
        Text(label, fontSize = 10.sp, color = SlateLight)
    }
}

// ---------------- TAB 1: EMPLOYEES DIRECTORY & FINANCES ----------------
