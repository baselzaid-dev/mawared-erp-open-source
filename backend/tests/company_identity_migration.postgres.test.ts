import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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

function runQuietly(label: string, command: string, args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function runExpectFailure(command: string, args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'ignore',
    windowsHide: true,
  });
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
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

const initdb = findCommand('initdb');
const pgCtl = findCommand('pg_ctl');
const createdb = findCommand('createdb');
const psql = findCommand('psql');
const backendRoot = resolve(process.cwd());
const prismaCli = resolve(backendRoot, 'node_modules/prisma/build/index.js');
const migrationName = '20260714000100_company_identity_login';
const baselineMigrations = [
  '0_init',
  '20260710000100_salary_payroll_foundation',
  '20260710000200_task_assignment_workflow',
  '20260710000300_chat_foundation',
  '20260710000400_purchasing_core',
  '20260710000500_training_core',
  '20260710000600_reporting_security_indexes',
];
const hasDisposablePostgres = Boolean(
  initdb && pgCtl && createdb && psql && existsSync(prismaCli),
);
const postgresDescribe = hasDisposablePostgres ? describe : describe.skip;

postgresDescribe('Sprint 12B M01 on disposable PostgreSQL', () => {
  const databaseUser = 'mawared_test';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let port = 0;

  const databaseEnvironment = (databaseName: string): NodeJS.ProcessEnv => {
    const localUrl = [
      'postgresql', '://', databaseUser, '@127.0.0.1:', String(port), '/', databaseName,
      '?schema=public',
    ].join('');
    return { ...process.env, DATABASE_URL: localUrl, DIRECT_URL: localUrl };
  };

  const stopAndClean = () => {
    if (clusterStarted && pgCtl) {
      spawnSync(pgCtl, ['--pgdata', clusterDirectory, '--wait', '--mode', 'fast', 'stop'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      clusterStarted = false;
    }
    if (
      workDirectory &&
      dirname(workDirectory) === tmpdir() &&
      basename(workDirectory).startsWith('mawared-identity-pg-')
    ) {
      rmSync(workDirectory, { recursive: true, force: true });
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

  const preparePrismaDirectory = (scenario: string): string => {
    const scenarioRoot = join(workDirectory, scenario, 'prisma');
    const migrationsRoot = join(scenarioRoot, 'migrations');
    mkdirSync(migrationsRoot, { recursive: true });
    copyFileSync(
      join(backendRoot, 'prisma', 'schema.prisma'),
      join(scenarioRoot, 'schema.prisma'),
    );
    copyFileSync(
      join(backendRoot, 'prisma', 'migrations', 'migration_lock.toml'),
      join(migrationsRoot, 'migration_lock.toml'),
    );
    for (const migration of baselineMigrations) {
      cpSync(
        join(backendRoot, 'prisma', 'migrations', migration),
        join(migrationsRoot, migration),
        { recursive: true },
      );
    }
    return scenarioRoot;
  };

  const deploy = (databaseName: string, prismaRoot: string) => {
    runQuietly(
      'Prisma migrate deploy',
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--schema', join(prismaRoot, 'schema.prisma')],
      { cwd: dirname(prismaRoot), env: databaseEnvironment(databaseName) },
    );
  };

  const deployExpectFailure = (databaseName: string, prismaRoot: string) => {
    runExpectFailure(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--schema', join(prismaRoot, 'schema.prisma')],
      { cwd: dirname(prismaRoot), env: databaseEnvironment(databaseName) },
    );
  };

  const addM01 = (prismaRoot: string) => {
    cpSync(
      join(backendRoot, 'prisma', 'migrations', migrationName),
      join(prismaRoot, 'migrations', migrationName),
      { recursive: true },
    );
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

  const commonFixture = (extraRows: string) => `
    INSERT INTO "Company" ("id", "name", "createdAt", "updatedAt") VALUES
      ('c1', 'Company One', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('c2', 'Company Two', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO "Role" ("id", "companyId", "name", "permissions", "createdAt", "updatedAt") VALUES
      ('r1', 'c1', 'Employee', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('r2', 'c2', 'Employee', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    ${extraRows}
  `;

  beforeAll(async () => {
    workDirectory = mkdtempSync(join(tmpdir(), 'mawared-identity-pg-'));
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

  it('backfills safely, permits cross-company reuse, preserves schema, and is idempotent', () => {
    const databaseName = 'mawared_identity_success';
    createDatabase(databaseName);
    const prismaRoot = preparePrismaDirectory('success');
    deploy(databaseName, prismaRoot);
    execute(databaseName, commonFixture(`
      INSERT INTO "Employee" ("id", "companyId", "employeeNum", "jobTitle", "joiningDate", "createdAt", "updatedAt") VALUES
        ('e1', 'c1', 'EMP-001', 'Engineer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('e2', 'c2', 'EMP-001', 'Engineer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "User" ("id", "companyId", "employeeId", "email", "password", "name", "roleId", "createdAt", "updatedAt") VALUES
        ('u1', 'c1', 'e1', 'shared-one@example.test', 'fixture', 'User One', 'r1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('u2', 'c2', 'e2', 'shared-two@example.test', 'fixture', 'User Two', 'r2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `));

    addM01(prismaRoot);
    deploy(databaseName, prismaRoot);

    expect(query(databaseName, 'SELECT count(*) FROM "Company" WHERE "code" IS NOT NULL;')).toBe('2');
    expect(query(databaseName, 'SELECT count(DISTINCT "code") FROM "Company";')).toBe('2');
    expect(query(databaseName, 'SELECT count(*) FROM "LoginIdentity";')).toBe('4');
    expect(query(databaseName, `
      SELECT count(*) FROM "LoginIdentity" li
      LEFT JOIN "User" u ON u."id" = li."userId" AND u."companyId" = li."companyId"
      WHERE u."id" IS NULL;
    `)).toBe('0');
    expect(query(databaseName, `
      SELECT count(*) FROM pg_constraint
      WHERE conname IN (
        'LoginIdentity_userId_companyId_fkey',
        'RefreshToken_userId_companyId_fkey',
        'User_employeeId_companyId_fkey'
      );
    `)).toBe('3');
    expect(query(databaseName, `
      SELECT CASE WHEN relrowsecurity THEN 'enabled' ELSE 'disabled' END
      FROM pg_class WHERE oid = '"LoginIdentity"'::regclass;
    `)).toBe('enabled');
    expect(query(databaseName, `SELECT count(*) FROM pg_policies WHERE tablename = 'LoginIdentity';`)).toBe('0');

    execute(databaseName, `
      UPDATE "User"
      SET "email" = 'shared-one@example.test', "normalizedEmail" = 'shared-one@example.test'
      WHERE "id" = 'u2';
      UPDATE "LoginIdentity"
      SET "normalizedIdentifier" = 'shared-one@example.test', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "companyId" = 'c2' AND "userId" = 'u2' AND "type" = 'email';
    `);
    expect(query(databaseName, `
      SELECT count(*) FROM "LoginIdentity"
      WHERE "normalizedIdentifier" = 'shared-one@example.test';
    `)).toBe('2');

    execute(databaseName, `
      INSERT INTO "Employee" (
        "id", "companyId", "employeeNum", "normalizedEmployeeNum", "jobTitle",
        "joiningDate", "createdAt", "updatedAt"
      ) VALUES (
        'e-conflict', 'c1', ' emp-001 ', 'EMP-001', 'Engineer',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `, true);

    const moduleTableCount = query(databaseName, `
      SELECT count(*) FROM unnest(ARRAY[
        'SalaryRecord', 'PayrollPeriod', 'Task', 'ChatConversation', 'Vendor',
        'PurchaseRequest', 'TrainingCourse', 'AuditLog'
      ]) AS table_name
      WHERE to_regclass(format('%I', table_name)) IS NOT NULL;
    `);
    expect(moduleTableCount).toBe('8');

    const migrationCount = query(databaseName, `
      SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;
    `);
    deploy(databaseName, prismaRoot);
    expect(query(databaseName, `
      SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;
    `)).toBe(migrationCount);

    execute(databaseName, `UPDATE "Company" SET "code" = 'OTHER-CODE' WHERE "id" = 'c1';`, true);
  }, 120_000);

  it('rolls back cleanly when normalized emails collide inside one company', () => {
    const databaseName = 'mawared_identity_email_collision';
    createDatabase(databaseName);
    const prismaRoot = preparePrismaDirectory('email-collision');
    deploy(databaseName, prismaRoot);
    execute(databaseName, commonFixture(`
      INSERT INTO "Employee" ("id", "companyId", "employeeNum", "jobTitle", "joiningDate", "createdAt", "updatedAt") VALUES
        ('e1', 'c1', 'EMP-101', 'Engineer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('e2', 'c1', 'EMP-102', 'Engineer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "User" ("id", "companyId", "employeeId", "email", "password", "name", "roleId", "createdAt", "updatedAt") VALUES
        ('u1', 'c1', 'e1', 'Case@Example.test', 'fixture', 'User One', 'r1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('u2', 'c1', 'e2', ' case@example.test ', 'fixture', 'User Two', 'r1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `));
    addM01(prismaRoot);
    deployExpectFailure(databaseName, prismaRoot);
    expect(query(databaseName, `
      SELECT count(*) FROM information_schema.columns
      WHERE table_name = 'Company' AND column_name = 'code';
    `)).toBe('0');
    expect(query(databaseName, `SELECT to_regclass('"LoginIdentity"') IS NULL;`)).toBe('t');
  }, 120_000);

  it('rolls back cleanly when normalized Employee numbers collide inside one company', () => {
    const databaseName = 'mawared_identity_employee_collision';
    createDatabase(databaseName);
    const prismaRoot = preparePrismaDirectory('employee-collision');
    deploy(databaseName, prismaRoot);
    execute(databaseName, commonFixture(`
      INSERT INTO "Employee" ("id", "companyId", "employeeNum", "jobTitle", "joiningDate", "createdAt", "updatedAt") VALUES
        ('e1', 'c1', 'EMP-201', 'Engineer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('e2', 'c1', ' emp-201 ', 'Engineer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "User" ("id", "companyId", "employeeId", "email", "password", "name", "roleId", "createdAt", "updatedAt") VALUES
        ('u1', 'c1', 'e1', 'one@example.test', 'fixture', 'User One', 'r1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('u2', 'c1', 'e2', 'two@example.test', 'fixture', 'User Two', 'r1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `));
    addM01(prismaRoot);
    deployExpectFailure(databaseName, prismaRoot);
    expect(query(databaseName, `
      SELECT count(*) FROM information_schema.columns
      WHERE table_name = 'Employee' AND column_name = 'normalizedEmployeeNum';
    `)).toBe('0');
  }, 120_000);

  it('rolls back cleanly when an identity contains invisible Unicode formatting', () => {
    const databaseName = 'mawared_identity_unicode_formatting';
    createDatabase(databaseName);
    const prismaRoot = preparePrismaDirectory('unicode-formatting');
    deploy(databaseName, prismaRoot);
    execute(databaseName, commonFixture(`
      INSERT INTO "Employee" ("id", "companyId", "employeeNum", "jobTitle", "joiningDate", "createdAt", "updatedAt") VALUES
        ('e1', 'c1', 'EMP-301', 'Engineer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "User" ("id", "companyId", "employeeId", "email", "password", "name", "roleId", "createdAt", "updatedAt") VALUES
        ('u1', 'c1', 'e1', U&'user\\200B@example.test', 'fixture', 'User One', 'r1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `));
    addM01(prismaRoot);
    deployExpectFailure(databaseName, prismaRoot);
    expect(query(databaseName, `
      SELECT count(*) FROM information_schema.columns
      WHERE table_name = 'Company' AND column_name = 'code';
    `)).toBe('0');
  }, 120_000);
});
