package com.example.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.domain.model.Department
import com.example.domain.model.ManageablePrincipal
import com.example.domain.model.TemporaryDelegation
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

private const val COMPANY_SCOPE = "__company__"

private fun authorizationIsoTime(timestamp: Long): String = SimpleDateFormat(
    "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
    Locale.US
).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(timestamp))

private fun capabilityLabel(value: String): String = when (value) {
    "company.settings.manage" -> "إدارة إعدادات الشركة"
    "company.sessions.manage" -> "إدارة جلسات الشركة"
    "permissions.manage_company" -> "إدارة صلاحيات الشركة"
    "permissions.manage_department" -> "إدارة صلاحيات القسم"
    "permissions.delegate_temporary" -> "إنشاء تفويض مؤقت"
    "principals.manage_peers" -> "إدارة مستخدمين من المستوى نفسه"
    "employees.view" -> "عرض الموظفين"
    "employees.view_department" -> "عرض موظفي القسم"
    "employees.create" -> "إضافة موظفين"
    "employees.update" -> "تعديل الموظفين"
    "employees.permissions.manage" -> "إدارة صلاحيات الموظفين"
    "attendance.view" -> "عرض الحضور"
    "attendance.view_department" -> "عرض حضور القسم"
    "attendance.manage" -> "إدارة الحضور"
    "leaves.review" -> "مراجعة الإجازات"
    "leaves.approve" -> "اعتماد الإجازات"
    "reports.view" -> "عرض التقارير"
    "reports.export" -> "تصدير التقارير"
    "salary.view_company" -> "عرض رواتب الشركة"
    "salary.manage" -> "إدارة الرواتب"
    "salary.view_owner" -> "عرض راتب المالك الأساسي"
    "tasks.create" -> "إنشاء المهام"
    "tasks.assign_department" -> "إسناد مهام داخل القسم"
    "tasks.assign_company" -> "إسناد مهام على مستوى الشركة"
    "tasks.review" -> "مراجعة المهام"
    "training.manage" -> "إدارة التدريب"
    "training.assign" -> "إسناد التدريب"
    "training.review" -> "مراجعة التدريب"
    "purchasing.review_department" -> "مراجعة مشتريات القسم"
    "purchasing.approve" -> "اعتماد المشتريات"
    else -> value.replace('.', ' ').replace('_', ' ')
}

@Composable
private fun <T> AuthorizationPicker(
    label: String,
    selected: T?,
    values: List<T>,
    display: (T) -> String,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier
) {
    var expanded by remember { mutableStateOf(false) }
    Box(modifier) {
        OutlinedButton(
            onClick = { expanded = true },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(selected?.let(display) ?: label, modifier = Modifier.weight(1f))
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            values.forEach { item ->
                DropdownMenuItem(
                    text = { Text(display(item)) },
                    onClick = {
                        expanded = false
                        onSelect(item)
                    }
                )
            }
        }
    }
}

