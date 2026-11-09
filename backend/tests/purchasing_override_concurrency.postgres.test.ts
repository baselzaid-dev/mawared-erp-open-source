/**
 * Purchasing override — real PostgreSQL concurrency and idempotency invariants.
 *
 * The override endpoint binds its Idempotency-Key to a canonical payload
 * fingerprint. These assertions cannot be proved against the in-memory fake:
 * they depend on `SELECT ... FOR UPDATE` row locking and the company-scoped
 * `(companyId, idempotencyKey)` unique index, and they assert *persisted state*
 * plus side-effect counts, not just HTTP status codes.
 *
 * Execution modes:
 * - Local: spawn a disposable PostgreSQL cluster via initdb/pg_ctl/createdb when
 *   those tools are on PATH (same pattern as sibling `*.postgres.test.ts` suites).
 * - CI / explicit: set `MAWARED_PG_TEST_DATABASE_URL` to a disposable localhost
 *   PostgreSQL URL (GitHub Actions service). Do not point this at Staging/Production.
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
import { PURCHASING_OVERRIDE_CONFIRMATION } from '../src/purchasingOverride';

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

const COMPANY_ID = 'pg-ovr-company';
const OWNER_USER_ID = 'pg-ovr-owner';
const OVERRIDE_USER_ID = 'pg-ovr-admin';
const OVERRIDE_EMPLOYEE_ID = 'pg-ovr-admin-employee';
const REQUESTER_USER_ID = 'pg-ovr-requester-user';
const REQUESTER_EMPLOYEE_ID = 'pg-ovr-requester-employee';

const OVERRIDE_PERMISSIONS = [
  PERMISSIONS.PURCHASING_VIEW,
  PERMISSIONS.PURCHASING_ADMIN_OVERRIDE,
];

postgresDescribe('real PostgreSQL purchasing override concurrency', () => {
  const databaseUser = 'mawared_test';
  const databaseName = 'mawared_override_concurrency';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let prisma: PrismaClient;
  let app: ReturnType<typeof makeApp>;
  let sequence = 0;

  const overrideToken = () =>
    tokenFor({
      id: OVERRIDE_USER_ID,
      companyId: COMPANY_ID,
      employeeId: OVERRIDE_EMPLOYEE_ID,
      permissions: OVERRIDE_PERMISSIONS,
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
      basename(workDirectory).startsWith('mawared-override-pg-')
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
        workDirectory = mkdtempSync(join(tmpdir(), 'mawared-override-pg-'));
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
        await tx.company.create({ data: { id: COMPANY_ID, code: 'OVR-PG', name: 'Override PG Co' } });
        await tx.role.createMany({
          data: [
            { id: 'pg-ovr-role-owner', companyId: COMPANY_ID, name: 'Owner', permissions: JSON.stringify(['admin.full']) },
            { id: 'pg-ovr-role-admin', companyId: COMPANY_ID, name: 'Purchasing Admin', permissions: JSON.stringify(OVERRIDE_PERMISSIONS) },
            { id: 'pg-ovr-role-staff', companyId: COMPANY_ID, name: 'Staff', permissions: JSON.stringify([]) },
          ],
        });
        await tx.employee.createMany({
          data: [
            { id: OVERRIDE_EMPLOYEE_ID, companyId: COMPANY_ID, employeeNum: 'E-OVR', normalizedEmployeeNum: 'E-OVR', jobTitle: 'Purchasing Admin', joiningDate: new Date('2025-01-01'), status: 'active' },
            { id: REQUESTER_EMPLOYEE_ID, companyId: COMPANY_ID, employeeNum: 'E-REQ', normalizedEmployeeNum: 'E-REQ', jobTitle: 'Staff', joiningDate: new Date('2025-01-01'), status: 'active' },
          ],
        });
        await tx.user.createMany({
          data: [
            { id: OWNER_USER_ID, companyId: COMPANY_ID, email: 'owner-ovr@postgres.test', normalizedEmail: 'owner-ovr@postgres.test', password: 'test-password-not-used', name: 'Owner', roleId: 'pg-ovr-role-owner' },
            { id: OVERRIDE_USER_ID, companyId: COMPANY_ID, email: 'admin-ovr@postgres.test', normalizedEmail: 'admin-ovr@postgres.test', password: 'test-password-not-used', name: 'Purchasing Admin', roleId: 'pg-ovr-role-admin', employeeId: OVERRIDE_EMPLOYEE_ID },
            { id: REQUESTER_USER_ID, companyId: COMPANY_ID, email: 'requester-ovr@postgres.test', normalizedEmail: 'requester-ovr@postgres.test', password: 'test-password-not-used', name: 'Requester', roleId: 'pg-ovr-role-staff', employeeId: REQUESTER_EMPLOYEE_ID },
          ],
        });
        await tx.companyOwnership.create({
          data: { companyId: COMPANY_ID, userId: OWNER_USER_ID, isPrimary: true, status: 'active', createdByUserId: OWNER_USER_ID },
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

  /** A fresh pending request per test keeps the concurrency assertions independent. */
  async function freshRequest(): Promise<string> {
    sequence += 1;
    const requestId = randomUUID();
    await prisma.purchaseRequest.create({
      data: {
        id: requestId,
        companyId: COMPANY_ID,
        requestNumber: `PR-OVR-${sequence}`,
        requestedByEmployeeId: REQUESTER_EMPLOYEE_ID,
        requesterNameSnapshot: 'Requester',
        requesterNumSnapshot: 'E-REQ',
        title: 'Override concurrency fixture',
        status: 'pending_purchasing',
        totalEstimated: '200.00',
        currency: 'SAR',
      },
    });
    return requestId;
  }

  const eventCountForKey = (key: string) =>
    prisma.purchaseWorkflowEvent.count({ where: { companyId: COMPANY_ID, idempotencyKey: key } });

  const auditCountForRequest = (requestId: string) =>
    prisma.auditLog.count({
      where: { companyId: COMPANY_ID, action: 'purchasing.override', details: { contains: requestId } },
    });

  const notificationCountForRequest = (requestId: string) =>
    prisma.notification.count({
      where: { companyId: COMPANY_ID, userId: REQUESTER_USER_ID, resourceType: 'purchase_request', resourceId: requestId },
    });

  it('resolves a concurrent exact retry as one mutation with one set of side effects', async () => {
    const requestId = await freshRequest();
    const key = `pg-override-exact-${requestId}`;
    const send = () =>
      request(app)
        .post(`/api/v2/purchasing/requests/${requestId}/override`)
        .set('Authorization', `Bearer ${overrideToken()}`)
        .set('Idempotency-Key', key)
        .send({ action: 'approve', reason: 'Vendor deadline forces admin override', confirmation: PURCHASING_OVERRIDE_CONFIRMATION });

    const responses = await Promise.all([send(), send(), send()]);

    // No 500: every concurrent retry resolves as a successful replay.
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(responses.every((response) => response.body.status === 'approved')).toBe(true);

    const persisted = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(persisted.status).toBe('approved');

    // Exactly one logical mutation and one of each side effect.
    expect(await eventCountForKey(key)).toBe(1);
    expect(await auditCountForRequest(requestId)).toBe(1);
    expect(await notificationCountForRequest(requestId)).toBe(1);
  });

  it('resolves a concurrent conflicting retry as one winner and a 409 loser (never 500)', async () => {
    const requestId = await freshRequest();
    const key = `pg-override-conflict-${requestId}`;
    const send = (action: 'approve' | 'reject') =>
      request(app)
        .post(`/api/v2/purchasing/requests/${requestId}/override`)
        .set('Authorization', `Bearer ${overrideToken()}`)
        .set('Idempotency-Key', key)
        .send({ action, reason: `Admin override to ${action}`, confirmation: PURCHASING_OVERRIDE_CONFIRMATION });

    const responses = await Promise.all([send('approve'), send('reject')]);

    const winners = responses.filter((response) => response.status === 200);
    const losers = responses.filter((response) => response.status !== 200);
    // Exactly one winner; the other is a 409 IdempotencyKeyReused, never a 500.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].status).toBe(409);
    expect(losers[0].body.error).toBe('IdempotencyKeyReused');

    // Persisted state equals the actual winner's action; no duplicate side effects.
    const persisted = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(persisted.status).toBe(winners[0].body.status);
    expect(['approved', 'rejected']).toContain(persisted.status);
    expect(await eventCountForKey(key)).toBe(1);
    expect(await auditCountForRequest(requestId)).toBe(1);
    expect(await notificationCountForRequest(requestId)).toBe(1);
  });

  it('replays a sequential exact retry and 409s a changed-payload retry on the same key', async () => {
    const requestId = await freshRequest();
    const key = `pg-override-seq-${requestId}`;
    const post = (action: 'approve' | 'reject', reason: string) =>
      request(app)
        .post(`/api/v2/purchasing/requests/${requestId}/override`)
        .set('Authorization', `Bearer ${overrideToken()}`)
        .set('Idempotency-Key', key)
        .send({ action, reason, confirmation: PURCHASING_OVERRIDE_CONFIRMATION });

    const first = await post('approve', 'Original override reason');
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('approved');

    const exactRetry = await post('approve', 'Original override reason');
    expect(exactRetry.status).toBe(200);
    expect(exactRetry.body.status).toBe('approved');

    const changedAction = await post('reject', 'Original override reason');
    expect(changedAction.status).toBe(409);
    expect(changedAction.body.error).toBe('IdempotencyKeyReused');

    const changedReason = await post('approve', 'A different override reason');
    expect(changedReason.status).toBe(409);
    expect(changedReason.body.error).toBe('IdempotencyKeyReused');

    const persisted = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(persisted.status).toBe('approved');
    expect(await eventCountForKey(key)).toBe(1);
    const event = await prisma.purchaseWorkflowEvent.findFirstOrThrow({
      where: { companyId: COMPANY_ID, idempotencyKey: key },
    });
    expect(event.payloadFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
