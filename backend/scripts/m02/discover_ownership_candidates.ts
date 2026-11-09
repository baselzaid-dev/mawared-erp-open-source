import { Prisma, PrismaClient } from '@prisma/client';
import { writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveAmbiguityWarning,
  deriveExistingOwnershipStatus,
  serializeOwnerMappingRows,
  type OwnerMappingColumn,
  type OwnershipCompanyInventory,
  type OwnershipInventoryRecord,
} from './ownership_mapping.ts';

export type OwnershipDiscoveryReport = {
  generatedAt: string;
  mode: 'read_only';
  automaticOwnerSelection: false;
  ownershipTableStatus: 'available' | 'not_created';
  companies: Array<OwnershipCompanyInventory & {
    existingOwnershipStatus: string;
    ambiguityWarning: string;
    warnings: string[];
  }>;
};

type DiscoveryDatabase = Pick<PrismaClient, 'company' | 'companyOwnership'>;

type SnapshotTransaction = DiscoveryDatabase & Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

type SnapshotDatabase = {
  $transaction<T>(
    operation: (transaction: SnapshotTransaction) => Promise<T>,
    options: { isolationLevel: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const resolveProtectedLocalPath = (value: string, argumentName: string): string => {
  if (!isAbsolute(value) || value.startsWith('\\\\')) {
    throw new Error(`${argumentName} must be an absolute local path, not a relative or UNC path`);
  }
  const protectedPath = resolve(value);
  const relativeToRepository = relative(repositoryRoot, protectedPath);
  if (!relativeToRepository.startsWith('..') && !isAbsolute(relativeToRepository)) {
    throw new Error(`${argumentName} must be outside the repository`);
  }
  return protectedPath;
};

export const assertLocalDatabaseUrl = (databaseUrl = process.env.DATABASE_URL): void => {
  if (!databaseUrl) throw new Error('DATABASE_URL is required and must point to a local PostgreSQL database');
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid local PostgreSQL URL');
  }
  const hostname = parsed.hostname.toLocaleLowerCase('en-US');
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !localHosts.has(hostname)) {
    throw new Error('M02 tools refuse non-local DATABASE_URL hosts');
  }
};

const parsePermissions = (raw: string): { permissions: string[]; warning?: string } => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
      return { permissions: [], warning: 'role_permissions_are_not_a_string_array' };
    }
    return { permissions: [...new Set(parsed)].sort() };
  } catch {
    return { permissions: [], warning: 'role_permissions_are_not_valid_json' };
  }
};

const ownershipTableDoesNotExist = (error: unknown): boolean => (
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2021'
);

export const discoverOwnershipCandidates = async (
  database: DiscoveryDatabase,
  now = new Date(),
  knownOwnershipTableStatus?: 'available' | 'not_created',
): Promise<OwnershipDiscoveryReport> => {
  const companies = await database.company.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      name: true,
      users: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          companyId: true,
          name: true,
          email: true,
          employeeId: true,
          role: { select: { id: true, name: true, permissions: true } },
          employee: { select: { status: true } },
        },
      },
    },
  });

  let ownershipTableStatus: 'available' | 'not_created' = knownOwnershipTableStatus ?? 'available';
  let ownershipRows: OwnershipInventoryRecord[] = [];
  if (ownershipTableStatus === 'available') {
    try {
      ownershipRows = await database.companyOwnership.findMany({
        orderBy: [{ companyId: 'asc' }, { id: 'asc' }],
        select: { id: true, companyId: true, userId: true, isPrimary: true, status: true },
      });
    } catch (error) {
      if (!ownershipTableDoesNotExist(error)) throw error;
      ownershipTableStatus = 'not_created';
    }
  }

  const discoveredCompanies = companies.map((company) => {
    const warnings: string[] = [];
    const users = company.users.map((user) => {
      const parsedPermissions = parsePermissions(user.role.permissions);
      if (parsedPermissions.warning) warnings.push(`${user.id}:${parsedPermissions.warning}`);
      const employeeStatus = user.employee?.status ?? null;
      return {
        id: user.id,
        companyId: user.companyId,
        name: user.name,
        email: user.email,
        roleId: user.role.id,
        roleName: user.role.name,
        permissions: parsedPermissions.permissions,
        employeeId: user.employeeId,
        employeeStatus,
        // M02's compatibility rule treats a user without an Employee link as active.
        isActive: user.employeeId === null || employeeStatus === 'active',
      };
    });
    const inventory: OwnershipCompanyInventory = {
      id: company.id,
      name: company.name,
      users,
      existingOwnerships: ownershipRows.filter((row) => row.companyId === company.id),
      ownershipInventoryStatus: ownershipTableStatus,
    };
    return {
      ...inventory,
      existingOwnershipStatus: deriveExistingOwnershipStatus(inventory),
      ambiguityWarning: deriveAmbiguityWarning(users),
      warnings,
    };
  });

  return {
    generatedAt: now.toISOString(),
    mode: 'read_only',
    automaticOwnerSelection: false,
    ownershipTableStatus,
    companies: discoveredCompanies,
  };
};

