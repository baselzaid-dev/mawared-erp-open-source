import { createHash } from 'node:crypto';

export const OWNER_MAPPING_COLUMNS = [
  'company_id',
  'company_name',
  'intended_owner_user_id',
  'intended_owner_name',
  'intended_owner_email',
  'owner_active_status',
  'company_membership_validation',
  'existing_ownership_status',
  'ambiguity_warning',
  'review_status',
  'reviewer',
  'notes',
] as const;

export type OwnerMappingColumn = (typeof OWNER_MAPPING_COLUMNS)[number];

export type OwnershipInventoryStatus = 'available' | 'not_created';

export type OwnershipInventoryRecord = {
  id: string;
  companyId: string;
  userId: string;
  isPrimary: boolean;
  status: string;
};

export type OwnershipUserInventory = {
  id: string;
  companyId: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  employeeId: string | null;
  employeeStatus: string | null;
  isActive: boolean;
};

export type OwnershipCompanyInventory = {
  id: string;
  name: string;
  users: OwnershipUserInventory[];
  existingOwnerships: OwnershipInventoryRecord[];
  ownershipInventoryStatus: OwnershipInventoryStatus;
};

export type ParsedOwnerMappingRow = Record<OwnerMappingColumn, string> & {
  rowNumber: number;
};

export type MappingValidationIssue = {
  code: string;
  message: string;
  rowNumber?: number;
};

export type ValidatedOwnerMapping = {
  companyId: string;
  companyName: string;
  ownerUserId: string;
  ownerName: string;
  ownerEmail: string;
  reviewer: string;
  notes: string;
};

export type OwnershipPlanRow = {
  companyId: string;
  ownerUserId: string;
  ownershipId: string;
  action: 'create' | 'already_matches';
};

export type OwnershipPlan = {
  version: 1;
  inventoryDigest: string;
  mappingDigest: string;
  rows: OwnershipPlanRow[];
};

export class OwnershipMappingValidationError extends Error {
  readonly issues: MappingValidationIssue[];

