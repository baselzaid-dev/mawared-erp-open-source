package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.AttendanceApi
import com.example.data.remote.api.AttendanceCorrectionCreateRequestDto
import com.example.data.remote.api.AttendanceCorrectionDecisionRequestDto
import com.example.data.remote.api.AttendanceCorrectionDto
import com.example.domain.model.*
import com.example.domain.repository.AttendanceCorrectionRepository
import com.squareup.moshi.Moshi
import retrofit2.Response

class ApiAttendanceCorrectionRepository(
    private val attendanceApi: AttendanceApi
) : AttendanceCorrectionRepository {

    private val errorJsonAdapter = Moshi.Builder().build().adapter(Any::class.java)

    private fun parseServerMessage(errorBody: String?): String? = try {
        errorBody?.let { body ->
            val json = errorJsonAdapter.fromJson(body) as? Map<*, *>
            (json?.get("messageKey") as? String)?.takeIf { it.isNotBlank() }
                ?: (json?.get("message") as? String)?.takeIf { it.isNotBlank() }
        }
    } catch (_: Exception) {
        null
    }

    private fun AttendanceCorrectionDto.toDomain() = AttendanceCorrection(
        id = id,
        attendanceId = attendanceId,
        employeeId = employeeId,
        requestedByUserId = requestedByUserId,
        requestedClockIn = requestedClockIn,
        requestedClockOut = requestedClockOut,
        reason = reason,
        status = AttendanceCorrectionStatus.fromApi(status),
        version = version,
        reviewedAt = reviewedAt,
        decisionReason = decisionReason,
        createdAt = createdAt,
        updatedAt = updatedAt
    )

    private fun <T> responseError(response: Response<T>, fallback: String): AppResult.Error {
        val message = parseServerMessage(response.errorBody()?.string()) ?: fallback
        val appError = when (response.code()) {
            401 -> AppError.Unauthorized
            403 -> AppError.Forbidden
            400, 409, 412 -> AppError.ValidationError(message)
            else -> AppError.ServerError(response.code(), message)
        }
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

    override suspend fun createCorrection(
        attendanceId: String,
        request: AttendanceCorrectionCreateRequest
    ): AppResult<AttendanceCorrection> = request(
        fallback = "تعذر إرسال طلب تصحيح الحضور",
        call = {
            attendanceApi.createCorrection(
                attendanceId,
                AttendanceCorrectionCreateRequestDto(
                    clockIn = request.clockIn,
                    clockOut = request.clockOut,
                    reason = request.reason,
                    expectedAttendanceVersion = request.expectedAttendanceVersion
                )
            )
        },
        map = { it.toDomain() }
    )

    override suspend fun listCorrections(
        status: String?,
        employeeId: String?,
        cursor: String?,
        limit: Int?
    ): AppResult<AttendanceCorrectionPage> = request(
        fallback = "تعذر تحميل طلبات تصحيح الحضور",
        call = { attendanceApi.listCorrections(status, employeeId, cursor, limit) },
        map = { dto ->
            AttendanceCorrectionPage(
                items = dto.items.map { it.toDomain() },
                nextCursor = dto.nextCursor,
                hasMore = dto.hasMore
            )
        }
    )

    override suspend fun decideCorrection(
        correctionId: String,
        request: AttendanceCorrectionDecisionRequest
    ): AppResult<AttendanceCorrectionDecisionResult> = request(
        fallback = "تعذر إكمال مراجعة طلب التصحيح",
        call = {
            attendanceApi.decideCorrection(
                correctionId,
                java.util.UUID.randomUUID().toString(),
                AttendanceCorrectionDecisionRequestDto(
                    decision = request.decision.toApiValue(),
                    reason = request.reason,
                    expectedVersion = request.expectedVersion
                )
            )
        },
        map = { dto ->
            AttendanceCorrectionDecisionResult(
                correction = dto.correction.toDomain(),
                updatedAttendanceVersion = dto.attendance?.version
            )
        }
    )
}
