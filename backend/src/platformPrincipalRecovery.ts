import crypto from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  assertNewPasswordPolicy,
  hashPassword,
} from './credentialSecrets';
import {
  CapturingRecoveryDeliveryAdapter,
  CredentialRecoveryService,
  DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
  InMemoryRecoveryRateLimitStore,
  PostgresRecoveryRateLimitStore,
  PostgresRecoveryTargetStore,
  RecoveryDeliveryScheduler,
  RecoveryRateLimiter,
  UnavailableRecoveryDeliveryAdapter,
  createSourceBucketHash,
  mintRecoveryTokenMaterial,
  withNormalizedResponseTime,
  type RecoveryDeliveryAdapter,
  type RecoveryRateLimiter as RecoveryRateLimiterType,
  type RecoveryTimingNormalizationOptions,
} from './credentialRecovery';
import {
  RECOVERY_ENVIRONMENT_BINDING_ENV,
  RECOVERY_RATE_LIMIT_PEPPER_ENV,
  RECOVERY_TOKEN_PEPPER_ENV,
  assertRecoveryCryptoConfig,
  resolveEnvironmentBinding,
  type CredentialRecoverySecret,
} from './credentialRecovery/tokenCrypto';
import { IdentityInputError, normalizeEmail } from './identity';
import { writePlatformAudit } from './platformAuth';
import { trustedRecoveryRequestSource } from './companyOwnerRecovery';

type TxClient = Prisma.TransactionClient;

export const PLATFORM_RECOVERY_INITIATE_STATUS =
  'if_account_exists_instructions_sent' as const;
export const PLATFORM_RECOVERY_CONFIRM_STATUS = 'recovery_complete' as const;
export const PLATFORM_RECOVERY_INVALID_MESSAGE_KEY =
  'platform.recovery.invalid_or_expired' as const;
export const PLATFORM_DISCOVERY_UNAVAILABLE_STATUS =
  'discovery_unavailable_use_support_path' as const;

/**
 * Binding product decision for E4: PlatformPrincipal has no durable
 * pre-verified alternate recovery identifier/channel distinct from login email.
 * Discovery therefore remains a generic support-path contract only.
 */
export const PLATFORM_ACCOUNT_DISCOVERY_ALTERNATE_CHANNEL_AVAILABLE = false as const;

const RESET_TOKEN_MIN = 40;
const RESET_TOKEN_MAX = 256;
const RESET_TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const RECOVERY_IDENTIFIER_MAX = 320;

const initiateBodySchema = z
  .object({
    email: z.string().trim().email().max(320),
  })
  .strict();

const confirmBodySchema = z
  .object({
    resetToken: z.string().min(RESET_TOKEN_MIN).max(RESET_TOKEN_MAX).regex(RESET_TOKEN_RE),
    newPassword: z.string().min(1).max(512),
  })
  .strict();

const discoveryBodySchema = z
  .object({
    recoveryIdentifier: z.string().min(1).max(RECOVERY_IDENTIFIER_MAX),
  })
  .strict();

interface PlatformRecoveryRequest extends Request {
  requestId?: string;
}

class PlatformRecoveryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

const fail = (status: number, code: string, messageKey: string): never => {
  throw new PlatformRecoveryHttpError(status, code, messageKey);
};

export interface PlatformPrincipalRecoveryEligibleTarget {
  principalId: string;
  recipientRef: string;
}

export interface PlatformPrincipalRecoveryDeps {
  app: Express;
  prisma: PrismaClient;
  recoveryService?: CredentialRecoveryService | null;
  rateLimiter?: RecoveryRateLimiterType | null;
  deliveryAdapter?: RecoveryDeliveryAdapter | null;
  deliveryScheduler?: RecoveryDeliveryScheduler | null;
  timing?: RecoveryTimingNormalizationOptions;
  performDummyCryptoWork?: () => Promise<void>;
  isProduction?: boolean;
}

