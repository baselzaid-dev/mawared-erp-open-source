package com.example.ui

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.core.utils.DateUtils
import com.example.domain.model.*
import com.example.ui.ux.MawaredDateField
import com.example.ui.ux.MawaredDateFieldLogic
import com.example.ui.ux.MawaredScrollableForm
import com.example.ui.ux.MawaredTextField

@Composable
fun MawaredTrainingManager(
    viewModel: MawaredViewModel,
    user: LoggedInState.Authenticated
) {
    val state by viewModel.trainingUiState.collectAsState()
    val timelineState by viewModel.trainingTimelineState.collectAsState()
    val exportState by viewModel.trainingExportState.collectAsState()
    val pendingExportShare by viewModel.trainingPendingExportShare.collectAsState()
    val context = LocalContext.current
    var editingCourse by remember { mutableStateOf<TrainingCourseParams?>(null) }
    var showCourseEditor by remember { mutableStateOf(false) }
    var assigningCourse by remember { mutableStateOf<TrainingCourseParams?>(null) }
    var progressAssignment by remember { mutableStateOf<TrainingAssignmentParams?>(null) }
    var submitAssignment by remember { mutableStateOf<TrainingAssignmentParams?>(null) }
    var artifactsAssignment by remember { mutableStateOf<TrainingAssignmentParams?>(null) }
    var reviewTarget by remember { mutableStateOf<Pair<TrainingAssignmentParams, String>?>(null) }
    var assignmentCancelTarget by remember { mutableStateOf<TrainingAssignmentParams?>(null) }
    var courseReasonTarget by remember { mutableStateOf<Pair<TrainingCourseParams, String>?>(null) }
    var courseConfirmTarget by remember { mutableStateOf<Pair<TrainingCourseParams, String>?>(null) }
    var expandedTimelineCourseId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(state.availableModes) {
        if (state.availableModes.isNotEmpty()) viewModel.refreshTraining(state.selectedMode)
    }

    LaunchedEffect(pendingExportShare?.uri) {
        val share = pendingExportShare ?: return@LaunchedEffect
        try {
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = share.mimeType
                putExtra(Intent.EXTRA_STREAM, share.uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(Intent.createChooser(intent, "مشاركة ملف تصدير التدريب"))
        } catch (_: Exception) {
            viewModel.showNotification("تعذرت مشاركة ملف التصدير")
        } finally {
            viewModel.consumeTrainingExportShare()
        }
    }

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
                    text = stringResource(R.string.training_title),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = trainingModeLabel(state.selectedMode),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            IconButton(onClick = { viewModel.refreshTraining(state.selectedMode) }) {
                Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.training_refresh_cd))
            }
            if (state.canManage && state.selectedMode == "courses") {
                FilledTonalIconButton(onClick = {
                    editingCourse = null
                    showCourseEditor = true
                }) {
                    Icon(Icons.Default.Add, contentDescription = stringResource(R.string.training_create_course_cd))
                }
            }
        }

        if (!state.canView) {
            TrainingEmptyState(stringResource(R.string.training_no_permission))
            return@Column
        }

        if (state.availableModes.size > 1) {
            ScrollableTabRow(
                selectedTabIndex = state.availableModes.indexOf(state.selectedMode).coerceAtLeast(0),
                edgePadding = 0.dp,
                divider = {}
            ) {
                state.availableModes.forEach { mode ->
                    Tab(
                        selected = mode == state.selectedMode,
                        onClick = {
                            viewModel.clearTypedResourceFocus()
                            viewModel.selectTrainingMode(mode)
                        },
                        text = { Text(trainingModeLabel(mode), maxLines = 1) }
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
        }

        TrainingFilters(state, viewModel)

        state.errorMessage?.let { message ->
            Surface(
                color = MaterialTheme.colorScheme.errorContainer,
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(message, modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.onErrorContainer)
                    IconButton(onClick = viewModel::clearTrainingError) {
                        Icon(Icons.Default.Close, contentDescription = stringResource(R.string.training_close_message_cd))
                    }
                }
            }
        }

        if (state.isLoading) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when (state.selectedMode) {
                "courses" -> TrainingCourseList(
                    state = state,
                    focusedCourseId = viewModel.focusedTrainingCourseId,
                    timelineState = timelineState,
                    expandedTimelineCourseId = expandedTimelineCourseId,
                    onToggleTimeline = { courseId ->
                        if (expandedTimelineCourseId == courseId) {
                            expandedTimelineCourseId = null
                        } else {
                            expandedTimelineCourseId = courseId
                            viewModel.selectTrainingCourse(state.courses.firstOrNull { it.id == courseId })
                            viewModel.loadTrainingCourseTimeline(courseId)
                        }
                    },
                    onRetryTimeline = viewModel::loadTrainingCourseTimeline,
                    onEdit = {
                        viewModel.selectTrainingCourse(it)
                        editingCourse = it
                        showCourseEditor = true
                    },
                    onPublish = { courseConfirmTarget = it to "publish" },
                    onAssign = {
                        viewModel.selectTrainingCourse(it)
                        viewModel.loadTrainingEligibleEmployees()
                        assigningCourse = it
                    },
                    onComplete = { courseConfirmTarget = it to "complete" },
                    onCancel = { courseReasonTarget = it to "cancel" },
                    onArchive = { courseConfirmTarget = it to "archive" }
                )
                "report" -> TrainingReportView(
                    report = state.report,
                    canExport = canShowTrainingExportActions(state.canReport),
                    exportState = exportState,
                    onExport = viewModel::exportTrainingReport,
                    onClearExportMessage = viewModel::clearTrainingExportMessage
                )
                else -> {
                    val rows = if (state.selectedMode == "reviews") {
                        state.assignments.filter { it.status == "submitted" }
                    } else state.assignments
                    TrainingAssignmentList(
                        assignments = rows,
                        courses = state.courses,
                        state = state,
                        onProgress = { viewModel.selectTrainingAssignment(it); progressAssignment = it },
                        onSubmit = { viewModel.selectTrainingAssignment(it); submitAssignment = it },
                        onAccept = { viewModel.selectTrainingAssignment(it); reviewTarget = it to "accept" },
                        onReturn = { viewModel.selectTrainingAssignment(it); reviewTarget = it to "return" },
                        onCancel = { viewModel.selectTrainingAssignment(it); assignmentCancelTarget = it },
                        onTimeline = {
                            viewModel.openTimeline(
                                com.example.domain.model.TimelineKind.TRAINING_ASSIGNMENT,
                                it.id
                            )
                        },
                        onArtifacts = { artifactsAssignment = it }
                    )
                }
            }
        }
    }

    if (showCourseEditor) {
        TrainingCourseEditorDialog(
            course = editingCourse,
            isSubmitting = state.isSubmitting,
            onDismiss = { showCourseEditor = false },
            onSave = { request ->
                viewModel.saveTrainingCourse(editingCourse?.id, request)
                showCourseEditor = false
            }
        )
    }

    assigningCourse?.let { course ->
        TrainingAssignmentDialog(
            course = course,
            employees = state.eligibleEmployees,
            isSubmitting = state.isSubmitting,
            onDismiss = { assigningCourse = null },
            onAssign = { ids ->
                viewModel.assignTrainingCourse(course.id, ids)
                assigningCourse = null
            }
        )
    }

    progressAssignment?.let { assignment ->
        TrainingProgressDialog(
            assignment = assignment,
            onDismiss = { progressAssignment = null },
            onSave = { value ->
                viewModel.updateTrainingProgress(assignment.id, value)
                progressAssignment = null
            }
        )
    }

    submitAssignment?.let { assignment ->
        TrainingTextDialog(
            title = stringResource(R.string.training_submit_title),
            label = stringResource(R.string.training_submit_note_label),
            required = false,
            onDismiss = { submitAssignment = null },
            onConfirm = { note ->
                viewModel.submitTrainingAssignment(assignment.id, note)
                submitAssignment = null
            }
        )
    }

    // ---- Commercial P4: certificate and evaluation ----
    artifactsAssignment?.let { assignment ->
        val certificate by viewModel.trainingCertificate.collectAsState()
        val evaluation by viewModel.trainingEvaluation.collectAsState()
        val busy by viewModel.trainingArtifactBusy.collectAsState()
        val canIssue = state.canIssueCertificate
        val canEvaluate = state.canCreateEvaluation
        val canReadEvaluation = state.canViewEvaluation
        var evaluationOpen by remember(assignment.id) { mutableStateOf(false) }

        LaunchedEffect(assignment.id) { viewModel.loadTrainingArtifacts(assignment.id) }

        AlertDialog(
            onDismissRequest = {
                artifactsAssignment = null
                viewModel.clearTrainingArtifacts()
            },
            title = { Text("الشهادة والتقييم") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("الشهادة", style = MaterialTheme.typography.titleSmall)
                    when {
                        busy -> Text("جارٍ التحميل…")
                        certificate != null -> Column {
                            Text("رقم الشهادة: ${certificate!!.serialNumber}")
                            Text("الدورة: ${certificate!!.courseTitle}")
                            Text(
                                "شهادة داخلية للشركة فقط ولا تمثل اعتمادًا خارجيًا.",
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                        else -> Text("لم تصدر شهادة لهذا التكليف.")
                    }
                    if (canIssue && certificate == null) {
                        Button(
                            enabled = !busy,
                            onClick = { viewModel.issueTrainingCertificate(assignment.id) }
                        ) { Text("إصدار شهادة") }
                    }

                    Text("التقييم", style = MaterialTheme.typography.titleSmall)
                    when {
                        // Reading an evaluation needs its own permission; say so
                        // rather than showing an empty panel.
                        !canReadEvaluation -> Text("التقييمات متاحة لأصحاب صلاحية عرض التقييم فقط.")
                        evaluation != null -> Column {
                            Text("فعالية التدريب: ${evaluation!!.effectivenessScore}/5")
                            Text("اكتساب المعرفة: ${evaluation!!.knowledgeScore}/5")
                            Text("التطبيق العملي: ${evaluation!!.applicationScore}/5")
                            Text("التوصية: ${trainingRecommendationLabel(evaluation!!.recommendation)}")
                        }
                        else -> Text("لا يوجد تقييم مسجل لهذا التكليف.")
                    }
                    if (canEvaluate && evaluation == null) {
                        OutlinedButton(
                            enabled = !busy,
                            onClick = { evaluationOpen = true }
                        ) { Text("تسجيل تقييم") }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    artifactsAssignment = null
                    viewModel.clearTrainingArtifacts()
                }) { Text("إغلاق") }
            }
        )

        if (evaluationOpen) {
            TrainingEvaluationDialog(
                busy = busy,
                onDismiss = { evaluationOpen = false },
                onConfirm = { request ->
                    viewModel.createTrainingEvaluation(assignment.id, request)
                    evaluationOpen = false
                }
            )
        }
    }

    reviewTarget?.let { (assignment, action) ->
        TrainingReviewDialog(
            assignment = assignment,
            action = action,
            onDismiss = { reviewTarget = null },
            onConfirm = { score, note ->
                viewModel.reviewTrainingAssignment(assignment.id, action, score, note)
                reviewTarget = null
            }
        )
    }

    assignmentCancelTarget?.let { assignment ->
        TrainingTextDialog(
            title = stringResource(R.string.training_cancel_assignment_title),
            label = stringResource(R.string.training_cancel_reason_label),
            required = true,
            onDismiss = { assignmentCancelTarget = null },
            onConfirm = { reason ->
                viewModel.cancelTrainingAssignment(assignment.id, reason.orEmpty())
                assignmentCancelTarget = null
            }
        )
    }

    courseReasonTarget?.let { (course, _) ->
        TrainingTextDialog(
            title = stringResource(R.string.training_cancel_course_title),
            label = stringResource(R.string.training_cancel_reason_label),
            required = true,
            onDismiss = { courseReasonTarget = null },
            onConfirm = { reason ->
                viewModel.cancelTrainingCourse(course.id, reason.orEmpty())
                courseReasonTarget = null
            }
        )
    }

    courseConfirmTarget?.let { (course, action) ->
        AlertDialog(
            onDismissRequest = { courseConfirmTarget = null },
            icon = { Icon(Icons.Default.School, contentDescription = null) },
            title = { Text(trainingCourseActionTitle(action)) },
            text = { Text(course.title) },
            confirmButton = {
                Button(onClick = {
                    when (action) {
                        "publish" -> viewModel.publishTrainingCourse(course.id)
                        "complete" -> viewModel.completeTrainingCourse(course.id)
                        "archive" -> viewModel.archiveTrainingCourse(course.id)
                    }
                    courseConfirmTarget = null
                }) { Text(stringResource(R.string.ux_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { courseConfirmTarget = null }) { Text(stringResource(R.string.ux_cancel)) }
            }
        )
    }
}

@Composable
private fun TrainingFilters(state: TrainingUiState, viewModel: MawaredViewModel) {
    if (state.selectedMode == "report" || state.selectedMode == "courses") {
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            listOf(null, "draft", "published", "completed", "cancelled", "archived").forEach { status ->
                FilterChip(
                    selected = state.courseStatusFilter == status,
                    onClick = { viewModel.setTrainingCourseStatusFilter(status) },
                    label = {
                        Text(
                            status?.let { stringResource(trainingCourseStatusLabelRes(it)) }
                                ?: stringResource(R.string.ux_all)
                        )
                    }
                )
            }
        }
    } else {
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            listOf(null, "assigned", "in_progress", "submitted", "completed", "returned", "cancelled").forEach { status ->
                FilterChip(
                    selected = state.assignmentStatusFilter == status,
                    onClick = { viewModel.setTrainingAssignmentStatusFilter(status) },
                    label = {
                        Text(
                            status?.let { stringResource(trainingAssignmentStatusLabelRes(it)) }
                                ?: stringResource(R.string.ux_all)
                        )
                    }
                )
            }
        }
    }
}

