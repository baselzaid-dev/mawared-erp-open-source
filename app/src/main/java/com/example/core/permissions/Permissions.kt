package com.example.core.permissions

/**
 * Canonical permission keys for Mawared.
 *
 * This object is a MIRROR of the backend source of truth:
 *   backend/src/permissions.ts
 * Keep both files in sync. CanonicalPermissionsTest guards that demo/mock
 * users only ever receive keys from this list.
 */
object Permissions {

    // Super admin — grants everything. The ONLY admin bypass key.
    const val ADMIN_FULL = "admin.full"

    // Company ownership and scoped authorization (Sprint 12C)
    const val COMPANY_OWNER_TRANSFER = "company.owner.transfer"
    const val COMPANY_ADMIN_DELEGATE = "company.admin.delegate"
    const val COMPANY_SETTINGS_MANAGE = "company.settings.manage"
    const val COMPANY_SESSIONS_MANAGE = "company.sessions.manage"
    const val PERMISSIONS_MANAGE_COMPANY = "permissions.manage_company"
    const val PERMISSIONS_MANAGE_DEPARTMENT = "permissions.manage_department"
    const val PERMISSIONS_DELEGATE_TEMPORARY = "permissions.delegate_temporary"
    const val PRINCIPALS_MANAGE_PEERS = "principals.manage_peers"

    // HR module (broad HR area access)
    const val HR_VIEW = "hr.view"
    const val HR_MANAGE = "hr.manage"

    // Employees
    const val EMPLOYEES_VIEW = "employees.view"
    const val EMPLOYEES_VIEW_DEPARTMENT = "employees.view_department"
    const val EMPLOYEES_CREATE = "employees.create"
    const val EMPLOYEES_UPDATE = "employees.update"
    // Reserved for destructive employee operations (delete/terminate).
    const val EMPLOYEES_MANAGE = "employees.manage"
    const val EMPLOYEES_PERMISSIONS_MANAGE = "employees.permissions.manage"
    const val EMPLOYEES_CREDENTIALS_CREATE = "employees.credentials.create"
    const val EMPLOYEES_CREDENTIALS_RESET = "employees.credentials.reset"
    const val EMPLOYEES_ARCHIVE = "employees.archive"

    // Attendance
    const val ATTENDANCE_VIEW = "attendance.view"
    const val ATTENDANCE_VIEW_DEPARTMENT = "attendance.view_department"
    const val ATTENDANCE_VIEW_OWN = "attendance.view_own"
    const val ATTENDANCE_VIEW_COMPANY = "attendance.view_company"
    const val ATTENDANCE_MANAGE = "attendance.manage"
    const val ATTENDANCE_MANAGE_MANUAL = "attendance.manage_manual"
    const val ATTENDANCE_CLOCK = "attendance.clock"
    const val ATTENDANCE_CHECK_SELF = "attendance.check_self"
    const val ATTENDANCE_REVIEW_CORRECTION = "attendance.review_correction"
    const val ATTENDANCE_REPORT = "attendance.report"
    const val EMPLOYEES_ATTENDANCE_EXEMPTION_MANAGE = "employees.attendance_exemption.manage"

    // Leaves
    const val LEAVES_VIEW = "leaves.view"
    const val LEAVES_VIEW_OWN = "leaves.view_own"
    const val LEAVES_CREATE = "leaves.create"
    const val LEAVES_CREATE_ON_BEHALF = "leaves.create_on_behalf"
    const val LEAVES_REVIEW = "leaves.review"
    const val LEAVES_APPROVE = "leaves.approve"
    const val LEAVES_REJECT = "leaves.reject"
    const val LEAVES_ESCALATE = "leaves.escalate"
    const val LEAVES_ADMIN_OVERRIDE = "leaves.admin_override"
    const val LEAVES_CANCEL = "leaves.cancel"

    // Payroll
    const val PAYROLL_VIEW = "payroll.view"
    const val PAYROLL_MANAGE = "payroll.manage"
    const val PAYROLL_APPROVE = "payroll.approve"
    const val PAYROLL_REPORT = "payroll.report"
    const val PAYROLL_PAY = "payroll.pay"
    const val PAYROLL_PAYMENTS_VIEW = "payroll.payments.view"
    const val PAYROLL_PAYMENTS_RECORD = "payroll.payments.record"
    const val PAYROLL_PAYMENTS_VOID = "payroll.payments.void"
    const val PAYROLL_ITEM_ADJUST = "payroll.item.adjust"
    const val PAYROLL_PERIOD_REOPEN = "payroll.period.reopen"

