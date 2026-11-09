package com.example.data.repository.mock

import com.example.core.utils.AppResult
import com.example.domain.model.TrainingCourseRequestParams
import com.example.domain.model.TrainingResourceRequestParams
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MockTrainingRepositoryTest {

    private fun courseRequest() = TrainingCourseRequestParams(
        title = "دورة اختبار",
        description = "وصف آمن",
        category = "اختبار",
        instructorName = "مدرب",
        deliveryMode = "online",
        location = null,
        startDate = "2026-07-15",
        endDate = "2026-07-16",
        durationHours = 4,
        capacity = 2,
        resources = listOf(TrainingResourceRequestParams("دليل", "link", "https://example.com/guide"))
    )

    @Test
    fun `course follows draft publish complete archive lifecycle without hard delete`() = runTest {
        val repo = MockTrainingRepository()
        val created = (repo.createCourse(courseRequest()) as AppResult.Success).data
        assertEquals("draft", created.status)
        assertTrue(created.courseCode.startsWith("TR-"))

        val published = (repo.publishCourse(created.id) as AppResult.Success).data
        assertEquals("published", published.status)
        assertTrue(repo.publishCourse(created.id) is AppResult.Error)

        repo.loadEligibleEmployees()
        val employeeId = repo.observeEligibleEmployees().first().first().employeeId
        val assignment = (repo.assignCourse(created.id, listOf(employeeId)) as AppResult.Success).data.single()
        repo.submitAssignment(assignment.id)
        repo.reviewAssignment(assignment.id, "accept", 90, null)
        val completed = (repo.completeCourse(created.id) as AppResult.Success).data
        assertEquals("completed", completed.status)
        assertEquals("archived", (repo.archiveCourse(created.id) as AppResult.Success).data.status)
        assertTrue(repo.observeCourses().first().any { it.id == created.id })
    }

    @Test
    fun `progress is honest 1 to 99 and submission requires review before completion`() = runTest {
        val repo = MockTrainingRepository()
        repo.loadEligibleEmployees()
        val employeeId = repo.observeEligibleEmployees().first().first().employeeId
        val course = (repo.createCourse(courseRequest()) as AppResult.Success).data
        repo.publishCourse(course.id)
        val assignment = (repo.assignCourse(course.id, listOf(employeeId)) as AppResult.Success).data.single()

        assertTrue(repo.updateAssignmentProgress(assignment.id, 100) is AppResult.Error)
        val progress = (repo.updateAssignmentProgress(assignment.id, 55) as AppResult.Success).data
        assertEquals("in_progress", progress.status)
        assertEquals(55, progress.progressPercent)

        val submitted = (repo.submitAssignment(assignment.id, "تم الإكمال") as AppResult.Success).data
        assertEquals("submitted", submitted.status)
        assertEquals(100, submitted.progressPercent)
        assertTrue(repo.updateAssignmentProgress(assignment.id, 60) is AppResult.Error)

        val returned = (repo.reviewAssignment(assignment.id, "return", null, "أعد القسم الأخير") as AppResult.Success).data
        assertEquals("returned", returned.status)
        assertTrue(repo.updateAssignmentProgress(assignment.id, 70) is AppResult.Success)
    }

    @Test
    fun `bulk assignment enforces duplicate and capacity rules atomically`() = runTest {
        val repo = MockTrainingRepository()
        repo.loadEligibleEmployees()
        val employees = repo.observeEligibleEmployees().first().map { it.employeeId }
        val course = (repo.createCourse(courseRequest().copy(capacity = 1)) as AppResult.Success).data
        repo.publishCourse(course.id)

        assertTrue(repo.assignCourse(course.id, listOf(employees.first(), employees.first())) is AppResult.Error)
        assertTrue(repo.assignCourse(course.id, employees.take(2)) is AppResult.Error)
        assertFalse(repo.observeAssignments().first().any { it.courseId == course.id })
        assertTrue(repo.assignCourse(course.id, listOf(employees.first())) is AppResult.Success)
    }

    @Test
    fun `cancellation retains assignment history and report uses repository values`() = runTest {
        val repo = MockTrainingRepository()
        repo.loadEligibleEmployees()
        val employeeId = repo.observeEligibleEmployees().first().first().employeeId
        val course = (repo.createCourse(courseRequest()) as AppResult.Success).data
        repo.publishCourse(course.id)
        val assignment = (repo.assignCourse(course.id, listOf(employeeId)) as AppResult.Success).data.single()

        val cancelled = (repo.cancelAssignment(assignment.id, "تغيرت الخطة") as AppResult.Success).data
        assertEquals("cancelled", cancelled.status)
        assertTrue(repo.observeAssignments().first().any { it.id == assignment.id })

        val report = (repo.loadReport() as AppResult.Success).data
        assertEquals(repo.observeAssignments().first().size, report.summary.assignmentCount)
        assertTrue(report.summary.averageScore == null)
    }

    @Test
    fun `clear removes cached company state on logout`() = runTest {
        val repo = MockTrainingRepository()
        repo.clear()
        assertTrue(repo.observeCourses().first().isEmpty())
        assertTrue(repo.observeAssignments().first().isEmpty())
        assertTrue(repo.observeReport().first() == null)
    }

    @Test
    fun `loadCourseTimeline returns seeded course events`() = runTest {
        val repo = MockTrainingRepository()
        val timeline = (repo.loadCourseTimeline("course-1") as AppResult.Success).data
        assertEquals("course-1", timeline.courseId)
        assertTrue(timeline.events.any { it.type == "course.created" })
        assertTrue(timeline.events.any { it.type == "assignment.assigned" })
        assertTrue(repo.loadCourseTimeline("missing") is AppResult.Error)
    }

    @Test
    fun `exportReport returns deterministic mock payload`() = runTest {
        val repo = MockTrainingRepository()
        val exported = (repo.exportReport(
            com.example.domain.model.TrainingExportFormat.XLSX,
            locale = "ar"
        ) as AppResult.Success).data
        assertEquals("training_export.xlsx", exported.filename)
        assertEquals(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            exported.mimeType
        )
        assertTrue(exported.bytes.isNotEmpty())
    }
}
