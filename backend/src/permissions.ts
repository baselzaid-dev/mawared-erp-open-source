/**
 * Canonical permission keys for Mawared.
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH for permission strings.
 * - prisma/seed.ts assigns these keys to roles.
 * - server routes check these keys.
 * - The Android app mirrors this list in
 *   app/src/main/java/com/example/core/permissions/Permissions.kt
 *   (keep both files in sync — the Android unit test
 *   CanonicalPermissionsTest guards the mirror).
 */
export const PERMISSIONS = {
  // Super admin — grants everything. The ONLY admin bypass key.
  ADMIN_FULL: 'admin.full',

  // Company ownership and scoped authorization (Sprint 12C)
  COMPANY_OWNER_TRANSFER: 'company.owner.transfer',
  COMPANY_ADMIN_DELEGATE: 'company.admin.delegate',
  COMPANY_SETTINGS_MANAGE: 'company.settings.manage',
  COMPANY_SESSIONS_MANAGE: 'company.sessions.manage',
  PERMISSIONS_MANAGE_COMPANY: 'permissions.manage_company',
  PERMISSIONS_MANAGE_DEPARTMENT: 'permissions.manage_department',
  PERMISSIONS_DELEGATE_TEMPORARY: 'permissions.delegate_temporary',
  PRINCIPALS_MANAGE_PEERS: 'principals.manage_peers',

  // HR module (broad HR area access, used for HR notifications/queues)
  HR_VIEW: 'hr.view',
  HR_MANAGE: 'hr.manage',

  // Employees
  EMPLOYEES_VIEW: 'employees.view',
  EMPLOYEES_VIEW_DEPARTMENT: 'employees.view_department',
  EMPLOYEES_CREATE: 'employees.create',
  EMPLOYEES_UPDATE: 'employees.update',
  // Reserved for destructive employee operations (delete/terminate).
  // No seeded role holds it today: destructive ops are admin-only by default.
  EMPLOYEES_MANAGE: 'employees.manage',
  EMPLOYEES_PERMISSIONS_MANAGE: 'employees.permissions.manage',
  EMPLOYEES_CREDENTIALS_CREATE: 'employees.credentials.create',
  EMPLOYEES_CREDENTIALS_RESET: 'employees.credentials.reset',
  EMPLOYEES_ARCHIVE: 'employees.archive',

  // Attendance
  ATTENDANCE_VIEW: 'attendance.view',
  ATTENDANCE_VIEW_DEPARTMENT: 'attendance.view_department',
  ATTENDANCE_VIEW_OWN: 'attendance.view_own',
  ATTENDANCE_VIEW_COMPANY: 'attendance.view_company',
  ATTENDANCE_MANAGE: 'attendance.manage',
  ATTENDANCE_MANAGE_MANUAL: 'attendance.manage_manual',
  ATTENDANCE_CLOCK: 'attendance.clock',
  ATTENDANCE_CHECK_SELF: 'attendance.check_self',
  ATTENDANCE_REVIEW_CORRECTION: 'attendance.review_correction',
  ATTENDANCE_REPORT: 'attendance.report',
  EMPLOYEES_ATTENDANCE_EXEMPTION_MANAGE: 'employees.attendance_exemption.manage',

  // Leaves
  LEAVES_VIEW: 'leaves.view',
  LEAVES_VIEW_OWN: 'leaves.view_own',
  LEAVES_CREATE: 'leaves.create',
  LEAVES_CREATE_ON_BEHALF: 'leaves.create_on_behalf',
  LEAVES_REVIEW: 'leaves.review',
  LEAVES_APPROVE: 'leaves.approve',
  LEAVES_REJECT: 'leaves.reject',
  LEAVES_ESCALATE: 'leaves.escalate',
  LEAVES_ADMIN_OVERRIDE: 'leaves.admin_override',
  LEAVES_CANCEL: 'leaves.cancel',

  // Payroll
  PAYROLL_VIEW: 'payroll.view',
  PAYROLL_MANAGE: 'payroll.manage',
  PAYROLL_APPROVE: 'payroll.approve',
  PAYROLL_REPORT: 'payroll.report',
  PAYROLL_PAY: 'payroll.pay',
  PAYROLL_PAYMENTS_VIEW: 'payroll.payments.view',
  PAYROLL_PAYMENTS_RECORD: 'payroll.payments.record',
  PAYROLL_PAYMENTS_VOID: 'payroll.payments.void',
  PAYROLL_ITEM_ADJUST: 'payroll.item.adjust',
  PAYROLL_PERIOD_REOPEN: 'payroll.period.reopen',

  // Salary records (separate from payroll period access)
  SALARY_VIEW_OWN: 'salary.view_own',
  SALARY_VIEW_COMPANY: 'salary.view_company',
  SALARY_MANAGE: 'salary.manage',
  SALARY_VIEW_OWNER: 'salary.view_owner',

  // Finance
  FINANCE_VIEW: 'finance.view',
  FINANCE_CREATE: 'finance.create',
  FINANCE_APPROVE: 'finance.approve',
  FINANCE_MANAGE: 'finance.manage',

  // Purchasing / vendors
  PURCHASING_VIEW: 'purchasing.view',
  PURCHASING_VIEW_OWN: 'purchasing.view_own',
  PURCHASING_VIEW_DEPARTMENT: 'purchasing.view_department',
  PURCHASING_CREATE: 'purchasing.create',
  PURCHASING_REVIEW_DEPARTMENT: 'purchasing.review_department',
  PURCHASING_APPROVE: 'purchasing.approve',
  PURCHASING_MANAGE: 'purchasing.manage',
  PURCHASING_RECEIVE: 'purchasing.receive',
  PURCHASING_REPORT: 'purchasing.report',
  PURCHASING_ADMIN_OVERRIDE: 'purchasing.admin_override',
  // Commercial Wave 2 — Operations Slice E1.
  // Partial receipt reuses `purchasing.receive`; an explicit over-receipt reuses
  // `purchasing.admin_override`. Only quotations and returns need new keys.
  PURCHASING_QUOTATION_MANAGE: 'purchasing.quotation.manage',
  PURCHASING_QUOTATION_COMPARE: 'purchasing.quotation.compare',
  PURCHASING_RETURN_CREATE: 'purchasing.return.create',
  PURCHASING_RETURN_APPROVE: 'purchasing.return.approve',
  VENDORS_VIEW: 'vendors.view',
  VENDORS_MANAGE: 'vendors.manage',
  VENDORS_ARCHIVE: 'vendors.archive',

  // Reports
  REPORTS_VIEW: 'reports.view',
  REPORTS_FINANCE: 'reports.finance',
  REPORTS_EXPORT: 'reports.export',
  REPORTS_COMPOSITE_VIEW: 'reports.composite.view',
  REPORTS_TEMPLATES_MANAGE: 'reports.templates.manage',

  // Misc modules
  DASHBOARD_SELF: 'dashboard.self',
  NOTIFICATIONS_VIEW: 'notifications.view',
  TASKS_VIEW_OWN: 'tasks.view_own',
  TASKS_VIEW_DEPARTMENT: 'tasks.view_department',
  TASKS_VIEW_COMPANY: 'tasks.view_company',
  TASKS_CREATE: 'tasks.create',
  TASKS_ASSIGN_DEPARTMENT: 'tasks.assign_department',
  TASKS_ASSIGN_COMPANY: 'tasks.assign_company',
  TASKS_REVIEW: 'tasks.review',
  // Commercial P4 — task collaboration. Reading comments/attachments needs no new
  // key: it reuses the task's own view scope, so a comment is never visible to
  // someone who cannot already see the task.
  TASKS_EDIT: 'tasks.edit',
  TASKS_COMMENT_CREATE: 'tasks.comment.create',
  TASKS_ATTACHMENT_MANAGE: 'tasks.attachment.manage',
  TRAINING_VIEW_OWN: 'training.view_own',
  TRAINING_VIEW_DEPARTMENT: 'training.view_department',
  TRAINING_VIEW_COMPANY: 'training.view_company',
  TRAINING_MANAGE: 'training.manage',
  TRAINING_ASSIGN: 'training.assign',
  TRAINING_REVIEW: 'training.review',
  TRAINING_REPORT: 'training.report',
  // Commercial P4 — training completion artifacts. Evaluations are
  // performance-adjacent, so reading one needs an explicit key rather than the
  // ordinary training view scope.
  TRAINING_CERTIFICATE_ISSUE: 'training.certificate.issue',
  TRAINING_EVALUATION_CREATE: 'training.evaluation.create',
  TRAINING_EVALUATION_VIEW: 'training.evaluation.view',
  CHAT_VIEW: 'chat.view',
  CHAT_CREATE_DIRECT: 'chat.create_direct',
  CHAT_CREATE_DEPARTMENT: 'chat.create_department',
  CHAT_CREATE_COMPANY_ANNOUNCEMENT: 'chat.create_company_announcement',
  CHAT_PIN: 'chat.pin',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Flat list of every canonical key (useful for validation/tests). */
export const ALL_PERMISSIONS: readonly string[] = Object.values(PERMISSIONS);

export function isCanonicalPermission(key: string): boolean {
  return (ALL_PERMISSIONS as string[]).includes(key);
}
