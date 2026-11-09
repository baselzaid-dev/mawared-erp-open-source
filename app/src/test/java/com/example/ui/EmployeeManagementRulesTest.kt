package com.example.ui

import com.example.core.permissions.Permissions
import com.example.domain.model.EmployeeParams
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private fun employee(
    id: String,
    code: String,
    name: String,
    department: String
) = EmployeeParams(
    id = id,
    companyId = "c1",
    departmentId = "d-$id",
    employeeCode = code,
    fullName = name,
    jobTitle = "Engineer",
    phone = null,
    email = "$id@example.com",
    nationalIdOrIqama = null,
    basicSalary = 0.0,
    allowances = 0.0,
    deductions = 0.0,
    status = "active",
    joiningDate = "2025-01-10",
    contractType = null,
    createdAt = 0L,
    updatedAt = 0L,
    departmentName = department,
    roleId = "r1",
    roleName = "Employee"
)

class EmployeeManagementRulesTest {
    @Test
    fun `employee edit is visible only for update permission or admin`() {
        assertTrue(canEditEmployees(setOf(Permissions.EMPLOYEES_UPDATE)))
        assertTrue(canEditEmployees(setOf(Permissions.ADMIN_FULL)))
        assertFalse(canEditEmployees(setOf(Permissions.EMPLOYEES_VIEW)))
        assertFalse(canEditEmployees(emptySet()))
    }

    @Test
    fun `department management is visible only for HR management or admin`() {
        assertTrue(canManageDepartments(setOf(Permissions.HR_MANAGE)))
        assertTrue(canManageDepartments(setOf(Permissions.ADMIN_FULL)))
        assertFalse(canManageDepartments(setOf(Permissions.EMPLOYEES_UPDATE)))
        assertFalse(canManageDepartments(setOf(Permissions.EMPLOYEES_VIEW_DEPARTMENT)))
    }

    @Test
    fun `employee and department mutation permissions follow the capability matrix`() {
        val hrOnly = setOf(Permissions.HR_MANAGE)
        val employeeUpdateOnly = setOf(Permissions.EMPLOYEES_UPDATE)
        val companyPermissionManager = setOf(
            Permissions.EMPLOYEES_PERMISSIONS_MANAGE,
            Permissions.PERMISSIONS_MANAGE_COMPANY
        )
        val admin = setOf(Permissions.ADMIN_FULL)
        val ordinary = setOf(Permissions.EMPLOYEES_VIEW)

        assertFalse(canEditEmployees(hrOnly))
        assertTrue(canManageDepartments(hrOnly))
        assertFalse(canChangeEmployeeRoles(hrOnly))
        assertFalse(canManageDepartmentManagers(hrOnly))
        assertFalse(canManageCompanyPrincipals(hrOnly))

        assertTrue(canEditEmployees(employeeUpdateOnly))
        assertFalse(canManageDepartments(employeeUpdateOnly))
        assertFalse(canChangeEmployeeRoles(employeeUpdateOnly))
        assertFalse(canManageDepartmentManagers(employeeUpdateOnly))
        assertFalse(canManageCompanyPrincipals(employeeUpdateOnly))

        assertFalse(canEditEmployees(companyPermissionManager))
        assertFalse(canManageDepartments(companyPermissionManager))
        assertFalse(canChangeEmployeeRoles(companyPermissionManager))
        assertFalse(canManageDepartmentManagers(companyPermissionManager))
        assertTrue(canManageCompanyPrincipals(companyPermissionManager))

        assertTrue(canChangeEmployeeRoles(companyPermissionManager + Permissions.EMPLOYEES_UPDATE))
        assertTrue(canManageDepartmentManagers(companyPermissionManager + Permissions.HR_MANAGE))

        assertTrue(canEditEmployees(admin))
        assertTrue(canManageDepartments(admin))
        assertTrue(canChangeEmployeeRoles(admin))
        assertTrue(canManageDepartmentManagers(admin))
        assertTrue(canManageCompanyPrincipals(admin))

        assertFalse(canEditEmployees(ordinary))
        assertFalse(canManageDepartments(ordinary))
        assertFalse(canChangeEmployeeRoles(ordinary))
        assertFalse(canManageDepartmentManagers(ordinary))
        assertFalse(canManageCompanyPrincipals(ordinary))
    }

    @Test
    fun `disabled role and manager controls preserve their original values`() {
        assertEquals("role-original", employeeRoleIdForSubmission("role-original", "role-new", false))
        assertEquals("role-new", employeeRoleIdForSubmission("role-original", "role-new", true))
        assertEquals(
            "manager-original",
            departmentManagerIdForSubmission("manager-original", "manager-new", false)
        )
        assertEquals(null, departmentManagerIdForSubmission("manager-original", null, true))
    }

    @Test
    fun `submission checks use loaded state and fail closed when it cannot confirm an unchanged principal`() {
        val profileEditor = setOf(Permissions.EMPLOYEES_UPDATE)
        val hrOnly = setOf(Permissions.HR_MANAGE)
        val principalPair = setOf(
            Permissions.EMPLOYEES_PERMISSIONS_MANAGE,
            Permissions.PERMISSIONS_MANAGE_COMPANY
        )

        assertTrue(canSubmitEmployeeRole(profileEditor, "role-1", "role-1"))
        assertFalse(canSubmitEmployeeRole(profileEditor, "role-1", "role-2"))
        assertFalse(canSubmitEmployeeRole(profileEditor, null, "role-1"))
        assertTrue(canSubmitEmployeeRole(profileEditor + principalPair, "role-1", "role-2"))

        assertTrue(canSubmitDepartmentManager(hrOnly, true, "manager-1", "manager-1"))
        assertFalse(canSubmitDepartmentManager(hrOnly, true, "manager-1", "manager-2"))
        assertFalse(canSubmitDepartmentManager(hrOnly, true, null, "manager-1"))
        assertFalse(canSubmitDepartmentManager(hrOnly, false, null, null))
        assertTrue(canSubmitDepartmentManager(hrOnly + principalPair, true, "manager-1", null))
    }

    @Test
    fun `HR management permission can reach the Employees area for department management`() {
        assertTrue(
            MawaredNavigation.isTabVisible(
                MawaredNavigation.TAB_EMPLOYEES,
                setOf(Permissions.HR_MANAGE)
            )
        )
    }

    @Test
    fun `owner and admin display roles are protected in edit selector`() {
        assertTrue(isProtectedAdminRole("Admin"))
        assertTrue(isProtectedAdminRole("Owner"))
        assertTrue(isProtectedAdminRole("مالك الشركة"))
        assertTrue(isProtectedAdminRole("المدير العام"))
        assertFalse(isProtectedAdminRole("HR Manager"))
        assertFalse(isProtectedAdminRole(null))
    }

    @Test
    fun `employee search and department filtering remain functional`() {
        val employees = listOf(
            employee("1", "E-001", "Ahmed", "Engineering"),
            employee("2", "E-002", "Sara", "People")
        )

        assertEquals(listOf("1"), filterEmployeeRecords(employees, "E-001", "الكل").map { it.id })
        assertEquals(listOf("2"), filterEmployeeRecords(employees, "sara", "الكل").map { it.id })
        assertEquals(listOf("2"), filterEmployeeRecords(employees, "", "People").map { it.id })
        assertEquals(2, filterEmployeeRecords(employees, "", "الكل").size)
    }
}
