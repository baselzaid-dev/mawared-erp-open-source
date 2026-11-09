package com.example.core.session

import com.example.domain.model.CurrentSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Regression guard: an app restart must require company-bound local unlock. */
class SessionRestoreGateTest {
    private class InMemoryStore(private var session: CurrentSession?) : SessionStore {
        override fun save(session: CurrentSession) { this.session = session }
        override fun load(): CurrentSession? = session
        override fun clear() { session = null }
    }

    private fun session() = CurrentSession(
        companyId = "c1",
        companyCode = "CMP-DEMO",
        companyName = "Mawared Demo",
        userId = "u1",
        employeeId = "e1",
        roleId = "r1",
        departmentId = null,
        permissions = setOf("employees.view"),
        token = "access",
        refreshToken = "refresh",
        email = "admin@example.test",
        name = "Admin User",
        role = "Admin"
    )

    @Test
    fun `persisted session does not bypass the startup authentication gate`() {
        val manager = SessionManager(InMemoryStore(session()))

        assertNull(manager.currentSession.value)
        assertEquals("CMP-DEMO", manager.rememberedSession.value?.companyCode)
    }

    @Test
    fun `startup gate opens only for matching company code`() {
        val manager = SessionManager(InMemoryStore(session()))

        assertNull(manager.unlockRememberedSession("CMP-OTHER"))
        assertEquals("u1", manager.unlockRememberedSession("CMP-DEMO")?.userId)
    }

    @Test
    fun `no persisted session leaves the gate closed`() {
        val manager = SessionManager(InMemoryStore(null))
        assertNull(manager.currentSession.value)
        assertNull(manager.rememberedSession.value)
    }
}
