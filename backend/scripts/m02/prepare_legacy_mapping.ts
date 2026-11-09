// M02 legacy owner-mapping preparation CLI. This is the execution-format
// counterpart to the discovery/review tools in `discover_ownership_candidates.ts`
// and `validate_ownership_mapping.ts`. It never selects an owner and never
// touches CompanyOwnership/DepartmentManager directly: it only prepares a
// digest-bound, approval-attributed control-table package that the M02
// migration's fail-closed preflight later consumes and backfills from.
//
// Modes:
//   --mode=preview            (default) Read-only. Validates the mapping
//                             against the current database inventory and
//                             prints a sanitized preview. No writes.
//   --mode=apply-preparation  Creates the control tables if needed, then
//                             inserts one package + its rows in a single
//                             transaction. Refuses if an unconsumed package
//                             already exists for this database unless it is
//                             byte-for-byte the same mapping (idempotent).
//
// Safety:
//   - assertLocalDatabaseUrl() is ALWAYS enforced, for every execution target.
//     There is no override. Only a local/loopback DATABASE_URL is ever
//     accepted by this tool.
//   - --execution-target=staging only changes messaging/requirements for a
//     future, separately authorized change. Staging execution is NOT
//     authorized by this tool today; it still refuses any non-local
//     DATABASE_URL host exactly like the default local target.
//   - --mapping must be an absolute local path outside the repository.
//   - Preview output never prints passwords or full connection URLs. Only the
//     parsed host, port, and database name are ever printed.

import { Prisma, PrismaClient } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertLocalDatabaseUrl,
  resolveProtectedLocalPath,
} from './discover_ownership_candidates.ts';
import {
  buildLegacyMappingCanonicalPayload,
  calculateLegacyMappingDigest,
  deterministicOwnershipId,
  LegacyMappingValidationError,
  parseLegacyMappingCsv,
  validateLegacyMappingAgainstCompanies,
  type LegacyMappingCompanyInventory,
  type ValidatedLegacyMappingRow,
} from './legacy_mapping.ts';

export type ExecutionTarget = 'local' | 'staging';
export type PreparationMode = 'preview' | 'apply-preparation';

export type SanitizedDatabaseIdentity = {
  host: string;
  port: string;
  databaseName: string;
};

// Parses only host/port/database name out of DATABASE_URL. Userinfo (username,
// password) is intentionally never read here.
export const sanitizeDatabaseIdentity = (databaseUrl: string): SanitizedDatabaseIdentity => {
  const parsed = new URL(databaseUrl);
  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    databaseName: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
};

const flagValue = (args: string[], flag: string): string | undefined => {
  const equalsArgument = args.find((argument) => argument.startsWith(`${flag}=`));
  const positionalIndex = args.indexOf(flag);
  const value = equalsArgument?.slice(flag.length + 1)
    ?? (positionalIndex >= 0 ? args[positionalIndex + 1] : undefined);
  if ((equalsArgument !== undefined || positionalIndex >= 0) && (!value || value.startsWith('--'))) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
};

const modeFromArgs = (args: string[]): PreparationMode => {
  const value = flagValue(args, '--mode') ?? 'preview';
  if (value !== 'preview' && value !== 'apply-preparation') {
    throw new Error('--mode must be preview or apply-preparation');
  }
  return value;
};

const executionTargetFromArgs = (args: string[]): ExecutionTarget => {
  const value = flagValue(args, '--execution-target') ?? 'local';
  if (value !== 'local' && value !== 'staging') {
    throw new Error('--execution-target must be local or staging');
  }
  return value;
};

const mappingPathFromArgs = (args: string[]): string => {
  const value = flagValue(args, '--mapping');
  if (!value) {
    throw new Error('An absolute local mapping file is required: --mapping <path>');
  }
  return resolveProtectedLocalPath(value, '--mapping');
};