  constructor(issues: MappingValidationIssue[]) {
    super(`Owner mapping validation failed with ${issues.length} issue(s)`);
    this.name = 'OwnershipMappingValidationError';
    this.issues = issues;
  }
}

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
      throw new OwnershipMappingValidationError([{
        code: 'CSV_MALFORMED',
        message: 'A closing CSV quote must be followed by a delimiter or line ending',
      }]);
    }

    if (character === '"') {
      if (cell.length > 0) {
        throw new OwnershipMappingValidationError([{
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
    throw new OwnershipMappingValidationError([{
      code: 'CSV_MALFORMED',
      message: 'The CSV input contains an unterminated quoted value',
    }]);
  }

  row.push(cell);
  rows.push(row);
  return rows.filter((cells) => cells.some((value) => value.trim().length > 0));
};

export const parseOwnerMappingCsv = (csv: string): ParsedOwnerMappingRow[] => {
  const rawRows = parseCsvCells(csv);
  const rows = rawRows.map((cells, rowIndex) => cells.map((value) => {
    const trimmed = value.trim();
    if (/^''[=+\-@]/.test(trimmed)) return trimmed.slice(1);
    if (/^'[=+\-@]/.test(trimmed)) return trimmed.slice(1);
    if (/^[=+\-@]/.test(trimmed)) {
      throw new OwnershipMappingValidationError([{
        code: 'SPREADSHEET_FORMULA_UNSAFE',
        message: `CSV row ${rowIndex + 1} contains an unprotected spreadsheet formula`,
        rowNumber: rowIndex + 1,
      }]);
    }
    return value;
  }));
  if (rows.length === 0) {
    throw new OwnershipMappingValidationError([{
      code: 'MISSING_HEADER',
      message: 'The owner mapping CSV is empty',
    }]);
  }

  const headers = rows[0].map((value) => value.trim());
  const issues: MappingValidationIssue[] = [];
  const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
  for (const header of new Set(duplicateHeaders)) {
    issues.push({ code: 'DUPLICATE_COLUMN', message: `CSV column appears more than once: ${header}` });
  }
  for (const requiredColumn of OWNER_MAPPING_COLUMNS) {
    if (!headers.includes(requiredColumn)) {
      issues.push({
        code: 'MISSING_REQUIRED_COLUMN',
        message: `Required CSV column is missing: ${requiredColumn}`,
      });
    }
  }
  for (const header of headers) {
    if (!OWNER_MAPPING_COLUMNS.includes(header as OwnerMappingColumn)) {
      issues.push({ code: 'UNEXPECTED_COLUMN', message: `Unexpected CSV column: ${header || '(blank)'}` });
    }
  }
  if (issues.length > 0) throw new OwnershipMappingValidationError(issues);

  return rows.slice(1).map((cells, index) => {
    if (cells.length !== headers.length) {
      throw new OwnershipMappingValidationError([{
        code: 'CSV_COLUMN_COUNT_MISMATCH',
        message: `CSV row ${index + 2} has ${cells.length} cells; expected ${headers.length}`,
        rowNumber: index + 2,
      }]);
    }
    const record = Object.fromEntries(headers.map((header, columnIndex) => [
      header,
      cells[columnIndex].trim(),
    ])) as Record<OwnerMappingColumn, string>;
    return { ...record, rowNumber: index + 2 };
  });
};

export const deriveAmbiguityWarning = (users: OwnershipUserInventory[]): string => {
  const activeAdminFullUsers = users.filter((user) => (
    user.isActive && user.permissions.includes('admin.full')
  ));
  if (activeAdminFullUsers.length === 0) return 'no_active_admin_full_users';
  if (activeAdminFullUsers.length === 1) return 'single_active_admin_full_user_not_authoritative';
  return `multiple_active_admin_full_users:${activeAdminFullUsers.length}`;
};

export const deriveExistingOwnershipStatus = (company: OwnershipCompanyInventory): string => {
  if (company.ownershipInventoryStatus === 'not_created') return 'not_created';
  const activePrimary = company.existingOwnerships.filter((record) => (
    record.isPrimary && record.status === 'active'
  ));
  if (activePrimary.length === 0) return 'none';
  if (activePrimary.length === 1) return `active:${activePrimary[0].userId}`;
  return `multiple_active:${activePrimary.length}`;
};

const normalizeEmail = (value: string): string => value.trim().toLocaleLowerCase('en-US');
const compareOrdinal = (left: string, right: string): number => (
  left < right ? -1 : left > right ? 1 : 0
);

export const validateOwnerMapping = (
  rows: ParsedOwnerMappingRow[],
  companies: OwnershipCompanyInventory[],
): ValidatedOwnerMapping[] => {
  const issues: MappingValidationIssue[] = [];
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const allExistingOwnerships = companies.flatMap((company) => company.existingOwnerships);
  const companiesByUserId = new Map<string, Set<string>>();
  for (const company of companies) {
    for (const user of company.users) {
      const memberships = companiesByUserId.get(user.id) ?? new Set<string>();
      memberships.add(company.id);
      companiesByUserId.set(user.id, memberships);
    }
  }

  const rowCountByCompany = new Map<string, number>();
  const ownerIdsByCompany = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.company_id) {
      rowCountByCompany.set(row.company_id, (rowCountByCompany.get(row.company_id) ?? 0) + 1);
      const owners = ownerIdsByCompany.get(row.company_id) ?? new Set<string>();
      if (row.intended_owner_user_id) owners.add(row.intended_owner_user_id);
      ownerIdsByCompany.set(row.company_id, owners);
    }
  }

  for (const [companyId, count] of rowCountByCompany) {
    if (count > 1) {
      issues.push({ code: 'DUPLICATE_COMPANY', message: `Company appears ${count} times: ${companyId}` });
      if ((ownerIdsByCompany.get(companyId)?.size ?? 0) > 1) {
        issues.push({
          code: 'MULTIPLE_OWNERS',
          message: `Company maps to multiple intended Primary Owners: ${companyId}`,
        });
      }
    }
  }

  for (const company of companies) {
    if (!rowCountByCompany.has(company.id)) {
      issues.push({ code: 'MISSING_COMPANY', message: `No reviewed owner mapping exists for company ${company.id}` });
    }
    if (company.ownershipInventoryStatus === 'available') {
      const activePrimary = company.existingOwnerships.filter((record) => (
        record.isPrimary && record.status === 'active'
      ));
      if (activePrimary.length > 1) {
        issues.push({
          code: 'MULTIPLE_EXISTING_ACTIVE_OWNERS',
          message: `Company already has ${activePrimary.length} active Primary Owners: ${company.id}`,
        });
      }
    }
  }

  const validated: ValidatedOwnerMapping[] = [];
  for (const row of rows) {
    const rowIssueCount = issues.length;
    const company = companyById.get(row.company_id);
    if (!row.company_id) {
      issues.push({ code: 'MISSING_COMPANY_ID', message: 'Company ID is required', rowNumber: row.rowNumber });
    } else if (!company) {
      issues.push({
        code: 'UNKNOWN_COMPANY',
        message: `Unknown company ID: ${row.company_id}`,
        rowNumber: row.rowNumber,
      });
    }

    if (!row.intended_owner_user_id) {
      issues.push({ code: 'MISSING_USER', message: 'Intended owner user ID is required', rowNumber: row.rowNumber });
    }

    if (row.review_status.toLocaleLowerCase('en-US') !== 'approved') {
      issues.push({
        code: 'UNREVIEWED_MAPPING',
        message: 'Review status must be approved',
        rowNumber: row.rowNumber,
      });
    }
    if (!row.reviewer) {
      issues.push({ code: 'MISSING_REVIEWER', message: 'Reviewer is required', rowNumber: row.rowNumber });
    }

    if (!company) continue;
    if (row.company_name !== company.name) {
      issues.push({
        code: 'COMPANY_NAME_MISMATCH',
        message: `Company name does not match inventory for ${company.id}`,
        rowNumber: row.rowNumber,
      });
    }

    const localUser = company.users.find((user) => user.id === row.intended_owner_user_id);
    if (!localUser && row.intended_owner_user_id) {
      const memberships = companiesByUserId.get(row.intended_owner_user_id);
      issues.push({
        code: memberships && !memberships.has(company.id) ? 'CROSS_COMPANY_USER' : 'UNKNOWN_USER',
        message: memberships
          ? `User ${row.intended_owner_user_id} does not belong to company ${company.id}`
          : `Unknown user ID: ${row.intended_owner_user_id}`,
        rowNumber: row.rowNumber,
      });
    }

    if (localUser) {
      if (!localUser.isActive) {
        issues.push({
          code: 'INACTIVE_USER',
          message: `Intended owner is inactive: ${localUser.id}`,
          rowNumber: row.rowNumber,
        });
      }
      if (row.intended_owner_name !== localUser.name) {
        issues.push({
          code: 'OWNER_NAME_MISMATCH',
          message: `Owner name does not match inventory for ${localUser.id}`,
          rowNumber: row.rowNumber,
        });
      }
      if (normalizeEmail(row.intended_owner_email) !== normalizeEmail(localUser.email)) {
        issues.push({
          code: 'OWNER_EMAIL_MISMATCH',
          message: `Owner email does not match inventory for ${localUser.id}`,
          rowNumber: row.rowNumber,
        });
      }
    }

    if (row.owner_active_status !== 'active') {
      issues.push({
        code: 'OWNER_ACTIVE_STATUS_NOT_CONFIRMED',
        message: 'Owner active status must be confirmed as active',
        rowNumber: row.rowNumber,
      });
    }
    if (row.company_membership_validation !== 'valid') {
      issues.push({
        code: 'COMPANY_MEMBERSHIP_NOT_CONFIRMED',
        message: 'Company membership validation must be confirmed as valid',
        rowNumber: row.rowNumber,
      });
    }

    const expectedExistingStatus = deriveExistingOwnershipStatus(company);
    if (row.existing_ownership_status !== expectedExistingStatus) {
      issues.push({
        code: 'EXISTING_OWNERSHIP_STATUS_MISMATCH',
        message: `Existing ownership status must be ${expectedExistingStatus}`,
        rowNumber: row.rowNumber,
      });
    }
    const expectedAmbiguityWarning = deriveAmbiguityWarning(company.users);
    if (row.ambiguity_warning !== expectedAmbiguityWarning) {
      issues.push({
        code: 'AMBIGUITY_WARNING_MISMATCH',
        message: `Ambiguity warning must be ${expectedAmbiguityWarning}`,
        rowNumber: row.rowNumber,
      });
    }

    const activePrimary = company.existingOwnerships.filter((record) => (
      record.isPrimary && record.status === 'active'
    ));
    if (row.intended_owner_user_id) {
      const expectedOwnershipId = deterministicOwnershipId(company.id, row.intended_owner_user_id);
      const idConflict = allExistingOwnerships.find((record) => (
        record.id === expectedOwnershipId
        && (
          record.companyId !== company.id
          || record.userId !== row.intended_owner_user_id
          || !record.isPrimary
          || record.status !== 'active'
        )
      ));
      if (idConflict) {
        issues.push({
          code: 'DETERMINISTIC_OWNERSHIP_ID_CONFLICT',
          message: `Deterministic ownership ID is already used by a different or non-active record for company ${company.id}`,
          rowNumber: row.rowNumber,
        });
      }
    }
    if (activePrimary.length === 1 && activePrimary[0].userId !== row.intended_owner_user_id) {
      issues.push({
        code: 'EXISTING_OWNERSHIP_CONFLICT',
        message: `Existing active Primary Owner conflicts with mapping for company ${company.id}`,
        rowNumber: row.rowNumber,
      });
    }

    if (issues.length === rowIssueCount) {
      validated.push({
        companyId: company.id,
        companyName: company.name,
        ownerUserId: localUser!.id,
        ownerName: localUser!.name,
        ownerEmail: localUser!.email,
        reviewer: row.reviewer,
        notes: row.notes,
      });
    }
  }

  if (issues.length > 0) throw new OwnershipMappingValidationError(issues);
  return validated.sort((left, right) => compareOrdinal(left.companyId, right.companyId));
};

const deterministicOwnershipId = (companyId: string, userId: string): string => (
  `co_${createHash('md5').update(`${companyId}:${userId}:primary`, 'utf8').digest('hex')}`
);

const sha256Json = (value: unknown): string => (
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
);

export const calculateOwnershipInventoryDigest = (
  companies: OwnershipCompanyInventory[],
): string => sha256Json(companies
  .map((company) => ({
    id: company.id,
    name: company.name,
    ownershipInventoryStatus: company.ownershipInventoryStatus,
    users: company.users
      .map((user) => ({
        id: user.id,
        companyId: user.companyId,
        name: user.name,
        email: user.email,
        roleId: user.roleId,
        roleName: user.roleName,
        permissions: [...user.permissions].sort(),
        employeeId: user.employeeId,
        employeeStatus: user.employeeStatus,
        isActive: user.isActive,
      }))
      .sort((left, right) => compareOrdinal(left.id, right.id)),
    existingOwnerships: company.existingOwnerships
      .map((record) => ({
        id: record.id,
        companyId: record.companyId,
        userId: record.userId,
        isPrimary: record.isPrimary,
        status: record.status,
      }))
      .sort((left, right) => compareOrdinal(left.id, right.id)),
  }))
  .sort((left, right) => compareOrdinal(left.id, right.id)));

export const buildOwnershipPlan = (
  csv: string,
  companies: OwnershipCompanyInventory[],
): OwnershipPlan => {
  const parsed = parseOwnerMappingCsv(csv);
  const validated = validateOwnerMapping(parsed, companies);
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const rows: OwnershipPlanRow[] = validated.map((mapping) => {
    const company = companyById.get(mapping.companyId)!;
    const matchingOwnerExists = company.existingOwnerships.some((record) => (
      record.isPrimary && record.status === 'active' && record.userId === mapping.ownerUserId
    ));
    return {
      companyId: mapping.companyId,
      ownerUserId: mapping.ownerUserId,
      ownershipId: deterministicOwnershipId(mapping.companyId, mapping.ownerUserId),
      action: matchingOwnerExists ? 'already_matches' : 'create',
    };
  });
  const inventoryDigest = calculateOwnershipInventoryDigest(companies);
  const reviewedEvidence = parsed
    .map((row) => Object.fromEntries(OWNER_MAPPING_COLUMNS.map((column) => [column, row[column]])))
    .sort((left, right) => compareOrdinal(String(left.company_id), String(right.company_id)));
  return {
    version: 1,
    inventoryDigest,
    mappingDigest: sha256Json({ version: 1, inventoryDigest, reviewedEvidence }),
    rows,
  };
};

const protectSpreadsheetFormula = (value: string): string => {
  const trimmed = value.trim();
  if (/^'[=+\-@]/.test(trimmed)) return `'${trimmed}`;
  if (/^[=+\-@]/.test(trimmed)) return `'${trimmed}`;
  return value;
};

const escapeCsvCell = (value: string): string => (
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
);

export const serializeOwnerMappingRows = (
  rows: Array<Record<OwnerMappingColumn, string>>,
): string => [
  OWNER_MAPPING_COLUMNS.join(','),
  ...rows.map((row) => OWNER_MAPPING_COLUMNS
    .map((column) => escapeCsvCell(protectSpreadsheetFormula(row[column])))
    .join(',')),
].join('\n');
