package com.example.ui.ux

import java.text.ParseException
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * Pure (non-Compose) Sprint 12D form/screen helpers.
 *
 * These types stay free of Android framework imports so ViewModels and JVM unit
 * tests can share the same validation and lifecycle rules.
 */

/** Typed screen/form phase for immutable feature state. */
enum class MawaredScreenPhase {
    Initial,
    Loading,
    Content,
    Empty,
    Error
}

/**
 * Snapshot of editable form values plus submission lock.
 *
 * Recoverable failures keep [values]; only an explicit caller clears or replaces them.
 */
data class MawaredFormSubmissionState(
    val values: Map<String, String> = emptyMap(),
    val isSubmitting: Boolean = false,
    val fieldErrors: Map<String, String> = emptyMap()
)

/** Result of attempting to start a submit while respecting the duplicate-tap lock. */
sealed class FormSubmitAttempt {
    data class Accepted(val state: MawaredFormSubmissionState) : FormSubmitAttempt()
    data class RejectedWhileSubmitting(val state: MawaredFormSubmissionState) : FormSubmitAttempt()
}

object MawaredFormSubmission {
    /**
     * Accepts the first submit and marks the form submitting.
     * Rejects a second submit while [MawaredFormSubmissionState.isSubmitting] is true,
     * retaining the same values.
     */
    fun trySubmit(state: MawaredFormSubmissionState): FormSubmitAttempt {
        if (state.isSubmitting) {
            return FormSubmitAttempt.RejectedWhileSubmitting(state)
        }
        return FormSubmitAttempt.Accepted(
            state.copy(isSubmitting = true, fieldErrors = emptyMap())
        )
    }

    /**
     * Ends submission after a recoverable server/client failure.
     * Field values are retained so the user can fix and retry.
     */
    fun retainAfterRecoverableError(
        state: MawaredFormSubmissionState,
        fieldErrors: Map<String, String> = emptyMap()
    ): MawaredFormSubmissionState =
        state.copy(isSubmitting = false, fieldErrors = fieldErrors)

    /** Ends submission after success without inventing new field values. */
    fun completeSuccess(state: MawaredFormSubmissionState): MawaredFormSubmissionState =
        state.copy(isSubmitting = false, fieldErrors = emptyMap())
}

/** Money parse outcome: exact String only — never [Double]. */
sealed class MawaredMoneyParseResult {
    data class Valid(val exactValue: String) : MawaredMoneyParseResult()
    data class Invalid(val reason: MawaredMoneyInvalidReason) : MawaredMoneyParseResult()
}

enum class MawaredMoneyInvalidReason {
    Empty,
    InvalidFormat,
    TooManyDecimals
}

/**
 * [MawaredMoneyField] pure logic: exact String state for DTOs.
 *
 * - Maps common locale decimal separators to `.`
 * - Allows at most two fraction digits
 * - Returns the validated string unchanged (no floating-point rewrite)
 */
object MawaredMoneyFieldLogic {
    private val VALID_EXACT = Regex("""^\d+(\.\d{1,2})?$""")

    fun parse(raw: String): MawaredMoneyParseResult {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) {
            return MawaredMoneyParseResult.Invalid(MawaredMoneyInvalidReason.Empty)
        }

        val normalized = trimmed
            .replace(',', '.')
            .replace('\u066B', '.') // Arabic decimal separator

        val dotCount = normalized.count { it == '.' }
        if (dotCount > 1) {
            return MawaredMoneyParseResult.Invalid(MawaredMoneyInvalidReason.InvalidFormat)
        }
        if (dotCount == 1) {
            val fraction = normalized.substringAfter('.')
            if (fraction.length > 2) {
                return MawaredMoneyParseResult.Invalid(MawaredMoneyInvalidReason.TooManyDecimals)
            }
        }

        if (!VALID_EXACT.matches(normalized)) {
            return MawaredMoneyParseResult.Invalid(MawaredMoneyInvalidReason.InvalidFormat)
        }

        // Preserve the exact DTO string (after separator mapping only).
        return MawaredMoneyParseResult.Valid(normalized)
    }
}

/**
 * [MawaredDateField] pure ISO helpers.
 *
 * Wire format is strict `yyyy-MM-dd` using API-24-safe calendar parsing
 * (no `java.time`, which lint flags as NewApi on minSdk 24 without desugaring).
 */