/**
 * Resolve active PlatformPrincipal eligibility from server state only.
 * Never trusts client-supplied principalId. Never uses MFA or phone fields.
 */
export async function resolvePlatformPrincipalRecoveryEligibility(
  prisma: PrismaClient | TxClient,
  input: { email: string },
): Promise<PlatformPrincipalRecoveryEligibleTarget | null> {
  let email: string;
  try {
    email = normalizeEmail(input.email);
  } catch (error) {
    if (error instanceof IdentityInputError) return null;
    throw error;
  }

  const principal = await prisma.platformPrincipal.findUnique({
    where: { normalizedEmail: email },
    select: {
      id: true,
      status: true,
      normalizedEmail: true,
    },
  });
  if (!principal) return null;
  if (principal.status !== 'active') return null;
  if (principal.normalizedEmail !== email) return null;

  return {
    principalId: principal.id,
    recipientRef: `platform-email:${principal.id}`,
  };
}

/**
 * Account-discovery eligibility. Returns null until a separately approved
 * verified-alternate-channel data model exists. Must never query by login email.
 */
export function resolvePlatformAccountDiscoveryEligibility(_input: {
  recoveryIdentifier: string;
}): null {
  void _input;
  return null;
}

async function defaultDummyCryptoWork(serviceCryptoPepper: string | null): Promise<void> {
  const pepper = serviceCryptoPepper && serviceCryptoPepper.length >= 32
    ? serviceCryptoPepper
    : 'platform-recovery-dummy-pepper-not-for-production-use!';
  mintRecoveryTokenMaterial(
    {
      principalDomain: 'platform_principal',
      purpose: 'password_reset',
      environmentBinding: 'test:dummy-binding-path',
    },
    { tokenPepper: pepper },
  );
}

async function enforceInitiateRateLimits(
  limiter: RecoveryRateLimiterType,
  input: { sourceKey: string; targetEmailKey: string },
): Promise<boolean> {
  const surface = 'platform_password_reset_initiate' as const;
  const checks: Array<{ dimension: 'source' | 'target' | 'global'; rawKey: string }> = [
    { dimension: 'source', rawKey: `source:${input.sourceKey}` },
    { dimension: 'target', rawKey: `target:${input.targetEmailKey}` },
    { dimension: 'global', rawKey: 'global:platform_password_reset_initiate' },
  ];
  for (const check of checks) {
    const decision = await limiter.check({
      surface,
      dimension: check.dimension,
      rawKey: check.rawKey,
    });
    if (!decision.allowed) return false;
  }
  return true;
}

async function enforceConfirmRateLimits(
  limiter: RecoveryRateLimiterType,
  input: { sourceKey: string; tokenBucketKey: string },
): Promise<boolean> {
  const surface = 'platform_password_reset_confirm' as const;
  const checks = [
    { dimension: 'source' as const, rawKey: `source:${input.sourceKey}` },
    { dimension: 'token' as const, rawKey: `token:${input.tokenBucketKey}` },
    { dimension: 'global' as const, rawKey: 'global:platform_password_reset_confirm' },
  ];
  for (const check of checks) {
    const decision = await limiter.check({
      surface,
      dimension: check.dimension,
      rawKey: check.rawKey,
    });
    if (!decision.allowed) return false;
  }
  return true;
}

async function enforceDiscoveryRateLimits(
  limiter: RecoveryRateLimiterType,
  input: { sourceKey: string; identifierBucketKey: string },
): Promise<boolean> {
  const surface = 'platform_account_discovery' as const;
  const checks = [
    { dimension: 'source' as const, rawKey: `source:${input.sourceKey}` },
    { dimension: 'target' as const, rawKey: `target:${input.identifierBucketKey}` },
    { dimension: 'global' as const, rawKey: 'global:platform_account_discovery' },
  ];
  for (const check of checks) {
    const decision = await limiter.check({
      surface,
      dimension: check.dimension,
      rawKey: check.rawKey,
    });
    if (!decision.allowed) return false;
  }
  return true;
}