@Composable
private fun TrainingCourseList(
    state: TrainingUiState,
    focusedCourseId: String?,
    timelineState: TrainingTimelineUiState,
    expandedTimelineCourseId: String?,
    onToggleTimeline: (String) -> Unit,
    onRetryTimeline: (String) -> Unit,
    onEdit: (TrainingCourseParams) -> Unit,
    onPublish: (TrainingCourseParams) -> Unit,
    onAssign: (TrainingCourseParams) -> Unit,
    onComplete: (TrainingCourseParams) -> Unit,
    onCancel: (TrainingCourseParams) -> Unit,
    onArchive: (TrainingCourseParams) -> Unit
) {
    val courses = focusedCourseId?.let { id ->
        state.courses.filter { it.id == id }
    } ?: state.courses
    if (courses.isEmpty()) {
        TrainingEmptyState(stringResource(R.string.training_empty_courses))
        return
    }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 16.dp)) {
        items(courses, key = { it.id }) { course ->
            TrainingCourseCard(
                course = course,
                state = state,
                timelineState = timelineState,
                timelineExpanded = expandedTimelineCourseId == course.id,
                onToggleTimeline = { onToggleTimeline(course.id) },
                onRetryTimeline = { onRetryTimeline(course.id) },
                onEdit = onEdit,
                onPublish = onPublish,
                onAssign = onAssign,
                onComplete = onComplete,
                onCancel = onCancel,
                onArchive = onArchive
            )
        }
    }
}

