import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CapturingRecoveryDeliveryAdapter,
  CredentialRecoveryService,
  InMemoryRecoveryRateLimitStore,
  RecoveryRateLimiter,
  DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
  TestOnlyMapRecoveryTargetStore,
} from '../src/credentialRecovery';
import { mintRecoveryTokenMaterial } from '../src/credentialRecovery/tokenCrypto';
import {
  OWNER_RECOVERY_REASON_CATEGORIES,
  encodeOwnerRecoveryIdempotencyHash,
  parseOwnerRecoveryIdempotencyHash,
  registerPlatformOwnerRecoveryRoutes,
} from '../src/platformOwnerRecovery';
import {
  DEFAULT_PLATFORM_RECENT_MFA_MAX_AGE_MS,
  PLATFORM_PERMISSIONS,
  type PlatformPrincipalContext,
} from '../src/platformAuth';

const TOKEN_PEPPER = 'e3-test-recovery-token-pepper-32chars-min';
const RATE_PEPPER = 'e3-test-recovery-rate-limit-pepper-32ch';
const ENV_BINDING = 'test:e3-fixture-fp';
const COMPANY_ID = 'c-platform-e3';
const OWNER_USER_ID = 'u-platform-owner';
const OWNER_EMAIL = 'owner@platform-e3.test';
const PLATFORM_PRINCIPAL_ID = 'platform-op-1';
const ROUTE = `/api/platform/v1/companies/${COMPANY_ID}/owner-recovery/initiate`;

function validBody(overrides?: Partial<ReturnType<typeof baseBody>>) {
  return { ...baseBody(), ...overrides };
}

function baseBody() {
  return {
    reasonCategory: 'verified_owner_request' as const,
    approvalReference: 'TICKET-2026-001',
    confirmation: true as const,
  };
}

function canonicalDigest(body: ReturnType<typeof validBody>, companyId = COMPANY_ID): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    companyId,
    reasonCategory: body.reasonCategory,
    approvalReference: body.approvalReference,
    confirmation: true,
  })).digest('hex');
}

