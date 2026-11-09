package com.example.core.utils

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Pure date helpers shared by date-picker fields. Kept free of Android/Compose
 * types so they can be unit-tested on the JVM. All dates use ISO `yyyy-MM-dd`
 * (UTC) which is exactly what the backend expects.
 */
object DateUtils {

    private const val ISO_PATTERN = "yyyy-MM-dd"

    private fun isoFormat(): SimpleDateFormat =
        SimpleDateFormat(ISO_PATTERN, Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
            isLenient = false
        }

    /** Today in ISO `yyyy-MM-dd` (UTC). */
    fun todayIso(): String = isoFormat().format(Date())

    /** Formats an epoch-millis UTC value (from a Material date picker) to ISO. */
    fun isoFromEpochMillis(epochMillis: Long): String = isoFormat().format(Date(epochMillis))

    /** Parses an ISO `yyyy-MM-dd` date to epoch millis (UTC), or null if invalid. */
    fun epochMillisFromIso(iso: String): Long? = try {
        isoFormat().parse(iso)?.time
    } catch (_: Exception) {
        null
    }

    /**
     * Inclusive day count between two ISO dates (start and end both counted).
     * Returns 1 when the range is a single day, and never less than 1. If either
     * date is unparseable or end is before start, falls back to 1.
     */
    fun inclusiveDayCount(startIso: String, endIso: String): Int {
        val startMs = epochMillisFromIso(startIso) ?: return 1
        val endMs = epochMillisFromIso(endIso) ?: return 1
        if (endMs < startMs) return 1
        val startDay = truncateToDay(startMs)
        val endDay = truncateToDay(endMs)
        val diffDays = ((endDay - startDay) / MILLIS_PER_DAY).toInt()
        return diffDays + 1
    }

    private fun truncateToDay(epochMillis: Long): Long {
        val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        cal.timeInMillis = epochMillis
        cal.set(Calendar.HOUR_OF_DAY, 0)
        cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        return cal.timeInMillis
    }

    private const val MILLIS_PER_DAY = 24L * 60L * 60L * 1000L
}
