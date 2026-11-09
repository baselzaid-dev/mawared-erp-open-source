import crypto from 'node:crypto';
import type express from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  resolveOwnerRecoveryEligibility,
} from './companyOwnerRecovery';
import {
  CredentialRecoveryService,
  type CredentialRecoverySecret,
  type RecoveryDeliveryAdapter,
  type RecoveryRateLimiter as RecoveryRateLimiterType,
} from './credentialRecovery';
import { createSourceBucketHash } from './credentialRecovery/tokenCrypto';
import {
  DEFAULT_PLATFORM_RECENT_MFA_MAX_AGE_MS,
  PLATFORM_PERMISSIONS,
  isPlatformMfaRecent,
  writePlatformAudit,
  type PlatformPrincipalContext,
  type PlatformRequest,
} from './platformAuth';

export const OWNER_RECOVERY_REASON_CATEGORIES = [
  'lost_registered_channel',
  'company_lockout',
  'suspected_compromise',
  'verified_owner_request',
] as const;

export type OwnerRecoveryReasonCategory =
  (typeof OWNER_RECOVERY_REASON_CATEGORIES)[number];

/** Server-owned stale-pending threshold for assisted delivery recovery. */
export const PLATFORM_OWNER_RECOVERY_STALE_PENDING_MS = 5 * 60 * 1000;
/**
 * Server-owned assisted adapter wait budget.
 * Timeout does NOT cancel the adapter (no AbortSignal in the delivery contract)
 * and does NOT mark delivery failed — the request stays pending.
 */
export const PLATFORM_OWNER_RECOVERY_DELIVERY_TIMEOUT_MS = 10_000;

/** Versioned owner-recovery idempotency envelope stored in PlatformIdempotencyKey.requestHash. */
export const OWNER_RECOVERY_IDEMPOTENCY_HASH_VERSION = 'v1';

/**
 * Exact correlation format (owner recovery only; provisioning keeps plain digests):
 * `v1:{canonicalSha256Hex}:{recoveryRequestId}`
 */
const OWNER_RECOVERY_IDEMPOTENCY_HASH_RE =
  /^v1:([a-f0-9]{64}):([A-Za-z0-9._:-]{8,128})$/;

export function encodeOwnerRecoveryIdempotencyHash(
  digest: string,
  recoveryRequestId: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('owner_recovery_idempotency_digest_invalid');
  }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(recoveryRequestId)) {
    throw new Error('owner_recovery_idempotency_recovery_id_invalid');
  }
  return `${OWNER_RECOVERY_IDEMPOTENCY_HASH_VERSION}:${digest}:${recoveryRequestId}`;
}

export function parseOwnerRecoveryIdempotencyHash(
  raw: string,
): { digest: string; recoveryRequestId: string } | null {
  const match = OWNER_RECOVERY_IDEMPOTENCY_HASH_RE.exec(raw.trim());
  if (!match) return null;
  return { digest: match[1], recoveryRequestId: match[2] };
}

/** Opaque ticket/case reference — no URLs, emails, tokens, or free-text evidence. */
const APPROVAL_REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const FORBIDDEN_APPROVAL_SHAPE =
  /(?:@|https?:\/\/|Bearer\s+|password|token|cookie|authorization|mfasecret|\+?\d{7,})/i;

const idempotencySchema = z.string().trim().min(8).max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const assistedBodySchema = z
  .object({
    reasonCategory: z.enum(OWNER_RECOVERY_REASON_CATEGORIES),
    approvalReference: z.string().trim().min(8).max(128),
    confirmation: z.literal(true),
  })
  .strict();

class PlatformOwnerRecoveryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

const fail = (status: number, code: string, messageKey: string): never => {
  throw new PlatformOwnerRecoveryError(status, code, messageKey);
};

const requestDigest = (value: unknown): string =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

type AssistedDeliverable = {
  recoveryRequestId: string;
  deliverySecret: CredentialRecoverySecret;
  expiresAt: Date;
  recipientRef: string;
};

