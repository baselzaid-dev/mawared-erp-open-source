package com.example.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddTask
import androidx.compose.material.icons.filled.AssignmentTurnedIn
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Comment
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Undo
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
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
import androidx.compose.ui.unit.sp
import com.example.domain.model.TaskAssignmentParams
import com.example.domain.model.TaskEligibleEmployee
import com.example.domain.model.TaskParams
import com.example.ui.theme.AmberStatus
import com.example.ui.theme.EmeraldMain
import com.example.ui.theme.RedStatus
import com.example.ui.theme.SlateDark
import com.example.ui.theme.SlateLight
import com.example.ui.theme.SlateMedium
import com.example.ui.ux.MawaredTextField
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MawaredDailyTasks(
    viewModel: MawaredViewModel,
    user: LoggedInState.Authenticated
) {
    val state by viewModel.tasksUiState.collectAsState()
    var createOpen by remember { mutableStateOf(false) }
    var completionAssignment by remember { mutableStateOf<TaskAssignmentParams?>(null) }
    var reviewAssignment by remember { mutableStateOf<TaskAssignmentParams?>(null) }
    var reviewAction by remember { mutableStateOf("accept") }
    var cancelTask by remember { mutableStateOf<TaskParams?>(null) }
    var editTask by remember { mutableStateOf<TaskParams?>(null) }
    var commentsTask by remember { mutableStateOf<TaskParams?>(null) }

    LaunchedEffect(user.userName) {
        viewModel.refreshTasks()
    }
    LaunchedEffect(state.canCreate) {
        if (state.canCreate) viewModel.loadTaskEligibleEmployees()
    }
    val displayedTasks = viewModel.focusedTaskId?.let { focusedId ->
        state.tasks.filter { it.id == focusedId }
    } ?: state.tasks

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 12.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "المهام",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = taskModeLabel(state.selectedMode),
                    style = MaterialTheme.typography.bodySmall,
                    color = SlateLight
                )
            }
            IconButton(onClick = { viewModel.refreshTasks(state.selectedMode) }) {
                Icon(Icons.Default.Refresh, contentDescription = "تحديث المهام")
            }
            if (state.canCreate) {
                IconButton(onClick = {
                    viewModel.loadTaskEligibleEmployees()
                    createOpen = true
                }) {
                    Icon(Icons.Default.AddTask, contentDescription = "إضافة مهمة", tint = EmeraldMain)
                }
            }
        }

        if (state.availableModes.size > 1) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                state.availableModes.forEach { mode ->
                    FilterChip(
                        selected = state.selectedMode == mode,
                        onClick = {
                            viewModel.clearTypedResourceFocus()
                            viewModel.selectTaskMode(mode)
                        },
                        label = { Text(taskModeLabel(mode)) }
                    )
                }
            }
            Spacer(modifier = Modifier.height(8.dp))
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            listOf(
                null to "الكل",
                "active" to "النشطة",
                "submitted" to "بانتظار المراجعة",
                "completed" to "المكتملة"
            ).forEach { (status, label) ->
                FilterChip(
                    selected = state.statusFilter == status,
                    onClick = {
                        viewModel.clearTypedResourceFocus()
                        viewModel.setTaskStatusFilter(status)
                    },
                    label = { Text(label) }
                )
            }
        }

        if (state.isLoading || state.isSubmitting) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            Spacer(modifier = Modifier.height(8.dp))
        }

        state.errorMessage?.let { message ->
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = MaterialTheme.colorScheme.errorContainer,
                shape = RoundedCornerShape(6.dp)
            ) {
                Row(
                    modifier = Modifier.padding(10.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(message, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = viewModel::clearTaskError) { Text("إغلاق") }
                }
            }
            Spacer(modifier = Modifier.height(8.dp))
        }

        if (!state.isLoading && displayedTasks.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(
                        Icons.Default.AssignmentTurnedIn,
                        contentDescription = null,
                        tint = SlateLight,
                        modifier = Modifier.size(48.dp)
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text("لا توجد مهام ضمن هذا النطاق حالياً", color = SlateLight)
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(displayedTasks, key = { it.id }) { task ->
                    TaskWorkflowCard(
                        task = task,
                        currentEmployeeId = state.currentEmployeeId,
                        canProgress = state.canProgress,
                        canReview = state.canReview,
                        canCancel = state.canCancel,
                        canEdit = state.canEdit,
                        canComment = state.canComment,
                        submitting = state.isSubmitting,
                        onStart = viewModel::startTaskAssignment,
                        onSubmit = { completionAssignment = it },
                        onReview = { assignment, action ->
                            reviewAssignment = assignment
                            reviewAction = action
                        },
                        onCancel = { cancelTask = task },
                        onEdit = { editTask = task },
                        onOpenComments = { commentsTask = task }
                    )
                }
                item { Spacer(modifier = Modifier.height(8.dp)) }
            }
        }
    }

    if (createOpen) {
        CreateTaskDialog(
            employees = state.eligibleEmployees,
            submitting = state.isSubmitting,
            onDismiss = { createOpen = false },
            onCreate = { title, description, priority, dueDate, employeeIds ->
                viewModel.createNewTask(title, description, priority, dueDate, employeeIds)
                createOpen = false
            }
        )
    }

    completionAssignment?.let { assignment ->
        CompletionDialog(
            employeeName = assignment.employeeName,
            submitting = state.isSubmitting,
            onDismiss = { completionAssignment = null },
            onSubmit = { details ->
                viewModel.submitTaskAssignment(assignment.id, details)
                completionAssignment = null
            }
        )
    }

    reviewAssignment?.let { assignment ->
        ReviewTaskDialog(
            action = reviewAction,
            employeeName = assignment.employeeName,
            completionDetails = assignment.completionDetails.orEmpty(),
            submitting = state.isSubmitting,
            onDismiss = { reviewAssignment = null },
            onConfirm = { note ->
                viewModel.reviewTaskAssignment(assignment.id, reviewAction, note)
                reviewAssignment = null
            }
        )
    }

    cancelTask?.let { task ->
        AlertDialog(
            onDismissRequest = { cancelTask = null },
            title = { Text("إلغاء المهمة") },
            text = { Text("سيتم إلغاء المهمة مع الاحتفاظ بجميع سجلات الإسناد والمراجعة.") },
            confirmButton = {
                Button(
                    enabled = !state.isSubmitting,
                    colors = ButtonDefaults.buttonColors(containerColor = RedStatus),
                    onClick = {
                        viewModel.cancelTask(task.id)
                        cancelTask = null
                    }
                ) { Text("تأكيد الإلغاء") }
            },
            dismissButton = { TextButton(onClick = { cancelTask = null }) { Text("رجوع") } }
        )
    }

    // ---- Commercial P4: edit ----
    editTask?.let { task ->
        var title by remember(task.id) { mutableStateOf(task.title) }
        var description by remember(task.id) { mutableStateOf(task.description.orEmpty()) }
        var priority by remember(task.id) { mutableStateOf(task.priority ?: "normal") }
        AlertDialog(
            onDismissRequest = { editTask = null },
            title = { Text("تعديل المهمة") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    MawaredTextField(
                        value = title,
                        onValueChange = { title = it },
                        label = "عنوان المهمة"
                    )
                    MawaredTextField(
                        value = description,
                        onValueChange = { description = it },
                        label = "الوصف (اتركه فارغاً لمسحه)"
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("low", "normal", "high", "urgent").forEach { option ->
                            FilterChip(
                                selected = priority == option,
                                onClick = { priority = option },
                                label = { Text(taskPriorityLabel(option)) }
                            )
                        }
                    }
                }
            },
            confirmButton = {
                Button(
                    enabled = !state.isSubmitting && title.isNotBlank() && task.updatedAt != null,
                    onClick = {
                        viewModel.editTask(
                            taskId = task.id,
                            // The row the user is looking at is the concurrency token.
                            expectedUpdatedAt = task.updatedAt!!,
                            title = title.takeIf { it.trim() != task.title },
                            priority = priority.takeIf { it != task.priority },
                            // Set(...) is always sent so an emptied box actually clears
                            // the description rather than being read as "unchanged".
                            description = com.example.domain.model.TaskFieldEdit.Set(description)
                        )
                        editTask = null
                    }
                ) { Text("حفظ التعديلات") }
            },
            dismissButton = { TextButton(onClick = { editTask = null }) { Text("رجوع") } }
        )
    }

    // ---- Commercial P4: comment thread ----
    commentsTask?.let { task ->
        val comments by viewModel.taskComments.collectAsState()
        val commentsLoading by viewModel.taskCommentsLoading.collectAsState()
        var draft by remember(task.id) { mutableStateOf("") }
        LaunchedEffect(task.id) { viewModel.loadTaskComments(task.id) }
        AlertDialog(
            onDismissRequest = {
                commentsTask = null
                viewModel.clearTaskComments()
            },
            title = { Text("تعليقات المهمة") },
            text = {
                Column(
                    modifier = Modifier.heightIn(max = 320.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    when {
                        commentsLoading -> Text("جارٍ تحميل التعليقات…", color = SlateLight)
                        comments.isEmpty() -> Text("لا توجد تعليقات بعد.", color = SlateLight)
                        else -> Column(
                            modifier = Modifier.verticalScroll(rememberScrollState()),
                            verticalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            comments.forEach { comment ->
                                Column {
                                    Text(comment.authorName, style = MaterialTheme.typography.labelMedium)
                                    Text(comment.body, style = MaterialTheme.typography.bodyMedium)
                                }
                            }
                        }
                    }
                    MawaredTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        label = "أضف تعليقاً"
                    )
                }
            },
            confirmButton = {
                Button(
                    enabled = !state.isSubmitting && draft.isNotBlank(),
                    onClick = {
                        viewModel.addTaskComment(task.id, draft)
                        draft = ""
                    }
                ) { Text("إضافة تعليق") }
            },
            dismissButton = {
                TextButton(onClick = {
                    commentsTask = null
                    viewModel.clearTaskComments()
                }) { Text("إغلاق") }
            }
        )
    }
}

