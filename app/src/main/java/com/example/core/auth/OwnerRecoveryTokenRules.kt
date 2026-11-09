package com.example.core.auth

/**
 * Opaque recovery-token shape aligned with backend E3/E6 confirm validators.
 */
object OwnerRecoveryTokenRules {
    const val MIN_LENGTH = 40
    const val MAX_LENGTH = 256
    private val TOKEN_PATTERN = Regex("^[A-Za-z0-9_-]+$")

    fun isValid(token: String): Boolean =
        token.length in MIN_LENGTH..MAX_LENGTH && TOKEN_PATTERN.matches(token)
}
