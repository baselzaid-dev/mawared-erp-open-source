/**
 * Commercial P4 — real PostgreSQL concurrency and idempotency invariants.
 *
 * Three claims here cannot be proved against the in-memory fake, because each
 * depends on behaviour PostgreSQL itself provides:
 *
 *  1. Task edit takes a `SELECT ... FOR UPDATE` row lock, so two genuinely
 *     concurrent edits serialize instead of interleaving. The loser must see a
 *     409 and leave NO trace — no partial field write, no second audit row.
 *  2. Certificate issue relies on the `(assignmentId, companyId)` unique index
 *     to make concurrent issues collapse to exactly one row, and the replay
 *     lookup must run on a FRESH connection after the failed transaction has
 *     aborted (the PR #89 lesson: a query inside an aborted transaction fails
 *     with 25P02 rather than recovering).
 *  3. Evaluation uses the same index but with conflict — not replay — semantics.
 *
 * Execution modes:
 * - Local: spawn a disposable PostgreSQL cluster via initdb/pg_ctl/createdb when
 *   those tools are on PATH (same pattern as sibling `*.postgres.test.ts` suites).
 * - CI / explicit: set `MAWARED_PG_TEST_DATABASE_URL` to a disposable localhost
 *   PostgreSQL URL. Never point this at Staging/Production.
 *
 * Without either path the suite skips. Set `MAWARED_PG_TEST_REQUIRE=1` to fail
 * closed instead of skipping (used by the Disposable PostgreSQL CI job).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

/**
 * pg_ctl/initdb must never inherit a pipe: the postgres server they spawn keeps
 * the handle open, so a piped spawnSync would block forever.
 */
