package com.example.core.session

import com.example.domain.model.CurrentSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private class FakeSessionStore(var stored: CurrentSession? = null) : SessionStore {
    var saveCount = 0
    var clearCount = 0

    override fun save(session: CurrentSession) {
        stored = session
        saveCount++
    }

    override fun load(): CurrentSession? = stored

    override fun clear() {
        stored = null
        clearCount++
    }
}

private fun session(
    userId: String = "u1",
    companyId: String = "c1",
    companyCode: String = "CMP-DEMO",
    mfaProtected: Boolean = false
) = CurrentSession(
    companyId = companyId,
    companyCode = companyCode,
    companyName = "Test Company",
    userId = userId,
    employeeId = "e1",
    roleId = "r1",
    departmentId = null,
    permissions = setOf("employees.view"),
    token = "access-token",
    refreshToken = "refresh-token",
    email = "user@company.test",
    name = "Test User",
    role = "Employee",
    mfaProtected = mfaProtected
)

class SessionManagerTest {
    @Test
    fun `restored session is remembered but remains locked`() {
        val manager = SessionManager(FakeSessionStore(stored = session("restored-user")))

        assertNull(manager.currentSession.value)
        assertEquals("restored-user", manager.rememberedSession.value?.userId)
    }

    @Test
    fun `exact normalized company code unlocks remembered session`() {
        val manager = SessionManager(FakeSessionStore(stored = session()))

        val unlocked = manager.unlockRememberedSession(" cmp-demo ")

        assertEquals("u1", unlocked?.userId)
        assertEquals("u1", manager.currentSession.value?.userId)
    }

    @Test
    fun `different company code cannot unlock remembered session`() {
        val manager = SessionManager(FakeSessionStore(stored = session()))

        assertNull(manager.unlockRememberedSession("CMP-OTHER"))
        assertNull(manager.currentSession.value)
        assertEquals("CMP-DEMO", manager.rememberedSession.value?.companyCode)
    }

    @Test
    fun `protected owner session never unlocks with biometrics alone`() {
        val manager = SessionManager(
            FakeSessionStore(stored = session(mfaProtected = true))
        )

        assertNull(manager.unlockRememberedSession("CMP-DEMO"))
        assertNull(manager.currentSession.value)
        assertEquals("u1", manager.rememberedSession.value?.userId)
    }

    @Test
    fun `updateSession persists and activates the session`() {
        val store = FakeSessionStore()
        val manager = SessionManager(store)

        manager.updateSession(session())

        assertEquals(1, store.saveCount)
        assertEquals("u1", manager.currentSession.value?.userId)
        assertEquals("u1", manager.rememberedSession.value?.userId)
    }

    @Test
    fun `switching company replaces active and remembered tenant context`() {
        val manager = SessionManager(FakeSessionStore())
        manager.updateSession(session())

        manager.updateSession(session("u2", "c2", "CMP-BRANCH"))

        assertEquals("c2", manager.currentSession.value?.companyId)
        assertEquals("CMP-BRANCH", manager.rememberedSession.value?.companyCode)
    }

    @Test
    fun `clearSession wipes memory and storage`() {
        val store = FakeSessionStore(stored = session())
        val manager = SessionManager(store)
        manager.unlockRememberedSession("CMP-DEMO")

        manager.clearSession()

        assertNull(manager.currentSession.value)
        assertNull(manager.rememberedSession.value)
        assertNull(store.stored)
        assertEquals(1, store.clearCount)
    }

    @Test
    fun `updateSession with null clears persisted session`() {
        val store = FakeSessionStore(stored = session())
        val manager = SessionManager(store)

        manager.updateSession(null)

        assertNull(manager.currentSession.value)
        assertNull(manager.rememberedSession.value)
        assertNull(store.stored)
    }

    @Test
    fun `works memory-only without a store`() {
        val manager = SessionManager()
        manager.updateSession(session())

        assertEquals("u1", manager.currentSession.value?.userId)
        manager.clearSession()
        assertNull(manager.currentSession.value)
    }
}
