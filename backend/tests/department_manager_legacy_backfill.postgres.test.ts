import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const prismaCli = require.resolve('prisma/build/index.js');

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

function runQuietly(
  label: string,
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): void {
  const result = spawnSync(command, args, {
    stdio: 'ignore',
    windowsHide: true,
    cwd: options?.cwd,
    env: options?.env ? { ...process.env, ...options.env } : process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function runCapture(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: options?.cwd,
    env: options?.env ? { ...process.env, ...options.env } : process.env,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
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
const dropdb = findCommand('dropdb');
const psql = findCommand('psql');
const hasDisposablePostgres = Boolean(initdb && pgCtl && createdb && psql);
const postgresDescribe = hasDisposablePostgres ? describe : describe.skip;

const backendRoot = resolve(process.cwd());
const migrationsRoot = join(backendRoot, 'prisma', 'migrations');
const migration20Name = '20260723000100_rc2_department_manager_legacy_backfill';
const e1MigrationName = '20260726000100_credential_recovery_e1_foundation';
const e5MigrationName = '20260730000100_credential_recovery_e5_break_glass';
const allMigrationNames = readdirSync(migrationsRoot)
  .filter((name) => {
    if (name.startsWith('.') || name === 'migration_lock.toml') return false;
    return statSync(join(migrationsRoot, name)).isDirectory();
  })
  .sort();
/** Migrations through M20 only — later append-only migrations have their own suites. */
const throughMigration20 = allMigrationNames.filter(
  (name) => name <= migration20Name,
);
const baseline19 = throughMigration20.filter((name) => name !== migration20Name);

postgresDescribe('RC2 DepartmentManager legacy backfill migration', () => {
  const databaseUser = 'mawared_test';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let port = 0;

  const urlFor = (databaseName: string): string => (
    ['postgres', 'ql', '://'].join('')
    + `${databaseUser}@127.0.0.1:${port}/${databaseName}?schema=public`
  );

  const databaseEnvironment = (databaseName: string): NodeJS.ProcessEnv => ({
    ...process.env,
    DATABASE_URL: urlFor(databaseName),
    DIRECT_URL: urlFor(databaseName),
  });

  const stopAndClean = () => {
    if (clusterStarted && pgCtl) {
      spawnSync(pgCtl, ['--pgdata', clusterDirectory, '--wait', '--mode', 'fast', 'stop'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      clusterStarted = false;
    }
    if (
      workDirectory
      && dirname(workDirectory) === tmpdir()
      && basename(workDirectory).startsWith('mawared-dm-legacy-')
    ) {
      try {
        rmSync(workDirectory, { recursive: true, force: true });
      } catch {
        // Windows may keep a brief lock on stopped PostgreSQL files.
      }
    }
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

  const dropDatabase = (databaseName: string) => {
    if (!dropdb) return;
    spawnSync(dropdb, [
      '--host', '127.0.0.1',
      '--port', String(port),
      '--username', databaseUser,
      '--if-exists',
      databaseName,
    ], { stdio: 'ignore', windowsHide: true });
  };

  const preparePrismaDirectory = (scenario: string, includeMigration20: boolean): string => {
    const scenarioRoot = join(workDirectory, scenario, 'prisma');
    const scenarioMigrations = join(scenarioRoot, 'migrations');
    mkdirSync(scenarioMigrations, { recursive: true });
    copyFileSync(join(backendRoot, 'prisma', 'schema.prisma'), join(scenarioRoot, 'schema.prisma'));
    copyFileSync(
      join(backendRoot, 'prisma', 'migrations', 'migration_lock.toml'),
      join(scenarioMigrations, 'migration_lock.toml'),
    );
    const selected = includeMigration20 ? throughMigration20 : baseline19;
    for (const migration of selected) {
      cpSync(
        join(migrationsRoot, migration),
        join(scenarioMigrations, migration),
        { recursive: true },
      );
    }
    return scenarioRoot;
  };

  const deploy = (databaseName: string, prismaRoot: string) => {
    runQuietly(
      'prisma migrate deploy',
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--schema', join(prismaRoot, 'schema.prisma')],
      { cwd: dirname(prismaRoot), env: databaseEnvironment(databaseName) },
    );
  };

  const deployCapture = (databaseName: string, prismaRoot: string) => (
    runCapture(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--schema', join(prismaRoot, 'schema.prisma')],
      { cwd: dirname(prismaRoot), env: databaseEnvironment(databaseName) },
    )
  );

  const migration20Sql = (): string => (
    readFileSync(join(migrationsRoot, migration20Name, 'migration.sql'), 'utf8')
  );

  const prepareForcedPostCheckFailurePrisma = (scenario: string): string => {
    const prismaRoot = preparePrismaDirectory(scenario, true);
    const sqlPath = join(prismaRoot, 'migrations', migration20Name, 'migration.sql');
    const original = readFileSync(sqlPath, 'utf8');
    const anchor = 'SELECT COUNT(*)::integer INTO unmatched_legacy_count';
    const anchorIndex = original.indexOf(anchor);
    if (anchorIndex < 0) {
      throw new Error('unable to locate post-check anchor for forced post-insert failure patch');
    }
    const patched = `${original.slice(0, anchorIndex)}RAISE EXCEPTION
    'DM legacy backfill post-check failed: forced post-insert invariant failure for rollback proof';

  ${original.slice(anchorIndex)}`;
    writeFileSync(sqlPath, patched, 'utf8');
    return prismaRoot;
  };

  const applyMigration20Sql = (databaseName: string, expectFailure = false): string => {
    const filePath = join(migrationsRoot, migration20Name, 'migration.sql');
    const result = runCapture(psql!, [
      '--no-psqlrc',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--username', databaseUser,
      '--dbname', databaseName,
      '--set', 'ON_ERROR_STOP=1',
      '--file', filePath,
    ]);
    const combined = `${result.stdout}\n${result.stderr}`;
    if (expectFailure) {
      expect(result.status).not.toBe(0);
      return combined;
    }
    if (result.status !== 0) {
      throw new Error(`migration 20 SQL failed: ${combined}`);
    }
    return combined;
  };

  const execute = (databaseName: string, sql: string) => {
    const result = runCapture(psql!, [
      '--no-psqlrc',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--username', databaseUser,
      '--dbname', databaseName,
      '--set', 'ON_ERROR_STOP=1',
      '--command', sql,
    ]);
    if (result.status !== 0) {
      throw new Error(`psql failed: ${result.stdout}\n${result.stderr}\nSQL=${sql.slice(0, 240)}`);
    }
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
    if (result.status !== 0) throw new Error(`query failed: ${sql}`);
    return (result.stdout ?? '').trim();
  };

  const seedMinimalCompany = (databaseName: string, opts: {
    companyId: string;
    ownerId: string;
    managerId: string;
    deptId: string;
    managerStatus?: string;
    ownerStatus?: string;
    setManagerId?: boolean;
    extraActiveManagerId?: string;
    endedManagerRow?: boolean;
    skipOwner?: boolean;
    crossCompanyManager?: boolean;
  }) => {
    const managerStatus = opts.managerStatus ?? 'active';
    const ownerStatus = opts.ownerStatus ?? 'active';
    const setManager = opts.setManagerId !== false;
    const managerCompany = opts.crossCompanyManager ? `${opts.companyId}-other` : opts.companyId;
    const code = `CMP-${opts.companyId.toUpperCase()}`.slice(0, 32);
    const otherCode = `X${code}`.slice(0, 16);
    const managerRoleCompany = managerCompany === opts.companyId ? opts.companyId : managerCompany;

    const statements: string[] = [];
    statements.push('BEGIN;');
    statements.push(`
      INSERT INTO "Company" ("id", "code", "name", "createdAt", "updatedAt")
      VALUES ('${opts.companyId}', '${code}', 'Company ${opts.companyId}', NOW(), NOW());
      INSERT INTO "Role" ("id", "companyId", "name", "permissions", "createdAt", "updatedAt")
      VALUES ('role-${opts.companyId}', '${opts.companyId}', 'Admin', '["admin.full"]', NOW(), NOW());
      INSERT INTO "User" (
        "id", "companyId", "email", "normalizedEmail", "name", "password", "roleId",
        "accountStatus", "authorizationVersion", "createdAt", "updatedAt"
      ) VALUES (
        '${opts.ownerId}', '${opts.companyId}', 'owner-${opts.companyId}@example.test',
        lower('owner-${opts.companyId}@example.test'), 'Owner', 'hash', 'role-${opts.companyId}',
        '${ownerStatus}', 1, NOW(), NOW()
      );
    `);

    if (!opts.skipOwner) {
      statements.push(`
        INSERT INTO "CompanyOwnership" (
          "id", "companyId", "userId", "isPrimary", "status", "effectiveAt", "createdByUserId"
        ) VALUES (
          'own-${opts.companyId}', '${opts.companyId}', '${opts.ownerId}', TRUE, 'active', NOW(), '${opts.ownerId}'
        );
      `);
    }

    if (opts.crossCompanyManager) {
      statements.push(`
        INSERT INTO "Company" ("id", "code", "name", "createdAt", "updatedAt")
        VALUES ('${managerCompany}', '${otherCode}', 'Other', NOW(), NOW());
        INSERT INTO "Role" ("id", "companyId", "name", "permissions", "createdAt", "updatedAt")
        VALUES ('role-${managerCompany}', '${managerCompany}', 'Admin', '["admin.full"]', NOW(), NOW());
        INSERT INTO "User" (
          "id", "companyId", "email", "normalizedEmail", "name", "password", "roleId",
          "accountStatus", "authorizationVersion", "createdAt", "updatedAt"
        ) VALUES (
          'owner-${managerCompany}', '${managerCompany}', 'owner-${managerCompany}@example.test',
          lower('owner-${managerCompany}@example.test'), 'Other Owner', 'hash', 'role-${managerCompany}',
          'active', 1, NOW(), NOW()
        );
        INSERT INTO "CompanyOwnership" (
          "id", "companyId", "userId", "isPrimary", "status", "effectiveAt", "createdByUserId"
        ) VALUES (
          'own-${managerCompany}', '${managerCompany}', 'owner-${managerCompany}', TRUE, 'active', NOW(),
          'owner-${managerCompany}'
        );
      `);
    }

    statements.push(`
      INSERT INTO "User" (
        "id", "companyId", "email", "normalizedEmail", "name", "password", "roleId",
        "accountStatus", "authorizationVersion", "createdAt", "updatedAt"
      ) VALUES (
        '${opts.managerId}', '${managerCompany}', 'mgr-${opts.managerId}@example.test',
        lower('mgr-${opts.managerId}@example.test'), 'Manager', 'hash', 'role-${managerRoleCompany}',
        '${managerStatus}', 1, NOW(), NOW()
      );
    `);

    if (opts.extraActiveManagerId) {
      statements.push(`
        INSERT INTO "User" (
          "id", "companyId", "email", "normalizedEmail", "name", "password", "roleId",
          "accountStatus", "authorizationVersion", "createdAt", "updatedAt"
        ) VALUES (
          '${opts.extraActiveManagerId}', '${opts.companyId}', 'extra-${opts.extraActiveManagerId}@example.test',
          lower('extra-${opts.extraActiveManagerId}@example.test'), 'Extra', 'hash', 'role-${opts.companyId}',
          'active', 1, NOW(), NOW()
        );
      `);
    }

    statements.push(`
      INSERT INTO "Department" ("id", "companyId", "name", "managerId", "createdAt", "updatedAt")
      VALUES (
        '${opts.deptId}', '${opts.companyId}', 'Engineering',
        ${setManager ? `'${opts.managerId}'` : 'NULL'},
        NOW(), NOW()
      );
    `);

    if (opts.endedManagerRow) {
      statements.push(`
        INSERT INTO "DepartmentManager" (
          "id", "companyId", "departmentId", "userId", "status",
          "assignedByUserId", "assignedAt", "endedAt", "endedByUserId"
        ) VALUES (
          'dm-ended-${opts.deptId}', '${opts.companyId}', '${opts.deptId}', '${opts.managerId}', 'ended',
          '${opts.ownerId}', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 hour', '${opts.ownerId}'
        );
      `);
    }

    if (opts.extraActiveManagerId) {
      statements.push(`
        INSERT INTO "DepartmentManager" (
          "id", "companyId", "departmentId", "userId", "status",
          "assignedByUserId", "assignedAt"
        ) VALUES (
          'dm-extra-${opts.deptId}', '${opts.companyId}', '${opts.deptId}', '${opts.extraActiveManagerId}', 'active',
          '${opts.ownerId}', NOW()
        );
      `);
    }

    statements.push('COMMIT;');
    execute(databaseName, statements.join('\n'));
  };

  beforeAll(async () => {
    expect(allMigrationNames).toContain(migration20Name);
    expect(allMigrationNames).toContain(e1MigrationName);
    expect(throughMigration20.length).toBe(20);
    // 20 through M20, plus E1, E5, QA-round-1 attachments, W1A payroll/finance,
    // W2 purchasing expansion and P4 tasks/training collaboration.
    expect(allMigrationNames.length).toBe(26);
    port = await reserveLocalPort();
    workDirectory = mkdtempSync(join(tmpdir(), 'mawared-dm-legacy-'));
    clusterDirectory = join(workDirectory, 'pgdata');
    runQuietly('initdb', initdb!, [
      '--pgdata', clusterDirectory,
      '--username', databaseUser,
      '--auth=trust',
      '--encoding=UTF8',
      '--locale=C',
      '--no-instructions',
    ]);
    runQuietly('pg_ctl start', pgCtl!, [
      '--pgdata', clusterDirectory,
      '--wait',
      '--options', `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=`,
      'start',
    ]);
    clusterStarted = true;
  }, 120_000);

  afterAll(() => {
    stopAndClean();
  }, 60_000);

  it('migration SQL is explicitly transactional with session table locks', () => {
    const sql = migration20Sql();
    const withoutComments = sql
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, '').trim())
      .filter(Boolean)
      .join('\n');
    expect(withoutComments.startsWith('BEGIN;')).toBe(true);
    expect(withoutComments.endsWith('COMMIT;')).toBe(true);
    expect(withoutComments.match(/\bBEGIN;/gi)?.length).toBe(1);
    expect(withoutComments.match(/\bCOMMIT;/gi)?.length).toBe(1);
    expect(sql).toMatch(/LOCK TABLE "CompanyOwnership" IN SHARE ROW EXCLUSIVE MODE;/);
    expect(sql).toMatch(/LOCK TABLE "Department" IN SHARE ROW EXCLUSIVE MODE;/);
    expect(sql).toMatch(/LOCK TABLE "DepartmentManager" IN SHARE ROW EXCLUSIVE MODE;/);
    expect(sql).toMatch(/LOCK TABLE "User" IN SHARE MODE;/);
  });

  it('fresh empty database applies all 20 migrations and second deploy is a no-op', () => {
    const db = 'dm_fresh_empty';
    dropDatabase(db);
    createDatabase(db);
    const prismaRoot = preparePrismaDirectory('fresh', true);
    deploy(db, prismaRoot);
    const second = deployCapture(db, prismaRoot);
    expect(second.status).toBe(0);
    expect(`${second.stdout}\n${second.stderr}`).toMatch(/No pending migrations to apply/i);
    expect(query(db, `SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)).toBe('20');
    expect(query(db, `SELECT COUNT(*) FROM "DepartmentManager"`)).toBe('0');
    expect(['t', 'true']).toContain(
      query(db, `SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public."DepartmentManager"'::regclass`),
    );
  }, 240_000);

  it('backfills one active membership attributed to the company Primary Owner', () => {
    const db = 'dm_happy_path';
    dropDatabase(db);
    createDatabase(db);
    deploy(db, preparePrismaDirectory('happy-base', false));
    seedMinimalCompany(db, {
      companyId: 'c1',
      ownerId: 'owner-c1',
      managerId: 'mgr-c1',
      deptId: 'dept-c1',
    });
    applyMigration20Sql(db);
    expect(query(db, `SELECT "managerId" FROM "Department" WHERE id='dept-c1'`)).toBe('mgr-c1');
    expect(query(db, `
      SELECT COUNT(*) FROM "DepartmentManager"
      WHERE "departmentId"='dept-c1' AND "userId"='mgr-c1' AND status='active'
    `)).toBe('1');
    expect(query(db, `
      SELECT "assignedByUserId" FROM "DepartmentManager"
      WHERE "departmentId"='dept-c1' AND "userId"='mgr-c1' AND status='active'
    `)).toBe('owner-c1');
    expect(query(db, `
      SELECT ("assignedAt" IS NOT NULL)::text FROM "DepartmentManager"
      WHERE "departmentId"='dept-c1' AND "userId"='mgr-c1' AND status='active'
    `)).toMatch(/^(t|true)$/);
    expect(query(db, `SELECT COUNT(*) FROM "User"`)).toBe('2');
  }, 240_000);

  it('leaves NULL managerId departments untouched and is idempotent for existing active memberships', () => {
    const db = 'dm_null_and_idempotent';
    dropDatabase(db);
    createDatabase(db);
    deploy(db, preparePrismaDirectory('null-idemp', false));
    seedMinimalCompany(db, {
      companyId: 'c1', ownerId: 'owner-c1', managerId: 'mgr-c1', deptId: 'dept-null', setManagerId: false,
    });
    seedMinimalCompany(db, {
      companyId: 'c2', ownerId: 'owner-c2', managerId: 'mgr-c2', deptId: 'dept-c2',
    });
    execute(db, `
      INSERT INTO "DepartmentManager" (
        "id", "companyId", "departmentId", "userId", "status", "assignedByUserId", "assignedAt"
      ) VALUES (
        'dm-existing', 'c2', 'dept-c2', 'mgr-c2', 'active', 'owner-c2', NOW()
      );
    `);
    applyMigration20Sql(db);
    expect(query(db, `SELECT COUNT(*) FROM "DepartmentManager" WHERE "departmentId"='dept-null'`)).toBe('0');
    expect(query(db, `SELECT COUNT(*) FROM "DepartmentManager" WHERE "departmentId"='dept-c2'`)).toBe('1');
    expect(query(db, `SELECT id FROM "DepartmentManager" WHERE "departmentId"='dept-c2'`)).toBe('dm-existing');
  }, 240_000);

  it('preserves ended history and additional active managers while inserting the legacy manager', () => {
    const db = 'dm_ended_multi';
    dropDatabase(db);
    createDatabase(db);
    deploy(db, preparePrismaDirectory('ended-multi', false));
    seedMinimalCompany(db, {
      companyId: 'c1',
      ownerId: 'owner-c1',
      managerId: 'mgr-c1',
      deptId: 'dept-c1',
      endedManagerRow: true,
      extraActiveManagerId: 'mgr-extra',
    });
    applyMigration20Sql(db);
    expect(query(db, `SELECT COUNT(*) FROM "DepartmentManager" WHERE status='ended'`)).toBe('1');
    expect(query(db, `SELECT COUNT(*) FROM "DepartmentManager" WHERE status='active'`)).toBe('2');
  }, 240_000);

  it('attributes each company to its own Primary Owner', () => {
    const db = 'dm_multi_company';
    dropDatabase(db);
    createDatabase(db);
    deploy(db, preparePrismaDirectory('multi-co', false));
    seedMinimalCompany(db, {
      companyId: 'c1', ownerId: 'owner-c1', managerId: 'mgr-c1', deptId: 'dept-c1',
    });
    seedMinimalCompany(db, {
      companyId: 'c2', ownerId: 'owner-c2', managerId: 'mgr-c2', deptId: 'dept-c2',
    });
    applyMigration20Sql(db);
    expect(query(db, `
      SELECT "assignedByUserId" FROM "DepartmentManager" WHERE "departmentId"='dept-c1' AND status='active'
    `)).toBe('owner-c1');
    expect(query(db, `
      SELECT "assignedByUserId" FROM "DepartmentManager" WHERE "departmentId"='dept-c2' AND status='active'
    `)).toBe('owner-c2');
  }, 240_000);

  it('fails closed and rolls back for invalid legacy manager or ownership preconditions', () => {
    const cases: Array<{ name: string; fragment: string; seed: (db: string) => void }> = [
      {
        name: 'missing',
        fragment: 'missing manager User',
        seed: (db) => {
          seedMinimalCompany(db, {
            companyId: 'c1', ownerId: 'owner-c1', managerId: 'mgr-c1', deptId: 'dept-c1',
          });
          execute(db, `
            ALTER TABLE "Department" DROP CONSTRAINT IF EXISTS "Department_managerId_fkey";
            UPDATE "Department" SET "managerId"='missing-user' WHERE id='dept-c1';
          `);
        },
      },
      {
        name: 'cross',
        fragment: 'cross-company manager',
        seed: (db) => {
          seedMinimalCompany(db, {
            companyId: 'c1', ownerId: 'owner-c1', managerId: 'mgr-x', deptId: 'dept-c1',
            crossCompanyManager: true,
          });
        },
      },
      {
        name: 'disabled',
        fragment: 'disabled/archived manager',
        seed: (db) => {
          seedMinimalCompany(db, {
            companyId: 'c1', ownerId: 'owner-c1', managerId: 'mgr-c1', deptId: 'dept-c1',
            managerStatus: 'disabled',
          });
        },
      },
      {
        name: 'archived',
        fragment: 'disabled/archived manager',
        seed: (db) => {
          seedMinimalCompany(db, {
            companyId: 'c1', ownerId: 'owner-c1', managerId: 'mgr-c1', deptId: 'dept-c1',
            managerStatus: 'archived',
          });
        },
      },
      {
        name: 'zero-owner',
        fragment: 'zero active Primary Owners',
        seed: (db) => {
          seedMinimalCompany(db, {
            companyId: 'c1', ownerId: 'owner-c1', managerId: 'mgr-c1', deptId: 'dept-c1',
          });
          execute(db, `
            ALTER TABLE "CompanyOwnership" DISABLE TRIGGER ALL;
            DELETE FROM "CompanyOwnership" WHERE "companyId"='c1';
            ALTER TABLE "CompanyOwnership" ENABLE TRIGGER ALL;
          `);
        },
      },
      {
        name: 'inactive-owner',
        fragment: 'inactive or cross-company Primary Owner',
        seed: (db) => {
          seedMinimalCompany(db, {
            companyId: 'c1', ownerId: 'owner-c1', managerId: 'mgr-c1', deptId: 'dept-c1',
          });
          execute(db, `UPDATE "User" SET "accountStatus"='disabled' WHERE id='owner-c1';`);
        },
      },
    ];

    for (const testCase of cases) {
      const db = `dm_fail_${testCase.name}`.replace(/[^a-z0-9_]/g, '_');
      dropDatabase(db);
      createDatabase(db);
      deploy(db, preparePrismaDirectory(`fail-${testCase.name}`, false));
      testCase.seed(db);
      const output = applyMigration20Sql(db, true);
      expect(output.toLowerCase()).toContain(testCase.fragment.toLowerCase());
      expect(query(db, `SELECT COUNT(*) FROM "DepartmentManager"`)).toBe(
        testCase.name === 'zero-owner' || testCase.name === 'inactive-owner'
          || testCase.name === 'missing' || testCase.name === 'cross'
          || testCase.name === 'disabled' || testCase.name === 'archived'
          ? '0'
          : '0',
      );
    }
  }, 420_000);

  it('fails closed when two active Primary Owners exist for an affected company', () => {
    const db = 'dm_fail_dual_owner';
    dropDatabase(db);
    createDatabase(db);
    deploy(db, preparePrismaDirectory('fail-dual', false));
    seedMinimalCompany(db, {
      companyId: 'c1', ownerId: 'owner-c1', managerId: 'mgr-c1', deptId: 'dept-c1',
    });
    execute(db, `
      INSERT INTO "User" (
        "id", "companyId", "email", "normalizedEmail", "name", "password", "roleId",
        "accountStatus", "authorizationVersion", "createdAt", "updatedAt"
      ) VALUES (
        'owner2-c1', 'c1', 'owner2-c1@example.test', 'owner2-c1@example.test', 'Owner2', 'hash',
        'role-c1', 'active', 1, NOW(), NOW()
      );
      ALTER TABLE "CompanyOwnership" DISABLE TRIGGER ALL;
      ALTER TABLE "CompanyOwnership" DROP CONSTRAINT IF EXISTS "CompanyOwnership_one_active_primary_key";
      INSERT INTO "CompanyOwnership" (
        "id", "companyId", "userId", "isPrimary", "status", "effectiveAt", "createdByUserId",
        "activePrimaryCompanyId"
      ) VALUES (
        'own2-c1', 'c1', 'owner2-c1', TRUE, 'active', NOW(), 'owner-c1', 'c1-dup'
      );
      ALTER TABLE "CompanyOwnership" ENABLE TRIGGER ALL;
    `);
    const output = applyMigration20Sql(db, true);
    expect(output.toLowerCase()).toContain('multiple active primary owners');
    expect(query(db, `SELECT COUNT(*) FROM "DepartmentManager"`)).toBe('0');
  }, 240_000);

  it('passes verify:authorization-migrations after a valid backfill', () => {
    const db = 'dm_verifier_pass';
    dropDatabase(db);
    createDatabase(db);
    deploy(db, preparePrismaDirectory('verifier', false));
    seedMinimalCompany(db, {
      companyId: 'c1', ownerId: 'owner-c1', managerId: 'mgr-c1', deptId: 'dept-c1',
    });
    execute(db, `
      INSERT INTO "User" (
        "id", "companyId", "email", "normalizedEmail", "name", "password", "roleId",
        "accountStatus", "authorizationVersion", "createdAt", "updatedAt"
      ) VALUES (
        'peer-c1', 'c1', 'peer-c1@example.test', 'peer-c1@example.test', 'Peer', 'hash',
        'role-c1', 'active', 1, NOW(), NOW()
      );
    `);
    applyMigration20Sql(db);
    const verify = runCapture(
      process.execPath,
      [require.resolve('tsx/cli'), join(backendRoot, 'scripts/verify_authorization_migrations.ts')],
      { cwd: backendRoot, env: databaseEnvironment(db) },
    );
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain('legacy/new Department Manager compatibility: PASS');
  }, 240_000);

  it('rolls back every inserted DepartmentManager row when a post-insert check fails', () => {
    const db = 'dm_forced_postcheck_rollback';
    dropDatabase(db);
    createDatabase(db);
    deploy(db, preparePrismaDirectory('forced-base', false));
    seedMinimalCompany(db, {
      companyId: 'c1',
      ownerId: 'owner-c1',
      managerId: 'mgr-c1',
      deptId: 'dept-c1',
      endedManagerRow: true,
    });

    const beforeUsers = query(db, `SELECT COUNT(*) FROM "User"`);
    const beforeEmployees = query(db, `SELECT COUNT(*) FROM "Employee"`);
    const beforeLoginIdentities = query(db, `SELECT COUNT(*) FROM "LoginIdentity"`);
    const beforeOwnership = query(db, `SELECT COUNT(*) FROM "CompanyOwnership"`);
    const beforeDepartments = query(db, `SELECT COUNT(*) FROM "Department"`);
    const beforeEnded = query(db, `SELECT COUNT(*) FROM "DepartmentManager" WHERE status='ended'`);
    const beforeActive = query(db, `SELECT COUNT(*) FROM "DepartmentManager" WHERE status='active'`);
    const beforeManagerId = query(db, `SELECT "managerId" FROM "Department" WHERE id='dept-c1'`);
    const beforeCompleted = query(
      db,
      `SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    expect(beforeCompleted).toBe('19');
    expect(beforeEnded).toBe('1');
    expect(beforeActive).toBe('0');

    // psql -f path: prove the explicit BEGIN/COMMIT rolls back inserts when a
    // post-insert check raises (this is the atomicity gap called out in PR #54 P1).
    const forcedSqlDir = join(workDirectory, 'forced-sql');
    mkdirSync(forcedSqlDir, { recursive: true });
    const forcedSqlPath = join(forcedSqlDir, 'migration.sql');
    const originalSql = migration20Sql();
    const anchor = 'SELECT COUNT(*)::integer INTO unmatched_legacy_count';
    const anchorIndex = originalSql.indexOf(anchor);
    expect(anchorIndex).toBeGreaterThanOrEqual(0);
    writeFileSync(
      forcedSqlPath,
      `${originalSql.slice(0, anchorIndex)}RAISE EXCEPTION
    'DM legacy backfill post-check failed: forced post-insert invariant failure for rollback proof';

  ${originalSql.slice(anchorIndex)}`,
      'utf8',
    );
    const psqlFail = runCapture(psql!, [
      '--no-psqlrc',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--username', databaseUser,
      '--dbname', db,
      '--set', 'ON_ERROR_STOP=1',
      '--file', forcedSqlPath,
    ]);
    expect(psqlFail.status).not.toBe(0);
    expect(`${psqlFail.stdout}\n${psqlFail.stderr}`.toLowerCase()).toContain(
      'forced post-insert invariant failure',
    );
    expect(query(db, `SELECT COUNT(*) FROM "DepartmentManager" WHERE id LIKE 'dm_legacy_bf_%'`)).toBe('0');
    expect(query(db, `SELECT COUNT(*) FROM "DepartmentManager" WHERE status='active'`)).toBe('0');
    expect(query(db, `SELECT COUNT(*) FROM "DepartmentManager" WHERE status='ended'`)).toBe(beforeEnded);

    // Prisma migrate deploy path: patched migration 20 must fail closed with no
    // completed migration 20 record and no surviving compatibility rows.
    const forcedPrisma = prepareForcedPostCheckFailurePrisma('forced-fail');
    const failedDeploy = deployCapture(db, forcedPrisma);
    expect(failedDeploy.status).not.toBe(0);
    const deployOutput = `${failedDeploy.stdout}\n${failedDeploy.stderr}`.toLowerCase();
    expect(
      deployOutput.includes('forced post-insert invariant failure')
      || deployOutput.includes('current transaction is aborted')
      || deployOutput.includes('applying migration'),
    ).toBe(true);

    expect(query(db, `SELECT COUNT(*) FROM "DepartmentManager" WHERE id LIKE 'dm_legacy_bf_%'`)).toBe('0');
    expect(query(db, `SELECT COUNT(*) FROM "DepartmentManager" WHERE status='active'`)).toBe('0');
    expect(query(db, `SELECT COUNT(*) FROM "DepartmentManager" WHERE status='ended'`)).toBe(beforeEnded);
    expect(query(db, `SELECT COUNT(*) FROM "User"`)).toBe(beforeUsers);
    expect(query(db, `SELECT COUNT(*) FROM "Employee"`)).toBe(beforeEmployees);
    expect(query(db, `SELECT COUNT(*) FROM "LoginIdentity"`)).toBe(beforeLoginIdentities);
    expect(query(db, `SELECT COUNT(*) FROM "CompanyOwnership"`)).toBe(beforeOwnership);
    expect(query(db, `SELECT COUNT(*) FROM "Department"`)).toBe(beforeDepartments);
    expect(query(db, `SELECT "managerId" FROM "Department" WHERE id='dept-c1'`)).toBe(beforeManagerId);

    const completedAfterFailure = query(
      db,
      `SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    expect(completedAfterFailure).toBe('19');
    expect(query(
      db,
      `SELECT COUNT(*) FROM "_prisma_migrations"
       WHERE migration_name = '${migration20Name}'
         AND finished_at IS NOT NULL
         AND rolled_back_at IS NULL`,
    )).toBe('0');

    const correctedDb = 'dm_forced_postcheck_corrected';
    dropDatabase(correctedDb);
    createDatabase(correctedDb);
    const goodPrisma = preparePrismaDirectory('forced-corrected', true);
    deploy(correctedDb, goodPrisma);
    const second = deployCapture(correctedDb, goodPrisma);
    expect(second.status).toBe(0);
    expect(`${second.stdout}\n${second.stderr}`).toMatch(/No pending migrations to apply/i);
    expect(query(
      correctedDb,
      `SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    )).toBe('20');
  }, 420_000);
});