type AssistedOperationOutcome =
  | { kind: 'replay_dispatched' }
  | { kind: 'replay_pending' }
  | ({ kind: 'deliver_new' } & AssistedDeliverable)
  | ({ kind: 'deliver_replacement' } & AssistedDeliverable);

type AssistedDeliveryOutcome =
  | 'dispatched'
  | 'failed'
  | 'pending_timeout'
  | 'status_persistence_failed';

function sanitizeApprovalReference(raw: string): string {
  const trimmed = raw.trim();
  if (!APPROVAL_REFERENCE_RE.test(trimmed) || FORBIDDEN_APPROVAL_SHAPE.test(trimmed)) {
    fail(400, 'InvalidRequest', 'platform.invalid_request');
  }
  return trimmed;
}

async function resolveActivePrimaryOwnerForCompany(
  prisma: PrismaClient,
  companyId: string,
): Promise<{ companyId: string; userId: string; recipientRef: string } | null> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, code: true },
  });
  if (!company) return null;

  const ownerships = await prisma.companyOwnership.findMany({
    where: {
      companyId: company.id,
      isPrimary: true,
      status: 'active',
      endedAt: null,
    },
    select: {
      userId: true,
      companyId: true,
      user: {
        select: {
          id: true,
          companyId: true,
          accountStatus: true,
          normalizedEmail: true,
          employeeId: true,
          employee: { select: { status: true, archivedAt: true } },
        },
      },
    },
  });
  if (ownerships.length !== 1) return null;
  const ownership = ownerships[0];
  const user = ownership.user;
  if (
    !user
    || user.companyId !== company.id
    || user.accountStatus !== 'active'
    || ownership.userId !== user.id
  ) {
    return null;
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
      return null;
    }
  }

  const eligible = await resolveOwnerRecoveryEligibility(prisma, {
    companyCode: company.code,
    ownerEmail: user.normalizedEmail,
  });
  if (!eligible || eligible.userId !== user.id || eligible.companyId !== company.id) {
    return null;
  }
  return eligible;
}

async function loadAssistedRecoveryById(
  prisma: PrismaClient | import('@prisma/client').Prisma.TransactionClient,
  recoveryRequestId: string,
): Promise<{
  id: string;
  principalId: string;
  companyId: string | null;
  deliveryStatus: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  invalidatedAt: Date | null;
} | null> {
  return prisma.credentialRecoveryRequest.findUnique({
    where: { id: recoveryRequestId },
    select: {
      id: true,
      principalId: true,
      companyId: true,
      deliveryStatus: true,
      createdAt: true,
      expiresAt: true,
      consumedAt: true,
      invalidatedAt: true,
    },
  });
}

async function enforcePlatformOwnerRecoveryRateLimits(
  limiter: RecoveryRateLimiterType,
  input: {
    actorPrincipalId: string;
    companyId: string;
    ownerUserId: string;
  },
): Promise<void> {
  const surface = 'company_owner_recovery_initiate' as const;
  const checks = [
    { dimension: 'actor' as const, rawKey: `platform-actor:${input.actorPrincipalId}` },
    { dimension: 'company' as const, rawKey: `company:${input.companyId}` },
    { dimension: 'target' as const, rawKey: `target-owner:${input.ownerUserId}` },
    { dimension: 'global' as const, rawKey: `global:company_owner_recovery_initiate` },
  ];
  for (const check of checks) {
    const decision = await limiter.check({
      surface,
      dimension: check.dimension,
      rawKey: check.rawKey,
    });
    if (!decision.allowed) {
      fail(429, 'RateLimited', 'platform.owner_recovery_rate_limited');
    }
  }
}

/**
 * Phase A: observe adapter outcome (dispatched / failed / throw / timeout).
 * Phase B: persist terminal status + E1 audit + Platform final audit atomically
 * via recordDeliveryStatusWithEffect. RecoveryResult.ok is authoritative —
 * resolved ok:false is status_persistence_failed (never claim terminal).
 * Timeout leaves durable status pending and does not claim AbortSignal cancellation.
 */
