package com.example.ui

import com.example.core.permissions.Permissions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SalaryManagementRulesTest {
    @Test
    fun `HR can manage non-owner and owner only with owner permission`() {
        val hr = setOf(Permissions.SALARY_VIEW_COMPANY, Permissions.SALARY_MANAGE)
        val hrOwner = hr + Permissions.SALARY_VIEW_OWNER

        assertTrue(canViewSalaryForTarget(hr, "Employee"))
        assertTrue(canManageSalaryForTarget(hr, "Employee"))
        assertFalse(canViewSalaryForTarget(hr, "Admin"))
        assertFalse(canManageSalaryForTarget(hr, "Admin"))
        assertTrue(canViewSalaryForTarget(hrOwner, "Admin"))
        assertTrue(canManageSalaryForTarget(hrOwner, "Admin"))
    }

    @Test
    fun `admin full cannot bypass owner salary privacy`() {
        val admin = setOf(Permissions.ADMIN_FULL)
        assertTrue(canViewSalaryForTarget(admin, "Employee"))
        assertTrue(canManageSalaryForTarget(admin, "Employee"))
        assertFalse(canViewSalaryForTarget(admin, "Admin"))
        assertFalse(canManageSalaryForTarget(admin, "المدير العام"))
    }

    @Test
    fun `Finance is read-only and employee manager accountant remain hidden`() {
        val finance = setOf(Permissions.SALARY_VIEW_COMPANY)
        assertTrue(canViewSalaryForTarget(finance, "Employee"))
        assertFalse(canManageSalaryForTarget(finance, "Employee"))
        assertFalse(canViewSalaryForTarget(emptySet(), "Employee"))
        assertFalse(canManageSalaryForTarget(emptySet(), "Employee"))
    }

    @Test
    fun `missing salary has a truthful Arabic state without fake zero`() {
        assertEquals("لم يتم تحديد الراتب", salaryDisplayText(null))
        assertFalse(salaryDisplayText(null).contains("0"))
        assertTrue(formatSalaryAmount("2500.25").contains("SAR"))
    }

    @Test
    fun `salary input accepts at most two decimals and the approved bound`() {
        assertTrue(isValidSalaryAmount("0"))
        assertTrue(isValidSalaryAmount("2500.25"))
        assertTrue(isValidSalaryAmount("10000000.00"))
        assertFalse(isValidSalaryAmount("-1"))
        assertFalse(isValidSalaryAmount("1.234"))
        assertFalse(isValidSalaryAmount("10000000.01"))
        assertFalse(isValidSalaryAmount("1e3"))
    }
}
