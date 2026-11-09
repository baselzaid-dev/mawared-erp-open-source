package com.example.ui

import com.example.core.utils.AppResult
import com.example.data.repository.mock.MockSessionRepository
import com.example.domain.model.RevokeAllSessionsRequest
import com.example.domain.model.RevokeAllSessionsResult
import com.example.domain.model.SessionSummary
import com.example.domain.repository.SessionRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SessionListControllerTest {
    @Test
    fun `load shows sessions from repository`() = runTest {
        val repository = MockSessionRepository()
        val controller = SessionListController(repository, backgroundScope)

        controller.load()
        runCurrent()

        val content = controller.state.value as SessionListUiState.Content
        assertEquals(3, content.sessions.size)
        assertTrue(content.sessions.any { it.isCurrent })
    }

    @Test
    fun `revoke success refreshes from server`() = runTest {
        val repository = MockSessionRepository()
        val controller = SessionListController(repository, backgroundScope)

        controller.load()
        runCurrent()
        controller.onRevokeSession("session-tablet-1")
        runCurrent()

        assertEquals("تم إنهاء الجلسة.", controller.feedback.value.successMessage)
        val content = controller.state.value as SessionListUiState.Content
        val revoked = content.sessions.first { it.sessionId == "session-tablet-1" }
        assertTrue(revoked.revokedAt != null)
    }

    @Test
    fun `revoke current session is blocked locally`() = runTest {
        val repository = TrackingSessionRepository()
        val controller = SessionListController(repository, backgroundScope)

        controller.load()
        runCurrent()
        controller.onRevokeSession(MockSessionRepository.CURRENT_SESSION_ID)
        runCurrent()

        assertTrue(controller.feedback.value.errorMessage.orEmpty().contains("الحالية"))
        assertEquals(0, repository.revokeCalls)
    }

    @Test
    fun `revoke all others refreshes list`() = runTest {
        val repository = MockSessionRepository()
        val controller = SessionListController(repository, backgroundScope)

        controller.load()
        runCurrent()
        controller.onRevokeAllOthers()
        runCurrent()

        assertTrue(controller.feedback.value.successMessage.orEmpty().contains("جلسة"))
        val content = controller.state.value as SessionListUiState.Content
        assertEquals(1, content.sessions.count { it.isActive })
    }

    @Test
    fun `server failure surfaces error without optimistic revoke`() = runTest {
        val repository = TrackingSessionRepository(failLoad = true)
        val controller = SessionListController(repository, backgroundScope)

        controller.load()
        runCurrent()

        val error = controller.state.value as SessionListUiState.Error
        assertTrue(error.message.isNotBlank())
    }

    @Test
    fun `reset clears feedback and loading state`() = runTest {
        val controller = SessionListController(MockSessionRepository(), backgroundScope)
        controller.load()
        runCurrent()
        controller.reset()

        assertEquals(SessionListUiState.Loading, controller.state.value)
        assertNull(controller.feedback.value.successMessage)
    }

    private class TrackingSessionRepository(
        private val failLoad: Boolean = false
    ) : SessionRepository {
        var revokeCalls = 0

        private val sessions = listOf(
            SessionSummary(
                sessionId = MockSessionRepository.CURRENT_SESSION_ID,
                deviceLabel = "Current",
                platform = "android",
                createdAt = "2026-07-19T08:00:00.000Z",
                lastUsedAt = "2026-07-19T12:00:00.000Z",
                revokedAt = null,
                isCurrent = true,
                isLegacyDevice = false
            ),
            SessionSummary(
                sessionId = "session-other",
                deviceLabel = "Other",
                platform = "android",
                createdAt = "2026-07-18T08:00:00.000Z",
                lastUsedAt = "2026-07-18T12:00:00.000Z",
                revokedAt = null,
                isCurrent = false,
                isLegacyDevice = false
            )
        )

        override suspend fun listSessions(): AppResult<List<SessionSummary>> =
            if (failLoad) {
                AppResult.Error(Exception("auth.sessions_load_failed"))
            } else {
                AppResult.Success(sessions)
            }

        override suspend fun revokeSession(sessionId: String): AppResult<Unit> {
            revokeCalls += 1
            return AppResult.Success(Unit)
        }

        override suspend fun revokeAllOtherSessions(
            request: RevokeAllSessionsRequest
        ): AppResult<RevokeAllSessionsResult> =
            AppResult.Success(RevokeAllSessionsResult(revokedCount = 1))
    }
}
