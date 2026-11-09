import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import bcrypt from 'bcrypt';
import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import * as OTPAuth from 'otpauth';
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
  CredentialRecoveryService,
  PostgresRecoveryTargetStore,
  CapturingRecoveryDeliveryAdapter,
  RecoveryDeliveryScheduler,
  RecoveryRateLimiter,
  InMemoryRecoveryRateLimitStore,
  DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
} from '../src/credentialRecovery';
import {
  confirmPlatformPasswordRecovery,
  registerPlatformPrincipalRecoveryRoutes,
} from '../src/platformPrincipalRecovery';
import {
  mintVersionBoundPlatformMfaChallenge,
  parseVersionBoundPlatformMfaChallengeToken,
  registerPlatformAuthRoutes,
} from '../src/platformAuth';
import {
  encryptMfaSecret,
  generateTotpSecret,
} from '../src/mfa';

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

function runCapture(command: string, args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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

const TOKEN_PEPPER = 'e4-mfa-race-token-pepper-32chars-min!!';
const RATE_PEPPER = 'e4-mfa-race-rate-limit-pepper-32chars';
const ENV_BINDING = 'test:e4-mfa-race-fp';
const PLATFORM_SIGNING = 'e4-mfa-race-platform-signing-material-32c';
const MFA_KEY = Buffer.alloc(32, 23).toString('base64');
const PRINCIPAL_ID = 'pp-e4-mfa-race';
const OTHER_ID = 'pp-e4-mfa-other';
const EMAIL = 'platform-mfa-race@example.test';
const OLD_PASSWORD = 'OldMfaRacePass-123!';
const NEW_PASSWORD = 'NewMfaRacePass-456!';

suite('Platform MFA challenge fencing vs E4 recovery on disposable PostgreSQL', () => {
  const databaseUser = 'mawared_e4_mfa';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let port = 0;
  let prisma: PrismaClient;
  let prismaRoot = '';
  let totpSecret = '';
  const databaseName = 'mawared_platform_mfa_race_e4';

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
      && basename(workDirectory).startsWith('mawared-platform-mfa-race-e4-pg-')
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

  const recoveryService = (clock?: () => Date) => new CredentialRecoveryService({
    prisma,
    crypto: { tokenPepper: TOKEN_PEPPER },
    environmentBinding: ENV_BINDING,
    targetStore: new PostgresRecoveryTargetStore(),
    clock: clock ?? (() => new Date('2026-07-30T20:00:00.000Z')),
  });

  const makeApp = () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      (req as { requestId?: string }).requestId = 'req-mfa-race';
      res.locals.requestId = 'req-mfa-race';
      next();
    });
    const limiter = rateLimit({ windowMs: 60_000, limit: 1_000, standardHeaders: false, legacyHeaders: false });
    registerPlatformAuthRoutes({
      app,
      prisma,
      limiter,
      jwtSecret: PLATFORM_SIGNING,
      mfaEncryptionKey: MFA_KEY,
      accessTokenTtl: '10m',
      refreshTokenTtlDays: 7,
    });
    const service = recoveryService();
    const rateLimiter = new RecoveryRateLimiter(
      new InMemoryRecoveryRateLimitStore(),
      RATE_PEPPER,
      DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
      () => new Date('2026-07-30T20:00:00.000Z'),
    );
    registerPlatformPrincipalRecoveryRoutes({
      app,
      prisma,
      recoveryService: service,
      rateLimiter,
      deliveryAdapter: new CapturingRecoveryDeliveryAdapter(),
      deliveryScheduler: new RecoveryDeliveryScheduler(),
      timing: { floorMs: 0, jitterMs: 0, delay: async () => undefined, random: () => 0 },
      isProduction: false,
    });
    process.env.CREDENTIAL_RECOVERY_TOKEN_PEPPER = TOKEN_PEPPER;
    process.env.CREDENTIAL_RECOVERY_RATE_LIMIT_PEPPER = RATE_PEPPER;
    return { app, service };
  };

  const seedPrincipal = async (passwordPlain: string, credentialVersion = 3) => {
    const passwordHash = await bcrypt.hash(passwordPlain, 4);
    totpSecret = generateTotpSecret();
    const cipher = encryptMfaSecret(totpSecret, MFA_KEY).replace(/'/g, "''");
    executeSql(`
      BEGIN;
      INSERT INTO "PlatformPrincipal" (
        "id", "email", "normalizedEmail", "password", "name", "status",
        "permissions", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        '${PRINCIPAL_ID}', '${EMAIL}', '${EMAIL}', '${passwordHash}', 'MFA Race',
        'active', '["platform.companies.view"]', 2, ${credentialVersion}, NOW(), NOW()
      )
      ON CONFLICT ("id") DO UPDATE SET
        "password" = EXCLUDED."password",
        "credentialVersion" = EXCLUDED."credentialVersion",
        status = 'active';
      INSERT INTO "PlatformPrincipal" (
        "id", "email", "normalizedEmail", "password", "name", "status",
        "permissions", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        '${OTHER_ID}', 'other-mfa-race@example.test', 'other-mfa-race@example.test', '${passwordHash}',
        'Other', 'active', '[]', 1, 1, NOW(), NOW()
      )
      ON CONFLICT ("id") DO NOTHING;
      INSERT INTO "PlatformMfaCredential" (
        "principalId", "state", "secretCiphertext", "pendingSecretCiphertext", "backupCodeHashes",
        "failedAttempts", "challengeAttempts", "enrolledAt", "lastVerifiedAt", "lastUsedTimeStep",
        "lockedUntil", "challengeTokenHash", "challengePurpose", "challengeExpiresAt",
        "createdAt", "updatedAt"
      ) VALUES (
        '${PRINCIPAL_ID}', 'enrolled', '${cipher}', NULL, '["bc-a"]',
        0, 0, NOW(), NOW(), 10, NULL, NULL, NULL, NULL, NOW(), NOW()
      )
      ON CONFLICT ("principalId") DO UPDATE SET
        state = 'enrolled',
        "secretCiphertext" = EXCLUDED."secretCiphertext",
        "pendingSecretCiphertext" = NULL,
        "backupCodeHashes" = '["bc-a"]',
        "failedAttempts" = 0,
        "lockedUntil" = NULL,
        "challengeTokenHash" = NULL,
        "challengePurpose" = NULL,
        "challengeExpiresAt" = NULL,
        "challengeAttempts" = 0,
        "lastUsedTimeStep" = 10;
      DELETE FROM "PlatformRefreshToken" WHERE "principalId" IN ('${PRINCIPAL_ID}', '${OTHER_ID}');
      UPDATE "CredentialRecoveryRequest"
      SET "invalidatedAt" = GREATEST("createdAt", NOW()), "invalidationReason" = 'security_event'
      WHERE "principalId" = '${PRINCIPAL_ID}' AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL;
      COMMIT;
    `);
  };

  const totpCode = () => new OTPAuth.TOTP({
    issuer: 'Mawared',
    label: 'platform',
    secret: OTPAuth.Secret.fromBase32(totpSecret),
  }).generate();

  const issueRecovery = async (service: CredentialRecoveryService, requestId: string) => {
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
    workDirectory = mkdtempSync(join(tmpdir(), 'mawared-platform-mfa-race-e4-pg-'));
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

  it('rejects a pre-recovery login MFA challenge and clears transient challenge fields', async () => {
    await seedPrincipal(OLD_PASSWORD, 3);
    const { app, service } = makeApp();

    const login = await request(app)
      .post('/api/platform/v1/auth/login')
      .send({ email: EMAIL, password: OLD_PASSWORD });
    expect(login.status).toBe(200);
    const challengeToken = login.body.challengeToken as string;
    expect(challengeToken).toBeTruthy();

    const mfaBefore = await prisma.platformMfaCredential.findUniqueOrThrow({
      where: { principalId: PRINCIPAL_ID },
    });
    expect(mfaBefore.challengePurpose).toBe('login');
    expect(mfaBefore.challengeTokenHash).toBeTruthy();
    expect(parseVersionBoundPlatformMfaChallengeToken(challengeToken)).toEqual({
      kind: 'login',
      credentialVersion: 3,
    });

    const issued = await issueRecovery(service, 'req-mfa-pre-challenge');
    if (!issued.ok || !issued.value.deliverySecret) return;
    await confirmPlatformPasswordRecovery({
      service,
      prisma,
      resetToken: issued.value.deliverySecret.reveal(),
      newPassword: NEW_PASSWORD,
      requestId: 'req-mfa-pre-confirm',
    });

    const mfaAfter = await prisma.platformMfaCredential.findUniqueOrThrow({
      where: { principalId: PRINCIPAL_ID },
    });
    expect(mfaAfter.state).toBe('enrolled');
    expect(mfaAfter.secretCiphertext).toBe(mfaBefore.secretCiphertext);
    expect(mfaAfter.backupCodeHashes).toBe(mfaBefore.backupCodeHashes);
    expect(mfaAfter.enrolledAt).toEqual(mfaBefore.enrolledAt);
    expect(mfaAfter.challengeTokenHash).toBeNull();
    expect(mfaAfter.challengePurpose).toBeNull();
    expect(mfaAfter.challengeExpiresAt).toBeNull();
    expect(mfaAfter.challengeAttempts).toBe(0);

    const verify = await request(app)
      .post('/api/platform/v1/auth/mfa/verify')
      .send({ challengeToken, code: totpCode() });
    expect(verify.status).toBe(401);
    expect(verify.body.messageKey).toBe('platform.mfa_invalid_challenge');
    expect(await prisma.platformRefreshToken.count({
      where: { principalId: PRINCIPAL_ID, revokedAt: null },
    })).toBe(0);
  }, 60_000);

  it('rejects legacy and version-mismatched challengePurpose values', async () => {
    await seedPrincipal(OLD_PASSWORD, 3);
    const { app } = makeApp();

    // Legacy unversioned token fails closed before/without a matching hash row.
    const legacy = await request(app)
      .post('/api/platform/v1/auth/mfa/verify')
      .send({
        challengeToken: 'a'.repeat(48),
        code: totpCode(),
      });
    expect(legacy.status).toBe(401);

    // Token embeds credentialVersion 99 while principal remains at 3.
    const mismatched = mintVersionBoundPlatformMfaChallenge('login', 99);
    await prisma.platformMfaCredential.update({
      where: { principalId: PRINCIPAL_ID },
      data: {
        challengeTokenHash: mismatched.tokenHash,
        challengePurpose: mismatched.purpose,
        challengeExpiresAt: mismatched.expiresAt,
        challengeAttempts: 0,
      },
    });
    const mismatch = await request(app)
      .post('/api/platform/v1/auth/mfa/verify')
      .send({ challengeToken: mismatched.token, code: totpCode() });
    expect(mismatch.status).toBe(401);
  }, 60_000);

  it('recovery-wins concurrent race creates no session', async () => {
    await seedPrincipal(OLD_PASSWORD, 3);
    const { app, service } = makeApp();
    const login = await request(app)
      .post('/api/platform/v1/auth/login')
      .send({ email: EMAIL, password: OLD_PASSWORD });
    const challengeToken = login.body.challengeToken as string;
    const issued = await issueRecovery(service, 'req-mfa-race-recovery-wins');
    if (!issued.ok || !issued.value.deliverySecret) return;
    const resetToken = issued.value.deliverySecret.reveal();

    // Deterministic recovery-first order (same lock order as E1).
    await confirmPlatformPasswordRecovery({
      service,
      prisma,
      resetToken,
      newPassword: NEW_PASSWORD,
      requestId: 'req-mfa-race-recovery',
    });
    const verifyRes = await request(app)
      .post('/api/platform/v1/auth/mfa/verify')
      .send({ challengeToken, code: totpCode() });
    expect(verifyRes.status).toBe(401);
    expect(verifyRes.body.accessToken).toBeUndefined();
    expect(await prisma.platformRefreshToken.count({
      where: { principalId: PRINCIPAL_ID, revokedAt: null },
    })).toBe(0);

    // Parallel settlement invariant: whichever order wins, no live session remains.
    await seedPrincipal(OLD_PASSWORD, 3);
    const again = makeApp();
    const login2 = await request(again.app)
      .post('/api/platform/v1/auth/login')
      .send({ email: EMAIL, password: OLD_PASSWORD });
    const issued2 = await issueRecovery(again.service, 'req-mfa-race-parallel');
    if (!issued2.ok || !issued2.value.deliverySecret) return;
    const [verifyParallel] = await Promise.all([
      request(again.app)
        .post('/api/platform/v1/auth/mfa/verify')
        .send({ challengeToken: login2.body.challengeToken, code: totpCode() }),
      confirmPlatformPasswordRecovery({
        service: again.service,
        prisma,
        resetToken: issued2.value.deliverySecret.reveal(),
        newPassword: NEW_PASSWORD,
        requestId: 'req-mfa-race-parallel-confirm',
      }),
    ]);
    expect(await prisma.platformRefreshToken.count({
      where: { principalId: PRINCIPAL_ID, revokedAt: null },
    })).toBe(0);
    if (verifyParallel.status === 200 && verifyParallel.body.accessToken) {
      const me = await request(again.app)
        .get('/api/platform/v1/auth/me')
        .set('Authorization', `Bearer ${verifyParallel.body.accessToken}`);
      expect(me.status).toBe(401);
      const refresh = await request(again.app)
        .post('/api/platform/v1/auth/refresh')
        .send({ refreshToken: verifyParallel.body.refreshToken });
      expect(refresh.status).toBe(401);
    } else {
      expect(verifyParallel.status).toBe(401);
    }
  }, 90_000);

  it('MFA-wins race session is revoked/fenced by subsequent recovery', async () => {
    await seedPrincipal(OLD_PASSWORD, 3);
    const { app, service } = makeApp();
    const login = await request(app)
      .post('/api/platform/v1/auth/login')
      .send({ email: EMAIL, password: OLD_PASSWORD });
    const challengeToken = login.body.challengeToken as string;

    const verify = await request(app)
      .post('/api/platform/v1/auth/mfa/verify')
      .send({ challengeToken, code: totpCode() });
    expect(verify.status).toBe(200);
    expect(verify.body.accessToken).toBeTruthy();
    expect(verify.body.refreshToken).toBeTruthy();

    const issued = await issueRecovery(service, 'req-mfa-race-mfa-wins');
    if (!issued.ok || !issued.value.deliverySecret) return;
    await confirmPlatformPasswordRecovery({
      service,
      prisma,
      resetToken: issued.value.deliverySecret.reveal(),
      newPassword: NEW_PASSWORD,
      requestId: 'req-mfa-race-mfa-wins-confirm',
    });

    const me = await request(app)
      .get('/api/platform/v1/auth/me')
      .set('Authorization', `Bearer ${verify.body.accessToken}`);
    expect(me.status).toBe(401);

    const refresh = await request(app)
      .post('/api/platform/v1/auth/refresh')
      .send({ refreshToken: verify.body.refreshToken });
    expect(refresh.status).toBe(401);

    const sessions = await prisma.platformRefreshToken.findMany({
      where: { principalId: PRINCIPAL_ID },
    });
    expect(sessions.every((row) => row.revokedAt != null)).toBe(true);
  }, 60_000);

  it('allows normal post-recovery login MFA with the new password', async () => {
    await seedPrincipal(NEW_PASSWORD, 4);
    // Ensure enrolled MFA uses current secret from seedPrincipal.
    const { app } = makeApp();
    const login = await request(app)
      .post('/api/platform/v1/auth/login')
      .send({ email: EMAIL, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.accessToken).toBeUndefined();

    const mfa = await prisma.platformMfaCredential.findUniqueOrThrow({
      where: { principalId: PRINCIPAL_ID },
    });
    expect(mfa.challengePurpose).toBe('login');
    expect(parseVersionBoundPlatformMfaChallengeToken(login.body.challengeToken)).toEqual({
      kind: 'login',
      credentialVersion: 4,
    });

    const verify = await request(app)
      .post('/api/platform/v1/auth/mfa/verify')
      .send({ challengeToken: login.body.challengeToken, code: totpCode() });
    expect(verify.status).toBe(200);
    expect(verify.body.accessToken).toBeTruthy();

    const me = await request(app)
      .get('/api/platform/v1/auth/me')
      .set('Authorization', `Bearer ${verify.body.accessToken}`);
    expect(me.status).toBe(200);

    const otherSessions = await prisma.platformRefreshToken.count({
      where: { principalId: OTHER_ID },
    });
    expect(otherSessions).toBe(0);
  }, 60_000);

  it('rejects an enroll challenge issued before recovery', async () => {
    await seedPrincipal(OLD_PASSWORD, 3);
    // Force pending enrollment state for this principal.
    await prisma.platformMfaCredential.update({
      where: { principalId: PRINCIPAL_ID },
      data: {
        state: 'pending',
        secretCiphertext: null,
        backupCodeHashes: '[]',
        enrolledAt: null,
        lastVerifiedAt: null,
        lastUsedTimeStep: null,
      },
    });
    const { app, service } = makeApp();
    const login = await request(app)
      .post('/api/platform/v1/auth/login')
      .send({ email: EMAIL, password: OLD_PASSWORD });
    expect(login.body.enrollmentRequired).toBe(true);
    const challengeToken = login.body.challengeToken as string;

    const issued = await issueRecovery(service, 'req-mfa-enroll-before');
    if (!issued.ok || !issued.value.deliverySecret) return;
    await confirmPlatformPasswordRecovery({
      service,
      prisma,
      resetToken: issued.value.deliverySecret.reveal(),
      newPassword: NEW_PASSWORD,
      requestId: 'req-mfa-enroll-before-confirm',
    });

    const start = await request(app)
      .post('/api/platform/v1/auth/mfa/enroll/start')
      .send({ challengeToken });
    expect(start.status).toBe(401);
  }, 60_000);
});
