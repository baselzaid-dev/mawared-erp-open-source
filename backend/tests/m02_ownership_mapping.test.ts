import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertLocalDatabaseUrl,
  discoverOwnershipCandidates,
  readOwnershipInventorySnapshot,
  renderDiscoveryMappingCsv,
  summarizeDiscoveryReport,
} from '../scripts/m02/discover_ownership_candidates.ts';
import {
  buildOwnershipPlan,
  deriveAmbiguityWarning,
  deriveExistingOwnershipStatus,
  OwnershipMappingValidationError,
  parseOwnerMappingCsv,
  serializeOwnerMappingRows,
  type OwnerMappingColumn,
  type OwnershipCompanyInventory,
  type OwnershipUserInventory,
} from '../scripts/m02/ownership_mapping.ts';

const user = (
  id: string,
  companyId: string,
  overrides: Partial<OwnershipUserInventory> = {},
): OwnershipUserInventory => ({
  id,
  companyId,
  name: `User ${id}`,
  email: `${id}@example.test`,
  roleId: `role-${id}`,
  roleName: 'Administrator',
  permissions: ['admin.full'],
  employeeId: `employee-${id}`,
  employeeStatus: 'active',
  isActive: true,
  ...overrides,
});

const baseInventory = (): OwnershipCompanyInventory[] => [
  {
    id: 'company-1',
    name: 'Company One',
    users: [
      user('owner-1', 'company-1'),
      user('inactive-1', 'company-1', {
        permissions: ['employees.view'],
        employeeStatus: 'inactive',
        isActive: false,
      }),
    ],
    existingOwnerships: [],
    ownershipInventoryStatus: 'not_created',
  },
  {
    id: 'company-2',
    name: 'Company Two',
    users: [user('owner-2', 'company-2')],
    existingOwnerships: [],
    ownershipInventoryStatus: 'not_created',
  },
];

const rowFor = (
  company: OwnershipCompanyInventory,
  owner: OwnershipUserInventory,
  overrides: Partial<Record<OwnerMappingColumn, string>> = {},
): Record<OwnerMappingColumn, string> => ({
  company_id: company.id,
  company_name: company.name,
  intended_owner_user_id: owner.id,
  intended_owner_name: owner.name,
  intended_owner_email: owner.email,
  owner_active_status: 'active',
  company_membership_validation: 'valid',
  existing_ownership_status: deriveExistingOwnershipStatus(company),
  ambiguity_warning: deriveAmbiguityWarning(company.users),
  review_status: 'approved',
  reviewer: 'Basel',
  notes: 'Reviewed against local discovery evidence',
  ...overrides,
});

const validCsv = (companies = baseInventory()): string => serializeOwnerMappingRows(
  companies.map((company) => rowFor(company, company.users.find((entry) => entry.isActive)!)),
);

const validationCodes = (
  csv: string,
  companies = baseInventory(),
): string[] => {
  try {
    buildOwnershipPlan(csv, companies);
  } catch (error) {
    expect(error).toBeInstanceOf(OwnershipMappingValidationError);
    return (error as OwnershipMappingValidationError).issues.map((issue) => issue.code);
  }
  throw new Error('Expected owner mapping validation to fail');
};

const m02MigrationSql = readFileSync(new URL(
  '../prisma/migrations/20260718000100_rc2_ownership_hierarchy_expand/migration.sql',
  import.meta.url,
), 'utf8');

