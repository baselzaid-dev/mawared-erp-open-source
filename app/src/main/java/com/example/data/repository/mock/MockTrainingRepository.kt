package com.example.data.repository.mock

import com.example.core.utils.AppResult
import com.example.domain.model.*
import com.example.domain.repository.TrainingRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map
import java.util.UUID

/** Deterministic demo data that follows the same soft lifecycle as the API. */
class MockTrainingRepository : TrainingRepository {

    private val resources = listOf(
        TrainingResourceParams("resource-1", "دليل الدورة", "document", "https://example.com/training-guide", 0)
    )
    private val courseRows = mutableListOf(
        TrainingCourseParams(
            id = "course-1", companyId = "demo-company", courseCode = "TR-202607-DEMO0001",
            title = "السلامة المهنية في بيئة العمل", description = "إرشادات السلامة والإخلاء.",
            category = "السلامة", instructorName = "مركز السلامة", deliveryMode = "online",
            location = null, startDate = "2026-07-15", endDate = "2026-07-16",
            durationHours = 6, capacity = 20, status = "published", resources = resources,
            assignmentSummary = TrainingAssignmentSummary(total = 1, inProgress = 1),
            ownAssignment = null, createdAt = "2026-07-01T08:00:00Z", publishedAt = "2026-07-02T08:00:00Z",
            completedAt = null, cancelledAt = null, archivedAt = null, updatedAt = "2026-07-02T08:00:00Z"
        ),
        TrainingCourseParams(
            id = "course-2", companyId = "demo-company", courseCode = "TR-202607-DEMO0002",
            title = "إدارة ملفات الموظفين", description = "تدريب عملي على إجراءات الموارد البشرية.",
            category = "الموارد البشرية", instructorName = "مدرب داخلي", deliveryMode = "onsite",
            location = "قاعة التدريب", startDate = "2026-07-20", endDate = "2026-07-20",
            durationHours = 4, capacity = 12, status = "draft", resources = emptyList(),
            assignmentSummary = TrainingAssignmentSummary(), ownAssignment = null,
            createdAt = "2026-07-03T08:00:00Z", publishedAt = null, completedAt = null,
            cancelledAt = null, archivedAt = null, updatedAt = null
        )
    )
    private val assignmentRows = mutableListOf(
        TrainingAssignmentParams(
            id = "assignment-1", companyId = "demo-company", courseId = "course-1",
            course = summary(courseRows[0]),
            employee = TrainingEmployeeSnapshot("4", "EMP-004", "موظف تجريبي 6", "dept-tech", "التقنية"),
            status = "in_progress", progressPercent = 55, assignedAt = "2026-07-02T09:00:00Z",
            startedAt = "2026-07-03T09:00:00Z", submittedAt = null, completedAt = null,
            reviewedAt = null, reviewNote = null, score = null, cancellation = null,
            createdAt = "2026-07-02T09:00:00Z", updatedAt = "2026-07-03T09:00:00Z"
        )
    )
    private val employeeRows = listOf(
        TrainingEligibleEmployee("1", "EMP-001", "موظف تجريبي 3", "dept-hr", "الموارد البشرية", "HR Manager"),
        TrainingEligibleEmployee("4", "EMP-004", "موظف تجريبي 6", "dept-tech", "التقنية", "Employee")
    )

    private val courses = MutableStateFlow(courseRows.toList())
    private val assignments = MutableStateFlow(assignmentRows.toList())
    private val eligibleEmployees = MutableStateFlow<List<TrainingEligibleEmployee>>(emptyList())
    private val report = MutableStateFlow<TrainingReportParams?>(null)

    override fun observeCourses(): Flow<List<TrainingCourseParams>> = courses
    override fun observeAssignments(): Flow<List<TrainingAssignmentParams>> = assignments
    override fun observeMyAssignments(employeeId: String): Flow<List<TrainingAssignmentParams>> =
        assignments.map { rows -> rows.filter { it.employee.employeeId == employeeId } }
    override fun observeEligibleEmployees(): Flow<List<TrainingEligibleEmployee>> = eligibleEmployees
    override fun observeReport(): Flow<TrainingReportParams?> = report

