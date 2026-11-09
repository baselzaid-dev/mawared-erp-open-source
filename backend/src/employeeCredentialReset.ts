import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import {
  generateTemporaryPassword,
  hashPassword,
  shapeOneTimeCredentialDto,
  temporaryPasswordExpiresAt,
  type OneTimeCredentialDto,
} from './credentialSecrets';
import {
  DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
  InMemoryRecoveryRateLimitStore,
  PostgresRecoveryRateLimitStore,
  RecoveryRateLimiter,
  type RecoveryRateLimiter as RecoveryRateLimiterType,
} from './credentialRecovery';
import { RECOVERY_RATE_LIMIT_PEPPER_ENV } from './credentialRecovery/tokenCrypto';
import {
  CredentialResetAuthError,
  acquireEmployeeCredentialResetLock,
  actorHasCredentialResetPermission,
  authorizeEmployeeCredentialResetInTransaction,
} from './employeeCredentialResetAuth';
import { loadAuthorizationContext } from './authorization';
import { PERMISSIONS } from './permissions';

interface CredentialResetUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface CredentialResetRequest extends Request {
  user?: CredentialResetUser;
  requestId?: string;
}

interface CredentialResetRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkPermission: (permission: string) => RequestHandler;
  /** Optional injectable limiter (tests). Production wires via createEmployeeAdminResetRateLimiter. */
  rateLimiter?: RecoveryRateLimiterType | null;
}

class CredentialResetError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

/** Bounded machine-readable administrative reset reasons — no free text. */
export const CREDENTIAL_RESET_REASONS = [
  'forgotten_password',
  'suspected_compromise',
  'administrative_rotation',
  'access_recovery',
] as const;

export type CredentialResetReason = (typeof CREDENTIAL_RESET_REASONS)[number];

export const CREDENTIAL_RESET_REASON_MESSAGE_KEYS: Readonly<
  Record<CredentialResetReason, string>
> = {
  forgotten_password: 'credentials.reset_reason.forgotten_password',
  suspected_compromise: 'credentials.reset_reason.suspected_compromise',
  administrative_rotation: 'credentials.reset_reason.administrative_rotation',
  access_recovery: 'credentials.reset_reason.access_recovery',
};

const reasonSchema = z.enum(CREDENTIAL_RESET_REASONS);
const credentialVersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const resetBodySchema = z.object({
  reason: reasonSchema,
  expectedCredentialVersion: credentialVersionSchema,
}).strict();

const fail = (
  status: number,
  code: string,
  messageKey: string,
): never => {
  throw new CredentialResetError(status, code, messageKey);
};

