package com.example.core.utils

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Guards the inclusive leave-day calculation and ISO date helpers. */
class DateUtilsTest {

    @Test
    fun `single day range counts as 1`() {
        assertEquals(1, DateUtils.inclusiveDayCount("2026-07-10", "2026-07-10"))
    }

    @Test
    fun `multi-day range is inclusive of both ends`() {
        assertEquals(5, DateUtils.inclusiveDayCount("2026-07-10", "2026-07-14"))
    }

    @Test
    fun `range spanning a month boundary counts correctly`() {
        // 2026-07-30, 31, 08-01 = 3 days
        assertEquals(3, DateUtils.inclusiveDayCount("2026-07-30", "2026-08-01"))
    }

    @Test
    fun `end before start falls back to 1`() {
        assertEquals(1, DateUtils.inclusiveDayCount("2026-07-14", "2026-07-10"))
    }

    @Test
    fun `invalid date falls back to 1`() {
        assertEquals(1, DateUtils.inclusiveDayCount("not-a-date", "2026-07-10"))
        assertEquals(1, DateUtils.inclusiveDayCount("2026-07-10", ""))
    }

    @Test
    fun `iso to epoch and back round-trips`() {
        val ms = DateUtils.epochMillisFromIso("2026-07-10")
        assertEquals("2026-07-10", DateUtils.isoFromEpochMillis(ms!!))
    }

    @Test
    fun `invalid iso returns null epoch`() {
        assertNull(DateUtils.epochMillisFromIso("10/07/2026"))
        assertNull(DateUtils.epochMillisFromIso("bad"))
    }
}
