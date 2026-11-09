package com.example.ui

import com.example.core.auth.OwnerRecoveryDeepLink
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
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class OwnerRecoveryControllerTest {

    private val placeholderToken = "e6tok_" + "B".repeat(40)

    @Test
    fun `forgot form retains company code and shows generic accepted`() = runTest {
        val repo = FakeOwnerAuthRepository()
        val controller = OwnerRecoveryController(repo, backgroundScope)
        controller.openForgot("cmp-demo")
        controller.onForgotEmailChange("owner@example.test")
        controller.submitForgot()
        runCurrent()

        val accepted = controller.forgotState.value as OwnerForgotUiState.Accepted
        assertEquals("CMP-DEMO", accepted.companyCode)
        assertEquals(1, repo.initiateCalls)
        assertEquals("CMP-DEMO", repo.lastInitiate?.companyCode)
    }

    @Test
    fun `deep link token stays in memory only and clears after success`() = runTest {
        val repo = FakeOwnerAuthRepository()
        val controller = OwnerRecoveryController(repo, backgroundScope)
        controller.openReset(
            companyCode = "CMP-DEMO",
            tokenFromDeepLink = placeholderToken
        )
        assertTrue(controller.hasInMemoryToken())
        assertEquals(placeholderToken, controller.peekTokenForTests())

        val form = controller.resetState.value as OwnerResetUiState.Form
        assertFalse(form.requiresManualToken)

        controller.submitReset("NewSecurePass1", "NewSecurePass1")
        runCurrent()

        assertTrue(controller.resetState.value is OwnerResetUiState.Completed)
        assertNull(controller.peekTokenForTests())
        assertEquals(1, repo.confirmCalls)
        assertEquals(1, repo.clearLocalCalls)
        assertNull(repo.lastSessionIssued)
    }

    @Test
    fun `invalid deep link falls back to manual token entry`() = runTest {
        val controller = OwnerRecoveryController(FakeOwnerAuthRepository(), backgroundScope)
        controller.openReset(
            companyCode = "CMP-DEMO",
            tokenFromDeepLink = "short",
            deepLinkRejected = true
        )
        val form = controller.resetState.value as OwnerResetUiState.Form
        assertTrue(form.requiresManualToken)
        assertTrue(form.deepLinkRejected)
        assertNull(controller.peekTokenForTests())
    }

    @Test
    fun `confirm failure clears token and maps invalid key`() = runTest {
        val repo = FakeOwnerAuthRepository().apply {
            confirmResult = AppResult.Error(
                Exception(OwnerRecoveryDeepLink.MESSAGE_KEY_INVALID),
                AppError.ValidationError(OwnerRecoveryDeepLink.MESSAGE_KEY_INVALID)
            )
        }
        val controller = OwnerRecoveryController(repo, backgroundScope)
        controller.openReset(companyCode = null, tokenFromDeepLink = placeholderToken)
        controller.submitReset("NewSecurePass1", "NewSecurePass1")
        runCurrent()

        val form = controller.resetState.value as OwnerResetUiState.Form
        assertEquals(OwnerRecoveryDeepLink.MESSAGE_KEY_INVALID, form.errorMessageKey)
        assertTrue(form.requiresManualToken)
        assertNull(controller.peekTokenForTests())
    }

    @Test
    fun `reset does not auto login`() = runTest {
        val repo = FakeOwnerAuthRepository()
        val controller = OwnerRecoveryController(repo, backgroundScope)
        controller.onManualTokenChange(placeholderToken)
        controller.submitReset("NewSecurePass1", "NewSecurePass1")
        runCurrent()
        assertTrue(controller.resetState.value is OwnerResetUiState.Completed)
        assertNull(repo.lastSessionIssued)
        assertTrue(repo.clearLocalCalls >= 1)
    }

    private class FakeOwnerAuthRepository : AuthRepository {
        var initiateCalls = 0
        var confirmCalls = 0
        var clearLocalCalls = 0
        var lastInitiate: OwnerRecoveryInitiateRequest? = null
        var lastConfirm: OwnerRecoveryConfirmRequest? = null
        var lastSessionIssued: CurrentSession? = null
        var confirmResult: AppResult<OwnerRecoveryConfirmResult> = AppResult.Success(
            OwnerRecoveryConfirmResult("recovery_complete", "req-ok")
        )
        private val session = MutableStateFlow<CurrentSession?>(null)

        override suspend fun login(
            companyCode: String,
            identifier: String,
            password: String
        ): AppResult<AuthLoginResult> = error("unused")

        override suspend fun startMfaEnrollment(challengeToken: String) = error("unused")
        override suspend fun confirmMfaEnrollment(challengeToken: String, code: String) = error("unused")
        override suspend fun verifyMfa(challengeToken: String, code: String) = error("unused")

        override suspend fun initiateOwnerRecovery(
            request: OwnerRecoveryInitiateRequest
        ): AppResult<OwnerRecoveryInitiateResult> {
            initiateCalls += 1
            lastInitiate = request
            return AppResult.Success(
                OwnerRecoveryInitiateResult("if_owner_account_exists_instructions_sent", "req-1")
            )
        }

        override suspend fun confirmOwnerRecovery(
            request: OwnerRecoveryConfirmRequest
        ): AppResult<OwnerRecoveryConfirmResult> {
            confirmCalls += 1
            lastConfirm = request
            // Intentionally do not set a session — recovery must not auto-login.
            return confirmResult
        }

        override suspend fun logout(): AppResult<Unit> {
            session.value = null
            return AppResult.Success(Unit)
        }

        override fun clearLocalSessions() {
            clearLocalCalls += 1
            session.value = null
        }

        override fun observeCurrentSession(): Flow<CurrentSession?> = session
        override fun observeRememberedSession(): Flow<CurrentSession?> = session
        override fun unlockRememberedSession(companyCode: String) = error("unused")
    }
}
