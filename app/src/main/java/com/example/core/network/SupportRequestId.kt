package com.example.core.network

import okhttp3.Headers

/**
 * Canonical Backend support request ID policy for Android presentation.
 * IDs are correlation handles only — never auth/session data.
 */
object SupportRequestId {
    private const val MAX_LENGTH = 128
    private val UUID_V4 = Regex(
        "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        RegexOption.IGNORE_CASE,
    )
    private val JSON_FIELD = Regex("\"requestId\"\\s*:\\s*\"([^\"]+)\"", RegexOption.IGNORE_CASE)

    fun sanitize(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        val trimmed = raw.trim()
        if (trimmed.length > MAX_LENGTH) return null
        if (trimmed.any { it.code < 32 || it == '\u007F' || it == '\n' || it == '\r' }) return null
        if (!UUID_V4.matches(trimmed)) return null
        return trimmed.lowercase()
    }

    fun fromHeaders(headers: Headers): String? = sanitize(headers["X-Request-ID"])

    fun fromErrorJson(body: String?): String? {
        if (body.isNullOrBlank()) return null
        val candidate = JSON_FIELD.find(body)?.groupValues?.getOrNull(1)
        return sanitize(candidate)
    }
}
