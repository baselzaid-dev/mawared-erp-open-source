package com.example.ui

import com.example.domain.model.CurrentSession
import com.example.domain.model.EffectiveAuthorization
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Behavioral session-transition coverage for the ViewModel authorization gate:
 * login identity bind, company/user switch, logout, and same-identity version refresh.
 */
class AuthorizationSessionControllerTest {
    private fun session(
        userId: String,
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
        userId: String,
        authorizationVersion: Int,
        permissions: List<String>
    ) = EffectiveAuthorization(
        userId = userId,
        authorizationVersion = authorizationVersion,
        isPrimaryOwner = false,
        managedDepartmentIds = emptyList(),
        capabilities = emptyList(),
        flatPermissions = permissions
    )

    @Test
    fun `login then company switch then logout hard-resets in order`() {
        val controller = AuthorizationSessionController()
        val resets = mutableListOf<String>()

        assertTrue(
            controller.bindSession(session("user-a", "company-1")) {
                resets += "login-a"
            }
        )
        assertEquals("company-1:user-a", controller.activeIdentityKey)

        assertFalse(
            controller.bindSession(session("user-a", "company-1")) {
                resets += "same-identity"
            }
        )

        assertTrue(
            controller.bindSession(session("user-a", "company-2")) {
                resets += "company-switch"
            }
        )
        assertEquals("company-2:user-a", controller.activeIdentityKey)

        assertTrue(
            controller.bindSession(session("user-b", "company-2")) {
                resets += "user-switch"
            }
        )
        assertEquals("company-2:user-b", controller.activeIdentityKey)

        assertTrue(
            controller.bindSession(null) {
                resets += "logout"
            }
        )
        assertNull(controller.activeIdentityKey)

        assertEquals(
            listOf("login-a", "company-switch", "user-switch", "logout"),
            resets
        )
    }

    @Test
    fun `same identity authorizationVersion change soft-updates without hard reset`() {
        val controller = AuthorizationSessionController()
        var hardResets = 0
        var softUpdates = 0
        var latestVersion = 0
        var latestPermissions = emptySet<String>()

        controller.bindSession(session("user-a", authorizationVersion = 1)) {
            hardResets += 1
        }

        val updated = controller.ingestEffectiveAuthorization(
            session("user-a", authorizationVersion = 1, permissions = setOf("employees.view")),
            effective("user-a", 3, listOf("employees.view", "hr.manage"))
        ) { version, permissions ->
            softUpdates += 1
            latestVersion = version
            latestPermissions = permissions
        }

        assertTrue(updated)
        assertEquals(1, hardResets)
        assertEquals(1, softUpdates)
        assertEquals(3, latestVersion)
        assertEquals(setOf("employees.view", "hr.manage"), latestPermissions)
        assertEquals("company-1:user-a", controller.activeIdentityKey)
    }

    @Test
    fun `stale effective from previous identity cannot soft-update after reset`() {
        val controller = AuthorizationSessionController()
        controller.bindSession(session("user-a")) {}
        controller.bindSession(session("user-b")) {}

        val applied = controller.ingestEffectiveAuthorization(
            session("user-a"),
            effective("user-a", 9, listOf("admin.full"))
        ) { _, _ -> error("must not update") }

        assertFalse(applied)
        assertEquals("company-1:user-b", controller.activeIdentityKey)
    }

    @Test
    fun `late effective after logout is ignored`() {
        val controller = AuthorizationSessionController()
        controller.bindSession(session("user-a")) {}
        controller.bindSession(null) {}

        val applied = controller.ingestEffectiveAuthorization(
            session("user-a"),
            effective("user-a", 2, listOf("employees.view"))
        ) { _, _ -> error("must not update") }

        assertFalse(applied)
    }
}
