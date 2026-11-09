import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import bcrypt from 'bcrypt';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import {
  CapturingRecoveryDeliveryAdapter,
  CredentialRecoveryService,
  PostgresRecoveryTargetStore,
} from '../src/credentialRecovery';
import {
  confirmPlatformPasswordRecovery,
  deliverPlatformPasswordRecovery,
} from '../src/platformPrincipalRecovery';
import { confirmOwnerPasswordRecovery } from '../src/companyOwnerRecovery';

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
const allMigrationNames = readdirSync(migrationsRoot)
  .filter((name) => {
    if (name.startsWith('.') || name === 'migration_lock.toml') return false;
    return statSync(join(migrationsRoot, name)).isDirectory();
  })
  .sort();
const hasDisposablePostgres = Boolean(initdb && pgCtl && createdb && psql && existsSync(prismaCli));
const suite = hasDisposablePostgres ? describe : describe.skip;

const TOKEN_PEPPER = 'e4-test-recovery-token-pepper-32chars-min';
const ENV_BINDING = 'test:e4-fixture-fp';
const PRINCIPAL_ID = 'pp-e4-pg';
const OTHER_PRINCIPAL_ID = 'pp-e4-other-pg';
const PLATFORM_EMAIL = 'platform-e4@example.test';
const COMPANY_ID = 'cmp-e4-pg';
const OWNER_ID = 'owner-e4-pg';
const ROLE_ID = 'role-e4-pg';

