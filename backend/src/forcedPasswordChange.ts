import type express from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import {
  assertNewPasswordPolicy,
  hashPassword,
  verifyPassword,
} from './credentialSecrets';

/** RC2 forced-change gate fields loaded on every authenticated request. */
export type UserCredentialGate = {
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: Date | null;
  accountStatus: string;
  credentialVersion: number;
  passwordChangedAt: Date | null;
};

export const changeTemporaryPasswordSchema = z.strictObject({
  temporaryPassword: z.string().min(1, 'كلمة المرور المؤقتة مطلوبة').max(256),
  newPassword: z.string().min(1, 'كلمة المرور الجديدة مطلوبة').max(256),
  confirmPassword: z.string().min(1, 'تأكيد كلمة المرور مطلوب').max(256),
});

type ChangeTemporaryPasswordBody = z.output<typeof changeTemporaryPasswordSchema>;

type PrismaLike = Pick<PrismaClient, 'user' | 'refreshToken' | '$transaction'>;

interface AuthUser {
  id: string;
  companyId: string;
}

interface ForcedPasswordChangeRoutesDeps {
  app: express.Express;
  prisma: PrismaClient;
  requireAuth: express.RequestHandler;
}

const ALLOWED_FORCED_CHANGE_PATHS: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/v2/auth/change-temporary-password' },
  { method: 'POST', path: '/api/v2/auth/logout' },
  { method: 'POST', path: '/api/auth/logout' },
  { method: 'POST', path: '/api/v2/auth/refresh' },
  { method: 'POST', path: '/api/auth/refresh' },
  { method: 'GET', path: '/api/auth/me' },
  { method: 'GET', path: '/api/v2/auth/me' },
];

/**
 * Coordinator: when `mustChangePassword=true`, only these routes may pass `requireAuth`.
 * Everything else must return 403 PasswordChangeRequired.
 */
export function isForcedChangeAllowedPath(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = path.split('?')[0] ?? path;
  return ALLOWED_FORCED_CHANGE_PATHS.some(
    (entry) => entry.method === normalizedMethod && entry.path === normalizedPath,
  );
}

export function listForcedChangeAllowedPaths(): ReadonlyArray<{ method: string; path: string }> {
  return ALLOWED_FORCED_CHANGE_PATHS;
}

export async function loadUserCredentialGate(
  prisma: Pick<PrismaClient, 'user'>,
  userId: string,
  companyId: string,
): Promise<UserCredentialGate | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, companyId },
    select: {
      mustChangePassword: true,
      temporaryPasswordExpiresAt: true,
      accountStatus: true,
      credentialVersion: true,
      passwordChangedAt: true,
    },
  });
  if (!user) return null;
  return {
    mustChangePassword: user.mustChangePassword,
    temporaryPasswordExpiresAt: user.temporaryPasswordExpiresAt,
    accountStatus: user.accountStatus,
    credentialVersion: Number.isInteger(user.credentialVersion) && user.credentialVersion >= 1
      ? user.credentialVersion
      : 1,
    passwordChangedAt: user.passwordChangedAt ?? null,
  };
}

/** Safe `/me` shaping when the client needs forced-change state. */
export function shapeMeCredentialFields(gate: UserCredentialGate): {
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: string | null;
} {
  return {
    mustChangePassword: gate.mustChangePassword,
    temporaryPasswordExpiresAt: gate.temporaryPasswordExpiresAt?.toISOString() ?? null,
  };
}

export function isTemporaryPasswordExpired(
  gate: Pick<UserCredentialGate, 'mustChangePassword' | 'temporaryPasswordExpiresAt'>,
  now: Date = new Date(),
): boolean {
  if (!gate.mustChangePassword) return false;
  if (!gate.temporaryPasswordExpiresAt) return false;
  return gate.temporaryPasswordExpiresAt.getTime() <= now.getTime();
}

/**
 * Coordinator note — login and refresh must reject accounts where the temporary
 * password TTL elapsed while `mustChangePassword` is still true. Those users
 * cannot complete forced change and must receive a new credential from an admin.
 */
