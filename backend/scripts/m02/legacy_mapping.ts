// M02 legacy owner-mapping EXECUTION format. This is deliberately separate from
// `ownership_mapping.ts` (the discovery/review preparation format). This module
// parses the approved, execution-ready legacy mapping CSV, validates it against
// a database inventory, and produces the deterministic canonical payload/digest
// that the M02 migration's fail-closed preflight consumes via prepared control
// tables. It performs no database access and no writes.
//
// CSV parsing helpers are intentionally duplicated from `ownership_mapping.ts`
// (rather than imported) so that neither file's exports need to change shape
// for the other's sake.

import { createHash } from 'node:crypto';

export const LEGACY_MAPPING_COLUMNS = [
  'company_id',
  'primary_owner_user_id',
  'created_by_user_id',
  'approved_by',
  'approved_at',
  'approval_reference',
  'mapping_version',
] as const;

export type LegacyMappingColumn = (typeof LEGACY_MAPPING_COLUMNS)[number];

export const SUPPORTED_MAPPING_VERSION = 'm02-legacy-v1';

// A generous ceiling that still comfortably rejects anything that could not be
// a reasonable legacy mapping for this migration, before any parsing work.
export const MAX_LEGACY_MAPPING_CHARS = 1_000_000;

export type LegacyMappingValidationIssue = {
  code: string;
  message: string;
  rowNumber?: number;
};

export class LegacyMappingValidationError extends Error {
  readonly issues: LegacyMappingValidationIssue[];

  constructor(issues: LegacyMappingValidationIssue[]) {
    super(`Legacy owner mapping validation failed with ${issues.length} issue(s)`);
    this.name = 'LegacyMappingValidationError';
    this.issues = issues;
  }
}

// Structurally valid, format-checked row. Every row carries a copy of the
// shared approval metadata because the CSV requires every row to agree on it.
export type LegacyMappingRow = {
  rowNumber: number;
  companyId: string;
  primaryOwnerUserId: string;
  createdByUserId: string;
  approvedBy: string;
  approvedAt: string; // normalized ISO-8601 (UTC)
  approvalReference: string;
  mappingVersion: string;
};

// A row that has been checked against the live database inventory and is safe
// to persist into the control tables / consume in the migration backfill.
export type ValidatedLegacyMappingRow = {
  companyId: string;
  primaryOwnerUserId: string;
  createdByUserId: string;
  ownerEqualsAttribution: boolean;
};

export type LegacyMappingCompanyUser = {
  id: string;
  isActive: boolean;
};

export type LegacyMappingCompanyInventory = {
  id: string;
  users: LegacyMappingCompanyUser[];
};

const compareOrdinal = (left: string, right: string): number => (
  left < right ? -1 : left > right ? 1 : 0
);

// ---------------------------------------------------------------------------
// Formula-safe CSV parsing (duplicated from ownership_mapping.ts on purpose).
// ---------------------------------------------------------------------------

const parseCsvCells = (csv: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (closedQuote && character !== ',' && character !== '\n' && character !== '\r') {
      throw new LegacyMappingValidationError([{
        code: 'CSV_MALFORMED',
        message: 'A closing CSV quote must be followed by a delimiter or line ending',
      }]);
    }

    if (character === '"') {
      if (cell.length > 0) {
        throw new LegacyMappingValidationError([{
          code: 'CSV_MALFORMED',
          message: 'A quoted CSV value must begin at the start of a cell',
        }]);
      }
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
      closedQuote = false;
    } else if (character === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      closedQuote = false;
    } else if (character !== '\r') {
      cell += character;
    }
  }

  if (quoted) {
    throw new LegacyMappingValidationError([{
      code: 'CSV_MALFORMED',
      message: 'The CSV input contains an unterminated quoted value',
    }]);
  }

  row.push(cell);
  rows.push(row);
  return rows.filter((cells) => cells.some((value) => value.trim().length > 0));
};

