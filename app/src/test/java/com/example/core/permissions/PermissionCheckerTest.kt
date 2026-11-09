package com.example.core.permissions

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PermissionCheckerTest {

    @Test
    fun `admin_full passes every canonical permission check`() {
        val checker = PermissionChecker(setOf(Permissions.ADMIN_FULL))
        Permissions.all.forEach { key ->
            assertTrue("admin.full must grant $key", checker.hasPermission(key))
        }
    }

    @Test
    fun `empty permission set grants nothing - role display names are irrelevant`() {
        // The old checker granted EVERYTHING when the role NAME was
        // "Admin" or "المدير". That bypass is removed: PermissionChecker no
        // longer even accepts a role name — a user whose role is displayed as
        // Admin/المدير but has no permission keys gets nothing.
        val checker = PermissionChecker(emptySet())
        Permissions.all.forEach { key ->
            assertFalse("no keys must mean no access ($key)", checker.hasPermission(key))
        }
    }

    @Test
    fun `module keys grant exactly their module`() {
        val checker = PermissionChecker(
            setOf(Permissions.EMPLOYEES_VIEW, Permissions.LEAVES_APPROVE)
        )
        assertTrue(checker.hasPermission(Permissions.EMPLOYEES_VIEW))
        assertTrue(checker.hasPermission(Permissions.LEAVES_APPROVE))

        assertFalse(checker.hasPermission(Permissions.EMPLOYEES_CREATE))
        assertFalse(checker.hasPermission(Permissions.EMPLOYEES_MANAGE))
        assertFalse(checker.hasPermission(Permissions.ATTENDANCE_VIEW))
        assertFalse(checker.hasPermission(Permissions.PAYROLL_VIEW))
        assertFalse(checker.hasPermission(Permissions.PURCHASING_VIEW))
        assertFalse(checker.hasPermission(Permissions.REPORTS_VIEW))
        assertFalse(checker.hasPermission(Permissions.CHAT_VIEW))
        assertFalse(checker.hasPermission(Permissions.ADMIN_FULL))
    }

    @Test
    fun `scoped own or department keys open the corresponding view`() {
        val own = PermissionChecker(
            setOf(Permissions.ATTENDANCE_VIEW_OWN, Permissions.LEAVES_VIEW_OWN)
        )
        assertTrue(own.hasPermission(Permissions.ATTENDANCE_VIEW))
        assertTrue(own.hasPermission(Permissions.LEAVES_VIEW))
        assertFalse(own.hasPermission(Permissions.ATTENDANCE_MANAGE))
        assertFalse(own.hasPermission(Permissions.LEAVES_APPROVE))

        val dept = PermissionChecker(setOf(Permissions.EMPLOYEES_VIEW_DEPARTMENT))
        assertTrue(dept.hasPermission(Permissions.EMPLOYEES_VIEW))
        assertFalse(dept.hasPermission(Permissions.EMPLOYEES_CREATE))
    }

    @Test
    fun `hasAnyPermission and hasAllPermissions behave as expected`() {
        val checker = PermissionChecker(setOf(Permissions.PAYROLL_VIEW))
        assertTrue(checker.hasAnyPermission(listOf(Permissions.PAYROLL_VIEW, Permissions.FINANCE_VIEW)))
        assertFalse(checker.hasAnyPermission(listOf(Permissions.FINANCE_VIEW, Permissions.ADMIN_FULL)))
        assertTrue(checker.hasAllPermissions(listOf(Permissions.PAYROLL_VIEW)))
        assertFalse(checker.hasAllPermissions(listOf(Permissions.PAYROLL_VIEW, Permissions.PAYROLL_APPROVE)))
    }

    @Test
    fun `checker aliases resolve to canonical keys`() {
        val checker = PermissionChecker(emptySet())
        assertTrue(checker.HR_EMPLOYEE_VIEW == Permissions.EMPLOYEES_VIEW)
        assertTrue(checker.HR_PAYROLL_CALCULATE == Permissions.PAYROLL_MANAGE)
        assertTrue(checker.PAYROLL_REPORT == Permissions.PAYROLL_REPORT)
        assertTrue(checker.PAYROLL_PAY == Permissions.PAYROLL_PAY)
        assertTrue(checker.PURCHASING_REQUEST_APPROVE == Permissions.PURCHASING_APPROVE)
        assertTrue(checker.ADMIN_ROLES_MANAGE == Permissions.ADMIN_FULL)
        assertTrue(checker.SYSTEM_CHAT_USE == Permissions.CHAT_VIEW)
        // Every alias value must be canonical.
        listOf(
            checker.HR_EMPLOYEE_VIEW, checker.HR_EMPLOYEE_CREATE, checker.HR_EMPLOYEE_UPDATE,
            checker.HR_EMPLOYEE_DELETE, checker.HR_ATTENDANCE_VIEW, checker.HR_ATTENDANCE_MANAGE,
            checker.HR_ATTENDANCE_CLOCK, checker.HR_ATTENDANCE_APPROVE, checker.HR_LEAVE_VIEW,
            checker.HR_LEAVE_CREATE, checker.HR_LEAVE_APPROVE, checker.HR_LEAVE_MANAGE,
            checker.HR_PAYROLL_VIEW, checker.HR_PAYROLL_CALCULATE, checker.HR_PAYROLL_APPROVE,
            checker.PAYROLL_REPORT, checker.PAYROLL_PAY,
            checker.PURCHASING_REQUEST_VIEW, checker.PURCHASING_REQUEST_VIEW_OWN,
            checker.PURCHASING_REQUEST_VIEW_DEPARTMENT, checker.PURCHASING_REQUEST_CREATE,
            checker.PURCHASING_DEPARTMENT_REVIEW, checker.PURCHASING_REQUEST_APPROVE,
            checker.PURCHASING_ORDER_MANAGE, checker.PURCHASING_ORDER_RECEIVE, checker.PURCHASING_REPORT,
            checker.PURCHASING_SUPPLIER_VIEW, checker.PURCHASING_SUPPLIER_MANAGE,
            checker.FINANCE_PAYROLL_VIEW, checker.FINANCE_PAYROLL_APPROVE,
            checker.FINANCE_REPORTS_VIEW, checker.REPORTS_VIEW, checker.REPORTS_FINANCIAL_VIEW,
            checker.ADMIN_USERS_MANAGE, checker.ADMIN_ROLES_MANAGE, checker.ADMIN_COMPANY_MANAGE,
            checker.CHAT_FINANCE_VIEW, checker.CHAT_HR_VIEW, checker.SYSTEM_CHAT_USE,
            checker.SYSTEM_AI_USE, checker.TASKS_VIEW_OWN, checker.TASKS_VIEW_DEPARTMENT,
            checker.TASKS_VIEW_COMPANY, checker.TASKS_CREATE, checker.TASKS_ASSIGN_DEPARTMENT,
            checker.TASKS_ASSIGN_COMPANY, checker.TASKS_REVIEW
        ).forEach { alias ->
            assertTrue("alias value '$alias' must be canonical", Permissions.all.contains(alias))
        }
    }
}