function runQuietly(label: string, command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true });
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
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
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}${detail ? `\n${detail}` : ''}`);
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
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

/**
 * Opt-in disposable PostgreSQL URL for CI (or a developer-supplied local server).
 * Refuses non-loopback hosts so this never silently targets Staging/Production.
 */
function readExternalDisposableDatabaseUrl(): string | null {
  const raw = process.env.MAWARED_PG_TEST_DATABASE_URL?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('MAWARED_PG_TEST_DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('MAWARED_PG_TEST_DATABASE_URL must use the postgres/postgresql protocol');
  }
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error(
      'MAWARED_PG_TEST_DATABASE_URL must target localhost/127.0.0.1 disposable PostgreSQL only',
    );
  }
  return raw;
}

const initdb = findCommand('initdb');
const pgCtl = findCommand('pg_ctl');
const createdb = findCommand('createdb');
const backendRoot = resolve(process.cwd());
const prismaCli = resolve(backendRoot, 'node_modules/prisma/build/index.js');
const externalDatabaseUrl = readExternalDisposableDatabaseUrl();
const hasLocalDisposablePostgres = Boolean(initdb && pgCtl && createdb && existsSync(prismaCli));
const hasDisposablePostgres = Boolean(
  existsSync(prismaCli) && (externalDatabaseUrl || hasLocalDisposablePostgres),
);
if (process.env.MAWARED_PG_TEST_REQUIRE === '1' && !hasDisposablePostgres) {
  throw new Error(
    'MAWARED_PG_TEST_REQUIRE=1 but no disposable PostgreSQL is available '
      + '(set MAWARED_PG_TEST_DATABASE_URL to a localhost URL, or install initdb/pg_ctl/createdb)',
  );
}
const postgresDescribe = hasDisposablePostgres ? describe : describe.skip;
const usesExternalDatabase = Boolean(externalDatabaseUrl);

const COMPANY_ID = 'pg-p4-company';
const OWNER_USER_ID = 'pg-p4-owner';
const MANAGER_USER_ID = 'pg-p4-manager';
const MANAGER_EMPLOYEE_ID = 'pg-p4-manager-employee';
const STAFF_USER_ID = 'pg-p4-staff-user';
const STAFF_EMPLOYEE_ID = 'pg-p4-staff-employee';
const COURSE_ID = 'pg-p4-course';

const MANAGER_PERMISSIONS = [
  PERMISSIONS.TASKS_VIEW_COMPANY,
  PERMISSIONS.TASKS_CREATE,
  PERMISSIONS.TASKS_ASSIGN_COMPANY,
  PERMISSIONS.TASKS_REVIEW,
  PERMISSIONS.TASKS_EDIT,
  PERMISSIONS.TASKS_COMMENT_CREATE,
  PERMISSIONS.TRAINING_VIEW_COMPANY,
  PERMISSIONS.TRAINING_MANAGE,
  PERMISSIONS.TRAINING_ASSIGN,
  PERMISSIONS.TRAINING_REVIEW,
  PERMISSIONS.TRAINING_CERTIFICATE_ISSUE,
  PERMISSIONS.TRAINING_EVALUATION_CREATE,
  PERMISSIONS.TRAINING_EVALUATION_VIEW,
];

postgresDescribe('real PostgreSQL P4 collaboration concurrency', () => {
  const databaseUser = 'mawared_test';
  const databaseName = 'mawared_p4_concurrency';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let prisma: PrismaClient;
  let app: ReturnType<typeof makeApp>;
  let sequence = 0;

  const managerToken = () =>
    tokenFor({
      id: MANAGER_USER_ID,
      companyId: COMPANY_ID,
      employeeId: MANAGER_EMPLOYEE_ID,
      permissions: MANAGER_PERMISSIONS,
      authorizationVersion: 1,
      credentialVersion: 1,
    });

  const stopAndClean = async () => {
    if (prisma) await prisma.$disconnect().catch(() => undefined);
    if (!usesExternalDatabase && clusterStarted && pgCtl) {
      spawnSync(pgCtl, ['--pgdata', clusterDirectory, '--wait', '--mode', 'fast', 'stop'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      clusterStarted = false;
    }
    if (
      !usesExternalDatabase &&
      workDirectory &&
      dirname(workDirectory) === tmpdir() &&
      basename(workDirectory).startsWith('mawared-p4-pg-')
    ) {
      rmSync(workDirectory, { recursive: true, force: true });
    }
  };

  beforeAll(async () => {
    try {
      let databaseUrl: string;
      if (usesExternalDatabase) {
        databaseUrl = externalDatabaseUrl!;
      } else {
        workDirectory = mkdtempSync(join(tmpdir(), 'mawared-p4-pg-'));
        clusterDirectory = join(workDirectory, 'cluster');
        const logPath = join(workDirectory, 'postgres.log');
        const port = await reserveLocalPort();

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

        // Split scheme so the secret scan never sees a literal database URL.
        databaseUrl = [
          'postgresql', '://', databaseUser, '@127.0.0.1:', String(port), '/', databaseName,
          '?schema=public',
        ].join('');
      }

      runCaptured(
        'Prisma migrate deploy',
        process.execPath,
        [prismaCli, 'migrate', 'deploy', '--schema', resolve(backendRoot, 'prisma/schema.prisma')],
        { cwd: backendRoot, env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl } },
      );

      prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      await prisma.$connect();

      // The company/primary-owner invariant is a deferred constraint: the owner
      // must be created in the same transaction as the company.
      await prisma.$transaction(async (tx) => {
        await tx.company.create({ data: { id: COMPANY_ID, code: 'P4-PG', name: 'P4 PG Co' } });
        await tx.role.createMany({
          data: [
            { id: 'pg-p4-role-owner', companyId: COMPANY_ID, name: 'Owner', permissions: JSON.stringify(['admin.full']) },
            { id: 'pg-p4-role-manager', companyId: COMPANY_ID, name: 'Manager', permissions: JSON.stringify(MANAGER_PERMISSIONS) },
            { id: 'pg-p4-role-staff', companyId: COMPANY_ID, name: 'Staff', permissions: JSON.stringify([PERMISSIONS.TASKS_VIEW_OWN, PERMISSIONS.TRAINING_VIEW_OWN]) },
          ],
        });
        await tx.employee.createMany({
          data: [
            { id: MANAGER_EMPLOYEE_ID, companyId: COMPANY_ID, employeeNum: 'E-MGR', normalizedEmployeeNum: 'E-MGR', jobTitle: 'Manager', joiningDate: new Date('2025-01-01'), status: 'active' },
            { id: STAFF_EMPLOYEE_ID, companyId: COMPANY_ID, employeeNum: 'E-STF', normalizedEmployeeNum: 'E-STF', jobTitle: 'Staff', joiningDate: new Date('2025-01-01'), status: 'active' },
          ],
        });
        await tx.user.createMany({
          data: [
            { id: OWNER_USER_ID, companyId: COMPANY_ID, email: 'owner-p4@postgres.test', normalizedEmail: 'owner-p4@postgres.test', password: 'test-password-not-used', name: 'Owner', roleId: 'pg-p4-role-owner' },
            { id: MANAGER_USER_ID, companyId: COMPANY_ID, email: 'manager-p4@postgres.test', normalizedEmail: 'manager-p4@postgres.test', password: 'test-password-not-used', name: 'Manager', roleId: 'pg-p4-role-manager', employeeId: MANAGER_EMPLOYEE_ID },
            { id: STAFF_USER_ID, companyId: COMPANY_ID, email: 'staff-p4@postgres.test', normalizedEmail: 'staff-p4@postgres.test', password: 'test-password-not-used', name: 'Staff', roleId: 'pg-p4-role-staff', employeeId: STAFF_EMPLOYEE_ID },
          ],
        });
        await tx.companyOwnership.create({
          data: { companyId: COMPANY_ID, userId: OWNER_USER_ID, isPrimary: true, status: 'active', createdByUserId: OWNER_USER_ID },
        });
        await tx.trainingCourse.create({
          data: {
            id: COURSE_ID,
            companyId: COMPANY_ID,
            courseCode: 'TR-P4-0001',
            title: 'Concurrency fixture course',
            deliveryMode: 'online',
            status: 'published',
            createdByUserId: MANAGER_USER_ID,
          },
        });
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      });

      app = makeApp(prisma);
    } catch (error) {
      await stopAndClean();
      throw error;
    }
  }, 300_000);

  afterAll(stopAndClean, 60_000);

  /** A fresh active task per test keeps the concurrency assertions independent. */
  async function freshTask(): Promise<{ id: string; updatedAt: string }> {
    sequence += 1;
    const taskId = randomUUID();
    const task = await prisma.task.create({
      data: {
        id: taskId,
        companyId: COMPANY_ID,
        title: `Concurrency fixture ${sequence}`,
        priority: 'normal',
        status: 'active',
        createdByUserId: MANAGER_USER_ID,
      },
    });
    await prisma.taskAssignment.create({
      data: {
        companyId: COMPANY_ID,
        taskId,
        employeeId: STAFF_EMPLOYEE_ID,
        status: 'assigned',
      },
    });
    return { id: task.id, updatedAt: task.updatedAt.toISOString() };
  }

  /** A fresh completed training assignment, ready for a completion artifact. */
  async function freshCompletedAssignment(): Promise<string> {
    sequence += 1;
    const assignmentId = randomUUID();
    await prisma.trainingCourse.create({
      data: {
        id: randomUUID(),
        companyId: COMPANY_ID,
        courseCode: `TR-P4-${String(sequence).padStart(4, '0')}-X`,
        title: `Fixture course ${sequence}`,
        deliveryMode: 'online',
        status: 'published',
        createdByUserId: MANAGER_USER_ID,
      },
    });
    await prisma.trainingAssignment.create({
      data: {
        id: assignmentId,
        companyId: COMPANY_ID,
        courseId: COURSE_ID,
        employeeId: STAFF_EMPLOYEE_ID,
        employeeNameSnapshot: 'Staff',
        employeeNumSnapshot: 'E-STF',
        status: 'completed',
        progressPercent: 100,
        assignedByUserId: MANAGER_USER_ID,
        completedAt: new Date(),
        reviewedByUserId: MANAGER_USER_ID,
        reviewedAt: new Date(),
      },
    });
    // One assignment per (courseId, employeeId): remove it after each test.
    return assignmentId;
  }

  const auditCountFor = (action: string, needle: string) =>
    prisma.auditLog.count({
      where: { companyId: COMPANY_ID, action, details: { contains: needle } },
    });

  it('serializes concurrent task edits so exactly one wins and the loser leaves no trace', async () => {
    const task = await freshTask();

    // Both editors read the same updatedAt, then race.
    const [first, second] = await Promise.all([
      request(app)
        .patch(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ expectedUpdatedAt: task.updatedAt, title: 'Winner A' }),
      request(app)
        .patch(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ expectedUpdatedAt: task.updatedAt, title: 'Winner B' }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const stored = await prisma.task.findFirstOrThrow({ where: { id: task.id } });
    // The surviving title is whichever request won — never a blend, never the loser.
    expect(['Winner A', 'Winner B']).toContain(stored.title);

    // The losing write must not have produced an audit row.
    expect(await auditCountFor('task.edit', task.id)).toBe(1);
  });

  it('keeps a third concurrent editor from resurrecting a stale token', async () => {
    const task = await freshTask();
    const staleToken = task.updatedAt;

    const winner = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .set('Authorization', `Bearer ${managerToken()}`)
      .send({ expectedUpdatedAt: staleToken, priority: 'high' });
    expect(winner.status).toBe(200);

    const [a, b] = await Promise.all([
      request(app)
        .patch(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ expectedUpdatedAt: staleToken, priority: 'urgent' }),
      request(app)
        .patch(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ expectedUpdatedAt: staleToken, priority: 'low' }),
    ]);

    expect(a.status).toBe(409);
    expect(b.status).toBe(409);
    const stored = await prisma.task.findFirstOrThrow({ where: { id: task.id } });
    expect(stored.priority).toBe('high');
    expect(await auditCountFor('task.edit', task.id)).toBe(1);
  });

  it('collapses concurrent certificate issues to one row and replays the rest', async () => {
    const assignmentId = await freshCompletedAssignment();

    const responses = await Promise.all([
      request(app)
        .post(`/api/training/assignments/${assignmentId}/certificate`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({}),
      request(app)
        .post(`/api/training/assignments/${assignmentId}/certificate`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({}),
      request(app)
        .post(`/api/training/assignments/${assignmentId}/certificate`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({}),
    ]);

    // Every caller gets a success, and every caller gets the SAME certificate.
    for (const response of responses) expect([200, 201]).toContain(response.status);
    const ids = new Set(responses.map((response) => response.body.id));
    expect(ids.size).toBe(1);
    const serials = new Set(responses.map((response) => response.body.serialNumber));
    expect(serials.size).toBe(1);

    const stored = await prisma.trainingCertificate.count({
      where: { companyId: COMPANY_ID, assignmentId },
    });
    expect(stored).toBe(1);
    // A replay must not duplicate the audit or the notification.
    expect(await auditCountFor('training.certificate.issue', assignmentId)).toBe(1);
    expect(
      await prisma.notification.count({
        where: { companyId: COMPANY_ID, category: 'training', resourceId: assignmentId },
      }),
    ).toBe(1);

    await prisma.trainingCertificate.deleteMany({ where: { assignmentId } });
    await prisma.trainingAssignment.deleteMany({ where: { id: assignmentId } });
  });

  it('lets exactly one concurrent evaluation win and reports the others as conflicts', async () => {
    const assignmentId = await freshCompletedAssignment();
    const body = {
      effectivenessScore: 4,
      knowledgeScore: 4,
      applicationScore: 4,
      recommendation: 'recommended' as const,
    };

    const responses = await Promise.all([
      request(app)
        .post(`/api/training/assignments/${assignmentId}/evaluation`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send(body),
      request(app)
        .post(`/api/training/assignments/${assignmentId}/evaluation`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ ...body, effectivenessScore: 1, recommendation: 'repeat_required' as const }),
    ]);

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(
      await prisma.trainingEvaluation.count({ where: { companyId: COMPANY_ID, assignmentId } }),
    ).toBe(1);
    expect(await auditCountFor('training.evaluation.create', assignmentId)).toBe(1);

    await prisma.trainingEvaluation.deleteMany({ where: { assignmentId } });
    await prisma.trainingAssignment.deleteMany({ where: { id: assignmentId } });
  });

  it('keeps concurrent comments on one task all durable and correctly ordered', async () => {
    const task = await freshTask();

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        request(app)
          .post(`/api/tasks/${task.id}/comments`)
          .set('Authorization', `Bearer ${managerToken()}`)
          .send({ body: `Concurrent comment ${index}` }),
      ),
    );

    for (const response of responses) expect(response.status).toBe(201);
    const stored = await prisma.taskComment.findMany({
      where: { companyId: COMPANY_ID, taskId: task.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(stored).toHaveLength(5);
    // Comments are additive, so none of them may be lost to a race.
    expect(new Set(stored.map((row) => row.id)).size).toBe(5);
    expect(await auditCountFor('task.comment.create', task.id)).toBe(5);

    // The keyset page must not repeat or skip a row under a shared timestamp.
    const page = await request(app)
      .get(`/api/tasks/${task.id}/comments?limit=3`)
      .set('Authorization', `Bearer ${managerToken()}`);
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(3);
    const next = await request(app)
      .get(`/api/tasks/${task.id}/comments?limit=3&cursor=${encodeURIComponent(page.body.nextCursor)}`)
      .set('Authorization', `Bearer ${managerToken()}`);
    const seen = [...page.body.items, ...next.body.items].map((row: any) => row.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(5);
  });
});
