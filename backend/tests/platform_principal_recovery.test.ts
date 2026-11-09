import util from 'node:util';
import bcrypt from 'bcrypt';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CapturingRecoveryDeliveryAdapter,
  CredentialRecoveryService,
  InMemoryRecoveryRateLimitStore,
  RecoveryDeliveryScheduler,
  RecoveryRateLimiter,
  DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
  TestOnlyMapRecoveryTargetStore,
  withNormalizedResponseTime,
} from '../src/credentialRecovery';
import { mintRecoveryTokenMaterial } from '../src/credentialRecovery/tokenCrypto';
import {
  PLATFORM_ACCOUNT_DISCOVERY_ALTERNATE_CHANNEL_AVAILABLE,
  PLATFORM_DISCOVERY_UNAVAILABLE_STATUS,
  PLATFORM_RECOVERY_CONFIRM_STATUS,
  PLATFORM_RECOVERY_INITIATE_STATUS,
  PLATFORM_RECOVERY_INVALID_MESSAGE_KEY,
  deliverPlatformPasswordRecovery,
  registerPlatformPrincipalRecoveryRoutes,
  resolvePlatformAccountDiscoveryEligibility,
  resolvePlatformPrincipalRecoveryEligibility,
  trustedRecoveryRequestSource,
} from '../src/platformPrincipalRecovery';
import {
  OWNER_RECOVERY_CONFIRM_STATUS,
  registerCompanyOwnerRecoveryRoutes,
} from '../src/companyOwnerRecovery';
import { NEW_PASSWORD_MIN_LENGTH } from '../src/credentialSecrets';

const TOKEN_PEPPER = 'e4-test-recovery-token-pepper-32chars-min';
const RATE_PEPPER = 'e4-test-recovery-rate-limit-pepper-32ch';
const ENV_BINDING = 'test:e4-fixture-fp';
const PLATFORM_EMAIL = 'platform.owner@example.test';
const PRINCIPAL_ID = 'pp-e4-principal';
const OTHER_PRINCIPAL_ID = 'pp-e4-other';
const OLD_PASSWORD = 'OldPlatformPass-123!';
const NEW_PASSWORD = 'NewPlatformPass-456!';

type RecoveryRow = {
  id: string;
  principalDomain: string;
  principalId: string;
  companyId: string | null;
  purpose: string;
  tokenHash: string | null;
  tokenHashAlgorithm: string | null;
  environmentBinding: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  supersededByRequestId: string | null;
  invalidatedAt: Date | null;
  invalidationReason: string | null;
  credentialVersionAtIssuance: number;
  initiatedBy: string;
  initiatorPrincipalId: string | null;
  deliveryChannel: string;
  deliveryStatus: string;
  requestSourceHash: string | null;
  auditEventId: string | null;
};

type PlatformRecoveryFixtureStore = {
  principal: {
    id: string;
    email: string;
    normalizedEmail: string;
    password: string;
    status: string;
    permissions: string;
    authorizationVersion: number;
    credentialVersion: number;
    name: string;
  };
  mfa: {
    principalId: string;
    state: string;
    secretCiphertext: string | null;
    pendingSecretCiphertext: string | null;
    backupCodeHashes: string;
    enrolledAt: Date | null;
    lastVerifiedAt: Date | null;
    lastUsedTimeStep: bigint | null;
    failedAttempts: number;
    lockedUntil: Date | null;
    challengeTokenHash?: string | null;
    challengePurpose?: string | null;
    challengeExpiresAt?: Date | null;
    challengeAttempts?: number;
  };
  refreshTokens: Array<{
    id: string;
    principalId: string;
    sessionId: string;
    revokedAt: Date | null;
    revokedReason: string | null;
    credentialVersion: number;
  }>;
  recoveryRequests: Map<string, RecoveryRow>;
  auditEvents: unknown[];
  platformAuditLogs: unknown[];
};