@Composable
private fun CapabilityChecklist(
    capabilities: List<String>,
    selected: Set<String>,
    onToggle: (String) -> Unit
) {
    if (capabilities.isEmpty()) {
        Text("لا توجد صلاحيات قابلة للإدارة ضمن هذا النطاق.", style = MaterialTheme.typography.bodyMedium)
        return
    }
    capabilities.forEach { capability ->
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth()
        ) {
            Checkbox(
                checked = capability in selected,
                onCheckedChange = { onToggle(capability) }
            )
            Column(Modifier.weight(1f)) {
                Text(capabilityLabel(capability), fontWeight = FontWeight.Medium)
                Text(capability, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
fun MawaredAuthorizationManager(viewModel: MawaredViewModel) {
    val coordinator = viewModel.authorization
    val state by coordinator.state.collectAsStateWithLifecycle()
    val employeesState by viewModel.employeesUiState.collectAsStateWithLifecycle()
    val departments = employeesState.departments

    var activeMode by remember { mutableIntStateOf(0) }
    var selectedScope by remember { mutableStateOf(COMPANY_SCOPE) }
    var selectedPrincipalId by remember { mutableStateOf<String?>(null) }
    var selectedCapabilities by remember { mutableStateOf(emptySet<String>()) }
    var permissionAction by remember { mutableStateOf("grant") }
    var reason by remember { mutableStateOf("") }
    var delegationDays by remember { mutableStateOf("7") }
    var ownershipPassword by remember { mutableStateOf("") }
    var ownershipConfirmation by remember { mutableStateOf("") }

    val selectedDepartmentId = selectedScope.takeUnless { it == COMPANY_SCOPE }
    val selectedPrincipal = state.principals.firstOrNull { it.userId == selectedPrincipalId }

    LaunchedEffect(Unit) {
        viewModel.refreshEmployees()
        viewModel.refreshAuthorizationForCurrentSession()
    }
    LaunchedEffect(state.ownershipCompleted) {
        if (state.ownershipCompleted) {
            coordinator.clearOwnershipCompleted()
            viewModel.logOut()
        }
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(Icons.Default.AdminPanelSettings, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text("الملكية والصلاحيات", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text("إدارة محمية بالمعاينة والتدقيق ونسخة التفويض", style = MaterialTheme.typography.bodySmall)
            }
            IconButton(
                onClick = { viewModel.refreshAuthorizationForCurrentSession(selectedDepartmentId) },
                enabled = !state.isLoading
            ) {
                Icon(Icons.Default.Refresh, contentDescription = "تحديث")
            }
        }

        if (state.isLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.errorMessage?.let { message ->
            Snackbar(
                modifier = Modifier.padding(horizontal = 16.dp),
                action = { TextButton(onClick = coordinator::clearMessages) { Text("إغلاق") } }
            ) { Text(message) }
        }
        state.message?.let { message ->
            Snackbar(
                modifier = Modifier.padding(horizontal = 16.dp),
                action = { TextButton(onClick = coordinator::clearMessages) { Text("حسنًا") } }
            ) { Text(message) }
        }

        val modes = buildList {
            add("الصلاحيات")
            add("التفويض المؤقت")
            add("مديرو الأقسام")
            if (state.effective?.isPrimaryOwner == true) add("نقل الملكية")
        }
        ScrollableTabRow(selectedTabIndex = activeMode.coerceAtMost(modes.lastIndex.coerceAtLeast(0))) {
            modes.forEachIndexed { index, title ->
                Tab(selected = activeMode == index, onClick = { activeMode = index }, text = { Text(title) })
            }
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("نطاق الإدارة", fontWeight = FontWeight.Bold)
                        val scopes = listOf<Department?>(null) + departments
                        AuthorizationPicker(
                            label = "اختر الشركة أو القسم",
                            selected = if (selectedScope == COMPANY_SCOPE) null else departments.firstOrNull { it.id == selectedScope },
                            values = scopes,
                            display = { it?.name ?: "الشركة كاملة" },
                            onSelect = { department ->
                                selectedScope = department?.id ?: COMPANY_SCOPE
                                selectedPrincipalId = null
                                selectedCapabilities = emptySet()
                                viewModel.refreshAuthorizationForCurrentSession(department?.id)
                            }
                        )
                        AuthorizationPicker(
                            label = "اختر المستخدم",
                            selected = selectedPrincipal,
                            values = state.principals,
                            display = ManageablePrincipal::name,
                            onSelect = { principal ->
                                selectedPrincipalId = principal.userId
                                selectedCapabilities = emptySet()
                                coordinator.loadGrantable(principal.userId, selectedDepartmentId)
                            }
                        )
                    }
                }
            }

            when (activeMode) {
                0 -> {
                    item {
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Text("شجرة الصلاحيات القابلة للإدارة", fontWeight = FontWeight.Bold)
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    FilterChip(
                                        selected = permissionAction == "grant",
                                        onClick = { permissionAction = "grant" },
                                        label = { Text("منح") }
                                    )
                                    FilterChip(
                                        selected = permissionAction == "revoke",
                                        onClick = { permissionAction = "revoke" },
                                        label = { Text("إلغاء منح مباشر") }
                                    )
                                }
                                CapabilityChecklist(
                                    capabilities = state.grantable?.capabilities.orEmpty(),
                                    selected = selectedCapabilities,
                                    onToggle = { capability ->
                                        selectedCapabilities = if (capability in selectedCapabilities) {
                                            selectedCapabilities - capability
                                        } else {
                                            selectedCapabilities + capability
                                        }
                                    }
                                )
                                OutlinedTextField(
                                    value = reason,
                                    onValueChange = { reason = it },
                                    label = { Text("سبب التغيير") },
                                    modifier = Modifier.fillMaxWidth(),
                                    minLines = 2
                                )
                                Button(
                                    onClick = { coordinator.previewPermissionChanges(permissionAction, selectedCapabilities, reason) },
                                    enabled = !state.isLoading && selectedPrincipal != null && selectedCapabilities.isNotEmpty() && reason.trim().length >= 3,
                                    modifier = Modifier.fillMaxWidth()
                                ) { Text("إنشاء معاينة قبل التطبيق") }
                                if (state.effective?.isPrimaryOwner == true) {
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        OutlinedButton(
                                            onClick = { selectedPrincipal?.let { coordinator.createDelegatedAdmin(it, selectedCapabilities, reason, selectedDepartmentId) } },
                                            enabled = selectedDepartmentId == null && selectedPrincipal != null && selectedCapabilities.isNotEmpty() && reason.trim().length >= 3,
                                            modifier = Modifier.weight(1f)
                                        ) { Text("منح إدارة مفوضة") }
                                        OutlinedButton(
                                            onClick = { selectedPrincipal?.let { coordinator.revokeDelegatedAdmin(it, reason, selectedDepartmentId) } },
                                            enabled = selectedDepartmentId == null && selectedPrincipal != null && reason.trim().length >= 3,
                                            modifier = Modifier.weight(1f)
                                        ) { Text("إلغاء الإدارة المفوضة") }
                                    }
                                }
                            }
                        }
                    }
                    state.permissionPreview?.let { preview ->
                        item {
                            Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
                                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text("معاينة التغييرات", fontWeight = FontWeight.Bold)
                                    preview.changes.forEach { change ->
                                        Text("• ${capabilityLabel(change.capability)}: ${change.before} ← ${change.after}")
                                    }
                                    Text("تنتهي المعاينة خلال ${preview.expiresInSeconds / 60} دقائق", style = MaterialTheme.typography.bodySmall)
                                    Button(
                                        onClick = { coordinator.applyPermissionPreview(selectedDepartmentId) },
                                        enabled = !state.isLoading,
                                        modifier = Modifier.fillMaxWidth()
                                    ) { Text("تطبيق التغييرات المعروضة") }
                                }
                            }
                        }
                    }
                }

                1 -> {
                    item {
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Text("تفويض مؤقت جديد", fontWeight = FontWeight.Bold)
                                CapabilityChecklist(
                                    capabilities = state.grantable?.capabilities.orEmpty(),
                                    selected = selectedCapabilities,
                                    onToggle = { capability ->
                                        selectedCapabilities = if (capability in selectedCapabilities) selectedCapabilities - capability
                                        else selectedCapabilities + capability
                                    }
                                )
                                OutlinedTextField(
                                    value = delegationDays,
                                    onValueChange = { delegationDays = it.filter(Char::isDigit).take(2) },
                                    label = { Text("مدة التفويض بالأيام (1-90)") },
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                    modifier = Modifier.fillMaxWidth()
                                )
                                OutlinedTextField(
                                    value = reason,
                                    onValueChange = { reason = it },
                                    label = { Text("سبب التفويض") },
                                    modifier = Modifier.fillMaxWidth()
                                )
                                Button(
                                    onClick = {
                                        val days = delegationDays.toIntOrNull()?.coerceIn(1, 90) ?: 7
                                        val now = System.currentTimeMillis()
                                        selectedPrincipal?.let {
                                            coordinator.createDelegation(
                                                it,
                                                selectedCapabilities,
                                                selectedDepartmentId,
                                                authorizationIsoTime(now),
                                                authorizationIsoTime(now + days * 86_400_000L),
                                                reason
                                            )
                                        }
                                    },
                                    enabled = !state.isLoading && selectedPrincipal != null && selectedCapabilities.isNotEmpty() && reason.trim().length >= 3,
                                    modifier = Modifier.fillMaxWidth()
                                ) { Text("إنشاء التفويض المؤقت") }
                            }
                        }
                    }
                    if (state.delegations.isEmpty()) {
                        item { Text("لا توجد تفويضات مؤقتة ضمن النطاق المتاح.") }
                    } else {
                        items(state.delegations, key = TemporaryDelegation::id) { delegation ->
                            val recipientName = state.principals.firstOrNull { it.userId == delegation.recipientUserId }?.name
                                ?: delegation.recipientUserId.take(8)
                            Card(Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                                    Text(recipientName, fontWeight = FontWeight.Bold)
                                    Text(delegation.capabilities.joinToString { capabilityLabel(it) })
                                    Text("من ${delegation.validFrom} حتى ${delegation.validUntil}", style = MaterialTheme.typography.bodySmall)
                                    Text(if (delegation.effective) "فعال الآن" else "${delegation.status} / غير فعال")
                                    if (delegation.status == "active") {
                                        OutlinedButton(
                                            onClick = { coordinator.revokeDelegation(delegation, reason, selectedDepartmentId) },
                                            enabled = reason.trim().length >= 3 && !state.isLoading
                                        ) { Text("إلغاء التفويض") }
                                    }
                                }
                            }
                        }
                    }
                }

                2 -> {
                    item {
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Text("مديرو القسم المحدد", fontWeight = FontWeight.Bold)
                                if (selectedDepartmentId == null) {
                                    Text("اختر قسمًا من نطاق الإدارة لعرض مديريه أو إضافة مدير جديد.")
                                } else {
                                    OutlinedTextField(
                                        value = reason,
                                        onValueChange = { reason = it },
                                        label = { Text("سبب التعيين أو الإنهاء") },
                                        modifier = Modifier.fillMaxWidth()
                                    )
                                    Button(
                                        onClick = { selectedPrincipal?.let { coordinator.assignDepartmentManager(selectedDepartmentId, it, reason) } },
                                        enabled = selectedPrincipal != null && reason.trim().length >= 3 && !state.isLoading,
                                        modifier = Modifier.fillMaxWidth()
                                    ) { Text("إضافة مدير آخر للقسم") }
                                }
                            }
                        }
                    }
                    items(state.departmentManagers, key = { it.id }) { manager ->
                        Card(Modifier.fillMaxWidth()) {
                            Row(
                                Modifier.fillMaxWidth().padding(14.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(manager.name ?: manager.userId.take(8), fontWeight = FontWeight.Bold)
                                    Text("تاريخ التعيين: ${manager.assignedAt}", style = MaterialTheme.typography.bodySmall)
                                }
                                OutlinedButton(
                                    onClick = { selectedDepartmentId?.let { coordinator.revokeDepartmentManager(it, manager, reason) } },
                                    enabled = reason.trim().length >= 3 && !state.isLoading
                                ) { Text("إنهاء") }
                            }
                        }
                    }
                }

                3 -> {
                    item {
                        Card(
                            Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
                        ) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Text("نقل الملكية الأساسية", fontWeight = FontWeight.Bold)
                                Text("عملية حساسة: تتطلب كلمة المرور ومعاينة وتأكيدًا حرفيًا، ثم تُبطل جلسات المالك القديم والجديد.")
                                OutlinedTextField(
                                    value = reason,
                                    onValueChange = { reason = it },
                                    label = { Text("سبب نقل الملكية") },
                                    modifier = Modifier.fillMaxWidth()
                                )
                                OutlinedTextField(
                                    value = ownershipPassword,
                                    onValueChange = { ownershipPassword = it },
                                    label = { Text("كلمة مرور المالك الحالي") },
                                    visualTransformation = PasswordVisualTransformation(),
                                    modifier = Modifier.fillMaxWidth()
                                )
                                Button(
                                    onClick = { selectedPrincipal?.let { coordinator.previewOwnership(it, reason, ownershipPassword) } },
                                    enabled = selectedPrincipal != null && reason.trim().length >= 3 && ownershipPassword.isNotEmpty() && !state.isLoading,
                                    modifier = Modifier.fillMaxWidth()
                                ) { Text("معاينة نقل الملكية") }
                                state.ownershipPreview?.let { preview ->
                                    HorizontalDivider()
                                    Text("سيصبح ${preview.target.name} المالك الأساسي.", fontWeight = FontWeight.Bold)
                                    Text("اكتب النص التالي حرفيًا للتأكيد: ${preview.confirmationText}")
                                    OutlinedTextField(
                                        value = ownershipConfirmation,
                                        onValueChange = { ownershipConfirmation = it },
                                        label = { Text("نص التأكيد") },
                                        modifier = Modifier.fillMaxWidth()
                                    )
                                    Button(
                                        onClick = coordinator::applyOwnership,
                                        enabled = ownershipConfirmation == preview.confirmationText && !state.isLoading,
                                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                                        modifier = Modifier.fillMaxWidth()
                                    ) { Text("تنفيذ نقل الملكية وإبطال الجلسات") }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