@Composable
private fun TrainingCourseCard(
    course: TrainingCourseParams,
    state: TrainingUiState,
    timelineState: TrainingTimelineUiState,
    timelineExpanded: Boolean,
    onToggleTimeline: () -> Unit,
    onRetryTimeline: () -> Unit,
    onEdit: (TrainingCourseParams) -> Unit,
    onPublish: (TrainingCourseParams) -> Unit,
    onAssign: (TrainingCourseParams) -> Unit,
    onComplete: (TrainingCourseParams) -> Unit,
    onCancel: (TrainingCourseParams) -> Unit,
    onArchive: (TrainingCourseParams) -> Unit
) {
    Card(
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(course.title, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                    Text(course.courseCode, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
                AssistChip(onClick = {}, label = { Text(stringResource(trainingCourseStatusLabelRes(course.status))) })
            }
            course.description?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            TrainingMetaLine(Icons.Default.Category, course.category ?: "بدون تصنيف")
            TrainingMetaLine(Icons.Default.Person, course.instructorName ?: "لم يحدد المدرب")
            TrainingMetaLine(Icons.Default.LocationOn, buildString {
                append(stringResource(trainingDeliveryLabelRes(course.deliveryMode)))
                course.location?.let { append(" · $it") }
            })
            TrainingMetaLine(Icons.Default.DateRange, trainingSchedule(course.startDate, course.endDate))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("المدة: ${course.durationHours?.let { "$it ساعة" } ?: "-"}", style = MaterialTheme.typography.bodySmall)
                Text("السعة: ${course.capacity?.toString() ?: "مفتوحة"}", style = MaterialTheme.typography.bodySmall)
                Text("التكليفات: ${course.assignmentSummary.total}", style = MaterialTheme.typography.bodySmall)
            }
            if (course.resources.isNotEmpty()) {
                HorizontalDivider()
                Text("المصادر", fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
                course.resources.forEach { TrainingResourceLink(it) }
            }
            HorizontalDivider()
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                if (state.canManage && course.status == "draft") {
                    OutlinedButton(onClick = { onEdit(course) }) {
                        Icon(Icons.Default.Edit, null); Spacer(Modifier.width(4.dp)); Text("تعديل")
                    }
                    Button(onClick = { onPublish(course) }) {
                        Icon(Icons.Default.Publish, null); Spacer(Modifier.width(4.dp)); Text("نشر")
                    }
                }
                if (state.canAssign && course.status == "published") {
                    Button(onClick = { onAssign(course) }) {
                        Icon(Icons.Default.GroupAdd, null); Spacer(Modifier.width(4.dp)); Text("إسناد")
                    }
                }
                if (state.canManage && course.status == "published") {
                    OutlinedButton(onClick = { onComplete(course) }) { Text("إكمال الدورة") }
                    OutlinedButton(onClick = { onCancel(course) }) { Text("إلغاء الدورة") }
                }
                if (state.canManage && course.status in setOf("completed", "cancelled")) {
                    OutlinedButton(onClick = { onArchive(course) }) {
                        Icon(Icons.Default.Archive, null); Spacer(Modifier.width(4.dp)); Text("أرشفة")
                    }
                }
                OutlinedButton(onClick = onToggleTimeline) {
                    Icon(
                        if (timelineExpanded) Icons.Default.KeyboardArrowUp else Icons.Default.DateRange,
                        contentDescription = null
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(if (timelineExpanded) "إخفاء السجل" else "سجل الدورة")
                }
            }
            if (timelineExpanded) {
                HorizontalDivider()
                TrainingCourseTimelineSection(
                    courseId = course.id,
                    timelineState = timelineState,
                    onRetry = onRetryTimeline
                )
            }
        }
    }
}

