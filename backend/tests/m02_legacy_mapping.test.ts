import { describe, expect, it } from 'vitest';
import {
  buildLegacyMappingCanonicalPayload,
  calculateLegacyMappingDigest,
  deterministicOwnershipId,
  LegacyMappingValidationError,
  parseLegacyMappingCsv,
  SUPPORTED_MAPPING_VERSION,
  validateLegacyMappingAgainstCompanies,
  type LegacyMappingCompanyInventory,
  type LegacyMappingRow,
} from '../scripts/m02/legacy_mapping.ts';

const HEADER = 'company_id,primary_owner_user_id,created_by_user_id,approved_by,approved_at,approval_reference,mapping_version';

type RowOverrides = Partial<{
  companyId: string;
  primaryOwnerUserId: string;
  createdByUserId: string;
  approvedBy: string;
  approvedAt: string;
  approvalReference: string;
  mappingVersion: string;
}>;

const csvRow = (overrides: RowOverrides = {}): string => [
  overrides.companyId ?? 'company-1',
  overrides.primaryOwnerUserId ?? 'owner-1',
  overrides.createdByUserId ?? 'creator-1',
  overrides.approvedBy ?? 'Basel Zaid',
  overrides.approvedAt ?? '2026-07-01T12:00:00Z',
  overrides.approvalReference ?? 'APPROVAL-REF-001',
  overrides.mappingVersion ?? SUPPORTED_MAPPING_VERSION,
].join(',');

const buildCsv = (rows: RowOverrides[]): string => [HEADER, ...rows.map((row) => csvRow(row))].join('\n');

const twoCompanyMapping = (): string => buildCsv([
  { companyId: 'company-1', primaryOwnerUserId: 'owner-1', createdByUserId: 'creator-1' },
  { companyId: 'company-2', primaryOwnerUserId: 'owner-2', createdByUserId: 'creator-2' },
]);

const inventory = (): LegacyMappingCompanyInventory[] => [
  {
    id: 'company-1',
    users: [
      { id: 'owner-1', isActive: true },
      { id: 'creator-1', isActive: true },
    ],
  },
  {
    id: 'company-2',
    users: [
      { id: 'owner-2', isActive: true },
      { id: 'creator-2', isActive: true },
    ],
  },
];

const parseIssues = (csv: string): string[] => {
  try {
    parseLegacyMappingCsv(csv);
  } catch (error) {
    expect(error).toBeInstanceOf(LegacyMappingValidationError);
    return (error as LegacyMappingValidationError).issues.map((issue) => issue.code);
  }
  throw new Error('Expected legacy mapping CSV parsing to fail');
};

const validationIssues = (rows: LegacyMappingRow[], companies: LegacyMappingCompanyInventory[]): string[] => {
  try {
    validateLegacyMappingAgainstCompanies(rows, companies);
  } catch (error) {
    expect(error).toBeInstanceOf(LegacyMappingValidationError);
    return (error as LegacyMappingValidationError).issues.map((issue) => issue.code);
  }
  throw new Error('Expected legacy mapping database validation to fail');
};

