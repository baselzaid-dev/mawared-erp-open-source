package com.example.ui

import com.example.core.permissions.Permissions
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskUiRulesTest {

    @Test
    fun `employee never sees Add Task while manager HR and Admin do`() {
        assertFalse(isTaskCreateVisible(setOf(Permissions.TASKS_VIEW_OWN)))
        assertTrue(isTaskCreateVisible(setOf(Permissions.TASKS_CREATE, Permissions.TASKS_ASSIGN_DEPARTMENT)))
        assertTrue(isTaskCreateVisible(setOf(Permissions.TASKS_CREATE, Permissions.TASKS_ASSIGN_COMPANY)))
        assertTrue(isTaskCreateVisible(setOf(Permissions.ADMIN_FULL)))
    }

    @Test
    fun `employee progress transitions expose only valid actions`() {
        assertTrue(canStartTaskAssignment("assigned"))
        assertTrue(canSubmitTaskAssignment("assigned"))
        assertFalse(canStartTaskAssignment("in_progress"))
        assertTrue(canSubmitTaskAssignment("in_progress"))
        assertTrue(canStartTaskAssignment("returned"))
        assertTrue(canSubmitTaskAssignment("returned"))
        assertFalse(canSubmitTaskAssignment("submitted"))
        assertFalse(canSubmitTaskAssignment("accepted"))
        assertTrue(isAcceptedTaskAssignmentImmutable("accepted"))
    }

    @Test
    fun `review appears only for submitted work and return requires a note`() {
        assertTrue(isTaskReviewVisible(setOf(Permissions.TASKS_REVIEW)))
        assertTrue(isTaskReviewVisible(setOf(Permissions.ADMIN_FULL)))
        assertFalse(isTaskReviewVisible(setOf(Permissions.TASKS_VIEW_DEPARTMENT)))
        assertTrue(canReviewTaskAssignment("submitted"))
        assertFalse(canReviewTaskAssignment("in_progress"))
        assertTrue(canShowTaskReview(canReview = true, ownAssignment = false, status = "submitted"))
        assertFalse(canShowTaskReview(canReview = true, ownAssignment = true, status = "submitted"))
        assertFalse(isReturnNoteValid("return", ""))
        assertTrue(isReturnNoteValid("return", "يلزم إرفاق الدليل"))
        assertTrue(isReturnNoteValid("accept", ""))
    }
}