@Composable
internal fun TrainingCourseTimelineSection(
    courseId: String,
    timelineState: TrainingTimelineUiState,
    onRetry: () -> Unit
) {
    val matchesCourse = timelineState.courseId == courseId
    Text("سجل الدورة", fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
    when {
        timelineState.isLoading && (matchesCourse || timelineState.courseId == null) -> {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp))
            Text("جاري تحميل السجل…", style = MaterialTheme.typography.bodySmall)
        }
        matchesCourse && timelineState.errorMessage != null -> {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    timelineState.errorMessage,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall
                )
                OutlinedButton(onClick = onRetry) { Text("إعادة المحاولة") }
            }
        }
        matchesCourse && timelineState.timeline != null && trainingTimelineEmpty(timelineState.timeline) -> {
            Text("لا توجد أحداث في سجل هذه الدورة.", style = MaterialTheme.typography.bodySmall)
        }
        matchesCourse && timelineState.timeline != null -> {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                trainingTimelineSortedEvents(timelineState.timeline).forEach { event ->
                    TrainingTimelineEventRow(event)
                }
            }
        }
        else -> {
            Text("جاري انتظار نتيجة السجل من الخادم…", style = MaterialTheme.typography.bodySmall)
            OutlinedButton(onClick = onRetry) { Text("إعادة المحاولة") }
        }
    }
}

@Composable
private fun TrainingTimelineEventRow(event: TrainingTimelineEvent) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            formatTrainingTimelineAt(event.at),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary
        )
        Text(
            trainingTimelineEventLabel(event.type),
            fontWeight = FontWeight.SemiBold,
            style = MaterialTheme.typography.bodyMedium
        )
        if (event.summary.isNotBlank()) {
            Text(
                event.summary,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun TrainingAssignmentList(
    assignments: List<TrainingAssignmentParams>,
    courses: List<TrainingCourseParams>,
    state: TrainingUiState,
    onProgress: (TrainingAssignmentParams) -> Unit,
    onSubmit: (TrainingAssignmentParams) -> Unit,
    onAccept: (TrainingAssignmentParams) -> Unit,
    onReturn: (TrainingAssignmentParams) -> Unit,
    onCancel: (TrainingAssignmentParams) -> Unit,
    onTimeline: ((TrainingAssignmentParams) -> Unit)? = null,
    onArtifacts: ((TrainingAssignmentParams) -> Unit)? = null
) {
    if (assignments.isEmpty()) {
        TrainingEmptyState(
            if (state.selectedMode == "reviews") {
                stringResource(R.string.training_empty_reviews)
            } else {
                stringResource(R.string.training_empty_assignments)
            }
        )
        return
    }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 16.dp)) {
        items(assignments, key = { it.id }) { assignment ->
            val fullCourse = courses.firstOrNull { it.id == assignment.courseId }
            TrainingAssignmentCard(assignment, fullCourse, state, onProgress, onSubmit, onAccept, onReturn, onCancel, onTimeline, onArtifacts)
        }
    }
}

