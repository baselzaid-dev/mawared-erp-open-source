package com.example.ui

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.example.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class QaRound2LocalizationTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    private fun source(path: String): String = File(appRoot, path).readText()

    private val round2Keys = listOf(
        "metric_additional_indicator",
        "metric_pending_department_count",
        "metric_pending_purchasing_count",
        "metric_ordered_count",
        "metric_received_count",
        "metric_draft_order_count",
        "metric_issued_order_count",
        "metric_received_order_count",
        "metric_estimated_total",
        "metric_draft_course_count",
        "metric_cancelled_course_count",
        "metric_assigned_count",
        "metric_in_progress_count",
        "metric_completed_assignment_count",
        "metric_returned_count",
        "metric_cancelled_assignment_count",
        "metric_overdue_count",
        "nav_employees",
        "chat_empty_recipients",
        "chat_title",
        "attendance_range_custom",
        "attendance_status_on_leave",
        "attendance_empty_detail",
        "my_work_empty_category_title",
        "my_work_empty_category_detail",
        "ux_error_cd",
        "report_section_employees",
        "reports_unavailable_sections_prefix"
    )

    @Test
    fun `QA Round 2 localization keys exist in Arabic default and English override`() {
        val arabic = source("src/main/res/values/strings.xml")
        val english = source("src/main/res/values-en/strings.xml")
        round2Keys.forEach { key ->
            assertTrue("missing Arabic key $key", arabic.contains("name=\"$key\""))
            assertTrue("missing English key $key", english.contains("name=\"$key\""))
        }
        assertTrue(arabic.contains("فترة مخصصة"))
        assertTrue(arabic.contains("في إجازة"))
        assertTrue(arabic.contains("لا توجد سجلات حضور خلال الفترة المحددة"))
        assertTrue(arabic.contains("لا توجد عناصر ضمن هذا التصنيف"))
        assertTrue(arabic.contains("المحادثات الداخلية"))
        assertTrue(arabic.contains("مؤشر إضافي"))
        assertTrue(arabic.contains("لا يوجد موظفون أو أقسام متاحة لبدء محادثة حاليًا"))
        assertTrue(arabic.contains("الموظفون"))
        assertFalse(arabic.contains("chat.view"))
        assertFalse(arabic.contains("chat.create_company_announcement"))
        assertFalse(english.contains("chat.view"))
        assertFalse(english.contains("chat.create_company_announcement"))
    }

    @Test
    fun `report views no longer use unsafe metric key fallbacks`() {
        val unified = source("src/main/java/com/example/ui/UnifiedReportViews.kt")
        val template = source("src/main/java/com/example/ui/ReportTemplateViews.kt")
        assertTrue(unified.contains("MetricLabelResolver.resolveResId"))
        assertTrue(template.contains("MetricLabelResolver.resolveResId"))
        assertFalse(unified.contains("?: key"))
        assertFalse(template.contains("else -> key"))
        assertFalse(unified.contains("reportMetricLabels"))
        assertFalse(template.contains("templateMetricLabel"))
        assertTrue(unified.contains("ReportSectionLabelResolver"))
        assertTrue(template.contains("reportDisplayValueRes") || template.contains("templateDisplayValueLocalized"))
    }

    @Test
    fun `training average score KPI uses localized metric resource`() {
        val training = source("src/main/java/com/example/ui/TrainingViews.kt")
        assertTrue(training.contains("MetricLabelResolver.resolveResId(\"averageScore\")"))
        assertFalse(training.contains("TrainingKpi(\"متوسط الدرجة\""))
    }

    @Test
    fun `resource layout keeps Arabic default and English selectable`() {
        val manifest = source("src/main/AndroidManifest.xml")
        val activity = source("src/main/java/com/example/MainActivity.kt")
        assertTrue(File(appRoot, "src/main/res/values/strings.xml").exists())
        assertTrue(File(appRoot, "src/main/res/values-en/strings.xml").exists())
        assertFalse(File(appRoot, "src/main/res/values-ar/strings.xml").exists())
        assertFalse(File(appRoot, "src/main/java/com/example/MawaredApplication.kt").exists())
        assertFalse(File(appRoot, "src/main/java/com/example/core/locale/MawaredLocale.kt").exists())
        assertFalse(manifest.contains("android:name=\".MawaredApplication\""))
        assertFalse(activity.contains("MawaredLocale.wrap"))
    }

    @Test
    @Config(qualifiers = "ar")
    fun `Arabic locale resolves Arabic resources and RTL`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertEquals("مؤشر إضافي", context.getString(R.string.metric_additional_indicator))
        assertEquals(android.util.LayoutDirection.RTL, context.resources.configuration.layoutDirection)
    }

    @Test
    @Config(qualifiers = "en")
    fun `English locale remains reachable and LTR`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertEquals("Additional indicator", context.getString(R.string.metric_additional_indicator))
        assertEquals(android.util.LayoutDirection.LTR, context.resources.configuration.layoutDirection)
    }

    @Test
    fun `AiViews and TaskViews avoid hardcoded English content descriptions`() {
        val ai = source("src/main/java/com/example/ui/AiViews.kt")
        val tasks = source("src/main/java/com/example/ui/TaskViews.kt")
        assertTrue(ai.contains("stringResource(R.string.ux_error_cd)"))
        assertFalse(ai.contains("contentDescription = \"Error\""))
        assertTrue(tasks.contains("stringResource(R.string.ux_delete_cd)"))
        assertFalse(tasks.contains("contentDescription = \"Delete\""))
    }

    @Test
    fun `repository scan asserts purchasing training metric keys are mapped`() {
        val resolver = source("src/main/java/com/example/ui/MetricLabelResolver.kt")
        listOf(
            "pendingDepartmentCount", "pendingPurchasingCount", "orderedCount",
            "receivedCount", "draftOrderCount", "issuedOrderCount",
            "receivedOrderCount", "estimatedTotal", "draftCourseCount",
            "cancelledCourseCount", "assignedCount", "inProgressCount",
            "completedAssignmentCount", "returnedCount", "cancelledAssignmentCount",
            "overdueCount"
        ).forEach { key ->
            assertTrue("MetricLabelResolver missing $key", resolver.contains("\"$key\""))
        }
    }
}
