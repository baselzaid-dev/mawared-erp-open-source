import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import {
  CredentialRecoveryService,
  DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
  MapRecoveryTargetResolver,
  PostgresRecoveryRateLimitStore,
  PostgresRecoveryTargetStore,
  RecoveryRateLimiter,
  createSourceBucketHash,
} from '../src/credentialRecovery';

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

function runQuietly(label: string, command: string, args: string[], options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): void {
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

function runCapture(command: string, args: string[], options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): { status: number | null; stdout: string; stderr: string } {
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

function assertLocalLoopbackUrl(url: string): void {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`Refusing non-local database URL host: ${host}`);
  }
  if (/supabase|render\.com|amazonaws|neon\.tech|azure|cloud/i.test(url)) {
    throw new Error('Refusing hosted database URL');
  }
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
        reject(new Error('Unable to reserve local port'));
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
const prismaCli = resolve(backendRoot, 'node_modules/prisma/build/index.js');
const migrationsRoot = join(backendRoot, 'prisma', 'migrations');
const e1Name = '20260726000100_credential_recovery_e1_foundation';
const allMigrationNames = readdirSync(migrationsRoot)
  .filter((name) => {
    if (name.startsWith('.') || name === 'migration_lock.toml') return false;
    return statSync(join(migrationsRoot, name)).isDirectory();
  })
  .sort();
const hasDisposablePostgres = Boolean(initdb && pgCtl && createdb && psql && existsSync(prismaCli));
const suite = hasDisposablePostgres ? describe : describe.skip;

const TOKEN_PEPPER = 'e1-test-recovery-token-pepper-32chars-min';
const RATE_PEPPER = 'e1-test-recovery-rate-limit-pepper-32ch';
const ENV_BINDING = 'test:e1-fixture-fingerprint';

suite('credential recovery E1 on disposable PostgreSQL', () => {
  const databaseUser = 'mawared_e1';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let port = 0;
  let prisma: PrismaClient;
  let prismaRoot = '';
  let databaseName = 'mawared_recovery_e1';

  const urlFor = (name: string): string => {
    const localUrl = [
      'postgresql', '://', databaseUser, '@127.0.0.1:', String(port), '/', name,
      '?schema=public',
    ].join('');
    assertLocalLoopbackUrl(localUrl);
    return localUrl;
  };

  const databaseEnvironment = (name: string): NodeJS.ProcessEnv => ({
    ...process.env,
    DATABASE_URL: urlFor(name),
    DIRECT_URL: urlFor(name),
  });

  const stopAndClean = async () => {
    await prisma?.$disconnect().catch(() => undefined);
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
      basename(workDirectory).startsWith('mawared-recovery-e1-pg-')
    ) {
      try {
        rmSync(workDirectory, { recursive: true, force: true });
      } catch {
        // Windows may briefly lock PG files after stop; disposable temp dirs are acceptable leftovers.
      }
    }
  };

  const deploy = (name: string) => {
    runQuietly(
      'prisma migrate deploy',
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--schema', join(prismaRoot, 'schema.prisma')],
      { cwd: dirname(prismaRoot), env: databaseEnvironment(name) },
    );
  };

  const deployCapture = (name: string) => runCapture(
    process.execPath,
    [prismaCli, 'migrate', 'deploy', '--schema', join(prismaRoot, 'schema.prisma')],
    { cwd: dirname(prismaRoot), env: databaseEnvironment(name) },
  );

  const executeSql = (sql: string) => {
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
      throw new Error(`psql failed: ${result.stdout}\n${result.stderr}`);
    }
  };

  const insertPlatformPrincipal = (id: string, version = 1) => {
    executeSql(`
      INSERT INTO "PlatformPrincipal" (
        "id", "email", "normalizedEmail", "password", "name", "status",
        "permissions", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        '${id}', '${id}@example.test', '${id}@example.test', 'hash', 'Principal', 'active',
        '[]', 1, ${version}, NOW(), NOW()
      )
      ON CONFLICT ("id") DO UPDATE SET "credentialVersion" = EXCLUDED."credentialVersion", status = 'active';
    `);
  };

  const platformService = (clock?: () => Date, ttlOverrides?: { password_reset?: number }) =>
    new CredentialRecoveryService({
      prisma,
      crypto: { tokenPepper: TOKEN_PEPPER },
      environmentBinding: ENV_BINDING,
      targetStore: new PostgresRecoveryTargetStore(),
      ttlOverrides,
      clock: clock ?? (() => new Date('2026-07-26T12:00:00.000Z')),
    });

  beforeAll(async () => {
    workDirectory = mkdtempSync(join(tmpdir(), 'mawared-recovery-e1-pg-'));
    clusterDirectory = join(workDirectory, 'cluster');
    const logPath = join(workDirectory, 'postgres.log');
    port = await reserveLocalPort();
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

    runQuietly('createdb', createdb!, [
      '--host', '127.0.0.1',
      '--port', String(port),
      '--username', databaseUser,
      '--maintenance-db', 'postgres',
      databaseName,
    ]);

    prismaRoot = join(workDirectory, 'prisma');
    mkdirSync(join(prismaRoot, 'migrations'), { recursive: true });
    copyFileSync(join(backendRoot, 'prisma', 'schema.prisma'), join(prismaRoot, 'schema.prisma'));
    copyFileSync(
      join(backendRoot, 'prisma', 'migrations', 'migration_lock.toml'),
      join(prismaRoot, 'migrations', 'migration_lock.toml'),
    );
    for (const name of allMigrationNames) {
      cpSync(join(migrationsRoot, name), join(prismaRoot, 'migrations', name), { recursive: true });
    }

    deploy(databaseName);
    const second = deployCapture(databaseName);
    expect(second.status).toBe(0);
    expect(`${second.stdout}\n${second.stderr}`).toMatch(/No pending migrations to apply/i);

    prisma = new PrismaClient({ datasources: { db: { url: urlFor(databaseName) } } });
  }, 300_000);

  afterAll(stopAndClean, 60_000);

  it('applies E1 foundation and keeps prior lineage intact through later append-only migrations', async () => {
    expect(allMigrationNames).toHaveLength(26);
    expect(allMigrationNames).toContain(e1Name);
    expect(allMigrationNames[allMigrationNames.length - 1]).toBe(
      '20260809000100_commercial_p4_tasks_training_collaboration',
    );

    const finished = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations"
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    expect(Number(finished[0].count)).toBe(26);

    for (const name of allMigrationNames.slice(0, 25)) {
      const sql = readFileSync(join(migrationsRoot, name, 'migration.sql'));
      expect(createHash('sha256').update(sql).digest('hex')).toHaveLength(64);
    }

    expect(await prisma.company.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.platformPrincipal.count()).toBe(0);
  }, 60_000);

  it('rejects invalid domain/company and schema constraint violations at the database', async () => {
    await expect(prisma.$executeRawUnsafe(`
      INSERT INTO "CredentialRecoveryRequest" (
        "id","principalDomain","principalId","companyId","purpose","environmentBinding",
        "expiresAt","credentialVersionAtIssuance","initiatedBy","deliveryChannel","deliveryStatus",
        "tokenHash","tokenHashAlgorithm"
      ) VALUES (
        'bad1','platform_principal','p1','c1','password_reset','test:fixture1',
        NOW() + interval '15 minutes',1,'self','email','pending',
        'hmac-sha256-v1:${'a'.repeat(64)}','hmac-sha256-v1'
      )
    `)).rejects.toThrow();

    await expect(prisma.$executeRawUnsafe(`
      INSERT INTO "CredentialRecoveryRequest" (
        "id","principalDomain","principalId","companyId","purpose","environmentBinding",
        "expiresAt","credentialVersionAtIssuance","initiatedBy","deliveryChannel","deliveryStatus"
      ) VALUES (
        'bad2','company_employee','u1',NULL,'employee_admin_reset','test:fixture1',
        NOW() + interval '15 minutes',1,'company_admin','none','pending'
      )
    `)).rejects.toThrow();

    await expect(prisma.$executeRawUnsafe(`
      INSERT INTO "CredentialRecoveryAuditEvent" (
        "id","eventType","actorType","subjectId","subjectDomain","companyId",
        "result","reasonCode","requestId","referenceId"
      ) VALUES (
        'bad-audit','recovery_request_rejected','anonymous','x','unresolved','no-such-company',
        'failure','invalid_or_expired_token','req','ref-bad'
      )
    `)).rejects.toThrow();
  }, 30_000);

  it('issues, supersedes, consumes once, and rejects replay (AT-CR-03/05/43/45)', async () => {
    insertPlatformPrincipal('prin-1', 3);
    const service = platformService(() => new Date('2026-07-26T12:00:00.000Z'));

    const first = await service.issue({
      principalDomain: 'platform_principal',
      principalId: 'prin-1',
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId: 'req-issue-1',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstToken = first.value.deliverySecret!.reveal();

    const second = await service.issue({
      principalDomain: 'platform_principal',
      principalId: 'prin-1',
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId: 'req-issue-2',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const active = await prisma.credentialRecoveryRequest.findMany({
      where: {
        principalId: 'prin-1',
        purpose: 'password_reset',
        consumedAt: null,
        invalidatedAt: null,
      },
    });
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(second.value.recoveryRequestId);
    expect(JSON.stringify(active[0])).not.toContain(firstToken);

    const oldRejected = await service.withValidRecoveryRequest(
      {
        rawToken: firstToken,
        principalDomain: 'platform_principal',
        purpose: 'password_reset',
        requestId: 'req-old',
        now: new Date('2026-07-26T12:01:00.000Z'),
      },
      async () => ({ ok: true }),
    );
    expect(oldRejected.ok).toBe(false);

    const liveToken = second.value.deliverySecret!.reveal();
    const consumed = await service.withValidRecoveryRequest(
      {
        rawToken: liveToken,
        principalDomain: 'platform_principal',
        purpose: 'password_reset',
        requestId: 'req-consume',
        now: new Date('2026-07-26T12:01:00.000Z'),
      },
      async () => ({ touched: true }),
    );
    expect(consumed.ok).toBe(true);
    expect(await prisma.platformPrincipal.findUniqueOrThrow({ where: { id: 'prin-1' } }))
      .toMatchObject({ credentialVersion: 4 });

    const replay = await service.withValidRecoveryRequest(
      {
        rawToken: liveToken,
        principalDomain: 'platform_principal',
        purpose: 'password_reset',
        requestId: 'req-replay',
        now: new Date('2026-07-26T12:02:00.000Z'),
      },
      async () => ({ touched: true }),
    );
    expect(replay.ok).toBe(false);
  }, 60_000);

  it('rejects wrong purpose/domain/expectedCompany and credentialVersion mismatch', async () => {
    executeSql(`
      BEGIN;
      INSERT INTO "Company" ("id", "code", "name", "createdAt", "updatedAt")
      VALUES ('cmp-e1', 'CMP-E1', 'E1 Co', NOW(), NOW());
      INSERT INTO "Role" ("id", "companyId", "name", "permissions", "createdAt", "updatedAt")
      VALUES ('role-e1', 'cmp-e1', 'Admin', '["admin.full"]', NOW(), NOW());
      INSERT INTO "User" (
        "id", "companyId", "email", "normalizedEmail", "name", "password", "roleId",
        "accountStatus", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        'owner-1', 'cmp-e1', 'owner-e1@example.test', 'owner-e1@example.test', 'Owner', 'hash',
        'role-e1', 'active', 1, 1, NOW(), NOW()
      );
      INSERT INTO "CompanyOwnership" (
        "id", "companyId", "userId", "isPrimary", "status", "effectiveAt", "createdByUserId"
      ) VALUES (
        'own-e1', 'cmp-e1', 'owner-1', TRUE, 'active', NOW(), 'owner-1'
      );
      COMMIT;
    `);

    const service = new CredentialRecoveryService({
      prisma,
      crypto: { tokenPepper: TOKEN_PEPPER },
      environmentBinding: ENV_BINDING,
      targetStore: new PostgresRecoveryTargetStore(),
      clock: () => new Date('2026-07-26T13:00:00.000Z'),
    });
    const issued = await service.issue({
      principalDomain: 'company_primary_owner',
      principalId: 'owner-1',
      companyId: 'cmp-e1',
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId: 'req-owner-1',
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const token = issued.value.deliverySecret!.reveal();

    expect((await service.withValidRecoveryRequest({
      rawToken: token,
      principalDomain: 'company_primary_owner',
      purpose: 'mfa_recovery',
      expectedCompanyId: 'cmp-e1',
      requestId: 'req-wrong-purpose',
      now: new Date('2026-07-26T13:01:00.000Z'),
    }, async () => null)).ok).toBe(false);

    expect((await service.withValidRecoveryRequest({
      rawToken: token,
      principalDomain: 'platform_principal',
      purpose: 'password_reset',
      requestId: 'req-wrong-domain',
      now: new Date('2026-07-26T13:01:00.000Z'),
    }, async () => null)).ok).toBe(false);

    expect((await service.withValidRecoveryRequest({
      rawToken: token,
      principalDomain: 'company_primary_owner',
      purpose: 'password_reset',
      expectedCompanyId: 'other-company',
      requestId: 'req-wrong-company',
      now: new Date('2026-07-26T13:01:00.000Z'),
    }, async () => null)).ok).toBe(false);

    const otherEnv = new CredentialRecoveryService({
      prisma,
      crypto: { tokenPepper: TOKEN_PEPPER },
      environmentBinding: 'staging:other-fingerprint',
      targetStore: new PostgresRecoveryTargetStore(),
    });
    expect((await otherEnv.withValidRecoveryRequest({
      rawToken: token,
      principalDomain: 'company_primary_owner',
      purpose: 'password_reset',
      expectedCompanyId: 'cmp-e1',
      requestId: 'req-wrong-env',
      now: new Date('2026-07-26T13:01:00.000Z'),
    }, async () => null)).ok).toBe(false);

    await prisma.user.update({
      where: { id: 'owner-1' },
      data: { credentialVersion: 2 },
    });
    expect(await service.withValidRecoveryRequest({
      rawToken: token,
      principalDomain: 'company_primary_owner',
      purpose: 'password_reset',
      expectedCompanyId: 'cmp-e1',
      requestId: 'req-version',
      now: new Date('2026-07-26T13:01:00.000Z'),
    }, async () => null)).toMatchObject({
      ok: false,
      reason: 'credential_version_mismatch',
    });
  }, 60_000);

  it('leaves exactly one active request and one successful consume under concurrency', async () => {
    insertPlatformPrincipal('prin-race', 1);
    const now = new Date('2026-07-26T14:00:00.000Z');
    const service = platformService(() => now);

    const [a, b] = await Promise.all([
      service.issue({
        principalDomain: 'platform_principal',
        principalId: 'prin-race',
        purpose: 'password_reset',
        initiatedBy: 'self',
        deliveryChannel: 'email',
        requestId: 'req-race-a',
        now,
      }),
      service.issue({
        principalDomain: 'platform_principal',
        principalId: 'prin-race',
        purpose: 'password_reset',
        initiatedBy: 'self',
        deliveryChannel: 'email',
        requestId: 'req-race-b',
        now,
      }),
    ]);
    expect([a.ok, b.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(await prisma.credentialRecoveryRequest.count({
      where: {
        principalId: 'prin-race',
        purpose: 'password_reset',
        consumedAt: null,
        invalidatedAt: null,
      },
    })).toBe(1);

    const live = await prisma.credentialRecoveryRequest.findFirstOrThrow({
      where: {
        principalId: 'prin-race',
        purpose: 'password_reset',
        consumedAt: null,
        invalidatedAt: null,
      },
    });
    const winner = (a.ok && a.value.recoveryRequestId === live.id)
      ? a
      : (b.ok && b.value.recoveryRequestId === live.id)
        ? b
        : null;
    expect(winner?.ok).toBe(true);
    if (!winner || !winner.ok || !winner.value.deliverySecret) return;

    const token = winner.value.deliverySecret.reveal();
    const [c1, c2] = await Promise.all([
      service.withValidRecoveryRequest({
        rawToken: token,
        principalDomain: 'platform_principal',
        purpose: 'password_reset',
        requestId: 'req-race-c1',
        now: new Date('2026-07-26T14:01:00.000Z'),
      }, async () => 'one'),
      service.withValidRecoveryRequest({
        rawToken: token,
        principalDomain: 'platform_principal',
        purpose: 'password_reset',
        requestId: 'req-race-c2',
        now: new Date('2026-07-26T14:01:00.000Z'),
      }, async () => 'two'),
    ]);
    expect([c1.ok, c2.ok].filter(Boolean)).toHaveLength(1);
  }, 60_000);

  it('cross-purpose consume race: exactly one effect and one credentialVersion bump', async () => {
    insertPlatformPrincipal('prin-cross', 7);
    const service = platformService(() => new Date('2026-07-26T14:30:00.000Z'));
    const passwordIssue = await service.issue({
      principalDomain: 'platform_principal',
      principalId: 'prin-cross',
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId: 'req-cross-pw',
    });
    const mfaIssue = await service.issue({
      principalDomain: 'platform_principal',
      principalId: 'prin-cross',
      purpose: 'mfa_recovery',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId: 'req-cross-mfa',
    });
    expect(passwordIssue.ok && mfaIssue.ok).toBe(true);
    if (!passwordIssue.ok || !mfaIssue.ok) return;

    let passwordEffect = 0;
    let mfaEffect = 0;
    const [pw, mfa] = await Promise.all([
      service.withValidRecoveryRequest({
        rawToken: passwordIssue.value.deliverySecret!,
        principalDomain: 'platform_principal',
        purpose: 'password_reset',
        requestId: 'req-cross-pw-c',
        now: new Date('2026-07-26T14:31:00.000Z'),
      }, async () => {
        passwordEffect += 1;
        return 'password';
      }),
      service.withValidRecoveryRequest({
        rawToken: mfaIssue.value.deliverySecret!,
        principalDomain: 'platform_principal',
        purpose: 'mfa_recovery',
        requestId: 'req-cross-mfa-c',
        now: new Date('2026-07-26T14:31:00.000Z'),
      }, async () => {
        mfaEffect += 1;
        return 'mfa';
      }),
    ]);

    expect([pw.ok, mfa.ok].filter(Boolean)).toHaveLength(1);
    expect(passwordEffect + mfaEffect).toBe(1);
    const loser = pw.ok ? mfa : pw;
    expect(loser).toMatchObject({ ok: false, reason: 'credential_version_mismatch' });
    expect(await prisma.platformPrincipal.findUniqueOrThrow({ where: { id: 'prin-cross' } }))
      .toMatchObject({ credentialVersion: 8 });
  }, 60_000);

  it('external credentialVersion change refuses consume before the effect', async () => {
    insertPlatformPrincipal('prin-ext', 1);
    const service = platformService(() => new Date('2026-07-26T14:40:00.000Z'));
    const issued = await service.issue({
      principalDomain: 'platform_principal',
      principalId: 'prin-ext',
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId: 'req-ext-issue',
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    await prisma.platformPrincipal.update({
      where: { id: 'prin-ext' },
      data: { credentialVersion: 2 },
    });

    let effectRan = false;
    const result = await service.withValidRecoveryRequest({
      rawToken: issued.value.deliverySecret!,
      principalDomain: 'platform_principal',
      purpose: 'password_reset',
      requestId: 'req-ext-consume',
      now: new Date('2026-07-26T14:41:00.000Z'),
    }, async () => {
      effectRan = true;
      return 'nope';
    });
    expect(result).toMatchObject({ ok: false, reason: 'credential_version_mismatch' });
    expect(effectRan).toBe(false);
    const row = await prisma.credentialRecoveryRequest.findUniqueOrThrow({
      where: { id: issued.value.recoveryRequestId },
    });
    expect(row.consumedAt).toBeNull();
  }, 60_000);

  it('rolls back credentialVersion, consumption, and success audit when the effect throws', async () => {
    insertPlatformPrincipal('prin-rollback', 1);
    const service = platformService(() => new Date('2026-07-26T15:00:00.000Z'));
    const issued = await service.issue({
      principalDomain: 'platform_principal',
      principalId: 'prin-rollback',
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId: 'req-rollback-issue',
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok || !issued.value.deliverySecret) return;

    expect(await service.withValidRecoveryRequest({
      rawToken: issued.value.deliverySecret,
      principalDomain: 'platform_principal',
      purpose: 'password_reset',
      requestId: 'req-rollback-consume',
      now: new Date('2026-07-26T15:01:00.000Z'),
    }, async () => {
      throw new Error('simulated effect failure');
    })).toMatchObject({ ok: false, reason: 'callback_failed' });

    const row = await prisma.credentialRecoveryRequest.findUniqueOrThrow({
      where: { id: issued.value.recoveryRequestId },
    });
    expect(row.consumedAt).toBeNull();
    expect(row.invalidatedAt).toBeNull();
    expect(await prisma.platformPrincipal.findUniqueOrThrow({ where: { id: 'prin-rollback' } }))
      .toMatchObject({ credentialVersion: 1 });
    expect(await prisma.credentialRecoveryAuditEvent.count({
      where: {
        recoveryRequestId: issued.value.recoveryRequestId,
        eventType: 'recovery_request_consumed',
      },
    })).toBe(0);
  }, 60_000);

  it('issuance snapshots credentialVersion inside the transaction, not a stale pre-read', async () => {
    insertPlatformPrincipal('prin-issue-race', 1);
    const targetStore = new PostgresRecoveryTargetStore();
    const service = new CredentialRecoveryService({
      prisma,
      crypto: { tokenPepper: TOKEN_PEPPER },
      environmentBinding: ENV_BINDING,
      targetStore,
      clock: () => new Date('2026-07-26T15:10:00.000Z'),
    });

    const issuePromise = service.issue({
      principalDomain: 'platform_principal',
      principalId: 'prin-issue-race',
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId: 'req-issue-race',
    });
    await prisma.platformPrincipal.update({
      where: { id: 'prin-issue-race' },
      data: { credentialVersion: 5 },
    });
    const issued = await issuePromise;
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    // Whatever version the issue transaction locked must match the stored snapshot.
    const row = await prisma.credentialRecoveryRequest.findUniqueOrThrow({
      where: { id: issued.value.recoveryRequestId },
    });
    expect(row.credentialVersionAtIssuance).toBe(issued.value.credentialVersionAtIssuance);
    expect([1, 5]).toContain(row.credentialVersionAtIssuance);
  }, 60_000);

  it('unknown-token audit never writes caller company scope (FK-safe)', async () => {
    const service = platformService(() => new Date('2026-07-26T15:20:00.000Z'));
    const result = await service.withValidRecoveryRequest({
      rawToken: 'not-a-real-token-value-at-all-xxxxxxxxxx',
      principalDomain: 'platform_principal',
      purpose: 'password_reset',
      expectedCompanyId: '00000000-0000-4000-8000-000000000099',
      requestId: 'req-unknown-token',
      now: new Date('2026-07-26T15:20:00.000Z'),
    }, async () => {
      throw new Error('callback must not run');
    });
    expect(result).toMatchObject({ ok: false, reason: 'token_invalid' });

    const audit = await prisma.credentialRecoveryAuditEvent.findFirstOrThrow({
      where: { requestId: 'req-unknown-token' },
      orderBy: { timestamp: 'desc' },
    });
    expect(audit.companyId).toBeNull();
    expect(audit.subjectId).toBeNull();
    expect(audit.subjectDomain).toBe('unresolved');
  }, 30_000);

  it('company-bound token works without expectedCompanyId; wrong assertion rejects without callback', async () => {
    const service = new CredentialRecoveryService({
      prisma,
      crypto: { tokenPepper: TOKEN_PEPPER },
      environmentBinding: ENV_BINDING,
      targetStore: new PostgresRecoveryTargetStore(),
      clock: () => new Date('2026-07-26T15:25:00.000Z'),
    });
    // Reset owner version after earlier mismatch invalidation path.
    await prisma.user.update({ where: { id: 'owner-1' }, data: { credentialVersion: 10 } });
    const issued = await service.issue({
      principalDomain: 'company_primary_owner',
      principalId: 'owner-1',
      companyId: 'cmp-e1',
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId: 'req-owner-self',
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    let wrongCallback = false;
    expect(await service.withValidRecoveryRequest({
      rawToken: issued.value.deliverySecret!,
      principalDomain: 'company_primary_owner',
      purpose: 'password_reset',
      expectedCompanyId: 'cmp-other',
      requestId: 'req-owner-wrong-assert',
      now: new Date('2026-07-26T15:26:00.000Z'),
    }, async () => {
      wrongCallback = true;
      return null;
    })).toMatchObject({ ok: false, reason: 'company_mismatch' });
    expect(wrongCallback).toBe(false);

    const ok = await service.withValidRecoveryRequest({
      rawToken: issued.value.deliverySecret!,
      principalDomain: 'company_primary_owner',
      purpose: 'password_reset',
      requestId: 'req-owner-no-company',
      now: new Date('2026-07-26T15:26:00.000Z'),
    }, async () => 'ok');
    expect(ok.ok).toBe(true);
  }, 60_000);

  it('rejects at exact TTL boundary via server-owned TTL config and uses durable hashed rate-limit buckets', async () => {
    insertPlatformPrincipal('prin-ttl', 1);
    const issuedAt = new Date('2026-07-26T16:00:00.000Z');
    const service = platformService(() => issuedAt, { password_reset: 60 });
    const issued = await service.issue({
      principalDomain: 'platform_principal',
      principalId: 'prin-ttl',
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId: 'req-ttl',
      now: issuedAt,
      sourceBucketHash: createSourceBucketHash('10.0.0.9', RATE_PEPPER),
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok || !issued.value.deliverySecret) return;
    expect(issued.value.expiresAt.getTime() - issuedAt.getTime()).toBe(60_000);

    expect((await service.withValidRecoveryRequest({
      rawToken: issued.value.deliverySecret,
      principalDomain: 'platform_principal',
      purpose: 'password_reset',
      requestId: 'req-ttl-expire',
      now: new Date(issuedAt.getTime() + 60_000),
    }, async () => 'late')).ok).toBe(false);

    const limiter = new RecoveryRateLimiter(
      new PostgresRecoveryRateLimitStore(prisma),
      RATE_PEPPER,
      {
        ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
        platform_password_reset_initiate: {
          target: { windowMs: 60_000, blockLimit: 1, alertLimit: 1 },
        },
      },
      () => new Date('2026-07-26T16:05:00.000Z'),
    );
    expect((await limiter.check({
      surface: 'platform_password_reset_initiate',
      dimension: 'target',
      rawKey: 'ttl-target',
    })).allowed).toBe(true);
    expect((await limiter.check({
      surface: 'platform_password_reset_initiate',
      dimension: 'target',
      rawKey: 'ttl-target',
    })).allowed).toBe(false);

    const bucket = await prisma.credentialRecoveryRateLimitBucket.findFirst({
      where: { surface: 'platform_password_reset_initiate', dimension: 'target' },
    });
    expect(bucket?.bucketKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bucket?.bucketKeyHash).not.toContain('ttl-target');
  }, 60_000);

  it('atomic rate-limit upsert survives concurrent first-bucket creates without P2002', async () => {
    const now = new Date('2026-07-26T16:10:00.000Z');
    const clientA = new PrismaClient({ datasources: { db: { url: urlFor(databaseName) } } });
    const clientB = new PrismaClient({ datasources: { db: { url: urlFor(databaseName) } } });
    try {
      const limiterA = new RecoveryRateLimiter(
        new PostgresRecoveryRateLimitStore(clientA),
        RATE_PEPPER,
        {
          ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
          platform_password_reset_initiate: {
            source: { windowMs: 60_000, blockLimit: 10, alertLimit: 5 },
          },
        },
        () => now,
      );
      const limiterB = new RecoveryRateLimiter(
        new PostgresRecoveryRateLimitStore(clientB),
        RATE_PEPPER,
        {
          ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
          platform_password_reset_initiate: {
            source: { windowMs: 60_000, blockLimit: 10, alertLimit: 5 },
          },
        },
        () => now,
      );

      const calls = Array.from({ length: 24 }, (_, i) =>
        (i % 2 === 0 ? limiterA : limiterB).check({
          surface: 'platform_password_reset_initiate',
          dimension: 'source',
          rawKey: 'concurrent-first-bucket',
          now,
        }),
      );
      const decisions = await Promise.all(calls);
      expect(decisions).toHaveLength(24);
      expect(decisions.every((d) => d.allowed === true || d.reason === 'rate_limited')).toBe(true);
      expect(decisions.filter((d) => d.allowed).length).toBe(10);
      expect(decisions.filter((d) => !d.allowed).length).toBe(14);

      const buckets = await prisma.credentialRecoveryRateLimitBucket.findMany({
        where: {
          surface: 'platform_password_reset_initiate',
          dimension: 'source',
        },
      });
      const matching = buckets.filter((b) => b.count === 24 || b.windowStartedAt.getTime() === Math.floor(now.getTime() / 60_000) * 60_000);
      expect(matching.length).toBeGreaterThanOrEqual(1);
      const firstBucket = buckets.find((b) => b.count >= 20);
      expect(firstBucket?.count).toBe(24);

      const other = await limiterA.check({
        surface: 'platform_account_discovery',
        dimension: 'source',
        rawKey: 'concurrent-first-bucket',
        now,
      });
      expect(other.allowed).toBe(true);
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  }, 60_000);

  it('test-only MapRecoveryTargetResolver still works for isolated unit paths', async () => {
    const resolver = new MapRecoveryTargetResolver(new Map());
    resolver.set({
      principalDomain: 'platform_principal',
      principalId: 'map-only',
      companyId: null,
      credentialVersion: 1,
    });
    const service = new CredentialRecoveryService({
      prisma,
      crypto: { tokenPepper: TOKEN_PEPPER },
      environmentBinding: ENV_BINDING,
      targetStore: resolver,
      clock: () => new Date('2026-07-26T17:00:00.000Z'),
    });
    const issued = await service.issue({
      principalDomain: 'platform_principal',
      principalId: 'map-only',
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId: 'req-map-only',
    });
    expect(issued.ok).toBe(true);
  }, 30_000);

  it('enforces recovery audit actor consistency without leaking DB/check errors', async () => {
    insertPlatformPrincipal('prin-actor', 1);
    const service = platformService(() => new Date('2026-07-26T17:30:00.000Z'));

    const beforeVersion = (
      await prisma.platformPrincipal.findUniqueOrThrow({ where: { id: 'prin-actor' } })
    ).credentialVersion;
    const beforeRequests = await prisma.credentialRecoveryRequest.count({
      where: { principalId: 'prin-actor' },
    });
    const beforeAudits = await prisma.credentialRecoveryAuditEvent.count({
      where: { requestId: { startsWith: 'req-actor-' } },
    });

    let effectRan = false;
    const malformed = await service.withValidRecoveryRequest({
      rawToken: 'unknown-token-for-actor-check-xxxxxxxx',
      principalDomain: 'platform_principal',
      purpose: 'password_reset',
      requestId: 'req-actor-malformed',
      actorId: 'orphan-actor-id',
    }, async () => {
      effectRan = true;
      return 'no';
    });
    expect(malformed).toMatchObject({ ok: false, reason: 'audit_rejected' });
    expect(malformed).not.toMatchObject({ reason: 'concurrent_conflict' });
    expect(effectRan).toBe(false);
    expect(await prisma.credentialRecoveryAuditEvent.count({
      where: { requestId: 'req-actor-malformed' },
    })).toBe(0);
    expect(await prisma.platformPrincipal.findUniqueOrThrow({ where: { id: 'prin-actor' } }))
      .toMatchObject({ credentialVersion: beforeVersion });
    expect(await prisma.credentialRecoveryRequest.count({
      where: { principalId: 'prin-actor' },
    })).toBe(beforeRequests);

    const anonymousUnknown = await service.withValidRecoveryRequest({
      rawToken: 'another-unknown-token-yyyyyyyyyyyyyy',
      principalDomain: 'platform_principal',
      purpose: 'password_reset',
      requestId: 'req-actor-anonymous-ok',
      actorType: 'anonymous',
      actorId: null,
    }, async () => 'no');
    expect(anonymousUnknown).toMatchObject({ ok: false, reason: 'token_invalid' });
    const anonymousAudit = await prisma.credentialRecoveryAuditEvent.findFirstOrThrow({
      where: { requestId: 'req-actor-anonymous-ok' },
    });
    expect(anonymousAudit.actorType).toBe('anonymous');
    expect(anonymousAudit.actorId).toBeNull();

    const issued = await service.issue({
      principalDomain: 'platform_principal',
      principalId: 'prin-actor',
      purpose: 'password_reset',
      initiatedBy: 'platform_operator',
      deliveryChannel: 'email',
      requestId: 'req-actor-auth-issue',
      actorType: 'platform_owner',
      actorId: 'platform-actor-1',
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok || !issued.value.deliverySecret) return;

    const issuedAudit = await prisma.credentialRecoveryAuditEvent.findFirstOrThrow({
      where: { requestId: 'req-actor-auth-issue', eventType: 'recovery_request_issued' },
    });
    expect(issuedAudit.actorType).toBe('platform_owner');
    expect(issuedAudit.actorId).toBe('platform-actor-1');

    const consumed = await service.withValidRecoveryRequest({
      rawToken: issued.value.deliverySecret,
      principalDomain: 'platform_principal',
      purpose: 'password_reset',
      requestId: 'req-actor-auth-consume',
      actorType: 'platform_owner',
      actorId: 'platform-actor-1',
      now: new Date('2026-07-26T17:31:00.000Z'),
    }, async () => 'ok');
    expect(consumed.ok).toBe(true);
    const consumedAudit = await prisma.credentialRecoveryAuditEvent.findFirstOrThrow({
      where: { requestId: 'req-actor-auth-consume', eventType: 'recovery_request_consumed' },
    });
    expect(consumedAudit.actorType).toBe('platform_owner');
    expect(consumedAudit.actorId).toBe('platform-actor-1');

    expect(await prisma.credentialRecoveryAuditEvent.count({
      where: { requestId: { startsWith: 'req-actor-' } },
    })).toBeGreaterThan(beforeAudits);
  }, 60_000);
});
