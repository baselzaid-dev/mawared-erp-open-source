package com.example.core.permissions

/**
 * Permission gate for the UI layer.
 *
 * Authorization comes ONLY from the session's permission keys
 * (canonical list: [Permissions], mirrored from backend/src/permissions.ts).
 * Role DISPLAY NAMES ("Admin", "المدير", ...) grant nothing — the only
 * super-admin bypass is the canonical key [Permissions.ADMIN_FULL].
 */
class PermissionChecker(
    private val currentPermissions: Set<String>
) {

    // Named aliases kept for existing call sites. Values are canonical keys.
    val HR_EMPLOYEE_VIEW = Permissions.EMPLOYEES_VIEW
    val HR_EMPLOYEE_CREATE = Permissions.EMPLOYEES_CREATE
    val HR_EMPLOYEE_UPDATE = Permissions.EMPLOYEES_UPDATE
    val HR_EMPLOYEE_DELETE = Permissions.EMPLOYEES_MANAGE

    val HR_ATTENDANCE_VIEW = Permissions.ATTENDANCE_VIEW
    val HR_ATTENDANCE_MANAGE = Permissions.ATTENDANCE_MANAGE
    val HR_ATTENDANCE_CLOCK = Permissions.ATTENDANCE_CLOCK
    val HR_ATTENDANCE_APPROVE = Permissions.ATTENDANCE_MANAGE

    val HR_LEAVE_VIEW = Permissions.LEAVES_VIEW
    val HR_LEAVE_CREATE = Permissions.LEAVES_CREATE
    val HR_LEAVE_APPROVE = Permissions.LEAVES_APPROVE
    val HR_LEAVE_MANAGE = Permissions.HR_MANAGE

    val HR_PAYROLL_VIEW = Permissions.PAYROLL_VIEW
    val HR_PAYROLL_CALCULATE = Permissions.PAYROLL_MANAGE
    val HR_PAYROLL_APPROVE = Permissions.PAYROLL_APPROVE
    val PAYROLL_REPORT = Permissions.PAYROLL_REPORT
    val PAYROLL_PAY = Permissions.PAYROLL_PAY
    val SALARY_VIEW_COMPANY = Permissions.SALARY_VIEW_COMPANY
    val SALARY_MANAGE = Permissions.SALARY_MANAGE
    val SALARY_VIEW_OWNER = Permissions.SALARY_VIEW_OWNER

    // Purchasing permissions
    val PURCHASING_REQUEST_VIEW = Permissions.PURCHASING_VIEW
    val PURCHASING_REQUEST_VIEW_OWN = Permissions.PURCHASING_VIEW_OWN
    val PURCHASING_REQUEST_VIEW_DEPARTMENT = Permissions.PURCHASING_VIEW_DEPARTMENT
    val PURCHASING_REQUEST_CREATE = Permissions.PURCHASING_CREATE
    val PURCHASING_DEPARTMENT_REVIEW = Permissions.PURCHASING_REVIEW_DEPARTMENT
    val PURCHASING_REQUEST_APPROVE = Permissions.PURCHASING_APPROVE
    val PURCHASING_ORDER_MANAGE = Permissions.PURCHASING_MANAGE
    val PURCHASING_ORDER_RECEIVE = Permissions.PURCHASING_RECEIVE
    val PURCHASING_REPORT = Permissions.PURCHASING_REPORT
    val PURCHASING_SUPPLIER_VIEW = Permissions.VENDORS_VIEW
    val PURCHASING_SUPPLIER_MANAGE = Permissions.VENDORS_MANAGE

    // Commercial Wave 2 — Operations Slice E1.
    // Partial receipt reuses PURCHASING_ORDER_RECEIVE; an audited over-receipt
    // reuses PURCHASING_ADMIN_OVERRIDE.
    val PURCHASING_ADMIN_OVERRIDE = Permissions.PURCHASING_ADMIN_OVERRIDE
    val PURCHASING_QUOTATION_MANAGE = Permissions.PURCHASING_QUOTATION_MANAGE
    val PURCHASING_QUOTATION_COMPARE = Permissions.PURCHASING_QUOTATION_COMPARE
    val PURCHASING_RETURN_CREATE = Permissions.PURCHASING_RETURN_CREATE
    val PURCHASING_RETURN_APPROVE = Permissions.PURCHASING_RETURN_APPROVE

    // Finance permissions
    val FINANCE_PAYROLL_VIEW = Permissions.PAYROLL_VIEW
    val FINANCE_PAYROLL_APPROVE = Permissions.PAYROLL_APPROVE
    val FINANCE_REPORTS_VIEW = Permissions.REPORTS_FINANCE

    // Reports permissions
    val REPORTS_VIEW = Permissions.REPORTS_VIEW
    val REPORTS_FINANCIAL_VIEW = Permissions.REPORTS_FINANCE

    // System permissions — admin.full is the single super-admin key.
    val ADMIN_USERS_MANAGE = Permissions.ADMIN_FULL
    val ADMIN_ROLES_MANAGE = Permissions.ADMIN_FULL
    val ADMIN_COMPANY_MANAGE = Permissions.ADMIN_FULL

    // Chat permissions
    val CHAT_FINANCE_VIEW = Permissions.CHAT_VIEW
    val CHAT_HR_VIEW = Permissions.CHAT_VIEW
    val SYSTEM_CHAT_USE = Permissions.CHAT_VIEW
    val SYSTEM_AI_USE = Permissions.CHAT_VIEW

    val TASKS_VIEW_OWN = Permissions.TASKS_VIEW_OWN
    val TASKS_VIEW_DEPARTMENT = Permissions.TASKS_VIEW_DEPARTMENT
    val TASKS_VIEW_COMPANY = Permissions.TASKS_VIEW_COMPANY
    val TASKS_CREATE = Permissions.TASKS_CREATE
    val TASKS_ASSIGN_DEPARTMENT = Permissions.TASKS_ASSIGN_DEPARTMENT
    val TASKS_ASSIGN_COMPANY = Permissions.TASKS_ASSIGN_COMPANY
    val TASKS_REVIEW = Permissions.TASKS_REVIEW

    fun hasPermission(key: String): Boolean {
        // The ONLY bypass: the canonical super-admin permission key.
        if (currentPermissions.contains(Permissions.ADMIN_FULL)) return true

        // Scoped-view fallbacks: holders of a department/own-scope key can
        // open the corresponding view screen (data scoping happens server-side).
        if (key == Permissions.EMPLOYEES_VIEW &&
            currentPermissions.contains(Permissions.EMPLOYEES_VIEW_DEPARTMENT)
        ) return true
        if (key == Permissions.ATTENDANCE_VIEW &&
            (currentPermissions.contains(Permissions.ATTENDANCE_VIEW_DEPARTMENT) ||
                currentPermissions.contains(Permissions.ATTENDANCE_VIEW_OWN))
        ) return true
        if (key == Permissions.LEAVES_VIEW &&
            currentPermissions.contains(Permissions.LEAVES_VIEW_OWN)
        ) return true
        if (key == Permissions.TASKS_VIEW_COMPANY &&
            (currentPermissions.contains(Permissions.TASKS_VIEW_DEPARTMENT) ||
                currentPermissions.contains(Permissions.TASKS_VIEW_OWN))
        ) return true
        if (key == Permissions.PURCHASING_VIEW &&
            (currentPermissions.contains(Permissions.PURCHASING_VIEW_DEPARTMENT) ||
                currentPermissions.contains(Permissions.PURCHASING_VIEW_OWN))
        ) return true

        return currentPermissions.contains(key)
    }

    /** Exact-key check for privacy rules where admin.full must not be a bypass. */
    fun hasExactPermission(key: String): Boolean = currentPermissions.contains(key)

    fun hasAnyPermission(keys: List<String>): Boolean = keys.any { hasPermission(it) }

    fun hasAllPermissions(keys: List<String>): Boolean = keys.all { hasPermission(it) }
}