    // Salary records
    const val SALARY_VIEW_OWN = "salary.view_own"
    const val SALARY_VIEW_COMPANY = "salary.view_company"
    const val SALARY_MANAGE = "salary.manage"
    const val SALARY_VIEW_OWNER = "salary.view_owner"

    // Finance
    const val FINANCE_VIEW = "finance.view"
    const val FINANCE_CREATE = "finance.create"
    const val FINANCE_APPROVE = "finance.approve"
    const val FINANCE_MANAGE = "finance.manage"

    // Purchasing / vendors
    const val PURCHASING_VIEW = "purchasing.view"
    const val PURCHASING_VIEW_OWN = "purchasing.view_own"
    const val PURCHASING_VIEW_DEPARTMENT = "purchasing.view_department"
    const val PURCHASING_CREATE = "purchasing.create"
    const val PURCHASING_REVIEW_DEPARTMENT = "purchasing.review_department"
    const val PURCHASING_APPROVE = "purchasing.approve"
    const val PURCHASING_MANAGE = "purchasing.manage"
    const val PURCHASING_RECEIVE = "purchasing.receive"
    const val PURCHASING_REPORT = "purchasing.report"
    const val PURCHASING_ADMIN_OVERRIDE = "purchasing.admin_override"

    // Commercial Wave 2 — Operations Slice E1.
    // Partial receipt reuses PURCHASING_RECEIVE; an explicit over-receipt reuses
    // PURCHASING_ADMIN_OVERRIDE. Only quotations and returns need new keys.
    const val PURCHASING_QUOTATION_MANAGE = "purchasing.quotation.manage"
    const val PURCHASING_QUOTATION_COMPARE = "purchasing.quotation.compare"
    const val PURCHASING_RETURN_CREATE = "purchasing.return.create"
    const val PURCHASING_RETURN_APPROVE = "purchasing.return.approve"
    const val VENDORS_VIEW = "vendors.view"
    const val VENDORS_MANAGE = "vendors.manage"
    const val VENDORS_ARCHIVE = "vendors.archive"

    // Reports
    const val REPORTS_VIEW = "reports.view"
    const val REPORTS_FINANCE = "reports.finance"
    const val REPORTS_EXPORT = "reports.export"
    const val REPORTS_COMPOSITE_VIEW = "reports.composite.view"
    const val REPORTS_TEMPLATES_MANAGE = "reports.templates.manage"

    // Misc modules
    const val DASHBOARD_SELF = "dashboard.self"
    const val NOTIFICATIONS_VIEW = "notifications.view"
    const val TASKS_VIEW_OWN = "tasks.view_own"
    const val TASKS_VIEW_DEPARTMENT = "tasks.view_department"
    const val TASKS_VIEW_COMPANY = "tasks.view_company"
    const val TASKS_CREATE = "tasks.create"
    const val TASKS_ASSIGN_DEPARTMENT = "tasks.assign_department"
    const val TASKS_ASSIGN_COMPANY = "tasks.assign_company"
    const val TASKS_REVIEW = "tasks.review"
    // Commercial P4 — task collaboration. Reading comments/attachments reuses the
    // task's own view scope, so no extra read key exists by design.
    const val TASKS_EDIT = "tasks.edit"
    const val TASKS_COMMENT_CREATE = "tasks.comment.create"
    const val TASKS_ATTACHMENT_MANAGE = "tasks.attachment.manage"
    const val TRAINING_VIEW_OWN = "training.view_own"
    const val TRAINING_VIEW_DEPARTMENT = "training.view_department"
    const val TRAINING_VIEW_COMPANY = "training.view_company"
    const val TRAINING_MANAGE = "training.manage"
    const val TRAINING_ASSIGN = "training.assign"
    const val TRAINING_REVIEW = "training.review"
    const val TRAINING_REPORT = "training.report"
    // Commercial P4 — training completion artifacts. Evaluations are
    // performance-adjacent, so reading one needs its own key.
    const val TRAINING_CERTIFICATE_ISSUE = "training.certificate.issue"
    const val TRAINING_EVALUATION_CREATE = "training.evaluation.create"
    const val TRAINING_EVALUATION_VIEW = "training.evaluation.view"
    const val CHAT_VIEW = "chat.view"
    const val CHAT_CREATE_DIRECT = "chat.create_direct"
    const val CHAT_CREATE_DEPARTMENT = "chat.create_department"
    const val CHAT_CREATE_COMPANY_ANNOUNCEMENT = "chat.create_company_announcement"
    const val CHAT_PIN = "chat.pin"