export async function deliverPlatformPasswordRecovery(input: {
  adapter: RecoveryDeliveryAdapter;
  service: CredentialRecoveryService;
  issued: {
    recoveryRequestId: string;
    deliverySecret: CredentialRecoverySecret | null;
    expiresAt: Date;
  };
  recipientRef: string;
  requestId: string;
}): Promise<'dispatched' | 'failed' | 'status_persistence_failed'> {
  let status: 'dispatched' | 'failed' = 'failed';
  let secret: CredentialRecoverySecret | null = input.issued.deliverySecret;
  try {
    const result = await input.adapter.send({
      channel: 'email',
      recipientRef: input.recipientRef,
      template: 'platform_password_reset',
      templateParams: {
        expiresAt: input.issued.expiresAt.toISOString(),
      },
      secretPayload: secret,
    });
    status = result.deliveryStatus === 'dispatched' ? 'dispatched' : 'failed';
  } catch {
    status = 'failed';
  } finally {
    secret = null;
  }

  try {
    const persistResult = await input.service.recordDeliveryStatus({
      recoveryRequestId: input.issued.recoveryRequestId,
      deliveryStatus: status,
      requestId: input.requestId,
      actorType: 'system',
      actorId: null,
    });
    if (!persistResult.ok) {
      return 'status_persistence_failed';
    }
  } catch {
    return 'status_persistence_failed';
  }
  return status;
}

export async function confirmPlatformPasswordRecovery(input: {
  service: CredentialRecoveryService;
  prisma: PrismaClient;
  resetToken: string;
  newPassword: string;
  requestId: string;
}): Promise<void> {
  const policyError = assertNewPasswordPolicy(input.newPassword);
  if (policyError) {
    fail(400, 'InvalidRequest', PLATFORM_RECOVERY_INVALID_MESSAGE_KEY);
  }

  const passwordHash = await hashPassword(input.newPassword);
  const result = await input.service.withValidRecoveryRequest(
    {
      rawToken: input.resetToken,
      principalDomain: 'platform_principal',
      purpose: 'password_reset',
      requestId: input.requestId,
      actorType: 'anonymous',
      actorId: null,
    },
    async (ctx, tx) => {
      if (ctx.companyId != null) {
        throw new Error('platform_recovery_company_must_be_null');
      }

      const principal = await tx.platformPrincipal.findFirst({
        where: {
          id: ctx.principalId,
          status: 'active',
        },
        select: {
          id: true,
          status: true,
          credentialVersion: true,
          authorizationVersion: true,
          permissions: true,
        },
      });
      if (!principal || principal.status !== 'active') {
        throw new Error('platform_recovery_principal_inactive');
      }

      // E1 already incremented credentialVersion; do not increment again.
      const changedAt = new Date();
      const updated = await tx.platformPrincipal.updateMany({
        where: {
          id: ctx.principalId,
          status: 'active',
          credentialVersion: ctx.nextCredentialVersion,
        },
        data: {
          password: passwordHash,
        },
      });
      if (updated.count !== 1) {
        throw new Error('platform_recovery_password_update_failed');
      }

      const revoked = await tx.platformRefreshToken.updateMany({
        where: {
          principalId: ctx.principalId,
          revokedAt: null,
        },
        data: {
          revokedAt: changedAt,
          revokedReason: 'platform_password_recovery',
        },
      });

      // Invalidate ephemeral MFA login/enrollment challenges only.
      // Preserve enrolled factor: state, secretCiphertext, backupCodeHashes,
      // enrolledAt, lastVerifiedAt, lastUsedTimeStep, failedAttempts, lockedUntil.
      const mfaRow = await tx.platformMfaCredential.findUnique({
        where: { principalId: ctx.principalId },
        select: {
          challengeTokenHash: true,
          challengePurpose: true,
          challengeExpiresAt: true,
          state: true,
          pendingSecretCiphertext: true,
        },
      });
      let mfaChallengesInvalidatedCount = 0;
      if (mfaRow) {
        const hadTransientChallenge = mfaRow.challengeTokenHash != null
          || mfaRow.challengePurpose != null
          || mfaRow.challengeExpiresAt != null
          || (mfaRow.state !== 'enrolled' && mfaRow.pendingSecretCiphertext != null);
        await tx.platformMfaCredential.update({
          where: { principalId: ctx.principalId },
          data: {
            challengeTokenHash: null,
            challengePurpose: null,
            challengeExpiresAt: null,
            challengeAttempts: 0,
            ...(mfaRow.state !== 'enrolled' ? { pendingSecretCiphertext: null } : {}),
          },
        });
        mfaChallengesInvalidatedCount = hadTransientChallenge ? 1 : 0;
      }

      await tx.credentialRecoveryRequest.updateMany({
        where: {
          principalDomain: 'platform_principal',
          principalId: ctx.principalId,
          companyId: null,
          purpose: 'password_reset',
          id: { not: ctx.recoveryRequestId },
          consumedAt: null,
          invalidatedAt: null,
        },
        data: {
          invalidatedAt: changedAt,
          invalidationReason: 'security_event',
        },
      });

      const recoveryRow = await tx.credentialRecoveryRequest.findUnique({
        where: { id: ctx.recoveryRequestId },
        select: { initiatedBy: true },
      });

      await writePlatformAudit(tx as PrismaClient, {
        principalId: ctx.principalId,
        action: 'platform.auth.password_recovery.completed',
        details: {
          principalId: ctx.principalId,
          previousCredentialVersion: ctx.credentialVersionAtIssuance,
          credentialVersion: ctx.nextCredentialVersion,
          sessionsRevokedCount: revoked.count,
          mfaChallengesInvalidatedCount,
          initiationType: recoveryRow?.initiatedBy === 'platform_operator'
            ? 'platform_operator'
            : 'self',
          recoveryRequestId: ctx.recoveryRequestId,
          requestId: input.requestId,
          status: 'success',
        },
      });

      return { sessionsRevokedCount: revoked.count };
    },
  );

  if (!result.ok) {
    fail(400, 'InvalidRequest', PLATFORM_RECOVERY_INVALID_MESSAGE_KEY);
  }
}

