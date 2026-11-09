package com.example.data.remote.repository

import com.example.core.session.SessionManager
import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.domain.model.AuthLoginResult
import com.example.data.remote.api.AuthApi
import com.example.data.remote.api.CompanyDto
import com.example.data.remote.api.LoginRequestDto
import com.example.data.remote.api.LoginResponseDto
import com.example.data.remote.api.LogoutRequestDto
import com.example.data.remote.api.MfaChallengeRequestDto
import com.example.data.remote.api.MfaEnrollmentDto
import com.example.data.remote.api.MfaVerifyRequestDto
import com.example.data.remote.api.OwnerRecoveryConfirmRequestDto
import com.example.data.remote.api.OwnerRecoveryConfirmResponseDto
import com.example.data.remote.api.OwnerRecoveryInitiateRequestDto
import com.example.data.remote.api.OwnerRecoveryInitiateResponseDto
import com.example.data.remote.api.RefreshRequestDto
import com.example.data.remote.api.RefreshResponseDto
import com.example.data.remote.api.UserDto
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

private class FakeAuthApi(
    var loginResult: () -> Response<LoginResponseDto> = { Response.success(null!!) },
    var enrollmentResult: () -> Response<MfaEnrollmentDto> = {
        throw UnsupportedOperationException("not used")
    },
    var confirmResult: () -> Response<LoginResponseDto> = {
        throw UnsupportedOperationException("not used")
    },
    var verifyResult: () -> Response<LoginResponseDto> = {
        throw UnsupportedOperationException("not used")
    },
    var initiateOwnerRecoveryResult: () -> Response<OwnerRecoveryInitiateResponseDto> = {
        Response.success(
            OwnerRecoveryInitiateResponseDto(
                status = "if_owner_account_exists_instructions_sent",
                requestId = "req-1"
            )
        )
    },
    var confirmOwnerRecoveryResult: () -> Response<OwnerRecoveryConfirmResponseDto> = {
        Response.success(
            OwnerRecoveryConfirmResponseDto(
                status = "recovery_complete",
                requestId = "req-2"
            )
        )
    },
    var logoutThrows: Boolean = false
) : AuthApi {
    var lastLoginRequest: LoginRequestDto? = null
    var lastLogoutRequest: LogoutRequestDto? = null
    var lastInitiateRequest: OwnerRecoveryInitiateRequestDto? = null
    var lastConfirmRequest: OwnerRecoveryConfirmRequestDto? = null

    override suspend fun login(request: LoginRequestDto): Response<LoginResponseDto> {
        lastLoginRequest = request
        return loginResult()
    }

    override suspend fun initiateOwnerRecovery(
        request: OwnerRecoveryInitiateRequestDto
    ): Response<OwnerRecoveryInitiateResponseDto> {
        lastInitiateRequest = request
        return initiateOwnerRecoveryResult()
    }

    override suspend fun confirmOwnerRecovery(
        request: OwnerRecoveryConfirmRequestDto
    ): Response<OwnerRecoveryConfirmResponseDto> {
        lastConfirmRequest = request
        return confirmOwnerRecoveryResult()
    }

    override suspend fun refresh(request: RefreshRequestDto): Response<RefreshResponseDto> =
        throw UnsupportedOperationException("not used in these tests")

    override suspend fun logout(request: LogoutRequestDto): Response<Map<String, String>> {
        lastLogoutRequest = request
        if (logoutThrows) throw java.io.IOException("server unreachable")
        return Response.success(mapOf("message" to "Logged out"))
    }

    override suspend fun getMe(): Response<UserDto> =
        throw UnsupportedOperationException("not used in these tests")

    override suspend fun startMfaEnrollment(
        request: MfaChallengeRequestDto
    ): Response<MfaEnrollmentDto> = enrollmentResult()

    override suspend fun confirmMfaEnrollment(
        request: MfaVerifyRequestDto
    ): Response<LoginResponseDto> = confirmResult()

    override suspend fun verifyMfa(
        request: MfaVerifyRequestDto
    ): Response<LoginResponseDto> = verifyResult()
}

private fun successBody(
    companyId: String = "c1",
    companyCode: String = "CMP-DEMO"
) = LoginResponseDto(
    accessToken = "access-token-value",
    refreshToken = "refresh-token-value",
    user = UserDto(
        id = "u1",
        companyId = companyId,
        employeeId = "e1",
        name = "Test User",
        email = "user@example.test",
        roleId = "r1",
        roleName = "HR Manager",
        permissions = listOf("employees.view", "leaves.approve")
    ),
    company = CompanyDto(companyId, companyCode, "Mawared Demo")
)

