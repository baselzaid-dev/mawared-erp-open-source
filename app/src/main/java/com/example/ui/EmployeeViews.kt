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
import com.example.data.demo.DemoLoginProfiles
import com.example.data.model.Employee
import com.example.data.model.PurchaseOrder
import com.example.data.model.ChatMessage
import com.example.data.model.Task
import com.example.data.model.TrainingCourse
import com.example.data.model.TrainingAssignment
import com.example.ui.theme.*
import com.example.ui.ux.MawaredEmailField
import com.example.ui.ux.MawaredPasswordField
import com.example.ui.ux.MawaredScrollableForm
import com.example.ui.ux.MawaredTextField
import androidx.compose.ui.text.input.ImeAction
import kotlinx.coroutines.launch
import java.math.BigDecimal
import java.text.SimpleDateFormat
import java.text.NumberFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal fun employeeRoleIdForSubmission(
    originalRoleId: String?,
    selectedRoleId: String?,
    canChangeRole: Boolean
): String? = if (canChangeRole) selectedRoleId else originalRoleId

internal fun departmentManagerIdForSubmission(
    originalManagerId: String?,
    selectedManagerId: String?,
    canManageManager: Boolean
): String? = if (canManageManager) selectedManagerId else originalManagerId

@Composable
fun MawaredEmployeesManager(
    viewModel: MawaredViewModel
) {
    // Employees screen is driven entirely by EmployeesUiState. Authorization comes from
    // canView / canCreate / canUpdate / canDelete (derived from CurrentSession.permissions
    // via PermissionChecker). No role/name string checks are allowed in this screen.
    val employeesUiState by viewModel.employeesUiState.collectAsState()
    val salaryUiState by viewModel.salaryUiState.collectAsState()
    val authUiState by viewModel.authUiState.collectAsState()
    val securityState by viewModel.employeeSecurityController.state.collectAsState()
    val employees = viewModel.focusedEmployeeId?.let { focusedId ->
        employeesUiState.employees.filter { it.id == focusedId }
    } ?: employeesUiState.employees
    val canAdd = employeesUiState.canCreate
    val session = authUiState.currentSession
    val permissions = session?.permissions ?: emptySet()

    // Load the list when the screen first opens. The ViewModel init refresh runs
    // before login, so without this the list stays empty until another action.
    LaunchedEffect(Unit) { viewModel.refreshEmployees() }

    var isAddEmployeeDialogOpen by remember { mutableStateOf(false) }
    var selectedSection by remember { mutableIntStateOf(0) }
    var editTarget by remember { mutableStateOf<com.example.domain.model.EmployeeParams?>(null) }
    var salaryTarget by remember { mutableStateOf<com.example.domain.model.EmployeeParams?>(null) }
    var createCredentialTarget by remember { mutableStateOf<com.example.domain.model.EmployeeParams?>(null) }
    var resetCredentialTarget by remember { mutableStateOf<com.example.domain.model.EmployeeParams?>(null) }
    var archiveTarget by remember { mutableStateOf<com.example.domain.model.EmployeeParams?>(null) }
    var departmentDialogOpen by remember { mutableStateOf(false) }
    var departmentEditTarget by remember { mutableStateOf<com.example.domain.model.Department?>(null) }

    LaunchedEffect(securityState) {
        when (val state = securityState) {
            is EmployeeSecurityUiState.SuccessMessage -> {
                archiveTarget = null
                viewModel.showNotification(state.message)
                viewModel.employeeSecurityController.dismissFeedback()
            }
            is EmployeeSecurityUiState.OneTimeSecret -> {
                createCredentialTarget = null
                resetCredentialTarget = null
            }
            else -> Unit
        }
    }

    LaunchedEffect(employeesUiState.canManageDepartments, employeesUiState.canView) {
        selectedSection = when {
            employeesUiState.canManageDepartments && !employeesUiState.canView -> 1
            !employeesUiState.canManageDepartments -> 0
            else -> selectedSection
        }
    }
    LaunchedEffect(viewModel.focusedEmployeeId) {
        if (viewModel.focusedEmployeeId != null) selectedSection = 0
    }

    // Dialog state bindings
    var newEmpName by remember { mutableStateOf("") }
    var newEmpEmail by remember { mutableStateOf("") }
    var newEmpTemporaryPassword by remember { mutableStateOf("") }
    var newEmpPhone by remember { mutableStateOf("") }
    var newEmpRole by remember { mutableStateOf("") }
    var newEmpDept by remember { mutableStateOf("الموارد البشرية") }
    var newEmpStatus by remember { mutableStateOf("نشط") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        if (!employeesUiState.canView && !employeesUiState.canManageDepartments) {
            // Friendly no-permission state: user lacks employees.view.
            // The employee list (and all actions) are intentionally hidden.
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.Lock, contentDescription = "لا توجد صلاحية", tint = SlateLight, modifier = Modifier.size(64.dp))
                    Text(
                        "لا تملك صلاحية عرض سجل الموظفين.",
                        color = SlateLight,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(top = 12.dp)
                    )
                    Text(
                        "يتطلب الوصول صلاحية (employees.view). تواصل مع مدير الموارد البشرية.",
                        color = SlateLight,
                        fontSize = 11.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 4.dp)
                    )
                }
            }
        } else {
            if (employeesUiState.canManageDepartments) {
                TabRow(selectedTabIndex = selectedSection) {
                    Tab(
                        selected = selectedSection == 0,
                        onClick = { selectedSection = 0 },
                        enabled = employeesUiState.canView,
                        text = { Text("الموظفون") },
                        icon = { Icon(Icons.Default.Groups, contentDescription = null) }
                    )
                    Tab(
                        selected = selectedSection == 1,
                        onClick = { selectedSection = 1 },
                        text = { Text("الأقسام") },
                        icon = { Icon(Icons.Default.Apartment, contentDescription = null) }
                    )
                }
                Spacer(modifier = Modifier.height(12.dp))
            }

            if (selectedSection == 1) {
                DepartmentManagementSection(
                    departments = employeesUiState.departments,
                    isLoading = employeesUiState.isLoading,
                    onAdd = {
                        departmentEditTarget = null
                        departmentDialogOpen = true
                    },
                    onEdit = {
                        departmentEditTarget = it
                        departmentDialogOpen = true
                    }
                )
            } else {
            // Search and Add layout
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedTextField(
                    value = employeesUiState.searchQuery,
                    onValueChange = { viewModel.updateEmployeeSearchQuery(it) },
                    label = { Text("ابحث عن موظف...") },
                    leadingIcon = { Icon(Icons.Default.Search, contentDescription = "بحث") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedLabelColor = EmeraldMain,
                        focusedBorderColor = EmeraldMain
                    )
                )

                // Refresh button — reloads the list from the backend on demand.
                IconButton(onClick = { viewModel.refreshEmployees() }) {
                    Icon(Icons.Default.Refresh, contentDescription = "تحديث", tint = EmeraldMain)
                }

                // canAdd = EmployeesUiState.canCreate (permission-driven).
                if (canAdd) {
                    Button(
                        onClick = { isAddEmployeeDialogOpen = true },
                        colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain),
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.height(56.dp)
                    ) {
                        Icon(Icons.Default.Add, contentDescription = "إضافة", tint = SlateDark)
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("إضافة موظف", color = SlateDark, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Department Filter Quick Badges
            val departments = listOf("الكل") + employeesUiState.departments.map { it.name }
            LazyRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                items(departments) { dept ->
                    val isSelected = employeesUiState.departmentFilter == dept
                    FilterChip(
                        selected = isSelected,
                        onClick = { viewModel.updateEmployeeDepartmentFilter(dept) },
                        label = { Text(dept, fontSize = 11.sp, color = if (isSelected) SlateDark else SlateLight) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = EmeraldMain
                        )
                    )
                }
            }

            Spacer(modifier = Modifier.height(10.dp))

            // List of Employees
            if (employeesUiState.isLoading && employees.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = EmeraldMain)
                }
            } else if (employees.isEmpty()) {
                val hasFilter = employeesUiState.searchQuery.isNotBlank() ||
                    employeesUiState.departmentFilter != "الكل"
                val emptyText = if (hasFilter) {
                    "لم يتم العثور على أي موظفين مطابقين لشرط التصفية."
                } else {
                    "لا توجد بيانات موظفين. اسحب للأسفل أو اضغط زر التحديث."
                }
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Default.PersonOff, contentDescription = "فارغ", tint = SlateLight, modifier = Modifier.size(64.dp))
                        Text(emptyText, color = SlateLight, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 10.dp))
                    }
                }
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    items(employees) { emp ->
                        val record = employeesUiState.employeeRecords.firstOrNull { it.id == emp.id }
                        val ownerTarget = isProtectedAdminRole(record?.roleName)
                        val canViewSalary = employeesUiState.canViewSalaryCompany &&
                            (!ownerTarget || employeesUiState.canViewOwnerSalary)
                        val canCreateCredential = record != null &&
                            EmployeeCredentialRules.canCreateCredentialFor(record, permissions)
                        val canResetCredential = record != null &&
                            EmployeeCredentialRules.canResetCredentialFor(
                                employee = record,
                                currentUserId = session?.userId,
                                actorEmployeeId = session?.employeeId,
                                permissions = permissions,
                                isPrimaryOwnerTarget = ownerTarget
                            )
                        val canArchive = record != null &&
                            EmployeeCredentialRules.canArchiveEmployeeRecord(
                                employee = record,
                                currentUserId = session?.userId,
                                actorEmployeeId = session?.employeeId,
                                isPrimaryOwnerTarget = ownerTarget,
                                permissions = permissions
                            )
                        val isSecurityBusy = securityState is EmployeeSecurityUiState.Submitting &&
                            (securityState as EmployeeSecurityUiState.Submitting).employeeId == emp.id
                        EmployeeCardLayout(
                            employee = emp,
                            canUpdate = employeesUiState.canUpdate,
                            canDelete = employeesUiState.canDelete,
                            canViewSalary = canViewSalary,
                            canCreateCredential = canCreateCredential,
                            canResetCredential = canResetCredential,
                            canArchive = canArchive,
                            securityBusy = isSecurityBusy,
                            onEditClick = {
                                editTarget = record
                            },
                            onSalaryClick = {
                                record?.let {
                                    salaryTarget = it
                                    viewModel.loadEmployeeSalary(it)
                                }
                            },
                            onDeleteClick = { viewModel.removeEmployee(emp.id, emp.name) },
                            onCreateCredentialClick = { createCredentialTarget = record },
                            onResetCredentialClick = { resetCredentialTarget = record },
                            onArchiveClick = { archiveTarget = record },
                            onTimelineClick = {
                                viewModel.openTimeline(
                                    com.example.domain.model.TimelineKind.EMPLOYEE,
                                    emp.id
                                )
                            }
                        )
                    }
                }
            }
            }
        }
    }

    editTarget?.let { employee ->
        EmployeeEditDialog(
            employee = employee,
            roles = employeesUiState.roles,
            departments = employeesUiState.departments,
            canChangeRole = employeesUiState.canChangeRoles,
            onDismiss = { editTarget = null },
            onSave = { update ->
                viewModel.updateEmployeeDetails(employee.id, update)
                editTarget = null
            }
        )
    }

    salaryTarget?.let { employee ->
        SalaryManagementDialog(
            employee = employee,
            state = salaryUiState,
            onDismiss = {
                salaryTarget = null
                viewModel.closeEmployeeSalary()
            },
            onSave = { amount, effectiveFrom ->
                viewModel.createEmployeeSalary(employee.id, amount, effectiveFrom)
            }
        )
    }

    createCredentialTarget?.let { employee ->
        val submitting = securityState is EmployeeSecurityUiState.Submitting &&
            (securityState as EmployeeSecurityUiState.Submitting).employeeId == employee.id &&
            (securityState as EmployeeSecurityUiState.Submitting).kind ==
            EmployeeSecurityActionKind.CREATE_CREDENTIAL
        val error = (securityState as? EmployeeSecurityUiState.Error)
            ?.takeIf {
                it.employeeId == employee.id &&
                    it.kind == EmployeeSecurityActionKind.CREATE_CREDENTIAL
            }
            ?.message
        EmployeeCreateCredentialDialog(
            employeeName = employee.fullName,
            initialEmail = employee.email.orEmpty(),
            isSubmitting = submitting,
            errorMessage = error,
            onDismiss = {
                if (!submitting) {
                    createCredentialTarget = null
                    viewModel.employeeSecurityController.dismissFeedback()
                }
            },
            onConfirm = { email ->
                viewModel.employeeSecurityController.createCredential(
                    employee = employee,
                    email = email,
                    permissions = permissions
                )
            }
        )
    }

    resetCredentialTarget?.let { employee ->
        val submitting = securityState is EmployeeSecurityUiState.Submitting &&
            (securityState as EmployeeSecurityUiState.Submitting).employeeId == employee.id &&
            (securityState as EmployeeSecurityUiState.Submitting).kind ==
            EmployeeSecurityActionKind.RESET_CREDENTIAL
        val error = (securityState as? EmployeeSecurityUiState.Error)
            ?.takeIf {
                it.employeeId == employee.id &&
                    it.kind == EmployeeSecurityActionKind.RESET_CREDENTIAL
            }
            ?.message
        EmployeeResetCredentialDialog(
            employeeName = employee.fullName,
            isSubmitting = submitting,
            errorMessage = error,
            onDismiss = {
                if (!submitting) {
                    resetCredentialTarget = null
                    viewModel.employeeSecurityController.dismissFeedback()
                }
            },
            onConfirm = { reason ->
                viewModel.employeeSecurityController.resetCredential(
                    employee = employee,
                    reason = reason,
                    currentUserId = session?.userId,
                    actorEmployeeId = session?.employeeId,
                    permissions = permissions,
                    isPrimaryOwnerTarget = isProtectedAdminRole(employee.roleName)
                )
            }
        )
    }

    archiveTarget?.let { employee ->
        val submitting = securityState is EmployeeSecurityUiState.Submitting &&
            (securityState as EmployeeSecurityUiState.Submitting).employeeId == employee.id &&
            (securityState as EmployeeSecurityUiState.Submitting).kind ==
            EmployeeSecurityActionKind.ARCHIVE
        val error = (securityState as? EmployeeSecurityUiState.Error)
            ?.takeIf {
                it.employeeId == employee.id &&
                    it.kind == EmployeeSecurityActionKind.ARCHIVE
            }
            ?.message
        EmployeeArchiveConfirmDialog(
            employeeName = employee.fullName,
            isSubmitting = submitting,
            errorMessage = error,
            onDismiss = {
                if (!submitting) {
                    archiveTarget = null
                    viewModel.employeeSecurityController.dismissFeedback()
                }
            },
            onConfirm = { reason ->
                viewModel.employeeSecurityController.archiveEmployee(
                    employee = employee,
                    reason = reason,
                    currentUserId = session?.userId,
                    actorEmployeeId = session?.employeeId,
                    isPrimaryOwnerTarget = isProtectedAdminRole(employee.roleName),
                    permissions = permissions
                )
            }
        )
    }

    (securityState as? EmployeeSecurityUiState.OneTimeSecret)?.let { secret ->
        EmployeeOneTimeCredentialDialog(
            employeeName = secret.employeeName,
            credential = secret.credential,
            onDismiss = {
                createCredentialTarget = null
                resetCredentialTarget = null
                viewModel.employeeSecurityController.dismissFeedback()
            }
        )
    }

    if (departmentDialogOpen) {
        DepartmentEditDialog(
            department = departmentEditTarget,
            candidates = employeesUiState.managerCandidates,
            canManageManager = employeesUiState.canManageDepartmentManagers,
            onDismiss = { departmentDialogOpen = false },
            onSave = { name, managerId ->
                val target = departmentEditTarget
                if (target == null) viewModel.createDepartment(name, managerId)
                else viewModel.updateDepartment(target.id, name, managerId)
                departmentDialogOpen = false
            }
        )
    }

    // Add Employee Form Dialog Model
    if (isAddEmployeeDialogOpen) {
        Dialog(onDismissRequest = { isAddEmployeeDialogOpen = false }) {
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(8.dp),
                shape = RoundedCornerShape(16.dp),
                color = if (viewModel.isDarkTheme) SlateMedium else Color.White
            ) {
                MawaredScrollableForm(
                    modifier = Modifier.padding(20.dp),
                    bottomAction = {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.End
                        ) {
                            TextButton(onClick = { isAddEmployeeDialogOpen = false }) {
                                Text("إلغاء", color = SlateLight)
                            }
                            Spacer(modifier = Modifier.width(12.dp))
                            Button(
                                onClick = {
                                    if (
                                        newEmpName.isNotEmpty() &&
                                        newEmpEmail.isNotEmpty() &&
                                        newEmpTemporaryPassword.length in 8..256
                                    ) {
                                        viewModel.addEmployee(
                                            name = newEmpName,
                                            email = newEmpEmail,
                                            temporaryPassword = newEmpTemporaryPassword,
                                            phone = newEmpPhone,
                                            role = newEmpRole,
                                            department = newEmpDept,
                                            status = newEmpStatus
                                        )
                                        isAddEmployeeDialogOpen = false
                                    } else {
                                        viewModel.showNotification("أدخل الاسم والبريد وكلمة مرور مؤقتة من 8 أحرف على الأقل")
                                    }
                                },
                                colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain)
                            ) {
                                Text("حفظ الموظف", color = SlateDark, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                ) {
                    Text(
                        text = "تسجيل موظف جديد",
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.titleLarge,
                        color = if (viewModel.isDarkTheme) Color.White else SlateDark
                    )
                    Spacer(modifier = Modifier.height(16.dp))

                    MawaredTextField(
                        value = newEmpName,
                        onValueChange = { newEmpName = it },
                        label = "الاسم الكامل",
                        imeAction = ImeAction.Next
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    MawaredEmailField(
                        value = newEmpEmail,
                        onValueChange = { newEmpEmail = it },
                        label = "البريد الإلكتروني",
                        imeAction = ImeAction.Next
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    MawaredPasswordField(
                        value = newEmpTemporaryPassword,
                        onValueChange = { newEmpTemporaryPassword = it.take(256) },
                        label = "كلمة المرور المؤقتة",
                        supportingText = "8 أحرف على الأقل، وتُسلّم للموظف بشكل آمن",
                        imeAction = ImeAction.Next
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    MawaredTextField(
                        value = newEmpPhone,
                        onValueChange = { newEmpPhone = it },
                        label = "رقم الهاتف",
                        keyboardType = KeyboardType.Phone,
                        forceLtr = true,
                        imeAction = ImeAction.Next
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    MawaredTextField(
                        value = newEmpRole,
                        onValueChange = { newEmpRole = it },
                        label = "المسمى الوظيفي",
                        imeAction = ImeAction.Done
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    // Dept spinner mock
                    Text("القسم المختص:", style = MaterialTheme.typography.bodySmall, color = SlateLight)
                    val depts = listOf("الموارد البشرية", "الشؤون المالية", "تكنولوجيا المعلومات", "المشتريات", "التسويق")
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState())
                            .padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        depts.forEach { d ->
                            val s = newEmpDept == d
                            ElevatedFilterChip(
                                selected = s,
                                onClick = { newEmpDept = d },
                                label = { Text(d, fontSize = 11.sp, color = if (s) SlateDark else SlateLight) },
                                colors = FilterChipDefaults.filterChipColors(selectedContainerColor = EmeraldMain)
                            )
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EmployeeEditDialog(
    employee: com.example.domain.model.EmployeeParams,
    roles: List<com.example.domain.model.Role>,
    departments: List<com.example.domain.model.Department>,
    canChangeRole: Boolean,
    onDismiss: () -> Unit,
    onSave: (com.example.domain.model.EmployeeUpdateForm) -> Unit
) {
    var name by remember(employee.id) { mutableStateOf(employee.fullName) }
    var email by remember(employee.id) { mutableStateOf(employee.email.orEmpty()) }
    var employeeNum by remember(employee.id) { mutableStateOf(employee.employeeCode) }
    var jobTitle by remember(employee.id) { mutableStateOf(employee.jobTitle.orEmpty()) }
    var joiningDate by remember(employee.id) { mutableStateOf(employee.joiningDate.orEmpty().take(10)) }
    var roleId by remember(employee.id) { mutableStateOf(employee.roleId) }
    var departmentId by remember(employee.id) { mutableStateOf(employee.departmentId) }
    var roleExpanded by remember { mutableStateOf(false) }
    var departmentExpanded by remember { mutableStateOf(false) }
    var showDatePicker by remember { mutableStateOf(false) }
    val adminTarget = isProtectedAdminRole(employee.roleName)
    val canEditRole = canChangeRole && !adminTarget
    val selectableRoles = roles.filter { !isProtectedAdminRole(it.name) || it.id == employee.roleId }
    val datePickerState = rememberDatePickerState(
        initialSelectedDateMillis = parseEmployeeDate(joiningDate)
    )

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("تعديل بيانات الموظف") },
        text = {
            MawaredScrollableForm(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 520.dp)
            ) {
                MawaredTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = "الاسم",
                    imeAction = ImeAction.Next
                )
                Spacer(modifier = Modifier.height(10.dp))
                MawaredEmailField(
                    value = email,
                    onValueChange = { email = it },
                    label = "البريد الإلكتروني",
                    imeAction = ImeAction.Next
                )
                Spacer(modifier = Modifier.height(10.dp))
                MawaredTextField(
                    value = employeeNum,
                    onValueChange = { employeeNum = it },
                    label = "الرقم الوظيفي",
                    forceLtr = true,
                    imeAction = ImeAction.Next
                )
                Spacer(modifier = Modifier.height(10.dp))
                MawaredTextField(
                    value = jobTitle,
                    onValueChange = { jobTitle = it },
                    label = "المسمى الوظيفي",
                    imeAction = ImeAction.Next
                )
                Spacer(modifier = Modifier.height(10.dp))
                // Date + role/department dropdowns stay on OutlinedTextField
                // (read-only pickers / menu anchors are not simple text fields).
                OutlinedTextField(
                    value = joiningDate,
                    onValueChange = {},
                    label = { Text("تاريخ الالتحاق") },
                    readOnly = true,
                    singleLine = true,
                    trailingIcon = {
                        IconButton(onClick = { showDatePicker = true }) {
                            Icon(Icons.Default.CalendarMonth, contentDescription = "اختيار التاريخ")
                        }
                    },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(10.dp))

                ExposedDropdownMenuBox(
                    expanded = roleExpanded && canEditRole,
                    onExpandedChange = { if (canEditRole) roleExpanded = !roleExpanded }
                ) {
                    OutlinedTextField(
                        value = roles.firstOrNull { it.id == roleId }?.name ?: employee.roleName.orEmpty(),
                        onValueChange = {},
                        label = { Text("الدور الوظيفي") },
                        readOnly = true,
                        enabled = canEditRole,
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(roleExpanded) },
                        modifier = Modifier.menuAnchor().fillMaxWidth()
                    )
                    ExposedDropdownMenu(
                        expanded = roleExpanded,
                        onDismissRequest = { roleExpanded = false }
                    ) {
                        selectableRoles.forEach { role ->
                            DropdownMenuItem(
                                text = { Text(role.name) },
                                onClick = {
                                    roleId = role.id
                                    roleExpanded = false
                                }
                            )
                        }
                    }
                }
                if (adminTarget) {
                    Text(
                        "دور المدير العام محمي ولا يمكن تغييره من شاشة الموظفين.",
                        style = MaterialTheme.typography.bodySmall,
                        color = SlateLight
                    )
                } else if (!canChangeRole) {
                    Text(
                        "يمكنك تعديل بيانات الموظف، لكن تغيير الدور يتطلب صلاحيات إدارة أدوار الشركة.",
                        style = MaterialTheme.typography.bodySmall,
                        color = SlateLight
                    )
                }

                Spacer(modifier = Modifier.height(10.dp))
                ExposedDropdownMenuBox(
                    expanded = departmentExpanded,
                    onExpandedChange = { departmentExpanded = !departmentExpanded }
                ) {
                    OutlinedTextField(
                        value = departments.firstOrNull { it.id == departmentId }?.name ?: "بدون قسم",
                        onValueChange = {},
                        label = { Text("القسم") },
                        readOnly = true,
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(departmentExpanded) },
                        modifier = Modifier.menuAnchor().fillMaxWidth()
                    )
                    ExposedDropdownMenu(
                        expanded = departmentExpanded,
                        onDismissRequest = { departmentExpanded = false }
                    ) {
                        DropdownMenuItem(
                            text = { Text("بدون قسم") },
                            onClick = {
                                departmentId = null
                                departmentExpanded = false
                            }
                        )
                        departments.forEach { department ->
                            DropdownMenuItem(
                                text = { Text(department.name) },
                                onClick = {
                                    departmentId = department.id
                                    departmentExpanded = false
                                }
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            val submittedRoleId = employeeRoleIdForSubmission(employee.roleId, roleId, canEditRole)
            Button(
                enabled = name.isNotBlank() && email.isNotBlank() && employeeNum.isNotBlank() &&
                    jobTitle.isNotBlank() && joiningDate.isNotBlank() && !submittedRoleId.isNullOrBlank(),
                onClick = {
                    onSave(
                        com.example.domain.model.EmployeeUpdateForm(
                            name = name.trim(),
                            email = email.trim(),
                            employeeNum = employeeNum.trim(),
                            jobTitle = jobTitle.trim(),
                            joiningDate = joiningDate,
                            departmentId = departmentId,
                            roleId = submittedRoleId!!
                        )
                    )
                }
            ) { Text("حفظ") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } }
    )

    if (showDatePicker) {
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    datePickerState.selectedDateMillis?.let { joiningDate = formatEmployeeDate(it) }
                    showDatePicker = false
                }) { Text("اختيار") }
            },
            dismissButton = {
                TextButton(onClick = { showDatePicker = false }) { Text("إلغاء") }
            }
        ) {
            DatePicker(state = datePickerState)
        }
    }
}

private fun parseEmployeeDate(value: String): Long? = try {
    java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
        isLenient = false
        timeZone = java.util.TimeZone.getTimeZone("UTC")
    }.parse(value)?.time
} catch (_: Exception) {
    null
}

private fun formatEmployeeDate(value: Long): String =
    java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
        timeZone = java.util.TimeZone.getTimeZone("UTC")
    }.format(java.util.Date(value))

internal fun formatSalaryAmount(value: String): String = try {
    val formatted = NumberFormat.getNumberInstance(Locale("ar", "SA")).apply {
        minimumFractionDigits = 2
        maximumFractionDigits = 2
    }.format(BigDecimal(value))
    "$formatted SAR"
} catch (_: NumberFormatException) {
    value
}

internal fun salaryDisplayText(record: com.example.domain.model.SalaryRecordParams?): String =
    record?.let { formatSalaryAmount(it.baseSalary) } ?: "لم يتم تحديد الراتب"

private fun currentSalaryDate(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
}.format(Date())

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SalaryManagementDialog(
    employee: com.example.domain.model.EmployeeParams,
    state: SalaryUiState,
    onDismiss: () -> Unit,
    onSave: (String, String) -> Unit
) {
    var amount by remember(employee.id) { mutableStateOf("") }
    var effectiveFrom by remember(employee.id) { mutableStateOf(currentSalaryDate()) }
    var inputError by remember(employee.id) { mutableStateOf<String?>(null) }
    var showDatePicker by remember { mutableStateOf(false) }
    val datePickerState = rememberDatePickerState(
        initialSelectedDateMillis = parseEmployeeDate(effectiveFrom)
    )

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("إدارة راتب ${employee.fullName}") },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 560.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                if (state.isLoading) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                        Spacer(modifier = Modifier.width(10.dp))
                        Text("جارٍ تحميل بيانات الراتب...", color = SlateLight)
                    }
                } else {
                    Text("الراتب الحالي", style = MaterialTheme.typography.labelLarge, color = SlateLight)
                    Text(
                        salaryDisplayText(state.currentSalary),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = if (state.currentSalary == null) SlateLight else EmeraldMain
                    )
                    state.currentSalary?.let {
                        Text(
                            "ساري من ${it.effectiveFrom}",
                            style = MaterialTheme.typography.bodySmall,
                            color = SlateLight
                        )
                    }

                    HorizontalDivider(color = SlateLight.copy(alpha = 0.2f))
                    Text("سجل الرواتب", style = MaterialTheme.typography.labelLarge)
                    if (state.history.isEmpty()) {
                        Text("لا يوجد سجل رواتب سابق.", color = SlateLight)
                    } else {
                        state.history.forEach { record ->
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(formatSalaryAmount(record.baseSalary), fontWeight = FontWeight.SemiBold)
                                    Text(
                                        if (record.effectiveTo == null) {
                                            "من ${record.effectiveFrom} - الحالي"
                                        } else {
                                            "من ${record.effectiveFrom} إلى ${record.effectiveTo}"
                                        },
                                        style = MaterialTheme.typography.bodySmall,
                                        color = SlateLight
                                    )
                                }
                            }
                        }
                    }
                }

                state.errorMessage?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }

                if (state.canManage) {
                    HorizontalDivider(color = SlateLight.copy(alpha = 0.2f))
                    Text("إضافة أو تغيير الراتب", style = MaterialTheme.typography.labelLarge)
                    OutlinedTextField(
                        value = amount,
                        onValueChange = {
                            amount = it
                            inputError = null
                        },
                        label = { Text("الراتب الأساسي") },
                        trailingIcon = { Text("SAR", color = SlateLight) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        singleLine = true,
                        enabled = !state.isSaving,
                        isError = inputError != null,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = effectiveFrom,
                        onValueChange = {},
                        label = { Text("تاريخ السريان") },
                        readOnly = true,
                        singleLine = true,
                        trailingIcon = {
                            IconButton(onClick = { showDatePicker = true }, enabled = !state.isSaving) {
                                Icon(Icons.Default.CalendarMonth, contentDescription = "اختيار تاريخ السريان")
                            }
                        },
                        modifier = Modifier.fillMaxWidth()
                    )
                    inputError?.let {
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        },
        confirmButton = {
            if (state.canManage) {
                Button(
                    enabled = !state.isLoading && !state.isSaving,
                    onClick = {
                        inputError = when {
                            !isValidSalaryAmount(amount) -> "أدخل راتباً صالحاً بحد أقصى منزلتين عشريتين."
                            parseEmployeeDate(effectiveFrom) == null -> "تاريخ سريان الراتب غير صالح."
                            else -> null
                        }
                        if (inputError == null) onSave(amount.trim(), effectiveFrom)
                    }
                ) {
                    if (state.isSaving) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    } else {
                        Text("حفظ")
                    }
                }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إغلاق") } }
    )

    if (showDatePicker) {
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    datePickerState.selectedDateMillis?.let { effectiveFrom = formatEmployeeDate(it) }
                    showDatePicker = false
                }) { Text("اختيار") }
            },
            dismissButton = {
                TextButton(onClick = { showDatePicker = false }) { Text("إلغاء") }
            }
        ) {
            DatePicker(state = datePickerState)
        }
    }
}