function makePlatformFixture(options?: {
  permissions?: string[];
  mfaVerifiedAt?: Date;
  clock?: () => Date;
  stalePendingMs?: number;
  deliveryTimeoutMs?: number;
  deliveryAdapter?: CapturingRecoveryDeliveryAdapter;
  rateLimitPolicy?: typeof DEFAULT_RECOVERY_RATE_LIMIT_POLICY;
  recordDeliveryStatusImpl?: (input: {
    recoveryRequestId: string;
    deliveryStatus: string;
  }) => Promise<unknown>;
  /** When set, the WithEffect mock throws inside the transactional effect. */
  platformAuditEffectThrows?: boolean;
}) {
  const permissions = options?.permissions ?? [
    PLATFORM_PERMISSIONS.COMPANIES_OWNER_RECOVERY_INITIATE,
  ];
  const clock = options?.clock ?? (() => new Date('2026-07-28T12:00:00.000Z'));
  const mfaVerifiedAt = options?.mfaVerifiedAt ?? new Date('2026-07-28T12:00:00.000Z');
  const idempotency: Array<{
    principalId: string;
    key: string;
    requestHash: string;
    companyId: string;
  }> = [];
  const platformAudits: unknown[] = [];
  const company = { id: COMPANY_ID, code: 'CMP-PLAT', name: 'Platform E3 Co' };
  const user = {
    id: OWNER_USER_ID,
    companyId: COMPANY_ID,
    normalizedEmail: OWNER_EMAIL,
    accountStatus: 'active',
    employeeId: null,
    employee: null,
  };
  const ownerships = [{
    id: 'own-plat',
    companyId: COMPANY_ID,
    userId: OWNER_USER_ID,
    isPrimary: true,
    status: 'active',
    endedAt: null,
    user,
  }];

  const recoveryRows = new Map<string, Record<string, unknown>>();

  // Serialize transactions like pg_advisory_xact_lock for concurrent same-key races.
  let txChain: Promise<unknown> = Promise.resolve();

  const prisma: Record<string, unknown> = {
    $executeRaw: vi.fn(async () => 1),
    credentialRecoveryRequest: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        recoveryRows.get(where.id) ?? null,
      ),
      // Intentionally NOT used for correlation — latest-row search must not exist.
      findFirst: vi.fn(async () => {
        throw new Error('findFirst must not be used for owner-recovery idempotency correlation');
      }),
    },
    company: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
        if (where.id === COMPANY_ID || where.code === company.code) return company;
        return null;
      }),
    },
    loginIdentity: {
      findUnique: vi.fn(async () => ({
        userId: OWNER_USER_ID,
        companyId: COMPANY_ID,
        normalizedIdentifier: OWNER_EMAIL,
        type: 'email',
      })),
    },
    user: {
      findFirst: vi.fn(async () => ({
        id: OWNER_USER_ID,
        companyId: COMPANY_ID,
        normalizedEmail: OWNER_EMAIL,
        accountStatus: 'active',
        employeeId: null,
        employee: null,
      })),
    },
    companyOwnership: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.companyId !== COMPANY_ID) return [];
        return ownerships.filter((row) =>
          row.isPrimary === where.isPrimary
          && row.status === where.status
          && row.endedAt === where.endedAt,
        ).map((row) => ({ ...row, user }));
      }),
    },
    platformIdempotencyKey: {
      findUnique: vi.fn(async ({ where }: { where: { principalId_key: { principalId: string; key: string } } }) =>
        idempotency.find((row) =>
          row.principalId === where.principalId_key.principalId
          && row.key === where.principalId_key.key,
        ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: typeof idempotency[number] }) => {
        idempotency.push({ ...data });
        return data;
      }),
      update: vi.fn(async ({
        where,
        data,
      }: {
        where: { principalId_key: { principalId: string; key: string } };
        data: { requestHash: string };
      }) => {
        const row = idempotency.find((item) =>
          item.principalId === where.principalId_key.principalId
          && item.key === where.principalId_key.key,
        );
        if (!row) throw new Error('missing idempotency row');
        row.requestHash = data.requestHash;
        return row;
      }),
    },
    platformAuditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        platformAudits.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
      const run = txChain.then(() => fn(prisma));
      txChain = run.then(() => undefined, () => undefined);
      return run;
    }),
    _store: { idempotency, platformAudits, recoveryRows },
  };

  const targetStore = new TestOnlyMapRecoveryTargetStore(new Map());
  targetStore.set({
    principalDomain: 'company_primary_owner',
    principalId: OWNER_USER_ID,
    companyId: COMPANY_ID,
    credentialVersion: 1,
  });

  let recoverySequence = 0;
  const recoveryService = {
    issueInTransaction: vi.fn(async (_tx: unknown, input: { requestId: string }) => {
      const minted = mintRecoveryTokenMaterial(
        {
          principalDomain: 'company_primary_owner',
          purpose: 'password_reset',
          environmentBinding: ENV_BINDING,
        },
        { tokenPepper: TOKEN_PEPPER },
      );
      const recoveryRequestId = `rr-${input.requestId}-${++recoverySequence}`;
      recoveryRows.set(recoveryRequestId, {
        id: recoveryRequestId,
        principalDomain: 'company_primary_owner',
        principalId: OWNER_USER_ID,
        companyId: COMPANY_ID,
        purpose: 'password_reset',
        initiatedBy: 'platform_operator',
        initiatorPrincipalId: PLATFORM_PRINCIPAL_ID,
        deliveryStatus: 'pending',
        createdAt: clock(),
        expiresAt: new Date(clock().getTime() + 60 * 60 * 1000),
        consumedAt: null,
        invalidatedAt: null,
      });
      return {
        recoveryRequestId,
        deliverySecret: minted.rawToken,
        expiresAt: new Date(clock().getTime() + 60 * 60 * 1000),
      };
    }),
    recordDeliveryStatusWithEffect: vi.fn(async (
      { recoveryRequestId, deliveryStatus }: {
        recoveryRequestId: string;
        deliveryStatus: string;
      },
      effect?: (tx: unknown, recorded: {
        recoveryRequestId: string;
        deliveryStatus: string;
        auditEventId: string;
      }) => Promise<unknown>,
    ) => {
      if (options?.recordDeliveryStatusImpl) {
        return options.recordDeliveryStatusImpl({ recoveryRequestId, deliveryStatus });
      }
      const row = recoveryRows.get(recoveryRequestId);
      if (row) row.deliveryStatus = deliveryStatus;
      const recorded = {
        recoveryRequestId,
        deliveryStatus,
        auditEventId: 'audit-1',
      };
      if (effect) {
        if (options?.platformAuditEffectThrows) {
          // Mimic service: effect throw aborts before commit (row stays pending).
          if (row) row.deliveryStatus = 'pending';
          return { ok: false, reason: 'callback_failed' };
        }
        await effect(prisma, recorded);
      }
      return { ok: true, value: recorded };
    }),
    recordDeliveryStatus: vi.fn(async ({ recoveryRequestId, deliveryStatus }: {
      recoveryRequestId: string;
      deliveryStatus: string;
    }) => {
      if (options?.recordDeliveryStatusImpl) {
        return options.recordDeliveryStatusImpl({ recoveryRequestId, deliveryStatus });
      }
      const row = recoveryRows.get(recoveryRequestId);
      if (row) row.deliveryStatus = deliveryStatus;
      return { ok: true, value: { recoveryRequestId, deliveryStatus, auditEventId: 'audit-1' } };
    }),
  } as unknown as CredentialRecoveryService;

  const deliveryAdapter = options?.deliveryAdapter ?? new CapturingRecoveryDeliveryAdapter();
  const rateLimiter = new RecoveryRateLimiter(
    new InMemoryRecoveryRateLimitStore(),
    RATE_PEPPER,
    options?.rateLimitPolicy ?? DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
    clock,
  );

  const principal: PlatformPrincipalContext = {
    id: PLATFORM_PRINCIPAL_ID,
    email: 'operator@platform.test',
    name: 'Operator',
    permissions,
    authorizationVersion: 1,
    sessionId: 'sess-1',
    mfaVerifiedAt,
    credentialVersion: 1,
  };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    (req as { requestId?: string }).requestId = 'req-platform-e3';
    res.locals.requestId = 'req-platform-e3';
    next();
  });
  const requirePlatformAuth: express.RequestHandler = (req, _res, next) => {
    (req as { platformPrincipal?: PlatformPrincipalContext }).platformPrincipal = principal;
    next();
  };
  registerPlatformOwnerRecoveryRoutes({
    app,
    prisma: prisma as never,
    requirePlatformAuth,
    recoveryService,
    rateLimiter,
    deliveryAdapter,
    rateLimitPepper: RATE_PEPPER,
    clock,
    stalePendingMs: options?.stalePendingMs,
    deliveryTimeoutMs: options?.deliveryTimeoutMs,
    isProduction: false,
  });

  return {
    app,
    prisma,
    deliveryAdapter,
    recoveryService,
    principal,
    store: prisma._store as {
      idempotency: typeof idempotency;
      platformAudits: Array<Record<string, unknown>>;
      recoveryRows: Map<string, Record<string, unknown>>;
    },
  };
}

