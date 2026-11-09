/**
 * Report registration contract — published by Commercial Wave 2.
 *
 * WHY THIS EXISTS
 * ---------------
 * The eight built-in report types in `reports.ts` are wired through hand-written
 * `switch` statements, a `Record<ReportType, …>` catalog and a
 * `Record<ReportType, CsvColumn[]>` export map. Every wave that wanted a new
 * report had to edit all of those in incompatible ways. This module is the
 * stable, versioned alternative: a module declares one
 * `RegisteredReportDefinition` and automatically gets
 *
 *   • a catalog entry filtered by its own permission predicate,
 *   • a `GET /api/reports/<key>` detail route,
 *   • CSV export through `POST /api/reports/export` with the shared
 *     formula-injection neutralization and the shared 5,000-row cap,
 *   • company isolation, because the definition only ever receives the
 *     authenticated `ReportUser` and must scope its own queries by
 *     `user.companyId`.
 *
 * COMPATIBILITY
 * -------------
 * The eight built-in report types are intentionally *not* migrated onto this
 * registry: their existing behavior, permissions and CSV columns stay exactly
 * as they are. The registry is additive, so nothing that already works changes.
 *
 * CONTRACT VERSION
 * ----------------
 * `REPORT_REGISTRY_CONTRACT_VERSION` is 1. A definition must declare the
 * version it was written against; registering a definition built against a
 * different version fails loudly at startup rather than silently misbehaving.
 *
 * RULES FOR A DEFINITION
 * ----------------------
 *  1. `key` is a stable snake_case identifier and must not collide with a
 *     built-in report type.
 *  2. `canAccess` must return false unless the user actually holds the
 *     permission for the data. Hiding a catalog entry is not authorization —
 *     the detail route re-checks `canAccess` on every request.
 *  3. `load` must filter by `context.user.companyId` and must never accept a
 *     company id from the request.
 *  4. `load` must respect `context.rowCap` and throw `REPORT_ROW_LIMIT` (via
 *     the supplied `assertRowLimit`) rather than streaming an unbounded result.
 *  5. `columns` drive CSV export. Values are neutralized against spreadsheet
 *     formula injection by the shared exporter — a definition must not build
 *     its own CSV.
 */

import type { ReportUser } from './reports';

export const REPORT_REGISTRY_CONTRACT_VERSION = 1 as const;

/** Shared with the built-in reports; do not raise without a real large-tenant case. */
export const REGISTERED_REPORT_EXPORT_ROW_CAP = 5000;
export const REGISTERED_REPORT_MAX_PAGE_SIZE = 100;

export interface RegisteredReportColumn {
  key: string;
  title: string;
  value?: (row: Record<string, unknown>) => unknown;
}

export interface RegisteredReportResult {
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

export interface RegisteredReportContext {
  prisma: any;
  user: ReportUser;
  /** Raw request query/filters — the definition validates them itself. */
  filters: unknown;
  exportMode: boolean;
  rowCap: number;
  /** Throws the shared `REPORT_ROW_LIMIT` error when a result is too large. */
  assertRowLimit: (count: number) => void;
}

export interface RegisteredReportDefinition {
  key: string;
  contractVersion: typeof REPORT_REGISTRY_CONTRACT_VERSION;
  title: string;
  description: string;
  /** Owning module, used for grouping in the catalog. */
  module: string;
  supportedFilters: readonly string[];
  containsFinancialData: boolean;
  maximumRangeDays: number;
  availableScopes: ReadonlyArray<'company' | 'department'>;
  exportable: boolean;
  canAccess: (user: ReportUser) => boolean;
  columns: readonly RegisteredReportColumn[];
  load: (context: RegisteredReportContext) => Promise<RegisteredReportResult>;
}

export class ReportRegistryError extends Error {}

const KEY_PATTERN = /^[a-z][a-z0-9_]{2,48}$/;

/** Built-in report types this registry must never shadow. */
const RESERVED_KEYS = new Set([
  'overview',
  'attendance',
  'leaves',
  'tasks',
  'payroll',
  'purchasing',
  'training',
  'audit',
  'catalog',
  'export',
]);

const registry = new Map<string, RegisteredReportDefinition>();

export function registerReport(definition: RegisteredReportDefinition): RegisteredReportDefinition {
  if (definition.contractVersion !== REPORT_REGISTRY_CONTRACT_VERSION) {
    throw new ReportRegistryError(
      `report "${definition.key}" targets contract version ${definition.contractVersion}, expected ${REPORT_REGISTRY_CONTRACT_VERSION}`,
    );
  }
  if (!KEY_PATTERN.test(definition.key)) {
    throw new ReportRegistryError(`invalid report key: ${definition.key}`);
  }
  if (RESERVED_KEYS.has(definition.key)) {
    throw new ReportRegistryError(`report key "${definition.key}" is reserved by a built-in report`);
  }
  if (registry.has(definition.key)) {
    throw new ReportRegistryError(`report key "${definition.key}" is already registered`);
  }
  if (definition.columns.length === 0) {
    throw new ReportRegistryError(`report "${definition.key}" must declare at least one export column`);
  }
  if (typeof definition.canAccess !== 'function' || typeof definition.load !== 'function') {
    throw new ReportRegistryError(`report "${definition.key}" must supply canAccess and load`);
  }
  registry.set(definition.key, Object.freeze({ ...definition }));
  return definition;
}

export const getRegisteredReport = (key: string): RegisteredReportDefinition | undefined =>
  registry.get(key);

export const listRegisteredReports = (): RegisteredReportDefinition[] => [...registry.values()];

export const listAccessibleRegisteredReports = (user: ReportUser): RegisteredReportDefinition[] =>
  listRegisteredReports().filter((definition) => definition.canAccess(user));

export const isRegisteredReportKey = (key: string): boolean => registry.has(key);

/** Test-only: lets a suite assert registration failures without leaking state. */
export const __unregisterForTests = (key: string): boolean => registry.delete(key);
