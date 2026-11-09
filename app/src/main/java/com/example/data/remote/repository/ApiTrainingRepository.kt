package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.*
import com.example.domain.model.*
import com.example.domain.repository.TrainingRepository
import com.squareup.moshi.Moshi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import okhttp3.ResponseBody
import retrofit2.Response
import java.io.ByteArrayOutputStream

private const val MAX_TRAINING_EXPORT_BYTES = 10 * 1024 * 1024

class ApiTrainingRepository(
    private val trainingApi: TrainingApi
) : TrainingRepository {

    private val courses = MutableStateFlow<List<TrainingCourseParams>>(emptyList())
    private val assignments = MutableStateFlow<List<TrainingAssignmentParams>>(emptyList())
    private val eligibleEmployees = MutableStateFlow<List<TrainingEligibleEmployee>>(emptyList())
    private val report = MutableStateFlow<TrainingReportParams?>(null)
    private val errorAdapter = Moshi.Builder().build().adapter(TrainingErrorResponseDto::class.java)
    private var lastCourseFilters = TrainingCourseFilters()
    private var lastAssignmentFilters = TrainingAssignmentFilters()

    private fun TrainingAssignmentSummaryDto.toParams() = TrainingAssignmentSummary(
        total = total,
        assigned = assigned,
        inProgress = inProgress,
        submitted = submitted,
        completed = completed,
        returned = returned,
        cancelled = cancelled
    )

    private fun TrainingCourseSummaryDto.toParams() = TrainingCourseSummaryParams(
        id = id,
        courseCode = courseCode,
        title = title,
        category = category,
        instructorName = instructorName,
        deliveryMode = deliveryMode,
        location = location,
        startDate = startDate,
        endDate = endDate,
        durationHours = durationHours,
        status = status
    )

    private fun TrainingEmployeeSnapshotDto.toParams() = TrainingEmployeeSnapshot(
        employeeId = employeeId,
        employeeNum = employeeNum,
        displayName = displayName,
        departmentId = departmentId,
        departmentName = departmentName
    )

    private fun TrainingAssignmentDto.toParams() = TrainingAssignmentParams(
        id = id,
        companyId = companyId,
        courseId = courseId,
        course = course?.toParams(),
        employee = employee.toParams(),
        status = status,
        progressPercent = progressPercent,
        assignedAt = assignedAt,
        startedAt = startedAt,
        submittedAt = submittedAt,
        completedAt = completedAt,
        reviewedAt = reviewedAt,
        reviewNote = reviewNote,
        score = score,
        cancellation = cancellation?.let { TrainingCancellationParams(it.cancelledAt, it.reason) },
        createdAt = createdAt,
        updatedAt = updatedAt
    )

    private fun TrainingCourseDto.toParams() = TrainingCourseParams(
        id = id,
        companyId = companyId,
        courseCode = courseCode,
        title = title,
        description = description,
        category = category,
        instructorName = instructorName,
        deliveryMode = deliveryMode,
        location = location,
        startDate = startDate,
        endDate = endDate,
        durationHours = durationHours,
        capacity = capacity,
        status = status,
        resources = resources.map { TrainingResourceParams(it.id, it.title, it.type, it.url, it.sortOrder) },
        assignmentSummary = assignmentSummary.toParams(),
        ownAssignment = ownAssignment?.toParams(),
        createdAt = createdAt,
        publishedAt = publishedAt,
        completedAt = completedAt,
        cancelledAt = cancelledAt,
        archivedAt = archivedAt,
        updatedAt = updatedAt
    )

    private fun TrainingEligibleEmployeeDto.toParams() = TrainingEligibleEmployee(
        employeeId = employeeId,
        employeeNum = employeeNum,
        displayName = displayName,
        departmentId = departmentId,
        departmentName = departmentName,
        roleName = roleName
    )

    private fun TrainingReportDto.toParams() = TrainingReportParams(
        summary = TrainingReportSummary(
            courseCount = summary.courseCount,
            draftCourseCount = summary.draftCourseCount,
            publishedCourseCount = summary.publishedCourseCount,
            completedCourseCount = summary.completedCourseCount,
            cancelledCourseCount = summary.cancelledCourseCount,
            assignmentCount = summary.assignmentCount,
            assignedCount = summary.assignedCount,
            inProgressCount = summary.inProgressCount,
            submittedCount = summary.submittedCount,
            completedAssignmentCount = summary.completedAssignmentCount,
            returnedCount = summary.returnedCount,
            cancelledAssignmentCount = summary.cancelledAssignmentCount,
            overdueCount = summary.overdueCount,
            completionRatePercent = summary.completionRatePercent,
            averageProgressPercent = summary.averageProgressPercent,
            averageScore = summary.averageScore
        ),
        courses = courses.map { row ->
            TrainingReportCourseRow(
                course = TrainingCourseSummaryParams(
                    row.id, row.courseCode, row.title, row.category, row.instructorName,
                    row.deliveryMode, row.location, row.startDate, row.endDate,
                    row.durationHours, row.status
                ),
                assignmentSummary = row.assignmentSummary.toParams()
            )
        },
        assignments = assignments.map { row ->
            TrainingReportAssignmentRow(row.id, row.courseId, row.employee.toParams(), row.status)
        },
        departments = departments.map { row ->
            TrainingReportDepartmentRow(
                row.departmentId,
                row.departmentName,
                row.assignmentCount,
                row.completedCount,
                row.completionRatePercent
            )
        }
    )

    private fun TrainingCourseRequestParams.toDto() = TrainingCourseRequestDto(
        title = title.trim(),
        description = description?.trim()?.takeIf { it.isNotEmpty() },
        category = category?.trim()?.takeIf { it.isNotEmpty() },
        instructorName = instructorName?.trim()?.takeIf { it.isNotEmpty() },
        deliveryMode = deliveryMode,
        location = location?.trim()?.takeIf { it.isNotEmpty() },
        startDate = startDate,
        endDate = endDate,
        durationHours = durationHours,
        capacity = capacity,
        resources = resources.map {
            TrainingResourceRequestDto(it.title.trim(), it.type, it.url.trim(), it.sortOrder)
        }
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
        return AppResult.Error(Exception(message), AppError.ServerError(response.code(), message))
    }

    private fun validationError(message: String): AppResult.Error =
        AppResult.Error(Exception(message), AppError.ValidationError(message))

    private fun cacheCourse(course: TrainingCourseParams) {
        courses.value = (courses.value.filterNot { it.id == course.id } + course)
            .sortedByDescending { it.createdAt.orEmpty() }
    }

    private fun cacheAssignment(assignment: TrainingAssignmentParams) {
        assignments.value = (assignments.value.filterNot { it.id == assignment.id } + assignment)
            .sortedByDescending { it.assignedAt.orEmpty() }
    }

    override fun observeCourses(): Flow<List<TrainingCourseParams>> = courses.asStateFlow()

    override fun observeAssignments(): Flow<List<TrainingAssignmentParams>> = assignments.asStateFlow()

    override fun observeMyAssignments(employeeId: String): Flow<List<TrainingAssignmentParams>> =
        assignments.map { rows -> rows.filter { it.employee.employeeId == employeeId } }

    override fun observeEligibleEmployees(): Flow<List<TrainingEligibleEmployee>> =
        eligibleEmployees.asStateFlow()

    override fun observeReport(): Flow<TrainingReportParams?> = report.asStateFlow()

    override suspend fun refreshCourses(filters: TrainingCourseFilters): AppResult<Unit> = try {
        val response = trainingApi.getCourses(
            filters.scope, filters.status, filters.category, filters.from, filters.to, filters.query
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            lastCourseFilters = filters
            courses.value = body.items.map { it.toParams() }
            AppResult.Success(Unit)
        } else responseError(response, "تعذر تحميل الدورات التدريبية")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun refreshAssignments(filters: TrainingAssignmentFilters): AppResult<Unit> = try {
        val response = trainingApi.getAssignments(
            filters.scope, filters.status, filters.courseId, filters.departmentId,
            filters.employeeId, filters.from, filters.to
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            lastAssignmentFilters = filters
            assignments.value = body.items.map { it.toParams() }
            AppResult.Success(Unit)
        } else responseError(response, "تعذر تحميل تكليفات التدريب")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadCourse(courseId: String, scope: String?): AppResult<TrainingCourseParams> = try {
        val response = trainingApi.getCourse(courseId, scope)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val mapped = body.toParams()
            cacheCourse(mapped)
            AppResult.Success(mapped)
        } else responseError(response, "تعذر تحميل تفاصيل الدورة")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadAssignment(assignmentId: String, scope: String?): AppResult<TrainingAssignmentParams> = try {
        val response = trainingApi.getAssignment(assignmentId, scope)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val mapped = body.toParams()
            cacheAssignment(mapped)
            AppResult.Success(mapped)
        } else responseError(response, "تعذر تحميل تفاصيل التكليف")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadEligibleEmployees(query: String?, departmentId: String?): AppResult<Unit> = try {
        val response = trainingApi.getEligibleEmployees(query, departmentId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            eligibleEmployees.value = body.map { it.toParams() }
            AppResult.Success(Unit)
        } else responseError(response, "تعذر تحميل الموظفين المتاحين للتدريب")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun createCourse(request: TrainingCourseRequestParams): AppResult<TrainingCourseParams> = try {
        val response = trainingApi.createCourse(request.toDto())
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val mapped = body.toParams()
            cacheCourse(mapped)
            refreshCourses(lastCourseFilters)
            AppResult.Success(mapped)
        } else responseError(response, "تعذر إنشاء الدورة التدريبية")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun updateCourse(
        courseId: String,
        request: TrainingCourseRequestParams
    ): AppResult<TrainingCourseParams> = try {
        val response = trainingApi.updateCourse(courseId, request.toDto())
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val mapped = body.toParams()
            cacheCourse(mapped)
            refreshCourses(lastCourseFilters)
            AppResult.Success(mapped)
        } else responseError(response, "تعذر تحديث الدورة التدريبية")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    private suspend fun courseAction(
        courseId: String,
        fallback: String,
        call: suspend () -> Response<TrainingCourseDto>
    ): AppResult<TrainingCourseParams> = try {
        val response = call()
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val mapped = body.toParams()
            cacheCourse(mapped)
            refreshCourses(lastCourseFilters)
            refreshAssignments(lastAssignmentFilters)
            AppResult.Success(mapped)
        } else responseError(response, fallback)
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun publishCourse(courseId: String) =
        courseAction(courseId, "تعذر نشر الدورة") { trainingApi.publishCourse(courseId) }

    override suspend fun completeCourse(courseId: String) =
        courseAction(courseId, "تعذر إكمال الدورة") { trainingApi.completeCourse(courseId) }

    override suspend fun cancelCourse(courseId: String, reason: String): AppResult<TrainingCourseParams> {
        if (reason.isBlank()) return validationError("سبب إلغاء الدورة مطلوب")
        return courseAction(courseId, "تعذر إلغاء الدورة") {
            trainingApi.cancelCourse(courseId, TrainingCancellationRequestDto(reason.trim()))
        }
    }

    override suspend fun archiveCourse(courseId: String) =
        courseAction(courseId, "تعذر أرشفة الدورة") { trainingApi.archiveCourse(courseId) }

    override suspend fun assignCourse(
        courseId: String,
        employeeIds: List<String>
    ): AppResult<List<TrainingAssignmentParams>> {
        val uniqueIds = employeeIds.distinct()
        if (uniqueIds.isEmpty() || uniqueIds.size != employeeIds.size) {
            return validationError("اختر موظفاً واحداً على الأقل دون تكرار")
        }
        return try {
            val response = trainingApi.assignCourse(courseId, TrainingBulkAssignmentRequestDto(uniqueIds))
            val body = response.body()
            if (response.isSuccessful && body != null) {
                val mapped = body.map { it.toParams() }
                mapped.forEach(::cacheAssignment)
                refreshAssignments(lastAssignmentFilters)
                refreshCourses(lastCourseFilters)
                AppResult.Success(mapped)
            } else responseError(response, "تعذر إسناد الدورة")
        } catch (exception: Exception) {
            AppResult.Error(exception, AppError.NetworkError)
        }
    }

    private suspend fun assignmentAction(
        fallback: String,
        call: suspend () -> Response<TrainingAssignmentDto>
    ): AppResult<TrainingAssignmentParams> = try {
        val response = call()
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val mapped = body.toParams()
            cacheAssignment(mapped)
            refreshAssignments(lastAssignmentFilters)
            refreshCourses(lastCourseFilters)
            AppResult.Success(mapped)
        } else responseError(response, fallback)
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun updateAssignmentProgress(
        assignmentId: String,
        progressPercent: Int
    ): AppResult<TrainingAssignmentParams> {
        if (progressPercent !in 1..99) return validationError("نسبة التقدم يجب أن تكون بين 1 و99")
        return assignmentAction("تعذر تحديث تقدم التدريب") {
            trainingApi.updateProgress(assignmentId, TrainingProgressRequestDto(progressPercent))
        }
    }

    override suspend fun submitAssignment(
        assignmentId: String,
        completionNote: String?
    ): AppResult<TrainingAssignmentParams> = assignmentAction("تعذر تسليم إكمال التدريب") {
        trainingApi.submitAssignment(
            assignmentId,
            TrainingSubmitRequestDto(completionNote?.trim()?.takeIf { it.isNotEmpty() })
        )
    }

    override suspend fun reviewAssignment(
        assignmentId: String,
        action: String,
        score: Int?,
        reviewNote: String?
    ): AppResult<TrainingAssignmentParams> {
        if (action !in setOf("accept", "return")) return validationError("إجراء المراجعة غير صالح")
        if (action == "return" && reviewNote.isNullOrBlank()) return validationError("ملاحظة الإعادة مطلوبة")
        if (score != null && score !in 0..100) return validationError("الدرجة يجب أن تكون بين 0 و100")
        return assignmentAction("تعذر مراجعة إكمال التدريب") {
            trainingApi.reviewAssignment(
                assignmentId,
                TrainingReviewRequestDto(
                    action,
                    score?.takeIf { action == "accept" },
                    reviewNote?.trim()?.takeIf { it.isNotEmpty() }
                )
            )
        }
    }

    override suspend fun cancelAssignment(
        assignmentId: String,
        reason: String
    ): AppResult<TrainingAssignmentParams> {
        if (reason.isBlank()) return validationError("سبب إلغاء التكليف مطلوب")
        return assignmentAction("تعذر إلغاء تكليف التدريب") {
            trainingApi.cancelAssignment(assignmentId, TrainingCancellationRequestDto(reason.trim()))
        }
    }

    override suspend fun loadReport(filters: TrainingReportFilters): AppResult<TrainingReportParams> = try {
        val response = trainingApi.getReport(
            filters.scope, filters.from, filters.to, filters.courseStatus,
            filters.assignmentStatus, filters.category, filters.departmentId
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val mapped = body.toParams()
            report.value = mapped
            AppResult.Success(mapped)
        } else responseError(response, "تعذر تحميل تقرير التدريب")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadCourseTimeline(
        courseId: String,
        scope: String?
    ): AppResult<TrainingTimelineParams> = try {
        val response = trainingApi.getCourseTimeline(courseId, scope)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(
                TrainingTimelineParams(
                    courseId = body.courseId,
                    events = body.events.map { TrainingTimelineEvent(it.at, it.type, it.summary) }
                )
            )
        } else responseError(response, "تعذر تحميل الجدول الزمني للدورة")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun exportReport(
        format: TrainingExportFormat,
        filters: TrainingReportFilters,
        locale: String
    ): AppResult<ReportExportPayload> = try {
        val response = trainingApi.exportReport(
            TrainingExportRequestDto(
                format = format.apiValue,
                locale = locale,
                scope = filters.scope,
                from = filters.from,
                to = filters.to,
                courseStatus = filters.courseStatus,
                assignmentStatus = filters.assignmentStatus,
                category = filters.category,
                departmentId = filters.departmentId
            )
        )
        val body = response.body()
        if (!response.isSuccessful || body == null) {
            responseError(response, "تعذر تصدير تقرير التدريب")
        } else if (body.contentLength() in 1..Long.MAX_VALUE && body.contentLength() > MAX_TRAINING_EXPORT_BYTES) {
            AppResult.Error(
                Exception("حجم ملف التصدير يتجاوز الحد المسموح"),
                AppError.ValidationError("حجم ملف التصدير يتجاوز الحد المسموح")
            )
        } else {
            val bytes = body.readLimitedBytes(MAX_TRAINING_EXPORT_BYTES)
            val filename = trainingExportFilename(format, response.headers()["Content-Disposition"])
            AppResult.Success(ReportExportPayload(bytes, filename, format.mimeType))
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    private fun ResponseBody.readLimitedBytes(maxBytes: Int): ByteArray {
        val output = ByteArrayOutputStream()
        byteStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var total = 0
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                require(total <= maxBytes) { "حجم ملف التصدير يتجاوز الحد المسموح" }
                output.write(buffer, 0, read)
            }
        }
        return output.toByteArray()
    }

    private fun trainingExportFilename(format: TrainingExportFormat, disposition: String?): String {
        val pattern = Regex("filename\\*?=\\s*(?:UTF-8''|\")?([^\";]+)", RegexOption.IGNORE_CASE)
        val raw = disposition?.let { pattern.find(it)?.groupValues?.getOrNull(1) }?.trim()
        val safe = raw?.takeIf { Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$").matches(it) }
        return safe ?: "training_export.${format.fileExtension}"
    }

    override suspend fun refreshTraining(): AppResult<Unit> {
        val courseResult = refreshCourses(lastCourseFilters)
        if (courseResult is AppResult.Error) return courseResult
        return refreshAssignments(lastAssignmentFilters)
    }

    // ---- Commercial P4 completion artifacts ----

    private fun TrainingCertificateDto.toParams() = TrainingCertificateParams(
        id = id,
        assignmentId = assignmentId,
        courseId = courseId,
        employeeId = employeeId,
        serialNumber = serialNumber,
        courseTitle = courseTitle,
        employeeName = employeeName,
        employeeNum = employeeNum,
        completedAt = completedAt,
        issuedById = issuedBy?.id,
        issuedByName = issuedBy?.name,
        issuedAt = issuedAt
    )

    private fun TrainingEvaluationDto.toParams() = TrainingEvaluationParams(
        id = id,
        assignmentId = assignmentId,
        courseId = courseId,
        employeeId = employeeId,
        effectivenessScore = effectivenessScore,
        knowledgeScore = knowledgeScore,
        applicationScore = applicationScore,
        recommendation = recommendation,
        comment = comment,
        evaluatedById = evaluatedBy?.id,
        evaluatedByName = evaluatedBy?.name,
        evaluatedAt = evaluatedAt
    )

    /**
     * Safe to retry: the backend replays the existing certificate for an exact
     * repeat rather than issuing a second one, so a network retry here can never
     * produce two certificates for one assignment.
     */
    override suspend fun issueCertificate(assignmentId: String): AppResult<TrainingCertificateParams> = try {
        val response = trainingApi.issueCertificate(assignmentId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(body.toParams())
        } else responseError(response, "تعذر إصدار شهادة التدريب")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadCertificate(assignmentId: String): AppResult<TrainingCertificateParams> = try {
        val response = trainingApi.getCertificate(assignmentId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(body.toParams())
        } else responseError(response, "تعذر تحميل شهادة التدريب")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    /** Not retry-safe by design: a repeat is a 409, surfaced rather than swallowed. */
    override suspend fun createEvaluation(
        assignmentId: String,
        request: TrainingEvaluationRequestParams
    ): AppResult<TrainingEvaluationParams> = try {
        val response = trainingApi.createEvaluation(
            assignmentId,
            CreateTrainingEvaluationRequestDto(
                effectivenessScore = request.effectivenessScore,
                knowledgeScore = request.knowledgeScore,
                applicationScore = request.applicationScore,
                recommendation = request.recommendation,
                comment = request.comment?.trim()?.takeIf { it.isNotEmpty() }
            )
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(body.toParams())
        } else responseError(response, "تعذر تسجيل تقييم التدريب")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadEvaluation(assignmentId: String): AppResult<TrainingEvaluationParams> = try {
        val response = trainingApi.getEvaluation(assignmentId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(body.toParams())
        } else responseError(response, "تعذر تحميل تقييم التدريب")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override fun clear() {
        courses.value = emptyList()
        assignments.value = emptyList()
        eligibleEmployees.value = emptyList()
        report.value = null
        lastCourseFilters = TrainingCourseFilters()
        lastAssignmentFilters = TrainingAssignmentFilters()
    }
}