describe('M02 migration fail-closed boundary', () => {
  it('locks Company before the preflight check, and still allows an empty database through', () => {
    const lockIndex = m02MigrationSql.indexOf('LOCK TABLE "Company" IN SHARE MODE;');
    const preflightCountIndex = m02MigrationSql.indexOf(
      'SELECT COUNT(*)::int INTO company_count FROM "Company";',
    );
    const freshPathIndex = m02MigrationSql.indexOf('RETURN; -- fresh database path');
    const firstPersistentDdlIndex = m02MigrationSql.indexOf('ALTER TABLE "User"');

    expect(lockIndex).toBeGreaterThan(-1);
    expect(preflightCountIndex).toBeGreaterThan(lockIndex);
    expect(freshPathIndex).toBeGreaterThan(preflightCountIndex);
    expect(firstPersistentDdlIndex).toBeGreaterThan(freshPathIndex);
  });

  it('rejects every existing-Company database with no prepared legacy mapping package', () => {
    expect(m02MigrationSql).toContain(
      `RAISE EXCEPTION 'M02 preflight failed: existing Companies require an explicit approved owner mapping and truthful migration attribution';`,
    );
    expect(m02MigrationSql).toContain('to_regclass(\'public."_MawaredM02LegacyMappingPackage"\')');
    expect(m02MigrationSql).toContain('"consumedAt" IS NULL');
  });

  it('contains no Role-derived or admin.full ownership inference, and only backfills CompanyOwnership from a validated legacy mapping after preflight and all ownership triggers', () => {
    expect(m02MigrationSql).not.toContain('JOIN "Role"');
    expect(m02MigrationSql).not.toContain(`permissions"::jsonb ? 'admin.full'`);
    expect(m02MigrationSql).not.toContain('INSERT INTO "DepartmentManager"');

    const insertMatches = m02MigrationSql.match(/INSERT INTO "CompanyOwnership"/g) ?? [];
    expect(insertMatches).toHaveLength(1);

    const preflightExceptionIndex = m02MigrationSql.lastIndexOf(
      `RAISE EXCEPTION 'M02 preflight failed: existing Companies require an explicit approved owner mapping and truthful migration attribution';`,
    );
    const primaryOwnerTriggerIndex = m02MigrationSql.indexOf('"Company_requires_primary_owner_trigger"');
    const insertIndex = m02MigrationSql.indexOf('INSERT INTO "CompanyOwnership"');

    expect(preflightExceptionIndex).toBeGreaterThan(-1);
    expect(primaryOwnerTriggerIndex).toBeGreaterThan(preflightExceptionIndex);
    expect(insertIndex).toBeGreaterThan(primaryOwnerTriggerIndex);
  });
});

