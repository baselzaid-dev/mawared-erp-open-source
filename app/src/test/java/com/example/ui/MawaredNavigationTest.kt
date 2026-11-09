package com.example.ui

import com.example.core.permissions.Permissions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MawaredNavigationTest {

    @Test
    fun `employee sees self-service destinations and attendance stays primary`() {
        val permissions = setOf(
            Permissions.DASHBOARD_SELF,
            Permissions.EMPLOYEES_VIEW,
            Permissions.ATTENDANCE_VIEW_OWN,
            Permissions.ATTENDANCE_CLOCK,
            Permissions.LEAVES_VIEW_OWN,
            Permissions.LEAVES_CREATE,
            Permissions.TASKS_VIEW_OWN,
            Permissions.TRAINING_VIEW_OWN,
            Permissions.PURCHASING_VIEW_OWN,
            Permissions.PURCHASING_CREATE,
            Permissions.CHAT_VIEW
        )

        val visibleTabs = visibleTabs(permissions)
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_DASHBOARD))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_ATTENDANCE))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_LEAVES))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_TASKS))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_TRAINING))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_CHAT))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_AI_ASSISTANT))
        assertFalse(visibleTabs.contains(MawaredNavigation.TAB_EMPLOYEES))
        assertFalse(visibleTabs.contains(MawaredNavigation.TAB_PAYROLL))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_PURCHASING))
        assertFalse(visibleTabs.contains(MawaredNavigation.TAB_REPORTS))
        assertFalse(visibleTabs.contains(MawaredNavigation.TAB_SUPPORT))
        assertFalse(visibleTabs.contains(MawaredNavigation.TAB_AUTHORIZATION))

        assertEquals(
            listOf(
                MawaredNavigation.TAB_ATTENDANCE,
                MawaredNavigation.TAB_LEAVES,
                MawaredNavigation.TAB_TASKS,
                MawaredNavigation.TAB_TRAINING,
                MawaredNavigation.TAB_CHAT
            ),
            bottomTabs(permissions)
        )
        assertEquals(MawaredNavigation.TAB_ATTENDANCE, MawaredNavigation.defaultTab(permissions))
    }

    @Test
    fun `department manager receives scoped destinations without role-name checks`() {
        val permissions = setOf(
            Permissions.EMPLOYEES_VIEW_DEPARTMENT,
            Permissions.ATTENDANCE_VIEW_DEPARTMENT,
            Permissions.LEAVES_VIEW,
            Permissions.TASKS_VIEW_DEPARTMENT,
            Permissions.TRAINING_VIEW_OWN,
            Permissions.TRAINING_VIEW_DEPARTMENT,
            Permissions.TRAINING_REPORT,
            Permissions.REPORTS_VIEW,
            Permissions.CHAT_VIEW
        )

        val visibleTabs = visibleTabs(permissions)
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_EMPLOYEES))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_ATTENDANCE))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_LEAVES))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_REPORTS))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_TASKS))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_TRAINING))
        assertFalse(visibleTabs.contains(MawaredNavigation.TAB_PAYROLL))
        assertFalse(visibleTabs.contains(MawaredNavigation.TAB_PURCHASING))
        assertFalse(visibleTabs.contains(MawaredNavigation.TAB_SUPPORT))
    }

    @Test
    fun `hr permissions expose HR operations but not unrelated modules`() {
        val permissions = setOf(
            Permissions.HR_VIEW,
            Permissions.HR_MANAGE,
            Permissions.EMPLOYEES_VIEW,
            Permissions.ATTENDANCE_VIEW,
            Permissions.LEAVES_VIEW,
            Permissions.PAYROLL_VIEW,
            Permissions.TASKS_VIEW_COMPANY,
            Permissions.TRAINING_VIEW_COMPANY,
            Permissions.TRAINING_MANAGE,
            Permissions.TRAINING_ASSIGN,
            Permissions.TRAINING_REVIEW,
            Permissions.TRAINING_REPORT,
            Permissions.REPORTS_VIEW
        )

        val visibleTabs = visibleTabs(permissions)
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_EMPLOYEES))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_ATTENDANCE))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_LEAVES))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_PAYROLL))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_TASKS))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_TRAINING))
        assertTrue(visibleTabs.contains(MawaredNavigation.TAB_REPORTS))
        assertFalse(visibleTabs.contains(MawaredNavigation.TAB_PURCHASING))
        assertFalse(visibleTabs.contains(MawaredNavigation.TAB_CHAT))
        assertFalse(visibleTabs.contains(MawaredNavigation.TAB_AI_ASSISTANT))
        assertFalse(visibleTabs.contains(MawaredNavigation.TAB_SUPPORT))
    }

    @Test
    fun `admin full exposes management drawer destinations and only five bottom items`() {
        val permissions = setOf(Permissions.ADMIN_FULL)

        // Notifications are bell-only — present in destinations metadata but not drawer/bottom.
        assertEquals(
            MawaredNavigation.destinations
                .map { it.tabIndex }
                .filter { it != MawaredNavigation.TAB_NOTIFICATIONS }
                .toSet(),
            visibleTabs(permissions)
        )
        assertFalse(visibleTabs(permissions).contains(MawaredNavigation.TAB_NOTIFICATIONS))
        assertFalse(visibleTabs(permissions).contains(MawaredNavigation.TAB_SUPPORT))
        assertFalse(bottomTabs(permissions).contains(MawaredNavigation.TAB_NOTIFICATIONS))
        assertEquals(
            listOf(
                MawaredNavigation.TAB_DASHBOARD,
                MawaredNavigation.TAB_ATTENDANCE,
                MawaredNavigation.TAB_LEAVES,
                MawaredNavigation.TAB_EMPLOYEES,
                MawaredNavigation.TAB_PAYROLL
            ),
            bottomTabs(permissions)
        )
        assertEquals(
            MawaredNavigation.MAX_BOTTOM_DESTINATIONS,
            MawaredNavigation.bottomDestinations(permissions).size
        )
    }

    @Test
    fun `notifications are bell-only not drawer or bottom bar`() {
        val withNotifications = setOf(Permissions.NOTIFICATIONS_VIEW, Permissions.ADMIN_FULL)
        assertFalse(visibleTabs(withNotifications).contains(MawaredNavigation.TAB_NOTIFICATIONS))
        assertFalse(bottomTabs(withNotifications).contains(MawaredNavigation.TAB_NOTIFICATIONS))
        // Still a valid tab when opened from the toolbar bell / typed notifications.inbox
        assertTrue(
            MawaredNavigation.isTabVisible(MawaredNavigation.TAB_NOTIFICATIONS, withNotifications)
        )
        assertFalse(
            MawaredNavigation.isTabVisible(MawaredNavigation.TAB_NOTIFICATIONS, emptySet())
        )
        val notificationsDestination = MawaredNavigation.destinations
            .single { it.tabIndex == MawaredNavigation.TAB_NOTIFICATIONS }
        assertEquals(null, notificationsDestination.bottomBarPriority)
    }

    @Test
    fun `empty permissions never gain module access from a display role`() {
        // Global search is deliberately permission-free like sessions: the server
        // scopes every result source, and a no-permission caller gets empty pages.
        assertEquals(
            setOf(
                MawaredNavigation.TAB_DASHBOARD,
                MawaredNavigation.TAB_SECURITY_SESSIONS,
                MawaredNavigation.TAB_GLOBAL_SEARCH
            ),
            visibleTabs(emptySet())
        )
        assertEquals(
            listOf(MawaredNavigation.TAB_DASHBOARD),
            bottomTabs(emptySet())
        )
    }

    @Test
    fun `security sessions destination is available to every authenticated session`() {
        assertTrue(visibleTabs(emptySet()).contains(MawaredNavigation.TAB_SECURITY_SESSIONS))
        assertTrue(
            visibleTabs(setOf(Permissions.DASHBOARD_SELF, Permissions.ATTENDANCE_CLOCK))
                .contains(MawaredNavigation.TAB_SECURITY_SESSIONS)
        )
    }

    @Test
    fun `reports export alone never grants report visibility`() {
        assertFalse(
            visibleTabs(setOf(Permissions.REPORTS_EXPORT))
                .contains(MawaredNavigation.TAB_REPORTS)
        )
        assertTrue(
            visibleTabs(setOf(Permissions.PURCHASING_REPORT, Permissions.REPORTS_EXPORT))
                .contains(MawaredNavigation.TAB_REPORTS)
        )
    }

    @Test
    fun `legacy HR permission alone does not expose Training`() {
        val permissions = setOf(Permissions.HR_MANAGE)
        assertFalse(visibleTabs(permissions).contains(MawaredNavigation.TAB_TRAINING))
    }

    @Test
    fun `authorization destination requires explicit management capability`() {
        assertFalse(visibleTabs(setOf(Permissions.EMPLOYEES_VIEW)).contains(MawaredNavigation.TAB_AUTHORIZATION))
        assertTrue(
            visibleTabs(setOf(Permissions.PERMISSIONS_MANAGE_DEPARTMENT))
                .contains(MawaredNavigation.TAB_AUTHORIZATION)
        )
        assertTrue(
            visibleTabs(setOf(Permissions.COMPANY_OWNER_TRANSFER))
                .contains(MawaredNavigation.TAB_AUTHORIZATION)
        )
    }

    @Test
    fun `every navigation requirement is canonical`() {
        MawaredNavigation.destinations
            .flatMap { it.requiredPermissions }
            .forEach { permission ->
                assertTrue(
                    "Navigation permission '$permission' must be canonical",
                    Permissions.all.contains(permission)
                )
            }
    }

    private fun visibleTabs(permissions: Set<String>): Set<Int> =
        MawaredNavigation.visibleDestinations(permissions).map { it.tabIndex }.toSet()

    private fun bottomTabs(permissions: Set<String>): List<Int> =
        MawaredNavigation.bottomDestinations(permissions).map { it.tabIndex }
}