describe('platform owner recovery (E3)', () => {
  beforeEach(() => {
    process.env.CREDENTIAL_RECOVERY_TOKEN_PEPPER = TOKEN_PEPPER;
    process.env.CREDENTIAL_RECOVERY_RATE_LIMIT_PEPPER = RATE_PEPPER;
  });

  it('encodes and strictly parses the v1 idempotency envelope', () => {
    const digest = 'a'.repeat(64);
    const recoveryId = 'rr-exact-001';
    const encoded = encodeOwnerRecoveryIdempotencyHash(digest, recoveryId);
    expect(encoded).toBe(`v1:${digest}:${recoveryId}`);
    expect(parseOwnerRecoveryIdempotencyHash(encoded)).toEqual({
      digest,
      recoveryRequestId: recoveryId,
    });
    expect(parseOwnerRecoveryIdempotencyHash(digest)).toBeNull();
    expect(parseOwnerRecoveryIdempotencyHash('v2:abc:rr-1')).toBeNull();
    expect(parseOwnerRecoveryIdempotencyHash('v1:short:rr-1')).toBeNull();
  });

  it('documents reason category enum values', () => {
    expect(OWNER_RECOVERY_REASON_CATEGORIES).toEqual([
      'lost_registered_channel',
      'company_lockout',
      'suspected_compromise',
      'verified_owner_request',
    ]);
  });

  it('returns 403 when owner recovery permission is missing', async () => {
    const { app } = makePlatformFixture({
      permissions: [PLATFORM_PERMISSIONS.COMPANIES_VIEW],
    });
    const res = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-no-perm-001')
      .send(validBody());
    expect(res.status).toBe(403);
    expect(res.body.messageKey).toBe('platform.forbidden');
  });

  it('rejects view and provision permissions without owner recovery initiate', async () => {
    for (const permissions of [
      [PLATFORM_PERMISSIONS.COMPANIES_VIEW],
      [PLATFORM_PERMISSIONS.COMPANIES_PROVISION],
      [PLATFORM_PERMISSIONS.COMPANIES_VIEW, PLATFORM_PERMISSIONS.COMPANIES_PROVISION],
    ]) {
      const { app } = makePlatformFixture({ permissions });
      const res = await request(app)
        .post(ROUTE)
        .set('Idempotency-Key', `idem-view-${permissions.join('-')}`)
        .send(validBody());
      expect(res.status).toBe(403);
    }
  });

  it('requires recent MFA and rejects stale mfaVerifiedAt', async () => {
    const stale = makePlatformFixture({
      mfaVerifiedAt: new Date(
        new Date('2026-07-28T12:00:00.000Z').getTime()
          - DEFAULT_PLATFORM_RECENT_MFA_MAX_AGE_MS
          - 60_000,
      ),
    });
    const res = await request(stale.app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-stale-mfa')
      .send(validBody());
    expect(res.status).toBe(403);
    expect(res.body.messageKey).toBe('platform.mfa_reauth_required');
  });

  it('requires Idempotency-Key header', async () => {
    const { app } = makePlatformFixture();
    const res = await request(app).post(ROUTE).send(validBody());
    expect(res.status).toBe(400);
    expect(res.body.messageKey).toBe('platform.idempotency_key_required');
  });

  it('rejects invalid reason, approvalReference, confirmation, and unknown fields', async () => {
    const { app } = makePlatformFixture();

    const badReason = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-bad-reason')
      .send({ ...validBody(), reasonCategory: 'unsupported_reason' });
    expect(badReason.status).toBe(400);

    const badApproval = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-bad-approval')
      .send({ ...validBody(), approvalReference: 'short' });
    expect(badApproval.status).toBe(400);

    const badConfirm = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-bad-confirm')
      .send({ ...validBody(), confirmation: false });
    expect(badConfirm.status).toBe(400);

    const unknownField = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-unknown-field')
      .send({ ...validBody(), evidenceUrl: 'https://evil.test' });
    expect(unknownField.status).toBe(400);
  });

  it('binds each Idempotency-Key to an exact recovery request envelope', async () => {
    const { app, store, deliveryAdapter } = makePlatformFixture();
    const body = validBody();
    const digest = canonicalDigest(body);

    const a = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-key-a')
      .send(body);
    expect(a.status).toBe(202);
    expect(a.body.status).toBe('owner_recovery_dispatched');

    deliveryAdapter.setNextStatus('failed');
    const b = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-key-b')
      .send(body);
    expect(b.status).toBe(503);

    expect(store.idempotency).toHaveLength(2);
    const envelopeA = parseOwnerRecoveryIdempotencyHash(store.idempotency[0].requestHash)!;
    const envelopeB = parseOwnerRecoveryIdempotencyHash(store.idempotency[1].requestHash)!;
    expect(envelopeA.digest).toBe(digest);
    expect(envelopeB.digest).toBe(digest);
    expect(envelopeA.recoveryRequestId).not.toBe(envelopeB.recoveryRequestId);
    expect(store.recoveryRows.get(envelopeA.recoveryRequestId)?.deliveryStatus).toBe('dispatched');
    expect(store.recoveryRows.get(envelopeB.recoveryRequestId)?.deliveryStatus).toBe('failed');

    const replayA = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-key-a')
      .send(body);
    expect(replayA.status).toBe(202);
    expect(replayA.body.status).toBe('owner_recovery_dispatched');
    expect(deliveryAdapter.deliveryCount).toBe(2);
  });

  it('keeps Key A replay isolated after Key B later dispatches', async () => {
    const { app, store, deliveryAdapter } = makePlatformFixture();
    const body = validBody();

    deliveryAdapter.setNextStatus('failed');
    const a = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-isolate-a')
      .send(body);
    expect(a.status).toBe(503);
    const envelopeA = parseOwnerRecoveryIdempotencyHash(store.idempotency[0].requestHash)!;

    deliveryAdapter.setNextStatus('dispatched');
    const b = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-isolate-b')
      .send(body);
    expect(b.status).toBe(202);
    expect(b.body.status).toBe('owner_recovery_dispatched');

    // Key A still correlates to its failed row, not Key B's dispatched success.
    const replayA = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-isolate-a')
      .send(body);
    expect(replayA.status).toBe(202);
    expect(replayA.body.status).toBe('owner_recovery_dispatched');
    const envelopeAAfter = parseOwnerRecoveryIdempotencyHash(
      store.idempotency.find((row) => row.key === 'idem-isolate-a')!.requestHash,
    )!;
    expect(envelopeAAfter.recoveryRequestId).not.toBe(envelopeA.recoveryRequestId);
    expect(store.recoveryRows.get(envelopeAAfter.recoveryRequestId)?.deliveryStatus).toBe('dispatched');
    const envelopeB = parseOwnerRecoveryIdempotencyHash(
      store.idempotency.find((row) => row.key === 'idem-isolate-b')!.requestHash,
    )!;
    expect(envelopeAAfter.recoveryRequestId).not.toBe(envelopeB.recoveryRequestId);
  });

  it('returns 409 when the same key is reused with a different canonical body', async () => {
    const { app } = makePlatformFixture();
    const first = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-conflict-body')
      .send(validBody());
    expect(first.status).toBe(202);

    const conflict = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-conflict-body')
      .send(validBody({ approvalReference: 'TICKET-2026-999' }));
    expect(conflict.status).toBe(409);
    expect(conflict.body.messageKey).toBe('platform.idempotency_conflict');
  });

  it('dispatches recovery once and replays idempotency key without second delivery', async () => {
    const { app, deliveryAdapter, store } = makePlatformFixture();
    const first = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-success-001')
      .send(validBody());
    expect(first.status).toBe(202);
    expect(first.body.status).toBe('owner_recovery_dispatched');
    expect(deliveryAdapter.deliveryCount).toBe(1);
    expect(deliveryAdapter.sent[0]?.hadSecret).toBe(true);

    const replay = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-success-001')
      .send(validBody());
    expect(replay.status).toBe(202);
    expect(replay.body.status).toBe('owner_recovery_dispatched');
    expect(deliveryAdapter.deliveryCount).toBe(1);
    expect(store.recoveryRows.size).toBe(1);
  });

  it('classifies a fresh pending operation without duplicate delivery', async () => {
    const { app, store } = makePlatformFixture();
    const seeded = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-fresh-pending')
      .send(validBody());
    expect(seeded.status).toBe(202);

    const envelope = parseOwnerRecoveryIdempotencyHash(store.idempotency[0].requestHash)!;
    store.recoveryRows.get(envelope.recoveryRequestId)!.deliveryStatus = 'pending';

    const replay = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-fresh-pending')
      .send(validBody());
    expect(replay.status).toBe(202);
    expect(replay.body.status).toBe('owner_recovery_pending');
    expect(store.recoveryRows.size).toBe(1);
  });

  it('replaces a stale pending operation and delivers a new token', async () => {
    const { app, deliveryAdapter, store } = makePlatformFixture({
      stalePendingMs: 60_000,
    });
    const seeded = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-stale-pending')
      .send(validBody());
    expect(seeded.status).toBe(202);
    expect(deliveryAdapter.deliveryCount).toBe(1);

    const before = parseOwnerRecoveryIdempotencyHash(store.idempotency[0].requestHash)!;
    const row = store.recoveryRows.get(before.recoveryRequestId)!;
    row.deliveryStatus = 'pending';
    row.createdAt = new Date('2026-07-28T11:00:00.000Z');

    const retry = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-stale-pending')
      .send(validBody());
    expect(retry.status).toBe(202);
    expect(retry.body.status).toBe('owner_recovery_dispatched');
    expect(deliveryAdapter.deliveryCount).toBe(2);
    expect(store.recoveryRows.size).toBe(2);
    const after = parseOwnerRecoveryIdempotencyHash(store.idempotency[0].requestHash)!;
    expect(after.recoveryRequestId).not.toBe(before.recoveryRequestId);
  });

  it('does not claim dispatch when adapter fails; replacement retry recovers truthfully', async () => {
    const { app, deliveryAdapter, store } = makePlatformFixture();
    deliveryAdapter.setNextStatus('failed');
    const first = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-failed-retry')
      .send(validBody());
    expect(first.status).toBe(503);
    expect(first.body.messageKey).toBe('platform.owner_recovery_delivery_failed');
    expect(deliveryAdapter.deliveryCount).toBe(1);
    expect(store.platformAudits.some((row) => String(row).includes('"status":"dispatched"')
      && String(row).includes('owner_recovery.initiate'))).toBe(false);

    deliveryAdapter.setNextStatus('dispatched');
    const retry = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-failed-retry')
      .send(validBody());
    expect(retry.status).toBe(202);
    expect(retry.body.status).toBe('owner_recovery_dispatched');
    expect(deliveryAdapter.deliveryCount).toBe(2);
    expect(store.recoveryRows.size).toBe(2);
  });

  it('serializes concurrent failed retries so only one owns the replacement secret', async () => {
    const { app, deliveryAdapter, store } = makePlatformFixture();
    deliveryAdapter.setNextStatus('failed');
    await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-concurrent-fail')
      .send(validBody());
    expect(deliveryAdapter.deliveryCount).toBe(1);

    deliveryAdapter.setNextStatus('dispatched');
    const [first, second] = await Promise.all([
      request(app).post(ROUTE).set('Idempotency-Key', 'idem-concurrent-fail').send(validBody()),
      request(app).post(ROUTE).set('Idempotency-Key', 'idem-concurrent-fail').send(validBody()),
    ]);

    const outcomes = [first.body.status, second.body.status];
    expect(outcomes.every((status) =>
      status === 'owner_recovery_dispatched' || status === 'owner_recovery_pending',
    )).toBe(true);
    expect(outcomes).toContain('owner_recovery_dispatched');
    // Original failed send + exactly one replacement delivery.
    expect(deliveryAdapter.deliveryCount).toBe(2);
    expect(deliveryAdapter.sent.every((row) => row.hadSecret)).toBe(true);
    expect(store.recoveryRows.size).toBe(2);
    expect(first.status === 503 || second.status === 503).toBe(false);
  });

  it('serializes concurrent stale-pending retries with one adapter call', async () => {
    const { app, deliveryAdapter, store } = makePlatformFixture({
      stalePendingMs: 60_000,
    });
    await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-concurrent-stale')
      .send(validBody());
    const envelope = parseOwnerRecoveryIdempotencyHash(store.idempotency[0].requestHash)!;
    const row = store.recoveryRows.get(envelope.recoveryRequestId)!;
    row.deliveryStatus = 'pending';
    row.createdAt = new Date('2026-07-28T11:00:00.000Z');
    const sendsBefore = deliveryAdapter.deliveryCount;

    const [first, second] = await Promise.all([
      request(app).post(ROUTE).set('Idempotency-Key', 'idem-concurrent-stale').send(validBody()),
      request(app).post(ROUTE).set('Idempotency-Key', 'idem-concurrent-stale').send(validBody()),
    ]);
    const outcomes = [first.body.status, second.body.status];
    expect(outcomes).toContain('owner_recovery_dispatched');
    expect(outcomes.every((status) =>
      status === 'owner_recovery_dispatched' || status === 'owner_recovery_pending',
    )).toBe(true);
    expect(deliveryAdapter.deliveryCount - sendsBefore).toBe(1);
    expect(store.recoveryRows.size).toBe(2);
  });

  it('leaves delivery pending on adapter wait-budget timeout without a second send', async () => {
    const adapter = new CapturingRecoveryDeliveryAdapter();
    let finish: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const originalSend = adapter.send.bind(adapter);
    adapter.send = vi.fn(async (input) => {
      await gate;
      return originalSend(input);
    });

    const { app, store } = makePlatformFixture({
      deliveryAdapter: adapter,
      deliveryTimeoutMs: 30,
    });
    const res = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-timeout-001')
      .send(validBody());
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('owner_recovery_pending');

    const envelope = parseOwnerRecoveryIdempotencyHash(store.idempotency[0].requestHash)!;
    expect(store.recoveryRows.get(envelope.recoveryRequestId)?.deliveryStatus).toBe('pending');

    const replay = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-timeout-001')
      .send(validBody());
    expect(replay.status).toBe(202);
    expect(replay.body.status).toBe('owner_recovery_pending');
    expect(adapter.send).toHaveBeenCalledTimes(1);

    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('does not claim dispatch when adapter throws', async () => {
    const { app, deliveryAdapter, store } = makePlatformFixture();
    deliveryAdapter.throwOnNextSend(new Error('provider boom'));
    const res = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-throw-001')
      .send(validBody());
    expect(res.status).toBe(503);
    expect(res.body.messageKey).toBe('platform.owner_recovery_delivery_failed');
    expect(Array.from(store.recoveryRows.values())[0]?.deliveryStatus).toBe('failed');
  });

  it('keeps tokens and emails out of platform audit rows', async () => {
    const { app, deliveryAdapter, store } = makePlatformFixture();
    await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-audit-clean')
      .send(validBody());
    const token = deliveryAdapter.consumeLastSecret();
    expect(token).toBeTruthy();
    const serialized = JSON.stringify(store.platformAudits);
    expect(serialized).not.toContain(token!);
    expect(serialized).not.toContain(OWNER_EMAIL);
    expect(serialized).not.toContain('idem-audit-clean');
  });

  it('fail-closes legacy plain-digest idempotency hashes', async () => {
    const { app, store } = makePlatformFixture();
    const body = validBody();
    await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-legacy-hash')
      .send(body);
    store.idempotency[0].requestHash = canonicalDigest(body);

    const replay = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-legacy-hash')
      .send(body);
    expect(replay.status).toBe(500);
    expect(replay.body.messageKey).toBe('platform.operation_failed');
  });

  it('does not convert confirmed dispatch into failed when status persistence throws', async () => {
    const { app, deliveryAdapter, store, recoveryService } = makePlatformFixture({
      recordDeliveryStatusImpl: async () => {
        throw new Error('audit write boom');
      },
    });
    const res = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-persist-dispatch-fail')
      .send(validBody());
    expect(res.status).toBe(500);
    expect(res.body.messageKey).toBe('platform.operation_failed');
    expect(deliveryAdapter.deliveryCount).toBe(1);
    expect(Array.from(store.recoveryRows.values())[0]?.deliveryStatus).toBe('pending');
    expect(store.platformAudits.some((row) =>
      String(row).includes('owner_recovery.delivery') && String(row).includes('"status":"dispatched"'),
    )).toBe(false);
    expect(store.platformAudits.some((row) =>
      String(row).includes('owner_recovery.delivery') && String(row).includes('"status":"failed"'),
    )).toBe(false);
    expect((recoveryService.recordDeliveryStatusWithEffect as ReturnType<typeof vi.fn>).mock.calls)
      .toHaveLength(1);
  });

  it('treats resolved RecoveryResult ok:false after dispatch as persistence failure', async () => {
    const { app, deliveryAdapter, store } = makePlatformFixture({
      recordDeliveryStatusImpl: async () => ({
        ok: false,
        reason: 'audit_rejected',
        detailCode: 'actor_inconsistent',
      }),
    });
    const res = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-persist-ok-false-dispatch')
      .send(validBody());
    expect(res.status).toBe(500);
    expect(res.body.messageKey).toBe('platform.operation_failed');
    expect(deliveryAdapter.deliveryCount).toBe(1);
    expect(Array.from(store.recoveryRows.values())[0]?.deliveryStatus).toBe('pending');
    expect(store.platformAudits.some((row) =>
      String(row).includes('owner_recovery.delivery') && String(row).includes('"status":"dispatched"'),
    )).toBe(false);
    expect(store.platformAudits.some((row) =>
      String(row).includes('owner_recovery.delivery') && String(row).includes('"status":"failed"'),
    )).toBe(false);
  });

  it('does not rewrite adapter failure when failed-status persistence throws', async () => {
    const deliveryAdapter = new CapturingRecoveryDeliveryAdapter();
    deliveryAdapter.setNextStatus('failed');
    const { app, store } = makePlatformFixture({
      deliveryAdapter,
      recordDeliveryStatusImpl: async () => {
        throw new Error('failed status write boom');
      },
    });
    const res = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-persist-failed-fail')
      .send(validBody());
    expect(res.status).toBe(500);
    expect(res.body.messageKey).toBe('platform.operation_failed');
    expect(Array.from(store.recoveryRows.values())[0]?.deliveryStatus).toBe('pending');
    expect(deliveryAdapter.deliveryCount).toBe(1);
  });

  it('treats resolved RecoveryResult ok:false after adapter failed as persistence failure', async () => {
    const deliveryAdapter = new CapturingRecoveryDeliveryAdapter();
    deliveryAdapter.setNextStatus('failed');
    const { app, store } = makePlatformFixture({
      deliveryAdapter,
      recordDeliveryStatusImpl: async () => ({
        ok: false,
        reason: 'concurrent_conflict',
      }),
    });
    const res = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-persist-ok-false-failed')
      .send(validBody());
    expect(res.status).toBe(500);
    expect(res.body.messageKey).toBe('platform.operation_failed');
    expect(Array.from(store.recoveryRows.values())[0]?.deliveryStatus).toBe('pending');
    expect(store.platformAudits.some((row) =>
      String(row).includes('owner_recovery.delivery') && String(row).includes('"status":"failed"'),
    )).toBe(false);
  });

  it('does not rewrite adapter throw when failed-status persistence throws', async () => {
    const deliveryAdapter = new CapturingRecoveryDeliveryAdapter();
    deliveryAdapter.throwOnNextSend(new Error('smtp boom'));
    const { app, store } = makePlatformFixture({
      deliveryAdapter,
      recordDeliveryStatusImpl: async () => {
        throw new Error('failed status write boom');
      },
    });
    const res = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-persist-throw-fail')
      .send(validBody());
    expect(res.status).toBe(500);
    expect(Array.from(store.recoveryRows.values())[0]?.deliveryStatus).toBe('pending');
    expect(deliveryAdapter.deliveryCount).toBe(0);
  });

  it('treats resolved RecoveryResult ok:false after adapter throw as persistence failure', async () => {
    const deliveryAdapter = new CapturingRecoveryDeliveryAdapter();
    deliveryAdapter.throwOnNextSend(new Error('smtp boom'));
    const { app, store } = makePlatformFixture({
      deliveryAdapter,
      recordDeliveryStatusImpl: async () => ({
        ok: false,
        reason: 'token_invalid',
      }),
    });
    const res = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-persist-ok-false-throw')
      .send(validBody());
    expect(res.status).toBe(500);
    expect(Array.from(store.recoveryRows.values())[0]?.deliveryStatus).toBe('pending');
  });

  it('rolls back terminal claim when Platform final audit effect fails', async () => {
    const { app, deliveryAdapter, store } = makePlatformFixture({
      platformAuditEffectThrows: true,
    });
    const res = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-platform-audit-effect-fail')
      .send(validBody());
    expect(res.status).toBe(500);
    expect(res.body.messageKey).toBe('platform.operation_failed');
    expect(deliveryAdapter.deliveryCount).toBe(1);
    expect(Array.from(store.recoveryRows.values())[0]?.deliveryStatus).toBe('pending');
    expect(store.platformAudits.some((row) =>
      String(row).includes('owner_recovery.delivery') && String(row).includes('"status":"dispatched"'),
    )).toBe(false);
  });

  it('rate-limits failed same-key replacement before minting another token', async () => {
    const tightPolicy = {
      ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
      company_owner_recovery_initiate: {
        ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY.company_owner_recovery_initiate,
        actor: { windowMs: 60 * 60_000, blockLimit: 1, alertLimit: 1 },
        company: { windowMs: 60 * 60_000, blockLimit: 100, alertLimit: 50 },
        target: { windowMs: 60 * 60_000, blockLimit: 100, alertLimit: 50 },
        global: { windowMs: 60 * 60_000, blockLimit: 100, alertLimit: 50 },
      },
    };
    const { app, deliveryAdapter, store } = makePlatformFixture({
      rateLimitPolicy: tightPolicy,
    });
    deliveryAdapter.setNextStatus('failed');
    const first = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-rl-failed')
      .send(validBody());
    expect(first.status).toBe(503);
    const envelopeBefore = store.idempotency[0].requestHash;
    const rowsBefore = store.recoveryRows.size;

    deliveryAdapter.setNextStatus('dispatched');
    const blocked = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-rl-failed')
      .send(validBody());
    expect(blocked.status).toBe(429);
    expect(blocked.body.messageKey).toBe('platform.owner_recovery_rate_limited');
    expect(store.idempotency[0].requestHash).toBe(envelopeBefore);
    expect(store.recoveryRows.size).toBe(rowsBefore);
    expect(deliveryAdapter.deliveryCount).toBe(1);
  });

  it('does not charge replacement quota for dispatched or fresh-pending replay', async () => {
    const tightPolicy = {
      ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
      company_owner_recovery_initiate: {
        ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY.company_owner_recovery_initiate,
        actor: { windowMs: 60 * 60_000, blockLimit: 1, alertLimit: 1 },
        company: { windowMs: 60 * 60_000, blockLimit: 100, alertLimit: 50 },
        target: { windowMs: 60 * 60_000, blockLimit: 100, alertLimit: 50 },
        global: { windowMs: 60 * 60_000, blockLimit: 100, alertLimit: 50 },
      },
    };
    const { app, store, deliveryAdapter } = makePlatformFixture({
      rateLimitPolicy: tightPolicy,
    });
    const first = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-rl-replay')
      .send(validBody());
    expect(first.status).toBe(202);

    const replayDispatched = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-rl-replay')
      .send(validBody());
    expect(replayDispatched.status).toBe(202);
    expect(replayDispatched.body.status).toBe('owner_recovery_dispatched');
    expect(deliveryAdapter.deliveryCount).toBe(1);

    const envelope = parseOwnerRecoveryIdempotencyHash(store.idempotency[0].requestHash)!;
    store.recoveryRows.get(envelope.recoveryRequestId)!.deliveryStatus = 'pending';
    const replayPending = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-rl-replay')
      .send(validBody());
    expect(replayPending.status).toBe(202);
    expect(replayPending.body.status).toBe('owner_recovery_pending');
    expect(store.recoveryRows.size).toBe(1);
  });

  it('rate-limits stale-pending replacement retries', async () => {
    const tightPolicy = {
      ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
      company_owner_recovery_initiate: {
        ...DEFAULT_RECOVERY_RATE_LIMIT_POLICY.company_owner_recovery_initiate,
        actor: { windowMs: 60 * 60_000, blockLimit: 1, alertLimit: 1 },
        company: { windowMs: 60 * 60_000, blockLimit: 100, alertLimit: 50 },
        target: { windowMs: 60 * 60_000, blockLimit: 100, alertLimit: 50 },
        global: { windowMs: 60 * 60_000, blockLimit: 100, alertLimit: 50 },
      },
    };
    const { app, store, deliveryAdapter } = makePlatformFixture({
      rateLimitPolicy: tightPolicy,
      stalePendingMs: 60_000,
    });
    await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-rl-stale')
      .send(validBody());
    const envelope = parseOwnerRecoveryIdempotencyHash(store.idempotency[0].requestHash)!;
    const row = store.recoveryRows.get(envelope.recoveryRequestId)!;
    row.deliveryStatus = 'pending';
    row.createdAt = new Date('2026-07-28T11:00:00.000Z');
    const envelopeBefore = store.idempotency[0].requestHash;

    const blocked = await request(app)
      .post(ROUTE)
      .set('Idempotency-Key', 'idem-rl-stale')
      .send(validBody());
    expect(blocked.status).toBe(429);
    expect(store.idempotency[0].requestHash).toBe(envelopeBefore);
    expect(store.recoveryRows.size).toBe(1);
    expect(deliveryAdapter.deliveryCount).toBe(1);
  });
});
