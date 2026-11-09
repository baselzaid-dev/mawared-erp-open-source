import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { makeApp, tokenFor } from './helpers';
import { normalizeMoney } from '../src/payrollMoney';
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

postgresDescribe('real PostgreSQL payroll adjustment invariants', () => {
  const companyId = 'pg-adj-company';
  const ownerUserId = 'pg-adj-owner';
  const adjusterId = 'pg-adj-actor';
  const approverId = 'pg-adj-approver';
  const employeeId = 'pg-adj-employee';
  const employeeUserId = 'pg-adj-employee-user';
  const databaseUser = 'mawared_test';
  const databaseName = 'mawared_payroll_adjust';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let prisma: PrismaClient;
  let app: ReturnType<typeof makeApp>;
  let periodId = '';
  let itemId = '';

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
      workDirectory
      && dirname(workDirectory) === tmpdir()
      && basename(workDirectory).startsWith('mawared-adj-pg-')
    ) {
      rmSync(workDirectory, { recursive: true, force: true });
    }
  };

  beforeAll(async () => {
    workDirectory = mkdtempSync(join(tmpdir(), 'mawared-adj-pg-'));
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
          data: { id: companyId, code: 'ADJ-PG', name: 'Adj PG Co' },
        });
        await tx.role.createMany({
          data: [
            {
              id: 'pg-adj-owner-role',
              companyId,
              name: 'Owner',
              permissions: JSON.stringify(['admin.full']),
            },
            {
              id: 'pg-adj-role',
              companyId,
              name: 'Payroll Adjuster',
              permissions: JSON.stringify([
                PERMISSIONS.PAYROLL_VIEW,
                PERMISSIONS.PAYROLL_MANAGE,
                PERMISSIONS.PAYROLL_ITEM_ADJUST,
              ]),
            },
            {
              id: 'pg-adj-approver-role',
              companyId,
              name: 'Payroll Approver',
              permissions: JSON.stringify([
                PERMISSIONS.PAYROLL_VIEW,
                PERMISSIONS.PAYROLL_APPROVE,
              ]),
            },
            {
              id: 'pg-adj-employee-role',
              companyId,
              name: 'Employee',
              permissions: JSON.stringify([]),
            },
          ],
        });
        await tx.employee.create({
          data: {
            id: employeeId,
            companyId,
            employeeNum: 'E-ADJ-1',
            normalizedEmployeeNum: 'E-ADJ-1',
            jobTitle: 'Staff',
            joiningDate: new Date('2025-01-01'),
            status: 'active',
          },
        });
        await tx.user.createMany({
          data: [
            {
              id: ownerUserId,
              companyId,
              email: 'owner-adj@postgres.test',
              normalizedEmail: 'owner-adj@postgres.test',
              password: 'test-password-not-used',
              name: 'Owner',
              roleId: 'pg-adj-owner-role',
            },
            {
              id: adjusterId,
              companyId,
              email: 'adjuster@postgres.test',
              normalizedEmail: 'adjuster@postgres.test',
              password: 'test-password-not-used',
              name: 'Adjuster',
              roleId: 'pg-adj-role',
            },
            {
              id: approverId,
              companyId,
              email: 'approver@postgres.test',
              normalizedEmail: 'approver@postgres.test',
              password: 'test-password-not-used',
              name: 'Approver',
              roleId: 'pg-adj-approver-role',
            },
            {
              id: employeeUserId,
              companyId,
              employeeId,
              email: 'employee-adj@postgres.test',
              normalizedEmail: 'employee-adj@postgres.test',
              password: 'test-password-not-used',
              name: 'Employee',
              roleId: 'pg-adj-employee-role',
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
        await tx.salaryRecord.create({
          data: {
            companyId,
            employeeId,
            baseSalary: '1000.00',
            currency: 'SAR',
            effectiveFrom: new Date('2025-01-01'),
            createdByUserId: adjusterId,
          },
        });
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      });

      app = makeApp(prisma);
      const manageToken = tokenFor({
        id: adjusterId,
        companyId,
        employeeId: null,
        permissions: [PERMISSIONS.PAYROLL_MANAGE, PERMISSIONS.PAYROLL_ITEM_ADJUST],
        authorizationVersion: 1,
        credentialVersion: 1,
      });
      const created = await request(app)
        .post('/api/payroll/periods')
        .set('Authorization', `Bearer ${manageToken}`)
        .send({ month: 8, year: 2026 });
      expect(created.status).toBe(201);
      periodId = created.body.id;
      const calculated = await request(app)
        .post(`/api/payroll/periods/${periodId}/calculate`)
        .set('Authorization', `Bearer ${manageToken}`)
        .send({});
      expect(calculated.status).toBe(200);
      itemId = calculated.body.items[0].id;
    } catch (error) {
      await stopAndClean();
      throw error;
    }
  }, 180_000);

  afterAll(stopAndClean, 60_000);

  it('survives calculate → adjust → recalculate without FK failure and without duplicating adjustments', async () => {
    const token = tokenFor({
      id: adjusterId,
      companyId,
      employeeId: null,
      permissions: [PERMISSIONS.PAYROLL_MANAGE, PERMISSIONS.PAYROLL_ITEM_ADJUST],
      authorizationVersion: 1,
      credentialVersion: 1,
    });
    const oldItemId = itemId;
    const applied = await request(app)
      .post(`/api/v2/payroll/periods/${periodId}/items/${itemId}/adjust`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'pg-adj-recalc-001')
      .send({ direction: 'allowance', amount: '50.00', reason: 'shift allowance' });
    expect(applied.status).toBe(201);
    const adjustmentId = applied.body.adjustment.id;

    const recalculated = await request(app)
      .post(`/api/payroll/periods/${periodId}/calculate`)
      .set('Authorization', `Bearer ${token}`)
      .send({ recalculationReason: 'apply adjustment into totals' });
    expect(recalculated.status).toBe(200);
    expect(recalculated.body.recalculated).toBe(true);
    expect(recalculated.body.items).toHaveLength(1);
    expect(recalculated.body.items[0].grossPay).toBe('1050.00');
    expect(recalculated.body.items[0].id).not.toBe(oldItemId);

    const adjustment = await prisma.payrollItemAdjustment.findUnique({ where: { id: adjustmentId } });
    expect(adjustment).toBeTruthy();
    expect(normalizeMoney(adjustment!.amount)).toBe('50.00');
    expect(adjustment!.status).toBe('applied');
    expect(adjustment!.payrollItemId).toBe(recalculated.body.items[0].id);
    expect(await prisma.payrollItemAdjustment.count({
      where: { companyId, payrollPeriodId: periodId, status: 'applied' },
    })).toBe(1);
    itemId = recalculated.body.items[0].id;
  });

  it('keeps exact-retry adjustment idempotent and rejects conflicting same-key payloads', async () => {
    const token = tokenFor({
      id: adjusterId,
      companyId,
      employeeId: null,
      permissions: [PERMISSIONS.PAYROLL_ITEM_ADJUST],
      authorizationVersion: 1,
      credentialVersion: 1,
    });
    const body = { direction: 'deduction', amount: '10.00', reason: 'tool recovery' };
    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/v2/payroll/periods/${periodId}/items/${itemId}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'pg-adj-idem-001')
        .send(body),
      request(app)
        .post(`/api/v2/payroll/periods/${periodId}/items/${itemId}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'pg-adj-idem-001')
        .send(body),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 201].sort());
    expect(first.body.adjustment.id).toBe(second.body.adjustment.id);
    expect(await prisma.payrollItemAdjustment.count({
      where: { companyId, idempotencyKey: 'pg-adj-idem-001' },
    })).toBe(1);

    const conflict = await request(app)
      .post(`/api/v2/payroll/periods/${periodId}/items/${itemId}/adjust`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'pg-adj-idem-001')
      .send({ direction: 'allowance', amount: '10.00', reason: 'tool recovery' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('returns IDEMPOTENCY_CONFLICT (not 500) for concurrent same-key different periods', async () => {
    const manageToken = tokenFor({
      id: adjusterId,
      companyId,
      employeeId: null,
      permissions: [PERMISSIONS.PAYROLL_MANAGE, PERMISSIONS.PAYROLL_ITEM_ADJUST],
      authorizationVersion: 1,
      credentialVersion: 1,
    });
    const adjustToken = tokenFor({
      id: adjusterId,
      companyId,
      employeeId: null,
      permissions: [PERMISSIONS.PAYROLL_ITEM_ADJUST],
      authorizationVersion: 1,
      credentialVersion: 1,
    });

    const createdA = await request(app)
      .post('/api/payroll/periods')
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ month: 10, year: 2026 });
    expect(createdA.status).toBe(201);
    const periodA = createdA.body.id;
    const calcA = await request(app)
      .post(`/api/payroll/periods/${periodA}/calculate`)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({});
    expect(calcA.status).toBe(200);
    const itemA = calcA.body.items[0].id;

    const createdB = await request(app)
      .post('/api/payroll/periods')
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ month: 11, year: 2026 });
    expect(createdB.status).toBe(201);
    const periodB = createdB.body.id;
    const calcB = await request(app)
      .post(`/api/payroll/periods/${periodB}/calculate`)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({});
    expect(calcB.status).toBe(200);
    const itemB = calcB.body.items[0].id;

    const sharedKey = 'pg-adj-cross-period-idem-001';
    const [responseA, responseB] = await Promise.all([
      request(app)
        .post(`/api/v2/payroll/periods/${periodA}/items/${itemA}/adjust`)
        .set('Authorization', `Bearer ${adjustToken}`)
        .set('Idempotency-Key', sharedKey)
        .send({ direction: 'allowance', amount: '7.00', reason: 'cross period A' }),
      request(app)
        .post(`/api/v2/payroll/periods/${periodB}/items/${itemB}/adjust`)
        .set('Authorization', `Bearer ${adjustToken}`)
        .set('Idempotency-Key', sharedKey)
        .send({ direction: 'allowance', amount: '8.00', reason: 'cross period B' }),
    ]);

    const statuses = [responseA.status, responseB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    expect([responseA.status, responseB.status]).not.toContain(500);

    const winner = responseA.status === 201 ? responseA : responseB;
    const loser = responseA.status === 409 ? responseA : responseB;
    expect(winner.status).toBe(201);
    expect(loser.status).toBe(409);
    expect(loser.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const rows = await prisma.payrollItemAdjustment.findMany({
      where: { companyId, idempotencyKey: sharedKey },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(winner.body.adjustment.id);
    expect([periodA, periodB]).toContain(rows[0].payrollPeriodId);

    const periodARow = await prisma.payrollPeriod.findUnique({ where: { id: periodA } });
    const periodBRow = await prisma.payrollPeriod.findUnique({ where: { id: periodB } });
    expect(periodARow?.status).toBe('calculated');
    expect(periodBRow?.status).toBe('calculated');

    const appliedA = await prisma.payrollItemAdjustment.count({
      where: { companyId, payrollPeriodId: periodA, status: 'applied' },
    });
    const appliedB = await prisma.payrollItemAdjustment.count({
      where: { companyId, payrollPeriodId: periodB, status: 'applied' },
    });
    expect(appliedA + appliedB).toBe(1);
    expect(Math.max(appliedA, appliedB)).toBe(1);
    expect(Math.min(appliedA, appliedB)).toBe(0);
  });

  it('never commits a new adjustment after concurrent approval wins', async () => {
    // Reset to a fresh calculated period without pending approval race artifacts.
    const manageToken = tokenFor({
      id: adjusterId,
      companyId,
      employeeId: null,
      permissions: [PERMISSIONS.PAYROLL_MANAGE, PERMISSIONS.PAYROLL_ITEM_ADJUST],
      authorizationVersion: 1,
      credentialVersion: 1,
    });
    const created = await request(app)
      .post('/api/payroll/periods')
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ month: 9, year: 2026 });
    expect(created.status).toBe(201);
    const racePeriodId = created.body.id;
    const calculated = await request(app)
      .post(`/api/payroll/periods/${racePeriodId}/calculate`)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({});
    expect(calculated.status).toBe(200);
    const raceItemId = calculated.body.items[0].id;

    const adjustToken = tokenFor({
      id: adjusterId,
      companyId,
      employeeId: null,
      permissions: [PERMISSIONS.PAYROLL_ITEM_ADJUST],
      authorizationVersion: 1,
      credentialVersion: 1,
    });
    const approveToken = tokenFor({
      id: approverId,
      companyId,
      employeeId: null,
      permissions: [PERMISSIONS.PAYROLL_APPROVE],
      authorizationVersion: 1,
      credentialVersion: 1,
    });

    const [adjustResponse, approveResponse] = await Promise.all([
      request(app)
        .post(`/api/v2/payroll/periods/${racePeriodId}/items/${raceItemId}/adjust`)
        .set('Authorization', `Bearer ${adjustToken}`)
        .set('Idempotency-Key', 'pg-adj-vs-approve-001')
        .send({ direction: 'allowance', amount: '5.00', reason: 'race probe' }),
      request(app)
        .post(`/api/payroll/periods/${racePeriodId}/approve`)
        .set('Authorization', `Bearer ${approveToken}`)
        .send({}),
    ]);

    expect([200, 201, 409]).toContain(adjustResponse.status);
    expect([200, 409]).toContain(approveResponse.status);

    const period = await prisma.payrollPeriod.findUnique({ where: { id: racePeriodId } });
    expect(period).toBeTruthy();
    expect(['approved', 'calculated']).toContain(period!.status);

    const adjustments = await prisma.payrollItemAdjustment.findMany({
      where: { companyId, payrollPeriodId: racePeriodId, status: 'applied' },
    });

    if (period!.status === 'approved') {
      expect(period!.approvedAt).toBeTruthy();
      for (const adjustment of adjustments) {
        // No adjustment may commit after approval under the FOR UPDATE contract.
        expect(adjustment.createdAt.getTime()).toBeLessThanOrEqual(period!.approvedAt!.getTime());
      }
      const late = await request(app)
        .post(`/api/v2/payroll/periods/${racePeriodId}/items/${raceItemId}/adjust`)
        .set('Authorization', `Bearer ${adjustToken}`)
        .set('Idempotency-Key', 'pg-adj-vs-approve-late')
        .send({ direction: 'allowance', amount: '1.00', reason: 'too late' });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('PAYROLL_ADJUST_NOT_ALLOWED');
    } else {
      // Adjust won and approval saw a stale fingerprint / lost the lock race.
      expect(adjustResponse.status).toBe(201);
      expect(adjustments).toHaveLength(1);
    }
  });
});
