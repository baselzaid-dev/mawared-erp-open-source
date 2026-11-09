package com.example.data.remote.api

import com.squareup.moshi.JsonClass
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Path

@JsonClass(generateAdapter = true)
data class TimelineEventDto(
    val at: String,
    val type: String,
    val summary: String,
    val fromStatus: String? = null,
    val toStatus: String? = null,
    val actorName: String? = null,
    val actorRole: String? = null,
    val reason: String? = null,
    val override: Boolean = false
)

@JsonClass(generateAdapter = true)
data class TimelineResponseDto(
    val entityType: String,
    val entityId: String,
    val events: List<TimelineEventDto>
)

@JsonClass(generateAdapter = true)
data class TimelineErrorResponseDto(
    val messageKey: String? = null,
    val message: String? = null,
    val error: String? = null
)

interface TimelineApi {
    @GET("/api/v2/leaves/{id}/timeline")
    suspend fun leaveTimeline(@Path("id") id: String): Response<TimelineResponseDto>

    @GET("/api/v2/purchasing/requests/{id}/timeline")
    suspend fun purchaseRequestTimeline(@Path("id") id: String): Response<TimelineResponseDto>

    @GET("/api/v2/employees/{id}/timeline")
    suspend fun employeeTimeline(@Path("id") id: String): Response<TimelineResponseDto>

    @GET("/api/v2/training/assignments/{id}/timeline")
    suspend fun trainingAssignmentTimeline(@Path("id") id: String): Response<TimelineResponseDto>
}
