package com.example.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AttendanceExemptionModelsTest {
    @Test
    fun `period label shows open ended when valid until missing`() {
        val exemption = AttendanceExemption(
            id = "ex-1",
            userId = "user-1",
            employeeId = null,
            validFrom = "2026-07-01T00:00:00.000Z",
            validUntil = null,
            reasonCategory = AttendanceExemptionReasonCategory.OWNER_ACCOUNT,
            note = null,
            status = AttendanceExemptionStatus.ACTIVE,
            version = 1,
            createdAt = "2026-07-01T08:00:00.000Z",
            revokedAt = null
        )

        assertTrue(exemption.periodLabel.contains("2026-07-01"))
        assertTrue(exemption.periodLabel.contains("مفتوح"))
    }

    @Test
    fun `reason categories map from api values`() {
        assertEquals(
            AttendanceExemptionReasonCategory.FIELD_ASSIGNMENT,
            AttendanceExemptionReasonCategory.fromApi("field_assignment")
        )
        assertEquals(
            AttendanceExemptionStatus.REVOKED,
            AttendanceExemptionStatus.fromApi("revoked")
        )
    }
}
