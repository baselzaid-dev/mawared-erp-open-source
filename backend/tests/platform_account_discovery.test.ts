import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CapturingRecoveryDeliveryAdapter,
  CredentialRecoveryService,
  DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
  InMemoryRecoveryRateLimitStore,
  RecoveryDeliveryScheduler,
  RecoveryRateLimiter,
  TestOnlyMapRecoveryTargetStore,
} from '../src/credentialRecovery';
import {
  PLATFORM_ACCOUNT_DISCOVERY_ALTERNATE_CHANNEL_AVAILABLE,
  PLATFORM_DISCOVERY_UNAVAILABLE_STATUS,
  registerPlatformPrincipalRecoveryRoutes,
  resolvePlatformAccountDiscoveryEligibility,
} from '../src/platformPrincipalRecovery';

const TOKEN_PEPPER = 'e4-discovery-token-pepper-32chars-min!!';
const RATE_PEPPER = 'e4-discovery-rate-limit-pepper-32chars';
const ENV_BINDING = 'test:e4-discovery-fp';

function makeDiscoveryApp() {
  const platformPrincipal = {
    findUnique: vi.fn(async () => ({
      id: 'should-never-be-returned',
      normalizedEmail: 'real@example.test',
      status: 'active',
    })),
  };
  const recoveryRequests = new Map();
  const prisma = {
    platformPrincipal,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $executeRaw: vi.fn().mockResolvedValue(0),
      credentialRecoveryRequest: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          recoveryRequests.set(data.id, data);
          return data;
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      credentialRecoveryAuditEvent: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      },
    })),
    credentialRecoveryRequest: {
      findMany: vi.fn(async () => []),
    },
    _recoveryRequests: recoveryRequests,
  };

  const targetStore = new TestOnlyMapRecoveryTargetStore(new Map());
  const deliveryAdapter = new CapturingRecoveryDeliveryAdapter();
  const deliveryScheduler = new RecoveryDeliveryScheduler();
  const rateLimiter = new RecoveryRateLimiter(
    new InMemoryRecoveryRateLimitStore(),
    RATE_PEPPER,
    DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
    () => new Date('2026-07-30T12:00:00.000Z'),
  );
  const recoveryService = new CredentialRecoveryService({
    prisma: prisma as never,
    crypto: { tokenPepper: TOKEN_PEPPER },
    environmentBinding: ENV_BINDING,
    targetStore,
    clock: () => new Date('2026-07-30T12:00:00.000Z'),
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    (req as { requestId?: string }).requestId = 'req-discovery-1';
    res.locals.requestId = 'req-discovery-1';
    next();
  });
  registerPlatformPrincipalRecoveryRoutes({
    app,
    prisma: prisma as never,
    recoveryService,
    rateLimiter,
    deliveryAdapter,
    deliveryScheduler,
    timing: { floorMs: 0, jitterMs: 0, delay: async () => undefined, random: () => 0 },
    isProduction: false,
  });

  process.env.CREDENTIAL_RECOVERY_RATE_LIMIT_PEPPER = RATE_PEPPER;
  process.env.CREDENTIAL_RECOVERY_TOKEN_PEPPER = TOKEN_PEPPER;

  return { app, platformPrincipal, deliveryAdapter, deliveryScheduler, recoveryRequests, rateLimiter };
}

describe('platform account discovery (E4)', () => {
  beforeEach(() => {
    process.env.CREDENTIAL_RECOVERY_TOKEN_PEPPER = TOKEN_PEPPER;
    process.env.CREDENTIAL_RECOVERY_RATE_LIMIT_PEPPER = RATE_PEPPER;
    process.env.CREDENTIAL_RECOVERY_ENVIRONMENT_BINDING = ENV_BINDING;
  });

  it('exposes the discovery endpoint with a strict unavailable support contract', async () => {
    expect(PLATFORM_ACCOUNT_DISCOVERY_ALTERNATE_CHANNEL_AVAILABLE).toBe(false);
    expect(resolvePlatformAccountDiscoveryEligibility({
      recoveryIdentifier: 'anything',
    })).toBeNull();

    const { app, platformPrincipal, deliveryAdapter, deliveryScheduler, recoveryRequests } = makeDiscoveryApp();
    const payloads = [
      { recoveryIdentifier: 'real@example.test' },
      { recoveryIdentifier: 'unknown@example.test' },
      { recoveryIdentifier: 'opaque-id-001' },
      { recoveryIdentifier: '+15550001111' },
      { recoveryIdentifier: 'CMP-123' },
    ];

    for (const body of payloads) {
      const res = await request(app)
        .post('/api/platform/v1/auth/discovery/notify')
        .send(body);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        status: PLATFORM_DISCOVERY_UNAVAILABLE_STATUS,
        requestId: 'req-discovery-1',
      });
      expect(JSON.stringify(res.body)).not.toMatch(/email|principal|account|phone|company/i);
    }

    const rejected = await request(app)
      .post('/api/platform/v1/auth/discovery/notify')
      .send({ recoveryIdentifier: 'x', wildcard: '*' });
    expect(rejected.status).toBe(202);
    expect(rejected.body.status).toBe(PLATFORM_DISCOVERY_UNAVAILABLE_STATUS);

    expect(platformPrincipal.findUnique).not.toHaveBeenCalled();
    await deliveryScheduler.waitForIdle();
    expect(deliveryAdapter.deliveryCount).toBe(0);
    expect(recoveryRequests.size).toBe(0);
  });

  it('applies an independent discovery rate-limit surface without persisting raw identifiers', async () => {
    const { app, rateLimiter } = makeDiscoveryApp();
    const now = new Date('2026-07-30T12:00:00.000Z');
    // Exhaust discovery target bucket (limit 3).
    for (let i = 0; i < 3; i += 1) {
      expect((await rateLimiter.check({
        surface: 'platform_account_discovery',
        dimension: 'target',
        rawKey: 'target:hashed-id-fixture',
        now,
      })).allowed).toBe(true);
    }
    expect((await rateLimiter.check({
      surface: 'platform_account_discovery',
      dimension: 'target',
      rawKey: 'target:hashed-id-fixture',
      now,
    })).allowed).toBe(false);

    // Password-reset surface remains independent.
    expect((await rateLimiter.check({
      surface: 'platform_password_reset_initiate',
      dimension: 'target',
      rawKey: 'target:hashed-id-fixture',
      now,
    })).allowed).toBe(true);

    const res = await request(app)
      .post('/api/platform/v1/auth/discovery/notify')
      .send({ recoveryIdentifier: 'secret-identifier-never-stored' });
    expect(res.status).toBe(202);
    expect(JSON.stringify(rateLimiter)).not.toContain('secret-identifier-never-stored');
  });
});
