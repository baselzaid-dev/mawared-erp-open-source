import crypto from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
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
import {
  IdentityInputError,
  normalizeCompanyCode,
  normalizeEmail,
  normalizeLoginIdentifier,
} from './identity';

type TxClient = Prisma.TransactionClient;

export const OWNER_RECOVERY_INITIATE_STATUS =
  'if_owner_account_exists_instructions_sent' as const;
export const OWNER_RECOVERY_CONFIRM_STATUS = 'recovery_complete' as const;
export const OWNER_RECOVERY_INVALID_MESSAGE_KEY =
  'owner_recovery.invalid_or_expired' as const;

const RESET_TOKEN_MIN = 40;
const RESET_TOKEN_MAX = 256;
const RESET_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

const initiateBodySchema = z
  .object({
    companyCode: z.string().min(1).max(64),
    ownerEmail: z.string().trim().email().max(320),
  })
  .strict();

const confirmBodySchema = z
  .object({
    resetToken: z.string().min(RESET_TOKEN_MIN).max(RESET_TOKEN_MAX).regex(RESET_TOKEN_RE),
    newPassword: z.string().min(1).max(512),
  })
  .strict();

interface OwnerRecoveryRequest extends Request {
  requestId?: string;
}

class OwnerRecoveryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

const fail = (status: number, code: string, messageKey: string): never => {
  throw new OwnerRecoveryHttpError(status, code, messageKey);
};

export interface OwnerRecoveryEligibleTarget {
  companyId: string;
  userId: string;
  recipientRef: string;
}

export interface CompanyOwnerRecoveryDeps {
  app: Express;
  prisma: PrismaClient;
  recoveryService?: CredentialRecoveryService | null;
  rateLimiter?: RecoveryRateLimiterType | null;
  deliveryAdapter?: RecoveryDeliveryAdapter | null;
  /** Bounded async delivery scheduler. Defaults to a new bounded scheduler. */
  deliveryScheduler?: RecoveryDeliveryScheduler | null;
  timing?: RecoveryTimingNormalizationOptions;
  /** Injected dummy-work hook for deterministic timing/enumeration tests. */
  performDummyCryptoWork?: () => Promise<void>;
  isProduction?: boolean;
}

/**
 * Resolve Primary Owner eligibility from server state only.
 * Never trusts client-supplied companyId/userId.
 */
export async function resolveOwnerRecoveryEligibility(
  prisma: PrismaClient | TxClient,
  input: { companyCode: string; ownerEmail: string },
): Promise<OwnerRecoveryEligibleTarget | null> {
  let companyCode: string;
  let ownerEmail: string;
  try {
    companyCode = normalizeCompanyCode(input.companyCode);
    ownerEmail = normalizeEmail(input.ownerEmail);
  } catch (error) {
    if (error instanceof IdentityInputError) return null;
    throw error;
  }

  const company = await prisma.company.findUnique({
    where: { code: companyCode },
    select: { id: true },
  });
  if (!company) return null;

  const normalizedIdentifier = normalizeLoginIdentifier(ownerEmail);
  const identity = await prisma.loginIdentity.findUnique({
    where: {
      companyId_normalizedIdentifier: {
        companyId: company.id,
        normalizedIdentifier,
      },
    },
    select: { userId: true, companyId: true, type: true },
  });
  if (!identity || identity.companyId !== company.id) return null;

  const user = await prisma.user.findFirst({
    where: {
      id: identity.userId,
      companyId: company.id,
      accountStatus: 'active',
    },
    select: {
      id: true,
      companyId: true,
      employeeId: true,
      normalizedEmail: true,
      employee: { select: { status: true, archivedAt: true } },
    },
  });
  if (!user || user.companyId !== company.id) return null;
  if (user.normalizedEmail !== ownerEmail) return null;

  if (user.employeeId) {
    const employee = user.employee;
    if (
      !employee
      || employee.archivedAt != null
      || employee.status === 'terminated'
      || employee.status === 'inactive'
      || employee.status === 'archived'
    ) {
      return null;
    }
  }

  const ownerships = await prisma.companyOwnership.findMany({
    where: {
      companyId: company.id,
      isPrimary: true,
      status: 'active',
      endedAt: null,
    },
    select: { userId: true, companyId: true },
  });
  if (ownerships.length !== 1) return null;
  const ownership = ownerships[0];
  if (ownership.userId !== user.id || ownership.companyId !== company.id) {
    return null;
  }

  return {
    companyId: company.id,
    userId: user.id,
    recipientRef: `owner-email:${company.id}:${user.id}`,
  };
}

