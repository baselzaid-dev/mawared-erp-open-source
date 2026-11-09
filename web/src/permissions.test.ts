import { describe, expect, it } from 'vitest';
import {
  canAccessApprovalInbox,
  canAdminApproveLeaves,
  canApproveFinance,
  canApproveLeaves,
  canApprovePayroll,
  canAdjustPayroll,
  canCreateFinance,
  canCreateLeaves,
  canManageFinance,
  canManagePayroll,
  canPostPayrollToLedger,
  canReopenPayroll,
  canViewAttendance,
  canViewCompanyLeaves,
  canViewFinance,
  canViewLeaves,
  canViewOwnerSalary,
  canViewPayroll,
  canApproveReturns,
  canCompareQuotations,
  canCreateReturns,
  canExportReports,
  canManagePurchasingOrders,
  canManageQuotations,
  canManageSuppliers,
  canOverrideReceipt,
  canReceivePurchasing,
  canViewQuotations,
  canCommentOnTasks,
  canCreateTasks,
  canCreateTrainingEvaluation,
  canEditTasks,
  canIssueTrainingCertificate,
  canReviewTasks,
  canViewChat,
  canViewNotifications,
  canViewTasks,
  canViewTraining,
  canViewTrainingEvaluation,
  visibleNavigationItems,
  ADMIN_FULL,
  CHAT_VIEW_PERMISSIONS,
  NOTIFICATION_VIEW_PERMISSIONS,
  PURCHASING_VIEW_PERMISSIONS,
  REPORTS_VIEW_PERMISSIONS,
  SUPPLIER_VIEW_PERMISSIONS,
  TASK_VIEW_PERMISSIONS,
  TRAINING_VIEW_PERMISSIONS,
} from './permissions';

