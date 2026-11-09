package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.TimelineApi
import com.example.data.remote.api.TimelineErrorResponseDto
import com.example.data.remote.api.TimelineResponseDto
import com.example.domain.model.TimelineEntity
import com.example.domain.model.TimelineEvent
import com.example.domain.model.TimelineKind
import com.example.domain.repository.TimelineRepository
import com.squareup.moshi.Moshi
import retrofit2.Response

class ApiTimelineRepository(
    private val api: TimelineApi
) : TimelineRepository {
    private val errorAdapter =
        Moshi.Builder().build().adapter(TimelineErrorResponseDto::class.java)

    override suspend fun loadTimeline(
        kind: TimelineKind,
        id: String
    ): AppResult<TimelineEntity> = try {
        val response = when (kind) {
            TimelineKind.LEAVE -> api.leaveTimeline(id)
            TimelineKind.PURCHASE_REQUEST -> api.purchaseRequestTimeline(id)
            TimelineKind.EMPLOYEE -> api.employeeTimeline(id)
            TimelineKind.TRAINING_ASSIGNMENT -> api.trainingAssignmentTimeline(id)
        }
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(body.toDomain())
        } else {
            responseError(response)
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    private fun TimelineResponseDto.toDomain() = TimelineEntity(
        entityType = entityType,
        entityId = entityId,
        events = events.map { dto ->
            TimelineEvent(
                at = dto.at,
                type = dto.type,
                summary = dto.summary,
                fromStatus = dto.fromStatus,
                toStatus = dto.toStatus,
                actorName = dto.actorName,
                actorRole = dto.actorRole,
                reason = dto.reason,
                override = dto.override
            )
        }
    )

    private fun <T> responseError(response: Response<T>): AppResult.Error {
        val payload = try {
            response.errorBody()?.string()?.let(errorAdapter::fromJson)
        } catch (_: Exception) {
            null
        }
        val message = payload?.messageKey?.takeIf(String::isNotBlank)
            ?: payload?.message?.takeIf(String::isNotBlank)
            ?: "تعذر تحميل السجل الزمني"
        val appError = when (response.code()) {
            401 -> AppError.Unauthorized
            403 -> AppError.Forbidden
            400, 404, 409 -> AppError.ValidationError(message)
            else -> AppError.ServerError(response.code(), message)
        }
        return AppResult.Error(Exception(message), appError)
    }
}
