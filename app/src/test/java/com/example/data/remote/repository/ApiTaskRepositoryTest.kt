package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.CreateTaskCommentRequestDto
import com.example.data.remote.api.CreateTaskRequestDto
import com.example.data.remote.api.TaskActorDto
import com.example.data.remote.api.TaskCommentDto
import com.example.data.remote.api.TaskCommentPageDto
import okhttp3.RequestBody
import okio.Buffer
import com.example.data.remote.api.TaskApi
import com.example.data.remote.api.TaskAssignmentDto
import com.example.data.remote.api.TaskAssignmentEmployeeDto
import com.example.data.remote.api.TaskDto
import com.example.data.remote.api.TaskEligibleEmployeeDto
import com.example.data.remote.api.TaskProgressRequestDto
import com.example.data.remote.api.TaskReviewRequestDto
import com.example.data.remote.api.TaskReviewResponseDto
import com.example.domain.model.CreateTaskRequestParams
import com.example.domain.model.TaskFilters
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

private fun taskAssignmentDto(
    id: String = "a1",
    taskId: String = "t1",
    status: String = "assigned",
    details: String? = null
) = TaskAssignmentDto(
    id = id,
    taskId = taskId,
    employee = TaskAssignmentEmployeeDto("e1", "EMP-1", "موظف", "d1", "الموارد البشرية"),
    status = status,
    completionDetails = details
)

private fun taskDto(
    id: String = "t1",
    status: String = "active",
    assignments: List<TaskAssignmentDto> = listOf(taskAssignmentDto(taskId = id))
) = TaskDto(
    id = id,
    companyId = "c1",
    title = "مهمة",
    description = "وصف",
    priority = "high",
    dueDate = "2026-07-20",
    status = status,
    creator = TaskActorDto("u1", "مدير"),
    assignments = assignments
)

/** `internal` so the P4 collaboration suite can reuse this fake. */
internal class FakeTaskApi(
    var tasks: List<TaskDto> = listOf(taskDto()),
    var failWith: Int? = null,
    var errorJson: String = "{}"
) : TaskApi {
    var lastFilters: List<String?> = emptyList()
    var lastCreate: CreateTaskRequestDto? = null
    var lastProgress: TaskProgressRequestDto? = null
    var lastReview: TaskReviewRequestDto? = null
    var listCalls = 0

    private fun <T> failure(): Response<T>? = failWith?.let {
        Response.error(it, errorJson.toResponseBody("application/json".toMediaType()))
    }

    override suspend fun getTasks(
        scope: String?,
        status: String?,
        priority: String?,
        from: String?,
        to: String?,
        employeeId: String?
    ): Response<List<TaskDto>> {
        listCalls += 1
        lastFilters = listOf(scope, status, priority, from, to, employeeId)
        return failure() ?: Response.success(tasks)
    }

    override suspend fun getTask(id: String): Response<TaskDto> =
        failure() ?: Response.success(tasks.firstOrNull { it.id == id } ?: taskDto(id))

    override suspend fun getEligibleEmployees(): Response<List<TaskEligibleEmployeeDto>> =
        failure() ?: Response.success(
            listOf(TaskEligibleEmployeeDto("e1", "EMP-1", "موظف", "d1", "الموارد البشرية"))
        )

    override suspend fun createTask(request: CreateTaskRequestDto): Response<TaskDto> {
        lastCreate = request
        val created = taskDto(
            id = "created",
            assignments = request.employeeIds.mapIndexed { index, employeeId ->
                taskAssignmentDto(id = "a$index", taskId = "created").copy(
                    employee = TaskAssignmentEmployeeDto(employeeId, "EMP-$employeeId", "موظف $employeeId")
                )
            }
        )
        return failure() ?: Response.success(created)
    }

    override suspend fun updateProgress(
        id: String,
        request: TaskProgressRequestDto
    ): Response<TaskAssignmentDto> {
        lastProgress = request
        return failure() ?: Response.success(
            taskAssignmentDto(id = id, status = request.status, details = request.completionDetails)
        )
    }

    override suspend fun reviewAssignment(
        id: String,
        request: TaskReviewRequestDto
    ): Response<TaskReviewResponseDto> {
        lastReview = request
        val status = if (request.action == "accept") "accepted" else "returned"
        return failure() ?: Response.success(
            TaskReviewResponseDto(taskAssignmentDto(id = id, status = status), if (status == "accepted") "completed" else "active")
        )
    }

    override suspend fun cancelTask(id: String): Response<TaskDto> =
        failure() ?: Response.success(taskDto(id = id, status = "cancelled"))

    // ---- Commercial P4 ----

    /** Raw JSON, so tests can assert on omitted vs explicitly-null properties. */
    var lastUpdateJson: String? = null
    var lastComment: CreateTaskCommentRequestDto? = null
    var lastCommentCursor: String? = null
    var comments: List<TaskCommentDto> = emptyList()

    override suspend fun updateTask(id: String, request: RequestBody): Response<TaskDto> {
        val buffer = Buffer()
        request.writeTo(buffer)
        lastUpdateJson = buffer.readUtf8()
        return failure() ?: Response.success(
            taskDto(id = id).copy(updatedAt = "2026-08-09T10:05:00.000Z")
        )
    }

    override suspend fun getTaskComments(
        id: String,
        cursor: String?,
        limit: Int?
    ): Response<TaskCommentPageDto> {
        lastCommentCursor = cursor
        return failure() ?: Response.success(
            TaskCommentPageDto(items = comments, nextCursor = "next-cursor", hasMore = true)
        )
    }

    override suspend fun createTaskComment(
        id: String,
        request: CreateTaskCommentRequestDto
    ): Response<TaskCommentDto> {
        lastComment = request
        return failure() ?: Response.success(
            TaskCommentDto("comment-1", id, request.body, TaskActorDto("u1", "مدير"), "2026-08-09T11:00:00.000Z")
        )
    }
}