describe('permission-aware navigation', () => {
  it('uses admin.full as the only frontend bypass', () => {
    expect(canViewAttendance(['admin.full'])).toBe(true);
    expect(canViewLeaves(['admin.full'])).toBe(true);
    expect(canViewPayroll(['admin.full'])).toBe(true);
    expect(canViewFinance(['admin.full'])).toBe(true);
    expect(canAccessApprovalInbox(['admin.full'])).toBe(true);
    expect(canApproveLeaves(['admin.full'])).toBe(true);
    expect(canAdminApproveLeaves(['admin.full'])).toBe(true);
    expect(canViewAttendance(['other.admin'])).toBe(false);
  });

  it('shows attendance, leaves, approvals, payroll, and finance only when available and authorized', () => {
    const items = [
      { id: 'overview', requiredPermissions: [], available: true },
      { id: 'employees', requiredPermissions: ['employees.view', 'employees.view_department'], available: true },
      { id: 'departments', requiredPermissions: ['hr.manage', 'employees.view'], available: true },
      { id: 'attendance', requiredPermissions: ['attendance.view', 'attendance.view_department'], available: true },
      { id: 'leaves', requiredPermissions: ['leaves.view', 'leaves.view_own', 'leaves.create', 'leaves.review', 'leaves.approve'], available: true },
      { id: 'approvals', requiredPermissions: ['leaves.review', 'leaves.approve'], available: true },
      { id: 'payroll', requiredPermissions: ['payroll.view'], available: true },
      { id: 'finance', requiredPermissions: ['finance.view'], available: true },
    ];

    expect(visibleNavigationItems(items, ['attendance.view_department']).map((item) => item.id)).toEqual([
      'overview',
      'attendance',
    ]);
    expect(visibleNavigationItems(items, ['leaves.create']).map((item) => item.id)).toEqual([
      'overview',
      'leaves',
    ]);
    expect(visibleNavigationItems(items, ['leaves.approve']).map((item) => item.id)).toEqual([
      'overview',
      'leaves',
      'approvals',
    ]);
    expect(visibleNavigationItems(items, ['payroll.view']).map((item) => item.id)).toEqual([
      'overview',
      'payroll',
    ]);
    expect(visibleNavigationItems(items, ['finance.view']).map((item) => item.id)).toEqual([
      'overview',
      'finance',
    ]);
    expect(visibleNavigationItems(items, []).map((item) => item.id)).toEqual(['overview']);
  });

  it('gates leave create and approval actions separately from view', () => {
    expect(canCreateLeaves(['leaves.view'])).toBe(false);
    expect(canCreateLeaves(['leaves.create'])).toBe(true);
    expect(canViewCompanyLeaves(['leaves.view_own'])).toBe(false);
    expect(canViewCompanyLeaves(['leaves.review'])).toBe(false);
    expect(canViewCompanyLeaves(['leaves.approve'])).toBe(false);
    expect(canViewCompanyLeaves(['leaves.view'])).toBe(true);
    expect(canApproveLeaves(['leaves.review'])).toBe(false);
    expect(canApproveLeaves(['leaves.approve'])).toBe(true);
    expect(canAdminApproveLeaves(['leaves.approve'])).toBe(false);
  });

  it('gates payroll and finance actions separately from view', () => {
    expect(canViewPayroll(['payroll.manage'])).toBe(false);
    expect(canManagePayroll(['payroll.view'])).toBe(false);
    expect(canManagePayroll(['payroll.manage'])).toBe(true);
    expect(canApprovePayroll(['payroll.manage'])).toBe(false);
    expect(canApprovePayroll(['payroll.approve'])).toBe(true);
    expect(canAdjustPayroll(['payroll.manage'])).toBe(false);
    expect(canAdjustPayroll(['payroll.item.adjust'])).toBe(true);
    expect(canReopenPayroll(['payroll.approve'])).toBe(false);
    expect(canReopenPayroll(['payroll.period.reopen'])).toBe(true);
    expect(canViewFinance(['finance.create'])).toBe(false);
    expect(canCreateFinance(['finance.view'])).toBe(false);
    expect(canCreateFinance(['finance.create'])).toBe(true);
    expect(canApproveFinance(['finance.manage'])).toBe(false);
    expect(canApproveFinance(['finance.approve'])).toBe(true);
    expect(canManageFinance(['finance.approve'])).toBe(false);
    expect(canManageFinance(['finance.manage'])).toBe(true);
    expect(canPostPayrollToLedger(['finance.view'])).toBe(false);
    expect(canPostPayrollToLedger(['finance.approve'])).toBe(true);
    expect(canPostPayrollToLedger(['finance.manage'])).toBe(true);
    expect(canViewOwnerSalary(['admin.full'])).toBe(false);
    expect(canViewOwnerSalary(['payroll.view'])).toBe(false);
    expect(canViewOwnerSalary(['salary.view_owner'])).toBe(true);
  });

  it('shows the Wave 2 purchasing, suppliers and reports entries only when authorized', () => {
    const items = [
      { id: 'overview', requiredPermissions: [], available: true },
      { id: 'purchasing', requiredPermissions: [...PURCHASING_VIEW_PERMISSIONS], available: true },
      { id: 'suppliers', requiredPermissions: [...SUPPLIER_VIEW_PERMISSIONS], available: true },
      { id: 'reports', requiredPermissions: [...REPORTS_VIEW_PERMISSIONS], available: true },
    ];

    expect(visibleNavigationItems(items, ['purchasing.view_own']).map((item) => item.id)).toEqual([
      'overview',
      'purchasing',
    ]);
    expect(visibleNavigationItems(items, ['vendors.view']).map((item) => item.id)).toEqual([
      'overview',
      'suppliers',
    ]);
    expect(visibleNavigationItems(items, ['purchasing.report']).map((item) => item.id)).toEqual([
      'overview',
      'reports',
    ]);
    expect(visibleNavigationItems(items, ['leaves.view']).map((item) => item.id)).toEqual(['overview']);
    expect(visibleNavigationItems(items, ['admin.full']).map((item) => item.id)).toEqual([
      'overview',
      'purchasing',
      'suppliers',
      'reports',
    ]);
  });

  it('mirrors the backend purchasing permission boundaries exactly', () => {
    // Viewing purchasing never implies acting on it.
    expect(canManagePurchasingOrders(['purchasing.view'])).toBe(false);
    expect(canManagePurchasingOrders(['purchasing.manage'])).toBe(true);
    expect(canReceivePurchasing(['purchasing.manage'])).toBe(false);
    expect(canReceivePurchasing(['purchasing.receive'])).toBe(true);

    // Over-receipt needs the elevated override permission, not purchasing.receive.
    expect(canOverrideReceipt(['purchasing.receive'])).toBe(false);
    expect(canOverrideReceipt(['purchasing.admin_override'])).toBe(true);

    // Quotation capture/award and comparison are separate keys.
    expect(canManageQuotations(['purchasing.quotation.compare'])).toBe(false);
    expect(canManageQuotations(['purchasing.quotation.manage'])).toBe(true);
    expect(canCompareQuotations(['purchasing.quotation.manage'])).toBe(false);
    expect(canCompareQuotations(['purchasing.quotation.compare'])).toBe(true);
    // Reading the quotation list accepts either.
    expect(canViewQuotations(['purchasing.quotation.manage'])).toBe(true);
    expect(canViewQuotations(['purchasing.quotation.compare'])).toBe(true);
    expect(canViewQuotations(['purchasing.view'])).toBe(false);

    // Raising and approving a return are deliberately different keys.
    expect(canCreateReturns(['purchasing.return.approve'])).toBe(false);
    expect(canCreateReturns(['purchasing.return.create'])).toBe(true);
    expect(canApproveReturns(['purchasing.return.create'])).toBe(false);
    expect(canApproveReturns(['purchasing.return.approve'])).toBe(true);

    expect(canManageSuppliers(['vendors.view'])).toBe(false);
    expect(canManageSuppliers(['vendors.manage'])).toBe(true);
    expect(canExportReports(['reports.view'])).toBe(false);
    expect(canExportReports(['reports.export'])).toBe(true);
  });

  it('mirrors the Commercial P4 task, training, chat and notification guards', () => {
    // Any of the three task view scopes opens the module.
    expect(canViewTasks(['tasks.view_own'])).toBe(true);
    expect(canViewTasks(['tasks.view_department'])).toBe(true);
    expect(canViewTasks(['tasks.view_company'])).toBe(true);
    expect(canViewTasks(['training.view_own'])).toBe(false);

    // Creating, editing, reviewing and commenting are four distinct keys:
    // holding one must never imply another.
    expect(canCreateTasks(['tasks.view_company'])).toBe(false);
    expect(canCreateTasks(['tasks.create'])).toBe(true);
    expect(canEditTasks(['tasks.create'])).toBe(false);
    expect(canEditTasks(['tasks.edit'])).toBe(true);
    expect(canReviewTasks(['tasks.edit'])).toBe(false);
    expect(canReviewTasks(['tasks.review'])).toBe(true);
    expect(canCommentOnTasks(['tasks.view_own'])).toBe(false);
    expect(canCommentOnTasks(['tasks.comment.create'])).toBe(true);

    expect(canViewTraining(['training.view_own'])).toBe(true);
    expect(canViewTraining(['tasks.view_own'])).toBe(false);
    expect(canIssueTrainingCertificate(['training.manage'])).toBe(false);
    expect(canIssueTrainingCertificate(['training.certificate.issue'])).toBe(true);

    // Evaluations are performance-adjacent: the ordinary training view scope is
    // deliberately NOT enough to read one, matching the backend guard exactly.
    expect(canViewTrainingEvaluation(['training.view_company'])).toBe(false);
    expect(canViewTrainingEvaluation(['training.evaluation.create'])).toBe(false);
    expect(canViewTrainingEvaluation(['training.evaluation.view'])).toBe(true);
    expect(canCreateTrainingEvaluation(['training.evaluation.view'])).toBe(false);
    expect(canCreateTrainingEvaluation(['training.evaluation.create'])).toBe(true);

    expect(canViewChat(['chat.create_direct'])).toBe(false);
    expect(canViewChat(['chat.view'])).toBe(true);
    expect(canViewNotifications([])).toBe(false);
    expect(canViewNotifications(['notifications.view'])).toBe(true);

    // admin.full remains the single bypass on every P4 helper.
    expect(canEditTasks([ADMIN_FULL])).toBe(true);
    expect(canViewTrainingEvaluation([ADMIN_FULL])).toBe(true);
    expect(canViewChat([ADMIN_FULL])).toBe(true);
  });

  it('hides P4 navigation entries an account cannot use', () => {
    const navigation = [
      { id: 'tasks', requiredPermissions: TASK_VIEW_PERMISSIONS, available: true },
      { id: 'training', requiredPermissions: TRAINING_VIEW_PERMISSIONS, available: true },
      { id: 'chat', requiredPermissions: CHAT_VIEW_PERMISSIONS, available: true },
      { id: 'notifications', requiredPermissions: NOTIFICATION_VIEW_PERMISSIONS, available: true },
    ];

    const employee = visibleNavigationItems(navigation, [
      'tasks.view_own',
      'training.view_own',
      'notifications.view',
    ]);
    expect(employee.map((item) => item.id)).toEqual(['tasks', 'training', 'notifications']);

    // Hiding is UX only — the backend still rejects a direct call to /api/chat/*.
    const noPermissions = visibleNavigationItems(navigation, []);
    expect(noPermissions).toHaveLength(0);
  });
});
