package com.example.data.remote.api

import com.example.core.session.SessionManager
import okhttp3.Interceptor
import okhttp3.Response

/**
 * Synchronizes the server's forced-password gate into the encrypted Android
 * session. The backend remains authoritative; this only prevents stale local
 * state from rendering the normal app after biometric/session restoration.
 */
class PasswordChangeRequiredInterceptor(
    private val sessionManager: SessionManager
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        if (response.code != 403) return response

        val payload = response.peekBody(MAX_ERROR_BODY_BYTES).string()
        val forced = PASSWORD_CHANGE_CODE_PATTERN.containsMatchIn(payload) ||
            PASSWORD_CHANGE_KEY_PATTERN.containsMatchIn(payload)
        if (!forced) return response

        val current = sessionManager.currentSession.value
        if (current != null && !current.mustChangePassword) {
            sessionManager.updateSession(current.copy(mustChangePassword = true))
        }
        return response
    }

    private companion object {
        const val MAX_ERROR_BODY_BYTES = 64L * 1024L
        val PASSWORD_CHANGE_CODE_PATTERN =
            Regex(""""code"\s*:\s*"PasswordChangeRequired"""")
        val PASSWORD_CHANGE_KEY_PATTERN =
            Regex(""""messageKey"\s*:\s*"auth\.password_change_required"""")
    }
}
