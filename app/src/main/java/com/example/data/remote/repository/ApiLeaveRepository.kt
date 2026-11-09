package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.LeaveApi
import com.example.data.remote.api.LeaveDto
import com.example.data.remote.api.LeaveRequestDto
import com.example.data.remote.api.RejectRequestDto
import com.example.domain.model.LeaveApprovalStage
import com.example.domain.model.LeaveQuery
import com.example.domain.model.LeaveReportData
import com.example.domain.model.LeaveReportSummary
import com.example.domain.model.LeaveRequestParams
import com.example.domain.repository.LeaveRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import retrofit2.Response

class ApiLeaveRepository(
    private val leaveApi: LeaveApi
) : LeaveRepository {

    private val _leaves = MutableStateFlow<List<LeaveRequestParams>>(emptyList())
    private val _myLeaves = MutableStateFlow<List<LeaveRequestParams>>(emptyList())
    private val _report = MutableStateFlow(LeaveReportData())

    override fun observeLeaveRequests(): Flow<List<LeaveRequestParams>> = _leaves.asStateFlow()

    override fun observeMyLeaveRequests(employeeId: String): Flow<List<LeaveRequestParams>> =
        _myLeaves.asStateFlow()

    override fun observeLeaveReport(): Flow<LeaveReportData> = _report.asStateFlow()

    private fun displayStatus(raw: String): String = when (raw) {
        "pending_hr", "pending_admin" -> "قيد المراجعة"
        "approved" -> "موافق عليها"
        "rejected" -> "مرفوضة"
        "cancelled" -> "ملغاة"
        else -> raw
    }

    private fun displayLeaveType(raw: String): String = when (raw) {
        "annual" -> "سنوية"
        "sick" -> "مرضية"
        "special" -> "طارئة"
        "unpaid" -> "بدون راتب"
        "study" -> "دراسية"
        else -> raw
    }

    private fun mapDtoToParams(dto: LeaveDto): LeaveRequestParams = LeaveRequestParams(
        id = dto.id,
        companyId = "",
        employeeId = dto.employeeId,
        employeeName = dto.employee?.name ?: "موظف",
        departmentName = dto.employee?.department?.name ?: "",
        leaveType = displayLeaveType(dto.leaveType),
        startDate = dto.startDate,
        endDate = dto.endDate,
        totalDays = dto.totalDays,
        reason = dto.reason.orEmpty(),
        status = displayStatus(dto.status),
        currentApprovalStep = if (dto.status == "pending_admin") 2 else 1,
        requestedAt = dto.createdAt ?: dto.startDate,
        approvedBy = null,
        approvedAt = null,
        rejectionReason = dto.rejectionReason,
        createdAt = dto.createdAt ?: dto.startDate,
        updatedAt = dto.updatedAt,
        exitReentryRequested = dto.exitReentryRequested,
        visaFeePaid = dto.visaFeePaid,
        rawStatus = dto.status,
        rawLeaveType = dto.leaveType
    )

    private fun placeholder(requestId: String, rawStatus: String): LeaveRequestParams =
        LeaveRequestParams(
            id = requestId,
            companyId = "",
            employeeId = "",
            employeeName = "",
            departmentName = "",
            leaveType = "",
            startDate = "",
            endDate = "",
            totalDays = 0,
            reason = "",
            status = displayStatus(rawStatus),
            currentApprovalStep = if (rawStatus == "pending_admin") 2 else 1,
            requestedAt = "",
            approvedBy = null,
            approvedAt = null,
            rejectionReason = null,
            createdAt = "",
            updatedAt = null,
            rawStatus = rawStatus,
            rawLeaveType = ""
        )

    private fun existingRequest(requestId: String): LeaveRequestParams? =
        (_leaves.value + _myLeaves.value + _report.value.requests)
            .firstOrNull { it.id == requestId }

    private fun jsonValue(body: String, key: String): String? =
        Regex("\\\"$key\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"")
            .find(body)
            ?.groupValues
            ?.getOrNull(1)

    private fun backendMessage(body: String?, fallback: String): String {
        if (body.isNullOrBlank()) return fallback
        val message = jsonValue(body, "message")
        val detail = Regex("\\\"details\\\"\\s*:\\s*\\[[\\s\\S]*?\\\"message\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"")
            .find(body)
            ?.groupValues
            ?.getOrNull(1)
        val error = jsonValue(body, "error")
        return message?.takeIf { it.isNotBlank() && it != "ValidationError" }
            ?: detail?.takeIf { it.isNotBlank() }
            ?: error?.takeIf { it.isNotBlank() && it != "ValidationError" }
            ?: fallback
    }

    private fun responseError(response: Response<*>, fallback: String): AppResult.Error {
        val message = try {
            backendMessage(response.errorBody()?.string(), fallback)
        } catch (_: Exception) {
            fallback
        }
        return AppResult.Error(
            Exception(message),
            AppError.ServerError(response.code(), message)
        )
    }

    override suspend fun submitLeaveRequest(request: LeaveRequestParams): AppResult<LeaveRequestParams> {
        return try {
            val response = leaveApi.submitLeaveRequest(
                LeaveRequestDto(
                    leaveType = request.rawLeaveType,
                    startDate = request.startDate,
                    endDate = request.endDate,
                    reason = request.reason,
                    exitReentryRequested = request.exitReentryRequested,
                    visaFeePaid = request.visaFeePaid
                )
            )
            if (response.isSuccessful) {
                val mapped = try {
                    response.body()?.let(::mapDtoToParams) ?: request
                } catch (_: Exception) {
                    request
                }
                refreshMyLeaveRequests()
                AppResult.Success(mapped)
            } else {
                responseError(response, "تعذر تقديم طلب الإجازة")
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun approveLeaveRequest(
        requestId: String,
        note: String?,
        stage: LeaveApprovalStage
    ): AppResult<LeaveRequestParams> {
        return try {
            val response = when (stage) {
                LeaveApprovalStage.HR -> leaveApi.hrApprove(requestId)
                LeaveApprovalStage.ADMIN -> leaveApi.adminApprove(requestId)
            }
            if (response.isSuccessful) {
                val current = existingRequest(requestId)
                val escalated = stage == LeaveApprovalStage.HR &&
                    current?.rawLeaveType in setOf("annual", "سنوية")
                val rawStatus = if (escalated) "pending_admin" else "approved"
                val updated = current?.copy(
                    status = displayStatus(rawStatus),
                    rawStatus = rawStatus,
                    currentApprovalStep = if (escalated) 2 else current.currentApprovalStep
                ) ?: placeholder(requestId, rawStatus)
                AppResult.Success(updated)
            } else {
                responseError(response, "تعذر اعتماد طلب الإجازة")
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun rejectLeaveRequest(
        requestId: String,
        reason: String,
        stage: LeaveApprovalStage
    ): AppResult<LeaveRequestParams> {
        return try {
            val response = when (stage) {
                LeaveApprovalStage.HR -> leaveApi.hrReject(requestId, RejectRequestDto(reason))
                LeaveApprovalStage.ADMIN -> leaveApi.adminReject(requestId, RejectRequestDto(reason))
            }
            if (response.isSuccessful) {
                val updated = existingRequest(requestId)?.copy(
                    status = displayStatus("rejected"),
                    rawStatus = "rejected",
                    rejectionReason = reason
                ) ?: placeholder(requestId, "rejected").copy(rejectionReason = reason)
                AppResult.Success(updated)
            } else {
                responseError(response, "تعذر رفض طلب الإجازة")
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun cancelLeaveRequest(requestId: String): AppResult<LeaveRequestParams> {
        return try {
            val response = leaveApi.cancelLeave(requestId)
            if (response.isSuccessful) {
                val mapped = try {
                    response.body()?.let(::mapDtoToParams)
                } catch (_: Exception) {
                    null
                } ?: existingRequest(requestId)?.copy(
                    status = displayStatus("cancelled"),
                    rawStatus = "cancelled"
                ) ?: placeholder(requestId, "cancelled")
                refreshMyLeaveRequests()
                AppResult.Success(mapped)
            } else {
                responseError(response, "تعذر إلغاء طلب الإجازة")
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun refreshMyLeaveRequests(query: LeaveQuery): AppResult<Unit> {
        return try {
            val response = leaveApi.getMyLeaves(query.from, query.to, query.status, query.leaveType)
            if (response.isSuccessful) {
                _myLeaves.value = response.body().orEmpty().map(::mapDtoToParams)
                AppResult.Success(Unit)
            } else {
                responseError(response, "تعذر تحديث طلباتي")
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun refreshLeaveReview(): AppResult<Unit> {
        return try {
            val response = leaveApi.getPendingLeaves()
            if (response.isSuccessful) {
                _leaves.value = response.body().orEmpty().map(::mapDtoToParams)
                AppResult.Success(Unit)
            } else {
                if (response.code() == 403) _leaves.value = emptyList()
                responseError(response, "تعذر تحديث قائمة المراجعة")
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun refreshLeaveReport(query: LeaveQuery): AppResult<Unit> {
        val from = query.from
        val to = query.to
        if (from.isNullOrBlank() || to.isNullOrBlank()) {
            val message = "يجب تحديد تاريخي البداية والنهاية"
            return AppResult.Error(Exception(message), AppError.ValidationError(message))
        }
        return try {
            val response = leaveApi.getLeaveReport(
                from = from,
                to = to,
                status = query.status,
                leaveType = query.leaveType,
                employeeId = query.employeeId
            )
            if (response.isSuccessful && response.body() != null) {
                val body = response.body()!!
                _report.value = LeaveReportData(
                    summary = LeaveReportSummary(
                        total = body.summary.total,
                        pendingHr = body.summary.pendingHr,
                        pendingAdmin = body.summary.pendingAdmin,
                        approved = body.summary.approved,
                        rejected = body.summary.rejected,
                        cancelled = body.summary.cancelled,
                        totalDays = body.summary.totalDays
                    ),
                    requests = body.requests.map(::mapDtoToParams)
                )
                AppResult.Success(Unit)
            } else {
                responseError(response, "تعذر تحديث تقرير الإجازات")
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun refreshLeaveRequests(): AppResult<Unit> {
        val myResult = refreshMyLeaveRequests()
        val reviewResult = refreshLeaveReview()
        val reviewForbidden = reviewResult is AppResult.Error &&
            (reviewResult.appError as? AppError.ServerError)?.code == 403
        return when {
            myResult is AppResult.Error -> myResult
            reviewResult is AppResult.Error && !reviewForbidden -> reviewResult
            else -> AppResult.Success(Unit)
        }
    }

    override fun clear() {
        _leaves.value = emptyList()
        _myLeaves.value = emptyList()
        _report.value = LeaveReportData()
    }
}
