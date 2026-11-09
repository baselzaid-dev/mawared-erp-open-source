package com.example.data.remote.api

import com.example.core.session.SessionManager
import com.example.domain.model.CurrentSession
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class TokenAuthenticatorTest {

    private fun sessionWith(
        token: String? = "old-access",
        refreshToken: String? = "refresh-1",
        permissions: Set<String> = setOf("employees.view"),
        authorizationVersion: Int = 0
    ) = CurrentSession(
        companyId = "1",
        companyCode = "CMP-DEMO",
        companyName = "Mawared Demo",
        userId = "u1",
        employeeId = "e1",
        roleId = "r1",
        departmentId = null,
        permissions = permissions,
        token = token,
        refreshToken = refreshToken,
        authorizationVersion = authorizationVersion
    )

    private fun request(auth: String? = "Bearer old-access", retried: Boolean = false): Request {
        val builder = Request.Builder().url("http://10.0.2.2:3000/api/employees")
        if (auth != null) builder.header("Authorization", auth)
        if (retried) builder.header(TokenAuthenticator.RETRY_HEADER, "1")
        return builder.build()
    }

    private fun unauthorized(request: Request): Response = Response.Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(401)
        .message("Unauthorized")
        .build()

    private fun jwt(payloadJson: String): String {
        val header = Base64.getUrlEncoder().withoutPadding()
            .encodeToString("""{"alg":"none"}""".toByteArray())
        val payload = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(payloadJson.toByteArray())
        return "$header.$payload.sig"
    }

    @Test
    fun `401 refreshes once and retries with the new access token`() {
        val manager = SessionManager()
        manager.updateSession(sessionWith())
        var refreshCalls = 0
        val authenticator = TokenAuthenticator(manager) { refreshToken ->
            refreshCalls++
            assertEquals("refresh-1", refreshToken)
            RefreshedTokens("new-access", "refresh-2")
        }

        val retry = authenticator.authenticate(null, unauthorized(request()))

        assertEquals(1, refreshCalls)
        assertEquals("Bearer new-access", retry?.header("Authorization"))
        assertEquals("1", retry?.header(TokenAuthenticator.RETRY_HEADER))
        assertEquals("new-access", manager.currentSession.value?.token)
        assertEquals("refresh-2", manager.currentSession.value?.refreshToken)
    }

    @Test
    fun `successful refresh soft updates authorizationVersion and permissions from claims`() {
        val manager = SessionManager()
        manager.updateSession(sessionWith(permissions = setOf("employees.view"), authorizationVersion = 1))
        val accessToken = jwt("""{"authorizationVersion":5,"permissions":["employees.view","hr.manage"]}""")
        val authenticator = TokenAuthenticator(manager) {
            RefreshedTokens(accessToken, "refresh-2")
        }

        authenticator.authenticate(null, unauthorized(request()))

        val session = manager.currentSession.value
        assertEquals(5, session?.authorizationVersion)
        assertEquals(setOf("employees.view", "hr.manage"), session?.permissions)
        assertEquals(accessToken, session?.token)
    }

    @Test
    fun `valid newer empty claim clears old permissions`() {
        val manager = SessionManager()
        manager.updateSession(sessionWith(permissions = setOf("admin.full", "chat.view"), authorizationVersion = 2))
        val accessToken = jwt("""{"authorizationVersion":3,"permissions":[]}""")
        val authenticator = TokenAuthenticator(manager) {
            RefreshedTokens(accessToken, "refresh-3")
        }

        authenticator.authenticate(null, unauthorized(request()))

        val session = manager.currentSession.value
        assertEquals(3, session?.authorizationVersion)
        assertEquals(emptySet<String>(), session?.permissions)
    }

    @Test
    fun `valid newer non-empty claim replaces old permissions`() {
        val manager = SessionManager()
        manager.updateSession(sessionWith(permissions = setOf("employees.view"), authorizationVersion = 1))
        val accessToken = jwt("""{"authorizationVersion":4,"permissions":["admin.full","chat.view"]}""")
        val authenticator = TokenAuthenticator(manager) {
            RefreshedTokens(accessToken, "refresh-4")
        }

        authenticator.authenticate(null, unauthorized(request()))

        val session = manager.currentSession.value
        assertEquals(4, session?.authorizationVersion)
        assertEquals(setOf("admin.full", "chat.view"), session?.permissions)
    }

    @Test
    fun `Primary Owner refresh keeps navigation when backend returns effective non-empty claims`() {
        val manager = SessionManager()
        manager.updateSession(
            sessionWith(permissions = setOf("admin.full", "chat.view"), authorizationVersion = 7)
        )
        // Mirrors Backend loadAuthorizationContext.flatPermissions for Primary Owner.
        val accessToken = jwt(
            """{"authorizationVersion":8,"permissions":["admin.full","chat.view","employees.view"]}"""
        )
        val authenticator = TokenAuthenticator(manager) {
            RefreshedTokens(accessToken, "refresh-owner")
        }

        authenticator.authenticate(null, unauthorized(request()))

        val session = manager.currentSession.value
        assertEquals(8, session?.authorizationVersion)
        assertTrue(session!!.permissions.contains("admin.full"))
        assertTrue(session.permissions.contains("chat.view"))
    }

    @Test
    fun `AI 401 refresh does not collapse permissions when backend returns correct effective claims`() {
        val manager = SessionManager()
        manager.updateSession(
            sessionWith(
                permissions = setOf("admin.full", "chat.view", "ai.assistant"),
                authorizationVersion = 4
            )
        )
        val accessToken = jwt(
            """{"authorizationVersion":5,"permissions":["admin.full","chat.view","ai.assistant"]}"""
        )
        val authenticator = TokenAuthenticator(manager) {
            RefreshedTokens(accessToken, "refresh-ai")
        }

        authenticator.authenticate(null, unauthorized(request()))

        assertEquals(
            setOf("admin.full", "chat.view", "ai.assistant"),
            manager.currentSession.value?.permissions
        )
    }

    @Test
    fun `malformed claims do not silently escalate or wipe via empty fallback privilege`() {
        val manager = SessionManager()
        manager.updateSession(
            sessionWith(permissions = setOf("employees.view"), authorizationVersion = 3)
        )
        // Missing permissions array → unparseable → keep previous (no escalation, no wipe).
        val accessToken = jwt("""{"authorizationVersion":9}""")
        val authenticator = TokenAuthenticator(manager) {
            RefreshedTokens(accessToken, "refresh-bad")
        }

        authenticator.authenticate(null, unauthorized(request()))

        val session = manager.currentSession.value
        assertEquals(3, session?.authorizationVersion)
        assertEquals(setOf("employees.view"), session?.permissions)
        assertEquals(accessToken, session?.token)
    }

    @Test
    fun `stale authorization-version claims cannot overwrite newer session state`() {
        val manager = SessionManager()
        manager.updateSession(
            sessionWith(permissions = setOf("admin.full"), authorizationVersion = 10)
        )
        val accessToken = jwt("""{"authorizationVersion":2,"permissions":["employees.view"]}""")
        val authenticator = TokenAuthenticator(manager) {
            RefreshedTokens(accessToken, "refresh-stale")
        }

        authenticator.authenticate(null, unauthorized(request()))

        val session = manager.currentSession.value
        assertEquals(10, session?.authorizationVersion)
        assertEquals(setOf("admin.full"), session?.permissions)
    }

    @Test
    fun `successful refresh synchronizes the forced-password gate`() {
        val manager = SessionManager()
        manager.updateSession(sessionWith())
        val authenticator = TokenAuthenticator(manager) {
            RefreshedTokens("new-access", "refresh-2", mustChangePassword = true)
        }

        authenticator.authenticate(null, unauthorized(request()))

        assertEquals(true, manager.currentSession.value?.mustChangePassword)
        assertEquals(true, manager.rememberedSession.value?.mustChangePassword)
    }

    @Test
    fun `failed refresh clears the session and gives up`() {
        val manager = SessionManager()
        manager.updateSession(sessionWith())
        val authenticator = TokenAuthenticator(manager) { null }

        val retry = authenticator.authenticate(null, unauthorized(request()))

        assertNull(retry)
        assertNull("failed refresh must surface the auth-required state", manager.currentSession.value)
    }

    @Test
    fun `a request that was already retried is never retried again - no infinite loop`() {
        val manager = SessionManager()
        manager.updateSession(sessionWith())
        var refreshCalls = 0
        val authenticator = TokenAuthenticator(manager) {
            refreshCalls++
            RefreshedTokens("new-access", "refresh-2")
        }

        val retry = authenticator.authenticate(
            null,
            unauthorized(request(auth = "Bearer new-access", retried = true))
        )

        assertNull(retry)
        assertEquals("no second refresh attempt", 0, refreshCalls)
        assertNull(manager.currentSession.value)
    }

    @Test
    fun `no refresh token means clean logout instead of a retry loop`() {
        val manager = SessionManager()
        manager.updateSession(sessionWith(refreshToken = null))
        var refreshCalls = 0
        val authenticator = TokenAuthenticator(manager) {
            refreshCalls++
            RefreshedTokens("x", "y")
        }

        val retry = authenticator.authenticate(null, unauthorized(request()))

        assertNull(retry)
        assertEquals(0, refreshCalls)
        assertNull(manager.currentSession.value)
    }

    @Test
    fun `no session at all means no retry`() {
        val manager = SessionManager()
        val authenticator = TokenAuthenticator(manager) { RefreshedTokens("x", "y") }
        assertNull(authenticator.authenticate(null, unauthorized(request(auth = null))))
    }

    @Test
    fun `reuses a token refreshed by another thread instead of refreshing again`() {
        val manager = SessionManager()
        manager.updateSession(sessionWith(token = "already-new-access"))
        var refreshCalls = 0
        val authenticator = TokenAuthenticator(manager) {
            refreshCalls++
            RefreshedTokens("even-newer", "r")
        }

        val retry = authenticator.authenticate(null, unauthorized(request(auth = "Bearer old-access")))

        assertEquals(0, refreshCalls)
        assertEquals("Bearer already-new-access", retry?.header("Authorization"))
    }
}
