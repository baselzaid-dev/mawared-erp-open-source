package com.example.domain.repository

import com.example.core.utils.AppResult
import com.example.domain.model.RevokeAllSessionsRequest
import com.example.domain.model.RevokeAllSessionsResult
import com.example.domain.model.SessionSummary

interface SessionRepository {
    suspend fun listSessions(): AppResult<List<SessionSummary>>

    suspend fun revokeSession(sessionId: String): AppResult<Unit>

    suspend fun revokeAllOtherSessions(
        request: RevokeAllSessionsRequest = RevokeAllSessionsRequest(exceptCurrent = true)
    ): AppResult<RevokeAllSessionsResult>
}
