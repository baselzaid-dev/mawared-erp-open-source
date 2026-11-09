package com.example.core.permissions

import com.example.core.session.SessionManager
import com.example.core.utils.AppResult
import com.example.data.repository.mock.MockAuthRepository
import com.example.domain.model.AuthLoginResult
import com.example.domain.model.CurrentSession
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the contract that demo/mock users only ever receive CANONICAL
 * permission keys (backend/src/permissions.ts ⇔ Permissions.kt). This is the
 * test that would have caught the old mismatch where demo users held
 * "hr.employee.view" while screens checked "employees.view".
 */
class CanonicalPermissionsTest {

    private val demoEmails = listOf(
        "a.otaibi@fixture-1.example.test",
        "s.ghamdi@fixture-1.example.test",
        "r.shammari@fixture-1.example.test",
        "b.yousef@fixture-1.example.test"
    )

    private fun session(result: AppResult<*>): CurrentSession =
        ((result as AppResult.Success).data as AuthLoginResult.Authenticated).session

    @Test
    fun `every demo user permission is a canonical key`() = runTest {
        val repo = MockAuthRepository(SessionManager())
        demoEmails.forEach { email ->
            val result = repo.login("CMP-DEMO", email, "1234")
            assertTrue("demo login must succeed for $email", result is AppResult.Success)
            val permissions = session(result).permissions
            assertTrue("demo user $email must have permissions", permissions.isNotEmpty())
            val unknown = permissions - Permissions.all
            assertTrue(
                "non-canonical keys for $email: $unknown",
                unknown.isEmpty()
            )
        }
    }

    @Test
    fun `no demo user holds the super-admin key`() = runTest {
        val repo = MockAuthRepository(SessionManager())
        demoEmails.forEach { email ->
            val result = repo.login("CMP-DEMO", email, "1234") as AppResult.Success
            assertFalse(
                "demo user $email must not be super admin",
                session(result).permissions.contains(Permissions.ADMIN_FULL)
            )
        }
    }

    @Test
    fun `demo permission sets keep the module gates working`() = runTest {
        val repo = MockAuthRepository(SessionManager())

        // HR manager: can view/create employees, approve leaves, calculate payroll.
        val hr = session(repo.login("CMP-DEMO", "a.otaibi@fixture-1.example.test", "1234"))
        val hrChecker = PermissionChecker(hr.permissions)
        assertTrue(hrChecker.hasPermission(Permissions.EMPLOYEES_VIEW))
        assertTrue(hrChecker.hasPermission(Permissions.EMPLOYEES_CREATE))
        assertTrue(hrChecker.hasPermission(Permissions.LEAVES_APPROVE))
        assertTrue(hrChecker.hasPermission(Permissions.PAYROLL_MANAGE))
        assertTrue(hrChecker.hasPermission(Permissions.PAYROLL_REPORT))
        assertTrue(hrChecker.hasPermission(Permissions.SALARY_VIEW_COMPANY))
        assertTrue(hrChecker.hasPermission(Permissions.SALARY_MANAGE))
        assertTrue(hrChecker.hasExactPermission(Permissions.SALARY_VIEW_OWNER))
        assertTrue(hrChecker.hasPermission(Permissions.TASKS_VIEW_COMPANY))
        assertTrue(hrChecker.hasPermission(Permissions.TASKS_CREATE))
        assertTrue(hrChecker.hasPermission(Permissions.TASKS_ASSIGN_COMPANY))
        assertTrue(hrChecker.hasPermission(Permissions.TASKS_REVIEW))
        assertTrue(hrChecker.hasExactPermission(Permissions.REPORTS_EXPORT))
        assertFalse(hrChecker.hasPermission(Permissions.PAYROLL_APPROVE)) // separation of duties
        assertFalse(hrChecker.hasPermission(Permissions.PURCHASING_VIEW))

        // Finance manager: approves payroll, views financial reports; no HR write.
        val fin = session(repo.login("CMP-DEMO", "s.ghamdi@fixture-1.example.test", "1234"))
        val finChecker = PermissionChecker(fin.permissions)
        assertTrue(finChecker.hasPermission(Permissions.PAYROLL_APPROVE))
        assertTrue(finChecker.hasPermission(Permissions.PAYROLL_MANAGE))
        assertTrue(finChecker.hasPermission(Permissions.PAYROLL_REPORT))
        assertTrue(finChecker.hasPermission(Permissions.PAYROLL_PAY))
        assertTrue(finChecker.hasPermission(Permissions.REPORTS_FINANCE))
        assertTrue(finChecker.hasExactPermission(Permissions.REPORTS_EXPORT))
        assertTrue(finChecker.hasPermission(Permissions.SALARY_VIEW_COMPANY))
        assertFalse(finChecker.hasPermission(Permissions.SALARY_MANAGE))
        assertFalse(finChecker.hasExactPermission(Permissions.SALARY_VIEW_OWNER))
        assertFalse(finChecker.hasPermission(Permissions.EMPLOYEES_CREATE))

        // Purchasing officer: purchasing + vendors only.
        val pur = session(repo.login("CMP-DEMO", "r.shammari@fixture-1.example.test", "1234"))
        val purChecker = PermissionChecker(pur.permissions)
        assertTrue(purChecker.hasPermission(Permissions.PURCHASING_CREATE))
        assertTrue(purChecker.hasPermission(Permissions.PURCHASING_APPROVE))
        assertTrue(purChecker.hasPermission(Permissions.PURCHASING_MANAGE))
        assertTrue(purChecker.hasPermission(Permissions.PURCHASING_RECEIVE))
        assertTrue(purChecker.hasPermission(Permissions.VENDORS_MANAGE))
        assertTrue(purChecker.hasExactPermission(Permissions.REPORTS_EXPORT))
        assertFalse(purChecker.hasPermission(Permissions.EMPLOYEES_VIEW))
        assertFalse(purChecker.hasPermission(Permissions.LEAVES_APPROVE))

        // Regular employee: self-service scopes open the view screens.
        val emp = session(repo.login("CMP-DEMO", "b.yousef@fixture-1.example.test", "1234"))
        val empChecker = PermissionChecker(emp.permissions)
        assertTrue(empChecker.hasPermission(Permissions.ATTENDANCE_VIEW)) // via view_own fallback
        assertTrue(empChecker.hasPermission(Permissions.LEAVES_VIEW)) // via view_own fallback
        assertTrue(empChecker.hasPermission(Permissions.ATTENDANCE_CLOCK))
        assertTrue(empChecker.hasPermission(Permissions.LEAVES_CREATE))
        assertTrue(empChecker.hasPermission(Permissions.CHAT_VIEW))
        assertTrue(empChecker.hasPermission(Permissions.TASKS_VIEW_OWN))
        assertTrue(empChecker.hasPermission(Permissions.PURCHASING_VIEW))
        assertTrue(empChecker.hasPermission(Permissions.PURCHASING_CREATE))
        assertFalse(empChecker.hasPermission(Permissions.TASKS_CREATE))
        assertFalse(empChecker.hasPermission(Permissions.TASKS_REVIEW))
        assertFalse(empChecker.hasPermission(Permissions.ATTENDANCE_MANAGE))
        assertFalse(empChecker.hasPermission(Permissions.LEAVES_APPROVE))
        assertFalse(empChecker.hasPermission(Permissions.PAYROLL_VIEW))
        assertFalse(empChecker.hasPermission(Permissions.SALARY_VIEW_COMPANY))
        assertFalse(empChecker.hasExactPermission(Permissions.REPORTS_EXPORT))
    }
}
