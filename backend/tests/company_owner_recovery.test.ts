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
  OWNER_RECOVERY_CONFIRM_STATUS,
  OWNER_RECOVERY_INITIATE_STATUS,
  OWNER_RECOVERY_INVALID_MESSAGE_KEY,
  deliverOwnerRecovery,
  registerCompanyOwnerRecoveryRoutes,
  resolveOwnerRecoveryEligibility,
  trustedRecoveryRequestSource,
} from '../src/companyOwnerRecovery';
import { PLATFORM_PERMISSIONS } from '../src/platformAuth';
import { NEW_PASSWORD_MIN_LENGTH } from '../src/credentialSecrets';

const TOKEN_PEPPER = 'e3-test-recovery-token-pepper-32chars-min';
const RATE_PEPPER = 'e3-test-recovery-rate-limit-pepper-32ch';
const ENV_BINDING = 'test:e3-fixture-fp';
const OWNER_EMAIL = 'owner@example.test';
const COMPANY_CODE = 'CMP-E3';
const COMPANY_ID = 'c-e3';
const OWNER_USER_ID = 'u-owner-e3';
const OLD_PASSWORD = 'OldPassword-123!';
const NEW_PASSWORD = 'NewSecurePass-456!';

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

type OwnerRecoveryFixtureStore = {
  user: { credentialVersion: number; password: string; [key: string]: unknown };
  recoveryRequests: Map<string, RecoveryRow>;
  ownerships?: unknown[];
  refreshTokens?: unknown[];
  auditEvents?: unknown[];
  auditLogs?: unknown[];
  loginIdentity?: unknown;
  [key: string]: unknown;
};