@Composable
private fun DepartmentManagementSection(
    departments: List<com.example.domain.model.Department>,
    isLoading: Boolean,
    onAdd: () -> Unit,
    onEdit: (com.example.domain.model.Department) -> Unit
) {
    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("إدارة الأقسام", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (isLoading) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                    Spacer(modifier = Modifier.width(8.dp))
                }
                FilledIconButton(onClick = onAdd, colors = IconButtonDefaults.filledIconButtonColors(containerColor = EmeraldMain)) {
                    Icon(Icons.Default.Add, contentDescription = "إضافة قسم", tint = SlateDark)
                }
            }
        }
        Spacer(modifier = Modifier.height(12.dp))
        if (departments.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.Apartment, contentDescription = null, tint = SlateLight, modifier = Modifier.size(52.dp))
                    Text("لا توجد أقسام مسجلة حالياً.", color = SlateLight, modifier = Modifier.padding(top = 8.dp))
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(departments, key = { it.id }) { department ->
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        border = BorderStroke(1.dp, SlateLight.copy(alpha = 0.2f)),
                        colors = CardDefaults.cardColors(
                            containerColor = if (isSystemInDarkTheme()) SlateMedium else Color.White
                        )
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(14.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(Icons.Default.Apartment, contentDescription = null, tint = EmeraldMain)
                            Spacer(modifier = Modifier.width(10.dp))
                            Column(modifier = Modifier.weight(1f)) {
                                Text(department.name, fontWeight = FontWeight.Bold)
                                Text(
                                    department.managerName ?: "بدون مدير",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = SlateLight
                                )
                                Text(
                                    "الموظفون النشطون: ${department.activeEmployeeCount}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = SlateLight
                                )
                            }
                            IconButton(onClick = { onEdit(department) }) {
                                Icon(Icons.Default.Edit, contentDescription = "تعديل القسم")
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DepartmentEditDialog(
    department: com.example.domain.model.Department?,
    candidates: List<com.example.domain.model.DepartmentManagerCandidate>,
    canManageManager: Boolean,
    onDismiss: () -> Unit,
    onSave: (String, String?) -> Unit
) {
    var name by remember(department?.id) { mutableStateOf(department?.name.orEmpty()) }
    var managerId by remember(department?.id) { mutableStateOf(department?.managerId) }
    var expanded by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (department == null) "إضافة قسم" else "تعديل القسم") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("اسم القسم") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                ExposedDropdownMenuBox(
                    expanded = expanded,
                    onExpandedChange = { if (canManageManager) expanded = !expanded }
                ) {
                    OutlinedTextField(
                        value = candidates.firstOrNull { it.userId == managerId }?.name
                            ?: department?.managerName?.takeIf { managerId != null }
                            ?: "بدون مدير",
                        onValueChange = {},
                        label = { Text("مدير القسم") },
                        readOnly = true,
                        enabled = canManageManager,
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
                        modifier = Modifier.menuAnchor().fillMaxWidth()
                    )
                    ExposedDropdownMenu(
                        expanded = expanded && canManageManager,
                        onDismissRequest = { expanded = false }
                    ) {
                        DropdownMenuItem(
                            text = { Text("بدون مدير") },
                            onClick = {
                                managerId = null
                                expanded = false
                            }
                        )
                        candidates.forEach { candidate ->
                            DropdownMenuItem(
                                text = { Text("${candidate.name} - ${candidate.roleName}") },
                                onClick = {
                                    managerId = candidate.userId
                                    expanded = false
                                }
                            )
                        }
                    }
                }
                if (!canManageManager) {
                    Text(
                        "يمكنك تعديل اسم القسم، أما تغيير المدير فيتطلب صلاحيات إدارة مستخدمي الشركة.",
                        style = MaterialTheme.typography.bodySmall,
                        color = SlateLight
                    )
                }
            }
        },
        confirmButton = {
            Button(
                enabled = name.isNotBlank(),
                onClick = {
                    val submittedManagerId = departmentManagerIdForSubmission(
                        department?.managerId,
                        managerId,
                        canManageManager
                    )
                    onSave(name.trim(), submittedManagerId)
                }
            ) {
                Text("حفظ")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } }
    )
}