class ApiAuthRepositoryTest {
    @Test
    fun `company-aware login sends canonical fields and stores tenant session`() = runTest {
        val sessionManager = SessionManager()
        val api = FakeAuthApi(loginResult = { Response.success(successBody()) })
        val repo = ApiAuthRepository(sessionManager, api)

        val result = repo.login(" cmp-demo ", " user@example.test ", "test-password")

        assertTrue(result is AppResult.Success)
        assertEquals(LoginRequestDto("CMP-DEMO", "user@example.test", "test-password"), api.lastLoginRequest)
        val session = sessionManager.currentSession.value
        assertEquals("c1", session?.companyId)
        assertEquals("CMP-DEMO", session?.companyCode)
        assertEquals("Mawared Demo", session?.companyName)
        assertEquals("access-token-value", session?.token)
        assertEquals("refresh-token-value", session?.refreshToken)
        assertTrue(session?.permissions?.contains("leaves.approve") == true)
    }

    @Test
    fun `mismatched tenant response is rejected and not persisted`() = runTest {
        val sessionManager = SessionManager()
        val body = successBody().copy(company = CompanyDto("c2", "CMP-DEMO", "Wrong Company"))
        val repo = ApiAuthRepository(
            sessionManager,
            FakeAuthApi(loginResult = { Response.success(body) })
        )

        val result = repo.login("CMP-DEMO", "user@example.test", "test-password")

        assertTrue(result is AppResult.Error)
        assertNull(sessionManager.currentSession.value)
        assertNull(sessionManager.rememberedSession.value)
    }

    @Test
    fun `MFA challenge stores no session and confirmation stores only verified tokens`() = runTest {
        val manager = SessionManager()
        val challengedBody = successBody().copy(
            accessToken = null,
            refreshToken = null,
            mfaRequired = true,
            enrollmentRequired = true,
            challengeToken = "challenge-token-value-that-is-long-enough",
            expiresAt = "2026-07-21T01:00:00.000Z"
        )
        val verifiedBody = successBody().copy(
            mfaRequired = true,
            mfaVerifiedAt = "2026-07-21T00:55:00.000Z",
            backupCodes = listOf("ABCDE-12345"),
            user = successBody().user.copy(mfaRequired = true, mfaEnrolled = true)
        )
        val api = FakeAuthApi(
            loginResult = { Response.success(challengedBody) },
            enrollmentResult = {
                Response.success(
                    MfaEnrollmentDto(
                        manualSecret = "JBSWY3DPEHPK3PXP",
                        otpauthUri = "otpauth://totp/Mawared:test",
                        expiresAt = challengedBody.expiresAt!!
                    )
                )
            },
            confirmResult = { Response.success(verifiedBody) }
        )
        val repo = ApiAuthRepository(manager, api)

        val login = repo.login("CMP-DEMO", "user@example.test", "password")
        assertTrue((login as AppResult.Success).data is AuthLoginResult.MfaChallenge)
        assertNull(manager.currentSession.value)

        val enrollment = repo.startMfaEnrollment(challengedBody.challengeToken!!)
        assertTrue(enrollment is AppResult.Success)
        val confirmed = repo.confirmMfaEnrollment(
            challengedBody.challengeToken,
            "123456"
        )
        assertTrue(confirmed is AppResult.Success)
        assertEquals(listOf("ABCDE-12345"), (confirmed as AppResult.Success).data.backupCodes)
        assertTrue(manager.currentSession.value?.mfaProtected == true)
        assertEquals("2026-07-21T00:55:00.000Z", manager.currentSession.value?.mfaVerifiedAt)
    }

    @Test
    fun `HTTP 401 login preserves status and leaves no session`() = runTest {
        val errorBody = "{\"error\":\"InvalidCredentials\"}"
            .toResponseBody("application/json".toMediaType())
        val repo = ApiAuthRepository(
            SessionManager(),
            FakeAuthApi(loginResult = { Response.error(401, errorBody) })
        )

        val result = repo.login("CMP-DEMO", "user@example.test", "wrong")

        assertTrue(result is AppResult.Error)
        assertEquals(AppError.Unauthorized, (result as AppResult.Error).appError)
    }

    @Test
    fun `HTTP 429 login preserves rate limit response`() = runTest {
        val errorBody = "{\"error\":\"TooManyRequests\",\"message\":\"Try again later\"}"
            .toResponseBody("application/json".toMediaType())
        val repo = ApiAuthRepository(
            SessionManager(),
            FakeAuthApi(loginResult = { Response.error(429, errorBody) })
        )

        val result = repo.login("CMP-DEMO", "user@example.test", "wrong")

        val appError = (result as AppResult.Error).appError as AppError.ServerError
        assertEquals(429, appError.code)
        assertEquals("Try again later", appError.message)
    }

