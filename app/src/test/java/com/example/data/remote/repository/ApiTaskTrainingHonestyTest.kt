package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.*
import com.example.domain.model.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

private fun trainingCourseDto(
    id: String = "c1",
    status: String = "draft",
    resources: List<TrainingResourceDto> = listOf(
        TrainingResourceDto("r1", "دليل", "document", "https://example.com/guide", 0)
    )
) = TrainingCourseDto(
    id = id,
    companyId = "company-1",
    courseCode = "TR-202607-ABCD1234",
    title = "دورة آمنة",
    description = "وصف",
    category = "تقنية",
    instructorName = "مدرب",
    deliveryMode = "online",
    location = null,
    startDate = "2026-07-15",
    endDate = "2026-07-16",
    durationHours = 4,
    capacity = 10,
    status = status,
    resources = resources,
    assignmentSummary = TrainingAssignmentSummaryDto(total = 1, inProgress = 1),
    createdAt = "2026-07-01T08:00:00Z"
)

private fun trainingAssignmentDto(
    id: String = "a1",
    status: String = "assigned",
    progress: Int = 0,
    score: Int? = null
) = TrainingAssignmentDto(
    id = id,
    companyId = "company-1",
    courseId = "c1",
    course = TrainingCourseSummaryDto(
        "c1", "TR-202607-ABCD1234", "دورة آمنة", "تقنية", "مدرب",
        "online", null, "2026-07-15", "2026-07-16", 4, "published"
    ),
    employee = TrainingEmployeeSnapshotDto("e1", "EMP-1", "موظف", "d1", "التقنية"),
    status = status,
    progressPercent = progress,
    assignedAt = "2026-07-02T08:00:00Z",
    score = score
)

private fun trainingReportDto() = TrainingReportDto(
    summary = TrainingReportSummaryDto(
        courseCount = 1, draftCourseCount = 0, publishedCourseCount = 1,
        completedCourseCount = 0, cancelledCourseCount = 0, assignmentCount = 1,
        assignedCount = 0, inProgressCount = 1, submittedCount = 0,
        completedAssignmentCount = 0, returnedCount = 0, cancelledAssignmentCount = 0,
        overdueCount = 0, completionRatePercent = 0.0, averageProgressPercent = 55.0,
        averageScore = null
    ),
    courses = listOf(
        TrainingReportCourseRowDto(
            "c1", "TR-202607-ABCD1234", "دورة آمنة", "تقنية", "مدرب",
            "online", null, "2026-07-15", "2026-07-16", 4, "published",
            TrainingAssignmentSummaryDto(total = 1, inProgress = 1)
        )
    ),
    assignments = listOf(
        TrainingReportAssignmentRowDto(
            "a1", "c1", TrainingEmployeeSnapshotDto("e1", "EMP-1", "موظف", "d1", "التقنية"),
            "in_progress"
        )
    ),
    departments = listOf(TrainingReportDepartmentRowDto("d1", "التقنية", 1, 0, 0.0))
)

