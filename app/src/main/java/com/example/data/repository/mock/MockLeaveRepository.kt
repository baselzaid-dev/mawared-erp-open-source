package com.example.data.repository.mock

import com.example.core.utils.AppResult
import com.example.domain.model.LeaveApprovalStage
import com.example.domain.model.LeaveQuery
import com.example.domain.model.LeaveReportData
import com.example.domain.model.LeaveReportSummary
import com.example.domain.model.LeaveRequestParams
import com.example.domain.model.isPendingHr
import com.example.domain.repository.LeaveRepository
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Demo Leaves repository. Seeded with realistic Arabic leave requests across multiple
 * employees / departments, every leave type ("سنوية" / "مرضية" / "طارئة" / "بدون راتب" /
 * "دراسية") and every status ("قيد المراجعة" / "موافق عليها" / "مرفوضة" / "ملغاة").
 *
 * Honest state machine — no fake success after failure:
 *  - approve / reject / cancel only act on a "قيد المراجعة" (pending) request, else AppResult.Error.
 */
class MockLeaveRepository : LeaveRepository {

    private val pending = "قيد المراجعة"

    private fun nowStamp(): String = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(Date())

    private val requests = mutableListOf(
        LeaveRequestParams(
            id = "LV-1", companyId = "1", employeeId = "4",
            employeeName = "موظف تجريبي 6", departmentName = "تقنية المعلومات",
            leaveType = "سنوية", startDate = "2026-06-20", endDate = "2026-06-24", totalDays = 5,
            reason = "إجازة سنوية لقضاء عطلة عائلية.", status = pending, currentApprovalStep = 1,
            requestedAt = "2026-06-12 09:10", approvedBy = null, approvedAt = null,
            rejectionReason = null, createdAt = "2026-06-12 09:10", updatedAt = null
        ),
        LeaveRequestParams(
            id = "LV-2", companyId = "1", employeeId = "2",
            employeeName = "موظف تجريبي 4", departmentName = "المالية",
            leaveType = "مرضية", startDate = "2026-06-14", endDate = "2026-06-15", totalDays = 2,
            reason = "إجازة مرضية بموجب تقرير طبي.", status = pending, currentApprovalStep = 1,
            requestedAt = "2026-06-13 08:05", approvedBy = null, approvedAt = null,
            rejectionReason = null, createdAt = "2026-06-13 08:05", updatedAt = null
        ),
        LeaveRequestParams(
            id = "LV-3", companyId = "1", employeeId = "3",
            employeeName = "موظف تجريبي 5", departmentName = "المشتريات",
            leaveType = "طارئة", startDate = "2026-06-13", endDate = "2026-06-13", totalDays = 1,
            reason = "ظرف عائلي طارئ.", status = "موافق عليها", currentApprovalStep = 2,
            requestedAt = "2026-06-13 07:30", approvedBy = "موظف تجريبي 3", approvedAt = "2026-06-13 07:55",
            rejectionReason = null, createdAt = "2026-06-13 07:30", updatedAt = "2026-06-13 07:55"
        ),
        LeaveRequestParams(
            id = "LV-4", companyId = "1", employeeId = "5",
            employeeName = "موظف تجريبي 8", departmentName = "التسويق",
            leaveType = "دراسية", startDate = "2026-07-01", endDate = "2026-07-10", totalDays = 10,
            reason = "حضور برنامج تدريبي معتمد.", status = pending, currentApprovalStep = 1,
            requestedAt = "2026-06-11 11:20", approvedBy = null, approvedAt = null,
            rejectionReason = null, createdAt = "2026-06-11 11:20", updatedAt = null
        ),
        LeaveRequestParams(
            id = "LV-5", companyId = "1", employeeId = "6",
            employeeName = "موظف تجريبي 2", departmentName = "المشتريات",
            leaveType = "بدون راتب", startDate = "2026-06-25", endDate = "2026-06-30", totalDays = 6,
            reason = "سفر شخصي.", status = "مرفوضة", currentApprovalStep = 2,
            requestedAt = "2026-06-09 14:00", approvedBy = null, approvedAt = null,
            rejectionReason = "ضغط العمل في نهاية الربع المالي.", createdAt = "2026-06-09 14:00",
            updatedAt = "2026-06-10 09:15"
        ),
        LeaveRequestParams(
            id = "LV-6", companyId = "1", employeeId = "1",
            employeeName = "موظف تجريبي 3", departmentName = "الموارد البشرية",
            leaveType = "سنوية", startDate = "2026-05-01", endDate = "2026-05-05", totalDays = 5,
            reason = "إجازة سنوية.", status = "ملغاة", currentApprovalStep = 1,
            requestedAt = "2026-04-20 10:00", approvedBy = null, approvedAt = null,
            rejectionReason = null, createdAt = "2026-04-20 10:00", updatedAt = "2026-04-22 12:00"
        ),
        LeaveRequestParams(
            id = "LV-7", companyId = "1", employeeId = "4",
            employeeName = "موظف تجريبي 6", departmentName = "تقنية المعلومات",
            leaveType = "مرضية", startDate = "2026-06-10", endDate = "2026-06-11", totalDays = 2,
            reason = "وعكة صحية.", status = "موافق عليها", currentApprovalStep = 2,
            requestedAt = "2026-06-09 08:00", approvedBy = "موظف تجريبي 3", approvedAt = "2026-06-09 09:30",
            rejectionReason = null, createdAt = "2026-06-09 08:00", updatedAt = "2026-06-09 09:30"
        )
    )

    private val flow = MutableStateFlow<List<LeaveRequestParams>>(requests.toList())
    private val reportFlow = MutableStateFlow(LeaveReportData())

