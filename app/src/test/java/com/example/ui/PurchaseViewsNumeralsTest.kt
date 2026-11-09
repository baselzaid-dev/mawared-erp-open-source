package com.example.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Sprint 12I — quantity/price inputs must always end up as plain English numerals
 * (money/quantity strings are parsed with `toBigDecimalOrNull()`, which returns null for
 * Arabic-Indic digits and silently breaks the create-request/create-order forms).
 */
class PurchaseViewsNumeralsTest {

    @Test
    fun `arabic-indic digits are converted to plain English numerals`() {
        assertEquals("123", normalizeDecimalInput("١٢٣"))
        assertEquals("10.5", normalizeDecimalInput("١٠.٥"))
    }

    @Test
    fun `extended arabic-indic (persian) digits are converted to plain English numerals`() {
        assertEquals("123", normalizeDecimalInput("۱۲۳"))
    }

    @Test
    fun `arabic decimal separator becomes a plain dot`() {
        assertEquals("10.5", normalizeDecimalInput("١٠٫٥"))
    }

    @Test
    fun `plain english numerals pass through unchanged`() {
        assertEquals("10.06", normalizeDecimalInput("10.06"))
        assertEquals("1", normalizeDecimalInput("1"))
    }

    @Test
    fun `only the first decimal point is kept and other characters are stripped`() {
        assertEquals("10.56", normalizeDecimalInput("1,0.5.6"))
        assertEquals("105", normalizeDecimalInput("١٠ ٥ابج"))
    }

    @Test
    fun `normalized output always parses as a valid BigDecimal`() {
        assertEquals(123.0, normalizeDecimalInput("١٢٣").toBigDecimal().toDouble(), 0.0)
        assertEquals(10.5, normalizeDecimalInput("١٠.٥").toBigDecimal().toDouble(), 0.0)
    }
}
