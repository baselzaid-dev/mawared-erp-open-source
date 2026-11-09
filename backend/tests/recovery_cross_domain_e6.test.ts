import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
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
  PLATFORM_RECOVERY_INVALID_MESSAGE_KEY,
  registerPlatformPrincipalRecoveryRoutes,
} from '../src/platformPrincipalRecovery';
import {
  OWNER_RECOVERY_INVALID_MESSAGE_KEY,
  registerCompanyOwnerRecoveryRoutes,
} from '../src/companyOwnerRecovery';
import {
  PLATFORM_BREAK_GLASS_INVALID_MESSAGE_KEY,
  registerBreakGlassCompletionRoutes,
} from '../src/platformRecovery/completion';
import { NEW_PASSWORD_MIN_LENGTH } from '../src/credentialSecrets';

const TOKEN_PEPPER = 'e6-cross-domain-token-pepper-32chars!!';
const RATE_PEPPER = 'e6-cross-domain-rate-pepper-32chars!!';
const ENV_BINDING = 'test:e6-cross-domain';
const NEW_PASSWORD = 'X'.repeat(NEW_PASSWORD_MIN_LENGTH);

function mint(
  domain: 'platform_principal' | 'company_primary_owner',
  purpose: 'password_reset' | 'break_glass_recovery',
) {
  return mintRecoveryTokenMaterial(
    {
      principalDomain: domain,
      purpose,
      environmentBinding: ENV_BINDING,
    },
    { tokenPepper: TOKEN_PEPPER },
  );
}

function createRejectingPrisma() {
  const tx = {
    credentialRecoveryRequest: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(),
    },
    credentialRecoveryAuditEvent: {
      create: vi.fn(async () => ({ id: 'audit-1' })),
    },
  };
  return {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    ...tx,
  };
}

describe('E6 cross-domain token isolation', () => {
  it('rejects cross-domain tokens and proves no break-glass execute HTTP route', async () => {
    const targetStore = new TestOnlyMapRecoveryTargetStore(new Map());
    const prisma = createRejectingPrisma();
    const service = new CredentialRecoveryService({
      prisma: prisma as never,
      crypto: { tokenPepper: TOKEN_PEPPER },
      environmentBinding: ENV_BINDING,
      targetStore,
      clock: () => new Date('2026-07-30T12:00:00.000Z'),
    });
    const rateLimiter = new RecoveryRateLimiter(
      new InMemoryRecoveryRateLimitStore(),
      RATE_PEPPER,
      DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
    );
    const delivery = new CapturingRecoveryDeliveryAdapter();

    const app = express();
    app.use(express.json());
    // Contain unexpected errors as 500 without leaking bodies.
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      void err;
      res.status(500).json({ code: 'InternalError', messageKey: 'internal' });
    });

    registerCompanyOwnerRecoveryRoutes({
      app,
      prisma: prisma as never,
      recoveryService: service,
      rateLimiter,
      deliveryAdapter: delivery,
      isProduction: false,
    });
    registerPlatformPrincipalRecoveryRoutes({
      app,
      prisma: prisma as never,
      recoveryService: service,
      rateLimiter,
      deliveryAdapter: delivery,
      isProduction: false,
    });
    registerBreakGlassCompletionRoutes({
      app,
      prisma: prisma as never,
      recoveryService: service,
      limiter: (_req, _res, next) => next(),
      isProduction: false,
    });

    const executeProbe = await request(app)
      .post('/api/platform/v1/auth/recovery/break-glass/execute')
      .send({});
    expect(executeProbe.status).toBe(404);

    const platformToken = mint('platform_principal', 'password_reset').rawToken.reveal();
    const ownerToken = mint('company_primary_owner', 'password_reset').rawToken.reveal();
    const breakGlassPkg = mint('platform_principal', 'break_glass_recovery').rawToken.reveal();

    // Tokens unknown to the store are rejected generically (enumeration-safe).
    // Domain/purpose binding is enforced inside withValidRecoveryRequest when a
    // row exists — covered by E1 postgres + E3/E4/E5 suites; here we prove
    // confirm/complete never succeed and never return a session.
    const platformOnCompany = await request(app)
      .post('/api/v2/auth/owner-recovery/confirm')
      .send({ resetToken: platformToken, newPassword: NEW_PASSWORD });
    expect(platformOnCompany.status).toBe(400);
    expect(platformOnCompany.body.messageKey).toBe(OWNER_RECOVERY_INVALID_MESSAGE_KEY);
    expect(platformOnCompany.body).not.toHaveProperty('accessToken');

    const companyOnPlatform = await request(app)
      .post('/api/platform/v1/auth/recovery/confirm')
      .send({ resetToken: ownerToken, newPassword: NEW_PASSWORD });
    expect(companyOnPlatform.status).toBe(400);
    expect(companyOnPlatform.body.messageKey).toBe(PLATFORM_RECOVERY_INVALID_MESSAGE_KEY);
    expect(companyOnPlatform.body).not.toHaveProperty('accessToken');

    const breakGlassOnPasswordReset = await request(app)
      .post('/api/platform/v1/auth/recovery/confirm')
      .send({ resetToken: breakGlassPkg, newPassword: NEW_PASSWORD });
    expect(breakGlassOnPasswordReset.status).toBe(400);
    expect(breakGlassOnPasswordReset.body.messageKey).toBe(PLATFORM_RECOVERY_INVALID_MESSAGE_KEY);

    const passwordOnBreakGlass = await request(app)
      .post('/api/platform/v1/auth/recovery/break-glass/complete')
      .send({ recoveryPackage: platformToken, newPassword: NEW_PASSWORD });
    expect(passwordOnBreakGlass.status).toBe(400);
    expect(passwordOnBreakGlass.body.messageKey).toBe(PLATFORM_BREAK_GLASS_INVALID_MESSAGE_KEY);
    expect(passwordOnBreakGlass.body).not.toHaveProperty('accessToken');

    const tempCredential = 'TempCred!234567890';
    const tempAsReset = await request(app)
      .post('/api/platform/v1/auth/recovery/confirm')
      .send({ resetToken: tempCredential, newPassword: NEW_PASSWORD });
    expect(tempAsReset.status).toBe(400);
  });
});