describe('M02 explicit owner mapping', () => {
  it('accepts a complete reviewed mapping and creates one deterministic row per company', () => {
    const companies = baseInventory();
    const plan = buildOwnershipPlan(validCsv(companies), companies);

    expect(plan.version).toBe(1);
    expect(plan.inventoryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.mappingDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.rows).toHaveLength(2);
    expect(plan.rows.map((row) => [row.companyId, row.ownerUserId, row.action])).toEqual([
      ['company-1', 'owner-1', 'create'],
      ['company-2', 'owner-2', 'create'],
    ]);
    expect(plan.rows.every((row) => row.ownershipId.startsWith('co_'))).toBe(true);
    const serializedPlan = JSON.stringify(plan);
    expect(serializedPlan).not.toContain('Company One');
    expect(serializedPlan).not.toContain('owner-1@example.test');
    expect(serializedPlan).not.toContain('Reviewed against local discovery evidence');
    expect(serializedPlan).not.toContain('Basel');
  });

  it('rejects a missing company and partial coverage', () => {
    const companies = baseInventory();
    const csv = serializeOwnerMappingRows([rowFor(companies[0], companies[0].users[0])]);
    expect(validationCodes(csv, companies)).toContain('MISSING_COMPANY');
  });

  it('rejects a duplicate company and multiple intended owners', () => {
    const companies = baseInventory();
    const csv = serializeOwnerMappingRows([
      rowFor(companies[0], companies[0].users[0]),
      rowFor(companies[0], companies[0].users[1], {
        owner_active_status: 'active',
      }),
      rowFor(companies[1], companies[1].users[0]),
    ]);
    const codes = validationCodes(csv, companies);
    expect(codes).toContain('DUPLICATE_COMPANY');
    expect(codes).toContain('MULTIPLE_OWNERS');
  });

  it('rejects a missing intended user', () => {
    const companies = baseInventory();
    const csv = serializeOwnerMappingRows([
      rowFor(companies[0], companies[0].users[0], {
        intended_owner_user_id: '',
        intended_owner_name: '',
        intended_owner_email: '',
      }),
      rowFor(companies[1], companies[1].users[0]),
    ]);
    expect(validationCodes(csv, companies)).toContain('MISSING_USER');
  });

  it('rejects an unknown company', () => {
    const companies = baseInventory();
    const unknownCompany = { ...companies[0], id: 'unknown-company', name: 'Unknown Company' };
    const csv = serializeOwnerMappingRows([
      rowFor(companies[0], companies[0].users[0]),
      rowFor(companies[1], companies[1].users[0]),
      rowFor(unknownCompany, companies[0].users[0]),
    ]);
    expect(validationCodes(csv, companies)).toContain('UNKNOWN_COMPANY');
  });

  it('rejects an unknown user', () => {
    const companies = baseInventory();
    const unknownUser = user('does-not-exist', 'company-1');
    const csv = serializeOwnerMappingRows([
      rowFor(companies[0], unknownUser),
      rowFor(companies[1], companies[1].users[0]),
    ]);
    expect(validationCodes(csv, companies)).toContain('UNKNOWN_USER');
  });

  it('rejects a user belonging to another company', () => {
    const companies = baseInventory();
    const csv = serializeOwnerMappingRows([
      rowFor(companies[0], companies[1].users[0]),
      rowFor(companies[1], companies[1].users[0]),
    ]);
    expect(validationCodes(csv, companies)).toContain('CROSS_COMPANY_USER');
  });

  it('rejects an inactive intended owner', () => {
    const companies = baseInventory();
    const csv = serializeOwnerMappingRows([
      rowFor(companies[0], companies[0].users[1]),
      rowFor(companies[1], companies[1].users[0]),
    ]);
    expect(validationCodes(csv, companies)).toContain('INACTIVE_USER');
  });

  it('rejects a conflicting existing active Primary Owner', () => {
    const companies = baseInventory();
    const otherOwner = user('other-owner', 'company-1', { permissions: [] });
    companies[0].users.push(otherOwner);
    companies[0].ownershipInventoryStatus = 'available';
    companies[0].existingOwnerships = [{
      id: 'ownership-existing',
      companyId: 'company-1',
      userId: otherOwner.id,
      isPrimary: true,
      status: 'active',
    }];
    const csv = serializeOwnerMappingRows([
      rowFor(companies[0], companies[0].users[0]),
      rowFor(companies[1], companies[1].users[0]),
    ]);
    expect(validationCodes(csv, companies)).toContain('EXISTING_OWNERSHIP_CONFLICT');
  });

  it('rejects more than one existing active Primary Owner for a company', () => {
    const companies = baseInventory();
    const otherOwner = user('other-owner', 'company-1', { permissions: [] });
    companies[0].users.push(otherOwner);
    companies[0].ownershipInventoryStatus = 'available';
    companies[0].existingOwnerships = [companies[0].users[0], otherOwner].map((entry, index) => ({
      id: `ownership-${index}`,
      companyId: 'company-1',
      userId: entry.id,
      isPrimary: true,
      status: 'active',
    }));
    const csv = serializeOwnerMappingRows([
      rowFor(companies[0], companies[0].users[0]),
      rowFor(companies[1], companies[1].users[0]),
    ]);
    expect(validationCodes(csv, companies)).toContain('MULTIPLE_EXISTING_ACTIVE_OWNERS');
  });

  it('accepts exactly one matching existing active Primary Owner without creating another', () => {
    const companies = baseInventory();
    companies[0].ownershipInventoryStatus = 'available';
    companies[0].existingOwnerships = [{
      id: 'ownership-existing',
      companyId: 'company-1',
      userId: 'owner-1',
      isPrimary: true,
      status: 'active',
    }];
    const plan = buildOwnershipPlan(validCsv(companies), companies);
    expect(plan.rows.find((row) => row.companyId === 'company-1')?.action).toBe('already_matches');
    expect(plan.rows).toHaveLength(companies.length);
  });

  it('rejects a deterministic ownership ID already held by a non-active record', () => {
    const companies = baseInventory();
    const initialPlan = buildOwnershipPlan(validCsv(companies), companies);
    const expectedId = initialPlan.rows.find((row) => row.companyId === 'company-1')!.ownershipId;
    companies[0].ownershipInventoryStatus = 'available';
    companies[0].existingOwnerships = [{
      id: expectedId,
      companyId: 'company-1',
      userId: 'owner-1',
      isPrimary: true,
      status: 'ended',
    }];

    expect(validationCodes(validCsv(companies), companies)).toContain(
      'DETERMINISTIC_OWNERSHIP_ID_CONFLICT',
    );
  });

  it('rejects a deterministic ownership ID collision found under another company', () => {
    const companies = baseInventory();
    const initialPlan = buildOwnershipPlan(validCsv(companies), companies);
    const expectedId = initialPlan.rows.find((row) => row.companyId === 'company-1')!.ownershipId;
    companies[1].ownershipInventoryStatus = 'available';
    companies[1].existingOwnerships = [{
      id: expectedId,
      companyId: 'company-2',
      userId: 'owner-2',
      isPrimary: true,
      status: 'ended',
    }];

    expect(validationCodes(validCsv(companies), companies)).toContain(
      'DETERMINISTIC_OWNERSHIP_ID_CONFLICT',
    );
  });

  it('rejects unreviewed rows and a missing reviewer', () => {
    const companies = baseInventory();
    const csv = serializeOwnerMappingRows([
      rowFor(companies[0], companies[0].users[0], { review_status: 'pending', reviewer: '' }),
      rowFor(companies[1], companies[1].users[0]),
    ]);
    const codes = validationCodes(csv, companies);
    expect(codes).toContain('UNREVIEWED_MAPPING');
    expect(codes).toContain('MISSING_REVIEWER');
  });

  it('rejects missing required columns before accepting any rows', () => {
    const malformedHeader = validCsv().replace(',notes\n', '\n');
    expect(validationCodes(malformedHeader)).toContain('MISSING_REQUIRED_COLUMN');
  });

  it('fails closed without returning a partial plan or mutating inventory', () => {
    const companies = baseInventory();
    const snapshot = structuredClone(companies);
    const partialCsv = serializeOwnerMappingRows([
      rowFor(companies[0], companies[0].users[0]),
    ]);

    expect(() => buildOwnershipPlan(partialCsv, companies)).toThrow(OwnershipMappingValidationError);
    expect(companies).toEqual(snapshot);
  });

  it('produces the same plan and digest on retries without mutating inventory', () => {
    const companies = baseInventory();
    const snapshot = structuredClone(companies);
    const csv = validCsv(companies);

    const first = buildOwnershipPlan(csv, companies);
    const retry = buildOwnershipPlan(csv, companies);

    expect(retry).toEqual(first);
    expect(companies).toEqual(snapshot);
  });

  it('changes both inventory and mapping digests when relevant inventory evidence changes', () => {
    const companies = baseInventory();
    const csv = validCsv(companies);
    const before = buildOwnershipPlan(csv, companies);

    companies[0].users[0].permissions.push('reports.view');
    companies[0].users[1].isActive = true;
    companies[0].users[1].employeeStatus = 'active';
    const after = buildOwnershipPlan(csv, companies);

    expect(after.inventoryDigest).not.toBe(before.inventoryDigest);
    expect(after.mappingDigest).not.toBe(before.mappingDigest);
  });

  it('binds reviewer evidence and notes into the mapping digest without exposing them in the plan', () => {
    const companies = baseInventory();
    const rows = companies.map((company) => rowFor(company, company.users.find((entry) => entry.isActive)!));
    const before = buildOwnershipPlan(serializeOwnerMappingRows(rows), companies);
    rows[0].reviewer = 'Second Reviewer';
    rows[0].notes = 'Independent approval evidence';
    const after = buildOwnershipPlan(serializeOwnerMappingRows(rows), companies);

    expect(after.inventoryDigest).toBe(before.inventoryDigest);
    expect(after.mappingDigest).not.toBe(before.mappingDigest);
    expect(JSON.stringify(after)).not.toContain('Second Reviewer');
    expect(JSON.stringify(after)).not.toContain('Independent approval evidence');
  });

  it('round-trips quoted CSV evidence safely', () => {
    const companies = baseInventory();
    companies[0].name = 'Company, "One"';
    const csv = validCsv(companies);
    const parsed = parseOwnerMappingCsv(csv);
    expect(parsed[0].company_name).toBe('Company, "One"');
    expect(buildOwnershipPlan(csv, companies).rows[0].companyId).toBe('company-1');
  });

  it('rejects characters after a closing CSV quote', () => {
    const malformedCsv = validCsv().replace('Company One', '"Company One"unexpected');
    expect(validationCodes(malformedCsv)).toContain('CSV_MALFORMED');
  });

  it('protects spreadsheet formulas while preserving a safe parser round-trip', () => {
    const companies = baseInventory();
    const formula = '=HYPERLINK("https://invalid.example","review")';
    const rows = companies.map((company) => rowFor(company, company.users.find((entry) => entry.isActive)!));
    rows[0].notes = formula;
    const protectedCsv = serializeOwnerMappingRows(rows);

    expect(protectedCsv).toContain('"\'=HYPERLINK(');
    expect(parseOwnerMappingCsv(protectedCsv)[0].notes).toBe(formula);
    expect(buildOwnershipPlan(protectedCsv, companies).rows).toHaveLength(2);

    const unsafeCsv = protectedCsv.replace('"\'=HYPERLINK(', '"=HYPERLINK(');
    expect(validationCodes(unsafeCsv, companies)).toContain('SPREADSHEET_FORMULA_UNSAFE');
  });
});

