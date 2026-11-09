package com.example.ui

import com.example.R
import com.example.core.permissions.Permissions
import com.example.domain.model.TrainingAssignmentParams
import com.example.domain.model.TrainingEmployeeSnapshot
import com.example.domain.model.TrainingExportFormat
import com.example.domain.model.TrainingTimelineEvent
import com.example.domain.model.TrainingTimelineParams
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TrainingUiRulesTest {

    private fun assignment(status: String, employeeId: String = "e1") = TrainingAssignmentParams(
        id = "a1", companyId = "c1", courseId = "course-1", course = null,
        employee = TrainingEmployeeSnapshot(employeeId, "EMP-1", "موظف", "d1", "القسم"),
        status = status, progressPercent = if (status == "submitted") 100 else 50,
        assignedAt = null, startedAt = null, submittedAt = null, completedAt = null,
        reviewedAt = null, reviewNote = null, score = null, cancellation = null,
        createdAt = null, updatedAt = null
    )

    @Test
    fun `role permissions produce the approved Training modes`() {
        assertEquals(
            listOf("own"),
            trainingModesForPermissions(setOf(Permissions.TRAINING_VIEW_OWN), "e1")
        )
        assertEquals(
            listOf("own", "department", "report"),
            trainingModesForPermissions(
                setOf(Permissions.TRAINING_VIEW_OWN, Permissions.TRAINING_VIEW_DEPARTMENT, Permissions.TRAINING_REPORT),
                "manager-employee"
            )
        )
        assertEquals(
            listOf("courses", "assignments", "reviews", "report"),
            trainingModesForPermissions(
                setOf(
                    Permissions.TRAINING_VIEW_COMPANY,
                    Permissions.TRAINING_MANAGE,
                    Permissions.TRAINING_ASSIGN,
                    Permissions.TRAINING_REVIEW,
                    Permissions.TRAINING_REPORT
                ),
                null
            )
        )
        assertEquals(
            listOf("courses", "assignments", "reviews", "report"),
            trainingModesForPermissions(setOf(Permissions.ADMIN_FULL), "owner-employee")
        )
        assertTrue(trainingModesForPermissions(emptySet(), "e1").isEmpty())
    }

    @Test
    fun `raw statuses and delivery modes map to stable string resources`() {
        assertEquals(R.string.training_status_draft, trainingCourseStatusLabelRes("draft"))
        assertEquals(R.string.training_status_published, trainingCourseStatusLabelRes("published"))
        assertEquals(R.string.training_assignment_submitted, trainingAssignmentStatusLabelRes("submitted"))
        assertEquals(R.string.training_assignment_returned, trainingAssignmentStatusLabelRes("returned"))
        assertEquals(R.string.training_delivery_online, trainingDeliveryLabelRes("online"))
        assertEquals(R.string.training_delivery_self_paced, trainingDeliveryLabelRes("self_paced"))
    }

    @Test
    fun `progress and review actions obey terminal and self-review rules`() {
        assertTrue(canUpdateTrainingProgress("assigned"))
        assertTrue(canUpdateTrainingProgress("returned"))
        assertFalse(canUpdateTrainingProgress("submitted"))
        assertFalse(canUpdateTrainingProgress("completed"))
        assertFalse(canUpdateTrainingProgress("cancelled"))

        val submitted = assignment("submitted")
        assertTrue(canReviewTrainingAssignment(submitted, "reviewer-employee", true))
        assertFalse(canReviewTrainingAssignment(submitted, "e1", true))
        assertFalse(canReviewTrainingAssignment(submitted, "reviewer-employee", false))
        assertFalse(canReviewTrainingAssignment(assignment("completed"), "reviewer-employee", true))
    }

    @Test
    fun `dashboard summary uses scoped backend values`() {
        val ownState = TrainingUiState(
            assignments = listOf(assignment("assigned"), assignment("completed")),
            canView = true,
            canViewOwn = true
        )
        assertEquals("دوراتي المسندة أو قيد التدريب: 1", trainingDashboardSummary(ownState))

        val reviewState = TrainingUiState(
            assignments = listOf(assignment("submitted"), assignment("completed")),
            canView = true,
            canReview = true
        )
        assertEquals("طلبات إكمال بانتظار المراجعة: 1", trainingDashboardSummary(reviewState))
    }

    @Test
    fun `export actions gate on training report permission only`() {
        assertFalse(canShowTrainingExportActions(canReport = false))
        assertTrue(canShowTrainingExportActions(canReport = true))
        assertEquals(
            listOf(TrainingExportFormat.CSV, TrainingExportFormat.XLSX, TrainingExportFormat.PDF),
            trainingExportFormats()
        )
    }

    @Test
    fun `timeline event labels and timestamps stay Arabic-friendly`() {
        assertEquals("إنشاء الدورة", trainingTimelineEventLabel("course.created"))
        assertEquals("مراجعة التكليف", trainingTimelineEventLabel("assignment.reviewed"))
        assertEquals("2026-07-01 08:00", formatTrainingTimelineAt("2026-07-01T08:00:00Z"))
        assertTrue(trainingTimelineEmpty(null))
        assertTrue(
            trainingTimelineEmpty(
                TrainingTimelineParams(courseId = "c1", events = emptyList())
            )
        )
        val sorted = trainingTimelineSortedEvents(
            TrainingTimelineParams(
                courseId = "c1",
                events = listOf(
                    TrainingTimelineEvent("2026-07-02T09:00:00Z", "course.published", "Course published"),
                    TrainingTimelineEvent("2026-07-01T08:00:00Z", "course.created", "Course created")
                )
            )
        )
        assertEquals("course.created", sorted.first().type)
        assertEquals("course.published", sorted.last().type)
    }
}