function makeRecoveryPrisma(seed?: {
  passwordHash?: string;
  credentialVersion?: number;
  accountStatus?: string;
  ownershipActive?: boolean;
  isPrimary?: boolean;
  employeeStatus?: string;
  employeeArchivedAt?: Date | null;
}) {
  const passwordHash = seed?.passwordHash ?? bcrypt.hashSync(OLD_PASSWORD, 4);
  const credentialVersion = seed?.credentialVersion ?? 1;
  const accountStatus = seed?.accountStatus ?? 'active';
  const ownershipActive = seed?.ownershipActive ?? true;
  const isPrimary = seed?.isPrimary ?? true;
  const employeeStatus = seed?.employeeStatus ?? 'active';
  const employeeArchivedAt = seed?.employeeArchivedAt ?? null;

  const company = { id: COMPANY_ID, code: COMPANY_CODE, name: 'E3 Test Co' };
  const user = {
    id: OWNER_USER_ID,
    companyId: COMPANY_ID,
    email: OWNER_EMAIL,
    normalizedEmail: OWNER_EMAIL,
    name: 'Primary Owner',
    password: passwordHash,
    accountStatus,
    credentialVersion,
    authorizationVersion: 1,
    employeeId: null as string | null,
    employee: null as { status: string; archivedAt: Date | null } | null,
  };
  const loginIdentity = {
    userId: OWNER_USER_ID,
    companyId: COMPANY_ID,
    normalizedIdentifier: OWNER_EMAIL,
    type: 'email',
  };
  const ownerships: Array<{
    id: string;
    companyId: string;
    userId: string;
    isPrimary: boolean;
    status: string;
    endedAt: Date | null;
    activePrimaryCompanyId?: string | null;
  }> = ownershipActive && isPrimary
    ? [{
      id: 'own-e3',
      companyId: COMPANY_ID,
      userId: OWNER_USER_ID,
      isPrimary: true,
      status: 'active',
      endedAt: null,
      activePrimaryCompanyId: COMPANY_ID,
    }]
    : [];
  const refreshTokens: Array<{
    id: string;
    userId: string;
    companyId: string;
    revokedAt: Date | null;
    revokedReason: string | null;
  }> = [
    { id: 'rt-1', userId: OWNER_USER_ID, companyId: COMPANY_ID, revokedAt: null, revokedReason: null },
  ];
  const recoveryRequests = new Map<string, RecoveryRow>();
  const auditEvents: unknown[] = [];
  const auditLogs: unknown[] = [];

  const matchRecoveryWhere = (row: RecoveryRow, where: Record<string, unknown>): boolean => {
    for (const [key, value] of Object.entries(where)) {
      if (key === 'consumedAt' && value === null && row.consumedAt != null) return false;
      if (key === 'invalidatedAt' && value === null && row.invalidatedAt != null) return false;
      if (key === 'tokenHash' && row.tokenHash !== value) return false;
      if (key === 'id' && typeof value === 'object' && value !== null && 'not' in value) {
        if (row.id === (value as { not: string }).not) return false;
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
    user: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id !== OWNER_USER_ID || where.companyId !== COMPANY_ID) return null;
        if (where.accountStatus && user.accountStatus !== where.accountStatus) return null;
        return {
          ...user,
          employee: user.employeeId
            ? user.employee
            : null,
        };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const expectedVersion = where.credentialVersion as number;
        if (
          where.id === OWNER_USER_ID
          && where.companyId === COMPANY_ID
          && (
            user.credentialVersion === expectedVersion
            || user.credentialVersion + 1 === expectedVersion
          )
        ) {
          if (typeof data.password === 'string') user.password = data.password;
          user.credentialVersion = expectedVersion;
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
    companyOwnership: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        ownerships.filter((row) =>
          row.companyId === where.companyId
          && row.userId === where.userId
          && row.isPrimary === where.isPrimary
          && row.status === where.status
          && row.endedAt === where.endedAt,
        ),
      ),
    },
    refreshToken: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of refreshTokens) {
          if (row.userId !== where.userId || row.companyId !== where.companyId) continue;
          if (where.revokedAt === null && row.revokedAt !== null) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        auditLogs.push(data);
        return data;
      }),
    },
  });

  const tx = buildTx();
  const prisma: Record<string, unknown> = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    company: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
        if (where.id === COMPANY_ID || where.code === COMPANY_CODE) return company;
        return null;
      }),
    },
    loginIdentity: {
      findUnique: vi.fn(async () => loginIdentity),
    },
    user: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.companyId !== COMPANY_ID) return null;
        if (where.id && where.id !== OWNER_USER_ID) return null;
        if (where.accountStatus && user.accountStatus !== where.accountStatus) return null;
        if (where.normalizedEmail && user.normalizedEmail !== where.normalizedEmail) return null;
        return {
          ...user,
          employee: user.employeeId
            ? { status: employeeStatus, archivedAt: employeeArchivedAt }
            : null,
        };
      }),
    },
    companyOwnership: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.companyId !== COMPANY_ID) return [];
        return ownerships.filter((row) =>
          row.isPrimary === where.isPrimary
          && row.status === where.status
          && row.endedAt === where.endedAt,
        );
      }),
    },
    _store: {
      user,
      ownerships,
      refreshTokens,
      recoveryRequests,
      auditEvents,
      auditLogs,
      loginIdentity,
    },
  };

  return {
    prisma: prisma as any,
    tx,
    store: prisma._store as OwnerRecoveryFixtureStore,
  };
}