    override suspend fun refreshCourses(filters: TrainingCourseFilters): AppResult<Unit> {
        courses.value = courseRows.filter { row ->
            (filters.status == null || row.status == filters.status) &&
                (filters.category == null || row.category == filters.category) &&
                (filters.query.isNullOrBlank() || "${row.courseCode} ${row.title}".contains(filters.query, true))
        }
        return AppResult.Success(Unit)
    }

    override suspend fun refreshAssignments(filters: TrainingAssignmentFilters): AppResult<Unit> {
        assignments.value = assignmentRows.filter { row ->
            (filters.status == null || row.status == filters.status) &&
                (filters.courseId == null || row.courseId == filters.courseId) &&
                (filters.departmentId == null || row.employee.departmentId == filters.departmentId) &&
                (filters.employeeId == null || row.employee.employeeId == filters.employeeId)
        }
        return AppResult.Success(Unit)
    }

    override suspend fun loadCourse(courseId: String, scope: String?): AppResult<TrainingCourseParams> =
        courseRows.firstOrNull { it.id == courseId }?.let { AppResult.Success(it) }
            ?: error("الدورة التدريبية غير موجودة")

    override suspend fun loadAssignment(assignmentId: String, scope: String?): AppResult<TrainingAssignmentParams> =
        assignmentRows.firstOrNull { it.id == assignmentId }?.let { AppResult.Success(it) }
            ?: error("تكليف التدريب غير موجود")

    override suspend fun loadEligibleEmployees(query: String?, departmentId: String?): AppResult<Unit> {
        eligibleEmployees.value = employeeRows.filter {
            (departmentId == null || it.departmentId == departmentId) &&
                (query.isNullOrBlank() || "${it.displayName} ${it.employeeNum}".contains(query, true))
        }
        return AppResult.Success(Unit)
    }

    override suspend fun createCourse(request: TrainingCourseRequestParams): AppResult<TrainingCourseParams> {
        if (request.title.isBlank()) return error("عنوان الدورة مطلوب")
        val row = TrainingCourseParams(
            id = UUID.randomUUID().toString(), companyId = "demo-company",
            courseCode = "TR-202607-${UUID.randomUUID().toString().take(8).uppercase()}",
            title = request.title.trim(), description = request.description, category = request.category,
            instructorName = request.instructorName, deliveryMode = request.deliveryMode, location = request.location,
            startDate = request.startDate, endDate = request.endDate, durationHours = request.durationHours,
            capacity = request.capacity, status = "draft",
            resources = request.resources.mapIndexed { index, item ->
                TrainingResourceParams(UUID.randomUUID().toString(), item.title, item.type, item.url, item.sortOrder ?: index)
            },
            assignmentSummary = TrainingAssignmentSummary(), ownAssignment = null,
            createdAt = "2026-07-11T08:00:00Z", publishedAt = null, completedAt = null,
            cancelledAt = null, archivedAt = null, updatedAt = null
        )
        courseRows.add(0, row)
        courses.value = courseRows.toList()
        return AppResult.Success(row)
    }

    override suspend fun updateCourse(
        courseId: String,
        request: TrainingCourseRequestParams
    ): AppResult<TrainingCourseParams> {
        val index = courseRows.indexOfFirst { it.id == courseId }
        if (index == -1) return error("الدورة التدريبية غير موجودة")
        if (courseRows[index].status != "draft") return error("لا يمكن تعديل الدورة بعد نشرها")
        val current = courseRows[index]
        val updated = current.copy(
            title = request.title.trim(), description = request.description, category = request.category,
            instructorName = request.instructorName, deliveryMode = request.deliveryMode, location = request.location,
            startDate = request.startDate, endDate = request.endDate, durationHours = request.durationHours,
            capacity = request.capacity,
            resources = request.resources.mapIndexed { position, item ->
                TrainingResourceParams(UUID.randomUUID().toString(), item.title, item.type, item.url, item.sortOrder ?: position)
            },
            updatedAt = "2026-07-11T09:00:00Z"
        )
        courseRows[index] = updated
        courses.value = courseRows.toList()
        return AppResult.Success(updated)
    }

    override suspend fun publishCourse(courseId: String): AppResult<TrainingCourseParams> =
        updateCourseStatus(courseId, setOf("draft"), "published")