object MawaredDateFieldLogic {
    private fun isoFormat(): SimpleDateFormat =
        SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
            isLenient = false
            timeZone = TimeZone.getTimeZone("UTC")
        }

    fun formatIso(year: Int, month: Int, dayOfMonth: Int): String {
        val calendar = Calendar.getInstance(TimeZone.getTimeZone("UTC"), Locale.US).apply {
            clear()
            set(Calendar.YEAR, year)
            set(Calendar.MONTH, month - 1)
            set(Calendar.DAY_OF_MONTH, dayOfMonth)
        }
        return isoFormat().format(calendar.time)
    }

    /** Returns the trimmed ISO string when valid; otherwise null. */
    fun parseIso(iso: String): String? {
        val trimmed = iso.trim()
        if (trimmed.isEmpty()) return null
        if (!Regex("""^\d{4}-\d{2}-\d{2}$""").matches(trimmed)) return null
        return try {
            val parsed = isoFormat().parse(trimmed) ?: return null
            val normalized = isoFormat().format(parsed)
            if (normalized == trimmed) trimmed else null
        } catch (_: ParseException) {
            null
        }
    }

    fun isValidIso(iso: String): Boolean = parseIso(iso) != null

    /**
     * Display format DD/MM/YYYY with Western digits (Locale.US / ASCII 0-9).
     * Returns blank when [iso] is blank; returns the original string when invalid.
     */
    fun formatDisplayDdMmYyyy(iso: String): String {
        val trimmed = iso.trim()
        if (trimmed.isEmpty()) return ""
        val parsed = parseIso(trimmed) ?: return trimmed
        return displayFormat().format(isoFormat().parse(parsed)!!)
    }

    /** True when both dates parse and start is on or before end (inclusive). */
    fun isStartOnOrBeforeEnd(startIso: String, endIso: String): Boolean {
        val start = parseIso(startIso) ?: return false
        val end = parseIso(endIso) ?: return false
        return start <= end
    }

    private fun displayFormat(): SimpleDateFormat =
        SimpleDateFormat("dd/MM/yyyy", Locale.US).apply {
            isLenient = false
            timeZone = TimeZone.getTimeZone("UTC")
        }
}

/**
 * [MawaredUnsavedChangesGuard] pure dirty detection.
 *
 * Dirty when current values differ from the baseline. Never auto-discards;
 * callers must explicitly save, discard, or cancel.
 */
data class UnsavedChangesGuard(
    val baselineValues: Map<String, String>
) {
    fun isDirty(currentValues: Map<String, String>): Boolean =
        currentValues != baselineValues

    /** True only when leaving would lose edits; does not discard anything. */
    fun shouldPromptBeforeLeave(currentValues: Map<String, String>): Boolean =
        isDirty(currentValues)

    /** Explicit discard — the only way baseline values replace the draft. */
    fun discardToBaseline(): Map<String, String> = baselineValues
}

/** Client-side email check; backend validation remains authoritative. */
sealed class MawaredEmailValidationResult {
    data class Valid(val trimmed: String) : MawaredEmailValidationResult()
    data class Invalid(val reason: MawaredEmailInvalidReason) : MawaredEmailValidationResult()
}

enum class MawaredEmailInvalidReason {
    Empty,
    TooLong,
    InvalidSyntax
}

/**
 * [MawaredEmailField] pure client validation: trim, basic syntax, length bound.
 */
object MawaredEmailFieldLogic {
    /** Practical upper bound for mailbox addresses (RFC 5321 forwarding path). */
    const val MAX_LENGTH: Int = 254

    private val BASIC_SYNTAX = Regex(
        """^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$"""
    )

    fun validate(raw: String): MawaredEmailValidationResult {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) {
            return MawaredEmailValidationResult.Invalid(MawaredEmailInvalidReason.Empty)
        }
        if (trimmed.length > MAX_LENGTH) {
            return MawaredEmailValidationResult.Invalid(MawaredEmailInvalidReason.TooLong)
        }
        if (!BASIC_SYNTAX.matches(trimmed)) {
            return MawaredEmailValidationResult.Invalid(MawaredEmailInvalidReason.InvalidSyntax)
        }
        return MawaredEmailValidationResult.Valid(trimmed)
    }
}
