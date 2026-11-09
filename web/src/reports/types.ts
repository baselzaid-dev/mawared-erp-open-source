/** Company Web types for the reports catalog and the Wave 2 registration contract. */

export interface ReportCatalogEntry {
  type: string;
  title: string;
  description: string;
  availableScopes: string[];
  supportedFilters: string[];
  exportAvailable: boolean;
  containsFinancialData: boolean;
  maximumRangeDays: number;
  /** `built_in` for the original report types, `registered` for Wave 2+ modules. */
  source?: 'built_in' | 'registered';
  module?: string;
}

export interface ReportDetail {
  type?: string;
  generatedAt: string;
  range: { from: string; to: string } | null;
  scope: { kind: 'company' | 'department'; departmentId: string | null };
  summary: Record<string, string | number | boolean | null>;
  rows: Array<Record<string, unknown>>;
  pagination: { page: number; pageSize: number; total: number };
  warnings: string[];
  protectedRowsHidden?: boolean;
  protectedRowCount?: number;
}

export interface ReportExportResult {
  filename: string;
  blob: Blob;
}
