package com.example.ui

import androidx.annotation.StringRes
import com.example.R
import com.example.core.permissions.PermissionChecker
import com.example.core.permissions.Permissions

/**
 * Authenticated navigation metadata.
 *
 * Visibility is derived only from canonical session permissions. Display role
 * names are intentionally absent from this policy.
 */
enum class MawaredNavigationSection(val arabicTitle: String) {
    CORE_HR("الرئيسية والموارد البشرية"),
    OPERATIONS("العمليات"),
    SUPPORT_PILOT("المساندة")
}

data class MawaredDestination(
    val tabIndex: Int,
    val label: String,
    val section: MawaredNavigationSection,
    @StringRes val labelRes: Int? = null,
    val requiredPermissions: List<String> = emptyList(),
    val bottomBarPriority: Int? = null,
    val hideForSelfServiceEmployee: Boolean = false,
    val exactPermissionMatch: Boolean = false
)

object MawaredNavigation {
    const val TAB_DASHBOARD = 0
    const val TAB_EMPLOYEES = 1
    const val TAB_PURCHASING = 2
    const val TAB_REPORTS = 3
    const val TAB_CHAT = 4
    const val TAB_TASKS = 5
    const val TAB_TRAINING = 6
    const val TAB_SUPPORT = 7
    const val TAB_AI_ASSISTANT = 8
    const val TAB_ATTENDANCE = 9
    const val TAB_LEAVES = 10
    const val TAB_PAYROLL = 11
    const val TAB_AUTHORIZATION = 12
    const val TAB_NOTIFICATIONS = 13
    const val TAB_MY_WORK = 14
    const val TAB_SECURITY_SESSIONS = 15
    const val TAB_GLOBAL_SEARCH = 16

    const val MAX_BOTTOM_DESTINATIONS = 5