async function performAssistedDelivery(input: {
  adapter: RecoveryDeliveryAdapter;
  service: CredentialRecoveryService;
  recoveryRequestId: string;
  deliverySecret: CredentialRecoverySecret;
  expiresAt: Date;
  recipientRef: string;
  companyId: string;
  requestId: string;
  actorId: string;
  timeoutMs: number;
}): Promise<AssistedDeliveryOutcome> {
  let secret: CredentialRecoverySecret | null = input.deliverySecret;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  type AdapterPhase =
    | { kind: 'dispatched' }
    | { kind: 'failed' }
    | { kind: 'timeout' };

  let adapterPhase: AdapterPhase;
  try {
    const sendPromise = input.adapter.send({
      channel: 'email',
      recipientRef: input.recipientRef,
      template: 'company_owner_recovery_platform_initiated',
      templateParams: { expiresAt: input.expiresAt.toISOString() },
      secretPayload: secret,
    }).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const raced = await Promise.race([
      sendPromise,
      new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timeout'), input.timeoutMs);
      }),
    ]);

    if (raced === 'timeout') {
      void sendPromise.then(() => undefined, () => undefined);
      adapterPhase = { kind: 'timeout' };
    } else if (!raced.ok) {
      adapterPhase = { kind: 'failed' };
    } else if (raced.result.deliveryStatus === 'dispatched') {
      adapterPhase = { kind: 'dispatched' };
    } else {
      adapterPhase = { kind: 'failed' };
    }
  } catch {
    adapterPhase = { kind: 'failed' };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    secret = null;
  }

  if (adapterPhase.kind === 'timeout') {
    return 'pending_timeout';
  }

  try {
    const persistResult = await input.service.recordDeliveryStatusWithEffect(
      {
        recoveryRequestId: input.recoveryRequestId,
        deliveryStatus: adapterPhase.kind,
        requestId: input.requestId,
        actorType: 'platform_owner',
        actorId: input.actorId,
      },
      async (tx, recorded) => {
        await writePlatformAudit(tx as PrismaClient, {
          principalId: input.actorId,
          action: 'platform.companies.owner_recovery.delivery',
          targetCompanyId: input.companyId,
          details: {
            companyId: input.companyId,
            recoveryRequestRef: recorded.recoveryRequestId,
            requestId: input.requestId,
            status: recorded.deliveryStatus,
          },
        });
      },
    );
    if (!persistResult.ok) {
      return 'status_persistence_failed';
    }
    return adapterPhase.kind;
  } catch {
    // Confirmed external outcome must not be rewritten to the opposite status.
    // Leave durable row pending when persistence cannot complete.
    return 'status_persistence_failed';
  }
}

export interface PlatformOwnerRecoveryRouteDeps {
  app: express.Express;
  prisma: PrismaClient;
  requirePlatformAuth: express.RequestHandler;
  recoveryService: CredentialRecoveryService | null;
  rateLimiter: RecoveryRateLimiterType | null;
  deliveryAdapter: RecoveryDeliveryAdapter;
  recentMfaMaxAgeMs?: number;
  rateLimitPepper?: string | null;
  clock?: () => Date;
  stalePendingMs?: number;
  deliveryTimeoutMs?: number;
  isProduction?: boolean;
}

