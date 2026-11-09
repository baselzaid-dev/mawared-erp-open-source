import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import bcrypt from 'bcrypt';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { verifyPassword } from '../src/credentialSecrets';
import {
  ExpectedSecretOfflineAuthorizationVerifier,
  NonProductionEntropyOfflineAuthorizationVerifier,
  PlatformRecoveryService,
  completeBreakGlassPassword,
  resolvePlatformRecoveryEnvironment,
  CapturingRecoveryPackageEmitter,
  emitBreakGlassPackageAfterCommit,
  FailingRecoveryPackageEmitter,
} from '../src/platformRecovery';
import {
  CredentialRecoveryService,
  PostgresRecoveryTargetStore,
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
const hasDisposablePostgres = Boolean(initdb && pgCtl && createdb && psql && existsSync(prismaCli));
const suite = hasDisposablePostgres ? describe : describe.skip;

const TOKEN_PEPPER = 'e5-test-recovery-token-pepper-32chars-min';
const ENV_BINDING = 'test:e5-fixture-fp';
const PRINCIPAL_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_PRINCIPAL_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PLATFORM_EMAIL = 'platform-e5@example.test';
const OLD_PASSWORD = 'OldPlatformPass-E5-123!';
const NEW_PASSWORD = 'NewPlatformPass-E5-456!';
const OFFLINE_SECRET = 'e5-offline-authorization-secret-32ch!!';

suite('platform recovery E5 on disposable PostgreSQL', () => {
  const databaseUser = 'mawared_e5';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let port = 0;
  let prisma: PrismaClient;
  let prismaRoot = '';
  const databaseName = 'mawared_platform_recovery_e5';
  let passwordHash = '';

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
      && basename(workDirectory).startsWith('mawared-platform-recovery-e5-pg-')
    ) {
      try {
        rmSync(workDirectory, { recursive: true, force: true });
      } catch {
        // Windows may briefly lock PG files after stop.
      }
    }
  };

  const executeSql = (sql: string) => {
    const result = spawnSync(psql!, [
      '--no-psqlrc',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--username', databaseUser,
      '--dbname', databaseName,
      '--set', 'ON_ERROR_STOP=1',
      '--command', sql,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(`psql failed: ${result.stdout}\n${result.stderr}`);
    }
  };

  const environment = () => resolvePlatformRecoveryEnvironment('development', {
    environmentBinding: ENV_BINDING,
  });

  const service = () => new PlatformRecoveryService({
    prisma,
    crypto: { tokenPepper: TOKEN_PEPPER },
    offlineAuthorization: new ExpectedSecretOfflineAuthorizationVerifier(OFFLINE_SECRET),
  });

  const recoveryService = () => new CredentialRecoveryService({
    prisma,
    crypto: { tokenPepper: TOKEN_PEPPER },
    environmentBinding: ENV_BINDING,
    targetStore: new PostgresRecoveryTargetStore(),
  });

  const seed = () => {
    executeSql(`
      BEGIN;
      DELETE FROM "PlatformRefreshToken" WHERE "principalId" IN ('${PRINCIPAL_ID}', '${OTHER_PRINCIPAL_ID}');
      DELETE FROM "PlatformAuditLog" WHERE "principalId" IN ('${PRINCIPAL_ID}', '${OTHER_PRINCIPAL_ID}');
      DELETE FROM "CredentialRecoveryAuditEvent" WHERE "subjectId" IN ('${PRINCIPAL_ID}', '${OTHER_PRINCIPAL_ID}');
      DELETE FROM "CredentialRecoveryRequest" WHERE "principalId" IN ('${PRINCIPAL_ID}', '${OTHER_PRINCIPAL_ID}');
      DELETE FROM "PlatformMfaCredential" WHERE "principalId" IN ('${PRINCIPAL_ID}', '${OTHER_PRINCIPAL_ID}');
      DELETE FROM "PlatformPrincipal" WHERE id IN ('${PRINCIPAL_ID}', '${OTHER_PRINCIPAL_ID}');
      INSERT INTO "PlatformPrincipal" (
        "id", "email", "normalizedEmail", "password", "name", "status",
        "permissions", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        '${PRINCIPAL_ID}', '${PLATFORM_EMAIL}', '${PLATFORM_EMAIL}', '${passwordHash}', 'Platform E5',
        'active', '["platform.companies.view"]', 7, 4, NOW(), NOW()
      );
      INSERT INTO "PlatformPrincipal" (
        "id", "email", "normalizedEmail", "password", "name", "status",
        "permissions", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        '${OTHER_PRINCIPAL_ID}', 'other-e5@example.test', 'other-e5@example.test', '${passwordHash}', 'Other',
        'active', '[]', 1, 1, NOW(), NOW()
      );
      INSERT INTO "PlatformMfaCredential" (
        "principalId", "state", "secretCiphertext", "pendingSecretCiphertext", "backupCodeHashes",
        "failedAttempts", "challengeAttempts", "enrolledAt", "lastVerifiedAt", "lastUsedTimeStep",
        "lockedUntil", "createdAt", "updatedAt"
      ) VALUES (
        '${PRINCIPAL_ID}', 'enrolled', 'cipher-e5', NULL, '["bc-a","bc-b"]',
        2, 1, NOW(), NOW(), 42, NULL, NOW(), NOW()
      );
      INSERT INTO "PlatformRefreshToken" (
        "id", "sessionId", "principalId", "tokenHash", "expiresAt",
        "credentialVersion", "mfaVerifiedAt", "createdAt"
      ) VALUES (
        'prt-e5-1', 'sess-e5-1', '${PRINCIPAL_ID}', 'hash-prt-e5-1',
        NOW() + interval '7 days', 4, NOW(), NOW()
      );
      INSERT INTO "PlatformRefreshToken" (
        "id", "sessionId", "principalId", "tokenHash", "expiresAt",
        "credentialVersion", "mfaVerifiedAt", "createdAt"
      ) VALUES (
        'prt-e5-other', 'sess-e5-other', '${OTHER_PRINCIPAL_ID}', 'hash-prt-e5-other',
        NOW() + interval '7 days', 1, NOW(), NOW()
      );
      COMMIT;
    `);
  };

  beforeAll(async () => {
    passwordHash = await bcrypt.hash(OLD_PASSWORD, 4);
    workDirectory = mkdtempSync(join(tmpdir(), 'mawared-platform-recovery-e5-pg-'));
    clusterDirectory = join(workDirectory, 'cluster');
    const logPath = join(workDirectory, 'postgres.log');
    port = await reserveLocalPort();

    runQuietly('initdb', initdb!, [
      '--pgdata', clusterDirectory,
      '--username', databaseUser,
      '--auth-local', 'trust',
      '--auth-host', 'trust',
      '--no-instructions',
    ]);
    writeFileSync(join(clusterDirectory, 'postgresql.conf'), [
      `listen_addresses = '127.0.0.1'`,
      `port = ${port}`,
      `logging_collector = off`,
      `max_connections = 40`,
      '',
    ].join('\n'), 'utf8');

    runQuietly('pg_ctl start', pgCtl!, [
      '--pgdata', clusterDirectory,
      '--log', logPath,
      '--wait',
      '--options', `-h 127.0.0.1 -p ${port} -c unix_socket_directories=`,
      'start',
    ]);
    clusterStarted = true;

    runQuietly('createdb', createdb!, [
      '--host', '127.0.0.1',
      '--port', String(port),
      '--username', databaseUser,
      databaseName,
    ]);

    prismaRoot = join(workDirectory, 'prisma');
    mkdirSync(prismaRoot, { recursive: true });
    // Point schema at repo migrations via symlink-like copy of schema only; migrate uses repo path.
    const schemaSource = join(backendRoot, 'prisma', 'schema.prisma');
    const schemaDest = join(prismaRoot, 'schema.prisma');
    const { copyFileSync, cpSync } = await import('node:fs');
    copyFileSync(schemaSource, schemaDest);
    cpSync(migrationsRoot, join(prismaRoot, 'migrations'), { recursive: true });

    runQuietly(
      'prisma migrate deploy',
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--schema', schemaDest],
      { cwd: workDirectory, env: databaseEnvironment(databaseName) },
    );

    // Confirm E5 migration is present in the chain.
    const migrations = readdirSync(migrationsRoot)
      .filter((name) => statSync(join(migrationsRoot, name)).isDirectory())
      .sort();
    expect(migrations.some((name) => name.includes('credential_recovery_e5'))).toBe(true);

    prisma = new PrismaClient({
      datasources: { db: { url: urlFor(databaseName) } },
    });
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await stopAndClean();
  }, 60_000);

  it('dry-run performs no writes', async () => {
    seed();
    const before = await prisma.platformPrincipal.findUnique({ where: { id: PRINCIPAL_ID } });
    const plan = await service().dryRun({
      principalId: PRINCIPAL_ID,
      mode: 'mfa-recovery',
      environment: environment(),
    });
    expect(plan.dryRun).toBe(true);
    expect(plan.eligible).toBe(true);
    expect(plan.passwordPreserved).toBe(true);
    expect(plan.mfaWouldBeCleared).toBe(true);
    const after = await prisma.platformPrincipal.findUnique({ where: { id: PRINCIPAL_ID } });
    expect(after?.credentialVersion).toBe(before?.credentialVersion);
    const sessions = await prisma.platformRefreshToken.count({
      where: { principalId: PRINCIPAL_ID, revokedAt: null },
    });
    expect(sessions).toBe(1);
  });

  it('MFA-only recovery preserves password, clears MFA, increments CV, revokes sessions', async () => {
    seed();
    const result = await service().execute({
      principalId: PRINCIPAL_ID,
      mode: 'mfa-recovery',
      reasonCategory: 'lost_mfa_device',
      environment: environment(),
      offlineSecret: OFFLINE_SECRET,
    });
    expect(result.credentialVersion).toBe(5);
    expect(result.sessionsRevokedCount).toBe(1);
    expect(result.mfaInvalidated).toBe(true);
    expect(result.recoveryPackageIssued).toBe(false);

    const principal = await prisma.platformPrincipal.findUnique({ where: { id: PRINCIPAL_ID } });
    expect(principal?.credentialVersion).toBe(5);
    expect(principal?.authorizationVersion).toBe(7);
    expect(principal?.permissions).toContain('platform.companies.view');
    expect(await verifyPassword(OLD_PASSWORD, principal!.password)).toBe(true);

    const mfa = await prisma.platformMfaCredential.findUnique({ where: { principalId: PRINCIPAL_ID } });
    expect(mfa?.state).toBe('pending');
    expect(mfa?.secretCiphertext).toBeNull();
    expect(mfa?.backupCodeHashes).toBe('[]');
    expect(mfa?.enrolledAt).toBeNull();

    const otherSessions = await prisma.platformRefreshToken.count({
      where: { principalId: OTHER_PRINCIPAL_ID, revokedAt: null },
    });
    expect(otherSessions).toBe(1);
  });

  it('full break-glass issues one-time package, invalidates password, and completes permanently', async () => {
    seed();
    const result = await service().execute({
      principalId: PRINCIPAL_ID,
      mode: 'full-break-glass',
      reasonCategory: 'total_lockout',
      environment: environment(),
      offlineSecret: OFFLINE_SECRET,
    });
    expect(result.recoveryPackageIssued).toBe(true);
    expect(result.recoveryPackage).not.toBeNull();
    const pkg = result.recoveryPackage!.reveal();
    expect(pkg.length).toBeGreaterThan(20);
    expect(JSON.stringify(result.recoveryPackage)).not.toContain(pkg);

    const emitter = new CapturingRecoveryPackageEmitter();
    await emitBreakGlassPackageAfterCommit(emitter, result);
    expect(emitter.emitCount).toBe(1);
    expect(emitter.revealForTest()).toBe(pkg);

    const principal = await prisma.platformPrincipal.findUnique({ where: { id: PRINCIPAL_ID } });
    expect(await verifyPassword(OLD_PASSWORD, principal!.password)).toBe(false);
    expect(principal?.credentialVersion).toBe(5);

    const mfa = await prisma.platformMfaCredential.findUnique({ where: { principalId: PRINCIPAL_ID } });
    expect(mfa?.state).toBe('pending');
    expect(mfa?.secretCiphertext).toBeNull();

    await completeBreakGlassPassword({
      service: recoveryService(),
      prisma,
      recoveryPackage: pkg,
      newPassword: NEW_PASSWORD,
      requestId: 'e5-complete-1',
    });

    const after = await prisma.platformPrincipal.findUnique({ where: { id: PRINCIPAL_ID } });
    expect(await verifyPassword(NEW_PASSWORD, after!.password)).toBe(true);
    expect(after?.credentialVersion).toBe(5); // no second increment on package consume

    // Package single-use
    await expect(completeBreakGlassPassword({
      service: recoveryService(),
      prisma,
      recoveryPackage: pkg,
      newPassword: 'AnotherNewPass-789!',
      requestId: 'e5-complete-2',
    })).rejects.toThrow();
  });

  it('break-glass supersession invalidates prior live package', async () => {
    seed();
    const first = await service().execute({
      principalId: PRINCIPAL_ID,
      mode: 'full-break-glass',
      reasonCategory: 'suspected_compromise',
      environment: environment(),
      offlineSecret: OFFLINE_SECRET,
    });
    const firstPkg = first.recoveryPackage!.reveal();

    // Re-seed sessions/MFA lightly by only updating CV-compatible state for second run:
    // Second execute on same principal after first should supersede.
    const second = await service().execute({
      principalId: PRINCIPAL_ID,
      mode: 'full-break-glass',
      reasonCategory: 'suspected_compromise',
      environment: environment(),
      offlineSecret: OFFLINE_SECRET,
    });
    expect(second.credentialVersion).toBe(first.credentialVersion + 1);

    await expect(completeBreakGlassPassword({
      service: recoveryService(),
      prisma,
      recoveryPackage: firstPkg,
      newPassword: NEW_PASSWORD,
      requestId: 'e5-superseded',
    })).rejects.toThrow();

    await completeBreakGlassPassword({
      service: recoveryService(),
      prisma,
      recoveryPackage: second.recoveryPackage!.reveal(),
      newPassword: NEW_PASSWORD,
      requestId: 'e5-live',
    });
  });

  it('concurrent MFA recoveries leave coherent fenced state', async () => {
    seed();
    const outcomes = await Promise.allSettled([
      service().execute({
        principalId: PRINCIPAL_ID,
        mode: 'mfa-recovery',
        reasonCategory: 'lost_mfa_device',
        environment: environment(),
        offlineSecret: OFFLINE_SECRET,
      }),
      service().execute({
        principalId: PRINCIPAL_ID,
        mode: 'mfa-recovery',
        reasonCategory: 'lost_mfa_device',
        environment: environment(),
        offlineSecret: OFFLINE_SECRET,
      }),
    ]);
    const fulfilled = outcomes.filter((item) => item.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const principal = await prisma.platformPrincipal.findUnique({ where: { id: PRINCIPAL_ID } });
    expect(principal!.credentialVersion).toBeGreaterThanOrEqual(5);
    expect(await verifyPassword(OLD_PASSWORD, principal!.password)).toBe(true);
    const mfa = await prisma.platformMfaCredential.findUnique({ where: { principalId: PRINCIPAL_ID } });
    expect(mfa?.state).toBe('pending');
    expect(mfa?.secretCiphertext).toBeNull();
  });

  it('concurrent break-glass leaves at most one live package', async () => {
    seed();
    const outcomes = await Promise.allSettled([
      service().execute({
        principalId: PRINCIPAL_ID,
        mode: 'full-break-glass',
        reasonCategory: 'total_lockout',
        environment: environment(),
        offlineSecret: OFFLINE_SECRET,
      }),
      service().execute({
        principalId: PRINCIPAL_ID,
        mode: 'full-break-glass',
        reasonCategory: 'total_lockout',
        environment: environment(),
        offlineSecret: OFFLINE_SECRET,
      }),
    ]);
    const fulfilled = outcomes.filter((item) => item.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const live = await prisma.credentialRecoveryRequest.count({
      where: {
        principalId: PRINCIPAL_ID,
        purpose: 'break_glass_recovery',
        consumedAt: null,
        invalidatedAt: null,
      },
    });
    expect(live).toBe(1);
    const principal = await prisma.platformPrincipal.findUnique({ where: { id: PRINCIPAL_ID } });
    expect(await verifyPassword(OLD_PASSWORD, principal!.password)).toBe(false);
  });

  it('concurrent package consume allows exactly one success', async () => {
    seed();
    const issued = await service().execute({
      principalId: PRINCIPAL_ID,
      mode: 'full-break-glass',
      reasonCategory: 'total_lockout',
      environment: environment(),
      offlineSecret: OFFLINE_SECRET,
    });
    const pkg = issued.recoveryPackage!.reveal();
    const outcomes = await Promise.allSettled([
      completeBreakGlassPassword({
        service: recoveryService(),
        prisma,
        recoveryPackage: pkg,
        newPassword: NEW_PASSWORD,
        requestId: 'e5-consume-a',
      }),
      completeBreakGlassPassword({
        service: recoveryService(),
        prisma,
        recoveryPackage: pkg,
        newPassword: 'AltNewPassword-E5-999!',
        requestId: 'e5-consume-b',
      }),
    ]);
    const fulfilled = outcomes.filter((item) => item.status === 'fulfilled');
    const rejected = outcomes.filter((item) => item.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const principal = await prisma.platformPrincipal.findUnique({ where: { id: PRINCIPAL_ID } });
    expect(await verifyPassword(NEW_PASSWORD, principal!.password)
      || await verifyPassword('AltNewPassword-E5-999!', principal!.password)).toBe(true);
  });
  it('emitter failure after commit leaves package supersedable and not retrievable as plaintext', async () => {
    seed();
    const result = await service().execute({
      principalId: PRINCIPAL_ID,
      mode: 'full-break-glass',
      reasonCategory: 'total_lockout',
      environment: environment(),
      offlineSecret: OFFLINE_SECRET,
    });
    await expect(emitBreakGlassPackageAfterCommit(
      new FailingRecoveryPackageEmitter(),
      result,
    )).rejects.toThrow(/emitter failed/i);

    const rows = await prisma.credentialRecoveryRequest.findMany({
      where: {
        principalId: PRINCIPAL_ID,
        purpose: 'break_glass_recovery',
        consumedAt: null,
        invalidatedAt: null,
      },
    });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(result.recoveryPackage!.reveal());
  });

  it('Production execute refuses without dual-control provider', async () => {
    seed();
    const productionEnv = resolvePlatformRecoveryEnvironment('production', {
      environmentBinding: 'production:e5prod-fp01',
    });
    const prodService = new PlatformRecoveryService({
      prisma,
      crypto: { tokenPepper: TOKEN_PEPPER },
      offlineAuthorization: new NonProductionEntropyOfflineAuthorizationVerifier(),
      enforceProductionConstructionGuards: true,
    });
    await expect(prodService.execute({
      principalId: PRINCIPAL_ID,
      mode: 'full-break-glass',
      reasonCategory: 'total_lockout',
      environment: productionEnv,
      offlineSecret: 'x'.repeat(32),
      productionConfirmationPhrase: 'CONFIRM PRODUCTION BREAK-GLASS',
      targetConfirmationPrincipalId: PRINCIPAL_ID,
    })).rejects.toThrow(/not configured|dual/i);
  });
});