/** `internal` so the P4 collaboration suite can reuse this fake. */
internal class FakeTrainingApi(
    var failWith: Int? = null,
    var errorJson: String = "{}"
) : TrainingApi {
    var courses = listOf(trainingCourseDto(status = "published"))
    var assignments = listOf(trainingAssignmentDto(status = "in_progress", progress = 55))
    var courseFilters: List<String?> = emptyList()
    var assignmentFilters: List<String?> = emptyList()
    var lastCourseRequest: TrainingCourseRequestDto? = null
    var lastBulkRequest: TrainingBulkAssignmentRequestDto? = null
    var lastProgress: TrainingProgressRequestDto? = null
    var lastSubmit: TrainingSubmitRequestDto? = null
    var lastReview: TrainingReviewRequestDto? = null
    var lastCancellation: TrainingCancellationRequestDto? = null
    var listCalls = 0
    var mutationCalls = 0

    private fun <T> failure(): Response<T>? = failWith?.let {
        Response.error(it, errorJson.toResponseBody("application/json".toMediaType()))
    }

    override suspend fun getCourses(
        scope: String?, status: String?, category: String?, from: String?, to: String?, query: String?
    ): Response<TrainingCoursePageDto> {
        listCalls += 1
        courseFilters = listOf(scope, status, category, from, to, query)
        return failure() ?: Response.success(TrainingCoursePageDto(courses, 1, 25, courses.size))
    }

    override suspend fun getCourse(id: String, scope: String?): Response<TrainingCourseDto> =
        failure() ?: Response.success(courses.firstOrNull { it.id == id } ?: trainingCourseDto(id))

    override suspend fun createCourse(request: TrainingCourseRequestDto): Response<TrainingCourseDto> {
        mutationCalls += 1
        lastCourseRequest = request
        return failure() ?: Response.success(trainingCourseDto("created").copy(
            title = request.title,
            deliveryMode = request.deliveryMode,
            resources = request.resources.mapIndexed { index, row ->
                TrainingResourceDto("new-$index", row.title, row.type, row.url, row.sortOrder ?: index)
            }
        ))
    }

    override suspend fun updateCourse(id: String, request: TrainingCourseRequestDto): Response<TrainingCourseDto> {
        mutationCalls += 1
        lastCourseRequest = request
        return failure() ?: Response.success(trainingCourseDto(id).copy(title = request.title))
    }

    override suspend fun publishCourse(id: String): Response<TrainingCourseDto> =
        actionCourse(id, "published")
    override suspend fun completeCourse(id: String): Response<TrainingCourseDto> =
        actionCourse(id, "completed")
    override suspend fun archiveCourse(id: String): Response<TrainingCourseDto> =
        actionCourse(id, "archived")

    override suspend fun cancelCourse(
        id: String,
        request: TrainingCancellationRequestDto
    ): Response<TrainingCourseDto> {
        lastCancellation = request
        return actionCourse(id, "cancelled")
    }

    private fun actionCourse(id: String, status: String): Response<TrainingCourseDto> {
        mutationCalls += 1
        return failure() ?: Response.success(trainingCourseDto(id, status))
    }

    override suspend fun getAssignments(
        scope: String?, status: String?, courseId: String?, departmentId: String?,
        employeeId: String?, from: String?, to: String?
    ): Response<TrainingAssignmentPageDto> {
        listCalls += 1
        assignmentFilters = listOf(scope, status, courseId, departmentId, employeeId, from, to)
        return failure() ?: Response.success(TrainingAssignmentPageDto(assignments, 1, 25, assignments.size))
    }

    override suspend fun getAssignment(id: String, scope: String?): Response<TrainingAssignmentDto> =
        failure() ?: Response.success(assignments.firstOrNull { it.id == id } ?: trainingAssignmentDto(id))

    override suspend fun getEligibleEmployees(
        query: String?,
        departmentId: String?
    ): Response<List<TrainingEligibleEmployeeDto>> = failure() ?: Response.success(
        listOf(TrainingEligibleEmployeeDto("e1", "EMP-1", "موظف", "d1", "التقنية", "Employee"))
    )

    override suspend fun assignCourse(
        id: String,
        request: TrainingBulkAssignmentRequestDto
    ): Response<List<TrainingAssignmentDto>> {
        mutationCalls += 1
        lastBulkRequest = request
        return failure() ?: Response.success(request.employeeIds.mapIndexed { index, employeeId ->
            trainingAssignmentDto("assigned-$index").copy(
                employee = TrainingEmployeeSnapshotDto(employeeId, "EMP-$employeeId", "موظف $employeeId")
            )
        })
    }

    override suspend fun updateProgress(
        id: String,
        request: TrainingProgressRequestDto
    ): Response<TrainingAssignmentDto> {
        mutationCalls += 1
        lastProgress = request
        return failure() ?: Response.success(trainingAssignmentDto(id, "in_progress", request.progressPercent))
    }

    override suspend fun submitAssignment(
        id: String,
        request: TrainingSubmitRequestDto
    ): Response<TrainingAssignmentDto> {
        mutationCalls += 1
        lastSubmit = request
        return failure() ?: Response.success(trainingAssignmentDto(id, "submitted", 100))
    }

    override suspend fun reviewAssignment(
        id: String,
        request: TrainingReviewRequestDto
    ): Response<TrainingAssignmentDto> {
        mutationCalls += 1
        lastReview = request
        return failure() ?: Response.success(
            trainingAssignmentDto(id, if (request.action == "accept") "completed" else "returned", 100, request.score)
                .copy(reviewNote = request.reviewNote)
        )
    }

    override suspend fun cancelAssignment(
        id: String,
        request: TrainingCancellationRequestDto
    ): Response<TrainingAssignmentDto> {
        mutationCalls += 1
        lastCancellation = request
        return failure() ?: Response.success(
            trainingAssignmentDto(id, "cancelled").copy(cancellation = TrainingCancellationDto("2026-07-11T10:00:00Z", request.cancellationReason))
        )
    }

    // ---- Commercial P4 completion artifacts ----

    var certificateIssueCalls = 0
    var lastEvaluation: CreateTrainingEvaluationRequestDto? = null

    private fun certificateDto(assignmentId: String) = TrainingCertificateDto(
        id = "certificate-1",
        assignmentId = assignmentId,
        courseId = "c1",
        employeeId = "e1",
        serialNumber = "CERT-202608-ABCDEF0123",
        courseTitle = "دورة",
        employeeName = "موظف",
        employeeNum = "EMP-1",
        completedAt = "2026-08-01T10:00:00Z",
        issuedBy = TaskActorDto("u1", "مدير"),
        issuedAt = "2026-08-09T12:00:00Z"
    )

    override suspend fun issueCertificate(id: String): Response<TrainingCertificateDto> {
        certificateIssueCalls += 1
        mutationCalls += 1
        return failure() ?: Response.success(certificateDto(id))
    }

    override suspend fun getCertificate(id: String): Response<TrainingCertificateDto> =
        failure() ?: Response.success(certificateDto(id))

    override suspend fun createEvaluation(
        id: String,
        request: CreateTrainingEvaluationRequestDto
    ): Response<TrainingEvaluationDto> {
        mutationCalls += 1
        lastEvaluation = request
        return failure() ?: Response.success(
            TrainingEvaluationDto(
                id = "evaluation-1",
                assignmentId = id,
                courseId = "c1",
                employeeId = "e1",
                effectivenessScore = request.effectivenessScore,
                knowledgeScore = request.knowledgeScore,
                applicationScore = request.applicationScore,
                recommendation = request.recommendation,
                comment = request.comment,
                evaluatedBy = TaskActorDto("u1", "مدير"),
                evaluatedAt = "2026-08-09T12:30:00Z"
            )
        )
    }

    override suspend fun getEvaluation(id: String): Response<TrainingEvaluationDto> =
        failure() ?: Response.success(
            TrainingEvaluationDto(
                id = "evaluation-1",
                assignmentId = id,
                courseId = "c1",
                employeeId = "e1",
                effectivenessScore = 4,
                knowledgeScore = 5,
                applicationScore = 3,
                recommendation = "recommended",
                comment = null,
                evaluatedBy = TaskActorDto("u1", "مدير"),
                evaluatedAt = "2026-08-09T12:30:00Z"
            )
        )

    override suspend fun getReport(
        scope: String?, from: String?, to: String?, courseStatus: String?,
        assignmentStatus: String?, category: String?, departmentId: String?
    ): Response<TrainingReportDto> = failure() ?: Response.success(trainingReportDto())

    override suspend fun getCourseTimeline(
        id: String,
        scope: String?
    ): Response<TrainingTimelineDto> = failure() ?: Response.success(
        TrainingTimelineDto(
            courseId = id,
            events = listOf(
                TrainingTimelineEventDto("2026-07-01T08:00:00Z", "course.created", "Course created"),
                TrainingTimelineEventDto("2026-07-02T08:00:00Z", "course.published", "Course published")
            )
        )
    )

    override suspend fun exportReport(
        request: TrainingExportRequestDto
    ): Response<okhttp3.ResponseBody> = failure() ?: Response.success(
        "training,export".toResponseBody("text/csv".toMediaType())
    )
}