function makeOwnerRecoveryApp(options?: {
  prisma?: ReturnType<typeof makeRecoveryPrisma>['prisma'];
  targetStore?: TestOnlyMapRecoveryTargetStore;
  deliveryAdapter?: CapturingRecoveryDeliveryAdapter;
  deliveryScheduler?: RecoveryDeliveryScheduler;
  timing?: { floorMs?: number; jitterMs?: number; clock?: () => number; delay?: (ms: number) => Promise<void>; random?: () => number };
  performDummyCryptoWork?: () => Promise<void>;
  clock?: () => Date;
}) {
  const built = options?.prisma
    ? {
      prisma: options.prisma,
      store: (options.prisma as { _store: OwnerRecoveryFixtureStore })._store,
    }
    : makeRecoveryPrisma();
  const fixture = {
    prisma: built.prisma,
    store: built.store as OwnerRecoveryFixtureStore,
  };
  const targetStore = options?.targetStore ?? new TestOnlyMapRecoveryTargetStore(new Map());
  targetStore.set({
    principalDomain: 'company_primary_owner',
    principalId: OWNER_USER_ID,
    companyId: COMPANY_ID,
    credentialVersion: fixture.store.user.credentialVersion,
  });

  const deliveryAdapter = options?.deliveryAdapter ?? new CapturingRecoveryDeliveryAdapter();
  const deliveryScheduler = options?.deliveryScheduler ?? new RecoveryDeliveryScheduler();
  const rateStore = new InMemoryRecoveryRateLimitStore();
  const rateLimiter = new RecoveryRateLimiter(
    rateStore,
    RATE_PEPPER,
    DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
    options?.clock ?? (() => new Date('2026-07-28T12:00:00.000Z')),
  );
  const recoveryService = new CredentialRecoveryService({
    prisma: fixture.prisma as never,
    crypto: { tokenPepper: TOKEN_PEPPER },
    environmentBinding: ENV_BINDING,
    targetStore,
    clock: options?.clock ?? (() => new Date('2026-07-28T12:00:00.000Z')),
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const requestId = 'req-e3-test-001';
    (req as { requestId?: string }).requestId = requestId;
    res.locals.requestId = requestId;
    next();
  });
  registerCompanyOwnerRecoveryRoutes({
    app,
    prisma: fixture.prisma as never,
    recoveryService,
    rateLimiter,
    deliveryAdapter,
    deliveryScheduler,
    timing: options?.timing ?? { floorMs: 0, jitterMs: 0, delay: async () => undefined, random: () => 0 },
    performDummyCryptoWork: options?.performDummyCryptoWork,
    isProduction: false,
  });

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
  expect(body.status).toBe(OWNER_RECOVERY_INITIATE_STATUS);
  expect(body.requestId).toBeTruthy();
  expect(JSON.stringify(body)).not.toMatch(/companyId|userId|ownerEmail|email/i);
}