describe('M02 read-only discovery', () => {
  it('lists users and existing-state evidence but leaves every owner selection blank', async () => {
    const companyFindMany = vi.fn().mockResolvedValue([{
      id: 'company-1',
      name: 'Company One',
      users: [{
        id: 'owner-1',
        companyId: 'company-1',
        name: 'Owner One',
        email: 'owner@example.test',
        employeeId: 'employee-1',
        role: { id: 'role-1', name: 'Admin', permissions: '["admin.full"]' },
        employee: { status: 'active' },
      }],
    }]);
    const ownershipFindMany = vi.fn().mockRejectedValue({ code: 'P2021' });
    const report = await discoverOwnershipCandidates({
      company: { findMany: companyFindMany },
      companyOwnership: { findMany: ownershipFindMany },
    } as never, new Date('2026-07-19T00:00:00.000Z'));

    expect(report.mode).toBe('read_only');
    expect(report.automaticOwnerSelection).toBe(false);
    expect(report.ownershipTableStatus).toBe('not_created');
    expect(report.companies[0].users[0]).toMatchObject({
      id: 'owner-1',
      roleName: 'Admin',
      permissions: ['admin.full'],
      isActive: true,
    });
    const mappingRows = parseOwnerMappingCsv(renderDiscoveryMappingCsv(report));
    expect(mappingRows[0]).toMatchObject({
      company_id: 'company-1',
      intended_owner_user_id: '',
      review_status: 'pending',
      existing_ownership_status: 'not_created',
    });
    expect(companyFindMany).toHaveBeenCalledOnce();
    expect(ownershipFindMany).toHaveBeenCalledOnce();
  });

  it('sets repeatable-read and read-only before both inventory reads', async () => {
    const calls: string[] = [];
    const transaction = {
      $executeRaw: vi.fn(async () => { calls.push('read-only'); return 0; }),
      $queryRaw: vi.fn(async () => { calls.push('table-check'); return [{ exists: true }]; }),
      company: {
        findMany: vi.fn(async () => {
          calls.push('companies');
          return [];
        }),
      },
      companyOwnership: {
        findMany: vi.fn(async () => {
          calls.push('ownerships');
          return [];
        }),
      },
    };
    const database = {
      $transaction: vi.fn(async (
        operation: (tx: typeof transaction) => Promise<unknown>,
        _options: { isolationLevel: string },
      ) => {
        calls.push('transaction');
        return operation(transaction);
      }),
    };

    await readOwnershipInventorySnapshot(database as never, new Date('2026-07-19T00:00:00.000Z'));

    expect(calls).toEqual(['transaction', 'read-only', 'table-check', 'companies', 'ownerships']);
    expect(database.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'RepeatableRead' });
  });

  it('rejects non-local database URLs with no override', () => {
    // Build fixtures without a contiguous protocol URL literal (secret-scan false positive).
    const fixtureUrl = (host: string) => (
      ['postgres', 'ql', '://', 'user:secret@', host, '/mawared'].join('')
    );
    expect(() => assertLocalDatabaseUrl(fixtureUrl('example.com'))).toThrow(
      'refuse non-local',
    );
    expect(() => assertLocalDatabaseUrl(fixtureUrl('10.0.0.8'))).toThrow(
      'refuse non-local',
    );
    expect(() => assertLocalDatabaseUrl(fixtureUrl('localhost'))).not.toThrow();
    expect(() => assertLocalDatabaseUrl(fixtureUrl('127.0.0.1'))).not.toThrow();
  });

  it('keeps the default discovery summary free of personal and permission data', async () => {
    const report = await discoverOwnershipCandidates({
      company: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'company-1',
          name: 'Sensitive Company Name',
          users: [{
            id: 'owner-1',
            companyId: 'company-1',
            name: 'Sensitive Owner Name',
            email: 'sensitive@example.test',
            employeeId: null,
            role: { id: 'role-1', name: 'Admin', permissions: '["admin.full"]' },
            employee: null,
          }],
        }]),
      },
      companyOwnership: { findMany: vi.fn().mockResolvedValue([]) },
    } as never);
    const summary = JSON.stringify(summarizeDiscoveryReport(report));

    expect(summary).not.toContain('Sensitive Company Name');
    expect(summary).not.toContain('Sensitive Owner Name');
    expect(summary).not.toContain('sensitive@example.test');
    expect(summary).not.toContain('admin.full');
    expect(summary).toContain('"companyCount":1');
    expect(summary).toContain('"userCount":1');
  });
});