class ApiTrainingRepositoryTest {

    private fun request() = TrainingCourseRequestParams(
        "دورة جديدة", "وصف", "تقنية", "مدرب", "online", null,
        "2026-07-15", "2026-07-16", 4, 10,
        listOf(TrainingResourceRequestParams("دليل", "document", "https://example.com/guide"))
    )

    @Test
    fun `refresh forwards scoped filters and preserves backend statuses`() = runTest {
        val api = FakeTrainingApi()
        val repo = ApiTrainingRepository(api)
        repo.refreshCourses(TrainingCourseFilters("department", "published", "تقنية", "2026-07-01", "2026-07-31", "دورة"))
        repo.refreshAssignments(TrainingAssignmentFilters("department", "in_progress", "c1", "d1", "e1", "2026-07-01", "2026-07-31"))

        assertEquals(listOf("department", "published", "تقنية", "2026-07-01", "2026-07-31", "دورة"), api.courseFilters)
        assertEquals(listOf("department", "in_progress", "c1", "d1", "e1", "2026-07-01", "2026-07-31"), api.assignmentFilters)
        assertEquals("published", repo.observeCourses().first().single().status)
        assertEquals("in_progress", repo.observeAssignments().first().single().status)
        assertEquals("document", repo.observeCourses().first().single().resources.single().type)
    }