@Composable
private fun TrainingAssignmentCard(
    assignment: TrainingAssignmentParams,
    course: TrainingCourseParams?,
    state: TrainingUiState,
    onProgress: (TrainingAssignmentParams) -> Unit,
    onSubmit: (TrainingAssignmentParams) -> Unit,
    onAccept: (TrainingAssignmentParams) -> Unit,
    onReturn: (TrainingAssignmentParams) -> Unit,
    onCancel: (TrainingAssignmentParams) -> Unit,
    onTimeline: ((TrainingAssignmentParams) -> Unit)? = null,
    onArtifacts: ((TrainingAssignmentParams) -> Unit)? = null
) {
    val isOwner = assignment.employee.employeeId == state.currentEmployeeId
    Card(
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(assignment.course?.title ?: course?.title ?: "دورة تدريبية", fontWeight = FontWeight.Bold)
                    Text(assignment.course?.courseCode ?: course?.courseCode.orEmpty(), style = MaterialTheme.typography.labelSmall)
                }
                AssistChip(onClick = {}, label = { Text(stringResource(trainingAssignmentStatusLabelRes(assignment.status))) })
            }
            if (!isOwner || state.canViewDepartment || state.canViewCompany) {
                TrainingMetaLine(Icons.Default.Person, "${assignment.employee.displayName} · ${assignment.employee.employeeNum}")
                TrainingMetaLine(Icons.Default.Business, assignment.employee.departmentName ?: "بدون قسم")
            }
            LinearProgressIndicator(
                progress = { assignment.progressPercent.coerceIn(0, 100) / 100f },
                modifier = Modifier.fillMaxWidth()
            )
            Text("التقدم ${assignment.progressPercent}%", style = MaterialTheme.typography.bodySmall)
            assignment.score?.let { Text("الدرجة: $it/100", fontWeight = FontWeight.SemiBold) }
            if (assignment.status == "returned" && !assignment.reviewNote.isNullOrBlank()) {
                Surface(color = MaterialTheme.colorScheme.tertiaryContainer, shape = RoundedCornerShape(6.dp)) {
                    Text(
                        "ملاحظة المراجعة: ${assignment.reviewNote}",
                        modifier = Modifier.fillMaxWidth().padding(10.dp),
                        color = MaterialTheme.colorScheme.onTertiaryContainer
                    )
                }
            }
            assignment.cancellation?.reason?.let {
                Text("سبب الإلغاء: $it", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            course?.resources?.takeIf { it.isNotEmpty() }?.let { links ->
                HorizontalDivider()
                links.forEach { TrainingResourceLink(it) }
            }
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                if (isOwner && canUpdateTrainingProgress(assignment.status)) {
                    if (assignment.status == "assigned") {
                        Button(onClick = { onProgress(assignment) }) { Text("بدء الدورة") }
                    } else {
                        OutlinedButton(onClick = { onProgress(assignment) }) { Text("تحديث التقدم") }
                    }
                    Button(onClick = { onSubmit(assignment) }) { Text("تسليم الإكمال") }
                }
                if (canReviewTrainingAssignment(assignment, state.currentEmployeeId, state.canReview)) {
                    Button(onClick = { onAccept(assignment) }) { Text("اعتماد") }
                    OutlinedButton(onClick = { onReturn(assignment) }) { Text("إعادة") }
                }
                if (state.canManage && assignment.status in setOf("assigned", "in_progress", "submitted", "returned")) {
                    OutlinedButton(onClick = { onCancel(assignment) }) { Text("إلغاء التكليف") }
                }
                onTimeline?.let {
                    TextButton(onClick = { it(assignment) }) {
                        Text(stringResource(R.string.timeline_action))
                    }
                }
                // Commercial P4: completion artifacts only exist for a completed
                // assignment, so the entry point is hidden until then.
                if (assignment.status == "completed") {
                    onArtifacts?.let {
                        TextButton(onClick = { it(assignment) }) { Text("الشهادة والتقييم") }
                    }
                }
            }
        }
    }
}

