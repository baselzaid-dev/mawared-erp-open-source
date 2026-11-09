import type express from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { loadAuthorizationContext, parseRolePermissions } from './authorization';
import {
  assertMfaEncryptionKey,
  createMfaChallenge,
  decryptMfaSecret,
  encryptMfaSecret,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCodes,
  hashMfaChallenge,
  matchingBackupCodeIndex,
  MFA_LOCKOUT_MS,
  MFA_MAX_CHALLENGE_ATTEMPTS,
  MfaConfigurationError,
  MfaRateLimitError,
  parseBackupCodeHashes,
  totpUri,
  verifyTotp,
} from './mfa';

type MfaPurpose = 'enroll' | 'login';

interface MfaLoginUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  email: string;
  name: string;
  roleId: string;
  authorizationVersion: number;
  credentialVersion: number;
  mustChangePassword: boolean;
  role: { id: string; name: string; permissions: string };
  company: { id: string; code: string; name: string };
}

interface MfaRouteDeps {
  app: express.Express;
  prisma: PrismaClient;
  limiter: express.RequestHandler;
  encryptionKey?: string;
  issueTokens: (
    input: {
      id: string;
      companyId: string;
      employeeId: string | null;
      permissions: string[];
      authorizationVersion: number;
      credentialVersion: number;
    },
    session?: { deviceLabel?: string; platform?: string },
  ) => Promise<{ accessToken: string; refreshToken: string }>;
}

class MfaRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

const fail = (status: number, code: string, messageKey: string): never => {
  throw new MfaRouteError(status, code, messageKey);
};

const challengeSchema = z.object({
  challengeToken: z.string().trim().min(40).max(200),
}).strict();

const codeSchema = z.string().trim().min(6).max(32);
const verifySchema = challengeSchema.extend({
  code: codeSchema,
  deviceLabel: z.string().trim().min(1).max(120).optional(),
  platform: z.string().trim().min(1).max(32).regex(/^[a-z0-9_-]+$/).optional(),
}).strict();

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail(400, 'InvalidRequest', 'auth.mfa_invalid_request');
  return parsed.data;
};

const shapeUser = (user: MfaLoginUser, permissions: string[]) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  companyId: user.companyId,
  employeeId: user.employeeId,
  roleId: user.role.id,
  roleName: user.role.name,
  permissions,
  mustChangePassword: Boolean(user.mustChangePassword),
  mfaRequired: true,
  mfaEnrolled: true,
});

const loadMfaUser = async (
  prisma: PrismaClient,
  userId: string,
  companyId: string,
): Promise<MfaLoginUser> => {
  const user = await prisma.user.findFirst({
    where: { id: userId, companyId, accountStatus: 'active' },
    include: { role: true, company: true },
  });
  if (!user) fail(401, 'MfaChallengeInvalid', 'auth.mfa_invalid_challenge');
  return user as MfaLoginUser;
};

const effectivePermissions = async (
  prisma: PrismaClient,
  user: MfaLoginUser,
): Promise<string[]> => {
  const context = await loadAuthorizationContext(prisma, {
    userId: user.id,
    companyId: user.companyId,
  });
  return context?.flatPermissions ?? parseRolePermissions(user.role.permissions);
};

const challengeResponse = (
  purpose: MfaPurpose,
  token: string,
  expiresAt: Date,
) => ({
  mfaRequired: true,
  enrollmentRequired: purpose === 'enroll',
  challengeToken: token,
  expiresAt: expiresAt.toISOString(),
});

