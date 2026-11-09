package com.example.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MawaredTypedNavigationExecutionTest {
    private val appRoot = generateSequence(
        File(System.getProperty("user.dir") ?: ".")
    ) { it.parentFile }.first { File(it, "src/main/AndroidManifest.xml").exists() }

    @Test
    fun `every Sprint 12L destination loads and consumes its exact target`() {
        val viewModel = File(
            appRoot,
            "src/main/java/com/example/ui/MawaredViewModel.kt"
        ).readText()
        listOf(
            "destination.employeeId?.let(::loadFocusedEmployee)",
            "loadFocusedTask(destination.taskId)",
            "destination.conversationId?.let(::loadFocusedChatConversation)",
            "destination.requestId?.let(::loadFocusedPurchaseRequest)",
            "destination.vendorId?.let(::loadFocusedVendor)",
            "destination.courseId?.let(::loadFocusedTrainingCourse)"
        ).forEach { marker ->
            assertTrue("missing typed target executor: $marker", viewModel.contains(marker))
        }

        val consumers = listOf(
            "EmployeeViews.kt" to "focusedEmployeeId",
            "LeaveViews.kt" to "focusedLeaveId",
            "TaskWorkflowViews.kt" to "focusedTaskId",
            "PurchaseViews.kt" to "focusedPurchaseRequestId",
            "SupplierViews.kt" to "focusedVendor",
            "TrainingViews.kt" to "focusedTrainingCourseId"
        )
        consumers.forEach { (file, marker) ->
            val source = File(appRoot, "src/main/java/com/example/ui/$file").readText()
            assertTrue("$file does not consume $marker", source.contains(marker))
        }
    }
}