const protectAgainstFormulaInjection = (cells: string[], rowIndex: number): string[] => cells.map((value) => {
  const trimmed = value.trim();
  if (/^''[=+\-@]/.test(trimmed)) return trimmed.slice(1);
  if (/^'[=+\-@]/.test(trimmed)) return trimmed.slice(1);
  if (/^[=+\-@]/.test(trimmed)) {
    throw new LegacyMappingValidationError([{
      code: 'SPREADSHEET_FORMULA_UNSAFE',
      message: `CSV row ${rowIndex + 1} contains an unprotected spreadsheet formula`,
      rowNumber: rowIndex + 1,
    }]);
  }
  return value;
});

// ---------------------------------------------------------------------------
// ISO-8601 handling.
// ---------------------------------------------------------------------------

const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/;

const normalizeIsoDateTime = (value: string): string | null => {
  if (!ISO_8601_PATTERN.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
};

// ---------------------------------------------------------------------------
// Parsing + format validation.
// ---------------------------------------------------------------------------

export const parseLegacyMappingCsv = (csv: string): LegacyMappingRow[] => {
  if (csv.length > MAX_LEGACY_MAPPING_CHARS) {
    throw new LegacyMappingValidationError([{
      code: 'MAPPING_TOO_LARGE',
      message: `The legacy mapping CSV exceeds the ${MAX_LEGACY_MAPPING_CHARS} character limit`,
    }]);
  }
  if (csv.trim().length === 0) {
    throw new LegacyMappingValidationError([{
      code: 'EMPTY_MAPPING',
      message: 'The legacy mapping CSV is empty',
    }]);
  }

  const rawRows = parseCsvCells(csv);
  const rows = rawRows.map((cells, rowIndex) => protectAgainstFormulaInjection(cells, rowIndex));

  if (rows.length === 0) {
    throw new LegacyMappingValidationError([{
      code: 'EMPTY_MAPPING',
      message: 'The legacy mapping CSV has no header row',
    }]);
  }

  const headers = rows[0].map((value) => value.trim());
  const issues: LegacyMappingValidationIssue[] = [];
  const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
  for (const header of new Set(duplicateHeaders)) {
    issues.push({ code: 'DUPLICATE_COLUMN', message: `CSV column appears more than once: ${header}` });
  }
  for (const requiredColumn of LEGACY_MAPPING_COLUMNS) {
    if (!headers.includes(requiredColumn)) {
      issues.push({
        code: 'MISSING_REQUIRED_COLUMN',
        message: `Required CSV column is missing: ${requiredColumn}`,
      });
    }
  }
  for (const header of headers) {
    if (!LEGACY_MAPPING_COLUMNS.includes(header as LegacyMappingColumn)) {
      issues.push({ code: 'UNEXPECTED_COLUMN', message: `Unexpected CSV column: ${header || '(blank)'}` });
    }
  }
  if (issues.length > 0) throw new LegacyMappingValidationError(issues);

  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    throw new LegacyMappingValidationError([{
      code: 'EMPTY_MAPPING',
      message: 'The legacy mapping CSV has no data rows',
    }]);
  }

  const parsedRows = dataRows.map((cells, index) => {
    const rowNumber = index + 2;
    if (cells.length !== headers.length) {
      throw new LegacyMappingValidationError([{
        code: 'CSV_COLUMN_COUNT_MISMATCH',
        message: `CSV row ${rowNumber} has ${cells.length} cells; expected ${headers.length}`,
        rowNumber,
      }]);
    }
    const record = Object.fromEntries(headers.map((header, columnIndex) => [
      header,
      cells[columnIndex].trim(),
    ])) as Record<LegacyMappingColumn, string>;
    return { record, rowNumber };
  });

  for (const { record, rowNumber } of parsedRows) {
    if (!record.approved_by) {
      issues.push({ code: 'MISSING_APPROVED_BY', message: 'approved_by is required', rowNumber });
    }
    if (!record.approval_reference) {
      issues.push({ code: 'MISSING_APPROVAL_REFERENCE', message: 'approval_reference is required', rowNumber });
    }
    if (record.mapping_version !== SUPPORTED_MAPPING_VERSION) {
      issues.push({
        code: 'UNSUPPORTED_MAPPING_VERSION',
        message: `Unsupported mapping_version: ${record.mapping_version || '(blank)'}`,
        rowNumber,
      });
    }
    if (!normalizeIsoDateTime(record.approved_at)) {
      issues.push({
        code: 'INVALID_APPROVED_AT',
        message: 'approved_at must be a valid ISO-8601 date or date-time',
        rowNumber,
      });
    }
  }
  if (issues.length > 0) throw new LegacyMappingValidationError(issues);

  const first = parsedRows[0].record;
  const normalizedApprovedAt = normalizeIsoDateTime(first.approved_at)!;
  for (const { record, rowNumber } of parsedRows) {
    const sameApprovedAt = normalizeIsoDateTime(record.approved_at) === normalizedApprovedAt;
    if (
      record.approved_by !== first.approved_by
      || !sameApprovedAt
      || record.approval_reference !== first.approval_reference
      || record.mapping_version !== first.mapping_version
    ) {
      issues.push({
        code: 'APPROVAL_METADATA_MISMATCH',
        message: 'All rows must share identical approved_by, approved_at, approval_reference, and mapping_version',
        rowNumber,
      });
    }
  }
  if (issues.length > 0) throw new LegacyMappingValidationError(issues);

  return parsedRows.map(({ record, rowNumber }) => ({
    rowNumber,
    companyId: record.company_id,
    primaryOwnerUserId: record.primary_owner_user_id,
    createdByUserId: record.created_by_user_id,
    approvedBy: record.approved_by,
    approvedAt: normalizedApprovedAt,
    approvalReference: record.approval_reference,
    mappingVersion: record.mapping_version,
  }));
};

// ---------------------------------------------------------------------------
// Validation against the live (or synthetic, in tests) database inventory.
// ---------------------------------------------------------------------------

export const validateLegacyMappingAgainstCompanies = (
  rows: LegacyMappingRow[],
  companies: LegacyMappingCompanyInventory[],
): ValidatedLegacyMappingRow[] => {
  const issues: LegacyMappingValidationIssue[] = [];
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const usersByCompany = new Map(companies.map((company) => [
    company.id,
    new Map(company.users.map((user) => [user.id, user])),
  ]));
  const companiesByUserId = new Map<string, Set<string>>();
  for (const company of companies) {
    for (const user of company.users) {
      const memberships = companiesByUserId.get(user.id) ?? new Set<string>();
      memberships.add(company.id);
      companiesByUserId.set(user.id, memberships);
    }
  }

  const rowCountByCompany = new Map<string, number>();
  for (const row of rows) {
    if (row.companyId) {
      rowCountByCompany.set(row.companyId, (rowCountByCompany.get(row.companyId) ?? 0) + 1);
    }
  }
  for (const [companyId, count] of rowCountByCompany) {
    if (count > 1) {
      issues.push({ code: 'DUPLICATE_COMPANY', message: `Company appears ${count} times: ${companyId}` });
    }
  }

  const mappedCompanyIds = new Set(rows.map((row) => row.companyId).filter(Boolean));
  for (const company of companies) {
    if (!mappedCompanyIds.has(company.id)) {
      issues.push({ code: 'MISSING_COMPANY', message: `No legacy mapping row exists for company ${company.id}` });
    }
  }
  for (const companyId of mappedCompanyIds) {
    if (!companyById.has(companyId)) {
      issues.push({
        code: 'EXTRA_COMPANY',
        message: `Legacy mapping references a company that does not exist in the database: ${companyId}`,
      });
    }
  }

  const checkUser = (
    companyId: string,
    userId: string,
    label: 'owner' | 'attribution',
    rowNumber: number,
  ): LegacyMappingCompanyUser | undefined => {
    const localUser = usersByCompany.get(companyId)?.get(userId);
    if (localUser) {
      if (!localUser.isActive) {
        issues.push({
          code: 'INACTIVE_USER',
          message: `The ${label} user is inactive: ${userId}`,
          rowNumber,
        });
      }
      return localUser;
    }
    const memberships = companiesByUserId.get(userId);
    if (memberships && !memberships.has(companyId)) {
      issues.push({
        code: 'CROSS_COMPANY_USER',
        message: `The ${label} user ${userId} does not belong to company ${companyId}`,
        rowNumber,
      });
    } else {
      issues.push({
        code: 'UNKNOWN_USER',
        message: `Unknown ${label} user ID: ${userId}`,
        rowNumber,
      });
    }
    return undefined;
  };

  const validated: ValidatedLegacyMappingRow[] = [];
  for (const row of rows) {
    const rowIssueCountBefore = issues.length;
    const company = companyById.get(row.companyId);
    if (!company) {
      issues.push({
        code: 'UNKNOWN_COMPANY',
        message: `Unknown company ID: ${row.companyId || '(blank)'}`,
        rowNumber: row.rowNumber,
      });
      continue;
    }

    if (!row.primaryOwnerUserId) {
      issues.push({ code: 'UNKNOWN_USER', message: 'primary_owner_user_id is required', rowNumber: row.rowNumber });
    } else {
      checkUser(company.id, row.primaryOwnerUserId, 'owner', row.rowNumber);
    }

    if (!row.createdByUserId) {
      issues.push({ code: 'MISSING_ATTRIBUTION', message: 'created_by_user_id is required', rowNumber: row.rowNumber });
    } else {
      checkUser(company.id, row.createdByUserId, 'attribution', row.rowNumber);
    }

    if (issues.length === rowIssueCountBefore) {
      validated.push({
        companyId: row.companyId,
        primaryOwnerUserId: row.primaryOwnerUserId,
        createdByUserId: row.createdByUserId,
        ownerEqualsAttribution: row.primaryOwnerUserId === row.createdByUserId,
      });
    }
  }

  if (issues.length > 0) throw new LegacyMappingValidationError(issues);
  return validated.sort((left, right) => compareOrdinal(left.companyId, right.companyId));
};

// ---------------------------------------------------------------------------
// Deterministic canonical payload, digest, and ownership ID.
// ---------------------------------------------------------------------------

export const buildLegacyMappingCanonicalPayload = (rows: LegacyMappingRow[]): string => {
  if (rows.length === 0) {
    throw new LegacyMappingValidationError([{
      code: 'EMPTY_MAPPING',
      message: 'Cannot build a canonical payload from zero rows',
    }]);
  }

  const first = rows[0];
  const seenCompanyIds = new Set<string>();
  for (const row of rows) {
    if (seenCompanyIds.has(row.companyId)) {
      throw new LegacyMappingValidationError([{
        code: 'DUPLICATE_COMPANY',
        message: `Company appears more than once: ${row.companyId}`,
      }]);
    }
    seenCompanyIds.add(row.companyId);

    if (
      row.approvedBy !== first.approvedBy
      || row.approvedAt !== first.approvedAt
      || row.approvalReference !== first.approvalReference
      || row.mappingVersion !== first.mappingVersion
    ) {
      throw new LegacyMappingValidationError([{
        code: 'APPROVAL_METADATA_MISMATCH',
        message: 'All rows must share identical approval metadata',
        rowNumber: row.rowNumber,
      }]);
    }
  }

  const sortedRows = [...rows]
    .sort((left, right) => compareOrdinal(left.companyId, right.companyId))
    .map((row) => ({
      companyId: row.companyId,
      primaryOwnerUserId: row.primaryOwnerUserId,
      createdByUserId: row.createdByUserId,
    }));

  return JSON.stringify({
    mappingVersion: first.mappingVersion,
    approvedBy: first.approvedBy,
    approvedAt: first.approvedAt,
    approvalReference: first.approvalReference,
    rows: sortedRows,
  });
};

export const calculateLegacyMappingDigest = (canonicalPayload: string): string => (
  createHash('sha256').update(canonicalPayload, 'utf8').digest('hex')
);

// Identical algorithm to the internal helper in ownership_mapping.ts, kept as a
// separate exported copy so this module has no runtime dependency on that one.
export const deterministicOwnershipId = (companyId: string, userId: string): string => (
  `co_${createHash('md5').update(`${companyId}:${userId}:primary`, 'utf8').digest('hex')}`
);
