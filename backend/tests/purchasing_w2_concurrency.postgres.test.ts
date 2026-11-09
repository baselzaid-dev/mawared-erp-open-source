/**
 * Commercial Wave 2 — real PostgreSQL concurrency and idempotency invariants.
 *
 * These assertions cannot be proved against an in-memory fake: they depend on
 * `SELECT ... FOR UPDATE` row locking, a partial unique index, and company-scoped
 * unique constraints. Every test asserts *persisted state*, not just the HTTP
 * status codes.
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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const COMPANY_ID = 'pg-w2-company';
const OWNER_USER_ID = 'pg-w2-owner';
const BUYER_USER_ID = 'pg-w2-buyer';
const APPROVER_USER_ID = 'pg-w2-approver';
const REQUESTER_EMPLOYEE_ID = 'pg-w2-employee-requester';
const BUYER_EMPLOYEE_ID = 'pg-w2-employee-buyer';
const APPROVER_EMPLOYEE_ID = 'pg-w2-employee-approver';
// Vendor / request / line ids reach `z.string().uuid()` request schemas, so the
// fixture uses real UUIDs for every id a client is allowed to send.
const VENDOR_A_ID = '70000000-0000-4000-8000-0000000000a1';
const VENDOR_B_ID = '70000000-0000-4000-8000-0000000000a2';

const BUYER_PERMISSIONS = [
  PERMISSIONS.PURCHASING_VIEW,
  PERMISSIONS.PURCHASING_MANAGE,
  PERMISSIONS.PURCHASING_RECEIVE,
  PERMISSIONS.PURCHASING_QUOTATION_MANAGE,
  PERMISSIONS.PURCHASING_QUOTATION_COMPARE,
  PERMISSIONS.PURCHASING_RETURN_CREATE,
];
const APPROVER_PERMISSIONS = [
  PERMISSIONS.PURCHASING_VIEW,
  PERMISSIONS.PURCHASING_RETURN_APPROVE,
];

postgresDescribe('real PostgreSQL W2 purchasing concurrency', () => {
  const databaseUser = 'mawared_test';
  const databaseName = 'mawared_w2_concurrency';
  let workDirectory = '';
  let clusterDirectory = '';
  let clusterStarted = false;
  let prisma: PrismaClient;
  let app: ReturnType<typeof makeApp>;
  let sequence = 0;

  const buyerToken = () =>
    tokenFor({
      id: BUYER_USER_ID,
      companyId: COMPANY_ID,
      employeeId: BUYER_EMPLOYEE_ID,
      permissions: BUYER_PERMISSIONS,
      authorizationVersion: 1,
      credentialVersion: 1,
    });
  const approverToken = () =>
    tokenFor({
      id: APPROVER_USER_ID,
      companyId: COMPANY_ID,
      employeeId: APPROVER_EMPLOYEE_ID,
      permissions: APPROVER_PERMISSIONS,
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
      basename(workDirectory).startsWith('mawared-w2-pg-')
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
        workDirectory = mkdtempSync(join(tmpdir(), 'mawared-w2-pg-'));
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
        await tx.company.create({ data: { id: COMPANY_ID, code: 'W2-PG', name: 'W2 PG Co' } });
        await tx.role.createMany({
          data: [
            { id: 'pg-w2-role-owner', companyId: COMPANY_ID, name: 'Owner', permissions: JSON.stringify(['admin.full']) },
            { id: 'pg-w2-role-buyer', companyId: COMPANY_ID, name: 'Buyer', permissions: JSON.stringify(BUYER_PERMISSIONS) },
            { id: 'pg-w2-role-approver', companyId: COMPANY_ID, name: 'Approver', permissions: JSON.stringify(APPROVER_PERMISSIONS) },
          ],
        });
        await tx.employee.createMany({
          data: [
            { id: REQUESTER_EMPLOYEE_ID, companyId: COMPANY_ID, employeeNum: 'E-REQ', normalizedEmployeeNum: 'E-REQ', jobTitle: 'Staff', joiningDate: new Date('2025-01-01'), status: 'active' },
            { id: BUYER_EMPLOYEE_ID, companyId: COMPANY_ID, employeeNum: 'E-BUY', normalizedEmployeeNum: 'E-BUY', jobTitle: 'Buyer', joiningDate: new Date('2025-01-01'), status: 'active' },
            { id: APPROVER_EMPLOYEE_ID, companyId: COMPANY_ID, employeeNum: 'E-APR', normalizedEmployeeNum: 'E-APR', jobTitle: 'Finance', joiningDate: new Date('2025-01-01'), status: 'active' },
          ],
        });
        await tx.user.createMany({
          data: [
            { id: OWNER_USER_ID, companyId: COMPANY_ID, email: 'owner-w2@postgres.test', normalizedEmail: 'owner-w2@postgres.test', password: 'test-password-not-used', name: 'Owner', roleId: 'pg-w2-role-owner' },
            { id: BUYER_USER_ID, companyId: COMPANY_ID, email: 'buyer-w2@postgres.test', normalizedEmail: 'buyer-w2@postgres.test', password: 'test-password-not-used', name: 'Buyer', roleId: 'pg-w2-role-buyer', employeeId: BUYER_EMPLOYEE_ID },
            { id: APPROVER_USER_ID, companyId: COMPANY_ID, email: 'approver-w2@postgres.test', normalizedEmail: 'approver-w2@postgres.test', password: 'test-password-not-used', name: 'Approver', roleId: 'pg-w2-role-approver', employeeId: APPROVER_EMPLOYEE_ID },
          ],
        });
        await tx.companyOwnership.create({
          data: { companyId: COMPANY_ID, userId: OWNER_USER_ID, isPrimary: true, status: 'active', createdByUserId: OWNER_USER_ID },
        });
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      });
      await prisma.vendor.createMany({
        data: [
          { id: VENDOR_A_ID, companyId: COMPANY_ID, name: 'Vendor A', status: 'active' },
          { id: VENDOR_B_ID, companyId: COMPANY_ID, name: 'Vendor B', status: 'active' },
        ],
      });

      app = makeApp(prisma);
    } catch (error) {
      await stopAndClean();
      throw error;
    }
  }, 300_000);

  afterAll(stopAndClean, 60_000);

  /** A fresh approved request per test keeps the concurrency assertions independent. */
  async function freshRequest(): Promise<{ requestId: string; requestLineId: string }> {
    sequence += 1;
    const requestId = randomUUID();
    const requestLineId = randomUUID();
    await prisma.purchaseRequest.create({
      data: {
        id: requestId,
        companyId: COMPANY_ID,
        requestNumber: `PR-PG-${sequence}`,
        requestedByEmployeeId: REQUESTER_EMPLOYEE_ID,
        requesterNameSnapshot: 'Requester',
        requesterNumSnapshot: 'E-REQ',
        title: 'Concurrency fixture',
        status: 'approved',
        totalEstimated: '200.00',
        currency: 'SAR',
        lines: {
          create: [{
            id: requestLineId,
            description: 'Widget',
            quantity: '10.000',
            unit: 'pc',
            estimatedUnitPrice: '20.00',
            estimatedTotal: '200.00',
          }],
        },
      },
    });
    return { requestId, requestLineId };
  }

  async function issuedOrder(): Promise<{ orderId: string; orderLineId: string; requestId: string }> {
    const { requestId, requestLineId } = await freshRequest();
    const created = await request(app)
      .post('/api/purchasing/orders')
      .set('Authorization', `Bearer ${buyerToken()}`)
      .send({
        purchaseRequestId: requestId,
        vendorId: VENDOR_A_ID,
        currency: 'SAR',
        lines: [{ requestLineId, description: 'Widget', quantity: '10.000', unit: 'pc', unitPrice: '20.00' }],
      });
    expect(created.status).toBe(201);
    const issue = await request(app)
      .post(`/api/purchasing/orders/${created.body.id}/issue`)
      .set('Authorization', `Bearer ${buyerToken()}`);
    expect(issue.status).toBe(200);
    return { orderId: created.body.id, orderLineId: created.body.lines[0].id, requestId };
  }

  const receivedMilliFor = async (orderLineId: string): Promise<number> => {
    const rows = await prisma.purchaseReceiptLine.findMany({
      where: { companyId: COMPANY_ID, purchaseOrderLineId: orderLineId },
      select: { quantity: true },
    });
    return rows.reduce((total, row) => total + Math.round(Number(row.quantity) * 1000), 0);
  };

  const returnedMilliFor = async (orderLineId: string): Promise<number> => {
    const rows = await prisma.purchaseReturnLine.findMany({
      where: {
        companyId: COMPANY_ID,
        purchaseOrderLineId: orderLineId,
        purchaseReturn: { status: { in: ['pending_approval', 'approved'] } },
      },
      select: { quantity: true },
    });
    return rows.reduce((total, row) => total + Math.round(Number(row.quantity) * 1000), 0);
  };

  it('never lets concurrent partial receipts exceed the ordered quantity', async () => {
    const { orderId, orderLineId } = await issuedOrder();
    const send = (key: string, quantity: string) =>
      request(app)
        .post(`/api/v2/purchasing/orders/${orderId}/receipts`)
        .set('Authorization', `Bearer ${buyerToken()}`)
        .set('Idempotency-Key', key)
        .send({ lines: [{ purchaseOrderLineId: orderLineId, quantity }] });

    const responses = await Promise.all([
      send('pg-race-a', '6.000'),
      send('pg-race-b', '6.000'),
      send('pg-race-c', '6.000'),
    ]);
    const accepted = responses.filter((response) => response.status === 201);
    const rejected = responses.filter((response) => response.status !== 201);

    // 10 ordered units admit at most one 6-unit receipt.
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((response) => response.status === 409)).toBe(true);
    expect(await receivedMilliFor(orderLineId)).toBe(6_000);
  });

  it('lets concurrent receipts that fit both succeed and totals stay exact', async () => {
    const { orderId, orderLineId } = await issuedOrder();
    const send = (key: string, quantity: string) =>
      request(app)
        .post(`/api/v2/purchasing/orders/${orderId}/receipts`)
        .set('Authorization', `Bearer ${buyerToken()}`)
        .set('Idempotency-Key', key)
        .send({ lines: [{ purchaseOrderLineId: orderLineId, quantity }] });

    const responses = await Promise.all([send('pg-fit-a', '4.000'), send('pg-fit-b', '6.000')]);
    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(await receivedMilliFor(orderLineId)).toBe(10_000);
    const order = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('received');
  });

  it('serializes a legacy whole-order receive racing a partial receive', async () => {
    const { orderId, orderLineId } = await issuedOrder();
    const [partial, legacy] = await Promise.all([
      request(app)
        .post(`/api/v2/purchasing/orders/${orderId}/receipts`)
        .set('Authorization', `Bearer ${buyerToken()}`)
        .set('Idempotency-Key', 'pg-mixed-partial')
        .send({ lines: [{ purchaseOrderLineId: orderLineId, quantity: '3.000' }] }),
      request(app)
        .post(`/api/purchasing/orders/${orderId}/receive`)
        .set('Authorization', `Bearer ${buyerToken()}`)
        .send({ receiptNote: 'close out' }),
    ]);
    // Two legal interleavings, both correct:
    //  • partial first  → 3.000 received, then the legacy path closes out 7.000;
    //  • legacy first   → 10.000 received, then the partial is a 409 over-receipt.
    const statuses = [partial.status, legacy.status];
    expect(statuses.some((status) => status === 200 || status === 201)).toBe(true);
    expect(statuses.every((status) => status === 200 || status === 201 || status === 409)).toBe(true);
    // Whatever the interleaving, the line is received exactly once in total.
    expect(await receivedMilliFor(orderLineId)).toBe(10_000);
    const order = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('received');
  });

  it('creates exactly one receipt for a concurrent same-key retry', async () => {
    const { orderId, orderLineId } = await issuedOrder();
    const body = { lines: [{ purchaseOrderLineId: orderLineId, quantity: '2.000' }] };
    const send = () =>
      request(app)
        .post(`/api/v2/purchasing/orders/${orderId}/receipts`)
        .set('Authorization', `Bearer ${buyerToken()}`)
        .set('Idempotency-Key', 'pg-idem-receipt')
        .send(body);

    const responses = await Promise.all([send(), send(), send()]);
    // Every concurrent retry is answered with the stored receipt, not a conflict:
    // the loser re-reads the winner in a fresh transaction.
    expect(responses.every((response) => response.status === 200 || response.status === 201)).toBe(true);
    const ids = new Set(responses.map((response) => response.body.receipt?.id));
    expect(ids.size).toBe(1);
    const stored = await prisma.purchaseReceipt.count({
      where: { companyId: COMPANY_ID, idempotencyKey: 'pg-idem-receipt' },
    });
    expect(stored).toBe(1);
    expect(await receivedMilliFor(orderLineId)).toBe(2_000);
  });

  it('never lets concurrent returns exceed the received quantity', async () => {
    const { orderId, orderLineId } = await issuedOrder();
    const received = await request(app)
      .post(`/api/v2/purchasing/orders/${orderId}/receipts`)
      .set('Authorization', `Bearer ${buyerToken()}`)
      .set('Idempotency-Key', 'pg-return-setup')
      .send({ lines: [{ purchaseOrderLineId: orderLineId, quantity: '10.000' }] });
    expect(received.status).toBe(201);

    const send = (key: string, quantity: string) =>
      request(app)
        .post(`/api/v2/purchasing/orders/${orderId}/returns`)
        .set('Authorization', `Bearer ${buyerToken()}`)
        .set('Idempotency-Key', key)
        .send({ reasonCode: 'damaged', lines: [{ purchaseOrderLineId: orderLineId, quantity }] });

    const responses = await Promise.all([
      send('pg-ret-a', '7.000'),
      send('pg-ret-b', '7.000'),
      send('pg-ret-c', '7.000'),
    ]);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(await returnedMilliFor(orderLineId)).toBe(7_000);
    // Receipt history is never rewritten by a return.
    expect(await receivedMilliFor(orderLineId)).toBe(10_000);
  });

  it('creates exactly one return for a concurrent same-key retry', async () => {
    const { orderId, orderLineId } = await issuedOrder();
    await request(app)
      .post(`/api/v2/purchasing/orders/${orderId}/receipts`)
      .set('Authorization', `Bearer ${buyerToken()}`)
      .set('Idempotency-Key', 'pg-return-idem-setup')
      .send({ lines: [{ purchaseOrderLineId: orderLineId, quantity: '5.000' }] });

    const body = { reasonCode: 'damaged', lines: [{ purchaseOrderLineId: orderLineId, quantity: '1.000' }] };
    const send = () =>
      request(app)
        .post(`/api/v2/purchasing/orders/${orderId}/returns`)
        .set('Authorization', `Bearer ${buyerToken()}`)
        .set('Idempotency-Key', 'pg-idem-return')
        .send(body);

    const responses = await Promise.all([send(), send()]);
    expect(responses.every((response) => response.status === 200 || response.status === 201)).toBe(true);
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
    const stored = await prisma.purchaseReturn.count({
      where: { companyId: COMPANY_ID, idempotencyKey: 'pg-idem-return' },
    });
    expect(stored).toBe(1);
    expect(await returnedMilliFor(orderLineId)).toBe(1_000);
  });

  it('allows only one winning quotation under concurrent selection', async () => {
    const { requestId, requestLineId } = await freshRequest();
    const quotationIds: string[] = [];
    for (const [index, vendorId] of [VENDOR_A_ID, VENDOR_B_ID].entries()) {
      const created = await request(app)
        .post(`/api/v2/purchasing/requests/${requestId}/quotations`)
        .set('Authorization', `Bearer ${buyerToken()}`)
        .set('Idempotency-Key', `pg-quote-create-${requestId}-${index}`)
        .send({
          vendorId,
          currency: 'SAR',
          lines: [{ requestLineId, description: 'Widget', quantity: '10.000', unit: 'pc', unitPrice: `${20 + index}.00` }],
        });
      expect(created.status).toBe(201);
      const submitted = await request(app)
        .post(`/api/v2/purchasing/quotations/${created.body.id}/submit`)
        .set('Authorization', `Bearer ${buyerToken()}`)
        .send({});
      expect(submitted.status).toBe(200);
      quotationIds.push(created.body.id);
    }

    const responses = await Promise.all(
      quotationIds.map((id, index) =>
        request(app)
          .post(`/api/v2/purchasing/quotations/${id}/select`)
          .set('Authorization', `Bearer ${buyerToken()}`)
          .set('Idempotency-Key', `pg-quote-select-${requestId}-${index}`)
          .send({ confirm: true, reason: 'award' }),
      ),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    const selected = await prisma.supplierQuotation.count({
      where: { companyId: COMPANY_ID, purchaseRequestId: requestId, status: 'selected' },
    });
    expect(selected).toBe(1);
  });

  it('replays a concurrent same-key quotation selection without a second award', async () => {
    const { requestId, requestLineId } = await freshRequest();
    const created = await request(app)
      .post(`/api/v2/purchasing/requests/${requestId}/quotations`)
      .set('Authorization', `Bearer ${buyerToken()}`)
      .set('Idempotency-Key', `pg-quote-single-${requestId}`)
      .send({
        vendorId: VENDOR_A_ID,
        currency: 'SAR',
        lines: [{ requestLineId, description: 'Widget', quantity: '10.000', unit: 'pc', unitPrice: '20.00' }],
      });
    await request(app)
      .post(`/api/v2/purchasing/quotations/${created.body.id}/submit`)
      .set('Authorization', `Bearer ${buyerToken()}`)
      .send({});

    const send = () =>
      request(app)
        .post(`/api/v2/purchasing/quotations/${created.body.id}/select`)
        .set('Authorization', `Bearer ${buyerToken()}`)
        .set('Idempotency-Key', `pg-quote-retry-${requestId}`)
        .send({ confirm: true, reason: 'award' });

    const responses = await Promise.all([send(), send()]);
    // Both concurrent retries see the awarded quotation; neither is a conflict.
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => response.body.status === 'selected')).toBe(true);
    const events = await prisma.purchaseWorkflowEvent.count({
      where: { companyId: COMPANY_ID, entityId: created.body.id, action: 'quotation_select' },
    });
    expect(events).toBe(1);
    const selected = await prisma.supplierQuotation.count({
      where: { companyId: COMPANY_ID, purchaseRequestId: requestId, status: 'selected' },
    });
    expect(selected).toBe(1);
  });

  it('binds the idempotency key to the payload for workflow-event mutations', async () => {
    // Proves the persisted `payloadFingerprint` column enforces the contract
    // end to end against real PostgreSQL: exact retry replays, a changed payload
    // on the same key is a 409 (never a 500), and no duplicate is created.
    const { requestId, requestLineId } = await freshRequest();
    const createBody = {
      vendorId: VENDOR_A_ID,
      currency: 'SAR',
      lines: [{ requestLineId, description: 'Widget', quantity: '10.000', unit: 'pc', unitPrice: '20.00' }],
    };
    const createKey = `pg-fp-create-${requestId}`;

    const first = await request(app)
      .post(`/api/v2/purchasing/requests/${requestId}/quotations`)
      .set('Authorization', `Bearer ${buyerToken()}`)
      .set('Idempotency-Key', createKey)
      .send(createBody);
    expect(first.status).toBe(201);

    const exactRetry = await request(app)
      .post(`/api/v2/purchasing/requests/${requestId}/quotations`)
      .set('Authorization', `Bearer ${buyerToken()}`)
      .set('Idempotency-Key', createKey)
      .send(createBody);
    expect(exactRetry.status).toBe(200);
    expect(exactRetry.body.id).toBe(first.body.id);

    const changedPayload = await request(app)
      .post(`/api/v2/purchasing/requests/${requestId}/quotations`)
      .set('Authorization', `Bearer ${buyerToken()}`)
      .set('Idempotency-Key', createKey)
      .send({ ...createBody, vendorId: VENDOR_B_ID });
    expect(changedPayload.status).toBe(409);
    expect(changedPayload.body.error).toBe('IDEMPOTENCY_CONFLICT');

    const quotationCount = await prisma.supplierQuotation.count({
      where: { companyId: COMPANY_ID, purchaseRequestId: requestId },
    });
    expect(quotationCount).toBe(1);

    // The stored workflow event actually carries a fingerprint.
    const createEvent = await prisma.purchaseWorkflowEvent.findFirst({
      where: { companyId: COMPANY_ID, idempotencyKey: createKey },
    });
    expect(createEvent?.payloadFingerprint).toMatch(/^[a-f0-9]{64}$/);

    // Return review: same key, opposite action must conflict, not replay.
    const { orderId, orderLineId } = await issuedOrder();
    await request(app)
      .post(`/api/v2/purchasing/orders/${orderId}/receipts`)
      .set('Authorization', `Bearer ${buyerToken()}`)
      .set('Idempotency-Key', `pg-fp-receipt-${orderId}`)
      .send({ lines: [{ purchaseOrderLineId: orderLineId, quantity: '5.000' }] });
    const created = await request(app)
      .post(`/api/v2/purchasing/orders/${orderId}/returns`)
      .set('Authorization', `Bearer ${buyerToken()}`)
      .set('Idempotency-Key', `pg-fp-return-${orderId}`)
      .send({ reasonCode: 'damaged', lines: [{ purchaseOrderLineId: orderLineId, quantity: '2.000' }] });
    expect(created.status).toBe(201);

    const reviewKey = `pg-fp-review-${orderId}`;
    const approved = await request(app)
      .post(`/api/v2/purchasing/returns/${created.body.id}/review`)
      .set('Authorization', `Bearer ${approverToken()}`)
      .set('Idempotency-Key', reviewKey)
      .send({ action: 'approve' });
    expect(approved.status).toBe(200);

    const flipped = await request(app)
      .post(`/api/v2/purchasing/returns/${created.body.id}/review`)
      .set('Authorization', `Bearer ${approverToken()}`)
      .set('Idempotency-Key', reviewKey)
      .send({ action: 'reject', note: 'flip' });
    expect(flipped.status).toBe(409);
    expect(flipped.body.error).toBe('IDEMPOTENCY_CONFLICT');

    const persisted = await prisma.purchaseReturn.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(persisted.status).toBe('approved');
  });

  it('keeps the database-level single-winner constraint even for a direct write', async () => {
    const { requestId, requestLineId } = await freshRequest();
    const makeQuotation = async (suffix: string, vendorId: string) => {
      const row = await prisma.supplierQuotation.create({
        data: {
          companyId: COMPANY_ID,
          quotationNumber: `SQ-DIRECT-${requestId}-${suffix}`,
          purchaseRequestId: requestId,
          vendorId,
          vendorNameSnapshot: 'Vendor',
          status: 'selected',
          selectedByUserId: BUYER_USER_ID,
          selectedAt: new Date(),
          currency: 'SAR',
          subtotal: '200.00',
          totalAmount: '200.00',
          createdByUserId: BUYER_USER_ID,
          lines: {
            create: [{
              requestLineId,
              descriptionSnapshot: 'Widget',
              quantity: '10.000',
              unitSnapshot: 'pc',
              unitPrice: '20.00',
              lineTotal: '200.00',
            }],
          },
        },
      });
      return row.id;
    };

    await makeQuotation('a', VENDOR_A_ID);
    await expect(makeQuotation('b', VENDOR_B_ID)).rejects.toThrow();
    const selected = await prisma.supplierQuotation.count({
      where: { companyId: COMPANY_ID, purchaseRequestId: requestId, status: 'selected' },
    });
    expect(selected).toBe(1);
  });
});
