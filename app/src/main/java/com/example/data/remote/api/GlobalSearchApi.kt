package com.example.data.remote.api

import com.squareup.moshi.JsonClass
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Query

@JsonClass(generateAdapter = true)
data class GlobalSearchResultItemDto(
    val type: String,
    val id: String,
    val title: String,
    val subtitle: String? = null,
    val status: String? = null,
    val routeKey: String,
    val resourceType: String,
    val resourceId: String? = null,
    val filterJson: String? = null
)

@JsonClass(generateAdapter = true)
data class GlobalSearchResponseDto(
    val items: List<GlobalSearchResultItemDto>,
    val nextCursor: Int? = null
)

@JsonClass(generateAdapter = true)
data class GlobalSearchErrorResponseDto(
    val messageKey: String? = null,
    val message: String? = null,
    val error: String? = null
)

interface GlobalSearchApi {
    @GET("/api/v2/search")
    suspend fun search(
        @Query("q") query: String,
        @Query("types") types: String? = null,
        @Query("cursor") cursor: Int? = null,
        @Query("limit") limit: Int? = null
    ): Response<GlobalSearchResponseDto>
}
