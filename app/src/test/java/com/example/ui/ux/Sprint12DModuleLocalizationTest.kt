package com.example.ui.ux

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class Sprint12DModuleLocalizationTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    private fun source(path: String): String = File(appRoot, path).readText()

    private val sprint12DKeys = listOf(
        "attendance_title",
        "attendance_empty_title",
        "training_title",
        "training_no_permission",
        "chat_title",
        "chat_no_permission_title",
        "reports_title",
        "reports_empty_data_title",
        "ux_confirm",
        "ux_all"
    )

    @Test
    fun `sprint 12D module keys exist in English and Arabic resources`() {
        val arabic = source("src/main/res/values/strings.xml")
        val english = source("src/main/res/values-en/strings.xml")
        sprint12DKeys.forEach { key ->
            assertTrue("missing English key $key", english.contains("name=\"$key\""))
            assertTrue("missing Arabic key $key", arabic.contains("name=\"$key\""))
        }
    }

    @Test
    fun `sprint 12D module views reference string resources for primary labels`() {
        val attendance = source("src/main/java/com/example/ui/AttendanceViews.kt")
        val training = source("src/main/java/com/example/ui/TrainingViews.kt")
        val chat = source("src/main/java/com/example/ui/ChatViews.kt")
        val reports = source("src/main/java/com/example/ui/UnifiedReportViews.kt")

        assertTrue(attendance.contains("stringResource(R.string.attendance_title)"))
        assertTrue(attendance.contains("stringResource(R.string.attendance_empty_title)"))
        assertTrue(training.contains("stringResource(R.string.training_title)"))
        assertTrue(training.contains("stringResource(R.string.training_no_permission)"))
        assertTrue(chat.contains("stringResource(R.string.chat_title)"))
        assertTrue(chat.contains("stringResource(R.string.chat_no_permission_title)"))
        assertTrue(reports.contains("stringResource(R.string.reports_title)"))
        assertTrue(reports.contains("stringResource(R.string.reports_empty_data_title)"))
    }
}
