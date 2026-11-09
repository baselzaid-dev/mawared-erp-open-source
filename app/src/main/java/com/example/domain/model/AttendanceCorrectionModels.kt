package com.example.domain.model

enum class AttendanceCorrectionStatus {
    PENDING,
    APPROVED,
    REJECTED,
    CANCELLED;

    companion object {
        fun fromApi(value: String): AttendanceCorrectionStatus = when (value.lowercase()) {
            "pending" -> PENDING
            "approved" -> APPROVED
            "rejected" -> REJECTED
            "cancelled" -> CANCELLED
            else -> PENDING
        }

        fun toApiFilter(value: AttendanceCorrectionStatus?): String? =
            value?.name?.lowercase()
    }
}

enum class AttendanceCorrectionDecision {
    ACCEPT,
    REJECT;

    fun toApiValue(): String = when (this) {
        ACCEPT -> "accept"
        REJECT -> "reject"
    }
}

data class AttendanceCorrection(
    val id: String,
    val attendanceId: String,
    val employeeId: String,
    val requestedByUserId: String,
    val requestedClockIn: String?,
    val requestedClockOut: String?,
    val reason: String,
    val status: AttendanceCorrectionStatus,
    val version: Int,
    val reviewedAt: String?,
    val decisionReason: String?,
    val createdAt: String,
    val updatedAt: String
)

data class AttendanceCorrectionPage(
    val items: List<AttendanceCorrection>,
    val nextCursor: String?,
    val hasMore: Boolean
)

data class AttendanceCorrectionCreateRequest(
    val clockIn: String?,
    val clockOut: String?,
    val reason: String,
    val expectedAttendanceVersion: Int
)

data class AttendanceCorrectionDecisionRequest(
    val decision: AttendanceCorrectionDecision,
    val reason: String,
    val expectedVersion: Int
)

data class AttendanceCorrectionDecisionResult(
    val correction: AttendanceCorrection,
    val updatedAttendanceVersion: Int?
)
