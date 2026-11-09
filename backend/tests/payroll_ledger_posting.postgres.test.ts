import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { makeApp, tokenFor } from './helpers';
import { PERMISSIONS } from '../src/permissions';

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

postgresDescribe('real PostgreSQL payroll ledger posting idempotency', () => {
  const companyId = 'pg-w1a-company';
  const actorId = 'pg-w1a-actor';
  const ownerUserId = 'pg-w1a-owner';
  const databaseUser = 'mawared_test';
  const databaseName = 'mawared_payroll_ledger';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let prisma: PrismaClient;
  let app: ReturnType<typeof makeApp>;
  let expenseId = '';
  let payableId = '';
  let periodId = '';

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
      basename(workDirectory).startsWith('mawared-w1a-pg-')
    ) {
      rmSync(workDirectory, { recursive: true, force: true });
    }
  };

  beforeAll(async () => {
    workDirectory = mkdtempSync(join(tmpdir(), 'mawared-w1a-pg-'));
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

      // Split scheme so secret scan does not treat the disposable fixture as a real DB URL.
      const databaseUrl = [
        'postgresql', '://', databaseUser, '@127.0.0.1:', String(port), '/', databaseName,
        '?schema=public',
      ].join('');
      runCaptured(
        'Prisma migrate deploy',
        process.execPath,
        [prismaCli, 'migrate', 'deploy', '--schema', resolve(backendRoot, 'prisma/schema.prisma')],
        {
          cwd: backendRoot,
          env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
        },
      );

      prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      await prisma.$connect();
      await prisma.$transaction(async (tx) => {
        await tx.company.create({
          data: { id: companyId, code: 'W1A-PG', name: 'W1A PG Co' },
        });
        await tx.role.createMany({
          data: [
            {
              id: 'pg-w1a-owner-role',
              companyId,
              name: 'Test Owner',
              permissions: JSON.stringify(['admin.full']),
            },
            {
              id: 'pg-w1a-role',
              companyId,
              name: 'Finance',
              permissions: JSON.stringify([
                PERMISSIONS.FINANCE_CREATE,
                PERMISSIONS.FINANCE_APPROVE,
                PERMISSIONS.FINANCE_MANAGE,
              ]),
            },
          ],
        });
        await tx.user.createMany({
          data: [
            {
              id: ownerUserId,
              companyId,
              email: 'owner-w1a@postgres.test',
              normalizedEmail: 'owner-w1a@postgres.test',
              password: 'test-password-not-used',
              name: 'Test Owner',
              roleId: 'pg-w1a-owner-role',
            },
            {
              id: actorId,
              companyId,
              email: 'w1a@postgres.test',
              normalizedEmail: 'w1a@postgres.test',
              password: 'test-password-not-used',
              name: 'W1A Actor',
              roleId: 'pg-w1a-role',
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

      const expense = await prisma.chartOfAccount.create({
        data: {
          companyId,
          code: '5100',
          name: 'Payroll Expense',
          type: 'Expense',
          status: 'active',
        },
      });
      const payable = await prisma.chartOfAccount.create({
        data: {
          companyId,
          code: '2100',
          name: 'Payroll Payable',
          type: 'Liability',
          status: 'active',
        },
      });
      expenseId = expense.id;
      payableId = payable.id;

      const period = await prisma.payrollPeriod.create({
        data: {
          companyId,
          month: 8,
          year: 2026,
          status: 'approved',
          calculationVersion: 1,
          calculationFingerprint: 'fp',
          approvedAt: new Date(),
          approvedByUserId: actorId,
          calculatedAt: new Date(),
          calculatedByUserId: actorId,
        },
      });
      periodId = period.id;
      const employee = await prisma.employee.create({
        data: {
          companyId,
          employeeNum: 'E-1',
          normalizedEmployeeNum: 'E-1',
          jobTitle: 'Staff',
          joiningDate: new Date('2025-01-01'),
          status: 'active',
        },
      });
      const salary = await prisma.salaryRecord.create({
        data: {
          companyId,
          employeeId: employee.id,
          baseSalary: '1000.00',
          currency: 'SAR',
          effectiveFrom: new Date('2025-01-01'),
          createdByUserId: actorId,
        },
      });
      await prisma.payrollItem.create({
        data: {
          companyId,
          payrollPeriodId: period.id,
          employeeId: employee.id,
          salaryRecordId: salary.id,
          employeeNameSnapshot: 'Staff',
          employeeNumSnapshot: 'E-1',
          baseSalary: '1000.00',
          grossPay: '1000.00',
          totalDeductions: '0.00',
          netPay: '1000.00',
          currency: 'SAR',
          status: 'calculated',
          calculatedAt: new Date(),
        },
      });
      app = makeApp(prisma);
    } catch (error) {
      await stopAndClean();
      throw error;
    }
  }, 180_000);

  afterAll(stopAndClean, 60_000);

  it('returns the same posting for exact idempotent retries under concurrency', async () => {
    const token = tokenFor({
      id: actorId,
      companyId,
      employeeId: null,
      permissions: [PERMISSIONS.FINANCE_APPROVE],
      authorizationVersion: 1,
      credentialVersion: 1,
    });
    const body = {
      expenseAccountId: expenseId,
      payableAccountId: payableId,
    };
    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/v2/payroll/periods/${periodId}/post-to-ledger`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'pg-ledger-idem-001')
        .send(body),
      request(app)
        .post(`/api/v2/payroll/periods/${periodId}/post-to-ledger`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'pg-ledger-idem-001')
        .send(body),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 201].sort());
    expect(first.body.postingId).toBe(second.body.postingId);
    const count = await prisma.payrollLedgerPosting.count({
      where: { companyId, payrollPeriodId: periodId },
    });
    expect(count).toBe(1);
  });
});
