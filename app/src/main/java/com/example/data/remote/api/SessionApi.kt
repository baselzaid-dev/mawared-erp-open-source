package com.example.data.remote.api

import com.squareup.moshi.JsonClass
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

@JsonClass(generateAdapter = true)
data class SessionSummaryDto(
    val sessionId: String,
    val deviceLabel: String? = null,
    val platform: String? = null,
    val createdAt: String,
    val lastUsedAt: String? = null,
    val revokedAt: String? = null,
    val isCurrent: Boolean = false,
    val isLegacyDevice: Boolean = false
)

@JsonClass(generateAdapter = true)
data class RevokeAllSessionsRequestDto(
    val exceptCurrent: Boolean
)

@JsonClass(generateAdapter = true)
data class RevokeAllSessionsResultDto(
    val revokedCount: Int
)

@JsonClass(generateAdapter = true)
data class SessionErrorResponseDto(
    val messageKey: String? = null,
    val message: String? = null,
    val code: String? = null
)

interface SessionApi {
    @GET("/api/v2/auth/sessions")
    suspend fun listSessions(): Response<List<SessionSummaryDto>>

    @DELETE("/api/v2/auth/sessions/{sessionId}")
    suspend fun revokeSession(
        @Path("sessionId") sessionId: String
    ): Response<Unit>

    @POST("/api/v2/auth/sessions/revoke-all")
    suspend fun revokeAllSessions(
        @Body request: RevokeAllSessionsRequestDto
    ): Response<RevokeAllSessionsResultDto>
}
