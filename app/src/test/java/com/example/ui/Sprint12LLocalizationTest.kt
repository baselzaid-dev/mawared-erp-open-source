package com.example.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class Sprint12LLocalizationTest {
    private val appRoot = generateSequence(File(System.getProperty("user.dir") ?: ".")) { it.parentFile }
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    @Test
    fun `English and Arabic resources contain every Sprint 12L presentation key`() {
        val arabic = File(appRoot, "src/main/res/values/strings.xml").readText()
        val english = File(appRoot, "src/main/res/values-en/strings.xml").readText()
        listOf(
            "global_search_section_employees",
            "global_search_error_connection",
            "global_search_pagination_error",
            "timeline_title_employee",
            "timeline_error_connection",
            "timeline_event_employee_reactivated",
            "timeline_event_assignment_returned",
            "timeline_transition",
            "status_pending_purchasing",
            "status_unknown"
        ).forEach { key ->
            assertTrue("missing English $key", english.contains("""name="$key""""))
            assertTrue("missing Arabic $key", arabic.contains("""name="$key""""))
        }
    }

    @Test
    fun `Sprint 12L models and controllers contain no hardcoded Arabic presentation text`() {
        listOf(
            "src/main/java/com/example/domain/model/GlobalSearchModels.kt",
            "src/main/java/com/example/domain/model/TimelineModels.kt",
            "src/main/java/com/example/ui/GlobalSearchController.kt",
            "src/main/java/com/example/ui/TimelineController.kt"
        ).forEach { relative ->
            val source = File(appRoot, relative).readText()
            assertFalse("$relative contains Arabic UI text", Regex("[\\u0600-\\u06FF]").containsMatchIn(source))
        }
    }

    @Test
    fun `root layout follows the active locale instead of forcing RTL`() {
        val source = File(appRoot, "src/main/java/com/example/ui/MawaredViews.kt").readText()
        assertFalse(source.contains("LocalLayoutDirection provides LayoutDirection.Rtl"))
    }
}