    @Test
    fun `network failure returns an error without a fake session`() = runTest {
        val sessionManager = SessionManager()
        val api = FakeAuthApi(loginResult = { throw java.io.IOException("timeout") })
        val repo = ApiAuthRepository(sessionManager, api)

        val result = repo.login("CMP-DEMO", "user@example.test", "test-password")

        assertTrue(result is AppResult.Error)
        assertNull(sessionManager.currentSession.value)
    }

    @Test
    fun `remembered session unlock is bound to company code`() = runTest {
        val manager = SessionManager()
        val repo = ApiAuthRepository(
            manager,
            FakeAuthApi(loginResult = { Response.success(successBody()) })
        )
        repo.login("CMP-DEMO", "user@example.test", "test-password")
        val coldStart = SessionManager(object : com.example.core.session.SessionStore {
            override fun save(session: com.example.domain.model.CurrentSession) = Unit
            override fun load() = manager.rememberedSession.value
            override fun clear() = Unit
        })
        val coldRepo = ApiAuthRepository(coldStart, FakeAuthApi())

        assertTrue(coldRepo.unlockRememberedSession("CMP-OTHER") is AppResult.Error)
        assertNull(coldStart.currentSession.value)
        assertTrue(coldRepo.unlockRememberedSession("CMP-DEMO") is AppResult.Success)
    }

    @Test
    fun `logout revokes refresh token and clears active and remembered session`() = runTest {
        val sessionManager = SessionManager()
        val api = FakeAuthApi(loginResult = { Response.success(successBody()) })
        val repo = ApiAuthRepository(sessionManager, api)
        repo.login("CMP-DEMO", "user@example.test", "test-password")

        val result = repo.logout()

        assertTrue(result is AppResult.Success)
        assertEquals("refresh-token-value", api.lastLogoutRequest?.refreshToken)
        assertNull(sessionManager.currentSession.value)
        assertNull(sessionManager.rememberedSession.value)
    }

    @Test
    fun `offline logout still clears local session`() = runTest {
        val sessionManager = SessionManager()
        val api = FakeAuthApi(loginResult = { Response.success(successBody()) }, logoutThrows = true)
        val repo = ApiAuthRepository(sessionManager, api)
        repo.login("CMP-DEMO", "user@example.test", "test-password")

        val result = repo.logout()

        assertTrue(result is AppResult.Success)
        assertNull(sessionManager.currentSession.value)
        assertNull(sessionManager.rememberedSession.value)
    }

    @Test
    fun `owner recovery initiate always returns generic accepted`() = runTest {
        val api = FakeAuthApi()
        val repo = ApiAuthRepository(SessionManager(), api)
        val result = repo.initiateOwnerRecovery(
            com.example.domain.model.OwnerRecoveryInitiateRequest("cmp-demo", "owner@example.test")
        )
        assertTrue(result is AppResult.Success)
        val data = (result as AppResult.Success).data
        assertEquals("if_owner_account_exists_instructions_sent", data.status)
        assertEquals("CMP-DEMO", api.lastInitiateRequest?.companyCode)
    }

    @Test
    fun `owner recovery confirm clears session and does not login`() = runTest {
        val sessionManager = SessionManager()
        val api = FakeAuthApi(loginResult = { Response.success(successBody()) })
        val repo = ApiAuthRepository(sessionManager, api)
        repo.login("CMP-DEMO", "user@example.test", "test-password")
        assertTrue(sessionManager.currentSession.value != null)

        val token = "e6tok_" + "C".repeat(40)
        val result = repo.confirmOwnerRecovery(
            com.example.domain.model.OwnerRecoveryConfirmRequest(token, "NewSecurePass1")
        )

        assertTrue(result is AppResult.Success)
        assertEquals("recovery_complete", (result as AppResult.Success).data.status)
        assertNull(sessionManager.currentSession.value)
        assertNull(sessionManager.rememberedSession.value)
        assertEquals(token, api.lastConfirmRequest?.resetToken)
    }

    @Test
    fun `owner recovery confirm maps invalid messageKey`() = runTest {
        val errorBody = """{"code":"InvalidRequest","messageKey":"owner_recovery.invalid_or_expired"}"""
            .toResponseBody("application/json".toMediaType())
        val api = FakeAuthApi(
            confirmOwnerRecoveryResult = { Response.error(400, errorBody) }
        )
        val repo = ApiAuthRepository(SessionManager(), api)
        val token = "e6tok_" + "D".repeat(40)
        val result = repo.confirmOwnerRecovery(
            com.example.domain.model.OwnerRecoveryConfirmRequest(token, "NewSecurePass1")
        )
        assertTrue(result is AppResult.Error)
        assertEquals(
            "owner_recovery.invalid_or_expired",
            (result as AppResult.Error).exception.message
        )
    }
}
