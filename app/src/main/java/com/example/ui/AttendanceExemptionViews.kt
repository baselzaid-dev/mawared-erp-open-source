package com.example.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.EventBusy
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.domain.model.AttendanceExemption
import com.example.domain.model.AttendanceExemptionReasonCategory
import com.example.domain.model.AttendanceExemptionStatus
import com.example.domain.model.AttendanceExemptionStatusFilter
import com.example.ui.theme.AmberStatus
import com.example.ui.theme.EmeraldMain
import com.example.ui.theme.RedStatus
import com.example.ui.theme.SlateDark
import com.example.ui.theme.SlateLight
import com.example.ui.ux.MawaredEmptyState
import com.example.ui.ux.MawaredErrorState
import com.example.ui.ux.MawaredLoadingState
import com.example.ui.ux.MawaredScrollableForm
import com.example.ui.ux.MawaredTextField
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

private fun exemptionStatusColor(status: AttendanceExemptionStatus): Color = when (status) {
    AttendanceExemptionStatus.ACTIVE -> EmeraldMain
    AttendanceExemptionStatus.REVOKED -> RedStatus
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AttendanceExemptionScreen(
    state: AttendanceExemptionScreenState,
    actions: AttendanceExemptionActions,
    modifier: Modifier = Modifier,
    onLoad: () -> Unit = {}
) {
    LaunchedEffect(Unit) { onLoad() }

    if (!state.canView) {
        AttendanceExemptionNoPermissionState(modifier = modifier)
        return
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("إعفاءات الحضور", fontWeight = FontWeight.Bold)
                        Text(
                            if (state.canManage) "إدارة إعفاءات الموظفين من تسجيل الحضور"
                            else "عرض إعفاءاتك من تسجيل الحضور",
                            style = MaterialTheme.typography.bodySmall,
                            color = SlateLight
                        )
                    }
                },
                actions = {
                    if (state.canManage) {
                        IconButton(
                            onClick = actions::onOpenCreateDialog,
                            enabled = !state.isSubmitting
                        ) {
                            Icon(Icons.Default.Add, contentDescription = "إضافة إعفاء")
                        }
                    }
                    IconButton(
                        onClick = actions::onRefresh,
                        enabled = !state.isSubmitting
                    ) {
                        Icon(Icons.Default.Refresh, contentDescription = "تحديث")
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
            if (state.isSubmitting) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }

            state.successMessage?.let { message ->
                Snackbar(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    action = { TextButton(onClick = actions::clearMessages) { Text("حسنًا") } }
                ) { Text(message) }
            }

            state.actionErrorMessage?.let { message ->
                Snackbar(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    action = { TextButton(onClick = actions::clearMessages) { Text("إغلاق") } }
                ) { Text(message) }
            }

            AttendanceExemptionStatusFilters(
                selected = (state.listState as? AttendanceExemptionListState.Content)?.statusFilter
                    ?: AttendanceExemptionStatusFilter.ALL,
                onSelect = actions::onStatusFilterSelected
            )

            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp)
            ) {
                when (val listState = state.listState) {
                    AttendanceExemptionListState.Loading -> {
                        MawaredLoadingState(
                            modifier = Modifier.align(Alignment.Center),
                            message = "جاري تحميل إعفاءات الحضور..."
                        )
                    }

                    is AttendanceExemptionListState.Error -> {
                        MawaredErrorState(
                            modifier = Modifier.align(Alignment.Center),
                            message = listState.message,
                            retryLabel = "إعادة المحاولة",
                            onRetry = actions::onRetry
                        )
                    }

                    AttendanceExemptionListState.Empty -> {
                        MawaredEmptyState(
                            modifier = Modifier.align(Alignment.Center),
                            title = "لا توجد إعفاءات",
                            detail = if (state.canManage) {
                                "لم يتم تسجيل أي إعفاء حضور بعد. استخدم زر الإضافة لإنشاء إعفاء جديد."
                            } else {
                                "لا يوجد لديك إعفاءات حضور مسجلة حاليًا."
                            }
                        )
                    }

                    is AttendanceExemptionListState.Content -> {
                        if (listState.items.isEmpty()) {
                            MawaredEmptyState(
                                modifier = Modifier.align(Alignment.Center),
                                title = "لا توجد نتائج",
                                detail = "لا توجد إعفاءات مطابقة للحالة المحددة."
                            )
                        } else {
                            LazyColumn(
                                contentPadding = PaddingValues(vertical = 8.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                items(listState.items, key = { it.id }) { exemption ->
                                    AttendanceExemptionCard(
                                        exemption = exemption,
                                        canManage = state.canManage,
                                        onRevoke = { actions.onOpenRevokeDialog(exemption) }
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (state.showCreateDialog) {
        AttendanceExemptionCreateDialog(
            eligibleTargets = state.eligibleTargets,
            isSubmitting = state.isSubmitting,
            onDismiss = actions::onDismissCreateDialog,
            onSubmit = actions::onCreateExemption
        )
    }

    state.revokingExemption?.let { exemption ->
        AttendanceExemptionRevokeDialog(
            exemption = exemption,
            isSubmitting = state.isSubmitting,
            onDismiss = actions::onDismissRevokeDialog,
            onConfirm = actions::onRevokeExemption
        )
    }
}

@Composable
private fun AttendanceExemptionNoPermissionState(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                Icons.Default.Lock,
                contentDescription = null,
                tint = SlateLight,
                modifier = Modifier.padding(bottom = 12.dp)
            )
            MawaredEmptyState(
                title = "لا توجد صلاحية",
                detail = "يلزم تسجيل الدخول لعرض إعفاءات الحضور."
            )
        }
    }
}

@Composable
private fun AttendanceExemptionStatusFilters(
    selected: AttendanceExemptionStatusFilter,
    onSelect: (AttendanceExemptionStatusFilter) -> Unit
) {
    LazyRow(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        items(AttendanceExemptionStatusFilter.entries.toList()) { filter ->
            FilterChip(
                selected = selected == filter,
                onClick = { onSelect(filter) },
                label = { Text(filter.labelAr) },
                colors = FilterChipDefaults.filterChipColors(selectedContainerColor = EmeraldMain)
            )
        }
    }
}

@Composable
private fun AttendanceExemptionCard(
    exemption: AttendanceExemption,
    canManage: Boolean,
    onRevoke: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Default.EventBusy,
                        contentDescription = null,
                        tint = exemptionStatusColor(exemption.status)
                    )
                    Text(
                        text = exemption.reasonCategory.labelAr,
                        modifier = Modifier.padding(start = 8.dp),
                        fontWeight = FontWeight.Bold,
                        color = SlateDark
                    )
                }
                Text(
                    text = exemption.status.labelAr,
                    color = exemptionStatusColor(exemption.status),
                    fontWeight = FontWeight.SemiBold,
                    style = MaterialTheme.typography.labelLarge
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            Text(
                text = "الفترة: ${exemption.periodLabel}",
                style = MaterialTheme.typography.bodyMedium,
                color = SlateDark
            )

            exemption.note?.takeIf { it.isNotBlank() }?.let { note ->
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "ملاحظة: $note",
                    style = MaterialTheme.typography.bodySmall,
                    color = SlateLight,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis
                )
            }

            if (canManage && exemption.status == AttendanceExemptionStatus.ACTIVE) {
                Spacer(modifier = Modifier.height(12.dp))
                OutlinedButton(
                    onClick = onRevoke,
                    modifier = Modifier.fillMaxWidth(),
                    colors = androidx.compose.material3.ButtonDefaults.outlinedButtonColors(contentColor = AmberStatus)
                ) {
                    Icon(Icons.Default.Block, contentDescription = null)
                    Spacer(modifier = Modifier.padding(horizontal = 4.dp))
                    Text("إلغاء الإعفاء")
                }
            }
        }
    }
}

