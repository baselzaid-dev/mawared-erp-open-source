import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import express from 'express';
import request from 'supertest';
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
  DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
  PostgresRecoveryRateLimitStore,
  PostgresRecoveryTargetStore,
  RecoveryRateLimiter,
} from '../src/credentialRecovery';
import {
  confirmOwnerPasswordRecovery,
  deliverOwnerRecovery,
} from '../src/companyOwnerRecovery';
import {
  encodeOwnerRecoveryIdempotencyHash,
  parseOwnerRecoveryIdempotencyHash,
  registerPlatformOwnerRecoveryRoutes,
} from '../src/platformOwnerRecovery';
import {
  PLATFORM_PERMISSIONS,
  type PlatformPrincipalContext,
} from '../src/platformAuth';
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

const TOKEN_PEPPER = 'e3-test-recovery-token-pepper-32chars-min';
const RATE_PEPPER = 'e3-test-recovery-rate-limit-pepper-32ch';
const ENV_BINDING = 'test:e3-fixture-fp';
const COMPANY_ID = 'cmp-e3-pg';
const OWNER_ID = 'owner-e3-pg';
const OTHER_OWNER_ID = 'owner-e3-other';
const ROLE_ID = 'role-e3-pg';
const OWNER_EMAIL = 'owner-e3@example.test';

