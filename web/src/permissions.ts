export const ADMIN_FULL = 'admin.full';

export const PERMISSIONS = {
  HR_MANAGE: 'hr.manage',
  EMPLOYEES_VIEW: 'employees.view',
  EMPLOYEES_VIEW_DEPARTMENT: 'employees.view_department',
  EMPLOYEES_CREATE: 'employees.create',
  ATTENDANCE_VIEW: 'attendance.view',
  ATTENDANCE_VIEW_DEPARTMENT: 'attendance.view_department',
  ATTENDANCE_VIEW_OWN: 'attendance.view_own',
  LEAVES_VIEW: 'leaves.view',
  LEAVES_VIEW_OWN: 'leaves.view_own',
  LEAVES_CREATE: 'leaves.create',
  LEAVES_REVIEW: 'leaves.review',
  LEAVES_APPROVE: 'leaves.approve',
  PAYROLL_VIEW: 'payroll.view',
  PAYROLL_MANAGE: 'payroll.manage',
  PAYROLL_APPROVE: 'payroll.approve',
  PAYROLL_ITEM_ADJUST: 'payroll.item.adjust',
  PAYROLL_PERIOD_REOPEN: 'payroll.period.reopen',
  FINANCE_VIEW: 'finance.view',
  FINANCE_CREATE: 'finance.create',
  FINANCE_APPROVE: 'finance.approve',
  FINANCE_MANAGE: 'finance.manage',
  SALARY_VIEW_OWNER: 'salary.view_owner',
  PURCHASING_VIEW: 'purchasing.view',
  PURCHASING_VIEW_OWN: 'purchasing.view_own',
  PURCHASING_VIEW_DEPARTMENT: 'purchasing.view_department',
  PURCHASING_MANAGE: 'purchasing.manage',
  PURCHASING_RECEIVE: 'purchasing.receive',
  PURCHASING_REPORT: 'purchasing.report',
  PURCHASING_ADMIN_OVERRIDE: 'purchasing.admin_override',
  PURCHASING_QUOTATION_MANAGE: 'purchasing.quotation.manage',
  PURCHASING_QUOTATION_COMPARE: 'purchasing.quotation.compare',
  PURCHASING_RETURN_CREATE: 'purchasing.return.create',
  PURCHASING_RETURN_APPROVE: 'purchasing.return.approve',
  VENDORS_VIEW: 'vendors.view',
  VENDORS_MANAGE: 'vendors.manage',
  REPORTS_VIEW: 'reports.view',
  REPORTS_FINANCE: 'reports.finance',
  REPORTS_EXPORT: 'reports.export',
  // Commercial P4 — tasks, training, chat and notifications.
  NOTIFICATIONS_VIEW: 'notifications.view',
  TASKS_VIEW_OWN: 'tasks.view_own',
  TASKS_VIEW_DEPARTMENT: 'tasks.view_department',
  TASKS_VIEW_COMPANY: 'tasks.view_company',
  TASKS_CREATE: 'tasks.create',
  TASKS_REVIEW: 'tasks.review',
  TASKS_EDIT: 'tasks.edit',
  TASKS_COMMENT_CREATE: 'tasks.comment.create',
  TASKS_ATTACHMENT_MANAGE: 'tasks.attachment.manage',
  TRAINING_VIEW_OWN: 'training.view_own',
  TRAINING_VIEW_DEPARTMENT: 'training.view_department',
  TRAINING_VIEW_COMPANY: 'training.view_company',
  TRAINING_MANAGE: 'training.manage',
  TRAINING_REVIEW: 'training.review',
  TRAINING_CERTIFICATE_ISSUE: 'training.certificate.issue',
  TRAINING_EVALUATION_CREATE: 'training.evaluation.create',
  TRAINING_EVALUATION_VIEW: 'training.evaluation.view',
  CHAT_VIEW: 'chat.view',
} as const;

export const EMPLOYEE_VIEW_PERMISSIONS = [
  PERMISSIONS.EMPLOYEES_VIEW,
  PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT,
] as const;

export const DEPARTMENT_VIEW_PERMISSIONS = [
  PERMISSIONS.HR_MANAGE,
  PERMISSIONS.EMPLOYEES_VIEW,
  PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT,
  PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT,
] as const;

export const ATTENDANCE_VIEW_PERMISSIONS = [
  PERMISSIONS.ATTENDANCE_VIEW,
  PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT,
] as const;

