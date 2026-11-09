package com.example.data.repository.mock

import com.example.core.utils.AppResult
import com.example.domain.model.AttendanceEligibleEmployee
import com.example.domain.model.AttendanceQuery
import com.example.domain.model.AttendanceRecordParams
import com.example.domain.model.ManualAttendanceRequest
import com.example.domain.repository.AttendanceRepository
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Demo Attendance repository. Seeded with realistic Arabic attendance records across multiple
 * employees / departments and every status ("حاضر" / "متأخر" / "غائب" / "إجازة" / "انصراف مبكر").
 *
 * Honest semantics — no fake success after failure:
 *  - clockIn  creates today's record (or re-stamps an existing one) for the employee.
 *  - clockOut updates today's record ONLY if a clock-in exists; otherwise AppResult.Error.
 */
class MockAttendanceRepository : AttendanceRepository {

    // Fixed "today" for deterministic demo data (matches the seeded records below).
    private val today = "2026-06-13"

    private fun nowTime(): String = SimpleDateFormat("HH:mm", Locale.US).format(Date())
    private fun nowStamp(): String = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(Date())

    // Minimal demo employee directory used to label freshly created clock-in records.
    private val employeeDirectory: Map<String, Pair<String, String>> = mapOf(
        "1" to ("موظف تجريبي 3" to "الموارد البشرية"),
        "2" to ("موظف تجريبي 4" to "المالية"),
        "3" to ("موظف تجريبي 5" to "المشتريات"),
        "4" to ("موظف تجريبي 6" to "تقنية المعلومات"),
        "5" to ("موظف تجريبي 8" to "التسويق"),
        "6" to ("موظف تجريبي 2" to "المشتريات")
    )

    private val records = mutableListOf(
        AttendanceRecordParams(
            id = "ATT-1", companyId = "1", employeeId = "1",
            employeeName = "موظف تجريبي 3", departmentName = "الموارد البشرية",
            date = today, clockInTime = "07:58", clockOutTime = null,
            status = "حاضر", lateMinutes = 0, overtimeMinutes = 0,
            source = "بصمة", locationLat = 24.7136, locationLng = 46.6753,
            createdAt = "$today 07:58", updatedAt = null
        ),
        AttendanceRecordParams(
            id = "ATT-2", companyId = "1", employeeId = "2",
            employeeName = "موظف تجريبي 4", departmentName = "المالية",
            date = today, clockInTime = "08:27", clockOutTime = null,
            status = "متأخر", lateMinutes = 27, overtimeMinutes = 0,
            source = "تطبيق", locationLat = null, locationLng = null,
            createdAt = "$today 08:27", updatedAt = null
        ),
        AttendanceRecordParams(
            id = "ATT-3", companyId = "1", employeeId = "3",
            employeeName = "موظف تجريبي 5", departmentName = "المشتريات",
            date = today, clockInTime = null, clockOutTime = null,
            status = "غائب", lateMinutes = 0, overtimeMinutes = 0,
            source = "نظام", locationLat = null, locationLng = null,
            createdAt = "$today 09:00", updatedAt = null
        ),
        AttendanceRecordParams(
            id = "ATT-4", companyId = "1", employeeId = "4",
            employeeName = "موظف تجريبي 6", departmentName = "تقنية المعلومات",
            date = today, clockInTime = "07:45", clockOutTime = "13:10",
            status = "انصراف مبكر", lateMinutes = 0, overtimeMinutes = 0,
            source = "بصمة", locationLat = 24.7743, locationLng = 46.7386,
            createdAt = "$today 07:45", updatedAt = "$today 13:10"
        ),
        AttendanceRecordParams(
            id = "ATT-5", companyId = "1", employeeId = "5",
            employeeName = "موظف تجريبي 8", departmentName = "التسويق",
            date = today, clockInTime = null, clockOutTime = null,
            status = "إجازة", lateMinutes = 0, overtimeMinutes = 0,
            source = "نظام", locationLat = null, locationLng = null,
            createdAt = "$today 00:00", updatedAt = null
        ),
        AttendanceRecordParams(
            id = "ATT-6", companyId = "1", employeeId = "6",
            employeeName = "موظف تجريبي 2", departmentName = "المشتريات",
            date = today, clockInTime = "08:02", clockOutTime = null,
            status = "حاضر", lateMinutes = 2, overtimeMinutes = 0,
            source = "يدوي", locationLat = null, locationLng = null,
            createdAt = "$today 08:05", updatedAt = null
        ),
        // History (previous day)
        AttendanceRecordParams(
            id = "ATT-7", companyId = "1", employeeId = "1",
            employeeName = "موظف تجريبي 3", departmentName = "الموارد البشرية",
            date = "2026-06-12", clockInTime = "07:50", clockOutTime = "17:35",
            status = "حاضر", lateMinutes = 0, overtimeMinutes = 35,
            source = "بصمة", locationLat = 24.7136, locationLng = 46.6753,
            createdAt = "2026-06-12 07:50", updatedAt = "2026-06-12 17:35"
        )
    )

