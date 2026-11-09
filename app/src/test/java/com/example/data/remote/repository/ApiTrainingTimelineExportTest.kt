package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.CreateTrainingEvaluationRequestDto
import com.example.data.remote.api.TrainingApi
import com.example.data.remote.api.TrainingAssignmentDto
import com.example.data.remote.api.TrainingCertificateDto
import com.example.data.remote.api.TrainingEvaluationDto
import com.example.data.remote.api.TrainingAssignmentPageDto
import com.example.data.remote.api.TrainingBulkAssignmentRequestDto
import com.example.data.remote.api.TrainingCancellationRequestDto
import com.example.data.remote.api.TrainingCourseDto
import com.example.data.remote.api.TrainingCoursePageDto
import com.example.data.remote.api.TrainingCourseRequestDto
import com.example.data.remote.api.TrainingEligibleEmployeeDto
import com.example.data.remote.api.TrainingExportRequestDto
import com.example.data.remote.api.TrainingProgressRequestDto
import com.example.data.remote.api.TrainingReportDto
import com.example.data.remote.api.TrainingReviewRequestDto
import com.example.data.remote.api.TrainingSubmitRequestDto
import com.example.data.remote.api.TrainingTimelineDto
import com.example.data.remote.api.TrainingTimelineEventDto
import com.example.domain.model.TrainingExportFormat
import com.example.domain.model.TrainingReportFilters
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

/**
 * Sprint 12K focused tests for Training timeline + export repository mapping.
 * Uses a dedicated fake so timeline/export coverage stays isolated.
 */
private class FakeTrainingTimelineExportApi : TrainingApi {
    var failWith: Int? = null
    var errorJson: String = "{}"
    var lastTimelineId: String? = null
    var lastTimelineScope: String? = null
    var lastExportRequest: TrainingExportRequestDto? = null
    var exportBody: ResponseBody? = null
    var exportDisposition: String? = null
    var timelineDto: TrainingTimelineDto = TrainingTimelineDto(
        courseId = "c1",
        events = listOf(
            TrainingTimelineEventDto("2026-07-02T09:00:00Z", "course.published", "Course published"),
            TrainingTimelineEventDto("2026-07-01T08:00:00Z", "course.created", "Course created")
        )
    )

    private fun <T> failure(): Response<T>? = failWith?.let {
        Response.error(it, errorJson.toResponseBody("application/json".toMediaType()))
    }

    override suspend fun getCourses(
        scope: String?, status: String?, category: String?, from: String?, to: String?, query: String?
    ): Response<TrainingCoursePageDto> = error("unused")

    override suspend fun getCourse(id: String, scope: String?): Response<TrainingCourseDto> = error("unused")
    override suspend fun createCourse(request: TrainingCourseRequestDto): Response<TrainingCourseDto> = error("unused")
    override suspend fun updateCourse(id: String, request: TrainingCourseRequestDto): Response<TrainingCourseDto> = error("unused")
    override suspend fun publishCourse(id: String): Response<TrainingCourseDto> = error("unused")
    override suspend fun completeCourse(id: String): Response<TrainingCourseDto> = error("unused")
    override suspend fun archiveCourse(id: String): Response<TrainingCourseDto> = error("unused")
    override suspend fun cancelCourse(id: String, request: TrainingCancellationRequestDto): Response<TrainingCourseDto> = error("unused")
    override suspend fun getAssignments(
        scope: String?, status: String?, courseId: String?, departmentId: String?,
        employeeId: String?, from: String?, to: String?
    ): Response<TrainingAssignmentPageDto> = error("unused")
    override suspend fun getAssignment(id: String, scope: String?): Response<TrainingAssignmentDto> = error("unused")
    override suspend fun getEligibleEmployees(query: String?, departmentId: String?): Response<List<TrainingEligibleEmployeeDto>> = error("unused")
    override suspend fun assignCourse(id: String, request: TrainingBulkAssignmentRequestDto): Response<List<TrainingAssignmentDto>> = error("unused")
    override suspend fun updateProgress(id: String, request: TrainingProgressRequestDto): Response<TrainingAssignmentDto> = error("unused")
    override suspend fun submitAssignment(id: String, request: TrainingSubmitRequestDto): Response<TrainingAssignmentDto> = error("unused")
    override suspend fun reviewAssignment(id: String, request: TrainingReviewRequestDto): Response<TrainingAssignmentDto> = error("unused")
    override suspend fun cancelAssignment(id: String, request: TrainingCancellationRequestDto): Response<TrainingAssignmentDto> = error("unused")
    override suspend fun issueCertificate(id: String): Response<TrainingCertificateDto> = error("unused")
    override suspend fun getCertificate(id: String): Response<TrainingCertificateDto> = error("unused")
    override suspend fun createEvaluation(
        id: String,
        request: CreateTrainingEvaluationRequestDto
    ): Response<TrainingEvaluationDto> = error("unused")
    override suspend fun getEvaluation(id: String): Response<TrainingEvaluationDto> = error("unused")
    override suspend fun getReport(
        scope: String?, from: String?, to: String?, courseStatus: String?,
        assignmentStatus: String?, category: String?, departmentId: String?
    ): Response<TrainingReportDto> = error("unused")