export function registerPlatformOwnerRecoveryRoutes({
  app,
  prisma,
  requirePlatformAuth,
  recoveryService,
  rateLimiter,
  deliveryAdapter,
  recentMfaMaxAgeMs = DEFAULT_PLATFORM_RECENT_MFA_MAX_AGE_MS,
  rateLimitPepper = null,
  clock = () => new Date(),
  stalePendingMs = PLATFORM_OWNER_RECOVERY_STALE_PENDING_MS,
  deliveryTimeoutMs = PLATFORM_OWNER_RECOVERY_DELIVERY_TIMEOUT_MS,
  isProduction = false,
}: PlatformOwnerRecoveryRouteDeps): void {
  const route = (
    handler: (req: express.Request, res: express.Response) => Promise<unknown>,
  ): express.RequestHandler => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof PlatformOwnerRecoveryError) {
        const requestId = (req as { requestId?: string }).requestId
          ?? (res.locals as { requestId?: string }).requestId;
        return res.status(error.status).json({
          code: error.code,
          messageKey: error.messageKey,
          ...(requestId ? { requestId } : {}),
        });
      }
      if ((error as { code?: string }).code === 'P2002') {
        return res.status(409).json({
          code: 'PlatformConflict',
          messageKey: 'platform.conflict',
        });
      }
      return res.status(500).json({
        code: 'PlatformOperationFailed',
        messageKey: 'platform.operation_failed',
      });
    }
  };

  const actor = (req: express.Request): PlatformPrincipalContext => {
    const principal = (req as PlatformRequest).platformPrincipal;
    if (!principal) fail(401, 'PlatformUnauthorized', 'platform.unauthorized');
    return principal;
  };

  const requireCapability = (
    principal: PlatformPrincipalContext,
    permission: string,
  ): void => {
    if (!principal.permissions.includes(permission)) {
      fail(403, 'PlatformForbidden', 'platform.forbidden');
    }
  };

  app.post(
    '/api/platform/v1/companies/:companyId/owner-recovery/initiate',
    requirePlatformAuth,
    route(async (req, res) => {
      const principal = actor(req);
      requireCapability(principal, PLATFORM_PERMISSIONS.COMPANIES_OWNER_RECOVERY_INITIATE);

      if (!isPlatformMfaRecent(principal, recentMfaMaxAgeMs, clock())) {
        fail(403, 'PlatformMfaReauthRequired', 'platform.mfa_reauth_required');
      }

      const key = idempotencySchema.safeParse(req.header('Idempotency-Key'));
      if (!key.success) {
        fail(400, 'IdempotencyKeyRequired', 'platform.idempotency_key_required');
      }

      const parsed = assistedBodySchema.safeParse(req.body);
      if (!parsed.success) fail(400, 'InvalidRequest', 'platform.invalid_request');
      const approvalReference = sanitizeApprovalReference(parsed.data.approvalReference);

      const companyId = String(req.params.companyId ?? '').trim();
      if (!companyId) fail(400, 'InvalidRequest', 'platform.invalid_request');

      const requestId = (req as { requestId?: string }).requestId
        ?? (res.locals as { requestId?: string }).requestId
        ?? crypto.randomUUID();

      const canonicalRequest = {
        companyId,
        reasonCategory: parsed.data.reasonCategory,
        approvalReference,
        confirmation: true as const,
      };
      const digest = requestDigest(canonicalRequest);

      if (!recoveryService) {
        fail(503, 'ServiceUnavailable', 'platform.owner_recovery_unavailable');
      }

      const pepper = rateLimitPepper;
      const sourceBucketHash = pepper && pepper.length >= 32
        ? createSourceBucketHash(`platform-owner-initiate:${principal.id}`, pepper)
        : null;

      // Serialize classification + replacement ownership under one advisory lock.
      const outcome: AssistedOperationOutcome = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtext(${`mawared-owner-recovery-idem:${principal.id}:${key.data}`})
          )
        `;

        const existingKey = await tx.platformIdempotencyKey.findUnique({
          where: { principalId_key: { principalId: principal.id, key: key.data } },
        });

        if (!existingKey) {
          const owner = await resolveActivePrimaryOwnerForCompany(prisma, companyId);
          if (!owner) {
            const company = await prisma.company.findUnique({
              where: { id: companyId },
              select: { id: true },
            });
            if (!company) {
              fail(404, 'PlatformCompanyNotFound', 'platform.company_not_found');
            }
            fail(403, 'PlatformOwnerRecoveryDenied', 'platform.owner_recovery_denied');
          }

          if (rateLimiter) {
            await enforcePlatformOwnerRecoveryRateLimits(rateLimiter, {
              actorPrincipalId: principal.id,
              companyId: owner.companyId,
              ownerUserId: owner.userId,
            });
          } else if (isProduction) {
            fail(503, 'ServiceUnavailable', 'platform.owner_recovery_unavailable');
          }

          const issued = await recoveryService.issueInTransaction(tx, {
            principalDomain: 'company_primary_owner',
            principalId: owner.userId,
            companyId: owner.companyId,
            purpose: 'password_reset',
            initiatedBy: 'platform_operator',
            initiatorPrincipalId: principal.id,
            deliveryChannel: 'email',
            requestId,
            sourceBucketHash,
            actorType: 'platform_owner',
            actorId: principal.id,
          });

          if (!issued.deliverySecret) {
            fail(500, 'PlatformOperationFailed', 'platform.operation_failed');
          }

          await tx.platformIdempotencyKey.create({
            data: {
              principalId: principal.id,
              key: key.data,
              requestHash: encodeOwnerRecoveryIdempotencyHash(digest, issued.recoveryRequestId),
              companyId: owner.companyId,
            },
          });

          await writePlatformAudit(tx as PrismaClient, {
            principalId: principal.id,
            action: 'platform.companies.owner_recovery.initiate',
            targetCompanyId: owner.companyId,
            details: {
              companyId: owner.companyId,
              reasonCategory: parsed.data.reasonCategory,
              approvalReference,
              recoveryRequestRef: issued.recoveryRequestId,
              requestId,
              status: 'pending',
            },
          });

          return {
            kind: 'deliver_new' as const,
            recoveryRequestId: issued.recoveryRequestId,
            deliverySecret: issued.deliverySecret,
            expiresAt: issued.expiresAt,
            recipientRef: owner.recipientRef,
          };
        }

        if (existingKey.companyId !== companyId) {
          fail(409, 'IdempotencyConflict', 'platform.idempotency_conflict');
        }

        const envelope = parseOwnerRecoveryIdempotencyHash(existingKey.requestHash);
        if (!envelope) {
          // Legacy plain digest / malformed — fail closed (cannot safely correlate).
          fail(500, 'PlatformOperationFailed', 'platform.operation_failed');
        }
        if (envelope.digest !== digest) {
          fail(409, 'IdempotencyConflict', 'platform.idempotency_conflict');
        }

        const recovery = await loadAssistedRecoveryById(tx, envelope.recoveryRequestId);
        if (!recovery || recovery.companyId !== companyId) {
          fail(500, 'PlatformOperationFailed', 'platform.operation_failed');
        }

        const now = clock();
        if (recovery.deliveryStatus === 'dispatched') {
          return { kind: 'replay_dispatched' as const };
        }

        if (recovery.deliveryStatus === 'pending') {
          const ageMs = now.getTime() - recovery.createdAt.getTime();
          if (ageMs < stalePendingMs) {
            return { kind: 'replay_pending' as const };
          }
        } else if (recovery.deliveryStatus !== 'failed') {
          fail(500, 'PlatformOperationFailed', 'platform.operation_failed');
        }

        // failed or stale pending — this TX owns replacement issuance.
        const owner = await resolveActivePrimaryOwnerForCompany(prisma, companyId);
        if (!owner) {
          fail(403, 'PlatformOwnerRecoveryDenied', 'platform.owner_recovery_denied');
        }

        // Replacement attempts consume the same actor/company/target/global limits
        // as first issuance — before minting a token.
        if (rateLimiter) {
          await enforcePlatformOwnerRecoveryRateLimits(rateLimiter, {
            actorPrincipalId: principal.id,
            companyId: owner.companyId,
            ownerUserId: owner.userId,
          });
        } else if (isProduction) {
          fail(503, 'ServiceUnavailable', 'platform.owner_recovery_unavailable');
        }

        const issued = await recoveryService.issueInTransaction(tx, {
          principalDomain: 'company_primary_owner',
          principalId: owner.userId,
          companyId: owner.companyId,
          purpose: 'password_reset',
          initiatedBy: 'platform_operator',
          initiatorPrincipalId: principal.id,
          deliveryChannel: 'email',
          requestId,
          sourceBucketHash,
          actorType: 'platform_owner',
          actorId: principal.id,
        });

        if (!issued.deliverySecret) {
          fail(500, 'PlatformOperationFailed', 'platform.operation_failed');
        }

        await tx.platformIdempotencyKey.update({
          where: { principalId_key: { principalId: principal.id, key: key.data } },
          data: {
            requestHash: encodeOwnerRecoveryIdempotencyHash(digest, issued.recoveryRequestId),
          },
        });

        await writePlatformAudit(tx as PrismaClient, {
          principalId: principal.id,
          action: 'platform.companies.owner_recovery.reissue',
          targetCompanyId: owner.companyId,
          details: {
            companyId: owner.companyId,
            reasonCategory: parsed.data.reasonCategory,
            approvalReference,
            recoveryRequestRef: issued.recoveryRequestId,
            previousRecoveryRequestRef: recovery.id,
            requestId,
            status: 'pending',
          },
        });

        return {
          kind: 'deliver_replacement' as const,
          recoveryRequestId: issued.recoveryRequestId,
          deliverySecret: issued.deliverySecret,
          expiresAt: issued.expiresAt,
          recipientRef: owner.recipientRef,
        };
      });

      if (outcome.kind === 'replay_dispatched') {
        return res.status(202).json({
          status: 'owner_recovery_dispatched',
          companyId,
          requestId,
        });
      }

      if (outcome.kind === 'replay_pending') {
        return res.status(202).json({
          status: 'owner_recovery_pending',
          companyId,
          requestId,
        });
      }

      // deliver_new | deliver_replacement — non-null secret only.
      const deliveryStatus = await performAssistedDelivery({
        adapter: deliveryAdapter,
        service: recoveryService,
        recoveryRequestId: outcome.recoveryRequestId,
        deliverySecret: outcome.deliverySecret,
        expiresAt: outcome.expiresAt,
        recipientRef: outcome.recipientRef,
        companyId,
        requestId,
        actorId: principal.id,
        timeoutMs: deliveryTimeoutMs,
      });

      if (deliveryStatus === 'pending_timeout') {
        // Truthful pending only — no false dispatched/failed delivery Audit.
        // Informational (no terminal status transition); kept outside finalization tx.
        await writePlatformAudit(prisma, {
          principalId: principal.id,
          action: 'platform.companies.owner_recovery.delivery',
          targetCompanyId: companyId,
          details: {
            companyId,
            recoveryRequestRef: outcome.recoveryRequestId,
            requestId,
            status: 'pending',
            reason: 'delivery_wait_budget_exceeded',
          },
        });
        return res.status(202).json({
          status: 'owner_recovery_pending',
          companyId,
          requestId,
        });
      }

      if (deliveryStatus === 'status_persistence_failed') {
        // External adapter result is known but durable status/final audit could not commit.
        // Do not claim dispatched/failed; do not reissue in this request.
        return res.status(500).json({
          code: 'PlatformOperationFailed',
          messageKey: 'platform.operation_failed',
          requestId,
        });
      }

      // Terminal status + E1 audit + Platform final audit already committed atomically.

      if (deliveryStatus !== 'dispatched') {
        return res.status(503).json({
          code: 'ServiceUnavailable',
          messageKey: 'platform.owner_recovery_delivery_failed',
          requestId,
        });
      }

      return res.status(202).json({
        status: 'owner_recovery_dispatched',
        companyId,
        requestId,
      });
    }),
  );
}
