package com.example.data.repository.mock

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.domain.model.RevokeAllSessionsRequest
import com.example.domain.model.RevokeAllSessionsResult
import com.example.domain.model.SessionSummary
import com.example.domain.repository.SessionRepository

class MockSessionRepository : SessionRepository {
    private val sessions = mutableListOf(
        SessionSummary(
            sessionId = CURRENT_SESSION_ID,
            deviceLabel = "هاتف Android الحالي",
            platform = "android",
            createdAt = "2026-07-19T08:00:00.000Z",
            lastUsedAt = "2026-07-19T12:00:00.000Z",
            revokedAt = null,
            isCurrent = true,
            isLegacyDevice = false
        ),
        SessionSummary(
            sessionId = "session-tablet-1",
            deviceLabel = "جهاز لوحي",
            platform = "android",
            createdAt = "2026-07-18T10:00:00.000Z",
            lastUsedAt = "2026-07-18T18:30:00.000Z",
            revokedAt = null,
            isCurrent = false,
            isLegacyDevice = false
        ),
        SessionSummary(
            sessionId = "session-legacy-1",
            deviceLabel = null,
            platform = null,
            createdAt = "2026-07-10T09:00:00.000Z",
            lastUsedAt = "2026-07-12T11:00:00.000Z",
            revokedAt = "2026-07-12T12:00:00.000Z",
            isCurrent = false,
            isLegacyDevice = true
        )
    )

    override suspend fun listSessions(): AppResult<List<SessionSummary>> =
        AppResult.Success(sessions.toList())

    override suspend fun revokeSession(sessionId: String): AppResult<Unit> {
        val index = sessions.indexOfFirst { it.sessionId == sessionId }
        if (index < 0) {
            return AppResult.Error(
                Exception("auth.session_not_found"),
                AppError.ValidationError("auth.session_not_found")
            )
        }
        val target = sessions[index]
        if (target.isCurrent) {
            return AppResult.Error(
                Exception("auth.session_revoke_current_forbidden"),
                AppError.ValidationError("auth.session_revoke_current_forbidden")
            )
        }
        if (target.isActive) {
            sessions[index] = target.copy(revokedAt = "2026-07-19T13:00:00.000Z")
        }
        return AppResult.Success(Unit)
    }

    override suspend fun revokeAllOtherSessions(
        request: RevokeAllSessionsRequest
    ): AppResult<RevokeAllSessionsResult> {
        var revokedCount = 0
        sessions.replaceAll { session ->
            val shouldRevoke = session.isActive &&
                (!request.exceptCurrent || !session.isCurrent)
            if (shouldRevoke) {
                revokedCount += 1
                session.copy(revokedAt = "2026-07-19T13:05:00.000Z")
            } else {
                session
            }
        }
        return AppResult.Success(RevokeAllSessionsResult(revokedCount = revokedCount))
    }

    companion object {
        const val CURRENT_SESSION_ID = "session-current-1"
    }
}