    override fun observeLeaveRequests(): Flow<List<LeaveRequestParams>> = flow

    override fun observeMyLeaveRequests(employeeId: String): Flow<List<LeaveRequestParams>> =
        flow.map { list -> list.filter { it.employeeId == employeeId } }

    override fun observeLeaveReport(): Flow<LeaveReportData> = reportFlow

    override fun clear() {
        flow.value = emptyList()
        reportFlow.value = LeaveReportData()
    }

    override suspend fun refreshMyLeaveRequests(query: LeaveQuery): AppResult<Unit> {
        flow.value = requests.toList()
        return AppResult.Success(Unit)
    }

    override suspend fun refreshLeaveReview(): AppResult<Unit> {
        flow.value = requests.toList()
        return AppResult.Success(Unit)
    }

    override suspend fun refreshLeaveReport(query: LeaveQuery): AppResult<Unit> {
        val filtered = requests.filter { request ->
            val dateMatches = (query.from == null || request.endDate >= query.from) &&
                (query.to == null || request.startDate <= query.to)
            val statusMatches = query.status == null || request.rawStatus == query.status
            val typeMatches = query.leaveType == null || request.rawLeaveType == query.leaveType ||
                request.leaveType == query.leaveType
            val employeeMatches = query.employeeId == null || request.employeeId == query.employeeId
            dateMatches && statusMatches && typeMatches && employeeMatches
        }
        reportFlow.value = LeaveReportData(
            summary = LeaveReportSummary(
                total = filtered.size,
                pendingHr = filtered.count { it.rawStatus == "pending_hr" || it.isPendingHr() },
                pendingAdmin = filtered.count { it.rawStatus == "pending_admin" },
                approved = filtered.count { it.rawStatus == "approved" || it.status == "موافق عليها" },
                rejected = filtered.count { it.rawStatus == "rejected" || it.status == "مرفوضة" },
                cancelled = filtered.count { it.rawStatus == "cancelled" || it.status == "ملغاة" },
                totalDays = filtered.sumOf { it.totalDays }
            ),
            requests = filtered
        )
        return AppResult.Success(Unit)
    }

    override suspend fun refreshLeaveRequests(): AppResult<Unit> {
        delay(600) // Simulate network
        flow.value = requests.toList()
        return AppResult.Success(Unit)
    }

    override suspend fun submitLeaveRequest(request: LeaveRequestParams): AppResult<LeaveRequestParams> {
        delay(700)
        val nextId = "LV-${(requests.maxOfOrNull { it.id.removePrefix("LV-").toIntOrNull() ?: 0 } ?: 0) + 1}"
        val created = request.copy(
            id = nextId,
            status = pending,
            rawStatus = "pending_hr",
            currentApprovalStep = 1,
            approvedBy = null,
            approvedAt = null,
            rejectionReason = null,
            requestedAt = nowStamp(),
            createdAt = nowStamp(),
            updatedAt = null
        )
        requests.add(created)
        flow.value = requests.toList()
        return AppResult.Success(created)
    }

    override suspend fun approveLeaveRequest(
        requestId: String,
        note: String?,
        stage: LeaveApprovalStage
    ): AppResult<LeaveRequestParams> {
        delay(500)
        val index = requests.indexOfFirst { it.id == requestId }
        if (index == -1) return AppResult.Error(Exception("طلب الإجازة غير موجود."))
        if (requests[index].status != pending) {
            return AppResult.Error(Exception("لا يمكن الموافقة على طلب ليس قيد المراجعة."))
        }
        val escalates = stage == LeaveApprovalStage.HR &&
            requests[index].rawLeaveType in setOf("annual", "سنوية")
        val updated = requests[index].copy(
            status = if (escalates) pending else "موافق عليها",
            rawStatus = if (escalates) "pending_admin" else "approved",
            currentApprovalStep = if (escalates) 2 else requests[index].currentApprovalStep,
            approvedBy = note?.takeIf { it.isNotBlank() } ?: "اعتماد إداري",
            approvedAt = nowStamp(),
            updatedAt = nowStamp()
        )
        requests[index] = updated
        flow.value = requests.toList()
        return AppResult.Success(updated)
    }

    override suspend fun rejectLeaveRequest(
        requestId: String,
        reason: String,
        stage: LeaveApprovalStage
    ): AppResult<LeaveRequestParams> {
        delay(500)
        val index = requests.indexOfFirst { it.id == requestId }
        if (index == -1) return AppResult.Error(Exception("طلب الإجازة غير موجود."))
        if (requests[index].status != pending) {
            return AppResult.Error(Exception("لا يمكن رفض طلب ليس قيد المراجعة."))
        }
        val updated = requests[index].copy(
            status = "مرفوضة",
            rawStatus = "rejected",
            rejectionReason = reason.ifBlank { "بدون سبب محدد." },
            updatedAt = nowStamp()
        )
        requests[index] = updated
        flow.value = requests.toList()
        return AppResult.Success(updated)
    }

    override suspend fun cancelLeaveRequest(requestId: String): AppResult<LeaveRequestParams> {
        delay(500)
        val index = requests.indexOfFirst { it.id == requestId }
        if (index == -1) return AppResult.Error(Exception("طلب الإجازة غير موجود."))
        if (!requests[index].isPendingHr()) {
            return AppResult.Error(Exception("لا يمكن إلغاء طلب ليس قيد المراجعة."))
        }
        val updated = requests[index].copy(status = "ملغاة", rawStatus = "cancelled", updatedAt = nowStamp())
        requests[index] = updated
        flow.value = requests.toList()
        return AppResult.Success(updated)
    }
}