// Every unconsumed control-table row required by the migration's preflight,
// exactly as it should be persisted (Company/User membership and activity are
// re-checked by the migration itself at apply time; this is preparation only).
const CONTROL_DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "_MawaredM02LegacyMappingPackage" (
    "id" TEXT PRIMARY KEY,
    "mappingVersion" TEXT NOT NULL,
    "mappingDigest" TEXT NOT NULL,
    "canonicalPayload" TEXT NOT NULL,
    "databaseName" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMPTZ NOT NULL,
    "approvalReference" TEXT NOT NULL,
    "companyCount" INTEGER NOT NULL CHECK ("companyCount" > 0),
    "preparedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMPTZ,
    CONSTRAINT "_MawaredM02_digest_format" CHECK ("mappingDigest" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "_MawaredM02_version_supported" CHECK ("mappingVersion" = 'm02-legacy-v1')
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "_MawaredM02_unconsumed_per_db"
    ON "_MawaredM02LegacyMappingPackage" ("databaseName") WHERE "consumedAt" IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "_MawaredM02_digest_unique"
    ON "_MawaredM02LegacyMappingPackage" ("mappingDigest")`,
  `CREATE TABLE IF NOT EXISTS "_MawaredM02LegacyMappingRow" (
    "packageId" TEXT NOT NULL REFERENCES "_MawaredM02LegacyMappingPackage"("id") ON DELETE CASCADE,
    "companyId" TEXT NOT NULL,
    "primaryOwnerUserId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "ownerEqualsAttribution" BOOLEAN NOT NULL,
    "ownershipId" TEXT NOT NULL,
    PRIMARY KEY ("packageId", "companyId")
  )`,
];

// Pick<> so unit/integration tests can pass a lightweight fake instead of a
// real PrismaClient/PostgreSQL connection. `$queryRaw` is required so restored
// pre-M02 databases (no User.accountStatus column yet) can be inventoried
// without Prisma selecting a column that does not exist.
export type LegacyMappingInventoryDatabase = Pick<PrismaClient, 'company' | '$queryRaw'>;

export const userAccountStatusColumnExists = async (
  database: Pick<PrismaClient, '$queryRaw'>,
): Promise<boolean> => {
  const rows = await database.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'User'
        AND column_name = 'accountStatus'
    ) AS "exists"
  `;
  return Boolean(rows[0]?.exists);
};

/** Employee.status values supported by the current Prisma model / conventions. */
export const SUPPORTED_LEGACY_EMPLOYEE_STATUSES = ['active', 'inactive', 'terminated'] as const;
export type SupportedLegacyEmployeeStatus = (typeof SUPPORTED_LEGACY_EMPLOYEE_STATUSES)[number];

export type LegacyEmployeeLinkEvidence = {
  userCompanyId: string;
  employeeId: string | null;
  /**
   * Employees that appear linked to this user. For an unambiguous User.employeeId
   * FK this must be exactly one row matching that id. More than one row, a
   * missing row, a company mismatch, or an unsupported status fails closed.
   */
  linkedEmployees: Array<{ id: string; companyId: string; status: string }>;
};

/**
 * Pre-M02 activity eligibility when User.accountStatus does not exist.
 * Never defaults unknown/missing evidence to active.
 */
export const isLegacyUserActiveFromEmployeeEvidence = (
  evidence: LegacyEmployeeLinkEvidence,
): boolean => {
  if (!evidence.employeeId) return false;
  if (evidence.linkedEmployees.length !== 1) return false;

  const employee = evidence.linkedEmployees[0];
  if (employee.id !== evidence.employeeId) return false;
  if (employee.companyId !== evidence.userCompanyId) return false;

  const normalizedStatus = employee.status.trim().toLowerCase();
  if (!(SUPPORTED_LEGACY_EMPLOYEE_STATUSES as readonly string[]).includes(normalizedStatus)) {
    return false;
  }
  return normalizedStatus === 'active';
};

export const readLegacyMappingCompanyInventory = async (
  database: LegacyMappingInventoryDatabase,
): Promise<LegacyMappingCompanyInventory[]> => {
  const hasAccountStatus = await userAccountStatusColumnExists(database);

  if (hasAccountStatus) {
    const companies = await database.company.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        users: {
          orderBy: { id: 'asc' },
          select: { id: true, accountStatus: true },
        },
      },
    });
    return companies.map((company) => ({
      id: company.id,
      users: company.users.map((user) => ({
        id: user.id,
        isActive: user.accountStatus === 'active',
      })),
    }));
  }

  // Pre-accountStatus schemas (e.g. Staging dump through company_identity_login):
  // derive eligibility only from an unambiguous same-company Employee link.
  // Missing, cross-company, inactive, terminated, unknown, or ambiguous
  // evidence fails closed (isActive = false). Never default to active.
  const companies = await database.company.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      users: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          companyId: true,
          employeeId: true,
          employee: {
            select: { id: true, companyId: true, status: true },
          },
        },
      },
    },
  });
  return companies.map((company) => ({
    id: company.id,
    users: company.users.map((user) => ({
      id: user.id,
      isActive: isLegacyUserActiveFromEmployeeEvidence({
        userCompanyId: user.companyId,
        employeeId: user.employeeId,
        linkedEmployees: user.employee
          ? [{ id: user.employee.id, companyId: user.employee.companyId, status: user.employee.status }]
          : [],
      }),
    })),
  }));
};

