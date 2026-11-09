import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { makeApp, tokenFor } from './helpers';

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

function runCaptured(label: string, command: string, args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter((chunk) => typeof chunk === 'string' && chunk.trim().length > 0)
      .join('\n')
      .trim();
    throw new Error(
      `${label} failed with exit code ${result.status ?? 'unknown'}${detail ? `\n${detail}` : ''}`,
    );
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
const backendRoot = resolve(process.cwd());
const prismaCli = resolve(backendRoot, 'node_modules/prisma/build/index.js');
const hasDisposablePostgres = Boolean(initdb && pgCtl && createdb && existsSync(prismaCli));
const postgresDescribe = hasDisposablePostgres ? describe : describe.skip;

postgresDescribe('real PostgreSQL leave transition concurrency', () => {
  const companyId = 'pg-company';
  const targetEmployeeId = 'pg-target-employee';
  const targetUserId = 'pg-target-user';
  const reviewerEmployeeId = 'pg-reviewer-employee';
  const reviewerUserId = 'pg-reviewer-user';
  const ownerUserId = 'pg-owner-user';
  const databaseUser = 'mawared_test';
  const databaseName = 'mawared_leave_concurrency';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let prisma: PrismaClient;
  let app: ReturnType<typeof makeApp>;

  const stopAndClean = async () => {
    if (prisma) await prisma.$disconnect().catch(() => undefined);
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
      basename(workDirectory).startsWith('mawared-leave-pg-')
    ) {
      rmSync(workDirectory, { recursive: true, force: true });
    }
  };

  beforeAll(async () => {
    workDirectory = mkdtempSync(join(tmpdir(), 'mawared-leave-pg-'));
    clusterDirectory = join(workDirectory, 'cluster');
    const logPath = join(workDirectory, 'postgres.log');
    const port = await reserveLocalPort();

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
      runQuietly('createdb', createdb!, [
        '--host', '127.0.0.1',
        '--port', String(port),
        '--username', databaseUser,
        '--maintenance-db', 'postgres',
        databaseName,
      ]);

      const databaseUrl = [
        'postgresql', '://', databaseUser, '@127.0.0.1:', String(port), '/', databaseName,
        '?schema=public',
      ].join('');
      const migrationEnvironment = {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DIRECT_URL: databaseUrl,
      };
      runCaptured(
        'Prisma migrate deploy',
        process.execPath,
        [prismaCli, 'migrate', 'deploy', '--schema', resolve(backendRoot, 'prisma/schema.prisma')],
        { cwd: backendRoot, env: migrationEnvironment },
      );

      prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      await prisma.$connect();
      await prisma.$transaction(async (tx) => {
        await tx.company.create({
          data: { id: companyId, code: 'PG-LEAVE', name: 'PostgreSQL concurrency test' },
        });
        await tx.role.createMany({
          data: [
            { id: 'pg-role-owner', companyId, name: 'Test Owner', permissions: '["admin.full"]' },
            { id: 'pg-role-reviewer', companyId, name: 'Test Reviewer', permissions: '["leaves.approve"]' },
            { id: 'pg-role-employee', companyId, name: 'Test Employee', permissions: '[]' },
          ],
        });
        await tx.employee.createMany({
          data: [
            {
              id: reviewerEmployeeId,
              companyId,
              employeeNum: 'PG-REVIEWER',
              normalizedEmployeeNum: 'PG-REVIEWER',
              jobTitle: 'Reviewer',
              joiningDate: new Date('2026-01-01T00:00:00.000Z'),
            },
            {
              id: targetEmployeeId,
              companyId,
              employeeNum: 'PG-TARGET',
              normalizedEmployeeNum: 'PG-TARGET',
              jobTitle: 'Employee',
              joiningDate: new Date('2026-01-01T00:00:00.000Z'),
            },
          ],
        });
        await tx.user.createMany({
          data: [
            {
              id: ownerUserId,
              companyId,
              email: 'owner@postgres.test',
              normalizedEmail: 'owner@postgres.test',
              password: 'test-password-not-used',
              name: 'Test Owner',
              roleId: 'pg-role-owner',
            },
            {
              id: reviewerUserId,
              companyId,
              employeeId: reviewerEmployeeId,
              email: 'reviewer@postgres.test',
              normalizedEmail: 'reviewer@postgres.test',
              password: 'test-password-not-used',
              name: 'Test Reviewer',
              roleId: 'pg-role-reviewer',
            },
            {
              id: targetUserId,
              companyId,
              employeeId: targetEmployeeId,
              email: 'employee@postgres.test',
              normalizedEmail: 'employee@postgres.test',
              password: 'test-password-not-used',
              name: 'Test Employee',
              roleId: 'pg-role-employee',
            },
          ],
        });
        await tx.companyOwnership.create({
          data: {
            companyId,
            userId: ownerUserId,
            isPrimary: true,
            status: 'active',
            createdByUserId: ownerUserId,
          },
        });
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      });
      app = makeApp(prisma);
    } catch (error) {
      await stopAndClean();
      throw error;
    }
  }, 120_000);

  afterAll(stopAndClean, 30_000);

  async function createPendingLeave(id: string) {
    await prisma.leaveRequest.create({
      data: {
        id,
        companyId,
        employeeId: targetEmployeeId,
        leaveType: 'special',
        startDate: new Date('2026-08-01T00:00:00.000Z'),
        endDate: new Date('2026-08-01T00:00:00.000Z'),
        totalDays: 1,
        status: 'pending_hr',
      },
    });
  }

  async function workflowCounts(leaveRequestId: string) {
    const [history, notifications, audit] = await Promise.all([
      prisma.leaveApprovalHistory.count({ where: { leaveRequestId } }),
      prisma.notification.count({ where: { companyId, userId: targetUserId } }),
      prisma.auditLog.count({
        where: {
          companyId,
          action: { in: ['leave.hr_approve', 'leave.hr_reject'] },
          details: { contains: leaveRequestId },
        },
      }),
    ]);
    return { history, notifications, audit };
  }

  const reviewerToken = () => tokenFor({
    id: reviewerUserId,
    companyId,
    employeeId: reviewerEmployeeId,
    permissions: ['leaves.approve'],
  });

  it('allows exactly one success in an approve-plus-approve race', async () => {
    const leaveRequestId = 'pg-leave-approve-race';
    await createPendingLeave(leaveRequestId);
    const before = await workflowCounts(leaveRequestId);
    const token = reviewerToken();

    const responses = await Promise.all([
      request(app).post(`/api/leaves/${leaveRequestId}/hr-approve`).set('Authorization', `Bearer ${token}`),
      request(app).post(`/api/leaves/${leaveRequestId}/hr-approve`).set('Authorization', `Bearer ${token}`),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await prisma.leaveRequest.findUnique({ where: { id: leaveRequestId } }))?.status).toBe('approved');
    const after = await workflowCounts(leaveRequestId);
    expect(after.history - before.history).toBe(1);
    expect(after.notifications - before.notifications).toBe(1);
    expect(after.audit - before.audit).toBe(1);
  });

  it('allows exactly one success in an approve-plus-reject race', async () => {
    const leaveRequestId = 'pg-leave-opposing-race';
    await createPendingLeave(leaveRequestId);
    const before = await workflowCounts(leaveRequestId);
    const token = reviewerToken();

    const responses = await Promise.all([
      request(app).post(`/api/leaves/${leaveRequestId}/hr-approve`).set('Authorization', `Bearer ${token}`),
      request(app)
        .post(`/api/leaves/${leaveRequestId}/hr-reject`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'PostgreSQL concurrency test' }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const finalStatus = (await prisma.leaveRequest.findUnique({ where: { id: leaveRequestId } }))?.status;
    expect(['approved', 'rejected']).toContain(finalStatus);
    const after = await workflowCounts(leaveRequestId);
    expect(after.history - before.history).toBe(1);
    expect(after.notifications - before.notifications).toBe(1);
    expect(after.audit - before.audit).toBe(1);
  });
});