/**
 * Production Platform recovery service. Returns null when crypto config is absent
 * (caller fail-closes in production / returns generic 202 on the public path).
 */
export function createPlatformPrincipalRecoveryService(
  prisma: PrismaClient,
  options?: {
    tokenPepper?: string | null;
    environmentBinding?: string | null;
    clock?: () => Date;
  },
): CredentialRecoveryService | null {
  const tokenPepper = options?.tokenPepper
    ?? process.env[RECOVERY_TOKEN_PEPPER_ENV]
    ?? null;
  const environmentBinding = options?.environmentBinding
    ?? process.env[RECOVERY_ENVIRONMENT_BINDING_ENV]
    ?? null;
  if (!tokenPepper || tokenPepper.length < 32 || !environmentBinding) {
    return null;
  }
  try {
    return new CredentialRecoveryService({
      prisma,
      crypto: assertRecoveryCryptoConfig({ tokenPepper }),
      environmentBinding: resolveEnvironmentBinding(environmentBinding),
      targetStore: new PostgresRecoveryTargetStore(),
      clock: options?.clock,
    });
  } catch {
    return null;
  }
}

export function createPlatformPrincipalRecoveryRateLimiter(
  prisma: PrismaClient,
  pepper: string | undefined | null,
  options?: {
    useInMemoryStore?: boolean;
    clock?: () => Date;
  },
): RecoveryRateLimiterType | null {
  if (!pepper || pepper.length < 32) return null;
  const store = options?.useInMemoryStore
    ? new InMemoryRecoveryRateLimitStore()
    : new PostgresRecoveryRateLimitStore(prisma);
  return new RecoveryRateLimiter(
    store,
    pepper,
    DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
    options?.clock,
  );
}