@Composable
private fun AttendanceExemptionCreateDialog(
    eligibleTargets: List<AttendanceExemptionTargetUi>,
    isSubmitting: Boolean,
    onDismiss: () -> Unit,
    onSubmit: (
        targetUserId: String,
        validFrom: String,
        validUntil: String?,
        reasonCategory: AttendanceExemptionReasonCategory,
        note: String?
    ) -> Unit
) {
    var selectedTargetId by remember(eligibleTargets) {
        mutableStateOf(eligibleTargets.firstOrNull()?.userId.orEmpty())
    }
    var selectedCategory by remember { mutableStateOf(AttendanceExemptionReasonCategory.FIELD_ASSIGNMENT) }
    var validFromDate by remember { mutableStateOf(todayIsoDate()) }
    var validUntilDate by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var localError by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { if (!isSubmitting) onDismiss() },
        title = { Text("إنشاء إعفاء حضور") },
        text = {
            MawaredScrollableForm {
                if (eligibleTargets.isEmpty()) {
                    Text(
                        "لا يوجد موظفون مؤهلون. حمّل قائمة الموظفين من الشاشة الرئيسية ثم أعد المحاولة.",
                        color = AmberStatus
                    )
                } else {
                    AttendanceExemptionTargetPicker(
                        label = "الموظف",
                        targets = eligibleTargets,
                        selectedUserId = selectedTargetId,
                        onSelect = { selectedTargetId = it }
                    )
                }

                AttendanceExemptionCategoryPicker(
                    selected = selectedCategory,
                    onSelect = { selectedCategory = it }
                )

                MawaredTextField(
                    value = validFromDate,
                    onValueChange = { validFromDate = it },
                    label = "تاريخ البداية (YYYY-MM-DD)"
                )

                MawaredTextField(
                    value = validUntilDate,
                    onValueChange = { validUntilDate = it },
                    label = "تاريخ النهاية (اختياري)"
                )

                MawaredTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = "ملاحظة (اختياري)"
                )

                localError?.let { Text(it, color = RedStatus, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !isSubmitting && eligibleTargets.isNotEmpty(),
                onClick = {
                    localError = validateCreateForm(selectedTargetId, validFromDate, validUntilDate)
                    if (localError != null) return@TextButton
                    onSubmit(
                        selectedTargetId,
                        toIsoDateTime(validFromDate),
                        validUntilDate.trim().takeIf { it.isNotBlank() }?.let(::toIsoDateTime),
                        selectedCategory,
                        note
                    )
                }
            ) { Text(if (isSubmitting) "جاري الحفظ..." else "إنشاء") }
        },
        dismissButton = {
            TextButton(enabled = !isSubmitting, onClick = onDismiss) { Text("إلغاء") }
        }
    )
}