suite('platform principal recovery E4 on disposable PostgreSQL', () => {
  const databaseUser = 'mawared_e4';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let port = 0;
  let prisma: PrismaClient;
  let prismaRoot = '';
  const databaseName = 'mawared_platform_recovery_e4';

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
      workDirectory
      && dirname(workDirectory) === tmpdir()
      && basename(workDirectory).startsWith('mawared-platform-recovery-e4-pg-')
    ) {
      try {
        rmSync(workDirectory, { recursive: true, force: true });
      } catch {
        // Windows may briefly lock PG files after stop.
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

  const platformService = (clock?: () => Date) => new CredentialRecoveryService({
    prisma,
    crypto: { tokenPepper: TOKEN_PEPPER },
    environmentBinding: ENV_BINDING,
    targetStore: new PostgresRecoveryTargetStore(),
    clock: clock ?? (() => new Date('2026-07-30T12:00:00.000Z')),
  });

  const seedPlatformFixture = (passwordHash: string) => {
    executeSql(`
      BEGIN;
      INSERT INTO "PlatformPrincipal" (
        "id", "email", "normalizedEmail", "password", "name", "status",
        "permissions", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        '${PRINCIPAL_ID}', '${PLATFORM_EMAIL}', '${PLATFORM_EMAIL}', '${passwordHash}', 'Platform E4',
        'active', '["platform.companies.view"]', 5, 3, NOW(), NOW()
      )
      ON CONFLICT ("id") DO UPDATE SET
        "password" = EXCLUDED."password",
        "credentialVersion" = EXCLUDED."credentialVersion",
        "authorizationVersion" = EXCLUDED."authorizationVersion",
        "permissions" = EXCLUDED."permissions",
        status = 'active';
      INSERT INTO "PlatformPrincipal" (
        "id", "email", "normalizedEmail", "password", "name", "status",
        "permissions", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        '${OTHER_PRINCIPAL_ID}', 'other-e4@example.test', 'other-e4@example.test', '${passwordHash}', 'Other',
        'active', '[]', 1, 1, NOW(), NOW()
      )
      ON CONFLICT ("id") DO NOTHING;
      INSERT INTO "PlatformMfaCredential" (
        "principalId", "state", "secretCiphertext", "pendingSecretCiphertext", "backupCodeHashes",
        "failedAttempts", "challengeAttempts", "enrolledAt", "lastVerifiedAt", "lastUsedTimeStep",
        "lockedUntil", "createdAt", "updatedAt"
      ) VALUES (
        '${PRINCIPAL_ID}', 'enrolled', 'cipher-e4', NULL, '["bc-a","bc-b"]',
        0, 0, NOW(), NOW(), 99, NULL, NOW(), NOW()
      )
      ON CONFLICT ("principalId") DO UPDATE SET
        state = 'enrolled',
        "secretCiphertext" = 'cipher-e4',
        "pendingSecretCiphertext" = NULL,
        "backupCodeHashes" = '["bc-a","bc-b"]',
        "failedAttempts" = 0,
        "lockedUntil" = NULL,
        "lastUsedTimeStep" = 99;
      INSERT INTO "PlatformRefreshToken" (
        "id", "sessionId", "principalId", "tokenHash", "expiresAt",
        "credentialVersion", "mfaVerifiedAt", "createdAt"
      ) VALUES (
        'prt-e4-1', 'sess-e4-1', '${PRINCIPAL_ID}', 'hash-prt-e4-1',
        NOW() + interval '7 days', 3, NOW(), NOW()
      )
      ON CONFLICT ("id") DO UPDATE SET "revokedAt" = NULL, "revokedReason" = NULL, "credentialVersion" = 3;
      INSERT INTO "PlatformRefreshToken" (
        "id", "sessionId", "principalId", "tokenHash", "expiresAt",
        "credentialVersion", "mfaVerifiedAt", "createdAt"
      ) VALUES (
        'prt-e4-other', 'sess-e4-other', '${OTHER_PRINCIPAL_ID}', 'hash-prt-e4-other',
        NOW() + interval '7 days', 1, NOW(), NOW()
      )
      ON CONFLICT ("id") DO UPDATE SET "revokedAt" = NULL, "revokedReason" = NULL;
      COMMIT;
    `);
  };

  const resetPlatformRecoveryRequests = () => {
    // Use GREATEST(createdAt, NOW()) so deterministic future clocks still satisfy
    // CredentialRecoveryRequest_lifecycle_check (invalidatedAt >= createdAt).
    executeSql(`
      UPDATE "CredentialRecoveryRequest"
      SET
        "invalidatedAt" = GREATEST("createdAt", NOW()),
        "invalidationReason" = 'security_event'
      WHERE "principalDomain" = 'platform_principal'
        AND "principalId" = '${PRINCIPAL_ID}'
        AND "consumedAt" IS NULL
        AND "invalidatedAt" IS NULL;
    `);
  };

  const issuePlatformRecovery = async (requestId: string, service = platformService()) => {
    const issued = await service.issue({
      principalDomain: 'platform_principal',
      principalId: PRINCIPAL_ID,
      companyId: null,
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId,
    });
    expect(issued.ok).toBe(true);
    return issued;
  };

  beforeAll(async () => {
    workDirectory = mkdtempSync(join(tmpdir(), 'mawared-platform-recovery-e4-pg-'));
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
      join(migrationsRoot, 'migration_lock.toml'),
      join(prismaRoot, 'migrations', 'migration_lock.toml'),
    );
    for (const name of allMigrationNames) {
      cpSync(join(migrationsRoot, name), join(prismaRoot, 'migrations', name), { recursive: true });
    }
    deploy(databaseName);
    prisma = new PrismaClient({ datasources: { db: { url: urlFor(databaseName) } } });
  }, 300_000);

  afterAll(stopAndClean, 60_000);

  it('issues and confirms Platform recovery with session revoke + MFA preservation', async () => {
    const oldHash = await bcrypt.hash('OldPlatformPass-123!', 4);
    seedPlatformFixture(oldHash);
    const service = platformService(() => new Date('2026-07-30T12:00:00.000Z'));
    const issued = await issuePlatformRecovery('req-e4-issue-1', service);
    if (!issued.ok || !issued.value.deliverySecret) return;
    const token = issued.value.deliverySecret.reveal();

    const mfaBefore = await prisma.platformMfaCredential.findUniqueOrThrow({
      where: { principalId: PRINCIPAL_ID },
    });
    const principalBefore = await prisma.platformPrincipal.findUniqueOrThrow({
      where: { id: PRINCIPAL_ID },
    });

    await confirmPlatformPasswordRecovery({
      service,
      prisma,
      resetToken: token,
      newPassword: 'NewPlatformPass-456!',
      requestId: 'req-e4-confirm-1',
    });

    const principalAfter = await prisma.platformPrincipal.findUniqueOrThrow({
      where: { id: PRINCIPAL_ID },
    });
    expect(principalAfter.credentialVersion).toBe(4);
    expect(await bcrypt.compare('NewPlatformPass-456!', principalAfter.password)).toBe(true);
    expect(principalAfter.authorizationVersion).toBe(principalBefore.authorizationVersion);
    expect(principalAfter.permissions).toBe(principalBefore.permissions);
    expect(principalAfter.status).toBe('active');

    const ownSessions = await prisma.platformRefreshToken.findMany({
      where: { principalId: PRINCIPAL_ID },
    });
    expect(ownSessions.every((row) =>
      row.revokedAt != null && row.revokedReason === 'platform_password_recovery')).toBe(true);

    const otherSessions = await prisma.platformRefreshToken.findMany({
      where: { principalId: OTHER_PRINCIPAL_ID },
    });
    expect(otherSessions.every((row) => row.revokedAt == null)).toBe(true);

    const mfaAfter = await prisma.platformMfaCredential.findUniqueOrThrow({
      where: { principalId: PRINCIPAL_ID },
    });
    expect(mfaAfter.state).toBe(mfaBefore.state);
    expect(mfaAfter.secretCiphertext).toBe(mfaBefore.secretCiphertext);
    expect(mfaAfter.pendingSecretCiphertext).toBe(mfaBefore.pendingSecretCiphertext);
    expect(mfaAfter.backupCodeHashes).toBe(mfaBefore.backupCodeHashes);
    expect(mfaAfter.lastUsedTimeStep).toBe(mfaBefore.lastUsedTimeStep);
    expect(mfaAfter.failedAttempts).toBe(mfaBefore.failedAttempts);
    expect(mfaAfter.lockedUntil).toEqual(mfaBefore.lockedUntil);
    expect(mfaAfter.challengeTokenHash).toBeNull();
    expect(mfaAfter.challengePurpose).toBeNull();
    expect(mfaAfter.challengeExpiresAt).toBeNull();
    expect(mfaAfter.challengeAttempts).toBe(0);

    const audits = await prisma.platformAuditLog.findMany({
      where: {
        principalId: PRINCIPAL_ID,
        action: 'platform.auth.password_recovery.completed',
      },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audits)).not.toContain(PLATFORM_EMAIL);
    expect(JSON.stringify(audits)).not.toContain(token);
  }, 60_000);

  it('allows exactly one successful concurrent confirm', async () => {
    const oldHash = await bcrypt.hash('ConcurrentOld-123!', 4);
    resetPlatformRecoveryRequests();
    seedPlatformFixture(oldHash);
    const service = platformService(() => new Date('2026-07-30T12:30:00.000Z'));
    const issued = await issuePlatformRecovery('req-e4-concurrent-issue', service);
    if (!issued.ok || !issued.value.deliverySecret) return;
    const token = issued.value.deliverySecret.reveal();

    const attempts = Array.from({ length: 10 }, (_, index) =>
      confirmPlatformPasswordRecovery({
        service,
        prisma,
        resetToken: token,
        newPassword: `ConcurrentNew-${index}ab!`,
        requestId: `req-e4-concurrent-${index}`,
      }).then(() => 'ok').catch(() => 'fail'),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((value) => value === 'ok')).toHaveLength(1);
    expect(results.filter((value) => value === 'fail')).toHaveLength(9);

    const principal = await prisma.platformPrincipal.findUniqueOrThrow({
      where: { id: PRINCIPAL_ID },
    });
    expect(principal.credentialVersion).toBe(4);
    expect(await prisma.credentialRecoveryRequest.count({
      where: { id: issued.value.recoveryRequestId, consumedAt: { not: null } },
    })).toBe(1);
  }, 60_000);

  it('supersedes older tokens and rejects expired/disabled/credential-version races', async () => {
    const oldHash = await bcrypt.hash('SupersedeOld-123!', 4);
    resetPlatformRecoveryRequests();
    seedPlatformFixture(oldHash);
    const service = platformService(() => new Date('2026-07-30T13:00:00.000Z'));
    const first = await issuePlatformRecovery('req-e4-super-1', service);
    if (!first.ok || !first.value.deliverySecret) return;
    const firstToken = first.value.deliverySecret.reveal();

    const second = await issuePlatformRecovery('req-e4-super-2', service);
    if (!second.ok || !second.value.deliverySecret) return;
    const secondToken = second.value.deliverySecret.reveal();

    await expect(confirmPlatformPasswordRecovery({
      service,
      prisma,
      resetToken: firstToken,
      newPassword: 'SupersededShouldFail-1!',
      requestId: 'req-e4-super-old',
    })).rejects.toMatchObject({
      messageKey: 'platform.recovery.invalid_or_expired',
    });

    await confirmPlatformPasswordRecovery({
      service,
      prisma,
      resetToken: secondToken,
      newPassword: 'NewestTokenWins-456!',
      requestId: 'req-e4-super-new',
    });

    // Credential-version fence: issue then bump credentialVersion outside recovery.
    resetPlatformRecoveryRequests();
    seedPlatformFixture(await bcrypt.hash('VersionFence-123!', 4));
    const versionClock = platformService(() => new Date('2026-07-30T13:30:00.000Z'));
    const versionIssued = await issuePlatformRecovery('req-e4-version', versionClock);
    if (!versionIssued.ok || !versionIssued.value.deliverySecret) return;
    executeSql(`
      UPDATE "PlatformPrincipal"
      SET "credentialVersion" = "credentialVersion" + 1
      WHERE id = '${PRINCIPAL_ID}';
    `);
    await expect(confirmPlatformPasswordRecovery({
      service: versionClock,
      prisma,
      resetToken: versionIssued.value.deliverySecret.reveal(),
      newPassword: 'ShouldNotApply-789!',
      requestId: 'req-e4-version-confirm',
    })).rejects.toMatchObject({
      messageKey: 'platform.recovery.invalid_or_expired',
    });

    // Disabled principal after issuance.
    resetPlatformRecoveryRequests();
    seedPlatformFixture(await bcrypt.hash('DisabledFence-123!', 4));
    const disabledService = platformService(() => new Date('2026-07-30T14:00:00.000Z'));
    const disabledIssued = await issuePlatformRecovery('req-e4-disabled', disabledService);
    if (!disabledIssued.ok || !disabledIssued.value.deliverySecret) return;
    executeSql(`UPDATE "PlatformPrincipal" SET status = 'disabled' WHERE id = '${PRINCIPAL_ID}';`);
    await expect(confirmPlatformPasswordRecovery({
      service: disabledService,
      prisma,
      resetToken: disabledIssued.value.deliverySecret.reveal(),
      newPassword: 'ShouldNotApply-Disabled!',
      requestId: 'req-e4-disabled-confirm',
    })).rejects.toMatchObject({
      messageKey: 'platform.recovery.invalid_or_expired',
    });
    const stillDisabled = await prisma.platformPrincipal.findUniqueOrThrow({
      where: { id: PRINCIPAL_ID },
    });
    expect(await bcrypt.compare('DisabledFence-123!', stillDisabled.password)).toBe(true);
  }, 90_000);

  it('rejects TTL-expired tokens and cross-domain company-owner tokens', async () => {
    const oldHash = await bcrypt.hash('TtlOld-123!', 4);
    resetPlatformRecoveryRequests();
    seedPlatformFixture(oldHash);
    let now = new Date('2026-07-30T15:00:00.000Z');
    const service = platformService(() => now);
    const issued = await issuePlatformRecovery('req-e4-ttl', service);
    if (!issued.ok || !issued.value.deliverySecret) return;
    now = new Date('2026-07-30T15:16:00.000Z');
    await expect(confirmPlatformPasswordRecovery({
      service,
      prisma,
      resetToken: issued.value.deliverySecret.reveal(),
      newPassword: 'ExpiredShouldFail-1!',
      requestId: 'req-e4-ttl-confirm',
    })).rejects.toMatchObject({
      messageKey: 'platform.recovery.invalid_or_expired',
    });

    // Cross-domain: company owner token cannot reset Platform Principal.
    executeSql(`
      BEGIN;
      INSERT INTO "Company" ("id", "code", "name", "createdAt", "updatedAt")
      VALUES ('${COMPANY_ID}', 'CMP-E4-PG', 'E4 PG Co', NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING;
      INSERT INTO "Role" ("id", "companyId", "name", "permissions", "createdAt", "updatedAt")
      VALUES ('${ROLE_ID}', '${COMPANY_ID}', 'Admin', '["admin.full"]', NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING;
      INSERT INTO "User" (
        "id", "companyId", "email", "normalizedEmail", "name", "password", "roleId",
        "accountStatus", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        '${OWNER_ID}', '${COMPANY_ID}', 'owner-e4@example.test', 'owner-e4@example.test', 'Owner',
        '${oldHash}', '${ROLE_ID}', 'active', 1, 1, NOW(), NOW()
      )
      ON CONFLICT ("id") DO NOTHING;
      INSERT INTO "CompanyOwnership" (
        "id", "companyId", "userId", "isPrimary", "status", "effectiveAt", "createdByUserId"
      ) VALUES (
        'own-e4-pg', '${COMPANY_ID}', '${OWNER_ID}', TRUE, 'active', NOW(), '${OWNER_ID}'
      )
      ON CONFLICT ("id") DO NOTHING;
      COMMIT;
    `);
    now = new Date('2026-07-30T16:00:00.000Z');
    const ownerIssued = await service.issue({
      principalDomain: 'company_primary_owner',
      principalId: OWNER_ID,
      companyId: COMPANY_ID,
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId: 'req-e4-owner-cross',
    });
    expect(ownerIssued.ok).toBe(true);
    if (!ownerIssued.ok || !ownerIssued.value.deliverySecret) return;

    await expect(confirmPlatformPasswordRecovery({
      service,
      prisma,
      resetToken: ownerIssued.value.deliverySecret.reveal(),
      newPassword: 'CrossDomainShouldFail!',
      requestId: 'req-e4-cross-platform',
    })).rejects.toMatchObject({
      messageKey: 'platform.recovery.invalid_or_expired',
    });

    resetPlatformRecoveryRequests();
    seedPlatformFixture(oldHash);
    now = new Date('2026-07-30T16:30:00.000Z');
    const platformIssued = await issuePlatformRecovery('req-e4-plat-cross', service);
    if (!platformIssued.ok || !platformIssued.value.deliverySecret) return;
    await expect(confirmOwnerPasswordRecovery({
      service,
      prisma,
      resetToken: platformIssued.value.deliverySecret.reveal(),
      newPassword: 'CrossDomainShouldFail!',
      requestId: 'req-e4-cross-owner',
    })).rejects.toMatchObject({
      messageKey: 'owner_recovery.invalid_or_expired',
    });
  }, 90_000);

  it('revokes stale refresh under concurrent recovery and records safe delivery evidence', async () => {
    const oldHash = await bcrypt.hash('RefreshRace-123!', 4);
    resetPlatformRecoveryRequests();
    seedPlatformFixture(oldHash);
    const service = platformService(() => new Date('2026-07-30T17:00:00.000Z'));
    const issued = await issuePlatformRecovery('req-e4-refresh-race', service);
    if (!issued.ok || !issued.value.deliverySecret) return;

    const confirmPromise = confirmPlatformPasswordRecovery({
      service,
      prisma,
      resetToken: issued.value.deliverySecret.reveal(),
      newPassword: 'RefreshRaceNew-456!',
      requestId: 'req-e4-refresh-confirm',
    });
    const rotatePromise = prisma.platformRefreshToken.updateMany({
      where: { principalId: PRINCIPAL_ID, revokedAt: null },
      data: { revokedReason: 'rotated_attempt' },
    });
    await Promise.all([confirmPromise, rotatePromise]);

    const sessions = await prisma.platformRefreshToken.findMany({
      where: { principalId: PRINCIPAL_ID },
    });
    expect(sessions.every((row) => row.revokedAt != null)).toBe(true);
    const principal = await prisma.platformPrincipal.findUniqueOrThrow({
      where: { id: PRINCIPAL_ID },
    });
    expect(principal.credentialVersion).toBe(4);
    // Stale session credentialVersion cannot match post-reset principal.
    expect(sessions.every((row) => row.credentialVersion !== principal.credentialVersion)).toBe(true);

    resetPlatformRecoveryRequests();
    seedPlatformFixture(await bcrypt.hash('DeliveryOld-123!', 4));
    const deliveryService = platformService(() => new Date('2026-07-30T17:30:00.000Z'));
    const deliveryIssued = await issuePlatformRecovery('req-e4-delivery', deliveryService);
    if (!deliveryIssued.ok || !deliveryIssued.value.deliverySecret) return;
    const adapter = new CapturingRecoveryDeliveryAdapter();
    adapter.setNextStatus('dispatched');
    const status = await deliverPlatformPasswordRecovery({
      adapter,
      service: deliveryService,
      issued: {
        recoveryRequestId: deliveryIssued.value.recoveryRequestId,
        deliverySecret: deliveryIssued.value.deliverySecret,
        expiresAt: deliveryIssued.value.expiresAt,
      },
      recipientRef: `platform-email:${PRINCIPAL_ID}`,
      requestId: 'req-e4-delivery',
    });
    expect(status).toBe('dispatched');
    const row = await prisma.credentialRecoveryRequest.findUniqueOrThrow({
      where: { id: deliveryIssued.value.recoveryRequestId },
    });
    expect(row.deliveryStatus).toBe('dispatched');
    const token = adapter.consumeLastSecret();
    expect(token).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(token!);
    expect(JSON.stringify(await prisma.credentialRecoveryAuditEvent.findMany({
      where: { recoveryRequestId: deliveryIssued.value.recoveryRequestId },
    }))).not.toContain(PLATFORM_EMAIL);
  }, 90_000);

  it('keeps concurrent initiates superseding so only one live token remains', async () => {
    const oldHash = await bcrypt.hash('ParallelIssue-123!', 4);
    resetPlatformRecoveryRequests();
    seedPlatformFixture(oldHash);
    const service = platformService(() => new Date('2026-07-30T18:00:00.000Z'));
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.issue({
          principalDomain: 'platform_principal',
          principalId: PRINCIPAL_ID,
          companyId: null,
          purpose: 'password_reset',
          initiatedBy: 'self',
          deliveryChannel: 'email',
          requestId: `req-e4-parallel-issue-${index}`,
        }),
      ),
    );
    expect(results.every((row) => row.ok)).toBe(true);
    const live = await prisma.credentialRecoveryRequest.findMany({
      where: {
        principalDomain: 'platform_principal',
        principalId: PRINCIPAL_ID,
        purpose: 'password_reset',
        consumedAt: null,
        invalidatedAt: null,
      },
    });
    expect(live).toHaveLength(1);
  }, 60_000);
});