type LegacyMappingPreparationTransaction =
  & Pick<Prisma.TransactionClient, '$executeRaw' | '$executeRawUnsafe' | '$queryRaw'>;

export type LegacyMappingPreparationDatabase = {
  $transaction<T>(operation: (transaction: LegacyMappingPreparationTransaction) => Promise<T>): Promise<T>;
};

export type ApplyLegacyMappingPreparationInput = {
  packageId: string;
  digest: string;
  canonicalPayload: string;
  databaseName: string;
  approvedBy: string;
  approvedAt: string;
  approvalReference: string;
  mappingVersion: string;
  rows: ValidatedLegacyMappingRow[];
};

export type ApplyLegacyMappingPreparationResult = {
  status: 'created' | 'already_prepared';
  packageId: string;
};

export const applyLegacyMappingPreparationInTransaction = async (
  transaction: LegacyMappingPreparationTransaction,
  input: ApplyLegacyMappingPreparationInput,
): Promise<ApplyLegacyMappingPreparationResult> => {
  for (const statement of CONTROL_DDL_STATEMENTS) {
    await transaction.$executeRawUnsafe(statement);
  }

  const existing = await transaction.$queryRaw<Array<{ id: string; mappingDigest: string }>>`
    SELECT "id", "mappingDigest" FROM "_MawaredM02LegacyMappingPackage"
    WHERE "databaseName" = ${input.databaseName} AND "consumedAt" IS NULL
  `;
  if (existing.length > 0) {
    if (existing[0].mappingDigest === input.digest) {
      return { status: 'already_prepared' as const, packageId: existing[0].id };
    }
    throw new Error(
      `An unconsumed legacy mapping package already exists for database "${input.databaseName}" with a `
      + 'different digest. Resolve or consume it (via the M02 migration) before preparing a new mapping.',
    );
  }

  await transaction.$executeRaw`
    INSERT INTO "_MawaredM02LegacyMappingPackage"
      ("id", "mappingVersion", "mappingDigest", "canonicalPayload", "databaseName",
       "approvedBy", "approvedAt", "approvalReference", "companyCount")
    VALUES (
      ${input.packageId}, ${input.mappingVersion}, ${input.digest}, ${input.canonicalPayload},
      ${input.databaseName}, ${input.approvedBy}, ${new Date(input.approvedAt)},
      ${input.approvalReference}, ${input.rows.length}
    )
  `;

  for (const row of input.rows) {
    const ownershipId = deterministicOwnershipId(row.companyId, row.primaryOwnerUserId);
    await transaction.$executeRaw`
      INSERT INTO "_MawaredM02LegacyMappingRow"
        ("packageId", "companyId", "primaryOwnerUserId", "createdByUserId", "ownerEqualsAttribution", "ownershipId")
      VALUES (
        ${input.packageId}, ${row.companyId}, ${row.primaryOwnerUserId}, ${row.createdByUserId},
        ${row.ownerEqualsAttribution}, ${ownershipId}
      )
    `;
  }

  return { status: 'created' as const, packageId: input.packageId };
};

export const applyLegacyMappingPreparation = async (
  database: LegacyMappingPreparationDatabase,
  input: ApplyLegacyMappingPreparationInput,
): Promise<ApplyLegacyMappingPreparationResult> => database.$transaction(async (transaction) => (
  applyLegacyMappingPreparationInTransaction(transaction, input)
));

