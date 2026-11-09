package com.example.ui

import com.example.core.permissions.Permissions
import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.domain.model.AttendanceRangePreset
import com.example.domain.model.AttendanceRecordParams
import com.example.domain.model.AttendanceViewScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

class AttendanceSprint4BTest {
    @Test
    fun `attendance scope follows canonical permissions`() {
        assertEquals(AttendanceViewScope.OWN, MawaredViewModel.attendanceScopeFor(setOf(Permissions.ATTENDANCE_VIEW_OWN)))
        assertEquals(
            AttendanceViewScope.DEPARTMENT,
            MawaredViewModel.attendanceScopeFor(setOf(Permissions.ATTENDANCE_VIEW_DEPARTMENT))
        )
        assertEquals(AttendanceViewScope.COMPANY, MawaredViewModel.attendanceScopeFor(setOf(Permissions.ATTENDANCE_VIEW)))
        assertEquals(AttendanceViewScope.COMPANY, MawaredViewModel.attendanceScopeFor(setOf(Permissions.ADMIN_FULL)))
    }

    @Test
    fun `week and month ranges end on the selected UTC day`() {
        val parser = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }
        val now = parser.parse("2026-07-10")!!
        val week = MawaredViewModel.attendanceRangeFor(AttendanceRangePreset.THIS_WEEK, now)
        val month = MawaredViewModel.attendanceRangeFor(AttendanceRangePreset.THIS_MONTH, now)
        assertEquals("2026-07-05", week.from)
        assertEquals("2026-07-10", week.to)
        assertEquals("2026-07-01", month.from)
        assertEquals("2026-07-10", month.to)
    }

    @Test
    fun `ISO attendance date validation rejects impossible dates`() {
        assertTrue(MawaredViewModel.isIsoAttendanceDate("2026-07-10"))
        assertFalse(MawaredViewModel.isIsoAttendanceDate("2026-02-30"))
        assertFalse(MawaredViewModel.isIsoAttendanceDate("2026-7-10"))
    }

    @Test
    fun `summary counts scoped records and only completed working minutes`() {
        val records = listOf(
            record("1", "حاضر", "08:00", "17:00"),
            record("2", "متأخر", "09:00", null),
            record("3", "غائب", null, null),
            record("4", "حاضر", "08:30", "12:00")
        )
        val summary = MawaredViewModel.calculateAttendanceSummary(records)
        assertEquals(2, summary.present)
        assertEquals(1, summary.late)
        assertEquals(1, summary.absent)
        assertEquals(1, summary.missingClockOut)
        assertEquals(750L, summary.completedWorkMinutes)
    }

    @Test
    fun `duplicate server response maps to clean Arabic`() {
        val error = AppResult.Error(Exception("duplicate"), AppError.ServerError(409, "duplicate"))
        assertEquals(
            "يوجد سجل حضور لهذا الموظف في هذا اليوم مسبقاً.",
            MawaredViewModel.mapAttendanceActionError(error)
        )
    }

    @Test
    fun `admin landing and self clock restriction regression remains`() {
        assertEquals(
            MawaredViewModel.TAB_DASHBOARD,
            MawaredViewModel.landingTabForPermissions(setOf(Permissions.ADMIN_FULL, Permissions.ATTENDANCE_CLOCK))
        )
        assertEquals(AttendanceViewScope.COMPANY, MawaredViewModel.attendanceScopeFor(setOf(Permissions.ADMIN_FULL)))
    }

    private fun record(
        id: String,
        status: String,
        clockIn: String?,
        clockOut: String?
    ) = AttendanceRecordParams(
        id = id,
        companyId = "c1",
        employeeId = "e$id",
        employeeName = "موظف",
        departmentName = "الهندسة",
        date = "2026-07-10",
        clockInTime = clockIn,
        clockOutTime = clockOut,
        status = status,
        lateMinutes = 0,
        overtimeMinutes = 0,
        source = "",
        locationLat = null,
        locationLng = null,
        createdAt = "",
        updatedAt = null
    )
}
