package com.example.data.remote.repository

import com.example.core.network.ApiErrorSupport
import com.example.core.session.SessionManager
import com.example.core.auth.CompanyLoginRules
import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.domain.model.AuthLoginResult
import com.example.domain.model.CurrentSession
import com.example.domain.model.MfaAuthenticationResult
import com.example.domain.model.MfaEnrollment
import com.example.domain.model.OwnerRecoveryConfirmRequest
import com.example.domain.model.OwnerRecoveryConfirmResult
import com.example.domain.model.OwnerRecoveryInitiateRequest
import com.example.domain.model.OwnerRecoveryInitiateResult
import com.example.domain.repository.AuthRepository
import com.example.data.remote.api.AuthApi
import com.example.data.remote.api.LoginRequestDto
import com.example.data.remote.api.LogoutRequestDto
import com.example.data.remote.api.LoginResponseDto
import com.example.data.remote.api.MfaChallengeRequestDto
import com.example.data.remote.api.MfaVerifyRequestDto
import com.example.data.remote.api.OwnerRecoveryConfirmRequestDto
import com.example.data.remote.api.OwnerRecoveryInitiateRequestDto
import com.example.core.auth.OwnerRecoveryDeepLink
import com.example.core.auth.OwnerRecoveryTokenRules
import com.example.core.auth.PasswordPolicy
import kotlinx.coroutines.flow.Flow
import retrofit2.Response

