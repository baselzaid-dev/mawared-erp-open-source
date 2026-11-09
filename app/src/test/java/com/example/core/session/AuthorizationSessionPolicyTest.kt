package com.example.core.session

import com.example.domain.model.CurrentSession
import com.example.domain.model.EffectiveAuthorization
import com.example.domain.model.EffectiveCapability
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthorizationSessionPolicyTest {
    private fun session(
        userId: String = "user-1",
        companyId: String = "company-1",
        permissions: Set<String> = setOf("employees.view"),
        authorizationVersion: Int = 1
    ) = CurrentSession(
        companyId = companyId,
        companyCode = "CMP-DEMO",
        companyName = "Demo",
        userId = userId,
        employeeId = "employee-1",
        roleId = "role-1",
        departmentId = null,
        permissions = permissions,
        authorizationVersion = authorizationVersion
    )

    private fun effective(
        userId: String = "user-1",
        authorizationVersion: Int = 2,
        flatPermissions: List<String> = listOf("employees.view", "hr.manage"),
        capabilities: List<EffectiveCapability> = emptyList()
    ) = EffectiveAuthorization(
        userId = userId,
        authorizationVersion = authorizationVersion,
        isPrimaryOwner = false,
        managedDepartmentIds = emptyList(),
        capabilities = capabilities,
        flatPermissions = flatPermissions
    )

    @Test
    fun `identity key changes require hard reset`() {
        assertTrue(
            AuthorizationSessionPolicy.shouldHardReset(
                "company-1:user-1",
                session(userId = "user-2")
            )
        )
        assertFalse(
            AuthorizationSessionPolicy.shouldHardReset(
                "company-1:user-1",
                session()
            )
        )
        assertTrue(AuthorizationSessionPolicy.shouldHardReset("company-1:user-1", null))
    }

    @Test
    fun `same identity version bump soft updates permissions`() {
        val decision = AuthorizationSessionPolicy.decideSameIdentityRefresh(
            session(authorizationVersion = 1, permissions = setOf("employees.view")),
            effective(authorizationVersion = 2, flatPermissions = listOf("employees.view", "hr.manage"))
        )

        assertEquals(
            AuthorizationSessionPolicy.SameIdentityRefresh.Update(
                authorizationVersion = 2,
                permissions = setOf("employees.view", "hr.manage")
            ),
            decision
        )
    }

    @Test
    fun `same identity and same snapshot is a no-op`() {
        val decision = AuthorizationSessionPolicy.decideSameIdentityRefresh(
            session(authorizationVersion = 2, permissions = setOf("employees.view", "hr.manage")),
            effective(authorizationVersion = 2, flatPermissions = listOf("employees.view", "hr.manage"))
        )
        assertEquals(AuthorizationSessionPolicy.SameIdentityRefresh.None, decision)
    }

    @Test
    fun `effective user mismatch fails closed`() {
        val decision = AuthorizationSessionPolicy.decideSameIdentityRefresh(
            session(),
            effective(userId = "other-user")
        )
        assertEquals(AuthorizationSessionPolicy.SameIdentityRefresh.IdentityMismatch, decision)
    }

    @Test
    fun `same identity permission strip soft updates to empty set`() {
        val decision = AuthorizationSessionPolicy.decideSameIdentityRefresh(
            session(authorizationVersion = 2, permissions = setOf("admin.full")),
            effective(
                authorizationVersion = 3,
                flatPermissions = emptyList(),
                capabilities = listOf(
                    EffectiveCapability("tasks.review", "department", "dept-1", "grant")
                )
            )
        )
        assertEquals(
            AuthorizationSessionPolicy.SameIdentityRefresh.Update(
                authorizationVersion = 3,
                permissions = emptySet()
            ),
            decision
        )
    }

    @Test
    fun `flatPermissions list is authoritative even when capabilities exist`() {
        val derived = AuthorizationSessionPolicy.effectivePermissions(
            effective(
                flatPermissions = listOf("employees.view"),
                capabilities = listOf(
                    EffectiveCapability("admin.full", "company", null, "role"),
                    EffectiveCapability("tasks.review", "department", "dept-1", "grant")
                )
            )
        )
        assertEquals(setOf("employees.view"), derived)
    }
}
