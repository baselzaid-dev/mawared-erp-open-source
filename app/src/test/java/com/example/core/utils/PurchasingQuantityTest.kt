package com.example.core.utils

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger

/**
 * Commercial Wave 2 — the Android side must compare purchasing quantities with
 * exact integer milli-units, never Double.
 */
class PurchasingQuantityTest {

    @Test
    fun `parses exact quantity strings into integer milli-units`() {
        assertEquals(BigInteger.valueOf(1000), PurchasingQuantity.parseMilli("1"))
        assertEquals(BigInteger.valueOf(1500), PurchasingQuantity.parseMilli("1.5"))
        assertEquals(BigInteger.ONE, PurchasingQuantity.parseMilli("0.001"))
        assertEquals(BigInteger.valueOf(10_000), PurchasingQuantity.parseMilli("10.000"))
    }

    @Test
    fun `rejects anything that is not an exact non-negative quantity`() {
        listOf("", "  ", "-1", "1.0001", "1e3", "abc", ".5", "1.", null).forEach { value ->
            assertNull("rejects $value", PurchasingQuantity.parseMilli(value))
        }
    }

    @Test
    fun `round-trips through the canonical three-decimal string`() {
        assertEquals("1.500", PurchasingQuantity.milliToString(BigInteger.valueOf(1500)))
        assertEquals("2.000", PurchasingQuantity.normalize("2"))
        assertEquals("2.500", PurchasingQuantity.normalize("2.5"))
        assertNull(PurchasingQuantity.normalize("bad"))
    }

    @Test
    fun `formats for display with grouping and without trailing zeros`() {
        assertEquals("1,000.5", PurchasingQuantity.format("1000.500"))
        assertEquals("3", PurchasingQuantity.format("3.000"))
        assertEquals("0.125", PurchasingQuantity.format("0.125"))
        assertEquals("—", PurchasingQuantity.format(null))
        // A value that Double arithmetic would corrupt stays exact.
        assertEquals("0.3", PurchasingQuantity.format("0.300"))
    }

    @Test
    fun `compares against a limit exactly`() {
        assertTrue(PurchasingQuantity.exceeds("5.001", "5.000"))
        assertFalse(PurchasingQuantity.exceeds("5.000", "5.000"))
        assertFalse(PurchasingQuantity.exceeds("4.999", "5.000"))
        // Unparseable input is left for the server to reject, not silently blocked.
        assertFalse(PurchasingQuantity.exceeds("bad", "5.000"))
    }

    @Test
    fun `recognizes strictly positive quantities`() {
        assertTrue(PurchasingQuantity.isPositive("0.001"))
        assertFalse(PurchasingQuantity.isPositive("0"))
        assertFalse(PurchasingQuantity.isPositive("0.000"))
        assertFalse(PurchasingQuantity.isPositive("-1"))
    }

    @Test
    fun `clamps the received percentage between zero and one hundred`() {
        assertEquals(50, PurchasingQuantity.receivedPercent("5.000", "10.000"))
        assertEquals(100, PurchasingQuantity.receivedPercent("10.000", "10.000"))
        // An audited over-receipt never renders past 100%.
        assertEquals(100, PurchasingQuantity.receivedPercent("11.000", "10.000"))
        assertEquals(0, PurchasingQuantity.receivedPercent("1.000", "0.000"))
    }
}
