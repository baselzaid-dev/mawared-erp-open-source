import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import {
  createEmployeeAdminResetRateLimiter,
  resetEmployeeCredential,
} from '../src/employeeCredentialReset';
import { executeForcedPasswordChange } from '../src/forcedPasswordChange';
import { PERMISSIONS } from '../src/permissions';
import { verifyPassword } from '../src/credentialSecrets';

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
const backendRoot = resolve(process.cwd());
const prismaCli = resolve(backendRoot, 'node_modules/prisma/build/index.js');
const hasDisposablePostgres = Boolean(initdb && pgCtl && createdb && existsSync(prismaCli));
const suite = hasDisposablePostgres ? describe : describe.skip;

const RATE_PEPPER = 'e2-pg-recovery-rate-limit-pepper-32chars!';

suite('E2 employee credential reset on disposable PostgreSQL', () => {
  const databaseUser = 'mawared_e2';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let port = 0;
  let prisma: PrismaClient;
  let databaseName = 'mawared_recovery_e2';

  const companyId = randomUUID();
  const ownerUserId = randomUUID();
  const hrUserId = randomUUID();
  const mgrUserId = randomUUID();
  const grantOnlyUserId = randomUUID();
  const targetUserId = randomUUID();
  const ownerEmployeeId = randomUUID();
  const hrEmployeeId = randomUUID();
  const mgrEmployeeId = randomUUID();
  const grantOnlyEmployeeId = randomUUID();
  const targetEmployeeId = randomUUID();
  const roleEmployeeId = randomUUID();
  const roleHrId = randomUUID();
  const roleDeptMgrId = randomUUID();
  const roleBareId = randomUUID();
  const departmentId = randomUUID();
  const otherDepartmentId = randomUUID();
  const deptManagerMembershipId = randomUUID();
  const accessGrantId = randomUUID();
  const temporaryDelegationId = randomUUID();

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
      && basename(workDirectory).startsWith('mawared-e2-pg-')
    ) {
      rmSync(workDirectory, { recursive: true, force: true });
    }
  };

  beforeAll(async () => {
    workDirectory = mkdtempSync(join(tmpdir(), 'mawared-e2-pg-'));
    clusterDirectory = join(workDirectory, 'pgdata');
    port = await reserveLocalPort();

    runQuietly('initdb', initdb!, [
      '--pgdata', clusterDirectory,
      '--username', databaseUser,
      '--auth', 'trust',
      '--encoding', 'UTF8',
      '--no-locale',
      '--no-instructions',
    ]);
    runQuietly('pg_ctl start', pgCtl!, [
      '--pgdata', clusterDirectory,
      '--wait',
      '-o', `-p ${port} -h 127.0.0.1`,
      'start',
    ]);
    clusterStarted = true;
    runQuietly('createdb', createdb!, [
      '-h', '127.0.0.1',
      '-p', String(port),
      '-U', databaseUser,
      databaseName,
    ]);
    runQuietly('prisma migrate deploy', process.execPath, [
      prismaCli, 'migrate', 'deploy',
    ], {
      cwd: backendRoot,
      env: databaseEnvironment(databaseName),
    });

    prisma = new PrismaClient({ datasources: { db: { url: urlFor(databaseName) } } });
    await prisma.$connect();

    const passwordHash = await bcrypt.hash('Seed-password-1', 4);
    await prisma.$transaction(async (tx) => {
      await tx.company.create({
        data: { id: companyId, code: 'E2CO', name: 'E2 Company' },
      });
      await tx.role.createMany({
        data: [
          {
            id: roleEmployeeId,
            companyId,
            name: 'Employee',
            permissions: JSON.stringify([PERMISSIONS.DASHBOARD_SELF]),
          },
          {
            id: roleHrId,
            companyId,
            name: 'HR',
            permissions: JSON.stringify([
              PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
              PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
              PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
            ]),
          },
          {
            id: roleDeptMgrId,
            companyId,
            name: 'DeptManager',
            permissions: JSON.stringify([
              PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
              PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
              PERMISSIONS.PERMISSIONS_MANAGE_DEPARTMENT,
            ]),
          },
          {
            id: roleBareId,
            companyId,
            name: 'Bare',
            permissions: JSON.stringify([PERMISSIONS.DASHBOARD_SELF]),
          },
        ],
      });
      await tx.department.createMany({
        data: [
          { id: departmentId, companyId, name: 'Ops' },
          { id: otherDepartmentId, companyId, name: 'Other' },
        ],
      });

      await tx.employee.createMany({
        data: [
          {
            id: ownerEmployeeId,
            companyId,
            departmentId,
            employeeNum: 'OWN-1',
            normalizedEmployeeNum: 'OWN-1',
            jobTitle: 'Owner',
            status: 'active',
            joiningDate: new Date('2026-01-01'),
          },
          {
            id: hrEmployeeId,
            companyId,
            departmentId,
            employeeNum: 'HR-1',
            normalizedEmployeeNum: 'HR-1',
            jobTitle: 'HR',
            status: 'active',
            joiningDate: new Date('2026-01-01'),
          },
          {
            id: mgrEmployeeId,
            companyId,
            departmentId,
            employeeNum: 'MGR-1',
            normalizedEmployeeNum: 'MGR-1',
            jobTitle: 'Dept Mgr',
            status: 'active',
            joiningDate: new Date('2026-01-01'),
          },
          {
            id: grantOnlyEmployeeId,
            companyId,
            departmentId,
            employeeNum: 'GRN-1',
            normalizedEmployeeNum: 'GRN-1',
            jobTitle: 'Grant Only',
            status: 'active',
            joiningDate: new Date('2026-01-01'),
          },
          {
            id: targetEmployeeId,
            companyId,
            departmentId,
            employeeNum: 'EMP-1',
            normalizedEmployeeNum: 'EMP-1',
            jobTitle: 'Staff',
            status: 'active',
            joiningDate: new Date('2026-01-01'),
          },
        ],
      });

      await tx.user.createMany({
        data: [
          {
            id: ownerUserId,
            companyId,
            employeeId: ownerEmployeeId,
            email: 'owner@example.com',
            normalizedEmail: 'owner@example.com',
            password: passwordHash,
            name: 'Owner',
            roleId: roleHrId,
            accountStatus: 'active',
            credentialVersion: 1,
            authorizationVersion: 1,
          },
          {
            id: hrUserId,
            companyId,
            employeeId: hrEmployeeId,
            email: 'hr@example.com',
            normalizedEmail: 'hr@example.com',
            password: passwordHash,
            name: 'HR',
            roleId: roleHrId,
            accountStatus: 'active',
            credentialVersion: 1,
            authorizationVersion: 1,
          },
          {
            id: mgrUserId,
            companyId,
            employeeId: mgrEmployeeId,
            email: 'mgr@example.com',
            normalizedEmail: 'mgr@example.com',
            password: passwordHash,
            name: 'DeptMgr',
            roleId: roleDeptMgrId,
            accountStatus: 'active',
            credentialVersion: 1,
            authorizationVersion: 1,
          },
          {
            id: grantOnlyUserId,
            companyId,
            employeeId: grantOnlyEmployeeId,
            email: 'grant@example.com',
            normalizedEmail: 'grant@example.com',
            password: passwordHash,
            name: 'GrantOnly',
            roleId: roleBareId,
            accountStatus: 'active',
            credentialVersion: 1,
            authorizationVersion: 1,
          },
          {
            id: targetUserId,
            companyId,
            employeeId: targetEmployeeId,
            email: 'target@example.com',
            normalizedEmail: 'target@example.com',
            password: passwordHash,
            name: 'Target',
            roleId: roleEmployeeId,
            accountStatus: 'active',
            credentialVersion: 3,
            authorizationVersion: 1,
            mustChangePassword: false,
          },
        ],
      });

      await tx.companyOwnership.create({
        data: {
          companyId,
          userId: ownerUserId,
          isPrimary: true,
          status: 'active',
          activePrimaryCompanyId: companyId,
          createdByUserId: ownerUserId,
        },
      });

      await tx.departmentManager.create({
        data: {
          id: deptManagerMembershipId,
          companyId,
          departmentId,
          userId: mgrUserId,
          status: 'active',
          assignedByUserId: ownerUserId,
        },
      });

      await tx.accessGrant.create({
        data: {
          id: accessGrantId,
          companyId,
          recipientUserId: grantOnlyUserId,
          capability: PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
          scopeType: 'company',
          grantedByUserId: ownerUserId,
          reason: 'e2-race-seed',
          status: 'active',
        },
      });
      await tx.accessGrant.createMany({
        data: [
          {
            companyId,
            recipientUserId: grantOnlyUserId,
            capability: PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
            scopeType: 'company',
            grantedByUserId: ownerUserId,
            reason: 'e2-race-seed',
            status: 'active',
          },
          {
            companyId,
            recipientUserId: grantOnlyUserId,
            capability: PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
            scopeType: 'company',
            grantedByUserId: ownerUserId,
            reason: 'e2-race-seed',
            status: 'active',
          },
        ],
      });

      await tx.temporaryDelegation.create({
        data: {
          id: temporaryDelegationId,
          companyId,
          delegatorUserId: ownerUserId,
          recipientUserId: grantOnlyUserId,
          scopeType: 'company',
          validFrom: new Date(Date.now() - 3_600_000),
          validUntil: new Date(Date.now() + 3_600_000),
          reason: 'e2-delegation-seed',
          idempotencyKey: `e2-del-${temporaryDelegationId}`,
          status: 'active',
        },
      });
      await tx.delegationCapability.create({
        data: {
          companyId,
          delegationId: temporaryDelegationId,
          capability: PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
        },
      });
    });

    await prisma.refreshToken.createMany({
      data: [
        {
          sessionId: randomUUID(),
          userId: targetUserId,
          companyId,
          tokenHash: `hash-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 86_400_000),
          credentialVersion: 3,
        },
        {
          sessionId: randomUUID(),
          userId: targetUserId,
          companyId,
          tokenHash: `hash-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 86_400_000),
          credentialVersion: 3,
        },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await stopAndClean();
  }, 60_000);

  it('concurrent resets with the same expectedCredentialVersion yield exactly one success', async () => {
    const actor = {
      id: hrUserId,
      companyId,
      employeeId: hrEmployeeId,
      permissions: [
        PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
        PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
        PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
      ],
    };
    const limiter = createEmployeeAdminResetRateLimiter(prisma, RATE_PEPPER, {
      useInMemoryStore: true,
    });

    const results = await Promise.allSettled([
      resetEmployeeCredential({
        prisma,
        actor,
        employeeId: targetEmployeeId,
        reason: 'forgotten_password',
        expectedCredentialVersion: 3,
        rateLimiter: limiter,
        requestId: 'pg-a',
      }),
      resetEmployeeCredential({
        prisma,
        actor,
        employeeId: targetEmployeeId,
        reason: 'suspected_compromise',
        expectedCredentialVersion: 3,
        rateLimiter: limiter,
        requestId: 'pg-b',
      }),
    ]);

    const fulfilled = results.filter((row) => row.status === 'fulfilled') as Array<PromiseFulfilledResult<{
      temporaryPassword: string;
      credentialVersion: number;
    }>>;
    const rejected = results.filter((row) => row.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0].value.credentialVersion).toBe(4);
    expect(fulfilled[0].value.temporaryPassword.length).toBeGreaterThan(10);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: targetUserId } });
    expect(user.credentialVersion).toBe(4);
    expect(user.mustChangePassword).toBe(true);
    expect(user.passwordChangedAt).toBeTruthy();
    expect(await verifyPassword(fulfilled[0].value.temporaryPassword, user.password)).toBe(true);

    const activeSessions = await prisma.refreshToken.count({
      where: { userId: targetUserId, companyId, revokedAt: null },
    });
    expect(activeSessions).toBe(0);

    const audits = await prisma.auditLog.findMany({
      where: { companyId, action: 'employee.credentials.reset' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].details).toMatch(/forgotten_password|suspected_compromise/);
    expect(audits[0].details).not.toContain(fulfilled[0].value.temporaryPassword);

    const notifications = await prisma.notification.findMany({
      where: { companyId, userId: targetUserId },
    });
    expect(notifications).toHaveLength(1);
    expect(JSON.stringify(notifications[0])).not.toContain(fulfilled[0].value.temporaryPassword);
  }, 60_000);

  it('forced-change concurrency yields exactly one success and invalidates the temporary password', async () => {
    const userBefore = await prisma.user.findUniqueOrThrow({ where: { id: targetUserId } });
    const tempPlain = (
      await resetEmployeeCredential({
        prisma,
        actor: {
          id: hrUserId,
          companyId,
          employeeId: hrEmployeeId,
          permissions: [
            PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
            PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
            PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
          ],
        },
        employeeId: targetEmployeeId,
        reason: 'administrative_rotation',
        expectedCredentialVersion: userBefore.credentialVersion,
        rateLimiter: createEmployeeAdminResetRateLimiter(prisma, RATE_PEPPER, {
          useInMemoryStore: true,
        }),
      })
    ).temporaryPassword;

    expect((await prisma.user.findUniqueOrThrow({ where: { id: targetUserId } })).mustChangePassword).toBe(true);

    const results = await Promise.allSettled([
      executeForcedPasswordChange(prisma, { id: targetUserId, companyId }, {
        temporaryPassword: tempPlain,
        newPassword: 'BrandNewPass99',
        confirmPassword: 'BrandNewPass99',
      }),
      executeForcedPasswordChange(prisma, { id: targetUserId, companyId }, {
        temporaryPassword: tempPlain,
        newPassword: 'OtherNewPass99',
        confirmPassword: 'OtherNewPass99',
      }),
    ]);

    const fulfilled = results.filter((row) => row.status === 'fulfilled');
    const rejected = results.filter((row) => row.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: targetUserId } });
    expect(user.mustChangePassword).toBe(false);
    expect(user.temporaryPasswordExpiresAt).toBeNull();
    expect(await verifyPassword(tempPlain, user.password)).toBe(false);
    expect(
      await verifyPassword('BrandNewPass99', user.password)
      || await verifyPassword('OtherNewPass99', user.password),
    ).toBe(true);
  }, 60_000);

  it('denies Primary Owner reset under real locks', async () => {
    await expect(resetEmployeeCredential({
      prisma,
      actor: {
        id: hrUserId,
        companyId,
        employeeId: hrEmployeeId,
        permissions: [
          PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
          PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
          PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
        ],
      },
      employeeId: ownerEmployeeId,
      reason: 'access_recovery',
      expectedCredentialVersion: 1,
      rateLimiter: createEmployeeAdminResetRateLimiter(prisma, RATE_PEPPER, {
        useInMemoryStore: true,
      }),
    })).rejects.toMatchObject({
      status: 403,
      messageKey: 'credentials.reset_forbidden',
    });
  }, 30_000);

  const hrActor = () => ({
    id: hrUserId,
    companyId,
    employeeId: hrEmployeeId,
    permissions: [
      PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
      PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
      PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
    ],
  });

  const mgrActor = () => ({
    id: mgrUserId,
    companyId,
    employeeId: mgrEmployeeId,
    permissions: [
      PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
      PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
      PERMISSIONS.PERMISSIONS_MANAGE_DEPARTMENT,
    ],
  });

  const grantActor = () => ({
    id: grantOnlyUserId,
    companyId,
    employeeId: grantOnlyEmployeeId,
    permissions: [
      PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
      PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
      PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
    ],
  });

  async function snapshotTarget() {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: targetUserId } });
    const employee = await prisma.employee.findUniqueOrThrow({ where: { id: targetEmployeeId } });
    const refresh = await prisma.refreshToken.findMany({
      where: { userId: targetUserId },
      orderBy: { sessionId: 'asc' },
      select: {
        sessionId: true,
        revokedAt: true,
        revokedReason: true,
        credentialVersion: true,
        tokenHash: true,
      },
    });
    const audits = await prisma.auditLog.count({
      where: { companyId, action: 'employee.credentials.reset' },
    });
    const notifications = await prisma.notification.count({
      where: { companyId, userId: targetUserId },
    });
    const ownership = await prisma.companyOwnership.findMany({
      where: { companyId },
      orderBy: { id: 'asc' },
    });
    return { user, employee, refresh, audits, notifications, ownership };
  }

  async function assertNoCredentialSideEffects(
    before: Awaited<ReturnType<typeof snapshotTarget>>,
  ) {
    const after = await snapshotTarget();
    expect(after.user.password).toBe(before.user.password);
    expect(after.user.credentialVersion).toBe(before.user.credentialVersion);
    expect(after.user.mustChangePassword).toBe(before.user.mustChangePassword);
    expect(after.user.temporaryPasswordExpiresAt?.getTime() ?? null)
      .toBe(before.user.temporaryPasswordExpiresAt?.getTime() ?? null);
    expect(after.user.authorizationVersion).toBe(before.user.authorizationVersion);
    expect(after.refresh).toEqual(before.refresh);
    expect(after.audits).toBe(before.audits);
    expect(after.notifications).toBe(before.notifications);
    expect(after.ownership.map((row) => ({
      id: row.id,
      userId: row.userId,
      isPrimary: row.isPrimary,
      status: row.status,
      activePrimaryCompanyId: row.activePrimaryCompanyId,
    }))).toEqual(before.ownership.map((row) => ({
      id: row.id,
      userId: row.userId,
      isPrimary: row.isPrimary,
      status: row.status,
      activePrimaryCompanyId: row.activePrimaryCompanyId,
    })));
    return after;
  }

  async function restoreTargetBaseline(passwordHash?: string) {
    const hash = passwordHash
      ?? (await prisma.user.findUniqueOrThrow({ where: { id: targetUserId } })).password;
    await prisma.employee.update({
      where: { id: targetEmployeeId },
      data: {
        status: 'active',
        archivedAt: null,
        archivedByUserId: null,
        archiveReason: null,
        departmentId,
      },
    });
    await prisma.user.update({
      where: { id: targetUserId },
      data: {
        password: hash,
        accountStatus: 'active',
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
        passwordChangedAt: null,
        credentialVersion: 10,
        authorizationVersion: 1,
        roleId: roleEmployeeId,
      },
    });
    await prisma.$transaction(async (tx) => {
      const targetPrimary = await tx.companyOwnership.findFirst({
        where: { companyId, userId: targetUserId, status: 'active', isPrimary: true },
      });
      const ownerPrimary = await tx.companyOwnership.findFirst({
        where: { companyId, userId: ownerUserId, status: 'active', isPrimary: true },
      });
      if (targetPrimary && !ownerPrimary) {
        await tx.companyOwnership.create({
          data: {
            companyId,
            userId: ownerUserId,
            isPrimary: true,
            status: 'active',
            createdByUserId: ownerUserId,
          },
        });
        await tx.companyOwnership.updateMany({
          where: { companyId, userId: targetUserId, status: 'active' },
          data: {
            status: 'ended',
            isPrimary: false,
            endedAt: new Date(),
            endedByUserId: ownerUserId,
          },
        });
      } else if (targetPrimary && ownerPrimary) {
        await tx.companyOwnership.updateMany({
          where: { companyId, userId: targetUserId, status: 'active' },
          data: {
            status: 'ended',
            isPrimary: false,
            endedAt: new Date(),
            endedByUserId: ownerUserId,
          },
        });
      } else if (!ownerPrimary) {
        await tx.companyOwnership.create({
          data: {
            companyId,
            userId: ownerUserId,
            isPrimary: true,
            status: 'active',
            createdByUserId: ownerUserId,
          },
        });
      }
    });
    await prisma.refreshToken.deleteMany({ where: { userId: targetUserId } });
    await prisma.refreshToken.create({
      data: {
        sessionId: randomUUID(),
        userId: targetUserId,
        companyId,
        tokenHash: `hash-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        credentialVersion: 10,
      },
    });
  }

  it('race A: target archived between request and authorization → deny, no write', async () => {
    await restoreTargetBaseline();
    const before = await snapshotTarget();

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "Employee"
        WHERE id = ${targetEmployeeId} AND "companyId" = ${companyId}
        FOR UPDATE
      `;
      await tx.employee.update({
        where: { id: targetEmployeeId },
        data: {
          archivedAt: new Date(),
          archivedByUserId: hrUserId,
          archiveReason: 'e2-race-archive',
          status: 'inactive',
        },
      });
    });

    await expect(resetEmployeeCredential({
      prisma,
      actor: hrActor(),
      employeeId: targetEmployeeId,
      reason: 'forgotten_password',
      expectedCredentialVersion: before.user.credentialVersion,
      rateLimiter: createEmployeeAdminResetRateLimiter(prisma, RATE_PEPPER, {
        useInMemoryStore: true,
      }),
    })).rejects.toMatchObject({
      status: 404,
      messageKey: 'credentials.employee_not_found',
    });

    await assertNoCredentialSideEffects(before);
    await prisma.employee.update({
      where: { id: targetEmployeeId },
      data: {
        archivedAt: null,
        archivedByUserId: null,
        archiveReason: null,
        status: 'active',
      },
    });
  }, 60_000);

  it('race B: target status inactive/terminated → deny, no write', async () => {
    await restoreTargetBaseline();
    const before = await snapshotTarget();
    await prisma.employee.update({
      where: { id: targetEmployeeId },
      data: { status: 'terminated' },
    });

    await expect(resetEmployeeCredential({
      prisma,
      actor: hrActor(),
      employeeId: targetEmployeeId,
      reason: 'access_recovery',
      expectedCredentialVersion: before.user.credentialVersion,
      rateLimiter: createEmployeeAdminResetRateLimiter(prisma, RATE_PEPPER, {
        useInMemoryStore: true,
      }),
    })).rejects.toMatchObject({
      status: 404,
      messageKey: 'credentials.employee_not_found',
    });

    await assertNoCredentialSideEffects(before);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: targetEmployeeId } })).status)
      .toBe('terminated');
    await prisma.employee.update({
      where: { id: targetEmployeeId },
      data: { status: 'active' },
    });
  }, 60_000);

  it('race C: target moved to another Department uses post-lock Department', async () => {
    await restoreTargetBaseline();
    // Ensure dept manager can reset while target is in managed dept.
    const allowed = await resetEmployeeCredential({
      prisma,
      actor: mgrActor(),
      employeeId: targetEmployeeId,
      reason: 'forgotten_password',
      expectedCredentialVersion: 10,
      rateLimiter: createEmployeeAdminResetRateLimiter(prisma, RATE_PEPPER, {
        useInMemoryStore: true,
      }),
    });
    expect(allowed.credentialVersion).toBe(11);
    expect(allowed.temporaryPassword.length).toBeGreaterThan(10);

    // Restore and move out of managed department under a held employee lock.
    const hash = (await prisma.user.findUniqueOrThrow({ where: { id: targetUserId } })).password;
    await restoreTargetBaseline(hash);
    const before = await snapshotTarget();

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "Employee"
        WHERE id = ${targetEmployeeId} AND "companyId" = ${companyId}
        FOR UPDATE
      `;
      await tx.employee.update({
        where: { id: targetEmployeeId },
        data: { departmentId: otherDepartmentId },
      });
    });

    await expect(resetEmployeeCredential({
      prisma,
      actor: mgrActor(),
      employeeId: targetEmployeeId,
      reason: 'suspected_compromise',
      expectedCredentialVersion: before.user.credentialVersion,
      rateLimiter: createEmployeeAdminResetRateLimiter(prisma, RATE_PEPPER, {
        useInMemoryStore: true,
      }),
    })).rejects.toMatchObject({
      status: 403,
      messageKey: 'credentials.reset_forbidden',
    });

    await assertNoCredentialSideEffects(before);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: targetEmployeeId } })).departmentId)
      .toBe(otherDepartmentId);
  }, 90_000);

  it('race D: target promoted to active Primary Owner → deny, no write', async () => {
    await restoreTargetBaseline();
    const before = await snapshotTarget();

    await prisma.$transaction(async (tx) => {
      // Insert successor first so the last-primary guard allows ending the old row.
      await tx.companyOwnership.create({
        data: {
          companyId,
          userId: targetUserId,
          isPrimary: true,
          status: 'active',
          createdByUserId: ownerUserId,
        },
      });
      await tx.companyOwnership.updateMany({
        where: { companyId, userId: ownerUserId, status: 'active' },
        data: {
          status: 'ended',
          isPrimary: false,
          endedAt: new Date(),
          endedByUserId: ownerUserId,
        },
      });
    });

    await expect(resetEmployeeCredential({
      prisma,
      actor: hrActor(),
      employeeId: targetEmployeeId,
      reason: 'administrative_rotation',
      expectedCredentialVersion: before.user.credentialVersion,
      rateLimiter: createEmployeeAdminResetRateLimiter(prisma, RATE_PEPPER, {
        useInMemoryStore: true,
      }),
    })).rejects.toMatchObject({
      status: 403,
      messageKey: 'credentials.reset_forbidden',
    });

    const afterUser = await prisma.user.findUniqueOrThrow({ where: { id: targetUserId } });
    expect(afterUser.password).toBe(before.user.password);
    expect(afterUser.credentialVersion).toBe(before.user.credentialVersion);
    expect(await prisma.auditLog.count({
      where: { companyId, action: 'employee.credentials.reset' },
    })).toBe(before.audits);
    expect(await prisma.notification.count({
      where: { companyId, userId: targetUserId },
    })).toBe(before.notifications);
    expect(await prisma.refreshToken.count({
      where: { userId: targetUserId, revokedAt: null },
    })).toBe(before.refresh.filter((row) => row.revokedAt == null).length);

    // Restore ownership for later tests (successor first, then end target).
    await prisma.$transaction(async (tx) => {
      await tx.companyOwnership.create({
        data: {
          companyId,
          userId: ownerUserId,
          isPrimary: true,
          status: 'active',
          createdByUserId: ownerUserId,
        },
      });
      await tx.companyOwnership.updateMany({
        where: { companyId, userId: targetUserId, status: 'active' },
        data: {
          status: 'ended',
          isPrimary: false,
          endedAt: new Date(),
          endedByUserId: ownerUserId,
        },
      });
    });
  }, 60_000);

  it('race E: actor reset permission revoked under actor-row serialization → deny', async () => {
    await restoreTargetBaseline();
    const before = await snapshotTarget();
    const hrAuthBefore = (
      await prisma.user.findUniqueOrThrow({ where: { id: hrUserId } })
    ).authorizationVersion;

    const holdAndRevoke = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "User"
        WHERE id = ${hrUserId} AND "companyId" = ${companyId}
        FOR UPDATE
      `;
      await new Promise((resolve) => setTimeout(resolve, 400));
      await tx.role.update({
        where: { id: roleHrId },
        data: {
          permissions: JSON.stringify([
            PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
            PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
          ]),
        },
      });
      await tx.user.update({
        where: { id: hrUserId },
        data: { authorizationVersion: { increment: 1 } },
      });
    }, { timeout: 20_000 });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const resetPromise = resetEmployeeCredential({
      prisma,
      actor: hrActor(), // stale JWT-style hint still lists reset
      employeeId: targetEmployeeId,
      reason: 'forgotten_password',
      expectedCredentialVersion: before.user.credentialVersion,
      rateLimiter: createEmployeeAdminResetRateLimiter(prisma, RATE_PEPPER, {
        useInMemoryStore: true,
      }),
    });

    const [, resetResult] = await Promise.allSettled([holdAndRevoke, resetPromise]);
    expect(resetResult.status).toBe('rejected');
    if (resetResult.status === 'rejected') {
      expect(resetResult.reason).toMatchObject({
        status: 403,
        messageKey: 'credentials.reset_forbidden',
      });
    }

    await assertNoCredentialSideEffects(before);
    const hrAuthAfter = (
      await prisma.user.findUniqueOrThrow({ where: { id: hrUserId } })
    ).authorizationVersion;
    expect(hrAuthAfter).toBe(hrAuthBefore + 1);

    // Restore HR role for later tests.
    await prisma.role.update({
      where: { id: roleHrId },
      data: {
        permissions: JSON.stringify([
          PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET,
          PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
          PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
        ]),
      },
    });
  }, 90_000);

  it('race F: DepartmentManager assignment revoked → deny, no write', async () => {
    await restoreTargetBaseline();
    await prisma.employee.update({
      where: { id: targetEmployeeId },
      data: { departmentId },
    });
    const before = await snapshotTarget();
    const mgrAuthBefore = (
      await prisma.user.findUniqueOrThrow({ where: { id: mgrUserId } })
    ).authorizationVersion;

    const holdAndEnd = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "User"
        WHERE id = ${mgrUserId} AND "companyId" = ${companyId}
        FOR UPDATE
      `;
      await new Promise((resolve) => setTimeout(resolve, 400));
      await tx.departmentManager.update({
        where: { id: deptManagerMembershipId },
        data: {
          status: 'ended',
          endedAt: new Date(),
          endedByUserId: ownerUserId,
        },
      });
      await tx.user.update({
        where: { id: mgrUserId },
        data: { authorizationVersion: { increment: 1 } },
      });
    }, { timeout: 20_000 });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const resetPromise = resetEmployeeCredential({
      prisma,
      actor: mgrActor(),
      employeeId: targetEmployeeId,
      reason: 'access_recovery',
      expectedCredentialVersion: before.user.credentialVersion,
      rateLimiter: createEmployeeAdminResetRateLimiter(prisma, RATE_PEPPER, {
        useInMemoryStore: true,
      }),
    });

    const [, resetResult] = await Promise.allSettled([holdAndEnd, resetPromise]);
    expect(resetResult.status).toBe('rejected');
    if (resetResult.status === 'rejected') {
      expect(resetResult.reason).toMatchObject({
        status: 403,
        messageKey: 'credentials.reset_forbidden',
      });
    }

    await assertNoCredentialSideEffects(before);
    expect((
      await prisma.user.findUniqueOrThrow({ where: { id: mgrUserId } })
    ).authorizationVersion).toBe(mgrAuthBefore + 1);

    await prisma.departmentManager.update({
      where: { id: deptManagerMembershipId },
      data: {
        status: 'active',
        endedAt: null,
        endedByUserId: null,
      },
    });
  }, 90_000);

  it('race G: target credentialVersion changes before lock → stale 412, no second secret', async () => {
    await restoreTargetBaseline();
    const before = await snapshotTarget();

    const bump = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "User"
        WHERE id = ${targetUserId} AND "companyId" = ${companyId}
        FOR UPDATE
      `;
      await new Promise((resolve) => setTimeout(resolve, 400));
      await tx.user.update({
        where: { id: targetUserId },
        data: { credentialVersion: { increment: 1 } },
      });
    }, { timeout: 20_000 });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const resetPromise = resetEmployeeCredential({
      prisma,
      actor: hrActor(),
      employeeId: targetEmployeeId,
      reason: 'forgotten_password',
      expectedCredentialVersion: before.user.credentialVersion,
      rateLimiter: createEmployeeAdminResetRateLimiter(prisma, RATE_PEPPER, {
        useInMemoryStore: true,
      }),
    });

    const [, resetResult] = await Promise.allSettled([bump, resetPromise]);
    expect(resetResult.status).toBe('rejected');
    if (resetResult.status === 'rejected') {
      expect(resetResult.reason).toMatchObject({
        status: 412,
        messageKey: 'credentials.stale_credential_version',
      });
    }

    const after = await prisma.user.findUniqueOrThrow({ where: { id: targetUserId } });
    expect(after.password).toBe(before.user.password);
    expect(after.credentialVersion).toBe(before.user.credentialVersion + 1);
    expect(after.mustChangePassword).toBe(false);
    expect(await prisma.auditLog.count({
      where: { companyId, action: 'employee.credentials.reset' },
    })).toBe(before.audits);
    expect(await prisma.notification.count({
      where: { companyId, userId: targetUserId },
    })).toBe(before.notifications);
    expect(await prisma.refreshToken.count({
      where: { userId: targetUserId, revokedReason: 'credential_reset' },
    })).toBe(0);
  }, 90_000);

  it('revoked AccessGrant between middleware hint and transaction → deny', async () => {
    await restoreTargetBaseline();
    const before = await snapshotTarget();

    await prisma.accessGrant.updateMany({
      where: { recipientUserId: grantOnlyUserId, companyId, status: 'active' },
      data: {
        status: 'revoked',
        revokedAt: new Date(),
        revokedByUserId: ownerUserId,
      },
    });
    await prisma.temporaryDelegation.update({
      where: { id: temporaryDelegationId },
      data: {
        status: 'revoked',
        revokedAt: new Date(),
        revokedByUserId: ownerUserId,
      },
    });
    await prisma.user.update({
      where: { id: grantOnlyUserId },
      data: { authorizationVersion: { increment: 1 } },
    });

    await expect(resetEmployeeCredential({
      prisma,
      actor: grantActor(),
      employeeId: targetEmployeeId,
      reason: 'suspected_compromise',
      expectedCredentialVersion: before.user.credentialVersion,
      rateLimiter: createEmployeeAdminResetRateLimiter(prisma, RATE_PEPPER, {
        useInMemoryStore: true,
      }),
    })).rejects.toMatchObject({
      status: 403,
      messageKey: 'credentials.reset_forbidden',
    });

    await assertNoCredentialSideEffects(before);
  }, 60_000);

  it('expired TemporaryDelegation between middleware hint and transaction → deny', async () => {
    // Re-activate grants briefly then expire only the delegation and revoke grants
    // so the actor depends solely on an expired delegation for reset capability.
    await prisma.accessGrant.updateMany({
      where: { recipientUserId: grantOnlyUserId, companyId },
      data: {
        status: 'revoked',
        revokedAt: new Date(),
        revokedByUserId: ownerUserId,
      },
    });
    await prisma.temporaryDelegation.update({
      where: { id: temporaryDelegationId },
      data: {
        status: 'active',
        revokedAt: null,
        revokedByUserId: null,
        validFrom: new Date(Date.now() - 7_200_000),
        validUntil: new Date(Date.now() - 60_000),
      },
    });
    await prisma.user.update({
      where: { id: grantOnlyUserId },
      data: { authorizationVersion: { increment: 1 } },
    });

    await restoreTargetBaseline();
    const before = await snapshotTarget();

    await expect(resetEmployeeCredential({
      prisma,
      actor: grantActor(),
      employeeId: targetEmployeeId,
      reason: 'access_recovery',
      expectedCredentialVersion: before.user.credentialVersion,
      rateLimiter: createEmployeeAdminResetRateLimiter(prisma, RATE_PEPPER, {
        useInMemoryStore: true,
      }),
    })).rejects.toMatchObject({
      status: 403,
      messageKey: 'credentials.reset_forbidden',
    });

    await assertNoCredentialSideEffects(before);
  }, 60_000);
});
