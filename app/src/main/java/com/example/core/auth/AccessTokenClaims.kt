package com.example.core.auth

/**
 * Reads unsigned JWT access-token claims that Mawared already trusts after a
 * successful login or refresh response. This does not verify signatures; the
 * Backend remains the authority for every protected request.
 */
data class AccessTokenClaims(
    val authorizationVersion: Int,
    val permissions: Set<String>
)

object AccessTokenClaimsParser {
    private val versionPattern = Regex("\"authorizationVersion\"\\s*:\\s*(-?\\d+)")
    private val permissionsArrayPattern = Regex("\"permissions\"\\s*:\\s*\\[(.*?)]", RegexOption.DOT_MATCHES_ALL)
    private val permissionItemPattern = Regex("\"([^\"]+)\"")

    fun parse(accessToken: String?): AccessTokenClaims? {
        if (accessToken.isNullOrBlank()) return null
        val parts = accessToken.split('.')
        if (parts.size < 2) return null
        return try {
            val payload = decodeJwtSegment(parts[1])
            val versionMatch = versionPattern.find(payload) ?: return null
            val version = versionMatch.groupValues[1].toIntOrNull() ?: return null
            if (version < 0) return null
            // Fail-closed: a missing permissions array is malformed, not "empty grants".
            val permissionsArray = permissionsArrayPattern.find(payload) ?: return null
            AccessTokenClaims(
                authorizationVersion = version,
                permissions = readPermissionsArray(permissionsArray.groupValues[1])
            )
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Base64URL decode without `java.util.Base64` (NewApi on minSdk 24) and
     * without `android.util.Base64` (null stubs in plain JVM unit tests).
     */
    private fun decodeJwtSegment(segment: String): String {
        val padded = segment + "=".repeat((4 - segment.length % 4) % 4)
        val bytes = decodeBase64Url(padded)
        return String(bytes, Charsets.UTF_8)
    }

    private fun decodeBase64Url(input: String): ByteArray {
        val table = IntArray(128) { -1 }
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        for (i in alphabet.indices) table[alphabet[i].code] = i

        val out = ByteArray(input.length * 3 / 4)
        var outIndex = 0
        var buffer = 0
        var bits = 0
        for (ch in input) {
            if (ch == '=') break
            val value = if (ch.code < 128) table[ch.code] else -1
            if (value < 0) throw IllegalArgumentException("invalid base64url")
            buffer = (buffer shl 6) or value
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out[outIndex++] = ((buffer shr bits) and 0xff).toByte()
            }
        }
        return out.copyOf(outIndex)
    }

    private fun readPermissionsArray(arrayBody: String): Set<String> =
        permissionItemPattern.findAll(arrayBody)
            .map { it.groupValues[1].trim() }
            .filter { it.isNotEmpty() }
            .toSet()
}
