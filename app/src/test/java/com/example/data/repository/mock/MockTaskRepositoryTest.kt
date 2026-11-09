package com.example.data.repository.mock

import com.example.core.utils.AppResult
import com.example.domain.model.CreateTaskRequestParams
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MockTaskRepositoryTest {

    private fun request(employeeIds: List<String> = listOf("e1")) = CreateTaskRequestParams(
        title = "مهمة اختبار",
        description = "وصف",
        priority = "high",
        dueDate = "2026-07-20",
        employeeIds = employeeIds
    )

    @Test
    fun `create maps multiple assignees and publishes the task`() = runTest {
        val repo = MockTaskRepository()
        val result = repo.createTask(request(listOf("e1", "e2")))
        assertTrue(result is AppResult.Success)
        val task = (result as AppResult.Success).data
        assertEquals("active", task.status)
        assertEquals(2, task.assignments.size)
        assertEquals(task.id, repo.observeTasks().first().single().id)
    }

    @Test
    fun `employee progress requires details and follows valid transitions`() = runTest {
        val repo = MockTaskRepository()
        val task = (repo.createTask(request()) as AppResult.Success).data
        val assignment = task.assignments.single()

        assertTrue(repo.updateProgress(assignment.id, "submitted", null) is AppResult.Error)
        assertTrue(repo.updateProgress(assignment.id, "in_progress") is AppResult.Success)
        val submitted = repo.updateProgress(assignment.id, "submitted", "اكتمل العمل")
        assertTrue(submitted is AppResult.Success)
        assertEquals("submitted", (submitted as AppResult.Success).data.status)
    }

    @Test
    fun `return requires a note and accepted assignments become immutable`() = runTest {
        val repo = MockTaskRepository()
        val task = (repo.createTask(request()) as AppResult.Success).data
        val assignmentId = task.assignments.single().id
        repo.updateProgress(assignmentId, "submitted", "تم")

        assertTrue(repo.reviewAssignment(assignmentId, "return", null) is AppResult.Error)
        val accepted = repo.reviewAssignment(assignmentId, "accept")
        assertTrue(accepted is AppResult.Success)
        assertEquals("completed", (accepted as AppResult.Success).data.taskStatus)
        assertTrue(repo.updateProgress(assignmentId, "in_progress") is AppResult.Error)
    }

    @Test
    fun `cancel retains assignment history and never deletes the task`() = runTest {
        val repo = MockTaskRepository()
        val task = (repo.createTask(request()) as AppResult.Success).data
        val cancelled = repo.cancelTask(task.id)
        assertTrue(cancelled is AppResult.Success)
        assertEquals("cancelled", (cancelled as AppResult.Success).data.status)
        assertEquals(1, cancelled.data.assignments.size)
        assertEquals(1, repo.observeTasks().first().size)
    }
}
