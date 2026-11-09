package com.example.core.utils

import java.math.BigInteger

/**
 * Exact decimal-string quantity helpers for the purchasing screens.
 *
 * Purchasing quantities are `DECIMAL(18,3)` on the server and are only ever
 * computed there. The app still has to compare and format them (remaining
 * quantity, input validation, progress), so it does the same integer
 * milli-unit arithmetic with [BigInteger] instead of Double — a purchase
 * quantity must never pass through IEEE floating point.
 */
object PurchasingQuantity {

    /** A trailing "1." is not an exact quantity, so the fraction needs at least one digit. */
    private val PATTERN = Regex("""^(\d+)(?:\.(\d{1,3}))?$""")
    private val THOUSAND = BigInteger.valueOf(1000)

    /** Integer milli-units, or null when the value is not an exact quantity. */
    fun parseMilli(value: String?): BigInteger? {
        val trimmed = value?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        val match = PATTERN.matchEntire(trimmed) ?: return null
        val whole = BigInteger(match.groupValues[1])
        val fractionText = match.groupValues[2].padEnd(3, '0')
        val fraction = if (fractionText.isEmpty()) BigInteger.ZERO else BigInteger(fractionText)
        return whole.multiply(THOUSAND).add(fraction)
    }

    /** Canonical `0.000` string for integer milli-units. */
    fun milliToString(milli: BigInteger): String {
        val negative = milli.signum() < 0
        val absolute = milli.abs()
        val whole = absolute.divide(THOUSAND)
        val fraction = absolute.mod(THOUSAND).toString().padStart(3, '0')
        val body = "$whole.$fraction"
        return if (negative) "-$body" else body
    }

    /** Canonical form of user input, or null when it is not an exact quantity. */
    fun normalize(value: String): String? = parseMilli(value)?.let(::milliToString)

    /** Display form: grouped thousands, trailing zeros trimmed. */
    fun format(value: String?): String {
        val milli = parseMilli(value) ?: return "—"
        val whole = milli.divide(THOUSAND).toString()
            .reversed()
            .chunked(3)
            .joinToString(",")
            .reversed()
        val fraction = milli.mod(THOUSAND).toString().padStart(3, '0').trimEnd('0')
        return if (fraction.isEmpty()) whole else "$whole.$fraction"
    }

    fun isPositive(value: String?): Boolean {
        val milli = parseMilli(value) ?: return false
        return milli.signum() > 0
    }

    /**
     * Client-side pre-check only. The backend re-derives the position inside its
     * row lock and stays the authority; this exists so the user is not sent to
     * the server with an obviously impossible quantity.
     */
    fun exceeds(value: String?, limit: String?): Boolean {
        val requested = parseMilli(value) ?: return false
        val allowed = parseMilli(limit) ?: return false
        return requested > allowed
    }

    /** Received percentage of a line, clamped to 0..100 for progress indicators. */
    fun receivedPercent(netReceived: String?, ordered: String?): Int {
        val net = parseMilli(netReceived) ?: return 0
        val total = parseMilli(ordered) ?: return 0
        if (total.signum() <= 0) return 0
        val capped = if (net > total) total else net
        return capped.multiply(BigInteger.valueOf(100)).divide(total).toInt()
    }
}