    override suspend fun getCourseTimeline(id: String, scope: String?): Response<TrainingTimelineDto> {
        lastTimelineId = id
        lastTimelineScope = scope
        return failure() ?: Response.success(timelineDto.copy(courseId = id))
    }

    override suspend fun exportReport(request: TrainingExportRequestDto): Response<ResponseBody> {
        lastExportRequest = request
        failure<ResponseBody>()?.let { return it }
        val body = exportBody ?: "id,title\n1,training".toResponseBody("text/csv".toMediaType())
        val disposition = exportDisposition
        return if (disposition != null) {
            Response.success(body, okhttp3.Headers.headersOf("Content-Disposition", disposition))
        } else {
            Response.success(body)
        }
    }

    private fun <T> error(message: String): Response<T> =
        Response.error(500, message.toResponseBody("text/plain".toMediaType()))
}

class ApiTrainingTimelineExportTest {

    @Test
    fun `loadCourseTimeline maps backend events without inventing extras`() = runTest {
        val api = FakeTrainingTimelineExportApi()
        val result = ApiTrainingRepository(api).loadCourseTimeline("c1", "company")
        assertTrue(result is AppResult.Success)
        val timeline = (result as AppResult.Success).data
        assertEquals("c1", timeline.courseId)
        assertEquals(2, timeline.events.size)
        assertEquals("course.published", timeline.events[0].type)
        assertEquals("Course created", timeline.events[1].summary)
        assertEquals("c1", api.lastTimelineId)
        assertEquals("company", api.lastTimelineScope)
    }

    @Test
    fun `loadCourseTimeline surfaces Arabic backend errors`() = runTest {
        val api = FakeTrainingTimelineExportApi().apply {
            failWith = 404
            errorJson = """{"error":"TRAINING_COURSE_NOT_FOUND","message":"الدورة التدريبية غير موجودة","code":404}"""
        }
        val result = ApiTrainingRepository(api).loadCourseTimeline("missing")
        assertTrue(result is AppResult.Error)
        result as AppResult.Error
        assertEquals(404, (result.appError as AppError.ServerError).code)
        assertEquals("الدورة التدريبية غير موجودة", result.exception.message)
    }

    @Test
    fun `exportReport streams bytes and prefers Content-Disposition filename`() = runTest {
        val api = FakeTrainingTimelineExportApi().apply {
            exportBody = "course,status\nTR-1,published".toResponseBody("text/csv".toMediaType())
            exportDisposition = "attachment; filename=\"training-2026-07-20.csv\""
        }
        val result = ApiTrainingRepository(api).exportReport(
            TrainingExportFormat.CSV,
            TrainingReportFilters(scope = "company", category = "سلامة"),
            locale = "ar"
        )
        assertTrue(result is AppResult.Success)
        val payload = (result as AppResult.Success).data
        assertEquals("text/csv", payload.mimeType)
        assertEquals("training-2026-07-20.csv", payload.filename)
        assertTrue(payload.bytes.isNotEmpty())
        assertEquals("csv", api.lastExportRequest?.format)
        assertEquals("ar", api.lastExportRequest?.locale)
        assertEquals("company", api.lastExportRequest?.scope)
        assertEquals("سلامة", api.lastExportRequest?.category)
    }

    @Test
    fun `exportReport forbidden is never treated as success`() = runTest {
        val api = FakeTrainingTimelineExportApi().apply {
            failWith = 403
            errorJson = """{"error":"Forbidden","message":"لا تملك صلاحية تصدير تقرير التدريب","code":403}"""
        }
        val result = ApiTrainingRepository(api).exportReport(TrainingExportFormat.PDF)
        assertTrue(result is AppResult.Error)
        assertEquals(403, ((result as AppResult.Error).appError as AppError.ServerError).code)
        assertTrue(result.exception.message.orEmpty().contains("لا تملك صلاحية"))
    }

    @Test
    fun `exportReport falls back to safe default filename`() = runTest {
        val api = FakeTrainingTimelineExportApi().apply {
            exportDisposition = "attachment; filename=\"../../evil.pdf\""
        }
        val result = ApiTrainingRepository(api).exportReport(TrainingExportFormat.PDF)
        assertTrue(result is AppResult.Success)
        assertEquals("training_export.pdf", (result as AppResult.Success).data.filename)
        assertEquals("application/pdf", result.data.mimeType)
    }
}