function makePlatformRecoveryPrisma(seed?: {
  passwordHash?: string;
  credentialVersion?: number;
  status?: string;
  mfaState?: string;
}) {
  const passwordHash = seed?.passwordHash ?? bcrypt.hashSync(OLD_PASSWORD, 4);
  const credentialVersion = seed?.credentialVersion ?? 1;
  const status = seed?.status ?? 'active';
  const mfaState = seed?.mfaState ?? 'enrolled';

  const principal = {
    id: PRINCIPAL_ID,
    email: PLATFORM_EMAIL,
    normalizedEmail: PLATFORM_EMAIL,
    password: passwordHash,
    status,
    permissions: '["platform.companies.view"]',
    authorizationVersion: 3,
    credentialVersion,
    name: 'Platform Owner',
  };
  const mfa = {
    principalId: PRINCIPAL_ID,
    state: mfaState,
    secretCiphertext: 'cipher-enrolled-secret',
    pendingSecretCiphertext: null as string | null,
    backupCodeHashes: '["hash-a","hash-b"]',
    enrolledAt: new Date('2026-01-01T00:00:00.000Z'),
    lastVerifiedAt: new Date('2026-07-01T00:00:00.000Z'),
    lastUsedTimeStep: 12345n,
    failedAttempts: 0,
    lockedUntil: null as Date | null,
    challengeTokenHash: null as string | null,
    challengePurpose: null as string | null,
    challengeExpiresAt: null as Date | null,
    challengeAttempts: 0,
  };
  const refreshTokens = [
    {
      id: 'prt-1',
      principalId: PRINCIPAL_ID,
      sessionId: 'sess-1',
      revokedAt: null as Date | null,
      revokedReason: null as string | null,
      credentialVersion,
    },
    {
      id: 'prt-other',
      principalId: OTHER_PRINCIPAL_ID,
      sessionId: 'sess-other',
      revokedAt: null as Date | null,
      revokedReason: null as string | null,
      credentialVersion: 1,
    },
  ];
  const recoveryRequests = new Map<string, RecoveryRow>();
  const auditEvents: unknown[] = [];
  const platformAuditLogs: unknown[] = [];

  const matchRecoveryWhere = (row: RecoveryRow, where: Record<string, unknown>): boolean => {
    for (const [key, value] of Object.entries(where)) {
      if (key === 'consumedAt' && value === null && row.consumedAt != null) return false;
      if (key === 'invalidatedAt' && value === null && row.invalidatedAt != null) return false;
      if (key === 'tokenHash' && row.tokenHash !== value) return false;
      if (key === 'companyId' && value === null && row.companyId != null) return false;
      if (key === 'id' && typeof value === 'object' && value !== null && 'not' in value) {
        if (row.id === (value as { not: string }).not) return false;
        continue;
      }
      if (key === 'id' && typeof value === 'object' && value !== null && 'in' in value) {
        if (!(value as { in: string[] }).in.includes(row.id)) return false;
        continue;
      }
      if (key in row && (row as Record<string, unknown>)[key] !== value) return false;
    }
    return true;
  };

  const buildTx = () => ({
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('');
      if (sql.includes('CredentialRecoveryRequest') && sql.includes('FOR UPDATE')) {
        const id = values[0] as string;
        const row = recoveryRequests.get(id);
        return row ? [{ ...row }] : [];
      }
      return [];
    }),
    credentialRecoveryRequest: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...recoveryRequests.values()].filter((row) => matchRecoveryWhere(row, where)),
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...recoveryRequests.values()].find((row) => matchRecoveryWhere(row, where)) ?? null,
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        recoveryRequests.get(where.id) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: RecoveryRow }) => {
        const row = {
          consumedAt: null,
          invalidatedAt: null,
          invalidationReason: null,
          supersededByRequestId: null,
          auditEventId: null,
          requestSourceHash: null,
          ...data,
        };
        recoveryRequests.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<RecoveryRow> }) => {
        const row = recoveryRequests.get(where.id);
        if (!row) throw new Error('missing recovery row');
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<RecoveryRow> }) => {
        let count = 0;
        for (const row of recoveryRequests.values()) {
          if (!matchRecoveryWhere(row, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      }),
    },
    credentialRecoveryAuditEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        auditEvents.push(data);
        return { id: data.id, ...data };
      }),
    },
    platformPrincipal: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id !== PRINCIPAL_ID) return null;
        if (where.status && principal.status !== where.status) return null;
        return { ...principal };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const expectedVersion = where.credentialVersion as number;
        if (
          where.id === PRINCIPAL_ID
          && where.status === 'active'
          && principal.status === 'active'
          && (
            principal.credentialVersion === expectedVersion
            || principal.credentialVersion + 1 === expectedVersion
          )
        ) {
          if (typeof data.password === 'string') principal.password = data.password;
          principal.credentialVersion = expectedVersion;
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
    platformRefreshToken: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of refreshTokens) {
          if (row.principalId !== where.principalId) continue;
          if (where.revokedAt === null && row.revokedAt !== null) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      }),
    },
    platformAuditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        platformAuditLogs.push(data);
        return data;
      }),
    },
    platformMfaCredential: {
      findUnique: vi.fn(async ({ where }: { where: { principalId: string } }) => {
        if (where.principalId !== PRINCIPAL_ID) return null;
        return { ...mfa };
      }),
      update: vi.fn(async ({ where, data }: { where: { principalId: string }; data: Record<string, unknown> }) => {
        if (where.principalId !== PRINCIPAL_ID) throw new Error('missing mfa');
        Object.assign(mfa, data);
        return { ...mfa };
      }),
    },
  });

  const tx = buildTx();
  const prisma: Record<string, unknown> = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    platformPrincipal: {
      findUnique: vi.fn(async ({ where }: { where: { normalizedEmail?: string; id?: string } }) => {
        if (where.normalizedEmail && where.normalizedEmail === principal.normalizedEmail) {
          return { ...principal };
        }
        if (where.id === PRINCIPAL_ID) return { ...principal };
        return null;
      }),
      findFirst: tx.platformPrincipal.findFirst,
    },
    _store: {
      principal,
      mfa,
      refreshTokens,
      recoveryRequests,
      auditEvents,
      platformAuditLogs,
    } satisfies PlatformRecoveryFixtureStore,
  };

  return {
    prisma: prisma as any,
    tx,
    store: prisma._store as PlatformRecoveryFixtureStore,
  };
}

