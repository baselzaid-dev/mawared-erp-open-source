package com.example.ui

/**
 * Pure back-press policy for the authenticated shell ([MawaredAppDashboardContent]).
 *
 * Pre-login / owner-recovery screens must NOT use this — they keep platform default
 * back (or their own handlers).
 *
 * Priority (first match wins):
 * 1. Drawer open → close drawer
 * 2. Notification preferences overlay open → close preferences
 * 3. Chat has a selected conversation → close conversation (nested chat)
 * 4. Current tab is not the role default → return to default tab
 * 5. Otherwise allow system back (finish activity)
 */
enum class AuthenticatedBackAction {
    CloseDrawer,
    CloseNotificationPreferences,
    CloseChatConversation,
    NavigateToDefaultTab,
    AllowSystemBack
}

fun resolveAuthenticatedBackAction(
    drawerOpen: Boolean,
    notificationPreferencesOpen: Boolean,
    chatHasSelectedConversation: Boolean,
    currentTab: Int,
    defaultTab: Int
): AuthenticatedBackAction = when {
    drawerOpen -> AuthenticatedBackAction.CloseDrawer
    notificationPreferencesOpen -> AuthenticatedBackAction.CloseNotificationPreferences
    chatHasSelectedConversation -> AuthenticatedBackAction.CloseChatConversation
    currentTab != defaultTab -> AuthenticatedBackAction.NavigateToDefaultTab
    else -> AuthenticatedBackAction.AllowSystemBack
}