class ApiTaskRepositoryTest {

    @Test
    fun `refresh maps raw statuses and forwards all filters`() = runTest {
        val api = FakeTaskApi()
        val repo = ApiTaskRepository(api)
        val filters = TaskFilters("department", "submitted", "high", "2026-07-01", "2026-07-31", "e1")
        val result = repo.refreshTasks(filters)
        assertTrue(result is AppResult.Success)
        assertEquals(listOf("department", "submitted", "high", "2026-07-01", "2026-07-31", "e1"), api.lastFilters)
        val task = repo.observeTasks().first().single()
        assertEquals("active", task.status)
        assertEquals("assigned", task.assignments.single().status)
    }

    @Test
    fun `eligible employees map only safe display fields`() = runTest {
        val repo = ApiTaskRepository(FakeTaskApi())
        assertTrue(repo.loadEligibleEmployees() is AppResult.Success)
        val employee = repo.observeEligibleEmployees().first().single()
        assertEquals("e1", employee.employeeId)
        assertEquals("الموارد البشرية", employee.departmentName)
    }

    @Test
    fun `create maps multiple assignees and refreshes after success`() = runTest {
        val api = FakeTaskApi(tasks = emptyList())
        val repo = ApiTaskRepository(api)
        val result = repo.createTask(
            CreateTaskRequestParams("مهمة", "وصف", "urgent", "2026-07-20", listOf("e1", "e2"))
        )
        assertTrue(result is AppResult.Success)
        assertEquals(listOf("e1", "e2"), api.lastCreate?.employeeIds)
        assertTrue(api.listCalls > 0)
    }

    @Test
    fun `progress and review keep completion details raw status and refresh`() = runTest {
        val api = FakeTaskApi()
        val repo = ApiTaskRepository(api)
        repo.refreshTasks()
        val progress = repo.updateProgress("a1", "submitted", "تم الإنجاز") as AppResult.Success
        assertEquals("submitted", progress.data.status)
        assertEquals("تم الإنجاز", api.lastProgress?.completionDetails)

        val review = repo.reviewAssignment("a1", "accept") as AppResult.Success
        assertEquals("accepted", review.data.assignment.status)
        assertEquals("completed", review.data.taskStatus)
        assertEquals("accept", api.lastReview?.action)
        assertTrue(api.listCalls >= 3)
    }

    @Test
    fun `cancel uses the soft workflow and never removes the cached task`() = runTest {
        val api = FakeTaskApi()
        val repo = ApiTaskRepository(api)
        repo.refreshTasks()
        val result = repo.cancelTask("t1") as AppResult.Success
        assertEquals("cancelled", result.data.status)
        assertFalse(repo.observeTasks().first().isEmpty())
    }

    @Test
    fun `Arabic backend errors remain ServerError and never become fake success`() = runTest {
        val json = """{"error":"TaskReviewInvalid","message":"يمكن مراجعة المهام المسلّمة فقط","code":409}"""
        val result = ApiTaskRepository(FakeTaskApi(failWith = 409, errorJson = json))
            .reviewAssignment("a1", "accept")
        assertTrue(result is AppResult.Error)
        result as AppResult.Error
        assertEquals(409, (result.appError as AppError.ServerError).code)
        assertEquals("يمكن مراجعة المهام المسلّمة فقط", result.exception.message)
    }
}