    @Test
    fun `create and update map safe course fields and refresh after success`() = runTest {
        val api = FakeTrainingApi()
        val repo = ApiTrainingRepository(api)
        val created = repo.createCourse(request()) as AppResult.Success
        assertEquals("created", created.data.id)
        assertEquals("online", api.lastCourseRequest?.deliveryMode)
        assertEquals("https://example.com/guide", api.lastCourseRequest?.resources?.single()?.url)

        val updated = repo.updateCourse("c1", request().copy(title = "عنوان محدث")) as AppResult.Success
        assertEquals("عنوان محدث", updated.data.title)
        assertTrue(api.listCalls >= 2)
    }

    @Test
    fun `assignment workflow uses real endpoints and never fabricates completion`() = runTest {
        val api = FakeTrainingApi()
        val repo = ApiTrainingRepository(api)
        val assigned = repo.assignCourse("c1", listOf("e1", "e2")) as AppResult.Success
        assertEquals(listOf("e1", "e2"), api.lastBulkRequest?.employeeIds)
        assertEquals(2, assigned.data.size)

        val progress = repo.updateAssignmentProgress("a1", 65) as AppResult.Success
        assertEquals("in_progress", progress.data.status)
        assertEquals(65, api.lastProgress?.progressPercent)

        val submitted = repo.submitAssignment("a1", "ملاحظة") as AppResult.Success
        assertEquals("submitted", submitted.data.status)
        assertEquals("ملاحظة", api.lastSubmit?.completionNote)

        val reviewed = repo.reviewAssignment("a1", "accept", 91, "تم") as AppResult.Success
        assertEquals("completed", reviewed.data.status)
        assertEquals(91, api.lastReview?.score)
        assertTrue(api.listCalls >= 8)
    }

    @Test
    fun `soft lifecycle actions and server report remain available without delete methods`() = runTest {
        val api = FakeTrainingApi()
        val repo = ApiTrainingRepository(api)
        assertEquals("published", (repo.publishCourse("c1") as AppResult.Success).data.status)
        assertEquals("completed", (repo.completeCourse("c1") as AppResult.Success).data.status)
        assertEquals("archived", (repo.archiveCourse("c1") as AppResult.Success).data.status)
        assertEquals("cancelled", (repo.cancelCourse("c1", "سبب") as AppResult.Success).data.status)
        assertEquals("cancelled", (repo.cancelAssignment("a1", "سبب") as AppResult.Success).data.status)
        assertEquals("سبب", api.lastCancellation?.cancellationReason)

        val report = repo.loadReport(TrainingReportFilters(scope = "company")) as AppResult.Success
        assertEquals(55.0, report.data.summary.averageProgressPercent, 0.0)
        assertNull(report.data.summary.averageScore)
    }

    @Test
    fun `local validation blocks unsafe fake success before calling the API`() = runTest {
        val api = FakeTrainingApi()
        val repo = ApiTrainingRepository(api)
        assertTrue(repo.assignCourse("c1", listOf("e1", "e1")) is AppResult.Error)
        assertTrue(repo.updateAssignmentProgress("a1", 100) is AppResult.Error)
        assertTrue(repo.reviewAssignment("a1", "return", null, null) is AppResult.Error)
        assertTrue(repo.cancelAssignment("a1", "") is AppResult.Error)
        assertEquals(0, api.mutationCalls)
    }

    @Test
    fun `Arabic backend errors remain server errors instead of fake success`() = runTest {
        val api = FakeTrainingApi(
            failWith = 409,
            errorJson = """{"error":"TRAINING_COURSE_IMMUTABLE","message":"لا يمكن تعديل الدورة بعد نشرها","code":409}"""
        )
        val result = ApiTrainingRepository(api).publishCourse("c1")
        assertTrue(result is AppResult.Error)
        result as AppResult.Error
        assertEquals(409, (result.appError as AppError.ServerError).code)
        assertEquals("لا يمكن تعديل الدورة بعد نشرها", result.exception.message)
    }

    @Test
    fun `clear removes cached tenant data on logout`() = runTest {
        val repo = ApiTrainingRepository(FakeTrainingApi())
        repo.refreshTraining()
        repo.loadReport()
        assertFalse(repo.observeCourses().first().isEmpty())
        repo.clear()
        assertTrue(repo.observeCourses().first().isEmpty())
        assertTrue(repo.observeAssignments().first().isEmpty())
        assertNull(repo.observeReport().first())
    }
}