@Composable
private fun TrainingResourceLink(resource: TrainingResourceParams) {
    val context = LocalContext.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable {
                val uri = runCatching { Uri.parse(resource.url) }.getOrNull()
                if (uri?.scheme == "https") {
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                        .onFailure { Toast.makeText(context, context.getString(R.string.training_link_open_failed), Toast.LENGTH_SHORT).show() }
                } else {
                    Toast.makeText(context, context.getString(R.string.training_link_unsafe), Toast.LENGTH_SHORT).show()
                }
            }
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(Icons.Default.Link, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(resource.title, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Icon(Icons.Default.OpenInNew, contentDescription = stringResource(R.string.training_open_resource_cd), modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun TrainingMetaLine(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(17.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(7.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun TrainingReportView(
    report: TrainingReportParams?,
    canExport: Boolean,
    exportState: TrainingExportUiState,
    onExport: (TrainingExportFormat) -> Unit,
    onClearExportMessage: () -> Unit
) {
    if (report == null) {
        TrainingEmptyState(stringResource(R.string.training_report_not_loaded))
        return
    }
    val summary = report.summary
    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 16.dp)) {
        item {
            Text(stringResource(R.string.training_report_summary), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        }
        item {
            TrainingExportActions(
                canExport = canExport,
                exportState = exportState,
                onExport = onExport,
                onClearMessage = onClearExportMessage
            )
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TrainingKpi(stringResource(MetricLabelResolver.resolveResId("courseCount")), summary.courseCount.toString(), Modifier.weight(1f))
                    TrainingKpi(stringResource(MetricLabelResolver.resolveResId("assignmentCount")), summary.assignmentCount.toString(), Modifier.weight(1f))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TrainingKpi(stringResource(MetricLabelResolver.resolveResId("completionRatePercent")), "${summary.completionRatePercent}%", Modifier.weight(1f))
                    TrainingKpi(stringResource(MetricLabelResolver.resolveResId("averageProgressPercent")), "${summary.averageProgressPercent}%", Modifier.weight(1f))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TrainingKpi(stringResource(MetricLabelResolver.resolveResId("submittedCount")), summary.submittedCount.toString(), Modifier.weight(1f))
                    TrainingKpi(stringResource(MetricLabelResolver.resolveResId("overdueCount")), summary.overdueCount.toString(), Modifier.weight(1f))
                }
                summary.averageScore?.let {
            TrainingKpi(
                stringResource(MetricLabelResolver.resolveResId("averageScore")),
                it,
                Modifier.fillMaxWidth()
            )
        }
            }
        }
        if (report.departments.isNotEmpty()) {
            item { Text("الأقسام", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold) }
            items(report.departments) { row ->
                ListItem(
                    headlineContent = { Text(row.departmentName ?: "بدون قسم") },
                    supportingContent = { Text("${row.completedCount} مكتمل من ${row.assignmentCount}") },
                    trailingContent = { Text("${row.completionRatePercent}%") }
                )
                HorizontalDivider()
            }
        }
    }
}

@Composable
internal fun TrainingExportActions(
    canExport: Boolean,
    exportState: TrainingExportUiState,
    onExport: (TrainingExportFormat) -> Unit,
    onClearMessage: () -> Unit = {}
) {
    if (!canExport) return
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("تصدير التقرير", fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            trainingExportFormats().forEach { format ->
                OutlinedButton(
                    onClick = { onExport(format) },
                    enabled = exportState.exportingFormat == null,
                    shape = RoundedCornerShape(6.dp)
                ) {
                    if (exportState.exportingFormat == format) {
                        CircularProgressIndicator(
                            modifier = Modifier.height(14.dp).width(14.dp).padding(end = 4.dp)
                        )
                    }
                    Text("تصدير ${format.apiValue.uppercase()}")
                }
            }
        }
        exportState.progressMessage?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        exportState.completionMessage?.let { message ->
            Surface(
                color = MaterialTheme.colorScheme.primaryContainer,
                shape = RoundedCornerShape(6.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(message, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = onClearMessage) { Text("حسناً") }
                }
            }
        }
        exportState.errorMessage?.let { message ->
            Surface(
                color = MaterialTheme.colorScheme.errorContainer,
                shape = RoundedCornerShape(6.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(message, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = onClearMessage) { Text("إغلاق") }
                }
            }
        }
    }
}

@Composable
private fun TrainingKpi(label: String, value: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surfaceVariant
    ) {
        Column(Modifier.padding(12.dp)) {
            Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text(label, style = MaterialTheme.typography.bodySmall)
        }
    }
}

private data class TrainingResourceDraft(
    val title: String = "",
    val type: String = "link",
    val url: String = ""
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TrainingCourseEditorDialog(
    course: TrainingCourseParams?,
    isSubmitting: Boolean,
    onDismiss: () -> Unit,
    onSave: (TrainingCourseRequestParams) -> Unit
) {
    var title by remember(course?.id) { mutableStateOf(course?.title.orEmpty()) }
    var description by remember(course?.id) { mutableStateOf(course?.description.orEmpty()) }
    var category by remember(course?.id) { mutableStateOf(course?.category.orEmpty()) }
    var instructor by remember(course?.id) { mutableStateOf(course?.instructorName.orEmpty()) }
    var deliveryMode by remember(course?.id) { mutableStateOf(course?.deliveryMode ?: "onsite") }
    var location by remember(course?.id) { mutableStateOf(course?.location.orEmpty()) }
    var startDate by remember(course?.id) { mutableStateOf(course?.startDate.orEmpty()) }
    var endDate by remember(course?.id) { mutableStateOf(course?.endDate.orEmpty()) }
    var duration by remember(course?.id) { mutableStateOf(course?.durationHours?.toString().orEmpty()) }
    var capacity by remember(course?.id) { mutableStateOf(course?.capacity?.toString().orEmpty()) }
    val resources = remember(course?.id) {
        mutableStateListOf<TrainingResourceDraft>().apply {
            addAll(course?.resources?.map { TrainingResourceDraft(it.title, it.type, it.url) }.orEmpty())
        }
    }
    var error by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (course == null) stringResource(R.string.training_course_create_title) else stringResource(R.string.training_course_edit_title)) },
        text = {
            MawaredScrollableForm(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 580.dp)
            ) {
                MawaredTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = "عنوان الدورة"
                )
                Spacer(Modifier.height(9.dp))
                MawaredTextField(
                    value = description,
                    onValueChange = { description = it },
                    label = "الوصف"
                )
                Spacer(Modifier.height(9.dp))
                MawaredTextField(
                    value = category,
                    onValueChange = { category = it },
                    label = "التصنيف"
                )
                Spacer(Modifier.height(9.dp))
                MawaredTextField(
                    value = instructor,
                    onValueChange = { instructor = it },
                    label = "المدرب"
                )
                Spacer(Modifier.height(9.dp))
                Text("طريقة التقديم", style = MaterialTheme.typography.labelLarge)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("onsite", "online", "hybrid", "self_paced").forEach { mode ->
                        FilterChip(
                            selected = deliveryMode == mode,
                            onClick = { deliveryMode = mode },
                            label = { Text(stringResource(trainingDeliveryLabelRes(mode))) }
                        )
                    }
                }
                Spacer(Modifier.height(9.dp))
                MawaredTextField(
                    value = location,
                    onValueChange = { location = it },
                    label = "الموقع"
                )
                Spacer(Modifier.height(9.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TrainingIsoDateField(
                        label = "تاريخ البداية",
                        isoValue = startDate,
                        onIsoSelected = { startDate = it },
                        modifier = Modifier.weight(1f)
                    )
                    TrainingIsoDateField(
                        label = "تاريخ النهاية",
                        isoValue = endDate,
                        onIsoSelected = { endDate = it },
                        modifier = Modifier.weight(1f)
                    )
                }
                Spacer(Modifier.height(9.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    MawaredTextField(
                        value = duration,
                        onValueChange = { duration = it.filter(Char::isDigit) },
                        label = "الساعات",
                        keyboardType = KeyboardType.Number,
                        modifier = Modifier.weight(1f)
                    )
                    MawaredTextField(
                        value = capacity,
                        onValueChange = { capacity = it.filter(Char::isDigit) },
                        label = "السعة",
                        keyboardType = KeyboardType.Number,
                        modifier = Modifier.weight(1f)
                    )
                }
                Spacer(Modifier.height(9.dp))
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("روابط المصادر", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    IconButton(onClick = {
                        if (resources.size < 20) resources.add(TrainingResourceDraft())
                    }) { Icon(Icons.Default.AddLink, contentDescription = "إضافة مصدر") }
                }
                resources.forEachIndexed { index, item ->
                    Surface(shape = RoundedCornerShape(6.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
                        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("مصدر ${index + 1}", modifier = Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                                IconButton(onClick = { resources.removeAt(index) }) {
                                    Icon(Icons.Default.RemoveCircleOutline, contentDescription = "إزالة المصدر")
                                }
                            }
                            MawaredTextField(
                                value = item.title,
                                onValueChange = { resources[index] = item.copy(title = it) },
                                label = "العنوان"
                            )
                            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                listOf("link", "video", "document").forEach { type ->
                                    FilterChip(
                                        selected = item.type == type,
                                        onClick = { resources[index] = item.copy(type = type) },
                                        label = { Text(trainingResourceTypeLabel(type)) }
                                    )
                                }
                            }
                            MawaredTextField(
                                value = item.url,
                                onValueChange = { resources[index] = item.copy(url = it) },
                                label = "رابط HTTPS",
                                forceLtr = true
                            )
                        }
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            Button(
                enabled = !isSubmitting,
                onClick = {
                    error = validateTrainingCourseForm(title, deliveryMode, location, startDate, endDate, resources)
                    if (error == null) {
                        onSave(
                            TrainingCourseRequestParams(
                                title.trim(), description.trim().takeIf(String::isNotEmpty),
                                category.trim().takeIf(String::isNotEmpty), instructor.trim().takeIf(String::isNotEmpty),
                                deliveryMode, location.trim().takeIf(String::isNotEmpty),
                                startDate.takeIf(String::isNotEmpty), endDate.takeIf(String::isNotEmpty),
                                duration.toIntOrNull(), capacity.toIntOrNull(),
                                resources.mapIndexed { index, item ->
                                    TrainingResourceRequestParams(item.title.trim(), item.type, item.url.trim(), index)
                                }
                            )
                        )
                    }
                }
            ) { Text(stringResource(R.string.training_save_draft)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.ux_cancel)) } }
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TrainingIsoDateField(
    label: String,
    isoValue: String,
    onIsoSelected: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    var showPicker by remember { mutableStateOf(false) }
    val isValid = isoValue.isBlank() || MawaredDateFieldLogic.isValidIso(isoValue)

    MawaredDateField(
        isoDate = isoValue,
        label = label,
        modifier = modifier,
        isError = !isValid,
        supportingText = if (!isValid) stringResource(R.string.ux_date_invalid_iso) else null,
        displayText = if (isoValue.isBlank()) "" else MawaredDateFieldLogic.formatDisplayDdMmYyyy(isoValue),
        onOpenPicker = { showPicker = true }
    )

    if (showPicker) {
        val state = rememberDatePickerState(initialSelectedDateMillis = DateUtils.epochMillisFromIso(isoValue))
        DatePickerDialog(
            onDismissRequest = { showPicker = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { onIsoSelected(DateUtils.isoFromEpochMillis(it)) }
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

@Composable
private fun TrainingAssignmentDialog(
    course: TrainingCourseParams,
    employees: List<TrainingEligibleEmployee>,
    isSubmitting: Boolean,
    onDismiss: () -> Unit,
    onAssign: (List<String>) -> Unit
) {
    var selected by remember { mutableStateOf(emptySet<String>()) }
    val activeAssignments = course.assignmentSummary.total - course.assignmentSummary.cancelled
    val remaining = course.capacity?.let { (it - activeAssignments).coerceAtLeast(0) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("إسناد ${course.title}") },
        text = {
            Column(Modifier.fillMaxWidth()) {
                Text(
                    remaining?.let { "المقاعد المتبقية: $it" } ?: "السعة مفتوحة",
                    style = MaterialTheme.typography.bodySmall
                )
                Spacer(Modifier.height(8.dp))
                if (employees.isEmpty()) {
                    Text(if (isSubmitting) "جاري تحميل الموظفين..." else "لا يوجد موظفون متاحون ضمن نطاقك.")
                } else {
                    LazyColumn(Modifier.heightIn(max = 360.dp)) {
                        items(employees, key = { it.employeeId }) { employee ->
                            val checked = employee.employeeId in selected
                            val canSelect = checked || remaining == null || selected.size < remaining
                            Row(
                                modifier = Modifier.fillMaxWidth().clickable(enabled = canSelect) {
                                    selected = if (checked) selected - employee.employeeId else selected + employee.employeeId
                                }.padding(vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Checkbox(
                                    checked = checked,
                                    enabled = canSelect,
                                    onCheckedChange = {
                                        selected = if (checked) selected - employee.employeeId else selected + employee.employeeId
                                    }
                                )
                                Column {
                                    Text(employee.displayName, fontWeight = FontWeight.SemiBold)
                                    Text(
                                        "${employee.employeeNum} · ${employee.departmentName ?: "بدون قسم"}",
                                        style = MaterialTheme.typography.bodySmall
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(enabled = selected.isNotEmpty() && !isSubmitting, onClick = { onAssign(selected.toList()) }) {
                Text("إسناد (${selected.size})")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.ux_cancel)) } }
    )
}

@Composable
private fun TrainingProgressDialog(
    assignment: TrainingAssignmentParams,
    onDismiss: () -> Unit,
    onSave: (Int) -> Unit
) {
    var progress by remember { mutableFloatStateOf(assignment.progressPercent.coerceIn(1, 99).toFloat()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (assignment.status == "assigned") "بدء الدورة" else "تحديث التقدم") },
        text = {
            MawaredScrollableForm {
                Text("النسبة الحالية: ${progress.toInt()}%")
                Slider(value = progress, onValueChange = { progress = it }, valueRange = 1f..99f, steps = 97)
            }
        },
        confirmButton = { Button(onClick = { onSave(progress.toInt()) }) { Text(stringResource(R.string.ux_save)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.ux_cancel)) } }
    )
}

@Composable
private fun TrainingReviewDialog(
    assignment: TrainingAssignmentParams,
    action: String,
    onDismiss: () -> Unit,
    onConfirm: (Int?, String?) -> Unit
) {
    var score by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    val valid = action == "accept" || note.isNotBlank()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (action == "accept") "اعتماد إكمال التدريب" else "إعادة الإكمال للموظف") },
        text = {
            MawaredScrollableForm {
                Text(assignment.employee.displayName)
                Spacer(Modifier.height(8.dp))
                if (action == "accept") {
                    MawaredTextField(
                        value = score,
                        onValueChange = { score = it.filter(Char::isDigit).take(3) },
                        label = "الدرجة (اختيارية)",
                        keyboardType = KeyboardType.Number,
                        isError = score.toIntOrNull()?.let { it !in 0..100 } == true
                    )
                    Spacer(Modifier.height(8.dp))
                }
                MawaredTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = if (action == "return") "ملاحظة الإعادة" else "ملاحظة المراجعة (اختيارية)"
                )
            }
        },
        confirmButton = {
            Button(
                enabled = valid && (score.isBlank() || score.toIntOrNull() in 0..100),
                onClick = { onConfirm(score.toIntOrNull(), note.trim().takeIf(String::isNotEmpty)) }
            ) { Text(if (action == "accept") "اعتماد" else "إعادة") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.ux_cancel)) } }
    )
}

@Composable
private fun trainingRecommendationLabel(value: String): String = when (value) {
    "recommended_with_follow_up" -> "موصى به مع متابعة"
    "repeat_required" -> "يتطلب إعادة"
    else -> "موصى به"
}

/**
 * Commercial P4 evaluation form. Scores are picked from a fixed 1..5 set rather
 * than typed, so the client cannot even offer an out-of-range value that the
 * backend CHECK constraint would reject.
 */
@Composable
private fun TrainingEvaluationDialog(
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (com.example.domain.model.TrainingEvaluationRequestParams) -> Unit
) {
    var effectiveness by remember { mutableStateOf(3) }
    var knowledge by remember { mutableStateOf(3) }
    var application by remember { mutableStateOf(3) }
    var recommendation by remember { mutableStateOf("recommended") }
    var comment by remember { mutableStateOf("") }

    @Composable
    fun scoreRow(label: String, value: Int, onChange: (Int) -> Unit) {
        Column {
            Text(label, style = MaterialTheme.typography.labelMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                (1..5).forEach { score ->
                    FilterChip(
                        selected = value == score,
                        onClick = { onChange(score) },
                        label = { Text("$score") }
                    )
                }
            }
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("تسجيل تقييم التدريب") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                scoreRow("فعالية التدريب", effectiveness) { effectiveness = it }
                scoreRow("اكتساب المعرفة", knowledge) { knowledge = it }
                scoreRow("التطبيق العملي", application) { application = it }
                Text("التوصية", style = MaterialTheme.typography.labelMedium)
                Column {
                    listOf(
                        "recommended",
                        "recommended_with_follow_up",
                        "repeat_required"
                    ).forEach { option ->
                        FilterChip(
                            selected = recommendation == option,
                            onClick = { recommendation = option },
                            label = { Text(trainingRecommendationLabel(option)) }
                        )
                    }
                }
                MawaredTextField(
                    value = comment,
                    onValueChange = { comment = it },
                    label = "ملاحظات التقييم (اختياري)"
                )
            }
        },
        confirmButton = {
            Button(
                enabled = !busy,
                onClick = {
                    onConfirm(
                        com.example.domain.model.TrainingEvaluationRequestParams(
                            effectivenessScore = effectiveness,
                            knowledgeScore = knowledge,
                            applicationScore = application,
                            recommendation = recommendation,
                            comment = comment.trim().takeIf { it.isNotEmpty() }
                        )
                    )
                }
            ) { Text("حفظ التقييم") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("رجوع") } }
    )
}

@Composable
private fun TrainingTextDialog(
    title: String,
    label: String,
    required: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (String?) -> Unit
) {
    var value by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            MawaredScrollableForm {
                MawaredTextField(
                    value = value,
                    onValueChange = { value = it },
                    label = label
                )
            }
        },
        confirmButton = {
            Button(enabled = !required || value.isNotBlank(), onClick = { onConfirm(value.trim().takeIf(String::isNotEmpty)) }) {
                Text(stringResource(R.string.ux_confirm))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.ux_cancel)) } }
    )
}

