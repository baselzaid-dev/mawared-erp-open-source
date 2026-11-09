package com.example.ui.ux

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class TrainingUxMigrationTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    @Test
    fun `training form dialogs reuse shared scrollable form and field components`() {
        val trainingViews = File(appRoot, "src/main/java/com/example/ui/TrainingViews.kt").readText()
        assertTrue(trainingViews.contains("MawaredScrollableForm"))
        assertTrue(trainingViews.contains("MawaredTextField"))
        assertTrue(trainingViews.contains("MawaredDateField"))

        val courseEditor = trainingViews.substringAfter("fun TrainingCourseEditorDialog")
            .substringBefore("fun TrainingAssignmentDialog")
        assertTrue(courseEditor.contains("MawaredScrollableForm"))
        assertTrue(courseEditor.contains("MawaredTextField"))
        assertTrue(courseEditor.contains("TrainingIsoDateField"))
        assertTrue(!courseEditor.contains("OutlinedTextField"))

        val reviewDialog = trainingViews.substringAfter("fun TrainingReviewDialog")
            .substringBefore("fun TrainingTextDialog")
        assertTrue(reviewDialog.contains("MawaredScrollableForm"))
        assertTrue(reviewDialog.contains("MawaredTextField"))
        assertTrue(!reviewDialog.contains("OutlinedTextField"))

        val textDialog = trainingViews.substringAfter("fun TrainingTextDialog")
            .substringBefore("fun TrainingEmptyState")
        assertTrue(textDialog.contains("MawaredScrollableForm"))
        assertTrue(textDialog.contains("MawaredTextField"))
        assertTrue(!textDialog.contains("OutlinedTextField"))
    }
}