describe('M02 legacy mapping CSV parsing', () => {
  it('parses a valid two-company mapping into normalized rows', () => {
    const rows = parseLegacyMappingCsv(twoCompanyMapping());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      companyId: 'company-1',
      primaryOwnerUserId: 'owner-1',
      createdByUserId: 'creator-1',
      approvedBy: 'Basel Zaid',
      approvalReference: 'APPROVAL-REF-001',
      mappingVersion: SUPPORTED_MAPPING_VERSION,
    });
    expect(rows[0].approvedAt).toBe('2026-07-01T12:00:00.000Z');
  });

  it('normalizes a date-only approved_at into a full ISO-8601 instant', () => {
    const rows = parseLegacyMappingCsv(buildCsv([{ approvedAt: '2026-07-01' }]));
    expect(rows[0].approvedAt).toBe(new Date('2026-07-01').toISOString());
  });

  it('rejects an empty file', () => {
    expect(parseIssues('')).toContain('EMPTY_MAPPING');
    expect(parseIssues('   \n  ')).toContain('EMPTY_MAPPING');
  });

  it('rejects a header-only file with no data rows', () => {
    expect(parseIssues(HEADER)).toContain('EMPTY_MAPPING');
  });

  it('rejects a mapping over the character limit', () => {
    const huge = `${HEADER}\n${'a'.repeat(1_000_001)}`;
    expect(parseIssues(huge)).toContain('MAPPING_TOO_LARGE');
  });

  it('rejects missing and unexpected columns', () => {
    const malformedHeader = twoCompanyMapping().replace('mapping_version', 'mapping_ver');
    const codes = parseIssues(malformedHeader);
    expect(codes).toContain('MISSING_REQUIRED_COLUMN');
    expect(codes).toContain('UNEXPECTED_COLUMN');
  });

  it('rejects a blank approved_by or approval_reference', () => {
    const csv = buildCsv([{ approvedBy: '' }, { approvalReference: '' }]);
    const codes = parseIssues(csv);
    expect(codes).toContain('MISSING_APPROVED_BY');
    expect(codes).toContain('MISSING_APPROVAL_REFERENCE');
  });

  it('rejects an invalid approved_at value', () => {
    expect(parseIssues(buildCsv([{ approvedAt: 'not-a-date' }]))).toContain('INVALID_APPROVED_AT');
    expect(parseIssues(buildCsv([{ approvedAt: '2026-13-40' }]))).toContain('INVALID_APPROVED_AT');
  });

  it('rejects an unsupported mapping_version', () => {
    expect(parseIssues(buildCsv([{ mappingVersion: 'm02-legacy-v2' }]))).toContain('UNSUPPORTED_MAPPING_VERSION');
  });

  it('rejects rows whose shared approval metadata does not match', () => {
    const csv = buildCsv([
      { companyId: 'company-1', approvedBy: 'Basel Zaid' },
      { companyId: 'company-2', approvedBy: 'Someone Else' },
    ]);
    expect(parseIssues(csv)).toContain('APPROVAL_METADATA_MISMATCH');
  });

  it('rejects mismatched approval_reference and mapping_version across rows', () => {
    const referenceMismatch = buildCsv([
      { companyId: 'company-1', approvalReference: 'REF-A' },
      { companyId: 'company-2', approvalReference: 'REF-B' },
    ]);
    expect(parseIssues(referenceMismatch)).toContain('APPROVAL_METADATA_MISMATCH');
  });

  it('treats equivalent but differently formatted approved_at values across rows as matching', () => {
    const rows = parseLegacyMappingCsv(buildCsv([
      { companyId: 'company-1', approvedAt: '2026-07-01T12:00:00Z' },
      { companyId: 'company-2', approvedAt: '2026-07-01T12:00:00.000Z' },
    ]));
    expect(rows[0].approvedAt).toBe(rows[1].approvedAt);
  });

  it('protects and round-trips unprotected spreadsheet formulas', () => {
    const csv = buildCsv([{ approvalReference: "'=HYPERLINK(invalid.example)" }]);
    expect(() => parseLegacyMappingCsv(csv)).not.toThrow();
    const unsafe = buildCsv([{ approvalReference: '=HYPERLINK(invalid.example)' }]);
    expect(parseIssues(unsafe)).toContain('SPREADSHEET_FORMULA_UNSAFE');
  });
});

