package com.example.ui.ux

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ReportUxMigrationTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    @Test
    fun `unified reports center uses shared loading empty and error states`() {
        val unifiedReportViews = File(appRoot, "src/main/java/com/example/ui/UnifiedReportViews.kt").readText()
        assertTrue(unifiedReportViews.contains("MawaredLoadingState"))
        assertTrue(unifiedReportViews.contains("MawaredEmptyState"))
        assertTrue(unifiedReportViews.contains("MawaredErrorState"))
        assertTrue(unifiedReportViews.contains("viewModel.refreshReportPreview"))
        assertTrue(unifiedReportViews.contains("viewModel.refreshReports"))
    }
}