export const LEAVE_VIEW_PERMISSIONS = [
  PERMISSIONS.LEAVES_VIEW,
  PERMISSIONS.LEAVES_VIEW_OWN,
  PERMISSIONS.LEAVES_CREATE,
  PERMISSIONS.LEAVES_REVIEW,
  PERMISSIONS.LEAVES_APPROVE,
] as const;

export const LEAVE_COMPANY_VIEW_PERMISSIONS = [
  PERMISSIONS.LEAVES_VIEW,
] as const;

export const APPROVAL_INBOX_PERMISSIONS = [
  PERMISSIONS.LEAVES_REVIEW,
  PERMISSIONS.LEAVES_APPROVE,
] as const;

export const PAYROLL_VIEW_PERMISSIONS = [
  PERMISSIONS.PAYROLL_VIEW,
] as const;

export const FINANCE_VIEW_PERMISSIONS = [
  PERMISSIONS.FINANCE_VIEW,
] as const;

export const PURCHASING_VIEW_PERMISSIONS = [
  PERMISSIONS.PURCHASING_VIEW,
  PERMISSIONS.PURCHASING_VIEW_DEPARTMENT,
  PERMISSIONS.PURCHASING_VIEW_OWN,
] as const;

export const SUPPLIER_VIEW_PERMISSIONS = [
  PERMISSIONS.VENDORS_VIEW,
  PERMISSIONS.VENDORS_MANAGE,
] as const;

export const REPORTS_VIEW_PERMISSIONS = [
  PERMISSIONS.REPORTS_VIEW,
  PERMISSIONS.REPORTS_FINANCE,
  PERMISSIONS.PURCHASING_REPORT,
] as const;

export const TASK_VIEW_PERMISSIONS = [
  PERMISSIONS.TASKS_VIEW_OWN,
  PERMISSIONS.TASKS_VIEW_DEPARTMENT,
  PERMISSIONS.TASKS_VIEW_COMPANY,
] as const;

export const TRAINING_VIEW_PERMISSIONS = [
  PERMISSIONS.TRAINING_VIEW_OWN,
  PERMISSIONS.TRAINING_VIEW_DEPARTMENT,
  PERMISSIONS.TRAINING_VIEW_COMPANY,
] as const;

export const CHAT_VIEW_PERMISSIONS = [PERMISSIONS.CHAT_VIEW] as const;

export const NOTIFICATION_VIEW_PERMISSIONS = [PERMISSIONS.NOTIFICATIONS_VIEW] as const;

export function hasAnyPermission(
  permissions: readonly string[],
  required: readonly string[],
): boolean {
  if (required.length === 0) return true;
  if (permissions.includes(ADMIN_FULL)) return true;
  return required.some((permission) => permissions.includes(permission));
}

export type NavigationItem = {
  id: string;
  requiredPermissions: readonly string[];
  available: boolean;
};

export function visibleNavigationItems(
  items: readonly NavigationItem[],
  permissions: readonly string[],
): NavigationItem[] {
  return items.filter(
    (item) => item.available && hasAnyPermission(permissions, item.requiredPermissions),
  );
}

export function canViewEmployees(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, EMPLOYEE_VIEW_PERMISSIONS);
}

export function canCreateEmployees(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.EMPLOYEES_CREATE]);
}

export function canViewDepartments(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, DEPARTMENT_VIEW_PERMISSIONS);
}

export function canManageDepartments(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.HR_MANAGE]);
}

export function canViewAttendance(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, ATTENDANCE_VIEW_PERMISSIONS);
}

export function canViewLeaves(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, LEAVE_VIEW_PERMISSIONS);
}

export function canViewCompanyLeaves(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, LEAVE_COMPANY_VIEW_PERMISSIONS);
}

export function canCreateLeaves(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.LEAVES_CREATE]);
}

export function canAccessApprovalInbox(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, APPROVAL_INBOX_PERMISSIONS);
}

export function canApproveLeaves(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.LEAVES_APPROVE]);
}

export function canAdminApproveLeaves(permissions: readonly string[]): boolean {
  return permissions.includes(ADMIN_FULL);
}

export function canViewPayroll(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, PAYROLL_VIEW_PERMISSIONS);
}

export function canManagePayroll(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.PAYROLL_MANAGE]);
}

