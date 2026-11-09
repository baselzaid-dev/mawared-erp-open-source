/**
 * Auth-plane completion for an already-issued break-glass package.
 * Does NOT execute or authorize break-glass — consumes package + sets permanent password only.
 */

import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { assertNewPasswordPolicy, hashPassword } from '../credentialSecrets';
import {
  CredentialRecoveryService,
  PostgresRecoveryTargetStore,
} from '../credentialRecovery';
import {
  RECOVERY_ENVIRONMENT_BINDING_ENV,
  RECOVERY_TOKEN_PEPPER_ENV,
  assertRecoveryCryptoConfig,
  resolveEnvironmentBinding,
} from '../credentialRecovery/tokenCrypto';
import { writePlatformAudit } from '../platformAuth';

const PACKAGE_MIN = 40;
const PACKAGE_MAX = 256;
const PACKAGE_RE = /^[A-Za-z0-9_-]+$/;

const completeBodySchema = z
  .object({
    recoveryPackage: z.string().min(PACKAGE_MIN).max(PACKAGE_MAX).regex(PACKAGE_RE),
    newPassword: z.string().min(1).max(512),
  })
  .strict();

class BreakGlassCompleteHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

const fail = (status: number, code: string, messageKey: string): never => {
  throw new BreakGlassCompleteHttpError(status, code, messageKey);
};

export const PLATFORM_BREAK_GLASS_COMPLETE_STATUS = 'break_glass_password_established' as const;
export const PLATFORM_BREAK_GLASS_INVALID_MESSAGE_KEY =
  'platform.recovery.invalid_or_expired' as const;

export interface BreakGlassCompletionDeps {
  app: Express;
  prisma: PrismaClient;
  recoveryService?: CredentialRecoveryService | null;
  limiter: RequestHandler;
  isProduction?: boolean;
}

export function createBreakGlassCompletionRecoveryService(
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

/**
 * Consume a live break-glass package and set a permanent password.
 * No session is issued. MFA remains unenrolled until normal enrollment.
 */
export async function completeBreakGlassPassword(input: {
  service: CredentialRecoveryService;
  prisma: PrismaClient;
  recoveryPackage: string;
  newPassword: string;
  requestId: string;
}): Promise<void> {
  const policyError = assertNewPasswordPolicy(input.newPassword);
  if (policyError) {
    fail(400, 'InvalidRequest', PLATFORM_BREAK_GLASS_INVALID_MESSAGE_KEY);
  }

  const passwordHash = await hashPassword(input.newPassword);
  const result = await input.service.withValidRecoveryRequest(
    {
      rawToken: input.recoveryPackage,
      principalDomain: 'platform_principal',
      purpose: 'break_glass_recovery',
      requestId: input.requestId,
      actorType: 'anonymous',
      actorId: null,
    },
    async (ctx, tx) => {
      if (ctx.companyId != null) {
        throw new Error('break_glass_company_must_be_null');
      }

      const principal = await tx.platformPrincipal.findFirst({
        where: { id: ctx.principalId, status: 'active' },
        select: {
          id: true,
          status: true,
          credentialVersion: true,
        },
      });
      if (!principal || principal.status !== 'active') {
        throw new Error('break_glass_principal_inactive');
      }
      // Execute already incremented CV; package row snapshots the post-execute version.
      if (principal.credentialVersion !== ctx.credentialVersionAtIssuance) {
        throw new Error('break_glass_credential_version_mismatch');
      }

      const updated = await tx.platformPrincipal.updateMany({
        where: {
          id: ctx.principalId,
          status: 'active',
          credentialVersion: ctx.credentialVersionAtIssuance,
        },
        data: { password: passwordHash },
      });
      if (updated.count !== 1) {
        throw new Error('break_glass_password_update_failed');
      }

      const mfa = await tx.platformMfaCredential.findUnique({
        where: { principalId: ctx.principalId },
        select: { state: true, enrolledAt: true, secretCiphertext: true },
      });
      if (mfa?.state === 'enrolled' || mfa?.secretCiphertext) {
        throw new Error('break_glass_mfa_must_remain_unenrolled');
      }

      await writePlatformAudit(tx as unknown as PrismaClient, {
        principalId: ctx.principalId,
        action: 'platform.auth.break_glass.password_established',
        details: {
          principalId: ctx.principalId,
          credentialVersion: principal.credentialVersion,
          recoveryRequestId: ctx.recoveryRequestId,
          requestId: input.requestId,
          recoveryPackageIssued: false,
          mfaInvalidated: true,
          status: 'success',
        },
      });

      return { ok: true as const };
    },
  );

  if (!result.ok) {
    fail(400, 'InvalidRequest', PLATFORM_BREAK_GLASS_INVALID_MESSAGE_KEY);
  }
}

export function registerBreakGlassCompletionRoutes(
  deps: BreakGlassCompletionDeps,
): void {
  const resolvedService = deps.recoveryService === undefined
    ? createBreakGlassCompletionRecoveryService(deps.prisma)
    : deps.recoveryService;

  const route = (
    handler: (req: Request, res: Response) => Promise<unknown>,
  ): RequestHandler => async (request, response, next) => {
    try {
      await handler(request, response);
    } catch (error) {
      if (error instanceof BreakGlassCompleteHttpError) {
        const requestId = (request as { requestId?: string }).requestId
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

  deps.app.post(
    '/api/platform/v1/auth/recovery/break-glass/complete',
    deps.limiter,
    route(async (req, res) => {
      const requestId = (req as { requestId?: string }).requestId
        ?? (res.locals as { requestId?: string }).requestId
        ?? 'unknown';

      if (!resolvedService) {
        if (deps.isProduction) {
          fail(400, 'InvalidRequest', PLATFORM_BREAK_GLASS_INVALID_MESSAGE_KEY);
        }
        fail(400, 'InvalidRequest', PLATFORM_BREAK_GLASS_INVALID_MESSAGE_KEY);
      }

      const parsed = completeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        fail(400, 'InvalidRequest', PLATFORM_BREAK_GLASS_INVALID_MESSAGE_KEY);
      }

      await completeBreakGlassPassword({
        service: resolvedService,
        prisma: deps.prisma,
        recoveryPackage: parsed.data.recoveryPackage,
        newPassword: parsed.data.newPassword,
        requestId,
      });

      return res.status(200).json({
        status: PLATFORM_BREAK_GLASS_COMPLETE_STATUS,
        requestId,
      });
    }),
  );
}