class ApiAuthRepository(
    private val sessionManager: SessionManager,
    private val authApi: AuthApi
) : AuthRepository {

    override suspend fun login(
        companyCode: String,
        identifier: String,
        password: String
    ): AppResult<AuthLoginResult> {
        return try {
            val normalizedCompanyCode = CompanyLoginRules.normalizeCompanyCode(companyCode)
            val response = authApi.login(LoginRequestDto(normalizedCompanyCode, identifier.trim(), password))
            if (response.isSuccessful && response.body() != null) {
                val body = response.body()!!
                val user = body.user
                val company = body.company
                if (user.companyId != company.id ||
                    CompanyLoginRules.normalizeCompanyCode(company.code) != normalizedCompanyCode
                ) {
                    return AppResult.Error(
                        IllegalStateException("Invalid company binding in login response"),
                        AppError.ServerError(500, "Invalid login response")
                    )
                }

                if (body.mfaRequired && !body.challengeToken.isNullOrBlank()) {
                    AppResult.Success(
                        AuthLoginResult.MfaChallenge(
                            challengeToken = body.challengeToken,
                            enrollmentRequired = body.enrollmentRequired,
                            expiresAt = body.expiresAt.orEmpty(),
                            companyCode = CompanyLoginRules.normalizeCompanyCode(company.code),
                            companyName = company.name,
                            email = user.email,
                            name = user.name,
                            role = user.roleName ?: user.oldRole ?: ""
                        )
                    )
                } else {
                    val session = sessionFrom(body)
                        ?: return AppResult.Error(
                            IllegalStateException("Login response omitted access token"),
                            AppError.ServerError(500, "Invalid login response")
                        )
                    sessionManager.updateSession(session)
                    AppResult.Success(AuthLoginResult.Authenticated(session))
                }
            } else {
                // Preserve the HTTP status code so the UI can distinguish an
                // authentication failure (400/401) from a real server/network
                // problem. Prefer the backend's Arabic "message" then "error".
                val rawBody = try {
                    response.errorBody()?.string().orEmpty()
                } catch (_: Exception) {
                    ""
                }
                val serverMessage = rawBody.takeIf { it.isNotBlank() }?.let { body ->
                    Regex("\"message\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
                        ?: Regex("\"error\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
                }
                val supportRequestId = ApiErrorSupport.extractSupportRequestId(response, rawBody)
                val safeMessage = ApiErrorSupport.sanitizeUserMessage(
                    serverMessage,
                    "بيانات الدخول غير صحيحة",
                    response.code(),
                )
                AppResult.Error(
                    Exception("Login failed: ${response.code()}"),
                    when (response.code()) {
                        401 -> AppError.Unauthorized
                        403 -> AppError.Forbidden
                        in 500..599 -> ApiErrorSupport.serverError(
                            response.code(),
                            "حدث خطأ في الخادم. حاول مرة أخرى لاحقاً.",
                            supportRequestId,
                        )
                        else -> AppError.ServerError(response.code(), safeMessage, supportRequestId = null)
                    }
                )
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun startMfaEnrollment(
        challengeToken: String
    ): AppResult<MfaEnrollment> = try {
        val response = authApi.startMfaEnrollment(MfaChallengeRequestDto(challengeToken))
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(
                MfaEnrollment(
                    manualSecret = body.manualSecret,
                    otpauthUri = body.otpauthUri,
                    expiresAt = body.expiresAt
                )
            )
        } else mfaError(response)
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun confirmMfaEnrollment(
        challengeToken: String,
        code: String
    ): AppResult<MfaAuthenticationResult> = completeMfa {
        authApi.confirmMfaEnrollment(MfaVerifyRequestDto(challengeToken, code.trim()))
    }

    override suspend fun verifyMfa(
        challengeToken: String,
        code: String
    ): AppResult<MfaAuthenticationResult> = completeMfa {
        authApi.verifyMfa(MfaVerifyRequestDto(challengeToken, code.trim()))
    }

    private suspend fun completeMfa(
        call: suspend () -> Response<LoginResponseDto>
    ): AppResult<MfaAuthenticationResult> = try {
        val response = call()
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val session = sessionFrom(body)
                ?: return AppResult.Error(
                    IllegalStateException("MFA response omitted access token"),
                    AppError.ServerError(500, "Invalid MFA response")
                )
            sessionManager.updateSession(session)
            AppResult.Success(MfaAuthenticationResult(session, body.backupCodes))
        } else mfaError(response)
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    private fun sessionFrom(body: LoginResponseDto): CurrentSession? {
        val accessToken = body.accessToken ?: return null
        val user = body.user
        val company = body.company
        val claims = com.example.core.auth.AccessTokenClaimsParser.parse(accessToken)
        return CurrentSession(
            companyId = company.id,
            companyCode = CompanyLoginRules.normalizeCompanyCode(company.code),
            companyName = company.name,
            userId = user.id,
            employeeId = user.employeeId,
            roleId = user.roleId,
            departmentId = null,
            permissions = user.permissions.toSet(),
            token = accessToken,
            refreshToken = body.refreshToken,
            email = user.email,
            name = user.name,
            role = user.roleName ?: user.oldRole ?: "",
            authorizationVersion = claims?.authorizationVersion ?: 0,
            mustChangePassword = user.mustChangePassword,
            mfaProtected = user.mfaRequired,
            mfaVerifiedAt = body.mfaVerifiedAt
        )
    }

    private fun <T> mfaError(response: Response<*>): AppResult<T> {
        val raw = runCatching { response.errorBody()?.string().orEmpty() }.getOrDefault("")
        val messageKey = Regex("\"messageKey\"\\s*:\\s*\"([^\"]+)\"")
            .find(raw)?.groupValues?.getOrNull(1)
        val appError = ApiErrorSupport.mapHttpFailure(
            response,
            fallback = messageKey ?: "تعذر إكمال التحقق.",
            parsedMessage = messageKey,
        )
        return AppResult.Error(
            Exception(messageKey ?: "MFA request failed"),
            appError,
        )
    }

    override suspend fun initiateOwnerRecovery(
        request: OwnerRecoveryInitiateRequest
    ): AppResult<OwnerRecoveryInitiateResult> = try {
        val normalizedCompany = CompanyLoginRules.normalizeCompanyCode(request.companyCode)
        val email = request.ownerEmail.trim()
        // Always surface the generic accepted contract to the UI — including local
        // validation failures — so the client never enumerates owner accounts.
        val response = authApi.initiateOwnerRecovery(
            OwnerRecoveryInitiateRequestDto(
                companyCode = normalizedCompany,
                ownerEmail = email
            )
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(
                OwnerRecoveryInitiateResult(
                    status = body.status.ifBlank { "if_owner_account_exists_instructions_sent" },
                    requestId = body.requestId
                )
            )
        } else {
            // Backend still returns 202 for most soft failures; map hard transport
            // failures to the same generic accepted shape where possible.
            AppResult.Success(
                OwnerRecoveryInitiateResult(
                    status = "if_owner_account_exists_instructions_sent",
                    requestId = ""
                )
            )
        }
    } catch (_: Exception) {
        AppResult.Success(
            OwnerRecoveryInitiateResult(
                status = "if_owner_account_exists_instructions_sent",
                requestId = ""
            )
        )
    }

    override suspend fun confirmOwnerRecovery(
        request: OwnerRecoveryConfirmRequest
    ): AppResult<OwnerRecoveryConfirmResult> {
        return try {
            val token = request.resetToken.trim()
            val password = request.newPassword
            if (!OwnerRecoveryTokenRules.isValid(token) || !PasswordPolicy.isValid(password)) {
                return AppResult.Error(
                    Exception(OwnerRecoveryDeepLink.MESSAGE_KEY_INVALID),
                    AppError.ValidationError(OwnerRecoveryDeepLink.MESSAGE_KEY_INVALID)
                )
            }
            val response = authApi.confirmOwnerRecovery(
                OwnerRecoveryConfirmRequestDto(
                    resetToken = token,
                    newPassword = password
                )
            )
            val body = response.body()
            if (response.isSuccessful && body != null) {
                // Recovery does not auto-login; drop any stale remembered/biometric session.
                sessionManager.clearSession()
                AppResult.Success(
                    OwnerRecoveryConfirmResult(
                        status = body.status.ifBlank { "recovery_complete" },
                        requestId = body.requestId
                    )
                )
            } else {
                val raw = runCatching { response.errorBody()?.string().orEmpty() }.getOrDefault("")
                val messageKey = Regex("\"messageKey\"\\s*:\\s*\"([^\"]+)\"")
                    .find(raw)?.groupValues?.getOrNull(1)
                    ?: OwnerRecoveryDeepLink.MESSAGE_KEY_INVALID
                AppResult.Error(
                    Exception(messageKey),
                    AppError.ValidationError(messageKey)
                )
            }
        } catch (exception: Exception) {
            AppResult.Error(exception, AppError.NetworkError)
        }
    }

    override suspend fun logout(): AppResult<Unit> {
        // Best-effort server-side revocation of the refresh token; local
        // logout must succeed even when the server is unreachable.
        val refreshToken = sessionManager.currentSession.value?.refreshToken
        if (!refreshToken.isNullOrBlank()) {
            try {
                authApi.logout(LogoutRequestDto(refreshToken))
            } catch (e: Exception) {
                // Offline logout: token expires server-side at its TTL.
            }
        }
        sessionManager.clearSession()
        return AppResult.Success(Unit)
    }

    override fun clearLocalSessions() {
        sessionManager.clearSession()
    }

    override fun observeCurrentSession(): Flow<CurrentSession?> {
        return sessionManager.currentSession
    }

    override fun observeRememberedSession(): Flow<CurrentSession?> {
        return sessionManager.rememberedSession
    }

    override fun unlockRememberedSession(companyCode: String): AppResult<CurrentSession> {
        val session = sessionManager.unlockRememberedSession(companyCode)
            ?: return AppResult.Error(AppError.Unauthorized, AppError.Unauthorized)
        return AppResult.Success(session)
    }

    override fun currentSessionOrNull(): CurrentSession? = sessionManager.currentSession.value

    override fun updateAuthorizationSnapshot(
        authorizationVersion: Int,
        permissions: Set<String>
    ): Boolean {
        val current = sessionManager.currentSession.value ?: return false
        if (
            current.authorizationVersion == authorizationVersion &&
            current.permissions == permissions
        ) {
            return false
        }
        sessionManager.updateSession(
            current.copy(
                authorizationVersion = authorizationVersion,
                permissions = permissions
            )
        )
        return true
    }
}