function makePlatformRecoveryApp(options?: {
  prisma?: ReturnType<typeof makePlatformRecoveryPrisma>['prisma'];
  targetStore?: TestOnlyMapRecoveryTargetStore;
  deliveryAdapter?: CapturingRecoveryDeliveryAdapter;
  deliveryScheduler?: RecoveryDeliveryScheduler;
  timing?: {
    floorMs?: number;
    jitterMs?: number;
    clock?: () => number;
    delay?: (ms: number) => Promise<void>;
    random?: () => number;
  };
  performDummyCryptoWork?: () => Promise<void>;
  clock?: () => Date;
  alsoRegisterOwnerRoutes?: boolean;
}) {
  const built = options?.prisma
    ? {
      prisma: options.prisma,
      store: (options.prisma as { _store: PlatformRecoveryFixtureStore })._store,
    }
    : makePlatformRecoveryPrisma();
  const fixture = {
    prisma: built.prisma,
    store: built.store as PlatformRecoveryFixtureStore,
  };
  const targetStore = options?.targetStore ?? new TestOnlyMapRecoveryTargetStore(new Map());
  targetStore.set({
    principalDomain: 'platform_principal',
    principalId: PRINCIPAL_ID,
    companyId: null,
    credentialVersion: fixture.store.principal.credentialVersion,
    status: fixture.store.principal.status,
  });

  const deliveryAdapter = options?.deliveryAdapter ?? new CapturingRecoveryDeliveryAdapter();
  const deliveryScheduler = options?.deliveryScheduler ?? new RecoveryDeliveryScheduler();
  const rateStore = new InMemoryRecoveryRateLimitStore();
  const rateLimiter = new RecoveryRateLimiter(
    rateStore,
    RATE_PEPPER,
    DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
    options?.clock ?? (() => new Date('2026-07-30T12:00:00.000Z')),
  );
  const recoveryService = new CredentialRecoveryService({
    prisma: fixture.prisma as never,
    crypto: { tokenPepper: TOKEN_PEPPER },
    environmentBinding: ENV_BINDING,
    targetStore,
    clock: options?.clock ?? (() => new Date('2026-07-30T12:00:00.000Z')),
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const requestId = 'req-e4-test-001';
    (req as { requestId?: string }).requestId = requestId;
    res.locals.requestId = requestId;
    next();
  });
  registerPlatformPrincipalRecoveryRoutes({
    app,
    prisma: fixture.prisma as never,
    recoveryService,
    rateLimiter,
    deliveryAdapter,
    deliveryScheduler,
    timing: options?.timing ?? {
      floorMs: 0,
      jitterMs: 0,
      delay: async () => undefined,
      random: () => 0,
    },
    performDummyCryptoWork: options?.performDummyCryptoWork,
    isProduction: false,
  });

  if (options?.alsoRegisterOwnerRoutes) {
    targetStore.set({
      principalDomain: 'company_primary_owner',
      principalId: 'owner-cross',
      companyId: 'cmp-cross',
      credentialVersion: 1,
    });
    registerCompanyOwnerRecoveryRoutes({
      app,
      prisma: fixture.prisma as never,
      recoveryService,
      rateLimiter,
      deliveryAdapter,
      deliveryScheduler,
      timing: options?.timing ?? {
        floorMs: 0,
        jitterMs: 0,
        delay: async () => undefined,
        random: () => 0,
      },
      isProduction: false,
    });
  }

  process.env.CREDENTIAL_RECOVERY_RATE_LIMIT_PEPPER = RATE_PEPPER;
  process.env.CREDENTIAL_RECOVERY_TOKEN_PEPPER = TOKEN_PEPPER;

  return {
    app,
    fixture,
    deliveryAdapter,
    deliveryScheduler,
    recoveryService,
    targetStore,
    rateStore,
  };
}