@Composable
private fun AttendanceExemptionRevokeDialog(
    exemption: AttendanceExemption,
    isSubmitting: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit
) {
    var reason by remember { mutableStateOf("") }
    var localError by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { if (!isSubmitting) onDismiss() },
        title = { Text("إلغاء إعفاء الحضور") },
        text = {
            Column {
                Text("السبب: ${exemption.reasonCategory.labelAr}")
                Text("الفترة: ${exemption.periodLabel}")
                Spacer(modifier = Modifier.height(12.dp))
                MawaredTextField(
                    value = reason,
                    onValueChange = { reason = it },
                    label = "سبب الإلغاء"
                )
                localError?.let {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(it, color = RedStatus, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !isSubmitting,
                onClick = {
                    localError = if (reason.trim().length < 3) {
                        "سبب الإلغاء يجب أن يكون 3 أحرف على الأقل."
                    } else {
                        null
                    }
                    if (localError == null) onConfirm(reason)
                }
            ) { Text(if (isSubmitting) "جاري الإلغاء..." else "تأكيد الإلغاء") }
        },
        dismissButton = {
            TextButton(enabled = !isSubmitting, onClick = onDismiss) { Text("رجوع") }
        }
    )
}

private typealias AttendanceExemptionTargetUi = com.example.domain.model.AttendanceExemptionTarget

@Composable
private fun AttendanceExemptionTargetPicker(
    label: String,
    targets: List<AttendanceExemptionTargetUi>,
    selectedUserId: String,
    onSelect: (String) -> Unit
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = targets.firstOrNull { it.userId == selectedUserId }
    Column(modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium)
        OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) {
            Text(
                selected?.let { "${it.name} — ${it.departmentName}" } ?: label,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        androidx.compose.material3.DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false }
        ) {
            targets.forEach { target ->
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text("${target.name} — ${target.departmentName}") },
                    onClick = {
                        expanded = false
                        onSelect(target.userId)
                    }
                )
            }
        }
    }
}

@Composable
private fun AttendanceExemptionCategoryPicker(
    selected: AttendanceExemptionReasonCategory,
    onSelect: (AttendanceExemptionReasonCategory) -> Unit
) {
    var expanded by remember { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
        Text("فئة السبب", style = MaterialTheme.typography.labelMedium)
        OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) {
            Text(selected.labelAr)
        }
        androidx.compose.material3.DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false }
        ) {
            AttendanceExemptionReasonCategory.entries.forEach { category ->
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text(category.labelAr) },
                    onClick = {
                        expanded = false
                        onSelect(category)
                    }
                )
            }
        }
    }
}

private fun validateCreateForm(
    targetUserId: String,
    validFromDate: String,
    validUntilDate: String
): String? = when {
    targetUserId.isBlank() -> "اختر موظفًا."
    !isValidIsoDate(validFromDate) -> "تاريخ البداية غير صالح (YYYY-MM-DD)."
    validUntilDate.isNotBlank() && !isValidIsoDate(validUntilDate) ->
        "تاريخ النهاية غير صالح (YYYY-MM-DD)."
    validUntilDate.isNotBlank() && validUntilDate < validFromDate ->
        "تاريخ النهاية يجب أن يكون بعد تاريخ البداية."
    else -> null
}

private fun isValidIsoDate(value: String): Boolean =
    value.matches(Regex("""\d{4}-\d{2}-\d{2}"""))

private fun todayIsoDate(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    .apply { timeZone = TimeZone.getTimeZone("UTC") }
    .format(Date())

private fun toIsoDateTime(date: String): String = "${date}T00:00:00.000Z"
