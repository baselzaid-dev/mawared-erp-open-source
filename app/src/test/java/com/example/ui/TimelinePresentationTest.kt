package com.example.ui

import com.example.domain.model.TimelineEvent
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Locale
import java.util.TimeZone

class TimelinePresentationTest {
    private fun event(type: String, at: String) = TimelineEvent(
        at = at,
        type = type,
        summary = type,
        fromStatus = null,
        toStatus = null,
        actorName = null,
        actorRole = null,
        reason = null,
        override = false
    )

    @Test
    fun `employment start remains the same calendar date in every device timezone`() {
        val original = TimeZone.getDefault()
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("America/Los_Angeles"))
            val losAngeles = formatTimelineDate(
                event("employee.joined", "2026-01-15T00:00:00.000Z"),
                Locale.US
            )
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Riyadh"))
            val riyadh = formatTimelineDate(
                event("employee.joined", "2026-01-15T00:00:00.000Z"),
                Locale.US
            )

            assertEquals(losAngeles, riyadh)
            assertEquals("Jan 15, 2026", riyadh)
        } finally {
            TimeZone.setDefault(original)
        }
    }

    @Test
    fun `unknown search status uses the safe fallback resource`() {
        assertEquals(com.example.R.string.status_unknown, globalStatusLabel("unexpected"))
    }
}
