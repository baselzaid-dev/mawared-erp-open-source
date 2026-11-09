package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.CreateTaskCommentRequestDto
import com.example.data.remote.api.CreateTaskRequestDto
import com.example.data.remote.api.TaskApi
import com.example.data.remote.api.TaskAssignmentDto
import com.example.data.remote.api.TaskCommentDto
import com.example.data.remote.api.TaskDto
import com.example.data.remote.api.TaskEligibleEmployeeDto
import com.example.data.remote.api.TaskErrorResponseDto
import com.example.data.remote.api.TaskProgressRequestDto
import com.example.data.remote.api.TaskReviewRequestDto
import com.example.domain.model.CreateTaskRequestParams
import com.example.domain.model.TaskAssignmentParams
import com.example.domain.model.TaskCommentPageParams
import com.example.domain.model.TaskCommentParams
import com.example.domain.model.TaskEligibleEmployee
import com.example.domain.model.TaskFilters
import com.example.domain.model.TaskParams
import com.example.domain.model.TaskReviewResult
import com.example.domain.model.TaskFieldEdit
import com.example.domain.repository.TaskRepository
import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import retrofit2.Response

private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

class ApiTaskRepository(
    private val taskApi: TaskApi
) : TaskRepository {

    private val tasks = MutableStateFlow<List<TaskParams>>(emptyList())
    private val eligibleEmployees = MutableStateFlow<List<TaskEligibleEmployee>>(emptyList())
    private val moshi = Moshi.Builder().build()
    private val errorAdapter = moshi.adapter(TaskErrorResponseDto::class.java)

    /**
     * `serializeNulls()` is the whole point: without it Moshi omits null values
     * and an explicit "clear this field" would silently become "leave it alone".
     */
    private val updateTaskAdapter = moshi
        .adapter<Map<String, Any?>>(
            Types.newParameterizedType(Map::class.java, String::class.java, Any::class.java)
        )
        .serializeNulls()

    private var lastFilters = TaskFilters()

    private fun TaskAssignmentDto.toParams() = TaskAssignmentParams(
        id = id,
        taskId = taskId,
        employeeId = employee.id,
        employeeNum = employee.employeeNum,
        employeeName = employee.name,
        departmentId = employee.departmentId,
        departmentName = employee.departmentName,
        status = status,
        completionDetails = completionDetails,
        submittedAt = submittedAt,
        reviewedById = reviewer?.id,
        reviewedByName = reviewer?.name,
        reviewedAt = reviewedAt,
        reviewNote = reviewNote,
        createdAt = createdAt,
        updatedAt = updatedAt
    )

    private fun TaskDto.toParams(): TaskParams {
        val mappedAssignments = assignments.map { it.toParams() }
        val first = mappedAssignments.firstOrNull()
        return TaskParams(
            id = id,
            companyId = companyId,
            title = title,
            description = description,
            status = status,
            priority = priority,
            assignedToId = first?.employeeId,
            assignedToName = first?.employeeName,
            departmentName = first?.departmentName,
            dueDate = dueDate,
            createdById = creator.id,
            createdByName = creator.name,
            createdAt = createdAt,
            updatedAt = updatedAt,
            assignments = mappedAssignments
        )
    }

    private fun TaskCommentDto.toParams() = TaskCommentParams(
        id = id,
        taskId = taskId,
        body = body,
        authorId = author.id,
        authorName = author.name,
        createdAt = createdAt
    )

    private fun TaskEligibleEmployeeDto.toParams() = TaskEligibleEmployee(
        employeeId = employeeId,
        employeeNum = employeeNum,
        name = name,
        departmentId = departmentId,
        departmentName = departmentName
    )

    private fun <T> responseError(response: Response<T>, fallback: String): AppResult.Error {
        val payload = try {
            response.errorBody()?.string()?.let(errorAdapter::fromJson)
        } catch (_: Exception) {
            null
        }
        val message = payload?.message?.takeIf { it.isNotBlank() }
            ?: payload?.error?.takeIf { it.isNotBlank() }
            ?: fallback
        return AppResult.Error(
            Exception(message),
            AppError.ServerError(response.code(), message)
        )
    }

    private fun cacheTask(task: TaskParams) {
        tasks.value = (tasks.value.filterNot { it.id == task.id } + task)
            .sortedWith(compareBy<TaskParams> { it.dueDate ?: "9999-12-31" }.thenByDescending { it.createdAt })
    }

    private fun cacheAssignment(assignment: TaskAssignmentParams, taskStatus: String? = null) {
        tasks.value = tasks.value.map { task ->
            if (task.id != assignment.taskId) task else task.copy(
                status = taskStatus ?: task.status,
                assignments = task.assignments.map { current ->
                    if (current.id == assignment.id) assignment else current
                }
            )
        }
    }

    override fun observeTasks(): Flow<List<TaskParams>> = tasks.asStateFlow()

    override fun observeEligibleEmployees(): Flow<List<TaskEligibleEmployee>> =
        eligibleEmployees.asStateFlow()

    override suspend fun refreshTasks(filters: TaskFilters): AppResult<Unit> = try {
        val response = taskApi.getTasks(
            scope = filters.scope,
            status = filters.status,
            priority = filters.priority,
            from = filters.from,
            to = filters.to,
            employeeId = filters.employeeId
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            lastFilters = filters
            tasks.value = body.map { it.toParams() }
            AppResult.Success(Unit)
        } else {
            responseError(response, "تعذّر تحميل المهام")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadTask(taskId: String): AppResult<TaskParams> = try {
        val response = taskApi.getTask(taskId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val task = body.toParams()
            cacheTask(task)
            AppResult.Success(task)
        } else {
            responseError(response, "تعذّر تحميل تفاصيل المهمة")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadEligibleEmployees(): AppResult<Unit> = try {
        val response = taskApi.getEligibleEmployees()
        val body = response.body()
        if (response.isSuccessful && body != null) {
            eligibleEmployees.value = body.map { it.toParams() }
            AppResult.Success(Unit)
        } else {
            responseError(response, "تعذّر تحميل الموظفين المتاحين")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun createTask(request: CreateTaskRequestParams): AppResult<TaskParams> = try {
        val response = taskApi.createTask(
            CreateTaskRequestDto(
                title = request.title.trim(),
                description = request.description?.trim()?.takeIf { it.isNotEmpty() },
                priority = request.priority,
                dueDate = request.dueDate,
                employeeIds = request.employeeIds.distinct()
            )
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val task = body.toParams()
            cacheTask(task)
            refreshTasks(lastFilters)
            AppResult.Success(task)
        } else {
            responseError(response, "تعذّر إنشاء المهمة")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun updateProgress(
        assignmentId: String,
        status: String,
        completionDetails: String?
    ): AppResult<TaskAssignmentParams> = try {
        val response = taskApi.updateProgress(
            assignmentId,
            TaskProgressRequestDto(
                status = status,
                completionDetails = completionDetails?.trim()?.takeIf { it.isNotEmpty() }
            )
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val assignment = body.toParams()
            cacheAssignment(assignment)
            refreshTasks(lastFilters)
            AppResult.Success(assignment)
        } else {
            responseError(response, "تعذّر تحديث تقدم المهمة")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun reviewAssignment(
        assignmentId: String,
        action: String,
        reviewNote: String?
    ): AppResult<TaskReviewResult> = try {
        val response = taskApi.reviewAssignment(
            assignmentId,
            TaskReviewRequestDto(
                action = action,
                reviewNote = reviewNote?.trim()?.takeIf { it.isNotEmpty() }
            )
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val result = TaskReviewResult(
                assignment = body.assignment.toParams(),
                taskStatus = body.taskStatus
            )
            cacheAssignment(result.assignment, result.taskStatus)
            refreshTasks(lastFilters)
            AppResult.Success(result)
        } else {
            responseError(response, "تعذّرت مراجعة المهمة")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun cancelTask(taskId: String): AppResult<TaskParams> = try {
        val response = taskApi.cancelTask(taskId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val task = body.toParams()
            cacheTask(task)
            refreshTasks(lastFilters)
            AppResult.Success(task)
        } else {
            responseError(response, "تعذّر إلغاء المهمة")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    // ---- Commercial P4 ----

    /**
     * Builds the request body key by key so three states stay distinguishable:
     * absent (leave unchanged), present with a value (set), and present with an
     * explicit JSON null (clear). Moshi's default writer drops nulls, so the
     * adapter here is `.serializeNulls()` and only intentional keys are added —
     * a partial edit therefore cannot wipe a field the user never touched, and
     * clearing a description or due date actually reaches the server.
     *
     * A 409 means another editor moved the task first; it is surfaced as-is and
     * never auto-retried, because retrying a lost optimistic-concurrency race
     * would simply overwrite the winner.
     */
    override suspend fun updateTask(
        taskId: String,
        expectedUpdatedAt: String,
        title: String?,
        priority: String?,
        description: TaskFieldEdit<String>,
        dueDate: TaskFieldEdit<String>
    ): AppResult<TaskParams> = try {
        val payload = buildMap<String, Any?> {
            put("expectedUpdatedAt", expectedUpdatedAt)
            title?.trim()?.takeIf { it.isNotEmpty() }?.let { put("title", it) }
            priority?.let { put("priority", it) }
            if (description is TaskFieldEdit.Set) {
                put("description", description.value?.trim()?.takeIf { it.isNotEmpty() })
            }
            if (dueDate is TaskFieldEdit.Set) {
                put("dueDate", dueDate.value?.takeIf { it.isNotEmpty() })
            }
        }
        val response = taskApi.updateTask(
            taskId,
            updateTaskAdapter.toJson(payload).toRequestBody(JSON_MEDIA_TYPE)
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val task = body.toParams()
            cacheTask(task)
            refreshTasks(lastFilters)
            AppResult.Success(task)
        } else {
            responseError(response, "تعذّر تعديل المهمة")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadComments(
        taskId: String,
        cursor: String?,
        limit: Int?
    ): AppResult<TaskCommentPageParams> = try {
        val response = taskApi.getTaskComments(taskId, cursor, limit)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(
                TaskCommentPageParams(
                    items = body.items.map { it.toParams() },
                    nextCursor = body.nextCursor,
                    hasMore = body.hasMore
                )
            )
        } else {
            responseError(response, "تعذّر تحميل تعليقات المهمة")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun addComment(taskId: String, body: String): AppResult<TaskCommentParams> = try {
        val response = taskApi.createTaskComment(taskId, CreateTaskCommentRequestDto(body.trim()))
        val payload = response.body()
        if (response.isSuccessful && payload != null) {
            AppResult.Success(payload.toParams())
        } else {
            responseError(response, "تعذّرت إضافة التعليق")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override fun clear() {
        tasks.value = emptyList()
        eligibleEmployees.value = emptyList()
        lastFilters = TaskFilters()
    }
}