    val destinations: List<MawaredDestination> = listOf(
        MawaredDestination(
            tabIndex = TAB_DASHBOARD,
            label = "لوحة التحكم",
            section = MawaredNavigationSection.CORE_HR,
            bottomBarPriority = 0
        ),
        MawaredDestination(
            tabIndex = TAB_EMPLOYEES,
            label = "الموظفون",
            labelRes = R.string.nav_employees,
            section = MawaredNavigationSection.CORE_HR,
            requiredPermissions = listOf(Permissions.EMPLOYEES_VIEW, Permissions.HR_MANAGE),
            bottomBarPriority = 3,
            hideForSelfServiceEmployee = true
        ),
        MawaredDestination(
            tabIndex = TAB_ATTENDANCE,
            label = "الحضور والانصراف",
            section = MawaredNavigationSection.CORE_HR,
            requiredPermissions = listOf(
                Permissions.ATTENDANCE_VIEW,
                Permissions.ATTENDANCE_CLOCK,
                Permissions.ATTENDANCE_MANAGE
            ),
            bottomBarPriority = 1
        ),
        MawaredDestination(
            tabIndex = TAB_LEAVES,
            label = "الإجازات",
            section = MawaredNavigationSection.CORE_HR,
            requiredPermissions = listOf(Permissions.LEAVES_VIEW, Permissions.HR_MANAGE),
            bottomBarPriority = 2
        ),
        MawaredDestination(
            tabIndex = TAB_PAYROLL,
            label = "الرواتب",
            section = MawaredNavigationSection.CORE_HR,
            requiredPermissions = listOf(Permissions.PAYROLL_VIEW, Permissions.FINANCE_VIEW),
            bottomBarPriority = 4
        ),
        MawaredDestination(
            tabIndex = TAB_PURCHASING,
            label = "المشتريات",
            section = MawaredNavigationSection.OPERATIONS,
            requiredPermissions = listOf(
                Permissions.PURCHASING_VIEW,
                Permissions.PURCHASING_VIEW_OWN,
                Permissions.PURCHASING_VIEW_DEPARTMENT,
                Permissions.PURCHASING_CREATE,
                Permissions.PURCHASING_REVIEW_DEPARTMENT,
                Permissions.PURCHASING_APPROVE,
                Permissions.PURCHASING_MANAGE,
                Permissions.PURCHASING_RECEIVE,
                Permissions.PURCHASING_REPORT,
                Permissions.VENDORS_VIEW,
                Permissions.VENDORS_MANAGE
            ),
            bottomBarPriority = 5
        ),
        MawaredDestination(
            tabIndex = TAB_REPORTS,
            label = "التقارير",
            section = MawaredNavigationSection.OPERATIONS,
            requiredPermissions = listOf(
                Permissions.REPORTS_VIEW,
                Permissions.REPORTS_FINANCE,
                Permissions.ATTENDANCE_VIEW,
                Permissions.ATTENDANCE_VIEW_DEPARTMENT,
                Permissions.LEAVES_VIEW,
                Permissions.TASKS_VIEW_DEPARTMENT,
                Permissions.TASKS_VIEW_COMPANY,
                Permissions.PAYROLL_REPORT,
                Permissions.PURCHASING_REPORT,
                Permissions.TRAINING_REPORT
            ),
            bottomBarPriority = 6,
            exactPermissionMatch = true
        ),
        MawaredDestination(
            tabIndex = TAB_TASKS,
            label = "المهام",
            section = MawaredNavigationSection.OPERATIONS,
            requiredPermissions = listOf(
                Permissions.TASKS_VIEW_OWN,
                Permissions.TASKS_VIEW_DEPARTMENT,
                Permissions.TASKS_VIEW_COMPANY,
                Permissions.TASKS_CREATE,
                Permissions.TASKS_REVIEW
            ),
            bottomBarPriority = 7
        ),
        MawaredDestination(
            tabIndex = TAB_TRAINING,
            label = "التدريب",
            section = MawaredNavigationSection.OPERATIONS,
            requiredPermissions = listOf(
                Permissions.TRAINING_VIEW_OWN,
                Permissions.TRAINING_VIEW_DEPARTMENT,
                Permissions.TRAINING_VIEW_COMPANY,
                Permissions.TRAINING_MANAGE
            ),
            bottomBarPriority = 8
        ),
        MawaredDestination(
            tabIndex = TAB_CHAT,
            label = "المحادثة الداخلية",
            section = MawaredNavigationSection.SUPPORT_PILOT,
            requiredPermissions = listOf(Permissions.CHAT_VIEW),
            bottomBarPriority = 9
        ),
        MawaredDestination(
            tabIndex = TAB_AI_ASSISTANT,
            label = "المساعد الذكي",
            section = MawaredNavigationSection.SUPPORT_PILOT,
            requiredPermissions = listOf(Permissions.CHAT_VIEW)
        ),
        MawaredDestination(
            tabIndex = TAB_AUTHORIZATION,
            label = "الملكية والصلاحيات",
            section = MawaredNavigationSection.CORE_HR,
            requiredPermissions = listOf(
                Permissions.COMPANY_OWNER_TRANSFER,
                Permissions.COMPANY_ADMIN_DELEGATE,
                Permissions.PERMISSIONS_MANAGE_COMPANY,
                Permissions.PERMISSIONS_MANAGE_DEPARTMENT,
                Permissions.PERMISSIONS_DELEGATE_TEMPORARY,
                Permissions.EMPLOYEES_PERMISSIONS_MANAGE
            ),
            hideForSelfServiceEmployee = true
        ),
        // Notifications stay addressable via TAB_NOTIFICATIONS / bell / typed
        // notifications.inbox — not listed in drawer or bottom bar (QA Issue 4).
        MawaredDestination(
            tabIndex = TAB_NOTIFICATIONS,
            label = "الإشعارات",
            section = MawaredNavigationSection.CORE_HR,
            requiredPermissions = listOf(Permissions.NOTIFICATIONS_VIEW)
        ),
        MawaredDestination(
            tabIndex = TAB_MY_WORK,
            label = "عملي",
            section = MawaredNavigationSection.CORE_HR,
            requiredPermissions = listOf(
                Permissions.LEAVES_VIEW,
                Permissions.LEAVES_VIEW_OWN,
                Permissions.LEAVES_REVIEW,
                Permissions.LEAVES_CREATE,
                Permissions.TASKS_VIEW_OWN,
                Permissions.TASKS_VIEW_DEPARTMENT,
                Permissions.TASKS_VIEW_COMPANY,
                Permissions.TASKS_REVIEW,
                Permissions.ATTENDANCE_CLOCK,
                Permissions.ATTENDANCE_VIEW_OWN
            )
        ),
        MawaredDestination(
            tabIndex = TAB_SECURITY_SESSIONS,
            label = "الجلسات والأجهزة",
            section = MawaredNavigationSection.SUPPORT_PILOT
        ),
        // Sprint 12L: global search is available to every authenticated user;
        // the server scopes every result by that module's own view permissions.
        MawaredDestination(
            tabIndex = TAB_GLOBAL_SEARCH,
            label = "البحث",
            section = MawaredNavigationSection.CORE_HR,
            labelRes = R.string.global_search_title
        )
    )

