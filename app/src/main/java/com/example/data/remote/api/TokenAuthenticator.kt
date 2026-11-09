package com.example.data.remote.api

import com.example.core.auth.AccessTokenClaimsParser
import com.example.core.session.SessionManager
import okhttp3.Authenticator
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route

/** Result of a successful token-refresh call. */
data class RefreshedTokens(
    val accessToken: String,
    val refreshToken: String?,
    val mustChangePassword: Boolean = false
)

/**
 * OkHttp [Authenticator]: on a 401, tries exactly ONE refresh, then retries
 * the original request exactly ONCE with the new access token.
 *
 * - No infinite loops: a retried request carries [RETRY_HEADER]; if it 401s
 *   again we clear the session and surface the auth-required state.
 * - Thread-safe: concurrent 401s refresh only once (the second thread reuses
 *   the token the first thread obtained).
 * - The actual network call is injected ([refreshCall]) so this logic is unit
 *   testable without a server. The callable must NEVER log the tokens.
 * - A successful refresh soft-updates authorizationVersion/permissions from the
 *   new access-token claims without clearing company-scoped UI state.
 */
class TokenAuthenticator(
    private val sessionManager: SessionManager,
    private val refreshCall: (refreshToken: String) -> RefreshedTokens?
) : Authenticator {

    private val lock = Any()

    override fun authenticate(route: Route?, response: Response): Request? {
        // Already retried once with a fresh token and still 401 → give up.
        if (response.request.header(RETRY_HEADER) != null) {
            sessionManager.clearSession()
            return null
        }

        val session = sessionManager.currentSession.value ?: return null
        val refreshToken = session.refreshToken
        if (refreshToken.isNullOrBlank()) {
            // No refresh token (e.g. demo/local session) → clean logout state.
            sessionManager.clearSession()
            return null
        }

        synchronized(lock) {
            val latest = sessionManager.currentSession.value ?: return null

            // Another thread may have refreshed while we waited on the lock.
            val sentAuth = response.request.header("Authorization")
            val latestAuth = latest.token?.let { "Bearer $it" }
            if (latestAuth != null && latestAuth != sentAuth) {
                return response.request.newBuilder()
                    .header("Authorization", latestAuth)
                    .header(RETRY_HEADER, "1")
                    .build()
            }

            val currentRefreshToken = latest.refreshToken ?: return null
            val refreshed = try {
                refreshCall(currentRefreshToken)
            } catch (e: Exception) {
                null
            }
            if (refreshed == null) {
                // Refresh failed (expired/revoked): clear session → auth-required.
                sessionManager.clearSession()
                return null
            }

            val claims = AccessTokenClaimsParser.parse(refreshed.accessToken)
            // Distinguish:
            // 1) valid empty effective permissions → apply (clear stale client grants)
            // 2) malformed/unparseable claims → keep previous (only explicit parse fallback)
            // 3) stale/lower authorizationVersion → keep previous session auth state
            // 4) valid newer (or equal) non-empty permissions → replace
            // Backend refresh must continue issuing loadAuthorizationContext.flatPermissions
            // so Primary Owner keeps effective non-empty claims (AI 401 regression).
            val nextPermissions = when {
                claims == null -> latest.permissions
                claims.authorizationVersion < latest.authorizationVersion -> latest.permissions
                else -> claims.permissions
            }
            val nextAuthorizationVersion = when {
                claims == null -> latest.authorizationVersion
                claims.authorizationVersion < latest.authorizationVersion ->
                    latest.authorizationVersion
                else -> claims.authorizationVersion
            }
            sessionManager.updateSession(
                latest.copy(
                    token = refreshed.accessToken,
                    refreshToken = refreshed.refreshToken ?: latest.refreshToken,
                    permissions = nextPermissions,
                    authorizationVersion = nextAuthorizationVersion,
                    mustChangePassword = refreshed.mustChangePassword
                )
            )

            return response.request.newBuilder()
                .header("Authorization", "Bearer ${refreshed.accessToken}")
                .header(RETRY_HEADER, "1")
                .build()
        }
    }

    companion object {
        /** Marker so a retried request is never retried again. */
        const val RETRY_HEADER = "X-Auth-Retry"
    }
}