describe('M02 legacy mapping database validation', () => {
  it('accepts a complete, fully-covered mapping', () => {
    const rows = parseLegacyMappingCsv(twoCompanyMapping());
    const validated = validateLegacyMappingAgainstCompanies(rows, inventory());
    expect(validated).toEqual([
      { companyId: 'company-1', primaryOwnerUserId: 'owner-1', createdByUserId: 'creator-1', ownerEqualsAttribution: false },
      { companyId: 'company-2', primaryOwnerUserId: 'owner-2', createdByUserId: 'creator-2', ownerEqualsAttribution: false },
    ]);
  });

  it('flags ownerEqualsAttribution when the owner performed their own migration attribution', () => {
    const rows = parseLegacyMappingCsv(buildCsv([{ primaryOwnerUserId: 'owner-1', createdByUserId: 'owner-1' }]));
    const validated = validateLegacyMappingAgainstCompanies(rows, [
      { id: 'company-1', users: [{ id: 'owner-1', isActive: true }] },
    ]);
    expect(validated[0].ownerEqualsAttribution).toBe(true);
  });

  it('rejects a company missing from the mapping (MISSING_COMPANY)', () => {
    const rows = parseLegacyMappingCsv(buildCsv([{ companyId: 'company-1' }]));
    const codes = validationIssues(rows, inventory());
    expect(codes).toContain('MISSING_COMPANY');
  });

  it('rejects a mapping row referencing a company that does not exist (EXTRA_COMPANY / UNKNOWN_COMPANY)', () => {
    const rows = parseLegacyMappingCsv(buildCsv([
      { companyId: 'company-1' },
      { companyId: 'company-999', primaryOwnerUserId: 'owner-1', createdByUserId: 'creator-1' },
    ]));
    const codes = validationIssues(rows, [{ id: 'company-1', users: [{ id: 'owner-1', isActive: true }, { id: 'creator-1', isActive: true }] }]);
    expect(codes).toContain('EXTRA_COMPANY');
    expect(codes).toContain('UNKNOWN_COMPANY');
  });

  it('rejects a duplicate company row (DUPLICATE_COMPANY)', () => {
    const rows = parseLegacyMappingCsv(buildCsv([
      { companyId: 'company-1', primaryOwnerUserId: 'owner-1', createdByUserId: 'creator-1' },
      { companyId: 'company-1', primaryOwnerUserId: 'creator-1', createdByUserId: 'owner-1' },
    ]));
    const codes = validationIssues(rows, [{
      id: 'company-1',
      users: [{ id: 'owner-1', isActive: true }, { id: 'creator-1', isActive: true }],
    }]);
    expect(codes).toContain('DUPLICATE_COMPANY');
  });

  it('rejects an unknown owner or attribution user (UNKNOWN_USER)', () => {
    const rows = parseLegacyMappingCsv(buildCsv([{ primaryOwnerUserId: 'ghost-user' }]));
    expect(validationIssues(rows, [{ id: 'company-1', users: [{ id: 'creator-1', isActive: true }] }]))
      .toContain('UNKNOWN_USER');
  });

  it('rejects a user who belongs to a different company (CROSS_COMPANY_USER)', () => {
    const rows = parseLegacyMappingCsv(buildCsv([{ primaryOwnerUserId: 'owner-2' }]));
    const codes = validationIssues(rows, [
      { id: 'company-1', users: [{ id: 'creator-1', isActive: true }] },
      { id: 'company-2', users: [{ id: 'owner-2', isActive: true }] },
    ]);
    expect(codes).toContain('CROSS_COMPANY_USER');
  });

  it('rejects an inactive owner and an inactive attribution user (INACTIVE_USER)', () => {
    const rows = parseLegacyMappingCsv(buildCsv([{}]));
    const codes = validationIssues(rows, [{
      id: 'company-1',
      users: [{ id: 'owner-1', isActive: false }, { id: 'creator-1', isActive: false }],
    }]);
    expect(codes.filter((code) => code === 'INACTIVE_USER')).toHaveLength(2);
  });

  it('keeps the approved CMP-DEMO Admin mapping valid when inventory marks the Admin active', () => {
    const adminId = '1eda2cce-b877-4e88-9841-6872eb88c7de';
    const rows = parseLegacyMappingCsv([
      'company_id,primary_owner_user_id,created_by_user_id,approved_by,approved_at,approval_reference,mapping_version',
      `1,${adminId},${adminId},Basel,2026-07-22T00:00:00.000Z,BASEL-M02-CMP-DEMO-2026-07-22,m02-legacy-v1`,
    ].join('\n'));
    const validated = validateLegacyMappingAgainstCompanies(rows, [{
      id: '1',
      users: [{ id: adminId, isActive: true }],
    }]);
    expect(validated).toEqual([{
      companyId: '1',
      primaryOwnerUserId: adminId,
      createdByUserId: adminId,
      ownerEqualsAttribution: true,
    }]);
  });

  it('rejects a blank created_by_user_id (MISSING_ATTRIBUTION)', () => {
    const rows = parseLegacyMappingCsv(buildCsv([{ createdByUserId: '' }]));
    expect(validationIssues(rows, [{
      id: 'company-1',
      users: [{ id: 'owner-1', isActive: true }],
    }])).toContain('MISSING_ATTRIBUTION');
  });

  it('fails closed without mutating the inventory or returning a partial result', () => {
    const rows = parseLegacyMappingCsv(twoCompanyMapping());
    const companies = inventory();
    const snapshot = structuredClone(companies);
    const partialRows = rows.slice(0, 1);

    expect(() => validateLegacyMappingAgainstCompanies(partialRows, companies)).toThrow(LegacyMappingValidationError);
    expect(companies).toEqual(snapshot);
  });
});