    override suspend fun assignCourse(
        courseId: String,
        employeeIds: List<String>
    ): AppResult<List<TrainingAssignmentParams>> {
        val course = courseRows.firstOrNull { it.id == courseId }
            ?: return error("الدورة التدريبية غير موجودة")
        if (course.status != "published") return error("يجب نشر الدورة قبل إسنادها")
        if (employeeIds.isEmpty() || employeeIds.distinct().size != employeeIds.size) {
            return error("اختر موظفين دون تكرار")
        }
        if (assignmentRows.any { it.courseId == courseId && it.employee.employeeId in employeeIds }) {
            return error("يوجد تكليف سابق لأحد الموظفين")
        }
        val selected = employeeRows.filter { it.employeeId in employeeIds }
        if (selected.size != employeeIds.size) return error("أحد الموظفين غير متاح")
        val activeCount = assignmentRows.count { it.courseId == courseId && it.status != "cancelled" }
        if (course.capacity != null && activeCount + selected.size > course.capacity) return error("تم تجاوز سعة الدورة")
        val created = selected.map { employee ->
            TrainingAssignmentParams(
                id = UUID.randomUUID().toString(), companyId = "demo-company", courseId = courseId,
                course = summary(course),
                employee = TrainingEmployeeSnapshot(
                    employee.employeeId, employee.employeeNum, employee.displayName,
                    employee.departmentId, employee.departmentName
                ),
                status = "assigned", progressPercent = 0, assignedAt = "2026-07-11T10:00:00Z",
                startedAt = null, submittedAt = null, completedAt = null, reviewedAt = null,
                reviewNote = null, score = null, cancellation = null,
                createdAt = "2026-07-11T10:00:00Z", updatedAt = null
            )
        }
        assignmentRows.addAll(0, created)
        assignments.value = assignmentRows.toList()
        refreshCourseSummary(courseId)
        return AppResult.Success(created)
    }

    override suspend fun updateAssignmentProgress(
        assignmentId: String,
        progressPercent: Int
    ): AppResult<TrainingAssignmentParams> {
        if (progressPercent !in 1..99) return error("نسبة التقدم يجب أن تكون بين 1 و99")
        return updateAssignment(assignmentId, setOf("assigned", "in_progress", "returned")) {
            it.copy(status = "in_progress", progressPercent = progressPercent,
                startedAt = it.startedAt ?: "2026-07-11T11:00:00Z", updatedAt = "2026-07-11T11:00:00Z")
        }
    }

    override suspend fun submitAssignment(
        assignmentId: String,
        completionNote: String?
    ): AppResult<TrainingAssignmentParams> =
        updateAssignment(assignmentId, setOf("assigned", "in_progress", "returned")) {
            it.copy(status = "submitted", progressPercent = 100,
                submittedAt = "2026-07-11T12:00:00Z", updatedAt = "2026-07-11T12:00:00Z")
        }

    override suspend fun reviewAssignment(
        assignmentId: String,
        action: String,
        score: Int?,
        reviewNote: String?
    ): AppResult<TrainingAssignmentParams> {
        if (action == "return" && reviewNote.isNullOrBlank()) return error("ملاحظة الإعادة مطلوبة")
        return updateAssignment(assignmentId, setOf("submitted")) {
            it.copy(
                status = if (action == "accept") "completed" else "returned",
                completedAt = if (action == "accept") "2026-07-11T13:00:00Z" else null,
                reviewedAt = "2026-07-11T13:00:00Z", reviewNote = reviewNote,
                score = score?.takeIf { action == "accept" }, updatedAt = "2026-07-11T13:00:00Z"
            )
        }
    }

    override suspend fun cancelAssignment(
        assignmentId: String,
        reason: String
    ): AppResult<TrainingAssignmentParams> {
        if (reason.isBlank()) return error("سبب الإلغاء مطلوب")
        return updateAssignment(assignmentId, setOf("assigned", "in_progress", "submitted", "returned")) {
            it.copy(status = "cancelled", cancellation = TrainingCancellationParams("2026-07-11T14:00:00Z", reason),
                updatedAt = "2026-07-11T14:00:00Z")
        }
    }