const route = (
  handler: (req: CredentialResetRequest, res: Response) => Promise<unknown>,
): RequestHandler => async (request, response, next) => {
  try {
    await handler(request as CredentialResetRequest, response);
  } catch (error) {
    if (error instanceof CredentialResetError || error instanceof CredentialResetAuthError) {
      const requestId = (request as CredentialResetRequest).requestId
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

const actorFrom = (req: CredentialResetRequest): CredentialResetUser => {
  if (!req.user?.id || !req.user.companyId) {
    fail(401, 'Unauthorized', 'credentials.unauthorized');
  }
  return req.user!;
};

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail(400, 'InvalidRequest', 'credentials.invalid_request');
  return parsed.data;
};

const notifyCredentialReset = async (
  prisma: PrismaClient,
  companyId: string,
  userId: string,
) => {
  await prisma.notification.create({
    data: {
      companyId,
      userId,
      title: 'تم إعادة تعيين كلمة المرور',
      message: 'قام مسؤول بإعادة تعيين كلمة مرور حسابك. استخدم كلمة المرور المؤقتة الجديدة عند تسجيل الدخول.',
      category: 'security',
      // Navigation metadata only — never temporary passwords, tokens, or secrets.
      routeKey: 'auth.change_password',
      resourceType: 'security',
    },
  });
};

async function enforceEmployeeAdminResetRateLimits(
  limiter: RecoveryRateLimiterType,
  input: {
    actorUserId: string;
    companyId: string;
    employeeId: string;
  },
): Promise<void> {
  const surface = 'employee_admin_reset' as const;
  const checks = [
    { dimension: 'actor' as const, rawKey: `actor:${input.actorUserId}` },
    { dimension: 'company' as const, rawKey: `company:${input.companyId}` },
    { dimension: 'target' as const, rawKey: `target:${input.employeeId}` },
    { dimension: 'global' as const, rawKey: 'global:employee_admin_reset' },
  ];
  for (const check of checks) {
    const decision = await limiter.check({
      surface,
      dimension: check.dimension,
      rawKey: check.rawKey,
    });
    if (!decision.allowed) {
      fail(429, 'RateLimited', 'credentials.reset_rate_limited');
    }
  }
}

/**
 * Build the E1-backed limiter for authenticated employee admin reset.
 * Returns null when the dedicated pepper is absent (caller decides fail-closed).
 */
export function createEmployeeAdminResetRateLimiter(
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

export async function resetEmployeeCredential(input: {
  prisma: PrismaClient;
  actor: CredentialResetUser;
  employeeId: string;
  reason: CredentialResetReason;
  expectedCredentialVersion: number;
  rateLimiter?: RecoveryRateLimiterType | null;
  requestId?: string;
}): Promise<OneTimeCredentialDto> {
  const employeeId = String(input.employeeId ?? '').trim();
  if (!employeeId) fail(400, 'InvalidRequest', 'credentials.invalid_request');

  if (input.rateLimiter) {
    await enforceEmployeeAdminResetRateLimits(input.rateLimiter, {
      actorUserId: input.actor.id,
      companyId: input.actor.companyId,
      employeeId,
    });
  } else if (process.env.NODE_ENV === 'production') {
    fail(503, 'ServiceUnavailable', 'credentials.reset_unavailable');
  }

  // Secret created only after rate-limit pass; revealed only after commit.
  let pendingSecret: ReturnType<typeof generateTemporaryPassword> | null = null;
  let expiresAt: Date | null = null;
  let nextCredentialVersion = 0;

  await input.prisma.$transaction(async (tx) => {
    await acquireEmployeeCredentialResetLock(tx, input.actor.companyId, employeeId);

    const authorized = await authorizeEmployeeCredentialResetInTransaction(tx, {
      actorUserId: input.actor.id,
      actorCompanyId: input.actor.companyId,
      employeeId,
    });

    // Final actor authorizationVersion fence immediately before credential mutation.
    const actorStillCurrent = await tx.user.findFirst({
      where: {
        id: input.actor.id,
        companyId: input.actor.companyId,
        authorizationVersion: authorized.actorAuthorizationVersion,
        accountStatus: 'active',
      },
      select: { id: true },
    });
    if (!actorStillCurrent) {
      fail(403, 'Forbidden', 'credentials.reset_forbidden');
    }

    // Bounded re-check under held locks: some Role JSON mutations historically omit
    // an authorizationVersion bump. Never trust the earlier context alone.
    const freshActorContext = await loadAuthorizationContext(tx, {
      userId: input.actor.id,
      companyId: input.actor.companyId,
    });
    if (
      !freshActorContext
      || freshActorContext.authorizationVersion !== authorized.actorAuthorizationVersion
      || !actorHasCredentialResetPermission(freshActorContext)
    ) {
      fail(403, 'Forbidden', 'credentials.reset_forbidden');
    }

    if (authorized.credentialVersion !== input.expectedCredentialVersion) {
      fail(412, 'StaleCredentialVersion', 'credentials.stale_credential_version');
    }

    pendingSecret = generateTemporaryPassword();
    const passwordHash = await hashPassword(pendingSecret.reveal());
    expiresAt = temporaryPasswordExpiresAt();
    nextCredentialVersion = input.expectedCredentialVersion + 1;
    const changedAt = new Date();

    const updated = await tx.user.updateMany({
      where: {
        id: authorized.targetUserId,
        companyId: input.actor.companyId,
        accountStatus: 'active',
        credentialVersion: input.expectedCredentialVersion,
      },
      data: {
        password: passwordHash,
        mustChangePassword: true,
        temporaryPasswordExpiresAt: expiresAt,
        passwordChangedAt: changedAt,
        credentialVersion: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      fail(412, 'StaleCredentialVersion', 'credentials.stale_credential_version');
    }

    const revoked = await tx.refreshToken.updateMany({
      where: {
        userId: authorized.targetUserId,
        companyId: input.actor.companyId,
        revokedAt: null,
      },
      data: {
        revokedAt: changedAt,
        revokedReason: 'credential_reset',
      },
    });

    await writeAuditRequired(tx, {
      companyId: input.actor.companyId,
      userId: input.actor.id,
      action: 'employee.credentials.reset',
      details: {
        employeeId: authorized.employeeId,
        targetUserId: authorized.targetUserId,
        resetReason: input.reason,
        credentialVersion: nextCredentialVersion,
        previousCredentialVersion: input.expectedCredentialVersion,
        sessionsRevokedCount: revoked.count,
        status: 'success',
        ...(input.requestId ? { requestId: input.requestId } : {}),
      },
    });

    await notifyCredentialReset(tx as PrismaClient, input.actor.companyId, authorized.targetUserId);
  });

  if (!pendingSecret || !expiresAt) {
    fail(500, 'InternalError', 'credentials.reset_failed');
  }

  return shapeOneTimeCredentialDto(pendingSecret, nextCredentialVersion, expiresAt);
}

export function registerEmployeeCredentialResetRoutes({
  app,
  prisma,
  requireAuth,
  checkPermission,
  rateLimiter = null,
}: CredentialResetRouteDeps): void {
  const resolvedLimiter = rateLimiter === undefined
    ? createEmployeeAdminResetRateLimiter(
      prisma,
      process.env[RECOVERY_RATE_LIMIT_PEPPER_ENV],
    )
    : rateLimiter;

  app.post(
    '/api/v2/employees/:id/credentials/reset',
    requireAuth,
    checkPermission(PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET),
    route(async (req, res) => {
      const actor = actorFrom(req);
      const body = parseBody(resetBodySchema, req.body);
      const requestId = req.requestId
        ?? (res.locals as { requestId?: string }).requestId;
      const dto = await resetEmployeeCredential({
        prisma,
        actor,
        employeeId: req.params.id,
        reason: body.reason,
        expectedCredentialVersion: body.expectedCredentialVersion,
        rateLimiter: resolvedLimiter,
        requestId,
      });
      return res.status(200).json(dto);
    }),
  );
}

export {
  resetBodySchema,
};
