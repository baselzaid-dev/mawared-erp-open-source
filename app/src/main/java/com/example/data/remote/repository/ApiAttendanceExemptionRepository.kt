package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.AttendanceApi
import com.example.data.remote.api.AttendanceExemptionCreateRequestDto
import com.example.data.remote.api.AttendanceExemptionDto
import com.example.data.remote.api.AttendanceExemptionListDto
import com.example.data.remote.api.AttendanceExemptionRevokeRequestDto
import com.example.domain.model.AttendanceExemption
import com.example.domain.model.AttendanceExemptionCreateRequest
import com.example.domain.model.AttendanceExemptionPage
import com.example.domain.model.AttendanceExemptionReasonCategory
import com.example.domain.model.AttendanceExemptionRevokeRequest
import com.example.domain.model.AttendanceExemptionStatus
import com.example.domain.repository.AttendanceExemptionRepository
import com.squareup.moshi.Moshi
import retrofit2.Response

class ApiAttendanceExemptionRepository(
    private val attendanceApi: AttendanceApi
) : AttendanceExemptionRepository {

    private val errorJsonAdapter = Moshi.Builder().build().adapter(Any::class.java)

    override suspend fun listExemptions(
        status: String?,
        targetUserId: String?
    ): AppResult<AttendanceExemptionPage> = request(
        fallback = "تعذر تحميل إعفاءات الحضور",
        call = { attendanceApi.listExemptions(status, targetUserId) },
        map = ::mapPage
    )

    override suspend fun createExemption(
        request: AttendanceExemptionCreateRequest
    ): AppResult<AttendanceExemption> = request(
        fallback = "تعذر إنشاء إعفاء الحضور",
        call = {
            attendanceApi.createExemption(
                java.util.UUID.randomUUID().toString(),
                AttendanceExemptionCreateRequestDto(
                    targetUserId = request.targetUserId,
                    validFrom = request.validFrom,
                    validUntil = request.validUntil,
                    reasonCategory = request.reasonCategory.apiValue,
                    note = request.note
                )
            )
        },
        map = ::mapExemption
    )

    override suspend fun revokeExemption(
        exemptionId: String,
        request: AttendanceExemptionRevokeRequest
    ): AppResult<AttendanceExemption> = request(
        fallback = "تعذر إلغاء إعفاء الحضور",
        call = {
            attendanceApi.revokeExemption(
                exemptionId,
                java.util.UUID.randomUUID().toString(),
                AttendanceExemptionRevokeRequestDto(
                    reason = request.reason,
                    expectedVersion = request.expectedVersion
                )
            )
        },
        map = ::mapExemption
    )

    private fun mapPage(dto: AttendanceExemptionListDto): AttendanceExemptionPage =
        AttendanceExemptionPage(
            items = dto.items.mapNotNull(::mapExemptionOrNull),
            nextCursor = dto.nextCursor,
            hasMore = dto.hasMore
        )

    private fun mapExemptionOrNull(dto: AttendanceExemptionDto): AttendanceExemption? {
        val category = AttendanceExemptionReasonCategory.fromApi(dto.reasonCategory) ?: return null
        return AttendanceExemption(
            id = dto.id,
            userId = dto.userId,
            employeeId = dto.employeeId,
            validFrom = dto.validFrom,
            validUntil = dto.validUntil,
            reasonCategory = category,
            note = dto.note,
            status = AttendanceExemptionStatus.fromApi(dto.status),
            version = dto.version,
            createdAt = dto.createdAt,
            revokedAt = dto.revokedAt
        )
    }

    private fun mapExemption(dto: AttendanceExemptionDto): AttendanceExemption =
        mapExemptionOrNull(dto)
            ?: throw IllegalArgumentException("attendance.exemption_unknown_category")

    private fun parseServerMessage(errorBody: String?): String? = try {
        errorBody?.let { body ->
            val json = errorJsonAdapter.fromJson(body) as? Map<*, *>
            (json?.get("messageKey") as? String)?.takeIf { it.isNotBlank() }
                ?: (json?.get("message") as? String)?.takeIf { it.isNotBlank() }
                ?: (json?.get("error") as? String)?.takeIf { it.isNotBlank() }
        }
    } catch (_: Exception) {
        null
    }

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
        if (response.isSuccessful && body != null) {
            AppResult.Success(map(body))
        } else {
            responseError(response, fallback)
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }
}