export function canApprovePayroll(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.PAYROLL_APPROVE]);
}

export function canAdjustPayroll(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.PAYROLL_ITEM_ADJUST]);
}

export function canReopenPayroll(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.PAYROLL_PERIOD_REOPEN]);
}

export function canViewFinance(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, FINANCE_VIEW_PERMISSIONS);
}

export function canCreateFinance(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.FINANCE_CREATE]);
}

export function canApproveFinance(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.FINANCE_APPROVE]);
}

export function canManageFinance(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.FINANCE_MANAGE]);
}

export function canViewOwnerSalary(permissions: readonly string[]): boolean {
  // Backend: admin.full does NOT grant salary.view_owner — keep the same rule in the UI.
  return permissions.includes(PERMISSIONS.SALARY_VIEW_OWNER);
}

/** Post-to-ledger requires finance.approve or finance.manage (backend checkAnyPermission). */
export function canPostPayrollToLedger(permissions: readonly string[]): boolean {
  return canApproveFinance(permissions) || canManageFinance(permissions);
}

// ---------------------------------------------------------------------------
// Commercial Wave 2 — purchasing, suppliers and reports.
//
// These mirror the backend `checkAnyPermission` guards exactly. Hiding a button
// is never the protection: every action is re-checked server side, and each of
// these helpers exists only so the UI does not offer an action that will 403.
// ---------------------------------------------------------------------------

export function canViewPurchasing(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, PURCHASING_VIEW_PERMISSIONS);
}

export function canManagePurchasingOrders(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.PURCHASING_MANAGE]);
}

export function canReceivePurchasing(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.PURCHASING_RECEIVE]);
}

export function canOverrideReceipt(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.PURCHASING_ADMIN_OVERRIDE]);
}

export function canManageQuotations(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.PURCHASING_QUOTATION_MANAGE]);
}

export function canCompareQuotations(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.PURCHASING_QUOTATION_COMPARE]);
}

/** Reading quotations needs either quotation permission (backend checkAnyPermission). */
export function canViewQuotations(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [
    PERMISSIONS.PURCHASING_QUOTATION_MANAGE,
    PERMISSIONS.PURCHASING_QUOTATION_COMPARE,
  ]);
}

export function canCreateReturns(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.PURCHASING_RETURN_CREATE]);
}

export function canApproveReturns(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.PURCHASING_RETURN_APPROVE]);
}

export function canViewSuppliers(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, SUPPLIER_VIEW_PERMISSIONS);
}

export function canManageSuppliers(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.VENDORS_MANAGE]);
}

export function canViewReports(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, REPORTS_VIEW_PERMISSIONS);
}

export function canExportReports(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.REPORTS_EXPORT]);
}

// ---------------------------------------------------------------------------
// Commercial P4 — tasks, training, chat and notifications.
//
// Same rule as every helper above: these mirror the backend `checkAnyPermission`
// guards so the UI does not offer an action that would 403. Hiding a control is
// never the protection — the backend re-checks each one independently.
// ---------------------------------------------------------------------------

export function canViewTasks(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, TASK_VIEW_PERMISSIONS);
}

export function canCreateTasks(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.TASKS_CREATE]);
}

export function canEditTasks(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.TASKS_EDIT]);
}

export function canReviewTasks(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.TASKS_REVIEW]);
}

export function canCommentOnTasks(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.TASKS_COMMENT_CREATE]);
}

/** Only own-scope holders can progress their own assignment. */
export function canProgressOwnTasks(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.TASKS_VIEW_OWN]);
}

export function canViewTraining(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, TRAINING_VIEW_PERMISSIONS);
}

export function canIssueTrainingCertificate(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.TRAINING_CERTIFICATE_ISSUE]);
}

export function canCreateTrainingEvaluation(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.TRAINING_EVALUATION_CREATE]);
}

/**
 * Reading an evaluation needs its own key. Backend deliberately does NOT accept
 * the ordinary training view scope here, because an evaluation is a
 * performance-adjacent judgment rather than course metadata.
 */
export function canViewTrainingEvaluation(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, [PERMISSIONS.TRAINING_EVALUATION_VIEW]);
}

export function canViewChat(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, CHAT_VIEW_PERMISSIONS);
}

export function canViewNotifications(permissions: readonly string[]): boolean {
  return hasAnyPermission(permissions, NOTIFICATION_VIEW_PERMISSIONS);
}