@Composable
fun EmployeeCardLayout(
    employee: Employee,
    canUpdate: Boolean,
    canDelete: Boolean,
    canViewSalary: Boolean,
    canCreateCredential: Boolean = false,
    canResetCredential: Boolean = false,
    canArchive: Boolean = false,
    securityBusy: Boolean = false,
    onEditClick: () -> Unit,
    onSalaryClick: () -> Unit,
    onDeleteClick: () -> Unit,
    onCreateCredentialClick: () -> Unit = {},
    onResetCredentialClick: () -> Unit = {},
    onArchiveClick: () -> Unit = {},
    onTimelineClick: (() -> Unit)? = null
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (isSystemInDarkTheme()) SlateMedium else Color.White
        ),
        border = BorderStroke(1.dp, if (isSystemInDarkTheme()) SlateMedium else Color(0xFFE2E8F0))
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            // Header: Name + Badge Status
            Column(modifier = Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(44.dp)
                            .background(EmeraldBg, CircleShape),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = employee.name.take(1).uppercase(),
                            color = EmeraldMain,
                            fontWeight = FontWeight.Bold,
                            fontSize = 18.sp
                        )
                    }
                    Spacer(modifier = Modifier.width(12.dp))
                    Column {
                        Text(
                            text = employee.name,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            color = if (isSystemInDarkTheme()) Color.White else SlateDark
                        )
                        Text(
                            text = "${employee.role} • ${employee.department}",
                            style = MaterialTheme.typography.bodySmall,
                            color = SlateLight
                        )
                    }
                }

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    onTimelineClick?.let { openTimeline ->
                        IconButton(onClick = openTimeline) {
                            Icon(
                                Icons.Default.History,
                                contentDescription = stringResource(com.example.R.string.timeline_action),
                                tint = SlateLight
                            )
                        }
                    }
                    if (canViewSalary) {
                        IconButton(onClick = onSalaryClick) {
                            Icon(Icons.Default.Payments, contentDescription = "إدارة الراتب", tint = EmeraldMain)
                        }
                    }
                    if (canUpdate) {
                        IconButton(onClick = onEditClick) {
                            Icon(Icons.Default.Edit, contentDescription = "تعديل الموظف", tint = EmeraldMain)
                        }
                    }
                    if (canCreateCredential) {
                        IconButton(onClick = onCreateCredentialClick, enabled = !securityBusy) {
                            Icon(
                                Icons.Default.PersonAdd,
                                contentDescription = "إنشاء بيانات الدخول",
                                tint = EmeraldMain
                            )
                        }
                    }
                    if (canResetCredential) {
                        IconButton(onClick = onResetCredentialClick, enabled = !securityBusy) {
                            Icon(
                                Icons.Default.LockReset,
                                contentDescription = "إعادة تعيين كلمة المرور",
                                tint = EmeraldMain
                            )
                        }
                    }
                    if (canArchive) {
                        IconButton(onClick = onArchiveClick, enabled = !securityBusy) {
                            Icon(
                                Icons.Default.Archive,
                                contentDescription = "أرشفة الموظف",
                                tint = RedStatus
                            )
                        }
                    }
                    // This action is soft deactivation only; no hard-delete control exists.
                    if (canDelete) {
                        IconButton(onClick = onDeleteClick) {
                            Icon(Icons.Default.PersonOff, contentDescription = "إيقاف الموظف", tint = RedStatus)
                        }
                    }
                }
            }

            Divider(modifier = Modifier.padding(vertical = 12.dp), color = SlateLight.copy(alpha = 0.2f))

            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Email, contentDescription = "بريد", tint = SlateLight, modifier = Modifier.size(14.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(employee.email, fontSize = 11.sp, color = SlateLight)
                }
                Spacer(modifier = Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Phone, contentDescription = "هاتف", tint = SlateLight, modifier = Modifier.size(14.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(employee.phone, fontSize = 11.sp, color = SlateLight)
                }
            }
        }
    }
}
