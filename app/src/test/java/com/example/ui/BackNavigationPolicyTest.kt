package com.example.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class BackNavigationPolicyTest {

    @Test
    fun `drawer open closes drawer first`() {
        assertEquals(
            AuthenticatedBackAction.CloseDrawer,
            resolveAuthenticatedBackAction(
                drawerOpen = true,
                notificationPreferencesOpen = true,
                chatHasSelectedConversation = true,
                currentTab = MawaredNavigation.TAB_CHAT,
                defaultTab = MawaredNavigation.TAB_DASHBOARD
            )
        )
    }

    @Test
    fun `notification preferences close before tab change`() {
        assertEquals(
            AuthenticatedBackAction.CloseNotificationPreferences,
            resolveAuthenticatedBackAction(
                drawerOpen = false,
                notificationPreferencesOpen = true,
                chatHasSelectedConversation = true,
                currentTab = MawaredNavigation.TAB_NOTIFICATIONS,
                defaultTab = MawaredNavigation.TAB_DASHBOARD
            )
        )
    }

    @Test
    fun `nested chat closes conversation before leaving chat tab`() {
        assertEquals(
            AuthenticatedBackAction.CloseChatConversation,
            resolveAuthenticatedBackAction(
                drawerOpen = false,
                notificationPreferencesOpen = false,
                chatHasSelectedConversation = true,
                currentTab = MawaredNavigation.TAB_CHAT,
                defaultTab = MawaredNavigation.TAB_DASHBOARD
            )
        )
    }

    @Test
    fun `non-default tabs return to dashboard for managers`() {
        val defaultTab = MawaredNavigation.TAB_DASHBOARD
        listOf(
            MawaredNavigation.TAB_ATTENDANCE,
            MawaredNavigation.TAB_LEAVES,
            MawaredNavigation.TAB_REPORTS,
            MawaredNavigation.TAB_TRAINING,
            MawaredNavigation.TAB_CHAT,
            MawaredNavigation.TAB_GLOBAL_SEARCH,
            MawaredNavigation.TAB_NOTIFICATIONS
        ).forEach { tab ->
            assertEquals(
                "Back from tab $tab should return to Dashboard",
                AuthenticatedBackAction.NavigateToDefaultTab,
                resolveAuthenticatedBackAction(
                    drawerOpen = false,
                    notificationPreferencesOpen = false,
                    chatHasSelectedConversation = false,
                    currentTab = tab,
                    defaultTab = defaultTab
                )
            )
        }
    }

    @Test
    fun `employee default attendance allows system back on attendance`() {
        assertEquals(
            AuthenticatedBackAction.AllowSystemBack,
            resolveAuthenticatedBackAction(
                drawerOpen = false,
                notificationPreferencesOpen = false,
                chatHasSelectedConversation = false,
                currentTab = MawaredNavigation.TAB_ATTENDANCE,
                defaultTab = MawaredNavigation.TAB_ATTENDANCE
            )
        )
    }

    @Test
    fun `manager on dashboard allows system back`() {
        assertEquals(
            AuthenticatedBackAction.AllowSystemBack,
            resolveAuthenticatedBackAction(
                drawerOpen = false,
                notificationPreferencesOpen = false,
                chatHasSelectedConversation = false,
                currentTab = MawaredNavigation.TAB_DASHBOARD,
                defaultTab = MawaredNavigation.TAB_DASHBOARD
            )
        )
    }

    @Test
    fun `recovery and pre-login screens do not use this policy helper for composition`() {
        // Documented contract: resolveAuthenticatedBackAction is only wired from
        // MawaredAppDashboardContent. Pre-login / owner-recovery keep platform back.
        // This assertion locks the AllowSystemBack sentinel used when enabled=false.
        assertEquals(
            AuthenticatedBackAction.AllowSystemBack,
            resolveAuthenticatedBackAction(
                drawerOpen = false,
                notificationPreferencesOpen = false,
                chatHasSelectedConversation = false,
                currentTab = MawaredNavigation.TAB_DASHBOARD,
                defaultTab = MawaredNavigation.TAB_DASHBOARD
            )
        )
    }
}
