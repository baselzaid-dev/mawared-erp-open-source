package com.example.domain.model

import com.example.core.permissions.PermissionChecker
import com.example.core.permissions.Permissions
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PayrollWorkflowRulesTest {

    private fun period(status: String, legacy: Boolean = false) = PayrollPeriodParams(
        id = "period",
        companyId = "company",
        month = 7,
        year = 2026,
        status = status,
        legacyWithoutItems = legacy
    )

    @Test
    fun `raw status exposes only valid workflow actions`() {
        val draft = period("draft")
        assertTrue(draft.canCalculate())
        assertFalse(draft.canApprove())
        assertFalse(draft.canMarkPaid())
        assertFalse(draft.canReport())

        val calculated = period("calculated")
        assertTrue(calculated.canCalculate())
        assertTrue(calculated.canApprove())
        assertFalse(calculated.canMarkPaid())

        val approved = period("approved")
        assertFalse(approved.canCalculate())
        assertTrue(approved.canMarkPaid())
        assertTrue(approved.canReport())

        val paid = period("paid")
        assertFalse(paid.canCalculate())
        assertFalse(paid.canMarkPaid())
        assertTrue(paid.canReport())
    }

    @Test
    fun `legacy approved state is explicit and never represented by a zero total`() {
        val legacy = period("approved", legacy = true)
        assertTrue(legacy.legacyWithoutItems)
        assertTrue(legacy.visibleSummary == null)
    }

    @Test
    fun `payroll domain stores no money as Double or Float`() {
        val payrollClasses = listOf(
            PayrollMoneySummary::class.java,
            PayrollItemParams::class.java,
            PayrollItemsResult::class.java,
            PayrollCalculationResult::class.java,
            PayrollReportParams::class.java,
            PayrollSummary::class.java,
            PayrollPaymentParams::class.java,
            PayrollRecordPaymentRequest::class.java
        )
        payrollClasses.flatMap { it.declaredFields.toList() }.forEach { field ->
            assertNotEquals("Double money field: ${field.name}", Double::class.javaPrimitiveType, field.type)
            assertNotEquals("Float money field: ${field.name}", Float::class.javaPrimitiveType, field.type)
        }
    }

    @Test
    fun `approval payment and protected data notices state the safety rules`() {
        assertTrue(PAYROLL_SECOND_PERSON_NOTICE.contains("شخصاً مختلفاً"))
        assertTrue(PAYROLL_ADMIN_PAID_WARNING.contains("لا يمثل إثبات تحويل بنكي"))
        assertTrue(PAYROLL_PROTECTED_DATA_NOTICE.contains("محمية غير ظاهرة"))
    }

    @Test
    fun `report and pay permissions remain independent`() {
        val reportOnly = PermissionChecker(setOf(Permissions.PAYROLL_REPORT))
        assertTrue(reportOnly.hasPermission(Permissions.PAYROLL_REPORT))
        assertFalse(reportOnly.hasPermission(Permissions.PAYROLL_PAY))
        assertFalse(reportOnly.hasPermission(Permissions.PAYROLL_MANAGE))

        val payOnly = PermissionChecker(setOf(Permissions.PAYROLL_PAY))
        assertTrue(payOnly.hasPermission(Permissions.PAYROLL_PAY))
        assertFalse(payOnly.hasPermission(Permissions.PAYROLL_REPORT))
    }
}
