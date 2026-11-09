export type AccountType = 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense';

export type ChartOfAccountRecord = {
  id: string;
  companyId: string;
  code: string;
  name: string;
  type: AccountType | string;
  parentId: string | null;
  status: string;
  archivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type CostCenterRecord = {
  id: string;
  companyId: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  archivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type JournalLineRecord = {
  id?: string;
  lineNo: number;
  accountId: string;
  costCenterId: string | null;
  debit: string;
  credit: string;
  lineMemo: string | null;
};

export type JournalEntryRecord = {
  id: string;
  companyId: string;
  status: 'draft' | 'posted' | 'reversed' | string;
  entryDate: string;
  reference: string | null;
  memo: string | null;
  currency: string;
  totalDebit: string;
  totalCredit: string;
  postedAt: string | null;
  reversedAt: string | null;
  reversesJournalEntryId: string | null;
  sourceType: string | null;
  sourcePayrollPeriodId: string | null;
  sourceCalculationVersion: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  lines: JournalLineRecord[];
  idempotent?: boolean;
};

export type CreateAccountInput = {
  code: string;
  name: string;
  type: AccountType;
  parentId?: string | null;
};

export type PatchAccountInput = {
  name?: string;
  type?: AccountType;
  parentId?: string | null;
};

export type CreateCostCenterInput = {
  code: string;
  name: string;
  description?: string | null;
};

export type PatchCostCenterInput = {
  name?: string;
  description?: string | null;
};

export type JournalLineInput = {
  accountId: string;
  costCenterId?: string | null;
  debit: string;
  credit: string;
  lineMemo?: string | null;
};

export type CreateJournalInput = {
  entryDate: string;
  reference?: string | null;
  memo?: string | null;
  currency?: string;
  lines: JournalLineInput[];
};

export type PatchJournalInput = {
  entryDate?: string;
  reference?: string | null;
  memo?: string | null;
  lines?: JournalLineInput[];
};
