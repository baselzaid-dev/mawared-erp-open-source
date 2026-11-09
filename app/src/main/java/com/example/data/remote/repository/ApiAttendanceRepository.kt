package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.AttendanceApi
import com.example.data.remote.api.AttendanceDto
import com.example.data.remote.api.ManualAttendanceRequestDto
import com.example.domain.model.AttendanceEligibleEmployee
import com.example.domain.model.AttendanceQuery
import com.example.domain.model.AttendanceRecordParams
import com.example.domain.model.AttendanceViewScope
import com.example.domain.model.ManualAttendanceRequest
import com.example.domain.repository.AttendanceRepository
import com.squareup.moshi.Moshi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import retrofit2.Response
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class ApiAttendanceRepository(
    private val attendanceApi: AttendanceApi
) : AttendanceRepository {

    private val attendanceRecords = MutableStateFlow<List<AttendanceRecordParams>>(emptyList())
    private val eligibleEmployees = MutableStateFlow<List<AttendanceEligibleEmployee>>(emptyList())
    private val errorJsonAdapter = Moshi.Builder().build().adapter(Any::class.java)
    private var lastQuery = AttendanceQuery()

    override fun observeAttendanceRecords(): Flow<List<AttendanceRecordParams>> =
        attendanceRecords.asStateFlow()

    override fun observeTodayAttendance(): Flow<List<AttendanceRecordParams>> =
        attendanceRecords.map { records ->
            val today = utcToday()
            records.filter { it.date == today }
        }

    override fun observeEligibleEmployees(): Flow<List<AttendanceEligibleEmployee>> =
        eligibleEmployees.asStateFlow()

    private fun mapDtoToParams(dto: AttendanceDto): AttendanceRecordParams = AttendanceRecordParams(
        id = dto.id,
        companyId = dto.companyId.orEmpty(),
        employeeId = dto.employeeId,
        employeeName = dto.employee?.user?.name ?: "بدون اسم",
        departmentName = dto.employee?.department?.name.orEmpty(),
        date = normalizeDate(dto.date),
        clockInTime = displayTime(dto.clockIn),
        clockOutTime = displayTime(dto.clockOut),
        status = arabicStatus(dto.status),
        lateMinutes = 0,
        overtimeMinutes = 0,
        source = "",
        locationLat = null,
        locationLng = null,
        createdAt = dto.date,
        updatedAt = null,
        departmentId = dto.employee?.department?.id
    )

    private fun parseServerMessage(errorBody: String?): String? = try {
        errorBody?.let { body ->
            val json = errorJsonAdapter.fromJson(body) as? Map<*, *>
            (json?.get("message") as? String)?.takeIf { it.isNotBlank() }
                ?: (json?.get("error") as? String)?.takeIf { it.isNotBlank() }
                ?: ((json?.get("details") as? List<*>)?.firstOrNull() as? Map<*, *>)
                    ?.get("message")?.toString()?.takeIf { it.isNotBlank() }
        }
    } catch (_: Exception) {
        null
    }

    private fun <T> responseError(response: Response<T>, fallback: String): AppResult.Error {
        val message = parseServerMessage(response.errorBody()?.string()) ?: fallback
        return AppResult.Error(
            Exception(message),
            AppError.ServerError(response.code(), message)
        )
    }

    override suspend fun clockIn(employeeId: String): AppResult<AttendanceRecordParams> = try {
        val response = attendanceApi.clockIn()
        if (response.isSuccessful && response.body() != null) {
            refreshAttendance()
            AppResult.Success(mapDtoToParams(response.body()!!))
        } else {
            responseError(response, "تعذر تسجيل الحضور")
        }
    } catch (e: Exception) {
        AppResult.Error(e, AppError.NetworkError)
    }

    override suspend fun clockOut(employeeId: String): AppResult<AttendanceRecordParams> = try {
        val response = attendanceApi.clockOut()
        if (response.isSuccessful && response.body() != null) {
            refreshAttendance()
            AppResult.Success(mapDtoToParams(response.body()!!))
        } else {
            responseError(response, "تعذر تسجيل الانصراف")
        }
    } catch (e: Exception) {
        AppResult.Error(e, AppError.NetworkError)
    }

    override suspend fun createManualAttendance(
        request: ManualAttendanceRequest
    ): AppResult<AttendanceRecordParams> = try {
        val response = attendanceApi.createManualAttendance(
            ManualAttendanceRequestDto(
                employeeId = request.employeeId,
                date = request.date,
                status = request.status,
                clockIn = request.clockIn,
                clockOut = request.clockOut
            )
        )
        if (response.isSuccessful && response.body() != null) {
            val created = mapDtoToParams(response.body()!!)
            refreshAttendance()
            AppResult.Success(created)
        } else {
            responseError(response, "تعذر إضافة سجل الحضور اليدوي")
        }
    } catch (e: Exception) {
        AppResult.Error(e, AppError.NetworkError)
    }

    override suspend fun refreshAttendance(query: AttendanceQuery?): AppResult<Unit> = try {
        val effectiveQuery = query ?: lastQuery
        lastQuery = effectiveQuery
        val response = when (effectiveQuery.scope) {
            AttendanceViewScope.OWN -> attendanceApi.getMyAttendance(
                effectiveQuery.from,
                effectiveQuery.to
            )
            AttendanceViewScope.DEPARTMENT,
            AttendanceViewScope.COMPANY -> attendanceApi.getAllAttendance(
                effectiveQuery.from,
                effectiveQuery.to,
                effectiveQuery.departmentId
            )
        }
        if (response.isSuccessful && response.body() != null) {
            attendanceRecords.value = response.body()!!.map(::mapDtoToParams)
            AppResult.Success(Unit)
        } else {
            responseError(response, "تعذر تحميل سجلات الحضور")
        }
    } catch (e: Exception) {
        AppResult.Error(e, AppError.NetworkError)
    }

    override suspend fun refreshEligibleEmployees(): AppResult<Unit> = try {
        val response = attendanceApi.getEligibleEmployees()
        if (response.isSuccessful && response.body() != null) {
            eligibleEmployees.value = response.body()!!.map { employee ->
                AttendanceEligibleEmployee(
                    employeeId = employee.employeeId,
                    employeeNum = employee.employeeNum,
                    name = employee.name,
                    departmentId = employee.departmentId,
                    departmentName = employee.departmentName,
                    roleName = employee.roleName
                )
            }
            AppResult.Success(Unit)
        } else {
            responseError(response, "تعذر تحميل قائمة الموظفين")
        }
    } catch (e: Exception) {
        AppResult.Error(e, AppError.NetworkError)
    }

    override fun clear() {
        attendanceRecords.value = emptyList()
        eligibleEmployees.value = emptyList()
        lastQuery = AttendanceQuery()
    }

    companion object {
        internal fun arabicStatus(status: String): String = when (status.lowercase(Locale.ROOT)) {
            "present" -> "حاضر"
            "late" -> "متأخر"
            "absent" -> "غائب"
            else -> status.ifBlank { "غير معروف" }
        }

        internal fun normalizeDate(value: String): String =
            if (value.length >= 10 && value[4] == '-' && value[7] == '-') value.take(10) else value

        internal fun displayTime(value: String?): String? = when {
            value.isNullOrBlank() -> null
            value.length >= 16 && value.contains('T') -> value.substring(11, 16)
            value.length >= 5 && value[2] == ':' -> value.take(5)
            else -> value
        }

        internal fun utcToday(now: Date = Date()): String = SimpleDateFormat(
            "yyyy-MM-dd",
            Locale.US
        ).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(now)
    }
}
