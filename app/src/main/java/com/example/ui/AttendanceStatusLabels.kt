package com.example.ui

import androidx.annotation.StringRes
import com.example.R
import java.util.Locale

/**
 * Maps attendance status wire/display values to string resources.
 * Domain/API may still carry Arabic labels ("حاضر") or English enums ("present");
 * presentation always goes through resources.
 */
@StringRes
internal fun attendanceStatusLabelRes(status: String): Int = when (status.trim().lowercase(Locale.ROOT)) {
    "حاضر", "present" -> R.string.attendance_status_present
    "متأخر", "late" -> R.string.attendance_status_late
    "غائب", "absent" -> R.string.attendance_status_absent
    "إجازة", "on_leave", "on leave" -> R.string.attendance_status_on_leave
    "انصراف مبكر", "early_leave", "early leave" -> R.string.attendance_status_early_leave
    else -> R.string.status_unknown
}

/**
 * Filter chips keep Arabic domain values so [MawaredViewModel] status matching
 * continues to work without changing internal filter storage.
 */
internal data class AttendanceStatusFilterOption(
    val filterValue: String,
    @StringRes val labelRes: Int
)

internal fun attendanceStatusFilterOptions(): List<AttendanceStatusFilterOption> = listOf(
    AttendanceStatusFilterOption("الكل", R.string.ux_all),
    AttendanceStatusFilterOption("حاضر", R.string.attendance_status_present),
    AttendanceStatusFilterOption("متأخر", R.string.attendance_status_late),
    AttendanceStatusFilterOption("غائب", R.string.attendance_status_absent),
    AttendanceStatusFilterOption("إجازة", R.string.attendance_status_on_leave)
)

internal fun attendanceManualStatusOptions(): List<Pair<String, Int>> = listOf(
    "present" to R.string.attendance_status_present,
    "late" to R.string.attendance_status_late,
    "absent" to R.string.attendance_status_absent
)
