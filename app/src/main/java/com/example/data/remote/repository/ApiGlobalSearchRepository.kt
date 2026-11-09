package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.GlobalSearchApi
import com.example.data.remote.api.GlobalSearchErrorResponseDto
import com.example.data.remote.api.GlobalSearchResultItemDto
import com.example.domain.model.GlobalSearchPage
import com.example.domain.model.GlobalSearchResult
import com.example.domain.repository.GlobalSearchRepository
import com.squareup.moshi.Moshi
import retrofit2.Response

class ApiGlobalSearchRepository(
    private val api: GlobalSearchApi
) : GlobalSearchRepository {
    private val errorAdapter =
        Moshi.Builder().build().adapter(GlobalSearchErrorResponseDto::class.java)

    override suspend fun search(
        query: String,
        types: List<String>?,
        cursor: Int?,
        limit: Int?
    ): AppResult<GlobalSearchPage> = try {
        val response = api.search(
            query = query,
            types = types?.takeIf { it.isNotEmpty() }?.joinToString(","),
            cursor = cursor,
            limit = limit
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(
                GlobalSearchPage(
                    items = body.items.map { it.toDomain() },
                    nextCursor = body.nextCursor
                )
            )
        } else {
            responseError(response)
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    private fun GlobalSearchResultItemDto.toDomain() = GlobalSearchResult(
        type = type,
        id = id,
        title = title,
        subtitle = subtitle,
        status = status,
        routeKey = routeKey,
        resourceType = resourceType,
        resourceId = resourceId,
        filterJson = filterJson
    )

    private fun <T> responseError(response: Response<T>): AppResult.Error {
        val payload = try {
            response.errorBody()?.string()?.let(errorAdapter::fromJson)
        } catch (_: Exception) {
            null
        }
        val message = payload?.messageKey?.takeIf(String::isNotBlank)
            ?: payload?.message?.takeIf(String::isNotBlank)
            ?: "تعذر تنفيذ البحث"
        val appError = when (response.code()) {
            401 -> AppError.Unauthorized
            403 -> AppError.Forbidden
            400, 404, 409, 429 -> AppError.ValidationError(message)
            else -> AppError.ServerError(response.code(), message)
        }
        return AppResult.Error(Exception(message), appError)
    }
}
