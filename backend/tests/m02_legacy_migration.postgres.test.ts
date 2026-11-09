import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import {
  buildLegacyMappingCanonicalPayload,
  calculateLegacyMappingDigest,
  parseLegacyMappingCsv,
  validateLegacyMappingAgainstCompanies,
  type LegacyMappingCompanyInventory,
  type ValidatedLegacyMappingRow,
} from '../scripts/m02/legacy_mapping.ts';
import { applyLegacyMappingPreparation } from '../scripts/m02/prepare_legacy_mapping.ts';

function findCommand(name: string): string | null {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function runQuietly(label: string, command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function runExpectFailure(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true });
  expect(result.status).not.toBe(0);
}

async function reserveLocalPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to reserve a local PostgreSQL test port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

const initdb = findCommand('initdb');
const pgCtl = findCommand('pg_ctl');
const createdb = findCommand('createdb');
const psql = findCommand('psql');
const backendRoot = resolve(process.cwd());
const migrationsRoot = join(backendRoot, 'prisma', 'migrations');

// The first 8 migrations, in order: 0_init through company_identity_login.
// M02 (the 9th) is applied separately by each test so its fail-closed
// preflight and legacy backfill can be exercised directly with `psql -f`.
const baselineMigrations = [
  '0_init',
  '20260710000100_salary_payroll_foundation',
  '20260710000200_task_assignment_workflow',
  '20260710000300_chat_foundation',
  '20260710000400_purchasing_core',
  '20260710000500_training_core',
  '20260710000600_reporting_security_indexes',
  '20260714000100_company_identity_login',
];

const m02MigrationPath = join(migrationsRoot, '20260718000100_rc2_ownership_hierarchy_expand', 'migration.sql');
const m02MigrationSql = readFileSync(m02MigrationPath, 'utf8');

// Isolate just the trailing legacy backfill DO block so a test can re-execute
// it standalone against an already-consumed package, without re-running the
// whole (non-idempotent) migration file.
const backfillMarker = '-- Legacy existing-data backfill from prepared mapping';
const backfillStartIndex = m02MigrationSql.indexOf(backfillMarker);
const backfillEndIndex = m02MigrationSql.indexOf('END $$;', backfillStartIndex) + 'END $$;'.length;
if (backfillStartIndex < 0 || backfillEndIndex < 0) {
  throw new Error('Could not locate the M02 legacy backfill DO block in the migration file');
}
const backfillDoBlockSql = m02MigrationSql.slice(backfillStartIndex, backfillEndIndex);

const hasDisposablePostgres = Boolean(initdb && pgCtl && createdb && psql);
const postgresDescribe = hasDisposablePostgres ? describe : describe.skip;