    /** Every canonical key. Used by tests to reject non-canonical strings. */
    val all: Set<String> = setOf(
        ADMIN_FULL,
        COMPANY_OWNER_TRANSFER, COMPANY_ADMIN_DELEGATE, COMPANY_SETTINGS_MANAGE,
        COMPANY_SESSIONS_MANAGE, PERMISSIONS_MANAGE_COMPANY,
        PERMISSIONS_MANAGE_DEPARTMENT, PERMISSIONS_DELEGATE_TEMPORARY,
        PRINCIPALS_MANAGE_PEERS,
        HR_VIEW, HR_MANAGE,
        EMPLOYEES_VIEW, EMPLOYEES_VIEW_DEPARTMENT, EMPLOYEES_CREATE,
        EMPLOYEES_UPDATE, EMPLOYEES_MANAGE, EMPLOYEES_PERMISSIONS_MANAGE,
        EMPLOYEES_CREDENTIALS_CREATE, EMPLOYEES_CREDENTIALS_RESET, EMPLOYEES_ARCHIVE,
        ATTENDANCE_VIEW, ATTENDANCE_VIEW_DEPARTMENT, ATTENDANCE_VIEW_OWN,
        ATTENDANCE_VIEW_COMPANY, ATTENDANCE_MANAGE, ATTENDANCE_MANAGE_MANUAL,
        ATTENDANCE_CLOCK, ATTENDANCE_CHECK_SELF, ATTENDANCE_REVIEW_CORRECTION,
        ATTENDANCE_REPORT, EMPLOYEES_ATTENDANCE_EXEMPTION_MANAGE,
        LEAVES_VIEW, LEAVES_VIEW_OWN, LEAVES_CREATE, LEAVES_CREATE_ON_BEHALF,
        LEAVES_REVIEW, LEAVES_APPROVE, LEAVES_REJECT, LEAVES_ESCALATE,
        LEAVES_ADMIN_OVERRIDE, LEAVES_CANCEL,
        PAYROLL_VIEW, PAYROLL_MANAGE, PAYROLL_APPROVE, PAYROLL_REPORT, PAYROLL_PAY,
        PAYROLL_PAYMENTS_VIEW, PAYROLL_PAYMENTS_RECORD, PAYROLL_PAYMENTS_VOID,
        PAYROLL_ITEM_ADJUST, PAYROLL_PERIOD_REOPEN,
        SALARY_VIEW_OWN, SALARY_VIEW_COMPANY, SALARY_MANAGE, SALARY_VIEW_OWNER,
        FINANCE_VIEW, FINANCE_CREATE, FINANCE_APPROVE, FINANCE_MANAGE,
        PURCHASING_VIEW, PURCHASING_VIEW_OWN, PURCHASING_VIEW_DEPARTMENT,
        PURCHASING_CREATE, PURCHASING_REVIEW_DEPARTMENT, PURCHASING_APPROVE,
        PURCHASING_MANAGE, PURCHASING_RECEIVE, PURCHASING_REPORT, PURCHASING_ADMIN_OVERRIDE,
        PURCHASING_QUOTATION_MANAGE, PURCHASING_QUOTATION_COMPARE,
        PURCHASING_RETURN_CREATE, PURCHASING_RETURN_APPROVE,
        VENDORS_VIEW, VENDORS_MANAGE, VENDORS_ARCHIVE,
        REPORTS_VIEW, REPORTS_FINANCE, REPORTS_EXPORT, REPORTS_COMPOSITE_VIEW, REPORTS_TEMPLATES_MANAGE,
        DASHBOARD_SELF, NOTIFICATIONS_VIEW,
        TASKS_VIEW_OWN, TASKS_VIEW_DEPARTMENT, TASKS_VIEW_COMPANY,
        TASKS_CREATE, TASKS_ASSIGN_DEPARTMENT, TASKS_ASSIGN_COMPANY, TASKS_REVIEW,
        TASKS_EDIT, TASKS_COMMENT_CREATE, TASKS_ATTACHMENT_MANAGE,
        TRAINING_VIEW_OWN, TRAINING_VIEW_DEPARTMENT, TRAINING_VIEW_COMPANY,
        TRAINING_MANAGE, TRAINING_ASSIGN, TRAINING_REVIEW, TRAINING_REPORT,
        TRAINING_CERTIFICATE_ISSUE, TRAINING_EVALUATION_CREATE, TRAINING_EVALUATION_VIEW,
        CHAT_VIEW, CHAT_CREATE_DIRECT, CHAT_CREATE_DEPARTMENT,
        CHAT_CREATE_COMPANY_ANNOUNCEMENT, CHAT_PIN
    )
}
