package com.example.ui.ux

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QaRound1DateFormatTest {

    @Test
    fun `ISO dates format to DD MM YYYY with western digits`() {
        assertEquals("19/07/2026", MawaredDateFieldLogic.formatDisplayDdMmYyyy("2026-07-19"))
        assertEquals("01/01/2025", MawaredDateFieldLogic.formatDisplayDdMmYyyy("2025-01-01"))
        assertEquals("", MawaredDateFieldLogic.formatDisplayDdMmYyyy(""))
        assertEquals("19/07/2026", MawaredDateFieldLogic.formatDisplayDdMmYyyy("2026-07-19").filter { it.isDigit() || it == '/' })
        // Western ASCII digits only (no Arabic-Indic digits)
        MawaredDateFieldLogic.formatDisplayDdMmYyyy("2026-07-19").forEach { ch ->
            if (ch.isDigit()) assertTrue(ch in '0'..'9')
        }
    }

    @Test
    fun `start must be on or before end`() {
        assertTrue(MawaredDateFieldLogic.isStartOnOrBeforeEnd("2026-07-01", "2026-07-19"))
        assertTrue(MawaredDateFieldLogic.isStartOnOrBeforeEnd("2026-07-19", "2026-07-19"))
        assertFalse(MawaredDateFieldLogic.isStartOnOrBeforeEnd("2026-07-20", "2026-07-19"))
        assertFalse(MawaredDateFieldLogic.isStartOnOrBeforeEnd("bad", "2026-07-19"))
        assertFalse(MawaredDateFieldLogic.isStartOnOrBeforeEnd("2026-07-01", "bad"))
    }

    @Test
    fun `wire format remains strict ISO`() {
        assertEquals("2026-07-19", MawaredDateFieldLogic.parseIso("2026-07-19"))
        assertEquals(null, MawaredDateFieldLogic.parseIso("19/07/2026"))
        assertTrue(MawaredDateFieldLogic.isValidIso("2026-07-19"))
        assertFalse(MawaredDateFieldLogic.isValidIso("19/07/2026"))
    }
}
