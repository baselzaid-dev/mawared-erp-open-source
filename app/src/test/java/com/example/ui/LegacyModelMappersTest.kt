package com.example.ui

import com.example.domain.model.TaskParams
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Only Tasks still needs a legacy Room-shaped display mapper. */
class LegacyModelMappersTest {

    @Test
    fun `task mapping marks completed only for the completed status`() {
        val base = TaskParams(
            id = "TASK-9", companyId = "1", title = "مهمة", description = null,
            status = TASK_STATUS_OPEN, priority = null, assignedToId = null,
            assignedToName = null, departmentName = null, dueDate = null,
            createdById = null, createdByName = null, createdAt = null, updatedAt = null
        )
        assertFalse(base.toLegacyTask().isCompleted)
        assertTrue(base.copy(status = TASK_STATUS_COMPLETED).toLegacyTask().isCompleted)

        val mapped = base.toLegacyTask()
        assertEquals("TASK-9", mapped.id)
        assertEquals("", mapped.description)
        assertEquals("متوسطة", mapped.priority)
    }
}