export const readOwnershipInventorySnapshot = async (
  database: SnapshotDatabase,
  now = new Date(),
): Promise<OwnershipDiscoveryReport> => database.$transaction(async (transaction) => {
  await transaction.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
  const tableRows = await transaction.$queryRaw<Array<{ exists: boolean }>>(
    Prisma.sql`SELECT to_regclass('"CompanyOwnership"') IS NOT NULL AS "exists"`,
  );
  const ownershipTableStatus = tableRows[0]?.exists ? 'available' : 'not_created';
  return discoverOwnershipCandidates(transaction, now, ownershipTableStatus);
}, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

export const renderDiscoveryMappingCsv = (report: OwnershipDiscoveryReport): string => {
  const rows = report.companies.map((company): Record<OwnerMappingColumn, string> => ({
    company_id: company.id,
    company_name: company.name,
    intended_owner_user_id: '',
    intended_owner_name: '',
    intended_owner_email: '',
    owner_active_status: '',
    company_membership_validation: '',
    existing_ownership_status: company.existingOwnershipStatus,
    ambiguity_warning: company.ambiguityWarning,
    review_status: 'pending',
    reviewer: '',
    notes: '',
  }));
  return serializeOwnerMappingRows(rows);
};

const requestedFormat = (args: string[]): 'json' | 'csv' => {
  const equalsArgument = args.find((argument) => argument.startsWith('--format='));
  const positionalIndex = args.indexOf('--format');
  const value = equalsArgument?.slice('--format='.length)
    ?? (positionalIndex >= 0 ? args[positionalIndex + 1] : 'json');
  if (value !== 'json' && value !== 'csv') {
    throw new Error('Format must be json or csv');
  }
  return value;
};

const requestedOutputPath = (args: string[]): string | undefined => {
  const equalsArgument = args.find((argument) => argument.startsWith('--output='));
  const positionalIndex = args.indexOf('--output');
  const value = equalsArgument?.slice('--output='.length)
    ?? (positionalIndex >= 0 ? args[positionalIndex + 1] : undefined);
  if ((equalsArgument !== undefined || positionalIndex >= 0) && (!value || value.startsWith('--'))) {
    throw new Error('--output requires an absolute local path');
  }
  if (!value) return undefined;
  return resolveProtectedLocalPath(value, '--output');
};

export const summarizeDiscoveryReport = (report: OwnershipDiscoveryReport): Record<string, unknown> => ({
  mode: report.mode,
  automaticOwnerSelection: report.automaticOwnerSelection,
  ownershipTableStatus: report.ownershipTableStatus,
  companyCount: report.companies.length,
  userCount: report.companies.reduce((count, company) => count + company.users.length, 0),
  existingOwnershipCount: report.companies.reduce(
    (count, company) => count + company.existingOwnerships.length,
    0,
  ),
});

export const runOwnershipDiscoveryCli = async (args = process.argv.slice(2)): Promise<void> => {
  assertLocalDatabaseUrl();
  const outputPath = requestedOutputPath(args);
  if (!outputPath && args.some((argument) => argument === '--format' || argument.startsWith('--format='))) {
    throw new Error('--format requires an explicit protected --output path');
  }
  const prisma = new PrismaClient();
  try {
    const report = await readOwnershipInventorySnapshot(prisma);
    if (outputPath) {
      const output = requestedFormat(args) === 'csv'
        ? renderDiscoveryMappingCsv(report)
        : JSON.stringify(report, null, 2);
      await writeFile(outputPath, `${output}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify({
      ...summarizeDiscoveryReport(report),
      protectedOutputWritten: Boolean(outputPath),
    })}\n`);
  } finally {
    await prisma.$disconnect();
  }
};

const isDirectExecution = Boolean(process.argv[1])
  && resolve(process.argv[1]).toLocaleLowerCase('en-US')
    === resolve(fileURLToPath(import.meta.url)).toLocaleLowerCase('en-US');

if (isDirectExecution) {
  runOwnershipDiscoveryCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`M02 ownership discovery failed: ${message}\n`);
    process.exitCode = 1;
  });
}