@Composable
private fun TrainingEmptyState(message: String) {
    Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Default.School, contentDescription = null, modifier = Modifier.size(44.dp), tint = MaterialTheme.colorScheme.outline)
            Spacer(Modifier.height(10.dp))
            Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun validateTrainingCourseForm(
    title: String,
    deliveryMode: String,
    location: String,
    startDate: String,
    endDate: String,
    resources: List<TrainingResourceDraft>
): String? {
    if (title.isBlank()) return "عنوان الدورة مطلوب."
    if (deliveryMode == "onsite" && location.isBlank()) return "موقع الدورة الحضورية مطلوب."
    if (startDate.isNotBlank() && endDate.isNotBlank()) {
        val start = DateUtils.epochMillisFromIso(startDate)
        val end = DateUtils.epochMillisFromIso(endDate)
        if (start == null || end == null || end < start) return "نطاق تاريخ الدورة غير صالح."
    }
    if (resources.any { it.title.isBlank() || !it.url.startsWith("https://") }) {
        return "كل مصدر يحتاج عنواناً ورابط HTTPS آمناً."
    }
    return null
}

@Composable
internal fun trainingModeLabel(mode: String): String = when (mode) {
    "own" -> stringResource(R.string.training_mode_own)
    "department" -> stringResource(R.string.training_mode_department)
    "courses" -> stringResource(R.string.training_mode_courses)
    "assignments" -> stringResource(R.string.training_mode_assignments)
    "reviews" -> stringResource(R.string.training_mode_reviews)
    "report" -> stringResource(R.string.training_mode_report)
    else -> stringResource(R.string.training_mode_default)
}