    override suspend fun completeCourse(courseId: String): AppResult<TrainingCourseParams> {
        val related = assignmentRows.filter { it.courseId == courseId }
        if (related.isEmpty() || related.any { it.status !in setOf("completed", "cancelled") }) {
            return error("توجد تكليفات غير مكتملة")
        }
        return updateCourseStatus(courseId, setOf("published"), "completed")
    }

    override suspend fun cancelCourse(courseId: String, reason: String): AppResult<TrainingCourseParams> {
        if (reason.isBlank()) return error("سبب الإلغاء مطلوب")
        assignmentRows.indices.filter { assignmentRows[it].courseId == courseId && assignmentRows[it].status in
            setOf("assigned", "in_progress", "submitted", "returned")
        }.forEach { index ->
            assignmentRows[index] = assignmentRows[index].copy(
                status = "cancelled", cancellation = TrainingCancellationParams("2026-07-11T14:00:00Z", reason)
            )
        }
        assignments.value = assignmentRows.toList()
        return updateCourseStatus(courseId, setOf("draft", "published"), "cancelled")
    }

    override suspend fun archiveCourse(courseId: String): AppResult<TrainingCourseParams> =
        updateCourseStatus(courseId, setOf("completed", "cancelled"), "archived")

    override suspend fun loadReport(filters: TrainingReportFilters): AppResult<TrainingReportParams> {
        val visibleAssignments = assignmentRows.filter {
            (filters.assignmentStatus == null || it.status == filters.assignmentStatus) &&
                (filters.departmentId == null || it.employee.departmentId == filters.departmentId)
        }
        val visibleCourses = courseRows.filter {
            (filters.courseStatus == null || it.status == filters.courseStatus) &&
                (filters.category == null || it.category == filters.category)
        }
        val scores = visibleAssignments.mapNotNull { it.score }
        val nonCancelled = visibleAssignments.filter { it.status != "cancelled" }
        val summary = TrainingReportSummary(
            courseCount = visibleCourses.size,
            draftCourseCount = visibleCourses.count { it.status == "draft" },
            publishedCourseCount = visibleCourses.count { it.status == "published" },
            completedCourseCount = visibleCourses.count { it.status == "completed" },
            cancelledCourseCount = visibleCourses.count { it.status == "cancelled" },
            assignmentCount = visibleAssignments.size,
            assignedCount = visibleAssignments.count { it.status == "assigned" },
            inProgressCount = visibleAssignments.count { it.status == "in_progress" },
            submittedCount = visibleAssignments.count { it.status == "submitted" },
            completedAssignmentCount = visibleAssignments.count { it.status == "completed" },
            returnedCount = visibleAssignments.count { it.status == "returned" },
            cancelledAssignmentCount = visibleAssignments.count { it.status == "cancelled" },
            overdueCount = 0,
            completionRatePercent = if (nonCancelled.isEmpty()) 0.0 else
                visibleAssignments.count { it.status == "completed" } * 100.0 / nonCancelled.size,
            averageProgressPercent = if (visibleAssignments.isEmpty()) 0.0 else
                visibleAssignments.map { it.progressPercent }.average(),
            averageScore = scores.takeIf { it.isNotEmpty() }?.average()?.let { "%.2f".format(it) }
        )
        val result = TrainingReportParams(
            summary = summary,
            courses = visibleCourses.map { TrainingReportCourseRow(summary(it), it.assignmentSummary) },
            assignments = visibleAssignments.map {
                TrainingReportAssignmentRow(it.id, it.courseId, it.employee, it.status)
            },
            departments = visibleAssignments.groupBy { it.employee.departmentId }.map { (departmentId, rows) ->
                val completed = rows.count { it.status == "completed" }
                TrainingReportDepartmentRow(
                    departmentId, rows.first().employee.departmentName, rows.size, completed,
                    if (rows.isEmpty()) 0.0 else completed * 100.0 / rows.size
                )
            }
        )
        report.value = result
        return AppResult.Success(result)
    }