private fun taskPriorityLabel(priority: String): String = when (priority) {
    "low" -> "منخفضة"
    "high" -> "عالية"
    "urgent" -> "عاجلة"
    else -> "عادية"
}

@Composable
private fun TaskWorkflowCard(
    task: TaskParams,
    currentEmployeeId: String?,
    canProgress: Boolean,
    canReview: Boolean,
    canCancel: Boolean,
    canEdit: Boolean,
    canComment: Boolean,
    submitting: Boolean,
    onStart: (String) -> Unit,
    onSubmit: (TaskAssignmentParams) -> Unit,
    onReview: (TaskAssignmentParams, String) -> Unit,
    onCancel: () -> Unit,
    onEdit: () -> Unit,
    onOpenComments: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Top
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        task.title,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                    task.description?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = SlateLight)
                    }
                }
                Spacer(modifier = Modifier.width(8.dp))
                StatusBadge(taskStatusLabel(task.status), statusColor(task.status))
            }

            Spacer(modifier = Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                StatusBadge(taskPriorityLabel(task.priority), priorityColor(task.priority))
                task.dueDate?.let { due ->
                    val overdue = task.status == "active" && due < taskTodayIso()
                    Text(
                        text = if (overdue) "متأخرة: $due" else "الاستحقاق: $due",
                        color = if (overdue) RedStatus else SlateLight,
                        fontSize = 11.sp
                    )
                }
            }
            Text(
                text = "أنشأها: ${task.createdByName ?: "مستخدم"}",
                color = SlateLight,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 6.dp)
            )

            task.assignments.forEach { assignment ->
                Spacer(modifier = Modifier.height(10.dp))
                AssignmentRow(
                    assignment = assignment,
                    ownAssignment = assignment.employeeId == currentEmployeeId,
                    canProgress = canProgress,
                    canReview = canReview,
                    submitting = submitting,
                    onStart = { onStart(assignment.id) },
                    onSubmit = { onSubmit(assignment) },
                    onReview = { action -> onReview(assignment, action) }
                )
            }

            if (task.status == "active" && (canEdit || canComment || canCancel)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    if (canComment) {
                        TextButton(onClick = onOpenComments, enabled = !submitting) {
                            Icon(Icons.Default.Comment, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("التعليقات")
                        }
                    }
                    if (canEdit) {
                        TextButton(onClick = onEdit, enabled = !submitting) {
                            Icon(Icons.Default.Edit, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("تعديل")
                        }
                    }
                    if (canCancel) {
                        TextButton(onClick = onCancel, enabled = !submitting) {
                            Icon(Icons.Default.Cancel, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("إلغاء المهمة", color = RedStatus)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AssignmentRow(
    assignment: TaskAssignmentParams,
    ownAssignment: Boolean,
    canProgress: Boolean,
    canReview: Boolean,
    submitting: Boolean,
    onStart: () -> Unit,
    onSubmit: () -> Unit,
    onReview: (String) -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f),
        shape = RoundedCornerShape(6.dp)
    ) {
        Column(modifier = Modifier.padding(10.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(assignment.employeeName, fontWeight = FontWeight.SemiBold)
                    Text(
                        assignment.departmentName ?: "بدون قسم",
                        color = SlateLight,
                        fontSize = 11.sp
                    )
                }
                StatusBadge(taskStatusLabel(assignment.status), statusColor(assignment.status))
            }
            assignment.completionDetails?.takeIf { it.isNotBlank() }?.let {
                Text("تفاصيل الإنجاز: $it", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp))
            }
            assignment.reviewNote?.takeIf { it.isNotBlank() }?.let {
                Text("ملاحظة المراجعة: $it", color = AmberStatus, style = MaterialTheme.typography.bodySmall)
            }

            val employeeActions = ownAssignment && canProgress &&
                !isAcceptedTaskAssignmentImmutable(assignment.status)
            if (employeeActions && (canStartTaskAssignment(assignment.status) || canSubmitTaskAssignment(assignment.status))) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    if (canStartTaskAssignment(assignment.status)) {
                        OutlinedButton(onClick = onStart, enabled = !submitting) {
                            Icon(Icons.Default.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                            Text("بدء")
                        }
                    }
                    if (canSubmitTaskAssignment(assignment.status)) {
                        Button(onClick = onSubmit, enabled = !submitting) {
                            Icon(Icons.Default.Upload, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("تسليم")
                        }
                    }
                }
            }

            if (canShowTaskReview(canReview, ownAssignment, assignment.status)) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Button(onClick = { onReview("accept") }, enabled = !submitting) {
                        Icon(Icons.Default.CheckCircle, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("قبول")
                    }
                    OutlinedButton(onClick = { onReview("return") }, enabled = !submitting) {
                        Icon(Icons.Default.Undo, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("إعادة")
                    }
                }
            }
        }
    }
}

@Composable
private fun CreateTaskDialog(
    employees: List<TaskEligibleEmployee>,
    submitting: Boolean,
    onDismiss: () -> Unit,
    onCreate: (String, String, String, String?, List<String>) -> Unit
) {
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var priority by remember { mutableStateOf("normal") }
    var dueDate by remember { mutableStateOf("") }
    var selectedIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    val validDate = dueDate.isBlank() || dueDate >= taskTodayIso()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("إضافة مهمة") },
        text = {
            Column(modifier = Modifier.fillMaxWidth()) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it.take(200) },
                    label = { Text("عنوان المهمة") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedTextField(
                    value = description,
                    onValueChange = { description = it.take(2000) },
                    label = { Text("الوصف") },
                    minLines = 2,
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    listOf("low", "normal", "high", "urgent").forEach { value ->
                        FilterChip(
                            selected = priority == value,
                            onClick = { priority = value },
                            label = { Text(taskPriorityLabel(value)) }
                        )
                    }
                }
                Spacer(modifier = Modifier.height(8.dp))
                IsoDatePickerField(
                    label = "تاريخ الاستحقاق (اختياري)",
                    isoValue = dueDate,
                    onIsoSelected = { dueDate = it },
                    modifier = Modifier.fillMaxWidth()
                )
                if (!validDate) {
                    Text("تاريخ الاستحقاق لا يمكن أن يكون في الماضي", color = RedStatus, fontSize = 11.sp)
                }
                Spacer(modifier = Modifier.height(8.dp))
                Text("الموظفون", fontWeight = FontWeight.SemiBold)
                if (employees.isEmpty()) {
                    Text("لا يوجد موظفون متاحون ضمن نطاقك", color = SlateLight, fontSize = 12.sp)
                } else {
                    LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 180.dp)) {
                        items(employees, key = { it.employeeId }) { employee ->
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Checkbox(
                                    checked = employee.employeeId in selectedIds,
                                    onCheckedChange = { checked ->
                                        selectedIds = if (checked) selectedIds + employee.employeeId
                                        else selectedIds - employee.employeeId
                                    }
                                )
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(employee.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(employee.departmentName ?: "بدون قسم", color = SlateLight, fontSize = 11.sp)
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                enabled = !submitting && title.isNotBlank() && selectedIds.isNotEmpty() && validDate,
                onClick = {
                    onCreate(
                        title.trim(),
                        description.trim(),
                        priority,
                        dueDate.takeIf { it.isNotBlank() },
                        selectedIds.toList()
                    )
                }
            ) { Text("إنشاء وإسناد") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } }
    )
}

@Composable
private fun CompletionDialog(
    employeeName: String,
    submitting: Boolean,
    onDismiss: () -> Unit,
    onSubmit: (String) -> Unit
) {
    var details by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("تسليم المهمة") },
        text = {
            Column {
                Text("تفاصيل إنجاز $employeeName", color = SlateLight, fontSize = 12.sp)
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedTextField(
                    value = details,
                    onValueChange = { details = it.take(4000) },
                    label = { Text("تفاصيل الإنجاز") },
                    minLines = 3,
                    maxLines = 6,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            Button(
                enabled = !submitting && details.isNotBlank(),
                onClick = { onSubmit(details.trim()) }
            ) { Text("تسليم للمراجعة") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } }
    )
}

@Composable
private fun ReviewTaskDialog(
    action: String,
    employeeName: String,
    completionDetails: String,
    submitting: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (String?) -> Unit
) {
    var note by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (action == "accept") "قبول الإنجاز" else "إعادة المهمة") },
        text = {
            Column {
                Text(employeeName, fontWeight = FontWeight.SemiBold)
                if (completionDetails.isNotBlank()) {
                    Text(completionDetails, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp))
                }
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it.take(2000) },
                    label = { Text(if (action == "return") "سبب الإعادة" else "ملاحظة (اختيارية)") },
                    minLines = 2,
                    maxLines = 5,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            Button(
                enabled = !submitting && isReturnNoteValid(action, note),
                onClick = { onConfirm(note.trim().takeIf { it.isNotEmpty() }) }
            ) { Text(if (action == "accept") "قبول" else "إعادة للموظف") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } }
    )
}

@Composable
private fun StatusBadge(label: String, color: Color) {
    Box(
        modifier = Modifier
            .background(color.copy(alpha = 0.14f), RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp)
    ) {
        Text(label, color = color, fontSize = 10.sp, fontWeight = FontWeight.Bold)
    }
}

private fun statusColor(status: String): Color = when (status) {
    "completed", "accepted" -> EmeraldMain
    "cancelled", "returned" -> RedStatus
    "submitted", "in_progress" -> AmberStatus
    else -> SlateLight
}

private fun priorityColor(priority: String?): Color = when (priority) {
    "urgent" -> RedStatus
    "high" -> AmberStatus
    "low" -> SlateLight
    else -> EmeraldMain
}

private fun taskTodayIso(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
}.format(Date())