@Composable
internal fun trainingCourseStatusLabel(status: String): String =
    stringResource(trainingCourseStatusLabelRes(status))

@Composable
internal fun trainingAssignmentStatusLabel(status: String): String =
    stringResource(trainingAssignmentStatusLabelRes(status))

@Composable
internal fun trainingDeliveryLabel(mode: String): String =
    stringResource(trainingDeliveryLabelRes(mode))

private fun trainingResourceTypeLabel(type: String): String = when (type) {
    "video" -> "فيديو"
    "document" -> "مستند"
    else -> "رابط"
}

private fun trainingSchedule(start: String?, end: String?): String = when {
    start == null && end == null -> "لم يحدد الموعد"
    start == end || end == null -> start.orEmpty()
    else -> "$start إلى $end"
}

internal fun canUpdateTrainingProgress(status: String): Boolean =
    status in setOf("assigned", "in_progress", "returned")

internal fun canReviewTrainingAssignment(
    assignment: TrainingAssignmentParams,
    currentEmployeeId: String?,
    canReview: Boolean
): Boolean = canReview && assignment.status == "submitted" &&
    assignment.employee.employeeId != currentEmployeeId

private fun trainingCourseActionTitle(action: String): String = when (action) {
    "publish" -> "نشر الدورة التدريبية"
    "complete" -> "إكمال الدورة التدريبية"
    "archive" -> "أرشفة الدورة التدريبية"
    else -> "تأكيد الإجراء"
}