export async function beginUserMfaChallenge(input: {
  prisma: PrismaClient;
  user: MfaLoginUser;
  encryptionKey?: string;
}): Promise<ReturnType<typeof challengeResponse>> {
  assertMfaEncryptionKey(input.encryptionKey);
  const existing = await input.prisma.userMfaCredential.findUnique({
    where: { userId: input.user.id },
  });
  if (existing?.lockedUntil && existing.lockedUntil.getTime() > Date.now()) {
    throw new MfaRateLimitError();
  }
  const lockExpired = existing?.lockedUntil != null &&
    existing.lockedUntil.getTime() <= Date.now();
  const purpose: MfaPurpose = existing?.state === 'enrolled' ? 'login' : 'enroll';
  const challenge = createMfaChallenge();
  await input.prisma.userMfaCredential.upsert({
    where: { userId: input.user.id },
    create: {
      userId: input.user.id,
      companyId: input.user.companyId,
      state: 'pending',
      challengeTokenHash: challenge.tokenHash,
      challengePurpose: purpose,
      challengeExpiresAt: challenge.expiresAt,
      challengeAttempts: 0,
      ...(purpose === 'enroll' ? { pendingSecretCiphertext: null } : {}),
      ...(lockExpired ? { failedAttempts: 0, lockedUntil: null } : {}),
    },
    update: {
      challengeTokenHash: challenge.tokenHash,
      challengePurpose: purpose,
      challengeExpiresAt: challenge.expiresAt,
      challengeAttempts: 0,
      ...(purpose === 'enroll' ? { pendingSecretCiphertext: null } : {}),
      ...(lockExpired ? { failedAttempts: 0, lockedUntil: null } : {}),
    },
  });
  return challengeResponse(purpose, challenge.token, challenge.expiresAt);
}

const challengeRow = async (
  client: any,
  challengeToken: string,
  purpose: MfaPurpose,
) => {
  const row = await client.userMfaCredential.findUnique({
    where: { challengeTokenHash: hashMfaChallenge(challengeToken) },
  });
  if (
    !row ||
    row.challengePurpose !== purpose ||
    !row.challengeExpiresAt ||
    row.challengeExpiresAt.getTime() <= Date.now() ||
    row.challengeAttempts >= MFA_MAX_CHALLENGE_ATTEMPTS
  ) {
    fail(401, 'MfaChallengeInvalid', 'auth.mfa_invalid_challenge');
  }
  return row;
};

const recordFailedAttempt = async (client: any, row: any): Promise<void> => {
  const attempts = row.challengeAttempts + 1;
  const failedAttempts = Math.min(
    Number(row.failedAttempts ?? 0) + 1,
    MFA_MAX_CHALLENGE_ATTEMPTS,
  );
  const locked = failedAttempts >= MFA_MAX_CHALLENGE_ATTEMPTS;
  await client.userMfaCredential.update({
    where: { userId: row.userId },
    data: {
      challengeAttempts: attempts,
      failedAttempts,
      ...(locked ? { lockedUntil: new Date(Date.now() + MFA_LOCKOUT_MS) } : {}),
      ...(attempts >= MFA_MAX_CHALLENGE_ATTEMPTS || locked
        ? {
          challengeTokenHash: null,
          challengePurpose: null,
          challengeExpiresAt: null,
        }
        : {}),
    },
  });
};

const tokenResponse = async (
  deps: MfaRouteDeps,
  userId: string,
  companyId: string,
  backupCodes?: string[],
  session?: { deviceLabel?: string; platform?: string },
) => {
  const user = await loadMfaUser(deps.prisma, userId, companyId);
  const permissions = await effectivePermissions(deps.prisma, user);
  const tokens = await deps.issueTokens({
    id: user.id,
    companyId: user.companyId,
    employeeId: user.employeeId,
    permissions,
    authorizationVersion: user.authorizationVersion,
    credentialVersion: user.credentialVersion ?? 1,
  }, session);
  return {
    ...tokens,
    user: shapeUser(user, permissions),
    company: user.company,
    mfaVerifiedAt: new Date().toISOString(),
    ...(backupCodes ? { backupCodes } : {}),
  };
};

