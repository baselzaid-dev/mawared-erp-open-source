package com.example.ui.ux

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AttendanceUxMigrationTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    @Test
    fun `attendance manual dialog uses shared scrollable form fields`() {
        val attendanceViews = File(appRoot, "src/main/java/com/example/ui/AttendanceViews.kt").readText()
        assertTrue(attendanceViews.contains("MawaredScrollableForm"))
        assertTrue(attendanceViews.contains("MawaredTextField"))
        assertTrue(attendanceViews.contains("MawaredDateField"))
        assertTrue(attendanceViews.contains("AttendanceManualDialog"))
        assertTrue(attendanceViews.contains("MawaredLoadingState"))
        assertTrue(attendanceViews.contains("MawaredEmptyState"))
        assertTrue(attendanceViews.contains("MawaredErrorState"))
        val manualDialog = attendanceViews.substringAfter("fun AttendanceManualDialog")
            .substringBefore("fun AttendanceTimeField")
        assertTrue(manualDialog.contains("MawaredScrollableForm"))
        assertTrue(manualDialog.contains("MawaredDateField"))
        assertTrue(!manualDialog.contains("OutlinedTextField(\n                    value = workDate"))
    }
}