    override suspend fun loadCourseTimeline(
        courseId: String,
        scope: String?
    ): AppResult<TrainingTimelineParams> {
        val course = courseRows.firstOrNull { it.id == courseId }
            ?: return error("الدورة التدريبية غير موجودة")
        val events = buildList {
            course.createdAt?.let { add(TrainingTimelineEvent(it, "course.created", "Course created")) }
            course.publishedAt?.let { add(TrainingTimelineEvent(it, "course.published", "Course published")) }
            course.completedAt?.let { add(TrainingTimelineEvent(it, "course.completed", "Course completed")) }
            course.cancelledAt?.let { add(TrainingTimelineEvent(it, "course.cancelled", "Course cancelled")) }
            course.archivedAt?.let { add(TrainingTimelineEvent(it, "course.archived", "Course archived")) }
            assignmentRows.filter { it.courseId == courseId }.forEach { assignment ->
                assignment.assignedAt?.let {
                    add(TrainingTimelineEvent(it, "assignment.assigned", "Assignment created"))
                }
                assignment.submittedAt?.let {
                    add(TrainingTimelineEvent(it, "assignment.submitted", "Assignment submitted"))
                }
                assignment.reviewedAt?.let {
                    add(TrainingTimelineEvent(it, "assignment.reviewed", "Assignment reviewed"))
                }
            }
        }.sortedBy { it.at }
        return AppResult.Success(TrainingTimelineParams(courseId = course.id, events = events))
    }

    override suspend fun exportReport(
        format: TrainingExportFormat,
        filters: TrainingReportFilters,
        locale: String
    ): AppResult<ReportExportPayload> {
        val loaded = loadReport(filters)
        if (loaded is AppResult.Error) return loaded
        val reportData = (loaded as AppResult.Success).data
        val bytes = buildString {
            append("format=${format.apiValue};locale=$locale;courses=${reportData.courses.size}")
        }.toByteArray(Charsets.UTF_8)
        return AppResult.Success(
            ReportExportPayload(
                bytes = bytes,
                filename = "training_export.${format.fileExtension}",
                mimeType = format.mimeType
            )
        )
    }

    override suspend fun refreshTraining(): AppResult<Unit> {
        courses.value = courseRows.toList()
        assignments.value = assignmentRows.toList()
        return AppResult.Success(Unit)
    }

    override fun clear() {
        courses.value = emptyList()
        assignments.value = emptyList()
        eligibleEmployees.value = emptyList()
        report.value = null
    }

    private fun updateCourseStatus(
        courseId: String,
        allowed: Set<String>,
        status: String
    ): AppResult<TrainingCourseParams> {
        val index = courseRows.indexOfFirst { it.id == courseId }
        if (index == -1) return error("الدورة التدريبية غير موجودة")
        if (courseRows[index].status !in allowed) return error("لا يمكن تنفيذ الإجراء من حالة الدورة الحالية")
        val current = courseRows[index]
        val updated = current.copy(
            status = status,
            publishedAt = if (status == "published") "2026-07-11T09:00:00Z" else current.publishedAt,
            completedAt = if (status == "completed") "2026-07-11T14:00:00Z" else current.completedAt,
            cancelledAt = if (status == "cancelled") "2026-07-11T14:00:00Z" else current.cancelledAt,
            archivedAt = if (status == "archived") "2026-07-11T15:00:00Z" else current.archivedAt,
            updatedAt = "2026-07-11T15:00:00Z"
        )
        courseRows[index] = updated
        courses.value = courseRows.toList()
        return AppResult.Success(updated)
    }

    private fun updateAssignment(
        assignmentId: String,
        allowed: Set<String>,
        transform: (TrainingAssignmentParams) -> TrainingAssignmentParams
    ): AppResult<TrainingAssignmentParams> {
        val index = assignmentRows.indexOfFirst { it.id == assignmentId }
        if (index == -1) return error("تكليف التدريب غير موجود")
        if (assignmentRows[index].status !in allowed) return error("لا يمكن تنفيذ الإجراء من حالة التكليف الحالية")
        val updated = transform(assignmentRows[index])
        assignmentRows[index] = updated
        assignments.value = assignmentRows.toList()
        refreshCourseSummary(updated.courseId)
        return AppResult.Success(updated)
    }