describe('company owner recovery (E3 unit/integration)', () => {
  beforeEach(() => {
    process.env.CREDENTIAL_RECOVERY_TOKEN_PEPPER = TOKEN_PEPPER;
    process.env.CREDENTIAL_RECOVERY_RATE_LIMIT_PEPPER = RATE_PEPPER;
    process.env.CREDENTIAL_RECOVERY_ENVIRONMENT_BINDING = ENV_BINDING;
  });

  describe('resolveOwnerRecoveryEligibility', () => {
    it('returns eligible target for active primary owner', async () => {
      const { prisma } = makeRecoveryPrisma();
      const eligible = await resolveOwnerRecoveryEligibility(prisma as never, {
        companyCode: COMPANY_CODE,
        ownerEmail: OWNER_EMAIL,
      });
      expect(eligible).toEqual({
        companyId: COMPANY_ID,
        userId: OWNER_USER_ID,
        recipientRef: `owner-email:${COMPANY_ID}:${OWNER_USER_ID}`,
      });
    });

    it('returns null for wrong company, unknown email, employee-only, historical owner, disabled user', async () => {
      const base = makeRecoveryPrisma();
      expect(await resolveOwnerRecoveryEligibility(base.prisma as never, {
        companyCode: 'UNKNOWN',
        ownerEmail: OWNER_EMAIL,
      })).toBeNull();

      const noIdentity = makeRecoveryPrisma();
      vi.mocked(noIdentity.prisma.loginIdentity.findUnique).mockResolvedValue(null);
      expect(await resolveOwnerRecoveryEligibility(noIdentity.prisma as never, {
        companyCode: COMPANY_CODE,
        ownerEmail: 'missing@example.test',
      })).toBeNull();

      const employeeOnly = makeRecoveryPrisma({ ownershipActive: false, isPrimary: false });
      expect(await resolveOwnerRecoveryEligibility(employeeOnly.prisma as never, {
        companyCode: COMPANY_CODE,
        ownerEmail: OWNER_EMAIL,
      })).toBeNull();

      const historical = makeRecoveryPrisma({ ownershipActive: false });
      expect(await resolveOwnerRecoveryEligibility(historical.prisma as never, {
        companyCode: COMPANY_CODE,
        ownerEmail: OWNER_EMAIL,
      })).toBeNull();

      const disabled = makeRecoveryPrisma({ accountStatus: 'disabled' });
      expect(await resolveOwnerRecoveryEligibility(disabled.prisma as never, {
        companyCode: COMPANY_CODE,
        ownerEmail: OWNER_EMAIL,
      })).toBeNull();
    });
  });

  describe('withNormalizedResponseTime', () => {
    it('applies deterministic floor via injected clock, delay, and random', async () => {
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

  describe('platform permission boundary', () => {
    it('defines owner recovery initiate separately from view/provision', () => {
      expect(PLATFORM_PERMISSIONS.COMPANIES_OWNER_RECOVERY_INITIATE).toBe(
        'platform.companies.owner_recovery.initiate',
      );
      expect(PLATFORM_PERMISSIONS.COMPANIES_VIEW).not.toBe(
        PLATFORM_PERMISSIONS.COMPANIES_OWNER_RECOVERY_INITIATE,
      );
      expect(PLATFORM_PERMISSIONS.COMPANIES_PROVISION).not.toBe(
        PLATFORM_PERMISSIONS.COMPANIES_OWNER_RECOVERY_INITIATE,
      );
      expect(PLATFORM_PERMISSIONS.COMPANIES_VIEW).not.toContain('owner_recovery');
      expect(PLATFORM_PERMISSIONS.COMPANIES_PROVISION).not.toContain('owner_recovery');
    });
  });

  describe('POST /api/v2/auth/owner-recovery/initiate', () => {
    it('returns generic 202 for valid shape without leaking account identifiers', async () => {
      const { app, deliveryAdapter, deliveryScheduler } = makeOwnerRecoveryApp();
      const res = await request(app)
        .post('/api/v2/auth/owner-recovery/initiate')
        .send({ companyCode: COMPANY_CODE, ownerEmail: OWNER_EMAIL });
      expect(res.status).toBe(202);
      genericInitiateBody(res.body);
      await deliveryScheduler.waitForIdle();
      expect(deliveryAdapter.deliveryCount).toBe(1);
      expect(deliveryAdapter.sent[0]?.template).toBe('company_owner_password_reset');
    });

    it('returns the same generic 202 for wrong company, unknown email, non-owner, invalid syntax', async () => {
      const { app, deliveryAdapter, deliveryScheduler } = makeOwnerRecoveryApp({
        prisma: makeRecoveryPrisma({ ownershipActive: false }).prisma,
      });

      const cases = [
        { companyCode: 'NOPE', ownerEmail: OWNER_EMAIL },
        { companyCode: COMPANY_CODE, ownerEmail: 'ghost@example.test' },
        { companyCode: COMPANY_CODE, ownerEmail: OWNER_EMAIL },
        { companyCode: 'bad code!', ownerEmail: OWNER_EMAIL },
        { companyCode: COMPANY_CODE, ownerEmail: 'not-an-email' },
        { companyCode: COMPANY_CODE, ownerEmail: OWNER_EMAIL, extraField: true },
      ];

      for (const body of cases) {
        const before = deliveryAdapter.deliveryCount;
        const res = await request(app)
          .post('/api/v2/auth/owner-recovery/initiate')
          .send(body);
        expect(res.status).toBe(202);
        genericInitiateBody(res.body);
        await deliveryScheduler.waitForIdle();
        expect(deliveryAdapter.deliveryCount).toBe(before);
      }
    });

    it('records delivery success, failure, and exception paths without leaking secrets', async () => {
      const success = makeOwnerRecoveryApp();
      success.deliveryAdapter.setNextStatus('dispatched');
      await request(success.app)
        .post('/api/v2/auth/owner-recovery/initiate')
        .send({ companyCode: COMPANY_CODE, ownerEmail: OWNER_EMAIL });
      await success.deliveryScheduler.waitForIdle();
      expect(success.deliveryAdapter.sent[0]?.hadSecret).toBe(true);

      const failed = makeOwnerRecoveryApp();
      failed.deliveryAdapter.setNextStatus('failed');
      await request(failed.app)
        .post('/api/v2/auth/owner-recovery/initiate')
        .send({ companyCode: COMPANY_CODE, ownerEmail: OWNER_EMAIL });
      await failed.deliveryScheduler.waitForIdle();

      const token = success.deliveryAdapter.consumeLastSecret();
      expect(token).toBeTruthy();
      expect(JSON.stringify(success.deliveryAdapter)).not.toContain(token!);
      expect(util.inspect(success.deliveryAdapter)).not.toContain(token!);

      const throwing = makeOwnerRecoveryApp();
      throwing.deliveryAdapter.throwOnNextSend(new Error('smtp down'));
      await request(throwing.app)
        .post('/api/v2/auth/owner-recovery/initiate')
        .send({ companyCode: COMPANY_CODE, ownerEmail: OWNER_EMAIL });
      await throwing.deliveryScheduler.waitForIdle();
      expect(throwing.deliveryAdapter.deliveryCount).toBe(0);
      expect(throwing.fixture.store.recoveryRequests.size).toBe(1);
      expect([...throwing.fixture.store.recoveryRequests.values()][0]?.deliveryStatus).toBe('failed');
    });

    it('ignores forged X-Forwarded-For and uses trusted req.ip for source limiting', async () => {
      const withoutTrust = express();
      withoutTrust.use(express.json());
      withoutTrust.use((req, _res, next) => {
        (req as { requestId?: string }).requestId = 'req-xff';
        next();
      });
      withoutTrust.get('/probe', (req, res) => {
        res.json({
          source: trustedRecoveryRequestSource(req),
          ip: req.ip,
        });
      });

      const forgedA = await request(withoutTrust)
        .get('/probe')
        .set('X-Forwarded-For', '203.0.113.10');
      const forgedB = await request(withoutTrust)
        .get('/probe')
        .set('X-Forwarded-For', '198.51.100.20');
      expect(forgedA.body.source).toBe(forgedB.body.source);
      expect(forgedA.body.source).not.toContain('203.0.113.10');
      expect(forgedA.body.source).not.toContain('198.51.100.20');

      const withTrust = express();
      withTrust.set('trust proxy', 1);
      withTrust.use(express.json());
      withTrust.get('/probe', (req, res) => {
        res.json({ source: trustedRecoveryRequestSource(req), ip: req.ip });
      });
      const trusted = await request(withTrust)
        .get('/probe')
        .set('X-Forwarded-For', '203.0.113.55');
      expect(trusted.body.ip).toBe('203.0.113.55');
      expect(trusted.body.source).toBe(trustedRecoveryRequestSource({
        ip: '203.0.113.55',
        socket: { remoteAddress: '127.0.0.1' },
      } as express.Request));
    });

    it('returns opaque 202 before a slow adapter finishes and records delivery later', async () => {
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
      const harness = makeOwnerRecoveryApp({
        deliveryAdapter: adapter,
        deliveryScheduler: scheduler,
        timing: { floorMs: 0, jitterMs: 0, delay: async () => undefined, random: () => 0 },
      });

      const started = Date.now();
      const resPromise = request(harness.app)
        .post('/api/v2/auth/owner-recovery/initiate')
        .send({ companyCode: COMPANY_CODE, ownerEmail: OWNER_EMAIL });

      const ineligible = makeOwnerRecoveryApp({
        prisma: makeRecoveryPrisma({ ownershipActive: false }).prisma,
        timing: { floorMs: 0, jitterMs: 0, delay: async () => undefined, random: () => 0 },
      });
      const ineligibleStarted = Date.now();
      const ineligibleRes = await request(ineligible.app)
        .post('/api/v2/auth/owner-recovery/initiate')
        .send({ companyCode: COMPANY_CODE, ownerEmail: OWNER_EMAIL });
      expect(ineligibleRes.status).toBe(202);
      expect(Date.now() - ineligibleStarted).toBeLessThan(400);
      await ineligible.deliveryScheduler.waitForIdle();
      expect(ineligible.deliveryAdapter.deliveryCount).toBe(0);

      const res = await resPromise;
      const elapsed = Date.now() - started;
      expect(res.status).toBe(202);
      genericInitiateBody(res.body);
      expect(elapsed).toBeLessThan(400);
      expect(adapter.deliveryCount).toBe(0);

      finish?.();
      await scheduler.waitForIdle();
      expect(adapter.deliveryCount).toBe(1);
      expect(adapter.sent[0]?.hadSecret).toBe(true);
      const token = adapter.consumeLastSecret();
      expect(token).toBeTruthy();
      expect(JSON.stringify(adapter)).not.toContain(token!);
      expect(scheduler.containedErrors).toHaveLength(0);
      expect(scheduler.lastOutcomes).toEqual(['dispatched']);
    });

    it('leaves public delivery pending on scheduler timeout without auto-resend', async () => {
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
      const harness = makeOwnerRecoveryApp({
        deliveryAdapter: adapter,
        deliveryScheduler: scheduler,
        timing: { floorMs: 0, jitterMs: 0, delay: async () => undefined, random: () => 0 },
      });

      const res = await request(harness.app)
        .post('/api/v2/auth/owner-recovery/initiate')
        .send({ companyCode: COMPANY_CODE, ownerEmail: OWNER_EMAIL });
      expect(res.status).toBe(202);
      await scheduler.waitForIdle();
      expect(scheduler.lastOutcomes).toEqual(['pending_timeout']);
      const row = [...harness.fixture.store.recoveryRequests.values()][0];
      expect(row?.deliveryStatus).toBe('pending');
      expect(adapter.send).toHaveBeenCalledTimes(1);

      finish?.();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(row?.deliveryStatus).toBe('pending');
      expect(adapter.send).toHaveBeenCalledTimes(1);
    });

    it('redacts recovery token material from JSON and inspect output', async () => {
      const minted = mintRecoveryTokenMaterial(
        {
          principalDomain: 'company_primary_owner',
          purpose: 'password_reset',
          environmentBinding: ENV_BINDING,
        },
        { tokenPepper: TOKEN_PEPPER },
      );
      const raw = minted.rawToken.reveal();
      expect(JSON.stringify(minted.rawToken)).not.toContain(raw);
      expect(String(minted.rawToken)).not.toContain(raw);
      expect(util.inspect(minted.rawToken)).not.toContain(raw);
    });
  });

  describe('POST /api/v2/auth/owner-recovery/confirm', () => {
    it('completes recovery without issuing session tokens', async () => {
      const harness = makeOwnerRecoveryApp();
      await request(harness.app)
        .post('/api/v2/auth/owner-recovery/initiate')
        .send({ companyCode: COMPANY_CODE, ownerEmail: OWNER_EMAIL });
      await harness.deliveryScheduler.waitForIdle();
      const token = harness.deliveryAdapter.consumeLastSecret();
      expect(token).toBeTruthy();

      const res = await request(harness.app)
        .post('/api/v2/auth/owner-recovery/confirm')
        .send({ resetToken: token, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(OWNER_RECOVERY_CONFIRM_STATUS);
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
      expect(await bcrypt.compare(NEW_PASSWORD, harness.fixture.store.user.password)).toBe(true);
    });

    it('rejects unknown/malformed tokens with generic invalid message', async () => {
      const { app } = makeOwnerRecoveryApp();
      const unknown = 'x'.repeat(48);
      const res = await request(app)
        .post('/api/v2/auth/owner-recovery/confirm')
        .send({ resetToken: unknown, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'InvalidRequest',
        messageKey: OWNER_RECOVERY_INVALID_MESSAGE_KEY,
      });
    });

    it('rejects weak passwords and unknown confirm fields', async () => {
      const harness = makeOwnerRecoveryApp();
      await request(harness.app)
        .post('/api/v2/auth/owner-recovery/initiate')
        .send({ companyCode: COMPANY_CODE, ownerEmail: OWNER_EMAIL });
      await harness.deliveryScheduler.waitForIdle();
      const token = harness.deliveryAdapter.consumeLastSecret()!;

      const weak = await request(harness.app)
        .post('/api/v2/auth/owner-recovery/confirm')
        .send({ resetToken: token, newPassword: 'short' });
      expect(weak.status).toBe(400);
      expect(weak.body.messageKey).toBe(OWNER_RECOVERY_INVALID_MESSAGE_KEY);
      expect('short'.length).toBeLessThan(NEW_PASSWORD_MIN_LENGTH);

      const extra = await request(harness.app)
        .post('/api/v2/auth/owner-recovery/confirm')
        .send({ resetToken: token, newPassword: NEW_PASSWORD, surprise: true });
      expect(extra.status).toBe(400);
      expect(extra.body.messageKey).toBe(OWNER_RECOVERY_INVALID_MESSAGE_KEY);
    });
  });

  describe('deliverOwnerRecovery', () => {
    it('records dispatched and failed delivery status through the service', async () => {
      const { prisma, store } = makeRecoveryPrisma();
      const targetStore = new TestOnlyMapRecoveryTargetStore(new Map());
      targetStore.set({
        principalDomain: 'company_primary_owner',
        principalId: OWNER_USER_ID,
        companyId: COMPANY_ID,
        credentialVersion: 1,
      });
      const service = new CredentialRecoveryService({
        prisma: prisma as never,
        crypto: { tokenPepper: TOKEN_PEPPER },
        environmentBinding: ENV_BINDING,
        targetStore,
        clock: () => new Date('2026-07-28T12:00:00.000Z'),
      });
      const issued = await service.issue({
        principalDomain: 'company_primary_owner',
        principalId: OWNER_USER_ID,
        companyId: COMPANY_ID,
        purpose: 'password_reset',
        initiatedBy: 'self',
        deliveryChannel: 'email',
        requestId: 'req-deliver-1',
      });
      expect(issued.ok).toBe(true);
      if (!issued.ok || !issued.value.deliverySecret) return;

      const adapter = new CapturingRecoveryDeliveryAdapter();
      adapter.setNextStatus('failed');
      const status = await deliverOwnerRecovery({
        adapter,
        service,
        issued: {
          recoveryRequestId: issued.value.recoveryRequestId,
          deliverySecret: issued.value.deliverySecret,
          expiresAt: issued.value.expiresAt,
        },
        recipientRef: `owner-email:${COMPANY_ID}:${OWNER_USER_ID}`,
        template: 'company_owner_password_reset',
        requestId: 'req-deliver-1',
      });
      expect(status).toBe('failed');
      const row = store.recoveryRequests.get(issued.value.recoveryRequestId);
      expect(row?.deliveryStatus).toBe('failed');
    });
  });
});