    private val flow = MutableStateFlow<List<AttendanceRecordParams>>(records.toList())
    private val eligibleFlow = MutableStateFlow(
        employeeDirectory.map { (id, identity) ->
            AttendanceEligibleEmployee(
                employeeId = id,
                employeeNum = id.padStart(3, '0'),
                name = identity.first,
                departmentId = identity.second,
                departmentName = identity.second,
                roleName = "موظف"
            )
        }
    )

    override fun observeAttendanceRecords(): Flow<List<AttendanceRecordParams>> = flow

    override fun observeTodayAttendance(): Flow<List<AttendanceRecordParams>> =
        flow.map { list -> list.filter { it.date == today } }

    override fun observeEligibleEmployees(): Flow<List<AttendanceEligibleEmployee>> = eligibleFlow

    override fun clear() {
        flow.value = emptyList()
        eligibleFlow.value = emptyList()
    }

    override suspend fun refreshAttendance(query: AttendanceQuery?): AppResult<Unit> {
        delay(600) // Simulate network
        val from = query?.from
        val to = query?.to
        val departmentId = query?.departmentId
        flow.value = records.filter { record ->
            (from == null || record.date >= from) &&
                (to == null || record.date <= to) &&
                (departmentId == null || record.departmentId == departmentId ||
                    record.departmentName == departmentId)
        }
        return AppResult.Success(Unit)
    }

    override suspend fun refreshEligibleEmployees(): AppResult<Unit> = AppResult.Success(Unit)

    override suspend fun clockIn(employeeId: String): AppResult<AttendanceRecordParams> {
        delay(500)
        val index = records.indexOfFirst { it.employeeId == employeeId && it.date == today }
        val stamped = nowTime()
        val updated: AttendanceRecordParams = if (index != -1) {
            // Re-stamp today's existing record as present.
            records[index].copy(
                clockInTime = stamped,
                status = "حاضر",
                source = "بصمة",
                updatedAt = nowStamp()
            ).also { records[index] = it }
        } else {
            val (name, dept) = employeeDirectory[employeeId] ?: ("موظف #$employeeId" to "غير محدد")
            AttendanceRecordParams(
                id = "ATT-${(records.maxOfOrNull { it.id.removePrefix("ATT-").toIntOrNull() ?: 0 } ?: 0) + 1}",
                companyId = "1", employeeId = employeeId,
                employeeName = name, departmentName = dept,
                date = today, clockInTime = stamped, clockOutTime = null,
                status = "حاضر", lateMinutes = 0, overtimeMinutes = 0,
                source = "بصمة", locationLat = null, locationLng = null,
                createdAt = nowStamp(), updatedAt = null
            ).also { records.add(it) }
        }
        flow.value = records.toList()
        return AppResult.Success(updated)
    }

    override suspend fun clockOut(employeeId: String): AppResult<AttendanceRecordParams> {
        delay(500)
        val index = records.indexOfFirst { it.employeeId == employeeId && it.date == today }
        if (index == -1 || records[index].clockInTime == null) {
            // No clock-in -> cannot clock out. No fake success.
            return AppResult.Error(Exception("لا يمكن تسجيل الانصراف بدون تسجيل حضور مسبق لهذا اليوم."))
        }
        val updated = records[index].copy(
            clockOutTime = nowTime(),
            updatedAt = nowStamp()
        )
        records[index] = updated
        flow.value = records.toList()
        return AppResult.Success(updated)
    }

    override suspend fun createManualAttendance(request: ManualAttendanceRequest): AppResult<AttendanceRecordParams> {
        delay(700)
        val nextId = "ATT-${(records.maxOfOrNull { it.id.removePrefix("ATT-").toIntOrNull() ?: 0 } ?: 0) + 1}"
        val identity = employeeDirectory[request.employeeId] ?: ("موظف" to "غير محدد")
        val created = AttendanceRecordParams(
            id = nextId,
            companyId = "1",
            employeeId = request.employeeId,
            employeeName = identity.first,
            departmentName = identity.second,
            date = request.date,
            clockInTime = request.clockIn,
            clockOutTime = request.clockOut,
            status = when (request.status) {
                "present" -> "حاضر"
                "late" -> "متأخر"
                "absent" -> "غائب"
                else -> request.status
            },
            lateMinutes = 0,
            overtimeMinutes = 0,
            source = "",
            locationLat = null,
            locationLng = null,
            createdAt = nowStamp(),
            updatedAt = null,
            departmentId = identity.second
        )
        records.add(created)
        flow.value = records.toList()
        return AppResult.Success(created)
    }
}