export function isCredentialGateLoginBlocked(gate: UserCredentialGate): boolean {
  return gate.mustChangePassword && isTemporaryPasswordExpired(gate);
}

/**
 * Fail-closed access-token freshness:
 * - Prefer credentialVersion claim when present (E2+): exact equality.
 * - Legacy tokens without credentialVersion are fenced by iat vs passwordChangedAt.
 * - Same-second (and earlier) legacy tokens are stale — no positive clock-skew grace.
 */
export function isAccessTokenCredentialStale(
  token: {
    credentialVersion?: unknown;
    iat?: unknown;
  },
  gate: Pick<UserCredentialGate, 'credentialVersion' | 'passwordChangedAt'>,
): boolean {
  const currentVersion = Number.isInteger(gate.credentialVersion) && gate.credentialVersion >= 1
    ? gate.credentialVersion
    : 1;
  if (typeof token.credentialVersion === 'number' && Number.isInteger(token.credentialVersion)) {
    return token.credentialVersion !== currentVersion;
  }

  // Legacy path (no credentialVersion claim).
  if (!gate.passwordChangedAt) {
    // Documented RC1 compatibility: no password change recorded → not stale by timestamp.
    return false;
  }

  if (
    typeof token.iat !== 'number'
    || !Number.isFinite(token.iat)
    || !Number.isInteger(token.iat)
  ) {
    return true;
  }

  // Token issued before OR during the same whole second as passwordChangedAt is stale.
  const changedAtSecond = Math.floor(gate.passwordChangedAt.getTime() / 1000);
  return token.iat <= changedAtSecond;
}

export function respondPasswordChangeRequired(res: express.Response): express.Response {
  return res.status(403).json({
    code: 'PasswordChangeRequired',
    messageKey: 'auth.password_change_required',
  });
}

class ForcedPasswordChangeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
    readonly fieldErrors?: Array<{ field: string; messageKey: string }>,
  ) {
    super(messageKey);
  }
}

const fail = (
  status: number,
  code: string,
  messageKey: string,
  fieldErrors?: Array<{ field: string; messageKey: string }>,
): never => {
  throw new ForcedPasswordChangeError(status, code, messageKey, fieldErrors);
};

const route =
  (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  async (req: express.Request, res: express.Response) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof ForcedPasswordChangeError) {
        const requestId = (req as express.Request & { requestId?: string }).requestId
          ?? (res.locals as { requestId?: string }).requestId;
        return res.status(error.status).json({
          code: error.code,
          messageKey: error.messageKey,
          ...(requestId ? { requestId } : {}),
          ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
        });
      }
      console.error('[forced-password-change] unexpected error');
      return res.status(500).json({
        code: 'InternalError',
        messageKey: 'common.internal_error',
      });
    }
  };

function parseBody(body: unknown): ChangeTemporaryPasswordBody {
  const parsed = changeTemporaryPasswordSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || 'body';
    fail(400, 'ValidationError', 'validation.invalid_body', [{
      field,
      messageKey: issue?.code === 'unrecognized_keys'
        ? 'validation.unrecognized_fields'
        : 'validation.invalid_field',
    }]);
  }
  return parsed.data;
}

function assertChangeBodyRules(body: ChangeTemporaryPasswordBody): void {
  if (body.newPassword !== body.confirmPassword) {
    fail(400, 'ValidationError', 'password.confirm_mismatch', [{
      field: 'confirmPassword',
      messageKey: 'password.confirm_mismatch',
    }]);
  }
  const policyError = assertNewPasswordPolicy(body.newPassword);
  if (policyError) {
    fail(400, 'ValidationError', policyError, [{
      field: 'newPassword',
      messageKey: policyError,
    }]);
  }
  if (body.newPassword === body.temporaryPassword) {
    fail(400, 'ValidationError', 'password.same_as_temporary', [{
      field: 'newPassword',
      messageKey: 'password.same_as_temporary',
    }]);
  }
}

