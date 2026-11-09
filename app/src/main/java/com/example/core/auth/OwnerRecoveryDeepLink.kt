package com.example.core.auth

import android.net.Uri
import com.example.BuildConfig

/**
 * Narrow allowlist for company Primary Owner recovery deep links.
 *
 * A self-hosted HTTPS App Link is verified against the configured hostname.
 * Token is taken from the URL fragment only — query tokens are rejected.
 * Unknown hosts, HTTP, wrong paths, and malformed tokens are rejected.
 */
object OwnerRecoveryDeepLink {
    const val HTTPS_SCHEME = "https"
    val HTTPS_HOST: String = BuildConfig.OWNER_RECOVERY_HOST
    const val HTTPS_PATH = "/owner-recovery/reset"

    const val MESSAGE_KEY_INVALID = "owner_recovery.invalid_or_expired"

    sealed interface ParseResult {
        data class Accepted(val token: String) : ParseResult
        data object ManualFallback : ParseResult
        data object NotOwnerRecovery : ParseResult
    }

    fun parse(uri: Uri?): ParseResult {
        if (uri == null) return ParseResult.NotOwnerRecovery
        if (!matchesAllowlist(uri)) return ParseResult.NotOwnerRecovery

        val rawToken = extractFragmentToken(uri) ?: return ParseResult.ManualFallback
        if (rawToken.isBlank()) return ParseResult.ManualFallback
        return if (OwnerRecoveryTokenRules.isValid(rawToken)) {
            ParseResult.Accepted(rawToken)
        } else {
            ParseResult.ManualFallback
        }
    }

    fun matchesAllowlist(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase().orEmpty()
        val host = uri.host?.lowercase().orEmpty()
        val path = uri.path.orEmpty()

        return scheme == HTTPS_SCHEME && host == HTTPS_HOST && path == HTTPS_PATH
            && (uri.port == -1 || uri.port == 443) && uri.userInfo == null
    }

    /**
     * Fragment-only token extraction (`#token=…`).
     * Query `?token=` is intentionally ignored so tokens never ride in Referer-visible URLs.
     */
    private fun extractFragmentToken(uri: Uri): String? {
        val fragment = uri.fragment.orEmpty()
        if (fragment.isBlank()) return null

        return fragment
            .split('&')
            .mapNotNull { part ->
                val idx = part.indexOf('=')
                if (idx <= 0) null
                else part.substring(0, idx) to part.substring(idx + 1)
            }
            .firstOrNull { it.first.equals("token", ignoreCase = true) }
            ?.second
            ?.let { Uri.decode(it) }
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
    }
}