    private fun refreshCourseSummary(courseId: String) {
        val index = courseRows.indexOfFirst { it.id == courseId }
        if (index == -1) return
        val rows = assignmentRows.filter { it.courseId == courseId }
        courseRows[index] = courseRows[index].copy(
            assignmentSummary = TrainingAssignmentSummary(
                total = rows.size,
                assigned = rows.count { it.status == "assigned" },
                inProgress = rows.count { it.status == "in_progress" },
                submitted = rows.count { it.status == "submitted" },
                completed = rows.count { it.status == "completed" },
                returned = rows.count { it.status == "returned" },
                cancelled = rows.count { it.status == "cancelled" }
            )
        )
        courses.value = courseRows.toList()
    }

    // ---- Commercial P4 completion artifacts ----

    private val certificates = mutableMapOf<String, TrainingCertificateParams>()
    private val evaluations = mutableMapOf<String, TrainingEvaluationParams>()

    /** Replays an existing certificate, exactly like the API's idempotent issue. */
    override suspend fun issueCertificate(assignmentId: String): AppResult<TrainingCertificateParams> {
        certificates[assignmentId]?.let { return AppResult.Success(it) }
        val assignment = assignmentRows.firstOrNull { it.id == assignmentId }
            ?: return error("تكليف التدريب غير موجود")
        if (assignment.status != "completed") return error("يتطلب هذا الإجراء تكليفاً مكتملاً")
        val certificate = TrainingCertificateParams(
            id = "certificate-${certificates.size + 1}",
            assignmentId = assignmentId,
            courseId = assignment.courseId,
            employeeId = assignment.employee.employeeId,
            serialNumber = "CERT-202608-DEMO${certificates.size + 1}",
            courseTitle = assignment.course?.title ?: "دورة تدريبية",
            employeeName = assignment.employee.displayName,
            employeeNum = assignment.employee.employeeNum,
            completedAt = assignment.completedAt,
            issuedById = "demo-user",
            issuedByName = "مستخدم تجريبي",
            issuedAt = "2026-08-09T12:00:00.000Z"
        )
        certificates[assignmentId] = certificate
        return AppResult.Success(certificate)
    }

    override suspend fun loadCertificate(assignmentId: String): AppResult<TrainingCertificateParams> =
        certificates[assignmentId]?.let { AppResult.Success(it) } ?: error("لا توجد شهادة لهذا التكليف")

    /** A repeat is a conflict, never an overwrite — same rule as the API. */
    override suspend fun createEvaluation(
        assignmentId: String,
        request: TrainingEvaluationRequestParams
    ): AppResult<TrainingEvaluationParams> {
        if (evaluations.containsKey(assignmentId)) return error("يوجد تقييم مسجل لهذا التكليف بالفعل")
        val assignment = assignmentRows.firstOrNull { it.id == assignmentId }
            ?: return error("تكليف التدريب غير موجود")
        if (assignment.status != "completed") return error("يتطلب هذا الإجراء تكليفاً مكتملاً")
        val evaluation = TrainingEvaluationParams(
            id = "evaluation-${evaluations.size + 1}",
            assignmentId = assignmentId,
            courseId = assignment.courseId,
            employeeId = assignment.employee.employeeId,
            effectivenessScore = request.effectivenessScore,
            knowledgeScore = request.knowledgeScore,
            applicationScore = request.applicationScore,
            recommendation = request.recommendation,
            comment = request.comment,
            evaluatedById = "demo-user",
            evaluatedByName = "مستخدم تجريبي",
            evaluatedAt = "2026-08-09T12:30:00.000Z"
        )
        evaluations[assignmentId] = evaluation
        return AppResult.Success(evaluation)
    }

    override suspend fun loadEvaluation(assignmentId: String): AppResult<TrainingEvaluationParams> =
        evaluations[assignmentId]?.let { AppResult.Success(it) } ?: error("لا يوجد تقييم لهذا التكليف")

    private fun <T> error(message: String): AppResult<T> = AppResult.Error(Exception(message))

    companion object {
        private fun summary(course: TrainingCourseParams) = TrainingCourseSummaryParams(
            course.id, course.courseCode, course.title, course.category, course.instructorName,
            course.deliveryMode, course.location, course.startDate, course.endDate,
            course.durationHours, course.status
        )
    }
}