export async function verifyEnrolledUserTotp(input: {
  prisma: PrismaClient;
  userId: string;
  companyId: string;
  code: string;
  encryptionKey?: string;
}): Promise<boolean> {
  assertMfaEncryptionKey(input.encryptionKey);
  return input.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "userId" FROM "UserMfaCredential"
      WHERE "userId" = ${input.userId} AND "companyId" = ${input.companyId}
      FOR UPDATE
    `;
    const credential = await tx.userMfaCredential.findUnique({
      where: { userId: input.userId },
    });
    if (!credential?.secretCiphertext || credential.state !== 'enrolled') return false;
    const secret = decryptMfaSecret(credential.secretCiphertext, input.encryptionKey);
    const verified = verifyTotp(secret, input.code);
    if (
      !verified.valid ||
      verified.timeStep == null ||
      (credential.lastUsedTimeStep != null &&
        verified.timeStep <= credential.lastUsedTimeStep)
    ) {
      return false;
    }
    await tx.userMfaCredential.update({
      where: { userId: input.userId },
      data: {
        lastUsedTimeStep: verified.timeStep,
        lastVerifiedAt: new Date(),
      },
    });
    return true;
  });
}

export function registerMfaRoutes(deps: MfaRouteDeps): void {
  const route = (
    handler: (req: express.Request, res: express.Response) => Promise<unknown>,
  ): express.RequestHandler => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof MfaRouteError) {
        return res.status(error.status).json({
          code: error.code,
          messageKey: error.messageKey,
        });
      }
      if (error instanceof MfaConfigurationError) {
        return res.status(503).json({
          code: 'MfaUnavailable',
          messageKey: 'auth.mfa_unavailable',
        });
      }
      if (error instanceof MfaRateLimitError) {
        return res.status(429).json({
          code: 'MfaRateLimited',
          messageKey: 'auth.mfa_rate_limited',
        });
      }
      return res.status(500).json({
        code: 'MfaFailed',
        messageKey: 'auth.mfa_failed',
      });
    }
  };

  deps.app.post('/api/v2/auth/mfa/enroll/start', deps.limiter, route(async (req, res) => {
    const body = parseBody(challengeSchema, req.body);
    assertMfaEncryptionKey(deps.encryptionKey);
    const row = await challengeRow(deps.prisma, body.challengeToken, 'enroll');
    if (row.state === 'enrolled') fail(409, 'MfaAlreadyEnrolled', 'auth.mfa_already_enrolled');
    let secret: string;
    if (row.pendingSecretCiphertext) {
      secret = decryptMfaSecret(row.pendingSecretCiphertext, deps.encryptionKey);
    } else {
      secret = generateTotpSecret();
      await deps.prisma.userMfaCredential.update({
        where: { userId: row.userId },
        data: { pendingSecretCiphertext: encryptMfaSecret(secret, deps.encryptionKey) },
      });
    }
    const user = await loadMfaUser(deps.prisma, row.userId, row.companyId);
    return res.json({
      manualSecret: secret,
      otpauthUri: totpUri(secret, `${user.company.code}:${user.email}`),
      expiresAt: row.challengeExpiresAt.toISOString(),
    });
  }));

  deps.app.post('/api/v2/auth/mfa/enroll/confirm', deps.limiter, route(async (req, res) => {
    const body = parseBody(verifySchema, req.body);
    assertMfaEncryptionKey(deps.encryptionKey);
    const result = await deps.prisma.$transaction(async (tx) => {
      const initial = await challengeRow(tx, body.challengeToken, 'enroll');
      await tx.$queryRaw`
        SELECT "userId" FROM "UserMfaCredential"
        WHERE "userId" = ${initial.userId} AND "companyId" = ${initial.companyId}
        FOR UPDATE
      `;
      const row = await challengeRow(tx, body.challengeToken, 'enroll');
      if (!row.pendingSecretCiphertext) {
        fail(409, 'MfaEnrollmentNotStarted', 'auth.mfa_enrollment_not_started');
      }
      const secret = decryptMfaSecret(row.pendingSecretCiphertext, deps.encryptionKey);
      const verified = verifyTotp(secret, body.code);
      if (!verified.valid || verified.timeStep == null) {
        await recordFailedAttempt(tx, row);
        return { kind: 'invalid' as const };
      }
      const backupCodes = generateBackupCodes();
      const backupCodeHashes = await hashBackupCodes(backupCodes);
      const now = new Date();
      await tx.userMfaCredential.update({
        where: { userId: row.userId },
        data: {
          state: 'enrolled',
          secretCiphertext: row.pendingSecretCiphertext,
          pendingSecretCiphertext: null,
          challengeTokenHash: null,
          challengePurpose: null,
          challengeExpiresAt: null,
          challengeAttempts: 0,
          failedAttempts: 0,
          lockedUntil: null,
          backupCodeHashes: JSON.stringify(backupCodeHashes),
          enrolledAt: now,
          lastVerifiedAt: now,
          lastUsedTimeStep: verified.timeStep,
        },
      });
      await tx.refreshToken.updateMany({
        where: { userId: row.userId, companyId: row.companyId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'mfa_enrolled' },
      });
      await writeAuditRequired(tx, {
        companyId: row.companyId,
        userId: row.userId,
        action: 'auth.mfa.enroll',
        details: { userId: row.userId, backupCodeCount: backupCodes.length },
      });
      return {
        kind: 'success' as const,
        userId: row.userId,
        companyId: row.companyId,
        backupCodes,
      };
    });
    if (result.kind === 'invalid') {
      fail(401, 'MfaInvalidCode', 'auth.mfa_invalid_code');
    }
    return res.json(await tokenResponse(
      deps,
      result.userId,
      result.companyId,
      result.backupCodes,
      { deviceLabel: body.deviceLabel, platform: body.platform },
    ));
  }));

  deps.app.post('/api/v2/auth/mfa/verify', deps.limiter, route(async (req, res) => {
    const body = parseBody(verifySchema, req.body);
    assertMfaEncryptionKey(deps.encryptionKey);
    const result = await deps.prisma.$transaction(async (tx) => {
      const initial = await challengeRow(tx, body.challengeToken, 'login');
      await tx.$queryRaw`
        SELECT "userId" FROM "UserMfaCredential"
        WHERE "userId" = ${initial.userId} AND "companyId" = ${initial.companyId}
        FOR UPDATE
      `;
      const row = await challengeRow(tx, body.challengeToken, 'login');
      if (!row.secretCiphertext || row.state !== 'enrolled') {
        fail(409, 'MfaNotEnrolled', 'auth.mfa_not_enrolled');
      }
      const secret = decryptMfaSecret(row.secretCiphertext, deps.encryptionKey);
      const verified = verifyTotp(secret, body.code);
      const previousStep = row.lastUsedTimeStep == null ? null : BigInt(row.lastUsedTimeStep);
      let backupCodeHashes = parseBackupCodeHashes(row.backupCodeHashes);
      let backupUsed = false;
      if (
        !verified.valid ||
        verified.timeStep == null ||
        (previousStep != null && verified.timeStep <= previousStep)
      ) {
        const backupIndex = await matchingBackupCodeIndex(body.code, backupCodeHashes);
        if (backupIndex < 0) {
          await recordFailedAttempt(tx, row);
          return { kind: 'invalid' as const };
        }
        backupCodeHashes = backupCodeHashes.filter((_, index) => index !== backupIndex);
        backupUsed = true;
      }
      const now = new Date();
      await tx.userMfaCredential.update({
        where: { userId: row.userId },
        data: {
          challengeTokenHash: null,
          challengePurpose: null,
          challengeExpiresAt: null,
          challengeAttempts: 0,
          failedAttempts: 0,
          lockedUntil: null,
          lastVerifiedAt: now,
          ...(verified.valid && verified.timeStep != null
            ? { lastUsedTimeStep: verified.timeStep }
            : {}),
          ...(backupUsed
            ? { backupCodeHashes: JSON.stringify(backupCodeHashes) }
            : {}),
        },
      });
      await writeAuditRequired(tx, {
        companyId: row.companyId,
        userId: row.userId,
        action: backupUsed ? 'auth.mfa.backup_used' : 'auth.mfa.verify',
        details: { userId: row.userId },
      });
      return {
        kind: 'success' as const,
        userId: row.userId,
        companyId: row.companyId,
      };
    });
    if (result.kind === 'invalid') {
      fail(401, 'MfaInvalidCode', 'auth.mfa_invalid_code');
    }
    return res.json(await tokenResponse(
      deps,
      result.userId,
      result.companyId,
      undefined,
      { deviceLabel: body.deviceLabel, platform: body.platform },
    ));
  }));
}
