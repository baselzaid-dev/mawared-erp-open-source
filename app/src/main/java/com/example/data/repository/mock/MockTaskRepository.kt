package com.example.data.repository.mock

import com.example.core.utils.AppResult
import com.example.domain.model.CreateTaskRequestParams
import com.example.domain.model.TaskAssignmentParams
import com.example.domain.model.TaskCommentPageParams
import com.example.domain.model.TaskCommentParams
import com.example.domain.model.TaskEligibleEmployee
import com.example.domain.model.TaskFieldEdit
import com.example.domain.model.TaskFilters
import com.example.domain.model.TaskParams
import com.example.domain.model.TaskReviewResult
import com.example.domain.repository.TaskRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

class MockTaskRepository : TaskRepository {

    private val employees = listOf(
        TaskEligibleEmployee("e1", "EMP-001", "موظف تجريبي", "d1", "الموارد البشرية"),
        TaskEligibleEmployee("e2", "EMP-002", "موظفة تجريبية", "d1", "الموارد البشرية")
    )
    private var taskCounter = 1
    private var assignmentCounter = 1
    private var commentCounter = 0
    private var editCounter = 0
    private val tasks = MutableStateFlow<List<TaskParams>>(emptyList())
    private val comments = MutableStateFlow<List<TaskCommentParams>>(emptyList())
    private val eligible = MutableStateFlow(employees)

    override fun observeTasks(): Flow<List<TaskParams>> = tasks.asStateFlow()

    override fun observeEligibleEmployees(): Flow<List<TaskEligibleEmployee>> = eligible.asStateFlow()

    override fun clear() {
        tasks.value = emptyList()
        eligible.value = emptyList()
    }

    override suspend fun refreshTasks(filters: TaskFilters): AppResult<Unit> = AppResult.Success(Unit)

    override suspend fun loadTask(taskId: String): AppResult<TaskParams> =
        tasks.value.firstOrNull { it.id == taskId }
            ?.let { AppResult.Success(it) }
            ?: AppResult.Error(Exception("المهمة غير موجودة"))

    override suspend fun loadEligibleEmployees(): AppResult<Unit> = AppResult.Success(Unit)

    override suspend fun createTask(request: CreateTaskRequestParams): AppResult<TaskParams> {
        val selected = employees.filter { it.employeeId in request.employeeIds }
        if (selected.size != request.employeeIds.distinct().size || selected.isEmpty()) {
            return AppResult.Error(Exception("الموظفون المحددون غير صالحين"))
        }
        val taskId = "TASK-${taskCounter++}"
        val assignments = selected.map { employee ->
            TaskAssignmentParams(
                id = "ASSIGN-${assignmentCounter++}",
                taskId = taskId,
                employeeId = employee.employeeId,
                employeeNum = employee.employeeNum,
                employeeName = employee.name,
                departmentId = employee.departmentId,
                departmentName = employee.departmentName,
                status = "assigned",
                completionDetails = null,
                submittedAt = null,
                reviewedById = null,
                reviewedByName = null,
                reviewedAt = null,
                reviewNote = null,
                createdAt = "2026-07-10T12:00:00.000Z",
                updatedAt = "2026-07-10T12:00:00.000Z"
            )
        }
        val first = assignments.first()
        val task = TaskParams(
            id = taskId,
            companyId = "1",
            title = request.title,
            description = request.description,
            status = "active",
            priority = request.priority,
            assignedToId = first.employeeId,
            assignedToName = first.employeeName,
            departmentName = first.departmentName,
            dueDate = request.dueDate,
            createdById = "demo-manager",
            createdByName = "مدير تجريبي",
            createdAt = "2026-07-10T12:00:00.000Z",
            updatedAt = "2026-07-10T12:00:00.000Z",
            assignments = assignments
        )
        tasks.value = listOf(task) + tasks.value
        return AppResult.Success(task)
    }

    override suspend fun updateProgress(
        assignmentId: String,
        status: String,
        completionDetails: String?
    ): AppResult<TaskAssignmentParams> {
        val task = tasks.value.firstOrNull { item -> item.assignments.any { it.id == assignmentId } }
            ?: return AppResult.Error(Exception("إسناد المهمة غير موجود"))
        if (task.status != "active") return AppResult.Error(Exception("المهمة لم تعد نشطة"))
        val current = task.assignments.first { it.id == assignmentId }
        val allowed = when (current.status) {
            "assigned" -> setOf("in_progress", "submitted")
            "in_progress" -> setOf("submitted")
            "returned" -> setOf("in_progress", "submitted")
            else -> emptySet()
        }
        if (status !in allowed) return AppResult.Error(Exception("انتقال حالة المهمة غير صالح"))
        if (status == "submitted" && completionDetails.isNullOrBlank()) {
            return AppResult.Error(Exception("تفاصيل الإنجاز مطلوبة"))
        }
        val updated = current.copy(
            status = status,
            completionDetails = completionDetails ?: current.completionDetails,
            submittedAt = if (status == "submitted") "2026-07-10T13:00:00.000Z" else current.submittedAt,
            reviewedById = if (status == "submitted") null else current.reviewedById,
            reviewedByName = if (status == "submitted") null else current.reviewedByName,
            reviewedAt = if (status == "submitted") null else current.reviewedAt,
            reviewNote = if (status == "submitted") null else current.reviewNote,
            updatedAt = "2026-07-10T13:00:00.000Z"
        )
        replaceAssignment(task.id, updated)
        return AppResult.Success(updated)
    }