describe('M02 legacy mapping canonical payload and digest', () => {
  it('produces a deterministic canonical payload independent of input row order', () => {
    const rowsInOrder = parseLegacyMappingCsv(twoCompanyMapping());
    const rowsReversed = parseLegacyMappingCsv(buildCsv([
      { companyId: 'company-2', primaryOwnerUserId: 'owner-2', createdByUserId: 'creator-2' },
      { companyId: 'company-1', primaryOwnerUserId: 'owner-1', createdByUserId: 'creator-1' },
    ]));

    const payloadInOrder = buildLegacyMappingCanonicalPayload(rowsInOrder);
    const payloadReversed = buildLegacyMappingCanonicalPayload(rowsReversed);

    expect(payloadInOrder).toBe(payloadReversed);
    expect(JSON.parse(payloadInOrder)).toEqual({
      mappingVersion: SUPPORTED_MAPPING_VERSION,
      approvedBy: 'Basel Zaid',
      approvedAt: '2026-07-01T12:00:00.000Z',
      approvalReference: 'APPROVAL-REF-001',
      rows: [
        { companyId: 'company-1', primaryOwnerUserId: 'owner-1', createdByUserId: 'creator-1' },
        { companyId: 'company-2', primaryOwnerUserId: 'owner-2', createdByUserId: 'creator-2' },
      ],
    });
  });

  it('produces a stable sha256 digest for the same canonical payload', () => {
    const rows = parseLegacyMappingCsv(twoCompanyMapping());
    const payload = buildLegacyMappingCanonicalPayload(rows);
    const first = calculateLegacyMappingDigest(payload);
    const second = calculateLegacyMappingDigest(payload);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('detects a tampered payload by recomputing the digest', () => {
    const rows = parseLegacyMappingCsv(twoCompanyMapping());
    const payload = buildLegacyMappingCanonicalPayload(rows);
    const digest = calculateLegacyMappingDigest(payload);

    const tamperedPayload = payload.replace('owner-1', 'owner-9');
    const tamperedDigest = calculateLegacyMappingDigest(tamperedPayload);

    expect(tamperedDigest).not.toBe(digest);
  });

  it('changes the digest when any mapped value changes', () => {
    const baseline = calculateLegacyMappingDigest(
      buildLegacyMappingCanonicalPayload(parseLegacyMappingCsv(twoCompanyMapping())),
    );
    const changedOwner = calculateLegacyMappingDigest(
      buildLegacyMappingCanonicalPayload(parseLegacyMappingCsv(buildCsv([
        { companyId: 'company-1', primaryOwnerUserId: 'owner-9', createdByUserId: 'creator-1' },
        { companyId: 'company-2', primaryOwnerUserId: 'owner-2', createdByUserId: 'creator-2' },
      ]))),
    );
    expect(changedOwner).not.toBe(baseline);
  });

  it('rejects building a canonical payload from duplicate companyId rows', () => {
    const rows = parseLegacyMappingCsv(buildCsv([
      { companyId: 'company-1', primaryOwnerUserId: 'owner-1', createdByUserId: 'creator-1' },
      { companyId: 'company-1', primaryOwnerUserId: 'owner-2', createdByUserId: 'creator-2' },
    ]));
    expect(() => buildLegacyMappingCanonicalPayload(rows)).toThrow(LegacyMappingValidationError);
  });

  it('rejects building a canonical payload from zero rows', () => {
    expect(() => buildLegacyMappingCanonicalPayload([])).toThrow(LegacyMappingValidationError);
  });
});

describe('M02 deterministic ownership ID', () => {
  it('matches the co_ + md5(companyId:userId:primary) pattern and is stable', () => {
    const id = deterministicOwnershipId('company-1', 'owner-1');
    expect(id).toMatch(/^co_[a-f0-9]{32}$/);
    expect(id).toBe(deterministicOwnershipId('company-1', 'owner-1'));
    expect(id).not.toBe(deterministicOwnershipId('company-1', 'owner-2'));
    expect(id).not.toBe(deterministicOwnershipId('company-2', 'owner-1'));
  });
});

describe('M02 legacy inventory without User.accountStatus', () => {
  it('accepts a user with an unambiguous active same-company Employee link', async () => {
    const { readLegacyMappingCompanyInventory } = await import('../scripts/m02/prepare_legacy_mapping.ts');

    const database = {
      $queryRaw: async () => [{ exists: false }],
      company: {
        findMany: async () => [
          {
            id: 'company-1',
            users: [{
              id: 'owner-1',
              companyId: 'company-1',
              employeeId: 'emp-1',
              employee: { id: 'emp-1', companyId: 'company-1', status: 'active' },
            }],
          },
        ],
      },
    };

    const inventory = await readLegacyMappingCompanyInventory(database as never);
    expect(inventory).toEqual([
      {
        id: 'company-1',
        users: [{ id: 'owner-1', isActive: true }],
      },
    ]);
  });

  it('rejects inactive, terminated, unknown, missing, and cross-company Employee evidence', async () => {
    const { readLegacyMappingCompanyInventory } = await import('../scripts/m02/prepare_legacy_mapping.ts');

    const database = {
      $queryRaw: async () => [{ exists: false }],
      company: {
        findMany: async () => [
          {
            id: 'company-1',
            users: [
              {
                id: 'inactive-1',
                companyId: 'company-1',
                employeeId: 'emp-inactive',
                employee: { id: 'emp-inactive', companyId: 'company-1', status: 'inactive' },
              },
              {
                id: 'terminated-1',
                companyId: 'company-1',
                employeeId: 'emp-terminated',
                employee: { id: 'emp-terminated', companyId: 'company-1', status: 'terminated' },
              },
              {
                id: 'unknown-status-1',
                companyId: 'company-1',
                employeeId: 'emp-unknown',
                employee: { id: 'emp-unknown', companyId: 'company-1', status: 'on_leave' },
              },
              {
                id: 'missing-employee-1',
                companyId: 'company-1',
                employeeId: null,
                employee: null,
              },
              {
                id: 'orphan-link-1',
                companyId: 'company-1',
                employeeId: 'emp-missing',
                employee: null,
              },
              {
                id: 'cross-company-1',
                companyId: 'company-1',
                employeeId: 'emp-other',
                employee: { id: 'emp-other', companyId: 'company-2', status: 'active' },
              },
            ],
          },
        ],
      },
    };

    const inventory = await readLegacyMappingCompanyInventory(database as never);
    expect(inventory[0].users.every((user) => user.isActive === false)).toBe(true);
  });

  it('rejects ambiguous multi-employee evidence for a user', async () => {
    const {
      isLegacyUserActiveFromEmployeeEvidence,
    } = await import('../scripts/m02/prepare_legacy_mapping.ts');

    expect(isLegacyUserActiveFromEmployeeEvidence({
      userCompanyId: 'company-1',
      employeeId: 'emp-1',
      linkedEmployees: [
        { id: 'emp-1', companyId: 'company-1', status: 'active' },
        { id: 'emp-2', companyId: 'company-1', status: 'active' },
      ],
    })).toBe(false);
  });

  it('uses accountStatus when the column exists', async () => {
    const { readLegacyMappingCompanyInventory } = await import('../scripts/m02/prepare_legacy_mapping.ts');

    const database = {
      $queryRaw: async () => [{ exists: true }],
      company: {
        findMany: async () => [
          {
            id: 'company-1',
            users: [
              { id: 'owner-1', accountStatus: 'active' },
              { id: 'inactive-1', accountStatus: 'disabled' },
              { id: 'archived-1', accountStatus: 'archived' },
            ],
          },
        ],
      },
    };

    const inventory = await readLegacyMappingCompanyInventory(database as never);
    expect(inventory[0].users).toEqual([
      { id: 'owner-1', isActive: true },
      { id: 'inactive-1', isActive: false },
      { id: 'archived-1', isActive: false },
    ]);
  });
});