export function createDefaultPlatformRecoveryDeliveryAdapter(): RecoveryDeliveryAdapter {
  return new UnavailableRecoveryDeliveryAdapter();
}

export function registerPlatformPrincipalRecoveryRoutes({
  app,
  prisma,
  recoveryService = null,
  rateLimiter = null,
  deliveryAdapter = null,
  deliveryScheduler = null,
  timing,
  performDummyCryptoWork,
  isProduction = false,
}: PlatformPrincipalRecoveryDeps): void {
  const resolvedService = recoveryService === undefined
    ? createPlatformPrincipalRecoveryService(prisma)
    : recoveryService;
  const resolvedLimiter = rateLimiter === undefined
    ? createPlatformPrincipalRecoveryRateLimiter(
      prisma,
      process.env[RECOVERY_RATE_LIMIT_PEPPER_ENV],
    )
    : rateLimiter;
  const resolvedDelivery = deliveryAdapter
    ?? createDefaultPlatformRecoveryDeliveryAdapter();
  const resolvedScheduler = deliveryScheduler ?? new RecoveryDeliveryScheduler();

  const route = (
    handler: (req: PlatformRecoveryRequest, res: Response) => Promise<unknown>,
  ): RequestHandler => async (request, response, next) => {
    try {
      await handler(request as PlatformRecoveryRequest, response);
    } catch (error) {
      if (error instanceof PlatformRecoveryHttpError) {
        const requestId = (request as PlatformRecoveryRequest).requestId
          ?? (response.locals as { requestId?: string }).requestId;
        return response.status(error.status).json({
          code: error.code,
          messageKey: error.messageKey,
          ...(requestId ? { requestId } : {}),
        });
      }
      return next(error);
    }
  };

  const requestIdOf = (req: PlatformRecoveryRequest, res: Response): string =>
    req.requestId
    ?? (res.locals as { requestId?: string }).requestId
    ?? crypto.randomUUID();

  app.post(
    '/api/platform/v1/auth/recovery/initiate',
    route(async (req, res) => {
      const requestId = requestIdOf(req, res);
      const genericBody = {
        status: PLATFORM_RECOVERY_INITIATE_STATUS,
        requestId,
      };

      await withNormalizedResponseTime(async () => {
        const parsed = initiateBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return;
        }

        let email: string | null = null;
        try {
          email = normalizeEmail(parsed.data.email);
        } catch {
          return;
        }

        const sourceKey = trustedRecoveryRequestSource(req);

        if (resolvedLimiter) {
          const allowed = await enforceInitiateRateLimits(resolvedLimiter, {
            sourceKey,
            targetEmailKey: email,
          });
          if (!allowed) return;
        } else if (isProduction) {
          return;
        }

        if (!resolvedService) {
          if (performDummyCryptoWork) {
            await performDummyCryptoWork();
          } else {
            await defaultDummyCryptoWork(process.env[RECOVERY_TOKEN_PEPPER_ENV] ?? null);
          }
          return;
        }

        const eligible = await resolvePlatformPrincipalRecoveryEligibility(prisma, {
          email,
        });

        if (!eligible) {
          if (performDummyCryptoWork) {
            await performDummyCryptoWork();
          } else {
            await defaultDummyCryptoWork(process.env[RECOVERY_TOKEN_PEPPER_ENV] ?? null);
          }
          return;
        }

        const pepper = process.env[RECOVERY_RATE_LIMIT_PEPPER_ENV]
          ?? (resolvedLimiter ? 'unused' : null);
        const sourceBucketHash = pepper && pepper.length >= 32
          ? createSourceBucketHash(`platform-initiate:${sourceKey}`, pepper)
          : null;

        const issued = await resolvedService.issue({
          principalDomain: 'platform_principal',
          principalId: eligible.principalId,
          companyId: null,
          purpose: 'password_reset',
          initiatedBy: 'self',
          initiatorPrincipalId: null,
          deliveryChannel: 'email',
          requestId,
          sourceBucketHash,
          actorType: 'anonymous',
          actorId: null,
        });

        if (!issued.ok || !issued.value.deliverySecret) {
          if (performDummyCryptoWork) {
            await performDummyCryptoWork();
          }
          return;
        }

        resolvedScheduler.schedule({
          adapter: resolvedDelivery,
          service: resolvedService,
          issued: {
            recoveryRequestId: issued.value.recoveryRequestId,
            deliverySecret: issued.value.deliverySecret,
            expiresAt: issued.value.expiresAt,
          },
          recipientRef: eligible.recipientRef,
          template: 'platform_password_reset',
          requestId,
        });
      }, timing);

      return res.status(202).json(genericBody);
    }),
  );

  app.post(
    '/api/platform/v1/auth/recovery/confirm',
    route(async (req, res) => {
      const requestId = requestIdOf(req, res);
      const parsed = confirmBodySchema.safeParse(req.body);
      if (!parsed.success) {
        fail(400, 'InvalidRequest', PLATFORM_RECOVERY_INVALID_MESSAGE_KEY);
      }

      if (!resolvedService) {
        fail(400, 'InvalidRequest', PLATFORM_RECOVERY_INVALID_MESSAGE_KEY);
      }

      if (resolvedLimiter) {
        const tokenBucketKey = crypto
          .createHash('sha256')
          .update(parsed.data.resetToken)
          .digest('hex');
        const allowed = await enforceConfirmRateLimits(resolvedLimiter, {
          sourceKey: trustedRecoveryRequestSource(req),
          tokenBucketKey,
        });
        if (!allowed) {
          fail(400, 'InvalidRequest', PLATFORM_RECOVERY_INVALID_MESSAGE_KEY);
        }
      } else if (isProduction) {
        fail(400, 'InvalidRequest', PLATFORM_RECOVERY_INVALID_MESSAGE_KEY);
      }

      await confirmPlatformPasswordRecovery({
        service: resolvedService,
        prisma,
        resetToken: parsed.data.resetToken,
        newPassword: parsed.data.newPassword,
        requestId,
      });

      return res.status(200).json({
        status: PLATFORM_RECOVERY_CONFIRM_STATUS,
        requestId,
      });
    }),
  );

  app.post(
    '/api/platform/v1/auth/discovery/notify',
    route(async (req, res) => {
      const requestId = requestIdOf(req, res);
      const genericBody = {
        status: PLATFORM_DISCOVERY_UNAVAILABLE_STATUS,
        requestId,
      };

      await withNormalizedResponseTime(async () => {
        const parsed = discoveryBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return;
        }

        // Never persist or log the raw identifier. Hash only for independent
        // discovery rate-limit buckets; do not query PlatformPrincipal by email.
        const identifierBucketKey = crypto
          .createHash('sha256')
          .update(parsed.data.recoveryIdentifier)
          .digest('hex');
        const sourceKey = trustedRecoveryRequestSource(req);

        if (resolvedLimiter) {
          await enforceDiscoveryRateLimits(resolvedLimiter, {
            sourceKey,
            identifierBucketKey,
          });
        } else if (isProduction) {
          return;
        }

        // Binding decision: no durable verified alternate channel exists.
        // Do not mint tokens, do not deliver, do not create discovery rows.
        void resolvePlatformAccountDiscoveryEligibility({
          recoveryIdentifier: parsed.data.recoveryIdentifier,
        });
        void PLATFORM_ACCOUNT_DISCOVERY_ALTERNATE_CHANNEL_AVAILABLE;
      }, timing);

      return res.status(202).json(genericBody);
    }),
  );
}

export {
  CapturingRecoveryDeliveryAdapter,
  UnavailableRecoveryDeliveryAdapter,
  trustedRecoveryRequestSource,
};