export type LegacyMappingPreviewRow = {
  companyId: string;
  primaryOwnerUserId: string;
  createdByUserId: string;
  ownerEqualsAttribution: boolean;
  approvalReference: string;
  digest: string;
  databaseName: string;
};

export const buildLegacyMappingPreview = (
  validatedRows: ValidatedLegacyMappingRow[],
  context: { approvalReference: string; digest: string; databaseName: string },
): LegacyMappingPreviewRow[] => validatedRows.map((row) => ({
  companyId: row.companyId,
  primaryOwnerUserId: row.primaryOwnerUserId,
  createdByUserId: row.createdByUserId,
  ownerEqualsAttribution: row.ownerEqualsAttribution,
  approvalReference: context.approvalReference,
  digest: context.digest,
  databaseName: context.databaseName,
}));

export const runPrepareLegacyMappingCli = async (
  args = process.argv.slice(2),
): Promise<void> => {
  const mode = modeFromArgs(args);
  const executionTarget = executionTargetFromArgs(args);

  if (executionTarget === 'staging') {
    const confirmed = flagValue(args, '--confirm-staging-preparation') === 'YES';
    if (!confirmed) {
      throw new Error(
        '--execution-target=staging requires --confirm-staging-preparation=YES. Note: Staging execution is '
        + 'NOT authorized by this tool today; this flag only documents future intent and never relaxes the '
        + 'local-only DATABASE_URL requirement below.',
      );
    }
  }

  // Enforced unconditionally, for every execution target. There is no
  // override that permits a non-local/loopback DATABASE_URL host.
  assertLocalDatabaseUrl();

  const mappingPath = mappingPathFromArgs(args);
  const mappingCsv = await readFile(mappingPath, 'utf8');
  const parsedRows = parseLegacyMappingCsv(mappingCsv);
  const identity = sanitizeDatabaseIdentity(process.env.DATABASE_URL!);

  const prisma = new PrismaClient();
  try {
    const companies = await readLegacyMappingCompanyInventory(prisma);
    const validatedRows = validateLegacyMappingAgainstCompanies(parsedRows, companies);
    const canonicalPayload = buildLegacyMappingCanonicalPayload(parsedRows);
    const digest = calculateLegacyMappingDigest(canonicalPayload);
    const packageId = `m02pkg_${digest.slice(0, 24)}`;
    const approvalReference = parsedRows[0].approvalReference;

    if (mode === 'preview') {
      process.stdout.write(`${JSON.stringify({
        mode: 'preview',
        executionTarget,
        databaseHost: identity.host,
        databasePort: identity.port,
        databaseName: identity.databaseName,
        mappingVersion: parsedRows[0].mappingVersion,
        companyCount: validatedRows.length,
        mappingDigest: digest,
        packageId,
        rows: buildLegacyMappingPreview(validatedRows, {
          approvalReference,
          digest,
          databaseName: identity.databaseName,
        }),
      }, null, 2)}\n`);
      return;
    }

    const result = await applyLegacyMappingPreparation(prisma, {
      packageId,
      digest,
      canonicalPayload,
      databaseName: identity.databaseName,
      approvedBy: parsedRows[0].approvedBy,
      approvedAt: parsedRows[0].approvedAt,
      approvalReference,
      mappingVersion: parsedRows[0].mappingVersion,
      rows: validatedRows,
    });

    process.stdout.write(`${JSON.stringify({
      mode: 'apply-preparation',
      status: result.status,
      executionTarget,
      databaseHost: identity.host,
      databasePort: identity.port,
      databaseName: identity.databaseName,
      companyCount: validatedRows.length,
      mappingDigest: digest,
      packageId: result.packageId,
    }, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
};

const isDirectExecution = Boolean(process.argv[1])
  && resolve(process.argv[1]).toLocaleLowerCase('en-US')
    === resolve(fileURLToPath(import.meta.url)).toLocaleLowerCase('en-US');

if (isDirectExecution) {
  runPrepareLegacyMappingCli().catch((error) => {
    if (error instanceof LegacyMappingValidationError) {
      process.stderr.write(`${JSON.stringify({
        error: error.name,
        issues: error.issues,
      }, null, 2)}\n`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`M02 legacy mapping preparation failed: ${message}\n`);
    }
    process.exitCode = 1;
  });
}
