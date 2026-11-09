package com.example.ui

import com.example.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class QaRound1LocalizationTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    private fun source(path: String): String = File(appRoot, path).readText()

    private val requiredKeys = listOf(
        "attendance_status_present",
        "attendance_status_absent",
        "attendance_status_late",
        "attendance_status_on_leave",
        "attendance_empty_title",
        "ux_filter",
        "ux_apply",
        "ux_reset",
        "ux_date_picker_title",
        "ux_date_previous",
        "ux_date_next",
        "ux_confirm",
        "ux_cancel",
        "my_work_empty_title",
        "my_work_category_leaves",
        "my_work_category_tasks",
        "my_work_category_attendance",
        "training_status_draft",
        "training_assignment_submitted",
        "training_delivery_online",
        "leave_date_from",
        "leave_date_to",
        "leave_range_order_error",
        "chat_tab_announcements",
        "chat_reply",
        "reports_all_statuses"
    )

    @Test
    fun `QA Round 1 localization keys exist in English and Arabic`() {
        val arabic = source("src/main/res/values/strings.xml")
        val english = source("src/main/res/values-en/strings.xml")
        requiredKeys.forEach { key ->
            assertTrue("missing English key $key", english.contains("name=\"$key\""))
            assertTrue("missing Arabic key $key", arabic.contains("name=\"$key\""))
        }
        assertTrue(arabic.contains("لا توجد سجلات حضور وانصراف"))
        assertTrue(arabic.contains("لا توجد مهام عمل حاليًا"))
        assertTrue(arabic.contains("اختيار التاريخ"))
        assertTrue(arabic.contains(">تأكيد<") || arabic.contains(">تأكيد</string>"))
        assertTrue(arabic.contains("السابق"))
        assertTrue(arabic.contains("التالي"))
    }

    @Test
    fun `attendance status mapper covers present late absent and leave`() {
        assertEquals(R.string.attendance_status_present, attendanceStatusLabelRes("حاضر"))
        assertEquals(R.string.attendance_status_present, attendanceStatusLabelRes("present"))
        assertEquals(R.string.attendance_status_late, attendanceStatusLabelRes("late"))
        assertEquals(R.string.attendance_status_absent, attendanceStatusLabelRes("غائب"))
        assertEquals(R.string.attendance_status_on_leave, attendanceStatusLabelRes("إجازة"))
        assertEquals(R.string.attendance_status_on_leave, attendanceStatusLabelRes("on_leave"))
        assertEquals(5, attendanceStatusFilterOptions().size)
    }

    @Test
    fun `training and report status mappers return resource ids`() {
        assertEquals(R.string.training_status_draft, trainingCourseStatusLabelRes("draft"))
        assertEquals(R.string.training_assignment_submitted, trainingAssignmentStatusLabelRes("submitted"))
        assertEquals(R.string.training_delivery_online, trainingDeliveryLabelRes("online"))
        assertEquals(R.string.attendance_status_present, reportDisplayValueRes("present"))
        assertTrue(reportStatusOptionRes("attendance").any { it.first == "present" })
        assertTrue(reportStatusOptionRes("training").any { it.first == "archived" })
    }

    @Test
    fun `owned views avoid hardcoded English status chips`() {
        val attendance = source("src/main/java/com/example/ui/AttendanceViews.kt")
        assertTrue(attendance.contains("attendanceStatusFilterOptions()"))
        assertTrue(attendance.contains("attendanceStatusLabelRes"))
        assertTrue(!attendance.contains("""items(listOf("الكل", "حاضر", "متأخر", "غائب"))"""))

        val myWork = source("src/main/java/com/example/ui/MyWorkViews.kt")
        assertTrue(myWork.contains("category.labelRes"))
        assertTrue(!myWork.contains("arabicLabel"))

        val training = source("src/main/java/com/example/ui/TrainingViews.kt")
        assertTrue(training.contains("trainingCourseStatusLabelRes"))
        assertTrue(training.contains("trainingAssignmentStatusLabelRes"))
    }
}
