export type PayrollPeriodStatus = 'draft' | 'calculated' | 'approved' | 'paid' | string;

export type PayrollMoneySummary = {
  visibleEmployeeCount: number;
  visibleGross: string;
  visibleDeductions: string;
  visibleNet: string;
  currency: string;
};

export type PayrollPeriodRecord = {
  id: string;
  companyId: string;
  month: number;
  year: number;
  status: PayrollPeriodStatus;
  calculationVersion: number;
  createdAt: string | null;
  calculatedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  reopenedAt: string | null;
  ledgerPostedAt: string | null;
  legacyWithoutItems?: boolean;
  itemCount?: number;
  visibleSummary?: PayrollMoneySummary | null;
  protectedRowsHidden?: boolean;
  protectedRowCount?: number;
  fullSummary?: PayrollMoneySummary;
};

export type PayrollItemRecord = {
  id: string;
  payrollPeriodId: string;
  employeeId: string;
  employeeName: string;
  employeeNum: string;
  departmentName: string | null;
  baseSalary: string;
  grossPay: string;
  totalDeductions: string;
  netPay: string;
  currency: string;
  status: string;
  calculatedAt: string | null;
};

export type PayrollItemsResponse = {
  period: PayrollPeriodRecord;
  items: PayrollItemRecord[];
  visibleSummary: PayrollMoneySummary | null;
  protectedRowsHidden: boolean;
  protectedRowCount: number;
  fullSummary?: PayrollMoneySummary;
  idempotent?: boolean;
  recalculated?: boolean;
  protectedEmployeeIssues?: number;
};

export type CreatePayrollPeriodInput = {
  month: number;
  year: number;
};

export type CalculatePayrollInput = {
  recalculationReason?: string;
};

export type AdjustPayrollItemInput = {
  direction: 'allowance' | 'deduction';
  amount: string;
  reason: string;
};

export type AdjustPreviewResponse = {
  preview: true;
  direction: 'allowance' | 'deduction';
  amount: string | null;
  resultingGross: string | null;
  resultingDeductions: string | null;
  resultingNet: string | null;
  redacted: boolean;
  requiresRecalculation: boolean;
};

export type AdjustApplyResponse = {
  idempotent?: boolean;
  adjustment: {
    id: string;
    payrollPeriodId: string;
    employeeId: string;
    payrollItemId: string | null;
    direction: 'allowance' | 'deduction';
    amount: string | null;
    reason: string | null;
    status: string;
    createdAt: string | null;
    redacted: boolean;
  };
  requiresRecalculation: boolean;
  resultingGross: string | null;
  resultingDeductions: string | null;
  resultingNet: string | null;
  redacted: boolean;
};

export type ReopenPayrollInput = {
  reason: string;
  confirm: true;
  confirmationPhrase: string;
};

export type ReopenPayrollResponse = {
  id: string;
  status: string;
  calculationVersion: number;
  reopenedAt: string | null;
  message?: string;
};

export type ApprovePayrollResponse = {
  period: PayrollPeriodRecord;
  message?: string;
};

export type PostToLedgerInput = {
  expenseAccountId: string;
  payableAccountId: string;
  deductionAccountId?: string;
};

export type PostToLedgerResponse = {
  idempotent: boolean;
  postingId: string;
  journalEntryId: string;
  calculationVersion: number;
  totalDebit: string | null;
  totalCredit: string | null;
  lineCount: number;
};

export type ComponentDefinitionRecord = {
  id: string;
  companyId: string;
  code: string;
  name: string;
  componentType: 'allowance' | 'deduction' | string;
  calcMethod: 'fixed' | 'percentage' | string;
  fixedAmount: string | null;
  rateBps: number | null;
  percentageBasis: string | null;
  version: number;
  status: string;
  currency: string;
  archivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};