export async function executeForcedPasswordChange(
  prisma: PrismaLike,
  user: AuthUser,
  body: ChangeTemporaryPasswordBody,
): Promise<{ changedAt: string; sessionsRevoked: number }> {
  parseBody(body);
  assertChangeBodyRules(body);

  return prisma.$transaction(async (tx) => {
    const row = await tx.user.findFirst({
      where: { id: user.id, companyId: user.companyId },
      select: {
        id: true,
        password: true,
        mustChangePassword: true,
        temporaryPasswordExpiresAt: true,
        credentialVersion: true,
        accountStatus: true,
        passwordChangedAt: true,
      },
    });
    if (!row) fail(401, 'Unauthorized', 'auth.unauthorized');
    if (row.accountStatus !== 'active') {
      fail(401, 'Unauthorized', 'auth.unauthorized');
    }

    const gate: UserCredentialGate = {
      mustChangePassword: row.mustChangePassword,
      temporaryPasswordExpiresAt: row.temporaryPasswordExpiresAt,
      accountStatus: row.accountStatus,
      credentialVersion: row.credentialVersion,
      passwordChangedAt: row.passwordChangedAt,
    };

    if (!gate.mustChangePassword) {
      fail(409, 'PasswordChangeNotRequired', 'auth.password_change_not_required');
    }
    if (!gate.temporaryPasswordExpiresAt || isTemporaryPasswordExpired(gate)) {
      fail(409, 'TemporaryPasswordExpired', 'auth.temporary_password_expired');
    }

    const temporaryMatches = await verifyPassword(body.temporaryPassword, row.password);
    if (!temporaryMatches) {
      fail(401, 'InvalidTemporaryPassword', 'auth.temporary_password_invalid');
    }

    const changedAt = new Date();
    const passwordHash = await hashPassword(body.newPassword);
    const expectedCredentialVersion = row.credentialVersion;

    const updatedCount = await tx.user.updateMany({
      where: {
        id: user.id,
        companyId: user.companyId,
        accountStatus: 'active',
        mustChangePassword: true,
        credentialVersion: expectedCredentialVersion,
        temporaryPasswordExpiresAt: { gt: changedAt },
      },
      data: {
        password: passwordHash,
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
        passwordChangedAt: changedAt,
        credentialVersion: { increment: 1 },
        authorizationVersion: { increment: 1 },
      },
    });
    if (updatedCount.count !== 1) {
      fail(409, 'CredentialConflict', 'auth.credential_conflict');
    }

    const updated = await tx.user.findFirst({
      where: { id: user.id, companyId: user.companyId },
      select: { credentialVersion: true, authorizationVersion: true },
    });
    if (!updated) fail(500, 'InternalError', 'common.internal_error');

    const revoked = await tx.refreshToken.updateMany({
      where: {
        userId: user.id,
        companyId: user.companyId,
        revokedAt: null,
      },
      data: {
        revokedAt: changedAt,
        revokedReason: 'password_changed',
      },
    });

    await writeAuditRequired(tx as Pick<PrismaClient, 'auditLog'>, {
      companyId: user.companyId,
      userId: user.id,
      action: 'auth.password.change_forced',
      details: {
        credentialVersion: updated.credentialVersion,
        previousCredentialVersion: expectedCredentialVersion,
        authorizationVersion: updated.authorizationVersion,
        sessionsRevokedCount: revoked.count,
        status: 'success',
      },
    });

    return {
      changedAt: changedAt.toISOString(),
      sessionsRevoked: revoked.count,
    };
  });
}

export function registerForcedPasswordChangeRoutes({
  app,
  prisma,
  requireAuth,
}: ForcedPasswordChangeRoutesDeps): void {
  app.post(
    '/api/v2/auth/change-temporary-password',
    requireAuth,
    route(async (req, res) => {
      const authUser = (req as express.Request & { user?: AuthUser }).user;
      if (!authUser?.id || !authUser.companyId) {
        fail(401, 'Unauthorized', 'auth.unauthorized');
      }
      const body = parseBody(req.body);
      const result = await executeForcedPasswordChange(prisma, authUser, body);
      return res.json(result);
    }),
  );
}
