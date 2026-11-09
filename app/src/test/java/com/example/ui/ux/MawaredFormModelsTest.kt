package com.example.ui.ux

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MawaredFormModelsTest {

    // --- Screen phase ---

    @Test
    fun `screen phases cover initial loading content empty and error`() {
        val phases = MawaredScreenPhase.entries.toSet()
        assertEquals(
            setOf(
                MawaredScreenPhase.Initial,
                MawaredScreenPhase.Loading,
                MawaredScreenPhase.Content,
                MawaredScreenPhase.Empty,
                MawaredScreenPhase.Error
            ),
            phases
        )
    }

    // --- Form submission ---

    @Test
    fun `trySubmit rejects duplicate submit while submitting`() {
        val values = mapOf("amount" to "10.00", "note" to "ok")
        val idle = MawaredFormSubmissionState(values = values)
        val accepted = MawaredFormSubmission.trySubmit(idle)
        assertTrue(accepted is FormSubmitAttempt.Accepted)
        val submitting = (accepted as FormSubmitAttempt.Accepted).state
        assertTrue(submitting.isSubmitting)

        val duplicate = MawaredFormSubmission.trySubmit(submitting)
        assertTrue(duplicate is FormSubmitAttempt.RejectedWhileSubmitting)
        val rejected = (duplicate as FormSubmitAttempt.RejectedWhileSubmitting).state
        assertEquals(values, rejected.values)
        assertTrue(rejected.isSubmitting)
    }

    @Test
    fun `retainAfterRecoverableError keeps values and clears submitting`() {
        val values = mapOf("email" to "a@fixture-3.example.test", "name" to "Ali")
        val submitting = MawaredFormSubmissionState(values = values, isSubmitting = true)
        val retained = MawaredFormSubmission.retainAfterRecoverableError(
            submitting,
            fieldErrors = mapOf("email" to "taken")
        )
        assertFalse(retained.isSubmitting)
        assertEquals(values, retained.values)
        assertEquals(mapOf("email" to "taken"), retained.fieldErrors)
    }

    // --- Money ---

    @Test
    fun `money accepts exact dto string with at most two decimals`() {
        val result = MawaredMoneyFieldLogic.parse("12.50")
        assertEquals(MawaredMoneyParseResult.Valid("12.50"), result)
    }

    @Test
    fun `money maps locale decimal separators to dot and preserves exact string`() {
        assertEquals(
            MawaredMoneyParseResult.Valid("10.5"),
            MawaredMoneyFieldLogic.parse("10,5")
        )
        assertEquals(
            MawaredMoneyParseResult.Valid("3.25"),
            MawaredMoneyFieldLogic.parse("3\u066B25")
        )
    }

    @Test
    fun `money accepts leading zero amounts`() {
        assertEquals(
            MawaredMoneyParseResult.Valid("0.50"),
            MawaredMoneyFieldLogic.parse("0.50")
        )
        assertEquals(
            MawaredMoneyParseResult.Valid("01.5"),
            MawaredMoneyFieldLogic.parse("01.5")
        )
    }

    @Test
    fun `money rejects more than two decimal places`() {
        val result = MawaredMoneyFieldLogic.parse("10.555")
        assertEquals(
            MawaredMoneyParseResult.Invalid(MawaredMoneyInvalidReason.TooManyDecimals),
            result
        )
    }

    @Test
    fun `money rejects invalid formats`() {
        assertEquals(
            MawaredMoneyParseResult.Invalid(MawaredMoneyInvalidReason.Empty),
            MawaredMoneyFieldLogic.parse("   ")
        )
        assertEquals(
            MawaredMoneyParseResult.Invalid(MawaredMoneyInvalidReason.InvalidFormat),
            MawaredMoneyFieldLogic.parse("12.5.0")
        )
        assertEquals(
            MawaredMoneyParseResult.Invalid(MawaredMoneyInvalidReason.InvalidFormat),
            MawaredMoneyFieldLogic.parse("abc")
        )
        assertEquals(
            MawaredMoneyParseResult.Invalid(MawaredMoneyInvalidReason.InvalidFormat),
            MawaredMoneyFieldLogic.parse(".5")
        )
    }

    // --- Date ISO ---

    @Test
    fun `date formats and parses strict iso yyyy-MM-dd`() {
        assertEquals("2026-07-19", MawaredDateFieldLogic.formatIso(2026, 7, 19))
        assertEquals("2026-07-19", MawaredDateFieldLogic.parseIso("2026-07-19"))
        assertTrue(MawaredDateFieldLogic.isValidIso("2026-07-19"))
    }

    @Test
    fun `date rejects invalid iso strings`() {
        assertNull(MawaredDateFieldLogic.parseIso("19/07/2026"))
        assertNull(MawaredDateFieldLogic.parseIso("2026-13-01"))
        assertNull(MawaredDateFieldLogic.parseIso("not-a-date"))
        assertFalse(MawaredDateFieldLogic.isValidIso(""))
    }

    @Test
    fun `date leap year accepts feb 29 only on leap years`() {
        assertEquals("2024-02-29", MawaredDateFieldLogic.parseIso("2024-02-29"))
        assertNull(MawaredDateFieldLogic.parseIso("2025-02-29"))
        assertNull(MawaredDateFieldLogic.parseIso("2023-02-29"))
    }

    @Test
    fun `date field formats display as western DD MM YYYY`() {
        assertEquals("19/07/2026", MawaredDateFieldLogic.formatDisplayDdMmYyyy("2026-07-19"))
        assertTrue(MawaredDateFieldLogic.isStartOnOrBeforeEnd("2026-01-01", "2026-01-31"))
        assertFalse(MawaredDateFieldLogic.isStartOnOrBeforeEnd("2026-02-01", "2026-01-31"))
    }

    // --- Unsaved / dirty ---

    @Test
    fun `unsaved guard is dirty only when current differs from baseline`() {
        val guard = UnsavedChangesGuard(
            baselineValues = mapOf("name" to "Sara", "amount" to "1.00")
        )
        assertFalse(guard.isDirty(mapOf("name" to "Sara", "amount" to "1.00")))
        assertTrue(guard.isDirty(mapOf("name" to "Sara", "amount" to "2.00")))
        assertTrue(guard.shouldPromptBeforeLeave(mapOf("name" to "Nour", "amount" to "1.00")))
    }

    @Test
    fun `unsaved guard never auto-discards and only returns baseline on explicit discard`() {
        val baseline = mapOf("note" to "draft")
        val guard = UnsavedChangesGuard(baselineValues = baseline)
        val dirty = mapOf("note" to "changed")
        assertTrue(guard.isDirty(dirty))
        // Prompting does not mutate or discard.
        assertTrue(guard.shouldPromptBeforeLeave(dirty))
        assertEquals(dirty, dirty)
        assertEquals(baseline, guard.discardToBaseline())
    }

    // --- Email ---

    @Test
    fun `email trims whitespace and accepts basic syntax`() {
        val result = MawaredEmailFieldLogic.validate("  User.Name+tag@Example.com  ")
        assertEquals(
            MawaredEmailValidationResult.Valid("User.Name+tag@Example.com"),
            result
        )
    }

    @Test
    fun `email rejects empty invalid syntax and over-length input`() {
        assertEquals(
            MawaredEmailValidationResult.Invalid(MawaredEmailInvalidReason.Empty),
            MawaredEmailFieldLogic.validate("   ")
        )
        assertEquals(
            MawaredEmailValidationResult.Invalid(MawaredEmailInvalidReason.InvalidSyntax),
            MawaredEmailFieldLogic.validate("not-an-email")
        )
        assertEquals(
            MawaredEmailValidationResult.Invalid(MawaredEmailInvalidReason.InvalidSyntax),
            MawaredEmailFieldLogic.validate("a@b")
        )
        val tooLong = "a".repeat(250) + "@x.com"
        assertTrue(tooLong.length > MawaredEmailFieldLogic.MAX_LENGTH)
        assertEquals(
            MawaredEmailValidationResult.Invalid(MawaredEmailInvalidReason.TooLong),
            MawaredEmailFieldLogic.validate(tooLong)
        )
    }
}