    override suspend fun reviewAssignment(
        assignmentId: String,
        action: String,
        reviewNote: String?
    ): AppResult<TaskReviewResult> {
        val task = tasks.value.firstOrNull { item -> item.assignments.any { it.id == assignmentId } }
            ?: return AppResult.Error(Exception("إسناد المهمة غير موجود"))
        val current = task.assignments.first { it.id == assignmentId }
        if (task.status != "active" || current.status != "submitted") {
            return AppResult.Error(Exception("يمكن مراجعة المهام المسلّمة فقط"))
        }
        if (action == "return" && reviewNote.isNullOrBlank()) {
            return AppResult.Error(Exception("سبب إعادة المهمة مطلوب"))
        }
        if (action !in setOf("accept", "return")) {
            return AppResult.Error(Exception("إجراء المراجعة غير صالح"))
        }
        val updated = current.copy(
            status = if (action == "accept") "accepted" else "returned",
            reviewedById = "demo-reviewer",
            reviewedByName = "مراجع تجريبي",
            reviewedAt = "2026-07-10T14:00:00.000Z",
            reviewNote = reviewNote,
            updatedAt = "2026-07-10T14:00:00.000Z"
        )
        replaceAssignment(task.id, updated)
        val refreshed = tasks.value.first { it.id == task.id }
        val taskStatus = if (refreshed.assignments.all { it.status == "accepted" }) "completed" else "active"
        if (taskStatus == "completed") replaceTask(refreshed.copy(status = taskStatus))
        return AppResult.Success(TaskReviewResult(updated, taskStatus))
    }

    override suspend fun cancelTask(taskId: String): AppResult<TaskParams> {
        val task = tasks.value.firstOrNull { it.id == taskId }
            ?: return AppResult.Error(Exception("المهمة غير موجودة"))
        if (task.status != "active") return AppResult.Error(Exception("يمكن إلغاء المهام النشطة فقط"))
        val cancelled = task.copy(status = "cancelled", updatedAt = "2026-07-10T15:00:00.000Z")
        replaceTask(cancelled)
        return AppResult.Success(cancelled)
    }

    // ---- Commercial P4 ----

    /** Mirrors the backend's optimistic-concurrency rule so DEMO_MODE behaves the same. */
    override suspend fun updateTask(
        taskId: String,
        expectedUpdatedAt: String,
        title: String?,
        priority: String?,
        description: TaskFieldEdit<String>,
        dueDate: TaskFieldEdit<String>
    ): AppResult<TaskParams> {
        val task = tasks.value.firstOrNull { it.id == taskId }
            ?: return AppResult.Error(Exception("المهمة غير موجودة"))
        if (task.status != "active") {
            return AppResult.Error(Exception("يمكن تعديل المهام النشطة فقط"))
        }
        if (task.updatedAt != expectedUpdatedAt) {
            return AppResult.Error(Exception("تم تعديل المهمة من مستخدم آخر"))
        }
        editCounter += 1
        val updated = task.copy(
            title = title?.trim()?.takeIf { it.isNotEmpty() } ?: task.title,
            priority = priority ?: task.priority,
            // Set(null) clears; Unchanged keeps — same three-state rule as the API.
            description = when (description) {
                is TaskFieldEdit.Unchanged -> task.description
                is TaskFieldEdit.Set -> description.value?.trim()?.takeIf { it.isNotEmpty() }
            },
            dueDate = when (dueDate) {
                is TaskFieldEdit.Unchanged -> task.dueDate
                is TaskFieldEdit.Set -> dueDate.value?.takeIf { it.isNotEmpty() }
            },
            updatedAt = "2026-08-09T10:0$editCounter:00.000Z"
        )
        replaceTask(updated)
        return AppResult.Success(updated)
    }

    override suspend fun loadComments(
        taskId: String,
        cursor: String?,
        limit: Int?
    ): AppResult<TaskCommentPageParams> {
        if (tasks.value.none { it.id == taskId }) {
            return AppResult.Error(Exception("المهمة غير موجودة"))
        }
        // Newest first, matching the real cursor page ordering.
        val ordered = comments.value.filter { it.taskId == taskId }.sortedByDescending { it.createdAt }
        val size = limit ?: 50
        return AppResult.Success(
            TaskCommentPageParams(items = ordered.take(size), nextCursor = null, hasMore = ordered.size > size)
        )
    }

    override suspend fun addComment(taskId: String, body: String): AppResult<TaskCommentParams> {
        val task = tasks.value.firstOrNull { it.id == taskId }
            ?: return AppResult.Error(Exception("المهمة غير موجودة"))
        if (task.status != "active") {
            return AppResult.Error(Exception("يمكن التعليق على المهام النشطة فقط"))
        }
        commentCounter += 1
        val comment = TaskCommentParams(
            id = "comment-$commentCounter",
            taskId = taskId,
            body = body.trim(),
            authorId = "u1",
            authorName = "مستخدم تجريبي",
            createdAt = "2026-08-09T11:0$commentCounter:00.000Z"
        )
        comments.value = comments.value + comment
        return AppResult.Success(comment)
    }

    private fun replaceAssignment(taskId: String, assignment: TaskAssignmentParams) {
        tasks.value = tasks.value.map { task ->
            if (task.id != taskId) task else task.copy(
                assignments = task.assignments.map { if (it.id == assignment.id) assignment else it }
            )
        }
    }

    private fun replaceTask(task: TaskParams) {
        tasks.value = tasks.value.map { if (it.id == task.id) task else it }
    }
}