    fun visibleDestinations(permissions: Set<String>): List<MawaredDestination> {
        val checker = PermissionChecker(permissions)
        val isSelfServiceEmployee = isSelfServiceEmployee(permissions)
        val visible = destinations.filter { destination ->
            // Bell-only: keep TAB_NOTIFICATIONS addressable but out of drawer/bottom.
            if (destination.tabIndex == TAB_NOTIFICATIONS) return@filter false
            val hasPermission = destination.requiredPermissions.isEmpty() ||
                if (destination.exactPermissionMatch) {
                    permissions.contains(Permissions.ADMIN_FULL) ||
                        destination.requiredPermissions.any(permissions::contains)
                } else {
                    checker.hasAnyPermission(destination.requiredPermissions)
                }
            hasPermission && !(isSelfServiceEmployee && destination.hideForSelfServiceEmployee)
        }
        return if (isSelfServiceEmployee) {
            visible.sortedBy { selfServiceDrawerPriority(it.tabIndex) }
        } else {
            visible
        }
    }

    fun bottomDestinations(permissions: Set<String>): List<MawaredDestination> {
        val visibleBottomItems = visibleDestinations(permissions)
            .filter { it.bottomBarPriority != null }
        val sortedItems = if (isSelfServiceEmployee(permissions)) {
            visibleBottomItems.sortedBy { selfServiceBottomPriority(it.tabIndex) }
        } else {
            visibleBottomItems.sortedBy { it.bottomBarPriority }
        }
        return sortedItems
            .take(MAX_BOTTOM_DESTINATIONS)
    }

    fun isTabVisible(tabIndex: Int, permissions: Set<String>): Boolean {
        // Notifications are bell-only (excluded from drawer), but remain a valid tab.
        if (tabIndex == TAB_NOTIFICATIONS) {
            return PermissionChecker(permissions)
                .hasAnyPermission(listOf(Permissions.NOTIFICATIONS_VIEW))
        }
        return visibleDestinations(permissions).any { it.tabIndex == tabIndex }
    }

    fun defaultTab(permissions: Set<String>): Int =
        if (isSelfServiceEmployee(permissions) && isTabVisible(TAB_ATTENDANCE, permissions)) {
            TAB_ATTENDANCE
        } else {
            TAB_DASHBOARD
        }

    private fun isSelfServiceEmployee(permissions: Set<String>): Boolean =
        permissions.contains(Permissions.DASHBOARD_SELF) &&
            !permissions.contains(Permissions.ADMIN_FULL) &&
            !permissions.contains(Permissions.HR_VIEW) &&
            !permissions.contains(Permissions.EMPLOYEES_VIEW_DEPARTMENT)

    private fun selfServiceDrawerPriority(tabIndex: Int): Int = when (tabIndex) {
        TAB_ATTENDANCE -> 0
        TAB_MY_WORK -> 1
        TAB_LEAVES -> 2
        TAB_TASKS -> 3
        TAB_TRAINING -> 4
        TAB_CHAT -> 5
        TAB_AI_ASSISTANT -> 6
        TAB_SECURITY_SESSIONS -> 7
        TAB_DASHBOARD -> 8
        else -> 50
    }

    private fun selfServiceBottomPriority(tabIndex: Int): Int = when (tabIndex) {
        TAB_ATTENDANCE -> 0
        TAB_LEAVES -> 1
        TAB_TASKS -> 2
        TAB_TRAINING -> 3
        TAB_CHAT -> 4
        TAB_DASHBOARD -> 5
        else -> 50
    }
}