function genericInitiateBody(body: Record<string, unknown>) {
  expect(body.status).toBe(PLATFORM_RECOVERY_INITIATE_STATUS);
  expect(body.requestId).toBeTruthy();
  expect(JSON.stringify(body)).not.toMatch(/principalId|email|credentialVersion|mfa|session/i);
}

describe('platform principal recovery (E4 unit/integration)', () => {
  beforeEach(() => {
    process.env.CREDENTIAL_RECOVERY_TOKEN_PEPPER = TOKEN_PEPPER;
    process.env.CREDENTIAL_RECOVERY_RATE_LIMIT_PEPPER = RATE_PEPPER;
    process.env.CREDENTIAL_RECOVERY_ENVIRONMENT_BINDING = ENV_BINDING;
  });

  describe('eligibility and discovery decision', () => {
    it('returns eligible active PlatformPrincipal by normalized email', async () => {
      const { prisma } = makePlatformRecoveryPrisma();
      const eligible = await resolvePlatformPrincipalRecoveryEligibility(prisma as never, {
        email: '  Platform.Owner@Example.TEST ',
      });
      expect(eligible).toEqual({
        principalId: PRINCIPAL_ID,
        recipientRef: `platform-email:${PRINCIPAL_ID}`,
      });
    });

    it('returns null for unknown or disabled principals', async () => {
      const unknown = makePlatformRecoveryPrisma();
      expect(await resolvePlatformPrincipalRecoveryEligibility(unknown.prisma as never, {
        email: 'ghost@example.test',
      })).toBeNull();

      const disabled = makePlatformRecoveryPrisma({ status: 'disabled' });
      expect(await resolvePlatformPrincipalRecoveryEligibility(disabled.prisma as never, {
        email: PLATFORM_EMAIL,
      })).toBeNull();
    });

    it('keeps account discovery unavailable without an alternate verified channel', () => {
      expect(PLATFORM_ACCOUNT_DISCOVERY_ALTERNATE_CHANNEL_AVAILABLE).toBe(false);
      expect(resolvePlatformAccountDiscoveryEligibility({
        recoveryIdentifier: PLATFORM_EMAIL,
      })).toBeNull();
      expect(resolvePlatformAccountDiscoveryEligibility({
        recoveryIdentifier: 'opaque-recovery-id-123',
      })).toBeNull();
    });
  });

  describe('POST /api/platform/v1/auth/recovery/initiate', () => {
    it('returns generic 202 for an active Platform email and schedules platform_password_reset', async () => {
      const { app, deliveryAdapter, deliveryScheduler, fixture } = makePlatformRecoveryApp();
      const res = await request(app)
        .post('/api/platform/v1/auth/recovery/initiate')
        .send({ email: PLATFORM_EMAIL });
      expect(res.status).toBe(202);
      genericInitiateBody(res.body);
      await deliveryScheduler.waitForIdle();
      expect(deliveryAdapter.deliveryCount).toBe(1);
      expect(deliveryAdapter.sent[0]?.template).toBe('platform_password_reset');
      const row = [...fixture.store.recoveryRequests.values()][0];
      expect(row?.principalDomain).toBe('platform_principal');
      expect(row?.purpose).toBe('password_reset');
      expect(row?.companyId).toBeNull();
      expect(row?.initiatedBy).toBe('self');
      expect(row?.tokenHash).toBeTruthy();
      expect(row?.tokenHash).not.toMatch(/recovery-token-v1/);
    });

    it('returns the same generic 202 for unknown, disabled, malformed, and unknown fields', async () => {
      const active = makePlatformRecoveryApp();
      const disabled = makePlatformRecoveryApp({
        prisma: makePlatformRecoveryPrisma({ status: 'disabled' }).prisma,
      });

      const cases: Array<{ app: express.Express; body: Record<string, unknown>; expectDelivery: boolean }> = [
        { app: active.app, body: { email: PLATFORM_EMAIL }, expectDelivery: true },
        { app: active.app, body: { email: 'ghost@example.test' }, expectDelivery: false },
        { app: disabled.app, body: { email: PLATFORM_EMAIL }, expectDelivery: false },
        { app: active.app, body: { email: '  Platform.Owner@Example.TEST ' }, expectDelivery: true },
        { app: active.app, body: { email: 'not-an-email' }, expectDelivery: false },
        { app: active.app, body: { email: PLATFORM_EMAIL, extra: true }, expectDelivery: false },
        { app: active.app, body: { principalId: PRINCIPAL_ID }, expectDelivery: false },
      ];

      for (const item of cases) {
        const before = item.app === active.app
          ? active.deliveryAdapter.deliveryCount
          : disabled.deliveryAdapter.deliveryCount;
        const res = await request(item.app)
          .post('/api/platform/v1/auth/recovery/initiate')
          .send(item.body);
        expect(res.status).toBe(202);
        genericInitiateBody(res.body);
        const harness = item.app === active.app ? active : disabled;
        await harness.deliveryScheduler.waitForIdle();
        if (!item.expectDelivery) {
          expect(harness.deliveryAdapter.deliveryCount).toBe(before);
        }
      }
    });

    it('keeps adapter latency outside the HTTP path and contains failures', async () => {
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
      const scheduler = new RecoveryDeliveryScheduler({ taskTimeoutMs: 5_000 });
      const harness = makePlatformRecoveryApp({
        deliveryAdapter: adapter,
        deliveryScheduler: scheduler,
      });

      const started = Date.now();
      const res = await request(harness.app)
        .post('/api/platform/v1/auth/recovery/initiate')
        .send({ email: PLATFORM_EMAIL });
      expect(res.status).toBe(202);
      expect(Date.now() - started).toBeLessThan(400);
      expect(adapter.deliveryCount).toBe(0);

      finish?.();
      await scheduler.waitForIdle();
      expect(adapter.deliveryCount).toBe(1);

      const failed = makePlatformRecoveryApp();
      failed.deliveryAdapter.setNextStatus('failed');
      await request(failed.app)
        .post('/api/platform/v1/auth/recovery/initiate')
        .send({ email: PLATFORM_EMAIL });
      await failed.deliveryScheduler.waitForIdle();

      const throwing = makePlatformRecoveryApp();
      throwing.deliveryAdapter.throwOnNextSend(new Error('smtp down'));
      await request(throwing.app)
        .post('/api/platform/v1/auth/recovery/initiate')
        .send({ email: PLATFORM_EMAIL });
      await throwing.deliveryScheduler.waitForIdle();
      expect([...throwing.fixture.store.recoveryRequests.values()][0]?.deliveryStatus).toBe('failed');
    });

    it('leaves delivery pending on scheduler timeout', async () => {
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
      const scheduler = new RecoveryDeliveryScheduler({ taskTimeoutMs: 25 });
      const harness = makePlatformRecoveryApp({
        deliveryAdapter: adapter,
        deliveryScheduler: scheduler,
      });
      await request(harness.app)
        .post('/api/platform/v1/auth/recovery/initiate')
        .send({ email: PLATFORM_EMAIL });
      await scheduler.waitForIdle();
      expect(scheduler.lastOutcomes).toEqual(['pending_timeout']);
      expect([...harness.fixture.store.recoveryRequests.values()][0]?.deliveryStatus).toBe('pending');
      finish?.();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect([...harness.fixture.store.recoveryRequests.values()][0]?.deliveryStatus).toBe('pending');
    });

    it('ignores forged X-Forwarded-For for source limiting', async () => {
      const withoutTrust = express();
      withoutTrust.use(express.json());
      withoutTrust.get('/probe', (req, res) => {
        res.json({ source: trustedRecoveryRequestSource(req), ip: req.ip });
      });
      const forgedA = await request(withoutTrust)
        .get('/probe')
        .set('X-Forwarded-For', '203.0.113.10');
      const forgedB = await request(withoutTrust)
        .get('/probe')
        .set('X-Forwarded-For', '198.51.100.20');
      expect(forgedA.body.source).toBe(forgedB.body.source);
      expect(forgedA.body.source).not.toContain('203.0.113.10');
    });
  });

  describe('POST /api/platform/v1/auth/recovery/confirm', () => {
    it('completes recovery, revokes Platform sessions, preserves enrolled MFA, and issues no session', async () => {
      const harness = makePlatformRecoveryApp();
      // Seed an ephemeral challenge that recovery must clear.
      harness.fixture.store.mfa.challengeTokenHash = 'pending-challenge-hash';
      harness.fixture.store.mfa.challengePurpose = 'login';
      harness.fixture.store.mfa.challengeExpiresAt = new Date('2026-07-30T12:10:00.000Z') as any;
      harness.fixture.store.mfa.challengeAttempts = 2;
      const enrolledBefore = {
        state: harness.fixture.store.mfa.state,
        secretCiphertext: harness.fixture.store.mfa.secretCiphertext,
        pendingSecretCiphertext: harness.fixture.store.mfa.pendingSecretCiphertext,
        backupCodeHashes: harness.fixture.store.mfa.backupCodeHashes,
        enrolledAt: harness.fixture.store.mfa.enrolledAt,
        lastVerifiedAt: harness.fixture.store.mfa.lastVerifiedAt,
        lastUsedTimeStep: harness.fixture.store.mfa.lastUsedTimeStep,
        failedAttempts: harness.fixture.store.mfa.failedAttempts,
        lockedUntil: harness.fixture.store.mfa.lockedUntil,
      };
      const authzBefore = harness.fixture.store.principal.authorizationVersion;
      const permissionsBefore = harness.fixture.store.principal.permissions;
      const statusBefore = harness.fixture.store.principal.status;

      await request(harness.app)
        .post('/api/platform/v1/auth/recovery/initiate')
        .send({ email: PLATFORM_EMAIL });
      await harness.deliveryScheduler.waitForIdle();
      const token = harness.deliveryAdapter.consumeLastSecret();
      expect(token).toBeTruthy();

      const res = await request(harness.app)
        .post('/api/platform/v1/auth/recovery/confirm')
        .send({ resetToken: token, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: PLATFORM_RECOVERY_CONFIRM_STATUS,
        requestId: 'req-e4-test-001',
      });
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
      expect(await bcrypt.compare(NEW_PASSWORD, harness.fixture.store.principal.password)).toBe(true);
      expect(harness.fixture.store.principal.credentialVersion).toBe(2);
      expect(harness.fixture.store.refreshTokens[0]?.revokedAt).toBeTruthy();
      expect(harness.fixture.store.refreshTokens[0]?.revokedReason).toBe('platform_password_recovery');
      expect(harness.fixture.store.refreshTokens[1]?.revokedAt).toBeNull();
      expect(harness.fixture.store.principal.authorizationVersion).toBe(authzBefore);
      expect(harness.fixture.store.principal.permissions).toBe(permissionsBefore);
      expect(harness.fixture.store.principal.status).toBe(statusBefore);
      expect(harness.fixture.store.mfa.state).toBe(enrolledBefore.state);
      expect(harness.fixture.store.mfa.secretCiphertext).toBe(enrolledBefore.secretCiphertext);
      expect(harness.fixture.store.mfa.pendingSecretCiphertext).toBe(enrolledBefore.pendingSecretCiphertext);
      expect(harness.fixture.store.mfa.backupCodeHashes).toBe(enrolledBefore.backupCodeHashes);
      expect(harness.fixture.store.mfa.enrolledAt).toEqual(enrolledBefore.enrolledAt);
      expect(harness.fixture.store.mfa.lastVerifiedAt).toEqual(enrolledBefore.lastVerifiedAt);
      expect(harness.fixture.store.mfa.lastUsedTimeStep).toBe(enrolledBefore.lastUsedTimeStep);
      expect(harness.fixture.store.mfa.failedAttempts).toBe(enrolledBefore.failedAttempts);
      expect(harness.fixture.store.mfa.lockedUntil).toEqual(enrolledBefore.lockedUntil);
      expect(harness.fixture.store.mfa.challengeTokenHash).toBeNull();
      expect(harness.fixture.store.mfa.challengePurpose).toBeNull();
      expect(harness.fixture.store.mfa.challengeExpiresAt).toBeNull();
      expect(harness.fixture.store.mfa.challengeAttempts).toBe(0);
      expect(harness.fixture.store.platformAuditLogs.length).toBe(1);
      const audit = harness.fixture.store.platformAuditLogs[0] as {
        action: string;
        details: string;
      };
      expect(audit.action).toBe('platform.auth.password_recovery.completed');
      expect(audit.details).not.toMatch(/password|token|email|secret|backup/i);
    });

    it('rejects unknown/malformed/weak/extra-field confirms with generic invalid', async () => {
      const harness = makePlatformRecoveryApp();
      await request(harness.app)
        .post('/api/platform/v1/auth/recovery/initiate')
        .send({ email: PLATFORM_EMAIL });
      await harness.deliveryScheduler.waitForIdle();
      const token = harness.deliveryAdapter.consumeLastSecret()!;

      const unknown = await request(harness.app)
        .post('/api/platform/v1/auth/recovery/confirm')
        .send({ resetToken: 'x'.repeat(48), newPassword: NEW_PASSWORD });
      expect(unknown.status).toBe(400);
      expect(unknown.body.messageKey).toBe(PLATFORM_RECOVERY_INVALID_MESSAGE_KEY);

      const weak = await request(harness.app)
        .post('/api/platform/v1/auth/recovery/confirm')
        .send({ resetToken: token, newPassword: 'short' });
      expect(weak.status).toBe(400);
      expect(weak.body.messageKey).toBe(PLATFORM_RECOVERY_INVALID_MESSAGE_KEY);
      expect('short'.length).toBeLessThan(NEW_PASSWORD_MIN_LENGTH);

      const extra = await request(harness.app)
        .post('/api/platform/v1/auth/recovery/confirm')
        .send({ resetToken: token, newPassword: NEW_PASSWORD, email: PLATFORM_EMAIL });
      expect(extra.status).toBe(400);
      expect(extra.body.messageKey).toBe(PLATFORM_RECOVERY_INVALID_MESSAGE_KEY);
    });

    it('rejects company-owner reset tokens on the Platform confirm path', async () => {
      const minted = mintRecoveryTokenMaterial(
        {
          principalDomain: 'company_primary_owner',
          purpose: 'password_reset',
          environmentBinding: ENV_BINDING,
        },
        { tokenPepper: TOKEN_PEPPER },
      );
      const { app } = makePlatformRecoveryApp();
      const res = await request(app)
        .post('/api/platform/v1/auth/recovery/confirm')
        .send({ resetToken: minted.rawToken.reveal(), newPassword: NEW_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.messageKey).toBe(PLATFORM_RECOVERY_INVALID_MESSAGE_KEY);
    });
  });

  describe('POST /api/platform/v1/auth/discovery/notify', () => {
    it('returns identical unavailable support responses and never delivers or looks up accounts', async () => {
      const harness = makePlatformRecoveryApp();
      const findUnique = harness.fixture.prisma.platformPrincipal.findUnique as ReturnType<typeof vi.fn>;
      findUnique.mockClear();

      const identifiers = [
        PLATFORM_EMAIL,
        'ghost@example.test',
        PRINCIPAL_ID,
        'CMP-CODE',
        '+15551234567',
        'opaque-random-value-xyz',
      ];
      const bodies: Array<Record<string, unknown>> = [];
      for (const recoveryIdentifier of identifiers) {
        const res = await request(harness.app)
          .post('/api/platform/v1/auth/discovery/notify')
          .send({ recoveryIdentifier });
        expect(res.status).toBe(202);
        expect(res.body).toEqual({
          status: PLATFORM_DISCOVERY_UNAVAILABLE_STATUS,
          requestId: 'req-e4-test-001',
        });
        bodies.push(res.body);
      }

      const unknownFields = await request(harness.app)
        .post('/api/platform/v1/auth/discovery/notify')
        .send({ recoveryIdentifier: 'x', email: PLATFORM_EMAIL });
      expect(unknownFields.status).toBe(202);
      expect(unknownFields.body.status).toBe(PLATFORM_DISCOVERY_UNAVAILABLE_STATUS);

      expect(findUnique).not.toHaveBeenCalled();
      await harness.deliveryScheduler.waitForIdle();
      expect(harness.deliveryAdapter.deliveryCount).toBe(0);
      expect(harness.fixture.store.recoveryRequests.size).toBe(0);
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    });
  });

  describe('privacy helpers', () => {
    it('redacts recovery token material from JSON and inspect output', () => {
      const minted = mintRecoveryTokenMaterial(
        {
          principalDomain: 'platform_principal',
          purpose: 'password_reset',
          environmentBinding: ENV_BINDING,
        },
        { tokenPepper: TOKEN_PEPPER },
      );
      const raw = minted.rawToken.reveal();
      expect(JSON.stringify(minted.rawToken)).not.toContain(raw);
      expect(util.inspect(minted.rawToken)).not.toContain(raw);
    });

    it('keeps timing helper deterministic for injected floor/jitter', async () => {
      const delays: number[] = [];
      let now = 1_000;
      await withNormalizedResponseTime(async () => 'done', {
        floorMs: 100,
        jitterMs: 20,
        clock: () => now,
        delay: async (ms) => {
          delays.push(ms);
          now += ms;
        },
        random: () => 0.5,
      });
      expect(delays).toEqual([110]);
    });
  });

  describe('deliverPlatformPasswordRecovery', () => {
    it('records dispatched and failed delivery through the service', async () => {
      const { prisma, store } = makePlatformRecoveryPrisma();
      const targetStore = new TestOnlyMapRecoveryTargetStore(new Map());
      targetStore.set({
        principalDomain: 'platform_principal',
        principalId: PRINCIPAL_ID,
        companyId: null,
        credentialVersion: 1,
        status: 'active',
      });
      const service = new CredentialRecoveryService({
        prisma: prisma as never,
        crypto: { tokenPepper: TOKEN_PEPPER },
        environmentBinding: ENV_BINDING,
        targetStore,
        clock: () => new Date('2026-07-30T12:00:00.000Z'),
      });
      const issued = await service.issue({
        principalDomain: 'platform_principal',
        principalId: PRINCIPAL_ID,
        companyId: null,
        purpose: 'password_reset',
        initiatedBy: 'self',
        deliveryChannel: 'email',
        requestId: 'req-e4-deliver',
      });
      expect(issued.ok).toBe(true);
      if (!issued.ok || !issued.value.deliverySecret) return;

      const adapter = new CapturingRecoveryDeliveryAdapter();
      adapter.setNextStatus('failed');
      const status = await deliverPlatformPasswordRecovery({
        adapter,
        service,
        issued: {
          recoveryRequestId: issued.value.recoveryRequestId,
          deliverySecret: issued.value.deliverySecret,
          expiresAt: issued.value.expiresAt,
        },
        recipientRef: `platform-email:${PRINCIPAL_ID}`,
        requestId: 'req-e4-deliver',
      });
      expect(status).toBe('failed');
      expect(store.recoveryRequests.get(issued.value.recoveryRequestId)?.deliveryStatus).toBe('failed');
      expect(OWNER_RECOVERY_CONFIRM_STATUS).toBe('recovery_complete');
    });
  });
});
