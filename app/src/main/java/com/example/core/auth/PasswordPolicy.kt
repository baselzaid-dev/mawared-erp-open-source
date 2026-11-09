package com.example.core.auth

/**
 * Shared company-plane password rules for recovery and forced change.
 * Length 10–128; no whitespace characters.
 */
object PasswordPolicy {
    const val MIN_LENGTH = 10
    const val MAX_LENGTH = 128

    fun containsWhitespace(value: String): Boolean =
        value.any { it.isWhitespace() }

    fun isValid(value: String): Boolean =
        value.length in MIN_LENGTH..MAX_LENGTH && !containsWhitespace(value)

    sealed interface Validation {
        data object Ok : Validation
        data object Blank : Validation
        data object TooShort : Validation
        data object TooLong : Validation
        data object ContainsWhitespace : Validation
        data object ConfirmMismatch : Validation
    }

    fun validateNewPassword(newPassword: String, confirmPassword: String? = null): Validation {
        if (newPassword.isEmpty()) return Validation.Blank
        if (containsWhitespace(newPassword)) return Validation.ContainsWhitespace
        if (newPassword.length < MIN_LENGTH) return Validation.TooShort
        if (newPassword.length > MAX_LENGTH) return Validation.TooLong
        if (confirmPassword != null && newPassword != confirmPassword) return Validation.ConfirmMismatch
        return Validation.Ok
    }
}
