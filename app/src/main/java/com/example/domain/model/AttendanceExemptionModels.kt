package com.example.domain.model

enum class AttendanceExemptionStatus(val apiValue: String, val labelAr: String) {
    ACTIVE("active", "نشط"),
    REVOKED("revoked", "ملغى");

    companion object {
        fun fromApi(value: String): AttendanceExemptionStatus =
            entries.firstOrNull { it.apiValue == value.lowercase() } ?: ACTIVE
    }
}

enum class AttendanceExemptionReasonCategory(val apiValue: String, val labelAr: String) {
    OWNER_ACCOUNT("owner_account", "حساب المالك"),
    ADMIN_ACCOUNT("admin_account", "حساب إداري"),
    FIELD_ASSIGNMENT("field_assignment", "مهمة ميدانية"),
    REMOTE_WORK("remote_work", "عمل عن بُعد"),
    MEDICAL("medical", "حالة طبية"),
    TEMPORARY_ASSIGNMENT("temporary_assignment", "تكليف مؤقت");

    companion object {
        fun fromApi(value: String): AttendanceExemptionReasonCategory? =
            entries.firstOrNull { it.apiValue == value.lowercase() }
    }
}

enum class AttendanceExemptionStatusFilter(val apiValue: String?, val labelAr: String) {
    ALL(null, "الكل"),
    ACTIVE("active", "نشط"),
    REVOKED("revoked", "ملغى")
}

data class AttendanceExemption(
    val id: String,
    val userId: String,
    val employeeId: String?,
    val validFrom: String,
    val validUntil: String?,
    val reasonCategory: AttendanceExemptionReasonCategory,
    val note: String?,
    val status: AttendanceExemptionStatus,
    val version: Int,
    val createdAt: String,
    val revokedAt: String?
) {
    val periodLabel: String
        get() = if (validUntil.isNullOrBlank()) {
            "${formatExemptionDate(validFrom)} — مفتوح"
        } else {
            "${formatExemptionDate(validFrom)} — ${formatExemptionDate(validUntil)}"
        }
}

data class AttendanceExemptionPage(
    val items: List<AttendanceExemption>,
    val nextCursor: String? = null,
    val hasMore: Boolean = false
)

data class AttendanceExemptionCreateRequest(
    val targetUserId: String,
    val validFrom: String,
    val validUntil: String?,
    val reasonCategory: AttendanceExemptionReasonCategory,
    val note: String?
)

data class AttendanceExemptionRevokeRequest(
    val reason: String,
    val expectedVersion: Int
)

data class AttendanceExemptionTarget(
    val userId: String,
    val name: String,
    val departmentName: String,
    val employeeId: String? = null
)

internal fun formatExemptionDate(isoValue: String): String {
    val normalized = isoValue.trim()
    return when {
        normalized.length >= 10 && normalized[4] == '-' && normalized[7] == '-' -> normalized.take(10)
        else -> normalized
    }
}