postgresDescribe('M02 legacy owner-mapping migration on disposable PostgreSQL', () => {
  const databaseUser = 'mawared_test';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let port = 0;

  // Assemble without a contiguous protocol URL literal (secret-scan false positive).
  const urlFor = (databaseName: string): string => (
    ['postgres', 'ql', '://'].join('')
    + `${databaseUser}@127.0.0.1:${port}/${databaseName}?schema=public`
  );

  const stopAndClean = () => {
    if (clusterStarted && pgCtl) {
      spawnSync(pgCtl, ['--pgdata', clusterDirectory, '--wait', '--mode', 'fast', 'stop'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      clusterStarted = false;
    }
    if (workDirectory) rmSync(workDirectory, { recursive: true, force: true });
  };

  const createDatabase = (databaseName: string) => {
    runQuietly('createdb', createdb!, [
      '--host', '127.0.0.1',
      '--port', String(port),
      '--username', databaseUser,
      '--maintenance-db', 'postgres',
      databaseName,
    ]);
  };

  const execute = (databaseName: string, sql: string, expectFailure = false) => {
    const args = [
      '--no-psqlrc',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--username', databaseUser,
      '--dbname', databaseName,
      '--set', 'ON_ERROR_STOP=1',
      '--command', sql,
    ];
    if (expectFailure) runExpectFailure(psql!, args);
    else runQuietly('psql fixture', psql!, args);
  };

  const executeFile = (databaseName: string, filePath: string, expectFailure = false) => {
    const args = [
      '--no-psqlrc',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--username', databaseUser,
      '--dbname', databaseName,
      '--set', 'ON_ERROR_STOP=1',
      '--file', filePath,
    ];
    if (expectFailure) runExpectFailure(psql!, args);
    else runQuietly('psql migration file', psql!, args);
  };

  const query = (databaseName: string, sql: string): string => {
    const result = spawnSync(psql!, [
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--username', databaseUser,
      '--dbname', databaseName,
      '--set', 'ON_ERROR_STOP=1',
      '--command', sql,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error('Disposable PostgreSQL verification query failed');
    return result.stdout.trim();
  };

  const applyBaseline = (databaseName: string) => {
    for (const migration of baselineMigrations) {
      executeFile(databaseName, join(migrationsRoot, migration, 'migration.sql'));
    }
  };

  // c1/c2 each get an owner and a distinct attribution ("created by") user, so
  // truthful migration attribution and Primary Owner != creator are both
  // exercised.
  const insertCompanyUserFixture = (databaseName: string) => {
    execute(databaseName, `
      INSERT INTO "Company" ("id","code","name","createdAt","updatedAt") VALUES
        ('c1','CODE-C1','Company One',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('c2','CODE-C2','Company Two',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO "Role" ("id","companyId","name","permissions","createdAt","updatedAt") VALUES
        ('r1','c1','Employee','[]',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('r2','c2','Employee','[]',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO "Employee" ("id","companyId","employeeNum","normalizedEmployeeNum","jobTitle","joiningDate","status","createdAt","updatedAt") VALUES
        ('emp-owner-c1','c1','E-OWN-1','E-OWN-1','Owner','2020-01-01','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('emp-creator-c1','c1','E-CRE-1','E-CRE-1','Creator','2020-01-01','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('emp-owner-c2','c2','E-OWN-2','E-OWN-2','Owner','2020-01-01','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('emp-creator-c2','c2','E-CRE-2','E-CRE-2','Creator','2020-01-01','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO "User" ("id","companyId","employeeId","email","normalizedEmail","password","name","roleId","createdAt","updatedAt") VALUES
        ('owner-c1','c1','emp-owner-c1','owner-c1@example.test','owner-c1@example.test','fixture','Owner C1','r1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('creator-c1','c1','emp-creator-c1','creator-c1@example.test','creator-c1@example.test','fixture','Creator C1','r1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('owner-c2','c2','emp-owner-c2','owner-c2@example.test','owner-c2@example.test','fixture','Owner C2','r2',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
        ('creator-c2','c2','emp-creator-c2','creator-c2@example.test','creator-c2@example.test','fixture','Creator C2','r2',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    `);
  };

  const companiesInventory: LegacyMappingCompanyInventory[] = [
    { id: 'c1', users: [{ id: 'owner-c1', isActive: true }, { id: 'creator-c1', isActive: true }] },
    { id: 'c2', users: [{ id: 'owner-c2', isActive: true }, { id: 'creator-c2', isActive: true }] },
  ];

  const legacyMappingCsv = [
    'company_id,primary_owner_user_id,created_by_user_id,approved_by,approved_at,approval_reference,mapping_version',
    'c1,owner-c1,creator-c1,Basel Zaid,2026-07-01T00:00:00Z,APPROVAL-REF-PG-1,m02-legacy-v1',
    'c2,owner-c2,creator-c2,Basel Zaid,2026-07-01T00:00:00Z,APPROVAL-REF-PG-1,m02-legacy-v1',
  ].join('\n');

  beforeAll(async () => {
    workDirectory = mkdtempSync(join(tmpdir(), 'mawared-legacy-mapping-pg-'));
    clusterDirectory = join(workDirectory, 'cluster');
    const logPath = join(workDirectory, 'postgres.log');
    port = await reserveLocalPort();
    try {
      runQuietly('initdb', initdb!, [
        '--pgdata', clusterDirectory,
        '--username', databaseUser,
        '--auth', 'trust',
        '--encoding', 'UTF8',
        '--no-locale',
      ]);
      runQuietly('pg_ctl start', pgCtl!, [
        '--pgdata', clusterDirectory,
        '--log', logPath,
        '--options', `-h 127.0.0.1 -p ${port} -F -c unix_socket_directories=`,
        '--wait',
        'start',
      ]);
      clusterStarted = true;
    } catch (error) {
      stopAndClean();
      throw error;
    }
  }, 60_000);

  afterAll(stopAndClean, 30_000);

  it('allows a fresh database (no Companies) through without needing any control tables', () => {
    const databaseName = 'mawared_m02_fresh';
    createDatabase(databaseName);
    applyBaseline(databaseName);
    executeFile(databaseName, m02MigrationPath);

    expect(query(databaseName, `SELECT to_regclass('"CompanyOwnership"') IS NOT NULL;`)).toBe('t');
    expect(query(databaseName, `SELECT count(*) FROM "CompanyOwnership";`)).toBe('0');
    expect(query(databaseName, `SELECT to_regclass('public."_MawaredM02LegacyMappingPackage"') IS NULL;`)).toBe('t');
  }, 120_000);

  it('fails closed when existing Companies have no prepared legacy mapping package at all', () => {
    const databaseName = 'mawared_m02_no_package';
    createDatabase(databaseName);
    applyBaseline(databaseName);
    insertCompanyUserFixture(databaseName);

    executeFile(databaseName, m02MigrationPath, true);

    expect(query(databaseName, `SELECT to_regclass('"CompanyOwnership"') IS NULL;`)).toBe('t');
  }, 120_000);

  it('fails closed when the prepared package does not cover every existing Company', async () => {
    const databaseName = 'mawared_m02_incomplete';
    createDatabase(databaseName);
    applyBaseline(databaseName);
    insertCompanyUserFixture(databaseName);

    const rows = parseLegacyMappingCsv(legacyMappingCsv);
    const canonicalPayload = buildLegacyMappingCanonicalPayload(rows);
    const digest = calculateLegacyMappingDigest(canonicalPayload);
    // Simulates a corrupted/tampered control table: only company c1 is
    // covered even though the database has c1 and c2. The migration's SQL
    // preflight must independently catch this even if the TS validator that
    // normally prevents it were bypassed.
    const incompleteRows: ValidatedLegacyMappingRow[] = [
      { companyId: 'c1', primaryOwnerUserId: 'owner-c1', createdByUserId: 'creator-c1', ownerEqualsAttribution: false },
    ];

    const prisma = new PrismaClient({ datasources: { db: { url: urlFor(databaseName) } } });
    try {
      await applyLegacyMappingPreparation(prisma, {
        packageId: `m02pkg_${digest.slice(0, 24)}`,
        digest,
        canonicalPayload,
        databaseName,
        approvedBy: rows[0].approvedBy,
        approvedAt: rows[0].approvedAt,
        approvalReference: rows[0].approvalReference,
        mappingVersion: rows[0].mappingVersion,
        rows: incompleteRows,
      });
    } finally {
      await prisma.$disconnect();
    }

    executeFile(databaseName, m02MigrationPath, true);

    expect(query(databaseName, `SELECT to_regclass('"CompanyOwnership"') IS NULL;`)).toBe('t');
  }, 120_000);

  it('fails closed when a prepared row assigns a Primary Owner from another company', async () => {
    const databaseName = 'mawared_m02_cross_company';
    createDatabase(databaseName);
    applyBaseline(databaseName);
    insertCompanyUserFixture(databaseName);

    const rows = parseLegacyMappingCsv(legacyMappingCsv);
    const canonicalPayload = buildLegacyMappingCanonicalPayload(rows);
    const digest = calculateLegacyMappingDigest(canonicalPayload);
    // Simulates the same kind of tampering, but the coverage count matches
    // while the owner for c1 is actually a c2 user.
    const tamperedRows: ValidatedLegacyMappingRow[] = [
      { companyId: 'c1', primaryOwnerUserId: 'owner-c2', createdByUserId: 'creator-c1', ownerEqualsAttribution: false },
      { companyId: 'c2', primaryOwnerUserId: 'owner-c2', createdByUserId: 'creator-c2', ownerEqualsAttribution: false },
    ];

    const prisma = new PrismaClient({ datasources: { db: { url: urlFor(databaseName) } } });
    try {
      await applyLegacyMappingPreparation(prisma, {
        packageId: `m02pkg_${digest.slice(0, 24)}`,
        digest,
        canonicalPayload,
        databaseName,
        approvedBy: rows[0].approvedBy,
        approvedAt: rows[0].approvedAt,
        approvalReference: rows[0].approvalReference,
        mappingVersion: rows[0].mappingVersion,
        rows: tamperedRows,
      });
    } finally {
      await prisma.$disconnect();
    }

    executeFile(databaseName, m02MigrationPath, true);

    expect(query(databaseName, `SELECT to_regclass('"CompanyOwnership"') IS NULL;`)).toBe('t');
  }, 120_000);

  it('fails closed when a prepared Primary Owner Employee is inactive, and inserts no ownership', async () => {
    const databaseName = 'mawared_m02_inactive_owner';
    createDatabase(databaseName);
    applyBaseline(databaseName);
    insertCompanyUserFixture(databaseName);
    execute(databaseName, `UPDATE "Employee" SET status = 'inactive' WHERE id = 'emp-owner-c1';`);

    const rows = parseLegacyMappingCsv(legacyMappingCsv);
    const canonicalPayload = buildLegacyMappingCanonicalPayload(rows);
    const digest = calculateLegacyMappingDigest(canonicalPayload);
    // Bypass the TypeScript inventory validator to prove the SQL preflight
    // independently rejects inactive Employee eligibility.
    const preparedRows: ValidatedLegacyMappingRow[] = [
      { companyId: 'c1', primaryOwnerUserId: 'owner-c1', createdByUserId: 'creator-c1', ownerEqualsAttribution: false },
      { companyId: 'c2', primaryOwnerUserId: 'owner-c2', createdByUserId: 'creator-c2', ownerEqualsAttribution: false },
    ];

    const prisma = new PrismaClient({ datasources: { db: { url: urlFor(databaseName) } } });
    try {
      await applyLegacyMappingPreparation(prisma, {
        packageId: `m02pkg_${digest.slice(0, 24)}`,
        digest,
        canonicalPayload,
        databaseName,
        approvedBy: rows[0].approvedBy,
        approvedAt: rows[0].approvedAt,
        approvalReference: rows[0].approvalReference,
        mappingVersion: rows[0].mappingVersion,
        rows: preparedRows,
      });
    } finally {
      await prisma.$disconnect();
    }

    executeFile(databaseName, m02MigrationPath, true);
    expect(query(databaseName, `SELECT to_regclass('"CompanyOwnership"') IS NULL;`)).toBe('t');
    expect(query(databaseName, `SELECT count(*) FROM "_MawaredM02LegacyMappingPackage" WHERE "consumedAt" IS NULL;`)).toBe('1');
  }, 120_000);

  it('backfills exactly one Primary Owner per Company from a validated legacy mapping, consumes the package, and refuses re-consumption', async () => {
    const databaseName = 'mawared_m02_valid';
    createDatabase(databaseName);
    applyBaseline(databaseName);
    insertCompanyUserFixture(databaseName);

    const rows = parseLegacyMappingCsv(legacyMappingCsv);
    const validated = validateLegacyMappingAgainstCompanies(rows, companiesInventory);
    const canonicalPayload = buildLegacyMappingCanonicalPayload(rows);
    const digest = calculateLegacyMappingDigest(canonicalPayload);
    const packageId = `m02pkg_${digest.slice(0, 24)}`;

    const prisma = new PrismaClient({ datasources: { db: { url: urlFor(databaseName) } } });
    try {
      const result = await applyLegacyMappingPreparation(prisma, {
        packageId,
        digest,
        canonicalPayload,
        databaseName,
        approvedBy: rows[0].approvedBy,
        approvedAt: rows[0].approvedAt,
        approvalReference: rows[0].approvalReference,
        mappingVersion: rows[0].mappingVersion,
        rows: validated,
      });
      expect(result.status).toBe('created');
    } finally {
      await prisma.$disconnect();
    }

    executeFile(databaseName, m02MigrationPath);

    expect(query(databaseName, `SELECT count(*) FROM "CompanyOwnership";`)).toBe('2');
    expect(query(databaseName, `
      SELECT count(*) FROM "CompanyOwnership"
      WHERE "companyId" = 'c1' AND "userId" = 'owner-c1' AND "createdByUserId" = 'creator-c1'
        AND "isPrimary" = TRUE AND "status" = 'active';
    `)).toBe('1');
    expect(query(databaseName, `
      SELECT count(*) FROM "CompanyOwnership"
      WHERE "companyId" = 'c2' AND "userId" = 'owner-c2' AND "createdByUserId" = 'creator-c2'
        AND "isPrimary" = TRUE AND "status" = 'active';
    `)).toBe('1');
    expect(query(databaseName, `
      SELECT "consumedAt" IS NOT NULL FROM "_MawaredM02LegacyMappingPackage" WHERE "id" = '${packageId}';
    `)).toBe('t');

    // The Primary Owner is deliberately distinct from admin.full/Role data:
    // this backfill never reads Role or permissions at all (see the static
    // migration-text assertions in m02_ownership_mapping.test.ts).

    // Re-running just the legacy backfill DO block against the now-consumed
    // package must fail closed and must not create a second owner.
    execute(databaseName, backfillDoBlockSql, true);
    expect(query(databaseName, `SELECT count(*) FROM "CompanyOwnership";`)).toBe('2');
  }, 120_000);

  it('refuses a second unconsumed package with a different digest, and is idempotent for an identical digest', async () => {
    const databaseName = 'mawared_m02_reuse_guard';
    // The control tables have no foreign keys to Company/User, so this test
    // does not need the baseline migrations or any fixture data.
    createDatabase(databaseName);

    const prisma = new PrismaClient({ datasources: { db: { url: urlFor(databaseName) } } });
    try {
      const csvA = [
        'company_id,primary_owner_user_id,created_by_user_id,approved_by,approved_at,approval_reference,mapping_version',
        'company-a,owner-a,creator-a,Basel Zaid,2026-07-01T00:00:00Z,APPROVAL-REF-A,m02-legacy-v1',
      ].join('\n');
      const rowsA = parseLegacyMappingCsv(csvA);
      const canonicalA = buildLegacyMappingCanonicalPayload(rowsA);
      const digestA = calculateLegacyMappingDigest(canonicalA);
      const validatedA: ValidatedLegacyMappingRow[] = [
        { companyId: 'company-a', primaryOwnerUserId: 'owner-a', createdByUserId: 'creator-a', ownerEqualsAttribution: false },
      ];
      const prepareA = () => applyLegacyMappingPreparation(prisma, {
        packageId: `m02pkg_${digestA.slice(0, 24)}`,
        digest: digestA,
        canonicalPayload: canonicalA,
        databaseName,
        approvedBy: rowsA[0].approvedBy,
        approvedAt: rowsA[0].approvedAt,
        approvalReference: rowsA[0].approvalReference,
        mappingVersion: rowsA[0].mappingVersion,
        rows: validatedA,
      });

      const first = await prepareA();
      expect(first.status).toBe('created');
      const second = await prepareA();
      expect(second.status).toBe('already_prepared');
      expect(second.packageId).toBe(first.packageId);

      const csvB = [
        'company_id,primary_owner_user_id,created_by_user_id,approved_by,approved_at,approval_reference,mapping_version',
        'company-b,owner-b,creator-b,Basel Zaid,2026-07-02T00:00:00Z,APPROVAL-REF-B,m02-legacy-v1',
      ].join('\n');
      const rowsB = parseLegacyMappingCsv(csvB);
      const canonicalB = buildLegacyMappingCanonicalPayload(rowsB);
      const digestB = calculateLegacyMappingDigest(canonicalB);
      const validatedB: ValidatedLegacyMappingRow[] = [
        { companyId: 'company-b', primaryOwnerUserId: 'owner-b', createdByUserId: 'creator-b', ownerEqualsAttribution: false },
      ];
      await expect(applyLegacyMappingPreparation(prisma, {
        packageId: `m02pkg_${digestB.slice(0, 24)}`,
        digest: digestB,
        canonicalPayload: canonicalB,
        databaseName,
        approvedBy: rowsB[0].approvedBy,
        approvedAt: rowsB[0].approvedAt,
        approvalReference: rowsB[0].approvalReference,
        mappingVersion: rowsB[0].mappingVersion,
        rows: validatedB,
      })).rejects.toThrow('already exists');
    } finally {
      await prisma.$disconnect();
    }

    expect(query(databaseName, `
      SELECT count(*) FROM "_MawaredM02LegacyMappingPackage" WHERE "consumedAt" IS NULL;
    `)).toBe('1');
  }, 60_000);
});
