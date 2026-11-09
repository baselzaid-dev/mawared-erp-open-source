package com.example.data.remote.repository

import com.example.core.network.ApiErrorSupport
import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.RevokeAllSessionsRequestDto
import com.example.data.remote.api.SessionApi
import com.example.data.remote.api.SessionErrorResponseDto
import com.example.data.remote.api.SessionSummaryDto
import com.example.domain.model.RevokeAllSessionsRequest
import com.example.domain.model.RevokeAllSessionsResult
import com.example.domain.model.SessionSummary
import com.example.domain.repository.SessionRepository
import com.squareup.moshi.Moshi
import retrofit2.Response

class ApiSessionRepository(
    private val api: SessionApi
) : SessionRepository {

    private val errorAdapter = Moshi.Builder().build().adapter(SessionErrorResponseDto::class.java)

    private fun SessionSummaryDto.toDomain() = SessionSummary(
        sessionId = sessionId,
        deviceLabel = deviceLabel,
        platform = platform,
        createdAt = createdAt,
        lastUsedAt = lastUsedAt,
        revokedAt = revokedAt,
        isCurrent = isCurrent,
        isLegacyDevice = isLegacyDevice
    )

    private fun <T> responseError(response: Response<T>, fallback: String): AppResult.Error {
        val rawBody = try {
            response.errorBody()?.string().orEmpty()
        } catch (_: Exception) {
            ""
        }
        val payload = try {
            rawBody.takeIf { it.isNotBlank() }?.let(errorAdapter::fromJson)
        } catch (_: Exception) {
            null
        }
        val message = payload?.messageKey?.takeIf(String::isNotBlank)
            ?: payload?.message?.takeIf(String::isNotBlank)
            ?: fallback
        val appError = ApiErrorSupport.mapHttpFailure(
            response,
            fallback = message,
            parsedMessage = message,
            errorBody = rawBody,
        )
        return AppResult.Error(Exception(message), appError)
    }

    private suspend fun <D, T> request(
        fallback: String,
        call: suspend () -> Response<D>,
        map: (D) -> T
    ): AppResult<T> = try {
        val response = call()
        val body = response.body()
        if (response.isSuccessful && body != null) AppResult.Success(map(body))
        else responseError(response, fallback)
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    private suspend fun requestNoBody(
        fallback: String,
        call: suspend () -> Response<Unit>
    ): AppResult<Unit> = try {
        val response = call()
        if (response.isSuccessful) AppResult.Success(Unit)
        else responseError(response, fallback)
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun listSessions(): AppResult<List<SessionSummary>> = request(
        fallback = "تعذر تحميل الجلسات",
        call = api::listSessions,
        map = { rows -> rows.map { it.toDomain() } }
    )

    override suspend fun revokeSession(sessionId: String): AppResult<Unit> = requestNoBody(
        fallback = "تعذر إنهاء الجلسة",
        call = { api.revokeSession(sessionId) }
    )

    override suspend fun revokeAllOtherSessions(
        request: RevokeAllSessionsRequest
    ): AppResult<RevokeAllSessionsResult> = request(
        fallback = "تعذر إنهاء الجلسات الأخرى",
        call = {
            api.revokeAllSessions(
                RevokeAllSessionsRequestDto(exceptCurrent = request.exceptCurrent)
            )
        },
        map = { RevokeAllSessionsResult(revokedCount = it.revokedCount) }
    )
}