suite('company owner recovery E3 on disposable PostgreSQL', () => {
  const databaseUser = 'mawared_e3';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let port = 0;
  let prisma: PrismaClient;
  let prismaRoot = '';
  const databaseName = 'mawared_owner_recovery_e3';

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
      && basename(workDirectory).startsWith('mawared-owner-recovery-e3-pg-')
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

  const ownerService = (clock?: () => Date) => new CredentialRecoveryService({
    prisma,
    crypto: { tokenPepper: TOKEN_PEPPER },
    environmentBinding: ENV_BINDING,
    targetStore: new PostgresRecoveryTargetStore(),
    clock: clock ?? (() => new Date('2026-07-28T12:00:00.000Z')),
  });

  const seedOwnerFixture = (passwordHash: string) => {
    executeSql(`
      BEGIN;
      INSERT INTO "Company" ("id", "code", "name", "createdAt", "updatedAt")
      VALUES ('${COMPANY_ID}', 'CMP-E3-PG', 'E3 PG Co', NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING;
      INSERT INTO "Role" ("id", "companyId", "name", "permissions", "createdAt", "updatedAt")
      VALUES ('${ROLE_ID}', '${COMPANY_ID}', 'Admin', '["admin.full"]', NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING;
      INSERT INTO "User" (
        "id", "companyId", "email", "normalizedEmail", "name", "password", "roleId",
        "accountStatus", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        '${OWNER_ID}', '${COMPANY_ID}', '${OWNER_EMAIL}', '${OWNER_EMAIL}', 'Owner', '${passwordHash}',
        '${ROLE_ID}', 'active', 1, 3, NOW(), NOW()
      )
      ON CONFLICT ("id") DO UPDATE SET
        "password" = EXCLUDED."password",
        "credentialVersion" = EXCLUDED."credentialVersion",
        "accountStatus" = 'active';
      INSERT INTO "CompanyOwnership" (
        "id", "companyId", "userId", "isPrimary", "status", "effectiveAt", "createdByUserId"
      ) VALUES (
        'own-e3-pg', '${COMPANY_ID}', '${OWNER_ID}', TRUE, 'active', NOW(), '${OWNER_ID}'
      )
      ON CONFLICT ("id") DO UPDATE SET
        "userId" = EXCLUDED."userId",
        status = 'active',
        "endedAt" = NULL,
        "endedByUserId" = NULL,
        "isPrimary" = TRUE;
      UPDATE "CompanyOwnership"
      SET status = 'ended', "endedAt" = NOW(), "isPrimary" = FALSE, "endedByUserId" = '${OWNER_ID}'
      WHERE "companyId" = '${COMPANY_ID}' AND id <> 'own-e3-pg' AND status = 'active';
      INSERT INTO "UserMfaCredential" (
        "userId", "companyId", "state", "secretCiphertext", "backupCodeHashes",
        "failedAttempts", "challengeAttempts", "enrolledAt", "createdAt", "updatedAt"
      ) VALUES (
        '${OWNER_ID}', '${COMPANY_ID}', 'enrolled', 'cipher', '[]', 0, 0, NOW(), NOW(), NOW()
      )
      ON CONFLICT ("userId") DO UPDATE SET state = 'enrolled', "enrolledAt" = NOW();
      INSERT INTO "RefreshToken" (
        "id", "userId", "companyId", "tokenHash", "sessionId", "expiresAt", "createdAt"
      ) VALUES (
        'rt-e3-1', '${OWNER_ID}', '${COMPANY_ID}', 'hash-rt-e3-1-unique', 'sess-e3-1',
        NOW() + interval '7 days', NOW()
      )
      ON CONFLICT ("id") DO UPDATE SET "revokedAt" = NULL, "revokedReason" = NULL;
      COMMIT;
    `);
  };

  const resetOwnerRecoveryRequests = () => {
    executeSql(`
      UPDATE "CredentialRecoveryRequest"
      SET "invalidatedAt" = NOW(), "invalidationReason" = 'superseded'
      WHERE "principalId" = '${OWNER_ID}'
        AND "consumedAt" IS NULL
        AND "invalidatedAt" IS NULL;
    `);
  };

  const issueOwnerRecovery = async (requestId: string, service = ownerService()) => {
    const issued = await service.issue({
      principalDomain: 'company_primary_owner',
      principalId: OWNER_ID,
      companyId: COMPANY_ID,
      purpose: 'password_reset',
      initiatedBy: 'self',
      deliveryChannel: 'email',
      requestId,
    });
    expect(issued.ok).toBe(true);
    return issued;
  };

  beforeAll(async () => {
    workDirectory = mkdtempSync(join(tmpdir(), 'mawared-owner-recovery-e3-pg-'));
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
      '--options', `-h 127.0.0.1 -p ${port} -F`,
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
    prisma = new PrismaClient({ datasources: { db: { url: urlFor(databaseName) } } });
  }, 300_000);

  afterAll(stopAndClean, 60_000);

  it('issues and confirms owner recovery: password change, credentialVersion +1, sessions revoked, MFA/ownership unchanged', async () => {
    const oldHash = await bcrypt.hash('OldOwnerPass-123!', 4);
    seedOwnerFixture(oldHash);
    const service = ownerService(() => new Date('2026-07-28T12:00:00.000Z'));
    const issued = await issueOwnerRecovery('req-e3-issue-1', service);
    if (!issued.ok || !issued.value.deliverySecret) return;
    const token = issued.value.deliverySecret.reveal();

    const mfaBefore = await prisma.userMfaCredential.findUnique({ where: { userId: OWNER_ID } });
    const ownershipBefore = await prisma.companyOwnership.findMany({
      where: { companyId: COMPANY_ID, isPrimary: true, status: 'active', endedAt: null },
    });

    await confirmOwnerPasswordRecovery({
      service,
      prisma,
      resetToken: token,
      newPassword: 'NewOwnerPass-456!',
      requestId: 'req-e3-confirm-1',
    });

    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: OWNER_ID } });
    expect(userAfter.credentialVersion).toBe(4);
    expect(await bcrypt.compare('NewOwnerPass-456!', userAfter.password)).toBe(true);

    const revoked = await prisma.refreshToken.findMany({
      where: { userId: OWNER_ID, companyId: COMPANY_ID },
    });
    expect(revoked.every((row) => row.revokedAt != null && row.revokedReason === 'owner_recovery')).toBe(true);

    const mfaAfter = await prisma.userMfaCredential.findUnique({ where: { userId: OWNER_ID } });
    expect(mfaAfter?.state).toBe(mfaBefore?.state);
    expect(mfaAfter?.secretCiphertext).toBe(mfaBefore?.secretCiphertext);

    const ownershipAfter = await prisma.companyOwnership.findMany({
      where: { companyId: COMPANY_ID, isPrimary: true, status: 'active', endedAt: null },
    });
    expect(ownershipAfter).toHaveLength(1);
    expect(ownershipAfter[0].userId).toBe(ownershipBefore[0].userId);
  }, 60_000);

  it('allows exactly one successful confirm under concurrent replay', async () => {
    const oldHash = await bcrypt.hash('ConcurrentOld-123!', 4);
    resetOwnerRecoveryRequests();
    seedOwnerFixture(oldHash);
    const service = ownerService(() => new Date('2026-07-28T12:30:00.000Z'));
    const issued = await issueOwnerRecovery('req-e3-concurrent-issue', service);
    if (!issued.ok || !issued.value.deliverySecret) return;
    const token = issued.value.deliverySecret.reveal();

    const attempts = Array.from({ length: 10 }, (_, index) =>
      confirmOwnerPasswordRecovery({
        service,
        prisma,
        resetToken: token,
        newPassword: `ConcurrentNew-${index}!`,
        requestId: `req-e3-concurrent-${index}`,
      }).then(() => 'ok').catch(() => 'fail'),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((value) => value === 'ok')).toHaveLength(1);
    expect(results.filter((value) => value === 'fail')).toHaveLength(9);

    const consumedForRequest = await prisma.credentialRecoveryRequest.count({
      where: { id: issued.value.recoveryRequestId, consumedAt: { not: null } },
    });
    expect(consumedForRequest).toBe(1);
  }, 60_000);

  it('fails confirm after ownership transfer without mutating password', async () => {
    const oldHash = await bcrypt.hash('TransferOld-123!', 4);
    resetOwnerRecoveryRequests();
    seedOwnerFixture(oldHash);
    const service = ownerService(() => new Date('2026-07-28T13:00:00.000Z'));
    const issued = await issueOwnerRecovery('req-e3-transfer-issue', service);
    if (!issued.ok || !issued.value.deliverySecret) return;
    const token = issued.value.deliverySecret.reveal();

    executeSql(`
      BEGIN;
      INSERT INTO "User" (
        "id", "companyId", "email", "normalizedEmail", "name", "password", "roleId",
        "accountStatus", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        '${OTHER_OWNER_ID}', '${COMPANY_ID}', 'other@example.test', 'other@example.test', 'Other',
        '${oldHash}', '${ROLE_ID}', 'active', 1, 1, NOW(), NOW()
      )
      ON CONFLICT ("id") DO NOTHING;
      INSERT INTO "CompanyOwnership" (
        "id", "companyId", "userId", "isPrimary", "status", "effectiveAt", "createdByUserId"
      ) VALUES (
        'own-e3-other', '${COMPANY_ID}', '${OTHER_OWNER_ID}', TRUE, 'active', NOW(), '${OTHER_OWNER_ID}'
      )
      ON CONFLICT ("id") DO NOTHING;
      UPDATE "CompanyOwnership"
      SET status = 'ended', "endedAt" = NOW(), "isPrimary" = FALSE, "endedByUserId" = '${OWNER_ID}'
      WHERE id = 'own-e3-pg';
      COMMIT;
    `);

    await expect(confirmOwnerPasswordRecovery({
      service,
      prisma,
      resetToken: token,
      newPassword: 'ShouldNotApply-789!',
      requestId: 'req-e3-transfer-confirm',
    })).rejects.toMatchObject({
      messageKey: 'owner_recovery.invalid_or_expired',
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: OWNER_ID } });
    expect(await bcrypt.compare('TransferOld-123!', user.password)).toBe(true);
    expect(user.credentialVersion).toBe(3);
  }, 60_000);

  it('supersedes the first token when a second issue occurs', async () => {
    const oldHash = await bcrypt.hash('SupersedeOld-123!', 4);
    resetOwnerRecoveryRequests();
    seedOwnerFixture(oldHash);
    const service = ownerService(() => new Date('2026-07-28T13:30:00.000Z'));
    const first = await issueOwnerRecovery('req-e3-super-1', service);
    if (!first.ok || !first.value.deliverySecret) return;
    const firstToken = first.value.deliverySecret.reveal();

    const second = await issueOwnerRecovery('req-e3-super-2', service);
    expect(second.ok).toBe(true);

    await expect(confirmOwnerPasswordRecovery({
      service,
      prisma,
      resetToken: firstToken,
      newPassword: 'SupersededShouldFail-1!',
      requestId: 'req-e3-super-old',
    })).rejects.toMatchObject({
      messageKey: 'owner_recovery.invalid_or_expired',
    });
  }, 60_000);

  it('records delivery status pending to dispatched/failed without leaking secrets', async () => {
    const oldHash = await bcrypt.hash('DeliveryOld-123!', 4);
    resetOwnerRecoveryRequests();
    seedOwnerFixture(oldHash);
    const service = ownerService(() => new Date('2026-07-28T14:00:00.000Z'));
    const issued = await issueOwnerRecovery('req-e3-delivery', service);
    if (!issued.ok || !issued.value.deliverySecret) return;

    const adapter = new CapturingRecoveryDeliveryAdapter();
    adapter.setNextStatus('dispatched');
    const status = await deliverOwnerRecovery({
      adapter,
      service,
      issued: {
        recoveryRequestId: issued.value.recoveryRequestId,
        deliverySecret: issued.value.deliverySecret,
        expiresAt: issued.value.expiresAt,
      },
      recipientRef: `owner-email:${COMPANY_ID}:${OWNER_ID}`,
      template: 'company_owner_password_reset',
      requestId: 'req-e3-delivery',
    });
    expect(status).toBe('dispatched');

    const row = await prisma.credentialRecoveryRequest.findUniqueOrThrow({
      where: { id: issued.value.recoveryRequestId },
    });
    expect(row.deliveryStatus).toBe('dispatched');
    const token = adapter.consumeLastSecret();
    expect(token).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(token!);
    expect(JSON.stringify(await prisma.credentialRecoveryAuditEvent.findMany({
      where: { recoveryRequestId: issued.value.recoveryRequestId },
    }))).not.toContain(token!);
    expect(JSON.stringify(await prisma.credentialRecoveryAuditEvent.findMany({
      where: { recoveryRequestId: issued.value.recoveryRequestId },
    }))).not.toContain(OWNER_EMAIL);
  }, 60_000);

  it('atomically commits delivery status, E1 audit, and Platform final audit', async () => {
    executeSql(`
      INSERT INTO "PlatformPrincipal" (
        "id", "email", "normalizedEmail", "password", "name", "status",
        "permissions", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        'plat-e3-atomic', 'plat-e3-atomic@example.test', 'plat-e3-atomic@example.test', 'hash', 'Platform', 'active',
        '[]', 1, 1, NOW(), NOW()
      )
      ON CONFLICT ("id") DO NOTHING;
    `);
    const oldHash = await bcrypt.hash('AtomicDeliveryOld-123!', 4);
    resetOwnerRecoveryRequests();
    seedOwnerFixture(oldHash);
    const service = ownerService(() => new Date('2026-07-28T14:05:00.000Z'));
    const issued = await issueOwnerRecovery('req-e3-atomic-ok', service);
    if (!issued.ok || !issued.value.deliverySecret) return;

    const result = await service.recordDeliveryStatusWithEffect(
      {
        recoveryRequestId: issued.value.recoveryRequestId,
        deliveryStatus: 'dispatched',
        requestId: 'req-e3-atomic-ok',
        actorType: 'platform_owner',
        actorId: 'plat-e3-atomic',
      },
      async (tx, recorded) => {
        await tx.platformAuditLog.create({
          data: {
            principalId: 'plat-e3-atomic',
            action: 'platform.companies.owner_recovery.delivery',
            targetCompanyId: COMPANY_ID,
            details: JSON.stringify({
              companyId: COMPANY_ID,
              recoveryRequestRef: recorded.recoveryRequestId,
              requestId: 'req-e3-atomic-ok',
              status: recorded.deliveryStatus,
            }),
          },
        });
      },
    );
    expect(result.ok).toBe(true);

    const row = await prisma.credentialRecoveryRequest.findUniqueOrThrow({
      where: { id: issued.value.recoveryRequestId },
    });
    expect(row.deliveryStatus).toBe('dispatched');
    const e1Audits = await prisma.credentialRecoveryAuditEvent.findMany({
      where: {
        recoveryRequestId: issued.value.recoveryRequestId,
        eventType: 'recovery_delivery_recorded',
      },
    });
    expect(e1Audits.length).toBeGreaterThanOrEqual(1);
    const platformAudits = await prisma.platformAuditLog.findMany({
      where: {
        principalId: 'plat-e3-atomic',
        action: 'platform.companies.owner_recovery.delivery',
      },
    });
    expect(platformAudits.some((a) => a.details.includes('"status":"dispatched"'))).toBe(true);
  }, 60_000);

  it('rolls back delivery status and E1 audit when Platform final audit effect fails', async () => {
    const oldHash = await bcrypt.hash('AtomicRollbackOld-123!', 4);
    resetOwnerRecoveryRequests();
    seedOwnerFixture(oldHash);
    const service = ownerService(() => new Date('2026-07-28T14:06:00.000Z'));
    const issued = await issueOwnerRecovery('req-e3-atomic-plat-fail', service);
    if (!issued.ok || !issued.value.deliverySecret) return;

    const beforeAudits = await prisma.credentialRecoveryAuditEvent.count({
      where: {
        recoveryRequestId: issued.value.recoveryRequestId,
        eventType: 'recovery_delivery_recorded',
      },
    });

    const result = await service.recordDeliveryStatusWithEffect(
      {
        recoveryRequestId: issued.value.recoveryRequestId,
        deliveryStatus: 'dispatched',
        requestId: 'req-e3-atomic-plat-fail',
        actorType: 'platform_owner',
        actorId: 'plat-e3-atomic',
      },
      async () => {
        throw new Error('platform audit insert boom');
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('callback_failed');

    const row = await prisma.credentialRecoveryRequest.findUniqueOrThrow({
      where: { id: issued.value.recoveryRequestId },
    });
    expect(row.deliveryStatus).toBe('pending');
    expect(await prisma.credentialRecoveryAuditEvent.count({
      where: {
        recoveryRequestId: issued.value.recoveryRequestId,
        eventType: 'recovery_delivery_recorded',
      },
    })).toBe(beforeAudits);
    expect(await prisma.platformAuditLog.count({
      where: {
        action: 'platform.companies.owner_recovery.delivery',
        details: { contains: issued.value.recoveryRequestId },
      },
    })).toBe(0);
  }, 60_000);

  it('rolls back delivery status when E1 delivery audit insert fails', async () => {
    const oldHash = await bcrypt.hash('AtomicE1FailOld-123!', 4);
    resetOwnerRecoveryRequests();
    seedOwnerFixture(oldHash);
    const issueService = ownerService(() => new Date('2026-07-28T14:07:00.000Z'));
    const issued = await issueOwnerRecovery('req-e3-atomic-e1-fail', issueService);
    if (!issued.ok || !issued.value.deliverySecret) return;

    const failingPrisma = prisma.$extends({
      query: {
        credentialRecoveryAuditEvent: {
          async create({ args, query }) {
            if ((args.data as { eventType?: string }).eventType === 'recovery_delivery_recorded') {
              throw new Error('e1 delivery audit boom');
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const service = new CredentialRecoveryService({
      prisma: failingPrisma,
      crypto: { tokenPepper: TOKEN_PEPPER },
      environmentBinding: ENV_BINDING,
      targetStore: new PostgresRecoveryTargetStore(),
      clock: () => new Date('2026-07-28T14:07:00.000Z'),
    });

    await expect(service.recordDeliveryStatus({
      recoveryRequestId: issued.value.recoveryRequestId,
      deliveryStatus: 'failed',
      requestId: 'req-e3-atomic-e1-fail',
      actorType: 'system',
      actorId: null,
    })).rejects.toThrow(/e1 delivery audit boom/);

    const row = await prisma.credentialRecoveryRequest.findUniqueOrThrow({
      where: { id: issued.value.recoveryRequestId },
    });
    expect(row.deliveryStatus).toBe('pending');
    expect(await prisma.credentialRecoveryAuditEvent.count({
      where: {
        recoveryRequestId: issued.value.recoveryRequestId,
        eventType: 'recovery_delivery_recorded',
      },
    })).toBe(0);
  }, 60_000);

  it('fail-closes concurrent terminal delivery finalization to a single winner', async () => {
    const oldHash = await bcrypt.hash('AtomicRaceOld-123!', 4);
    resetOwnerRecoveryRequests();
    seedOwnerFixture(oldHash);
    const service = ownerService(() => new Date('2026-07-28T14:08:00.000Z'));
    const issued = await issueOwnerRecovery('req-e3-atomic-race', service);
    if (!issued.ok || !issued.value.deliverySecret) return;

    const [a, b] = await Promise.all([
      service.recordDeliveryStatus({
        recoveryRequestId: issued.value.recoveryRequestId,
        deliveryStatus: 'dispatched',
        requestId: 'req-e3-atomic-race-a',
        actorType: 'system',
        actorId: null,
      }),
      service.recordDeliveryStatus({
        recoveryRequestId: issued.value.recoveryRequestId,
        deliveryStatus: 'failed',
        requestId: 'req-e3-atomic-race-b',
        actorType: 'system',
        actorId: null,
      }),
    ]);

    const oks = [a, b].filter((r) => r.ok);
    const fails = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
    if (fails[0]!.ok === false) {
      expect(['concurrent_conflict', 'policy_rejected']).toContain(fails[0]!.reason);
    }

    const row = await prisma.credentialRecoveryRequest.findUniqueOrThrow({
      where: { id: issued.value.recoveryRequestId },
    });
    expect(['dispatched', 'failed']).toContain(row.deliveryStatus);
    expect(oks[0]!.ok && oks[0]!.value.deliveryStatus).toBe(row.deliveryStatus);
  }, 60_000);

  it('marks failed delivery then reissue supersedes the prior live token', async () => {
    const oldHash = await bcrypt.hash('FailedDeliveryOld-123!', 4);
    resetOwnerRecoveryRequests();
    seedOwnerFixture(oldHash);
    const service = ownerService(() => new Date('2026-07-28T14:15:00.000Z'));
    const first = await issueOwnerRecovery('req-e3-fail-delivery', service);
    if (!first.ok || !first.value.deliverySecret) return;
    const firstToken = first.value.deliverySecret.reveal();

    const adapter = new CapturingRecoveryDeliveryAdapter();
    adapter.setNextStatus('failed');
    const status = await deliverOwnerRecovery({
      adapter,
      service,
      issued: {
        recoveryRequestId: first.value.recoveryRequestId,
        deliverySecret: first.value.deliverySecret,
        expiresAt: first.value.expiresAt,
      },
      recipientRef: `owner-email:${COMPANY_ID}:${OWNER_ID}`,
      template: 'company_owner_password_reset',
      requestId: 'req-e3-fail-delivery',
    });
    expect(status).toBe('failed');
    const failedRow = await prisma.credentialRecoveryRequest.findUniqueOrThrow({
      where: { id: first.value.recoveryRequestId },
    });
    expect(failedRow.deliveryStatus).toBe('failed');

    const second = await issueOwnerRecovery('req-e3-fail-reissue', service);
    expect(second.ok).toBe(true);
    if (!second.ok || !second.value.deliverySecret) return;

    await expect(confirmOwnerPasswordRecovery({
      service,
      prisma,
      resetToken: firstToken,
      newPassword: 'FailedDeliveryShouldNotApply-1!',
      requestId: 'req-e3-fail-old-confirm',
    })).rejects.toMatchObject({
      messageKey: 'owner_recovery.invalid_or_expired',
    });

    await confirmOwnerPasswordRecovery({
      service,
      prisma,
      resetToken: second.value.deliverySecret.reveal(),
      newPassword: 'FailedDeliveryNew-456!',
      requestId: 'req-e3-fail-new-confirm',
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: OWNER_ID } });
    expect(await bcrypt.compare('FailedDeliveryNew-456!', user.password)).toBe(true);
  }, 60_000);

  it('platform assisted routes bind each key to an exact recovery and serialize replacement', async () => {
    executeSql(`
      INSERT INTO "PlatformPrincipal" (
        "id", "email", "normalizedEmail", "password", "name", "status",
        "permissions", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        'plat-e3-http', 'plat-e3-http@example.test', 'plat-e3-http@example.test', 'hash', 'Platform', 'active',
        '["platform.companies.owner_recovery.initiate"]', 1, 1, NOW(), NOW()
      )
      ON CONFLICT ("id") DO NOTHING;
    `);
    const oldHash = await bcrypt.hash('PlatformHttpOld-123!', 4);
    resetOwnerRecoveryRequests();
    seedOwnerFixture(oldHash);
    executeSql(`
      INSERT INTO "LoginIdentity" (
        "id", "companyId", "userId", "type", "normalizedIdentifier", "createdAt", "updatedAt"
      ) VALUES (
        'li-e3-owner', '${COMPANY_ID}', '${OWNER_ID}', 'email', '${OWNER_EMAIL}', NOW(), NOW()
      )
      ON CONFLICT ("id") DO UPDATE SET
        "userId" = EXCLUDED."userId",
        "normalizedIdentifier" = EXCLUDED."normalizedIdentifier";
    `);

    const deliveryAdapter = new CapturingRecoveryDeliveryAdapter();
    const service = ownerService(() => new Date('2026-07-28T16:00:00.000Z'));
    const rateLimiter = new RecoveryRateLimiter(
      new PostgresRecoveryRateLimitStore(prisma),
      RATE_PEPPER,
      DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
      () => new Date('2026-07-28T16:00:00.000Z'),
    );
    const principal: PlatformPrincipalContext = {
      id: 'plat-e3-http',
      email: 'plat-e3-http@example.test',
      name: 'Platform',
      permissions: [PLATFORM_PERMISSIONS.COMPANIES_OWNER_RECOVERY_INITIATE],
      authorizationVersion: 1,
      sessionId: 'sess-plat-e3-http',
      mfaVerifiedAt: new Date('2026-07-28T16:00:00.000Z'),
      credentialVersion: 1,
    };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      (req as { requestId?: string }).requestId = 'req-plat-e3-http';
      res.locals.requestId = 'req-plat-e3-http';
      next();
    });
    const requirePlatformAuth: express.RequestHandler = (req, _res, next) => {
      (req as { platformPrincipal?: PlatformPrincipalContext }).platformPrincipal = principal;
      next();
    };
    registerPlatformOwnerRecoveryRoutes({
      app,
      prisma,
      requirePlatformAuth,
      recoveryService: service,
      rateLimiter,
      deliveryAdapter,
      rateLimitPepper: RATE_PEPPER,
      clock: () => new Date('2026-07-28T16:00:00.000Z'),
      isProduction: false,
    });

    const route = `/api/platform/v1/companies/${COMPANY_ID}/owner-recovery/initiate`;
    const body = {
      reasonCategory: 'verified_owner_request' as const,
      approvalReference: 'TICKET-PG-E3-001',
      confirmation: true as const,
    };
    const digest = crypto.createHash('sha256').update(JSON.stringify({
      companyId: COMPANY_ID,
      reasonCategory: body.reasonCategory,
      approvalReference: body.approvalReference,
      confirmation: true,
    })).digest('hex');

    const keyA = await request(app).post(route).set('Idempotency-Key', 'idem-pg-key-a').send(body);
    expect(keyA.status).toBe(202);
    expect(keyA.body.status).toBe('owner_recovery_dispatched');
    const tokenA = deliveryAdapter.consumeLastSecret();
    expect(tokenA).toBeTruthy();

    deliveryAdapter.setNextStatus('failed');
    const keyB = await request(app).post(route).set('Idempotency-Key', 'idem-pg-key-b').send(body);
    expect(keyB.status).toBe(503);

    const rowA = await prisma.platformIdempotencyKey.findUniqueOrThrow({
      where: { principalId_key: { principalId: 'plat-e3-http', key: 'idem-pg-key-a' } },
    });
    const rowB = await prisma.platformIdempotencyKey.findUniqueOrThrow({
      where: { principalId_key: { principalId: 'plat-e3-http', key: 'idem-pg-key-b' } },
    });
    const envelopeA = parseOwnerRecoveryIdempotencyHash(rowA.requestHash)!;
    const envelopeB = parseOwnerRecoveryIdempotencyHash(rowB.requestHash)!;
    expect(envelopeA.digest).toBe(digest);
    expect(envelopeB.digest).toBe(digest);
    expect(envelopeA.recoveryRequestId).not.toBe(envelopeB.recoveryRequestId);
    expect(encodeOwnerRecoveryIdempotencyHash(digest, envelopeA.recoveryRequestId)).toBe(rowA.requestHash);

    const replayA = await request(app).post(route).set('Idempotency-Key', 'idem-pg-key-a').send(body);
    expect(replayA.status).toBe(202);
    expect(replayA.body.status).toBe('owner_recovery_dispatched');
    expect(deliveryAdapter.deliveryCount).toBe(2);

    deliveryAdapter.setNextStatus('dispatched');
    const [retry1, retry2] = await Promise.all([
      request(app).post(route).set('Idempotency-Key', 'idem-pg-key-b').send(body),
      request(app).post(route).set('Idempotency-Key', 'idem-pg-key-b').send(body),
    ]);
    const outcomes = [retry1.body.status, retry2.body.status];
    expect(outcomes).toContain('owner_recovery_dispatched');
    expect(outcomes.every((status) =>
      status === 'owner_recovery_dispatched' || status === 'owner_recovery_pending',
    )).toBe(true);
    expect(deliveryAdapter.deliveryCount).toBe(3);
    expect(deliveryAdapter.sent.every((row) => row.hadSecret)).toBe(true);

    const rowBAfter = await prisma.platformIdempotencyKey.findUniqueOrThrow({
      where: { principalId_key: { principalId: 'plat-e3-http', key: 'idem-pg-key-b' } },
    });
    const envelopeBAfter = parseOwnerRecoveryIdempotencyHash(rowBAfter.requestHash)!;
    expect(envelopeBAfter.recoveryRequestId).not.toBe(envelopeB.recoveryRequestId);

    const replacementToken = deliveryAdapter.consumeLastSecret();
    expect(replacementToken).toBeTruthy();

    await expect(confirmOwnerPasswordRecovery({
      service,
      prisma,
      resetToken: tokenA!,
      newPassword: 'ShouldNotApplyFromKeyA-1!',
      requestId: 'req-pg-confirm-old-a',
    })).rejects.toMatchObject({
      messageKey: 'owner_recovery.invalid_or_expired',
    });

    await confirmOwnerPasswordRecovery({
      service,
      prisma,
      resetToken: replacementToken!,
      newPassword: 'PlatformHttpNew-456!',
      requestId: 'req-pg-confirm-replacement',
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: OWNER_ID } });
    expect(await bcrypt.compare('PlatformHttpNew-456!', user.password)).toBe(true);

    const conflict = await request(app)
      .post(route)
      .set('Idempotency-Key', 'idem-pg-key-a')
      .send({ ...body, approvalReference: 'TICKET-PG-E3-OTHER' });
    expect(conflict.status).toBe(409);

    const audits = await prisma.platformAuditLog.findMany({
      where: { principalId: 'plat-e3-http' },
    });
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(tokenA!);
    expect(serialized).not.toContain(replacementToken!);
    expect(serialized).not.toContain(OWNER_EMAIL);
  }, 90_000);

  it('rate-limits concurrent failed replacement retries under advisory lock', async () => {
    executeSql(`
      INSERT INTO "PlatformPrincipal" (
        "id", "email", "normalizedEmail", "password", "name", "status",
        "permissions", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        'plat-e3-rl', 'plat-e3-rl@example.test', 'plat-e3-rl@example.test', 'hash', 'Platform', 'active',
        '["platform.companies.owner_recovery.initiate"]', 1, 1, NOW(), NOW()
      )
      ON CONFLICT ("id") DO NOTHING;
    `);
    const oldHash = await bcrypt.hash('PlatformRlOld-123!', 4);
    resetOwnerRecoveryRequests();
    seedOwnerFixture(oldHash);
    executeSql(`
      INSERT INTO "LoginIdentity" (
        "id", "companyId", "userId", "type", "normalizedIdentifier", "createdAt", "updatedAt"
      ) VALUES (
        'li-e3-rl', '${COMPANY_ID}', '${OWNER_ID}', 'email', '${OWNER_EMAIL}', NOW(), NOW()
      )
      ON CONFLICT ("companyId", "normalizedIdentifier") DO UPDATE SET
        "userId" = EXCLUDED."userId";
    `);

    const deliveryAdapter = new CapturingRecoveryDeliveryAdapter();
    const service = ownerService(() => new Date('2026-07-28T17:00:00.000Z'));
    const rateLimiter = new RecoveryRateLimiter(
      new PostgresRecoveryRateLimitStore(prisma),
      RATE_PEPPER,
      {
        ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
        company_owner_recovery_initiate: {
          ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY.company_owner_recovery_initiate,
          actor: { windowMs: 60 * 60_000, blockLimit: 1, alertLimit: 1 },
          company: { windowMs: 60 * 60_000, blockLimit: 100, alertLimit: 50 },
          target: { windowMs: 60 * 60_000, blockLimit: 100, alertLimit: 50 },
          global: { windowMs: 60 * 60_000, blockLimit: 100, alertLimit: 50 },
        },
      },
      () => new Date('2026-07-28T17:00:00.000Z'),
    );
    const principal: PlatformPrincipalContext = {
      id: 'plat-e3-rl',
      email: 'plat-e3-rl@example.test',
      name: 'Platform',
      permissions: [PLATFORM_PERMISSIONS.COMPANIES_OWNER_RECOVERY_INITIATE],
      authorizationVersion: 1,
      sessionId: 'sess-plat-e3-rl',
      mfaVerifiedAt: new Date('2026-07-28T17:00:00.000Z'),
      credentialVersion: 1,
    };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      (req as { requestId?: string }).requestId = 'req-plat-e3-rl';
      res.locals.requestId = 'req-plat-e3-rl';
      next();
    });
    registerPlatformOwnerRecoveryRoutes({
      app,
      prisma,
      requirePlatformAuth: ((req, _res, next) => {
        (req as { platformPrincipal?: PlatformPrincipalContext }).platformPrincipal = principal;
        next();
      }) as express.RequestHandler,
      recoveryService: service,
      rateLimiter,
      deliveryAdapter,
      rateLimitPepper: RATE_PEPPER,
      clock: () => new Date('2026-07-28T17:00:00.000Z'),
      isProduction: false,
    });

    const route = `/api/platform/v1/companies/${COMPANY_ID}/owner-recovery/initiate`;
    const body = {
      reasonCategory: 'verified_owner_request' as const,
      approvalReference: 'TICKET-PG-E3-RL',
      confirmation: true as const,
    };
    deliveryAdapter.setNextStatus('failed');
    const first = await request(app).post(route).set('Idempotency-Key', 'idem-pg-rl').send(body);
    expect(first.status).toBe(503);
    const before = await prisma.platformIdempotencyKey.findUniqueOrThrow({
      where: { principalId_key: { principalId: 'plat-e3-rl', key: 'idem-pg-rl' } },
    });
    const rowsBefore = await prisma.credentialRecoveryRequest.count({
      where: { principalId: OWNER_ID, purpose: 'password_reset' },
    });

    deliveryAdapter.setNextStatus('dispatched');
    const [a, b] = await Promise.all([
      request(app).post(route).set('Idempotency-Key', 'idem-pg-rl').send(body),
      request(app).post(route).set('Idempotency-Key', 'idem-pg-rl').send(body),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([429, 429]);
    const after = await prisma.platformIdempotencyKey.findUniqueOrThrow({
      where: { principalId_key: { principalId: 'plat-e3-rl', key: 'idem-pg-rl' } },
    });
    expect(after.requestHash).toBe(before.requestHash);
    expect(await prisma.credentialRecoveryRequest.count({
      where: { principalId: OWNER_ID, purpose: 'password_reset' },
    })).toBe(rowsBefore);
    expect(deliveryAdapter.deliveryCount).toBe(1);
  }, 90_000);

  it('platform idempotency race keeps one recovery request for the same key', async () => {
    executeSql(`
      INSERT INTO "PlatformPrincipal" (
        "id", "email", "normalizedEmail", "password", "name", "status",
        "permissions", "authorizationVersion", "credentialVersion", "createdAt", "updatedAt"
      ) VALUES (
        'plat-e3', 'plat-e3@example.test', 'plat-e3@example.test', 'hash', 'Platform', 'active',
        '["platform.companies.owner_recovery.initiate"]', 1, 1, NOW(), NOW()
      )
      ON CONFLICT ("id") DO NOTHING;
    `);
    const oldHash = await bcrypt.hash('IdemOld-123!', 4);
    resetOwnerRecoveryRequests();
    seedOwnerFixture(oldHash);
    const service = ownerService(() => new Date('2026-07-28T14:30:00.000Z'));
    const digest = 'a'.repeat(64);
    const key = 'idem-e3-race-key';

    const issueWithIdempotency = async (requestId: string) => prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`mawared-owner-recovery-idem:plat-e3:${key}`}))
      `;
      const existing = await tx.platformIdempotencyKey.findUnique({
        where: { principalId_key: { principalId: 'plat-e3', key } },
      });
      if (existing) return null;
      const issued = await service.issueInTransaction(tx, {
        principalDomain: 'company_primary_owner',
        principalId: OWNER_ID,
        companyId: COMPANY_ID,
        purpose: 'password_reset',
        initiatedBy: 'platform_operator',
        initiatorPrincipalId: 'plat-e3',
        deliveryChannel: 'email',
        requestId,
        actorType: 'platform_owner',
        actorId: 'plat-e3',
      });
      await tx.platformIdempotencyKey.create({
        data: {
          principalId: 'plat-e3',
          key,
          requestHash: encodeOwnerRecoveryIdempotencyHash(digest, issued.recoveryRequestId),
          companyId: COMPANY_ID,
        },
      });
      return issued;
    });

    const [a, b] = await Promise.all([
      issueWithIdempotency('req-e3-idem-a'),
      issueWithIdempotency('req-e3-idem-b'),
    ]);
    const successes = [a, b].filter(Boolean);
    expect(successes).toHaveLength(1);
    expect(await prisma.platformIdempotencyKey.count({
      where: { principalId: 'plat-e3', key },
    })).toBe(1);
    const keyRow = await prisma.platformIdempotencyKey.findUniqueOrThrow({
      where: { principalId_key: { principalId: 'plat-e3', key } },
    });
    const envelope = parseOwnerRecoveryIdempotencyHash(keyRow.requestHash);
    expect(envelope?.digest).toBe(digest);
    expect(await prisma.credentialRecoveryRequest.count({
      where: {
        principalId: OWNER_ID,
        purpose: 'password_reset',
        consumedAt: null,
        invalidatedAt: null,
      },
    })).toBe(1);
  }, 60_000);

  it('creates rate-limit buckets atomically without raw identifiers', async () => {
    const now = new Date('2026-07-28T15:00:00.000Z');
    const clientA = new PrismaClient({ datasources: { db: { url: urlFor(databaseName) } } });
    const clientB = new PrismaClient({ datasources: { db: { url: urlFor(databaseName) } } });
    try {
      const limiterA = new RecoveryRateLimiter(
        new PostgresRecoveryRateLimitStore(clientA),
        RATE_PEPPER,
        {
          ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
          company_owner_recovery_initiate: {
            source: { windowMs: 60_000, blockLimit: 12, alertLimit: 6 },
          },
        },
        () => now,
      );
      const limiterB = new RecoveryRateLimiter(
        new PostgresRecoveryRateLimitStore(clientB),
        RATE_PEPPER,
        {
          ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
          company_owner_recovery_initiate: {
            source: { windowMs: 60_000, blockLimit: 12, alertLimit: 6 },
          },
        },
        () => now,
      );

      const decisions = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? limiterA : limiterB).check({
          surface: 'company_owner_recovery_initiate',
          dimension: 'source',
          rawKey: `owner-initiate:${OWNER_EMAIL}`,
          now,
        }),
      ));
      expect(decisions.filter((d) => d.allowed).length).toBe(12);
      expect(decisions.filter((d) => !d.allowed).length).toBe(8);

      const buckets = await prisma.credentialRecoveryRateLimitBucket.findMany({
        where: { surface: 'company_owner_recovery_initiate', dimension: 'source' },
      });
      expect(buckets.length).toBeGreaterThanOrEqual(1);
      for (const bucket of buckets) {
        expect(bucket.bucketKeyHash).toMatch(/^[a-f0-9]{64}$/);
        expect(bucket.bucketKeyHash).not.toContain(OWNER_EMAIL);
        expect(JSON.stringify(bucket)).not.toContain(OWNER_EMAIL);
      }
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  }, 60_000);

  it('never stores raw email or token in recovery audit or company audit logs', async () => {
    const oldHash = await bcrypt.hash('AuditOld-123!', 4);
    resetOwnerRecoveryRequests();
    seedOwnerFixture(oldHash);
    const service = ownerService(() => new Date('2026-07-28T15:30:00.000Z'));
    const issued = await issueOwnerRecovery('req-e3-audit-issue', service);
    if (!issued.ok || !issued.value.deliverySecret) return;
    const token = issued.value.deliverySecret.reveal();

    await confirmOwnerPasswordRecovery({
      service,
      prisma,
      resetToken: token,
      newPassword: 'AuditNewPass-456!',
      requestId: 'req-e3-audit-confirm',
    });

    const recoveryAudits = await prisma.credentialRecoveryAuditEvent.findMany({
      where: { subjectId: OWNER_ID },
    });
    const companyAudits = await prisma.auditLog.findMany({
      where: { userId: OWNER_ID, action: 'company.owner_recovery.completed' },
    });
    const serialized = JSON.stringify({ recoveryAudits, companyAudits });
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(OWNER_EMAIL);
  }, 60_000);
});