async function defaultDummyCryptoWork(serviceCryptoPepper: string | null): Promise<void> {
  // Bounded dummy HMAC so ineligible paths spend similar CPU without minting a live request.
  const pepper = serviceCryptoPepper && serviceCryptoPepper.length >= 32
    ? serviceCryptoPepper
    : 'owner-recovery-dummy-pepper-not-for-production-use!!';
  mintRecoveryTokenMaterial(
    {
      principalDomain: 'company_primary_owner',
      purpose: 'password_reset',
      environmentBinding: 'test:dummy-binding-path',
    },
    { tokenPepper: pepper },
  );
}

async function enforceInitiateRateLimits(
  limiter: RecoveryRateLimiterType,
  input: {
    sourceKey: string;
    targetTupleKey: string;
    companyKey: string | null;
  },
): Promise<boolean> {
  const surface = 'company_owner_recovery_initiate' as const;
  const checks: Array<{ dimension: 'source' | 'target' | 'company' | 'global'; rawKey: string }> = [
    { dimension: 'source', rawKey: `source:${input.sourceKey}` },
    { dimension: 'target', rawKey: `target:${input.targetTupleKey}` },
    { dimension: 'global', rawKey: 'global:company_owner_recovery_initiate' },
  ];
  if (input.companyKey) {
    checks.push({ dimension: 'company', rawKey: `company:${input.companyKey}` });
  }
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
  const surface = 'company_owner_recovery_confirm' as const;
  const checks = [
    { dimension: 'source' as const, rawKey: `source:${input.sourceKey}` },
    { dimension: 'token' as const, rawKey: `token:${input.tokenBucketKey}` },
    { dimension: 'global' as const, rawKey: 'global:company_owner_recovery_confirm' },
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

export async function deliverOwnerRecovery(input: {
  adapter: RecoveryDeliveryAdapter;
  service: CredentialRecoveryService;
  issued: {
    recoveryRequestId: string;
    deliverySecret: CredentialRecoverySecret | null;
    expiresAt: Date;
  };
  recipientRef: string;
  template: 'company_owner_password_reset' | 'company_owner_recovery_platform_initiated';
  requestId: string;
  actorType?: 'anonymous' | 'platform_owner' | 'system';
  actorId?: string | null;
}): Promise<'dispatched' | 'failed' | 'status_persistence_failed'> {
  let status: 'dispatched' | 'failed' = 'failed';
  let secret: CredentialRecoverySecret | null = input.issued.deliverySecret;
  try {
    const result = await input.adapter.send({
      channel: 'email',
      recipientRef: input.recipientRef,
      template: input.template,
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
      actorType: input.actorType ?? 'system',
      actorId: input.actorId ?? null,
    });
    if (!persistResult.ok) {
      return 'status_persistence_failed';
    }
  } catch {
    return 'status_persistence_failed';
  }
  return status;
}

export async function confirmOwnerPasswordRecovery(input: {
  service: CredentialRecoveryService;
  prisma: PrismaClient;
  resetToken: string;
  newPassword: string;
  requestId: string;
}): Promise<void> {
  const policyError = assertNewPasswordPolicy(input.newPassword);
  if (policyError) {
    fail(400, 'InvalidRequest', OWNER_RECOVERY_INVALID_MESSAGE_KEY);
  }

  const passwordHash = await hashPassword(input.newPassword);
  const result = await input.service.withValidRecoveryRequest(
    {
      rawToken: input.resetToken,
      principalDomain: 'company_primary_owner',
      purpose: 'password_reset',
      requestId: input.requestId,
      actorType: 'anonymous',
      actorId: null,
    },
    async (ctx, tx) => {
      if (!ctx.companyId) {
        throw new Error('owner_recovery_company_required');
      }

      const ownership = await tx.companyOwnership.findMany({
        where: {
          companyId: ctx.companyId,
          userId: ctx.principalId,
          isPrimary: true,
          status: 'active',
          endedAt: null,
        },
        select: {
          id: true,
          companyId: true,
          userId: true,
          isPrimary: true,
          status: true,
          activePrimaryCompanyId: true,
        },
      });
      if (ownership.length !== 1) {
        throw new Error('owner_recovery_ownership_inactive');
      }

      const user = await tx.user.findFirst({
        where: {
          id: ctx.principalId,
          companyId: ctx.companyId,
          accountStatus: 'active',
        },
        select: {
          id: true,
          companyId: true,
          employeeId: true,
          credentialVersion: true,
          employee: { select: { status: true, archivedAt: true } },
        },
      });
      if (!user || user.companyId !== ctx.companyId) {
        throw new Error('owner_recovery_user_inactive');
      }
      if (user.employeeId) {
        const employee = user.employee;
        if (
          !employee
          || employee.archivedAt != null
          || employee.status === 'terminated'
          || employee.status === 'inactive'
          || employee.status === 'archived'
        ) {
          throw new Error('owner_recovery_employee_inactive');
        }
      }

      // E1 already incremented credentialVersion; do not increment again.
      const changedAt = new Date();
      const updated = await tx.user.updateMany({
        where: {
          id: ctx.principalId,
          companyId: ctx.companyId,
          accountStatus: 'active',
          credentialVersion: ctx.nextCredentialVersion,
        },
        data: {
          password: passwordHash,
          passwordChangedAt: changedAt,
          mustChangePassword: false,
          temporaryPasswordExpiresAt: null,
        },
      });
      if (updated.count !== 1) {
        throw new Error('owner_recovery_password_update_failed');
      }

      const revoked = await tx.refreshToken.updateMany({
        where: {
          userId: ctx.principalId,
          companyId: ctx.companyId,
          revokedAt: null,
        },
        data: {
          revokedAt: changedAt,
          revokedReason: 'owner_recovery',
        },
      });

      await tx.credentialRecoveryRequest.updateMany({
        where: {
          principalDomain: 'company_primary_owner',
          principalId: ctx.principalId,
          companyId: ctx.companyId,
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

      await writeAuditRequired(tx, {
        companyId: ctx.companyId,
        userId: ctx.principalId,
        action: 'company.owner_recovery.completed',
        details: {
          targetUserId: ctx.principalId,
          previousCredentialVersion: ctx.credentialVersionAtIssuance,
          credentialVersion: ctx.nextCredentialVersion,
          sessionsRevokedCount: revoked.count,
          initiationType: recoveryRow?.initiatedBy === 'platform_operator'
            ? 'platform_operator'
            : 'self',
          recoveryRequestRef: ctx.recoveryRequestId,
          requestId: input.requestId,
          status: 'success',
        },
      });

      return { sessionsRevokedCount: revoked.count };
    },
  );

  if (!result.ok) {
    fail(400, 'InvalidRequest', OWNER_RECOVERY_INVALID_MESSAGE_KEY);
  }
}

/**
 * Build production CredentialRecoveryService. Returns null when crypto config
 * is absent (caller fail-closes in production / returns generic 202 in public path).
 */
export function createCompanyOwnerRecoveryService(
  prisma: PrismaClient,
  options?: {
    tokenPepper?: string | null;
    environmentBinding?: string | null;
    clock?: () => Date;
    useInMemoryTargetStore?: never;
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

export function createCompanyOwnerRecoveryRateLimiter(
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

/**
 * Default adapter when callers do not inject one.
 * E6: prefer createRecoveryDeliveryAdapterFromEnv for Production wiring.
 * This remains Unavailable (fail-closed delivery) — never a silent mock dispatch.
 */
export function createDefaultOwnerRecoveryDeliveryAdapter(): RecoveryDeliveryAdapter {
  return new UnavailableRecoveryDeliveryAdapter();
}

/**
 * Trusted request source for rate limiting. Never reads client-supplied
 * X-Forwarded-For directly; uses Express `req.ip` after the application's
 * existing trust-proxy policy, with a stable keyed fallback only.
 */
export function trustedRecoveryRequestSource(req: Request): string {
  return ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown');
}

export function registerCompanyOwnerRecoveryRoutes({
  app,
  prisma,
  recoveryService = null,
  rateLimiter = null,
  deliveryAdapter = null,
  deliveryScheduler = null,
  timing,
  performDummyCryptoWork,
  isProduction = false,
}: CompanyOwnerRecoveryDeps): void {
  const resolvedService = recoveryService === undefined
    ? createCompanyOwnerRecoveryService(prisma)
    : recoveryService;
  const resolvedLimiter = rateLimiter === undefined
    ? createCompanyOwnerRecoveryRateLimiter(
      prisma,
      process.env[RECOVERY_RATE_LIMIT_PEPPER_ENV],
    )
    : rateLimiter;
  const resolvedDelivery = deliveryAdapter
    ?? createDefaultOwnerRecoveryDeliveryAdapter();
  const resolvedScheduler = deliveryScheduler ?? new RecoveryDeliveryScheduler();

  if (isProduction && (!resolvedService || !resolvedLimiter)) {
    // Fail closed: routes still register but always take the safe generic path
    // without minting tokens when crypto/rate-limit peppers are absent.
  }

  const route = (
    handler: (req: OwnerRecoveryRequest, res: Response) => Promise<unknown>,
  ): RequestHandler => async (request, response, next) => {
    try {
      await handler(request as OwnerRecoveryRequest, response);
    } catch (error) {
      if (error instanceof OwnerRecoveryHttpError) {
        const requestId = (request as OwnerRecoveryRequest).requestId
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

  const requestIdOf = (req: OwnerRecoveryRequest, res: Response): string =>
    req.requestId
    ?? (res.locals as { requestId?: string }).requestId
    ?? crypto.randomUUID();

  app.post(
    '/api/v2/auth/owner-recovery/initiate',
    route(async (req, res) => {
      const requestId = requestIdOf(req, res);
      const genericBody = {
        status: OWNER_RECOVERY_INITIATE_STATUS,
        requestId,
      };

      await withNormalizedResponseTime(async () => {
        const parsed = initiateBodySchema.safeParse(req.body);
        if (!parsed.success) {
          // Invalid syntax still returns opaque 202 (enumeration-safe).
          return;
        }

        let companyCode: string | null = null;
        let ownerEmail: string | null = null;
        try {
          companyCode = normalizeCompanyCode(parsed.data.companyCode);
          ownerEmail = normalizeEmail(parsed.data.ownerEmail);
        } catch {
          return;
        }

        const targetTupleKey = `${companyCode}\u0000${ownerEmail}`;
        const sourceKey = trustedRecoveryRequestSource(req);

        // Rate limit before any token mint. Blocked requests still return 202.
        if (resolvedLimiter) {
          let companyKey: string | null = null;
          try {
            const company = await prisma.company.findUnique({
              where: { code: companyCode },
              select: { id: true },
            });
            companyKey = company?.id ?? null;
          } catch {
            companyKey = null;
          }
          const allowed = await enforceInitiateRateLimits(resolvedLimiter, {
            sourceKey,
            targetTupleKey,
            companyKey,
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

        const eligible = await resolveOwnerRecoveryEligibility(prisma, {
          companyCode,
          ownerEmail,
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
          ? createSourceBucketHash(`owner-initiate:${sourceKey}`, pepper)
          : null;

        const issued = await resolvedService.issue({
          principalDomain: 'company_primary_owner',
          principalId: eligible.userId,
          companyId: eligible.companyId,
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

        // Schedule delivery outside the public timing path; the opaque 202 must
        // complete on the server-owned floor independent of adapter latency.
        resolvedScheduler.schedule({
          adapter: resolvedDelivery,
          service: resolvedService,
          issued: {
            recoveryRequestId: issued.value.recoveryRequestId,
            deliverySecret: issued.value.deliverySecret,
            expiresAt: issued.value.expiresAt,
          },
          recipientRef: eligible.recipientRef,
          template: 'company_owner_password_reset',
          requestId,
        });
      }, timing);

      return res.status(202).json(genericBody);
    }),
  );

  app.post(
    '/api/v2/auth/owner-recovery/confirm',
    route(async (req, res) => {
      const requestId = requestIdOf(req, res);
      const parsed = confirmBodySchema.safeParse(req.body);
      if (!parsed.success) {
        fail(400, 'InvalidRequest', OWNER_RECOVERY_INVALID_MESSAGE_KEY);
      }

      if (!resolvedService) {
        fail(400, 'InvalidRequest', OWNER_RECOVERY_INVALID_MESSAGE_KEY);
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
          fail(400, 'InvalidRequest', OWNER_RECOVERY_INVALID_MESSAGE_KEY);
        }
      } else if (isProduction) {
        fail(400, 'InvalidRequest', OWNER_RECOVERY_INVALID_MESSAGE_KEY);
      }

      await confirmOwnerPasswordRecovery({
        service: resolvedService,
        prisma,
        resetToken: parsed.data.resetToken,
        newPassword: parsed.data.newPassword,
        requestId,
      });

      return res.status(200).json({
        status: OWNER_RECOVERY_CONFIRM_STATUS,
        requestId,
      });
    }),
  );
}

export {
  CapturingRecoveryDeliveryAdapter,
  UnavailableRecoveryDeliveryAdapter,
};
