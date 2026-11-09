import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import express from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '@prisma/client';
import { sanitizeAuditDetails } from './audit';
import { normalizeEmail } from './identity';
import {
  assertMfaEncryptionKey,
  decryptMfaSecret,
  encryptMfaSecret,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCodes,
  hashMfaChallenge,
  matchingBackupCodeIndex,
  MFA_CHALLENGE_TTL_MS,
  MFA_LOCKOUT_MS,
  MFA_MAX_CHALLENGE_ATTEMPTS,
  MfaConfigurationError,
  parseBackupCodeHashes,
  totpUri,
  verifyTotp,
} from './mfa';
import { generateRefreshToken, hashToken } from './tokens';

type TxClient = Prisma.TransactionClient;

export type PlatformMfaChallengeKind = 'login' | 'enroll';

/**
 * Version-bound Platform MFA challenge token.
 * credentialVersion is embedded in the presented token (hash-bound), while
 * challengePurpose remains DB-compatible `login`|`enroll` (CHECK constraint).
 * Format: pcv1.<kind>.<credentialVersion>.<entropy>
 */
export function mintVersionBoundPlatformMfaChallenge(
  kind: PlatformMfaChallengeKind,
  credentialVersion: number,
): {
  token: string;
  tokenHash: string;
  purpose: PlatformMfaChallengeKind;
  expiresAt: Date;
  credentialVersion: number;
} {
  if (!Number.isInteger(credentialVersion) || credentialVersion < 1) {
    throw new Error('platform MFA challenge requires a positive credentialVersion');
  }
  const entropy = crypto.randomBytes(32).toString('base64url');
  const token = `pcv1.${kind}.${credentialVersion}.${entropy}`;
  return {
    token,
    tokenHash: hashMfaChallenge(token),
    purpose: kind,
    expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS),
    credentialVersion,
  };
}

/**
 * Fail-closed parser for presented challenge tokens.
 * Legacy unversioned tokens and malformed values return null.
 * Never accepts a separate client credentialVersion field.
 */
export function parseVersionBoundPlatformMfaChallengeToken(
  value: unknown,
): { kind: PlatformMfaChallengeKind; credentialVersion: number } | null {
  if (typeof value !== 'string') return null;
  const match = /^pcv1\.(login|enroll)\.([1-9][0-9]{0,9})\.([A-Za-z0-9_-]{40,128})$/.exec(value);
  if (!match) return null;
  const credentialVersion = Number(match[2]);
  if (!Number.isSafeInteger(credentialVersion) || credentialVersion < 1) return null;
  return {
    kind: match[1] as PlatformMfaChallengeKind,
    credentialVersion,
  };
}

export const PLATFORM_PERMISSIONS = {
  COMPANIES_VIEW: 'platform.companies.view',
  COMPANIES_PROVISION: 'platform.companies.provision',
  COMPANIES_OWNER_RECOVERY_INITIATE: 'platform.companies.owner_recovery.initiate',
} as const;

export interface PlatformPrincipalContext {
  id: string;
  email: string;
  name: string;
  permissions: string[];
  authorizationVersion: number;
  sessionId: string;
  mfaVerifiedAt: Date;
  credentialVersion: number;
}

export interface PlatformRequest extends express.Request {
  platformPrincipal?: PlatformPrincipalContext;
}

interface PlatformAuthDeps {
  app: express.Express;
  prisma: PrismaClient;
  limiter: express.RequestHandler;
  jwtSecret?: string;
  mfaEncryptionKey?: string;
  accessTokenTtl?: string;
  refreshTokenTtlDays?: number;
}

class PlatformAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

const fail = (status: number, code: string, messageKey: string): never => {
  throw new PlatformAuthError(status, code, messageKey);
};

const dummyHash = bcrypt.hash(crypto.randomBytes(32), 10);
const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(512),
}).strict();
const challengeSchema = z.object({
  challengeToken: z.string().trim().min(40).max(200),
}).strict();
const verifySchema = challengeSchema.extend({
  code: z.string().trim().min(6).max(32),
}).strict();
const refreshSchema = z.object({ refreshToken: z.string().min(40).max(256) }).strict();
const logoutSchema = z.object({ refreshToken: z.string().min(40).max(256) }).strict();

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail(400, 'InvalidRequest', 'platform.invalid_request');
  return parsed.data;
};

const permissionsOf = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
};

export async function writePlatformAudit(
  client: Pick<PrismaClient, 'platformAuditLog'>,
  input: {
    principalId: string;
    action: string;
    targetCompanyId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await client.platformAuditLog.create({
    data: {
      principalId: input.principalId,
      action: input.action,
      targetCompanyId: input.targetCompanyId ?? null,
      details: JSON.stringify(sanitizeAuditDetails(input.details ?? {})),
    },
  });
}

/** Default recent-MFA window for high-risk Platform mutations (15 minutes). */
export const DEFAULT_PLATFORM_RECENT_MFA_MAX_AGE_MS = 15 * 60 * 1000;
export const PLATFORM_RECENT_MFA_MAX_AGE_MIN_MS = 60 * 1000;
export const PLATFORM_RECENT_MFA_MAX_AGE_MAX_MS = 60 * 60 * 1000;

export function assertPlatformRecentMfaMaxAgeMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error('platform recent MFA max age must be a finite integer');
  }
  if (value < PLATFORM_RECENT_MFA_MAX_AGE_MIN_MS || value > PLATFORM_RECENT_MFA_MAX_AGE_MAX_MS) {
    throw new Error(
      `platform recent MFA max age must be between ${PLATFORM_RECENT_MFA_MAX_AGE_MIN_MS} and ${PLATFORM_RECENT_MFA_MAX_AGE_MAX_MS} ms`,
    );
  }
  return value;
}

/**
 * Check recent MFA/re-auth using the authoritative session mfaVerifiedAt.
 * Never trusts client-supplied timestamps.
 */
export function isPlatformMfaRecent(
  principal: Pick<PlatformPrincipalContext, 'mfaVerifiedAt'>,
  maxAgeMs: number = DEFAULT_PLATFORM_RECENT_MFA_MAX_AGE_MS,
  now: Date = new Date(),
): boolean {
  const bounded = assertPlatformRecentMfaMaxAgeMs(maxAgeMs);
  const verifiedAt = principal.mfaVerifiedAt;
  if (!(verifiedAt instanceof Date) || Number.isNaN(verifiedAt.getTime())) {
    return false;
  }
  return now.getTime() - verifiedAt.getTime() <= bounded;
}

const safePrincipal = (principal: any) => ({
  id: principal.id,
  email: principal.email,
  name: principal.name,
  permissions: permissionsOf(principal.permissions),
  authorizationVersion: principal.authorizationVersion,
  mfaRequired: true,
  mfaEnrolled: true,
});

type LockedPlatformPrincipal = {
  id: string;
  email: string;
  name: string;
  status: string;
  permissions: string;
  authorizationVersion: number;
  credentialVersion: number;
};

const resolveChallengePrincipalId = async (
  client: Pick<PrismaClient, 'platformMfaCredential'> | TxClient,
  token: string,
): Promise<string> => {
  // Fail closed on legacy/unversioned tokens before any DB lookup.
  if (!parseVersionBoundPlatformMfaChallengeToken(token)) {
    fail(401, 'PlatformMfaChallengeInvalid', 'platform.mfa_invalid_challenge');
  }
  const row = await client.platformMfaCredential.findUnique({
    where: { challengeTokenHash: hashMfaChallenge(token) },
    select: { principalId: true },
  });
  if (!row) fail(401, 'PlatformMfaChallengeInvalid', 'platform.mfa_invalid_challenge');
  return row.principalId;
};

/** Lock order step 2: PlatformPrincipal before MFA (matches E1 recovery). */
const lockPlatformPrincipalForMfa = async (
  tx: TxClient,
  principalId: string,
): Promise<LockedPlatformPrincipal | null> => {
  const rows = await tx.$queryRaw<LockedPlatformPrincipal[]>`
    SELECT id, email, name, status, permissions, "authorizationVersion", "credentialVersion"
    FROM "PlatformPrincipal"
    WHERE id = ${principalId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
};

/** Lock order step 3: PlatformMfaCredential after PlatformPrincipal. */
const lockPlatformMfaCredential = async (
  tx: TxClient,
  principalId: string,
): Promise<void> => {
  await tx.$queryRaw`
    SELECT "principalId"
    FROM "PlatformMfaCredential"
    WHERE "principalId" = ${principalId}
    FOR UPDATE
  `;
};

const loadValidatedMfaChallenge = async (
  client: Pick<PrismaClient, 'platformMfaCredential'> | TxClient,
  token: string,
  expectedKind: PlatformMfaChallengeKind,
  expectedCredentialVersion: number,
) => {
  const bound = parseVersionBoundPlatformMfaChallengeToken(token);
  const row = await client.platformMfaCredential.findUnique({
    where: { challengeTokenHash: hashMfaChallenge(token) },
  });
  if (
    !bound ||
    bound.kind !== expectedKind ||
    bound.credentialVersion !== expectedCredentialVersion ||
    !row ||
    row.challengePurpose !== expectedKind ||
    !row.challengeExpiresAt ||
    row.challengeExpiresAt.getTime() <= Date.now() ||
    row.challengeAttempts >= MFA_MAX_CHALLENGE_ATTEMPTS ||
    (row.lockedUntil && row.lockedUntil.getTime() > Date.now())
  ) {
    fail(401, 'PlatformMfaChallengeInvalid', 'platform.mfa_invalid_challenge');
  }
  return row;
};

const failedAttempt = async (client: any, row: any): Promise<void> => {
  const challengeAttempts = row.challengeAttempts + 1;
  const failedAttempts = Math.min(
    Number(row.failedAttempts ?? 0) + 1,
    MFA_MAX_CHALLENGE_ATTEMPTS,
  );
  const locked = failedAttempts >= MFA_MAX_CHALLENGE_ATTEMPTS;
  await client.platformMfaCredential.update({
    where: { principalId: row.principalId },
    data: {
      challengeAttempts,
      failedAttempts,
      ...(locked ? { lockedUntil: new Date(Date.now() + MFA_LOCKOUT_MS) } : {}),
      ...(locked || challengeAttempts >= MFA_MAX_CHALLENGE_ATTEMPTS
        ? {
          challengeTokenHash: null,
          challengePurpose: null,
          challengeExpiresAt: null,
        }
        : {}),
    },
  });
};

export function registerPlatformAuthRoutes(deps: PlatformAuthDeps): {
  requirePlatformAuth: express.RequestHandler;
} {
  const requireSecret = (): string => {
    if (!deps.jwtSecret) fail(503, 'PlatformAuthUnavailable', 'platform.auth_unavailable');
    return deps.jwtSecret;
  };

  const issueTokensOnClient = async (
    client: Pick<PrismaClient, 'platformRefreshToken'> | TxClient,
    principal: LockedPlatformPrincipal | {
      id: string;
      permissions: string;
      authorizationVersion: number;
      credentialVersion: number;
    },
    verifiedAt: Date = new Date(),
  ) => {
    const secret = requireSecret();
    const sessionId = crypto.randomUUID();
    const refresh = generateRefreshToken(deps.refreshTokenTtlDays ?? 7);
    await client.platformRefreshToken.create({
      data: {
        sessionId,
        principalId: principal.id,
        tokenHash: refresh.hash,
        expiresAt: refresh.expiresAt,
        credentialVersion: principal.credentialVersion,
        mfaVerifiedAt: verifiedAt,
      },
    });
    const mfaVerifiedAt = verifiedAt.toISOString();
    const accessToken = jwt.sign(
      {
        principalType: 'platform',
        id: principal.id,
        permissions: permissionsOf(principal.permissions),
        authorizationVersion: principal.authorizationVersion,
        mfaVerifiedAt,
        sessionId,
      },
      secret,
      {
        audience: 'mawared-platform',
        expiresIn: (deps.accessTokenTtl ?? '10m') as jwt.SignOptions['expiresIn'],
      },
    );
    return { accessToken, refreshToken: refresh.token, mfaVerifiedAt };
  };

  /** Refresh rotation and non-MFA paths — uses the root Prisma client. */
  const issueTokens = async (
    principal: {
      id: string;
      permissions: string;
      authorizationVersion: number;
      credentialVersion: number;
    },
    verifiedAt: Date = new Date(),
  ) => issueTokensOnClient(deps.prisma, principal, verifiedAt);

  const requirePlatformAuth: express.RequestHandler = async (request, response, next) => {
    try {
      const header = request.header('Authorization');
      const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
      if (!token) fail(401, 'PlatformUnauthorized', 'platform.unauthorized');
      const payload = jwt.verify(token, requireSecret(), {
        audience: 'mawared-platform',
      }) as jwt.JwtPayload;
      if (payload.principalType !== 'platform' || typeof payload.id !== 'string') {
        fail(401, 'PlatformUnauthorized', 'platform.unauthorized');
      }
      if (typeof payload.sessionId !== 'string') {
        fail(401, 'PlatformUnauthorized', 'platform.unauthorized');
      }
      const principal = await deps.prisma.platformPrincipal.findFirst({
        where: { id: payload.id, status: 'active' },
      });
      const [session, mfa] = principal
        ? await Promise.all([
          deps.prisma.platformRefreshToken.findUnique({
            where: { sessionId: payload.sessionId },
          }),
          deps.prisma.platformMfaCredential.findUnique({
            where: { principalId: principal.id },
          }),
        ])
        : [null, null];
      if (
        !principal ||
        payload.authorizationVersion !== principal.authorizationVersion ||
        !session ||
        session.principalId !== principal.id ||
        session.revokedAt != null ||
        session.expiresAt <= new Date() ||
        session.credentialVersion !== principal.credentialVersion ||
        mfa?.state !== 'enrolled'
      ) {
        fail(401, 'PlatformUnauthorized', 'platform.unauthorized');
      }
      (request as PlatformRequest).platformPrincipal = {
        id: principal.id,
        email: principal.email,
        name: principal.name,
        permissions: permissionsOf(principal.permissions),
        authorizationVersion: principal.authorizationVersion,
        sessionId: session.sessionId,
        mfaVerifiedAt: session.mfaVerifiedAt,
        credentialVersion: principal.credentialVersion,
      };
      next();
    } catch (error) {
      const authError = error instanceof PlatformAuthError
        ? error
        : new PlatformAuthError(401, 'PlatformUnauthorized', 'platform.unauthorized');
      response.status(authError.status).json({
        code: authError.code,
        messageKey: authError.messageKey,
      });
    }
  };

  const route = (
    handler: (req: express.Request, res: express.Response) => Promise<unknown>,
  ): express.RequestHandler => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof PlatformAuthError) {
        return res.status(error.status).json({
          code: error.code,
          messageKey: error.messageKey,
        });
      }
      if (error instanceof MfaConfigurationError) {
        return res.status(503).json({
          code: 'PlatformMfaUnavailable',
          messageKey: 'platform.mfa_unavailable',
        });
      }
      return res.status(500).json({
        code: 'PlatformAuthFailed',
        messageKey: 'platform.auth_failed',
      });
    }
  };

  const beginChallenge = async (principal: {
    id: string;
    email: string;
    name: string;
    credentialVersion: number;
  }) => {
    assertMfaEncryptionKey(deps.mfaEncryptionKey);
    const existing = await deps.prisma.platformMfaCredential.findUnique({
      where: { principalId: principal.id },
    });
    if (existing?.lockedUntil && existing.lockedUntil.getTime() > Date.now()) {
      fail(429, 'PlatformMfaRateLimited', 'platform.mfa_rate_limited');
    }
    const lockExpired = existing?.lockedUntil != null &&
      existing.lockedUntil.getTime() <= Date.now();
    const kind: PlatformMfaChallengeKind = existing?.state === 'enrolled' ? 'login' : 'enroll';
    // Bind to the password-check snapshot credentialVersion — never re-fetch here.
    // Version lives in the presented token (hash-bound); purpose column stays login|enroll.
    const challenge = mintVersionBoundPlatformMfaChallenge(kind, principal.credentialVersion);
    await deps.prisma.platformMfaCredential.upsert({
      where: { principalId: principal.id },
      create: {
        principalId: principal.id,
        state: 'pending',
        challengeTokenHash: challenge.tokenHash,
        challengePurpose: challenge.purpose,
        challengeExpiresAt: challenge.expiresAt,
      },
      update: {
        challengeTokenHash: challenge.tokenHash,
        challengePurpose: challenge.purpose,
        challengeExpiresAt: challenge.expiresAt,
        challengeAttempts: 0,
        ...(kind === 'enroll' ? { pendingSecretCiphertext: null } : {}),
        ...(lockExpired ? { failedAttempts: 0, lockedUntil: null } : {}),
      },
    });
    return {
      mfaRequired: true,
      enrollmentRequired: kind === 'enroll',
      challengeToken: challenge.token,
      expiresAt: challenge.expiresAt.toISOString(),
      principal: {
        id: principal.id,
        email: principal.email,
        name: principal.name,
      },
    };
  };

  deps.app.post('/api/platform/v1/auth/login', deps.limiter, route(async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const normalizedEmail = normalizeEmail(body.email);
    const principal = await deps.prisma.platformPrincipal.findUnique({
      where: { normalizedEmail },
    });
    const matches = await bcrypt.compare(body.password, principal?.password ?? await dummyHash);
    if (!principal || !matches || principal.status !== 'active') {
      return res.status(401).json({
        code: 'InvalidCredentials',
        messageKey: 'platform.invalid_credentials',
      });
    }
    // Use the password-check principal snapshot so a concurrent recovery cannot
    // produce a post-reset challenge from a pre-reset password verification.
    return res.json(await beginChallenge(principal));
  }));

  deps.app.post('/api/platform/v1/auth/mfa/enroll/start', deps.limiter, route(async (req, res) => {
    const body = parseBody(challengeSchema, req.body);
    const principalId = await resolveChallengePrincipalId(deps.prisma, body.challengeToken);
    const result = await deps.prisma.$transaction(async (tx) => {
      const principal = await lockPlatformPrincipalForMfa(tx, principalId);
      if (!principal || principal.status !== 'active') {
        fail(401, 'PlatformMfaChallengeInvalid', 'platform.mfa_invalid_challenge');
      }
      await lockPlatformMfaCredential(tx, principalId);
      const row = await loadValidatedMfaChallenge(
        tx,
        body.challengeToken,
        'enroll',
        principal.credentialVersion,
      );
      let secret: string;
      if (row.pendingSecretCiphertext) {
        secret = decryptMfaSecret(row.pendingSecretCiphertext, deps.mfaEncryptionKey);
      } else {
        secret = generateTotpSecret();
        await tx.platformMfaCredential.update({
          where: { principalId: row.principalId },
          data: { pendingSecretCiphertext: encryptMfaSecret(secret, deps.mfaEncryptionKey) },
        });
      }
      return {
        secret,
        email: principal.email,
        expiresAt: row.challengeExpiresAt!.toISOString(),
      };
    });
    return res.json({
      manualSecret: result.secret,
      otpauthUri: totpUri(result.secret, `platform:${result.email}`),
      expiresAt: result.expiresAt,
    });
  }));

  deps.app.post('/api/platform/v1/auth/mfa/enroll/confirm', deps.limiter, route(async (req, res) => {
    const body = parseBody(verifySchema, req.body);
    const principalId = await resolveChallengePrincipalId(deps.prisma, body.challengeToken);
    const result = await deps.prisma.$transaction(async (tx) => {
      const principal = await lockPlatformPrincipalForMfa(tx, principalId);
      if (!principal || principal.status !== 'active') {
        fail(401, 'PlatformMfaChallengeInvalid', 'platform.mfa_invalid_challenge');
      }
      await lockPlatformMfaCredential(tx, principalId);
      const row = await loadValidatedMfaChallenge(
        tx,
        body.challengeToken,
        'enroll',
        principal.credentialVersion,
      );
      if (!row.pendingSecretCiphertext) {
        fail(409, 'PlatformMfaEnrollmentNotStarted', 'platform.mfa_enrollment_not_started');
      }
      const verified = verifyTotp(
        decryptMfaSecret(row.pendingSecretCiphertext, deps.mfaEncryptionKey),
        body.code,
      );
      if (!verified.valid || verified.timeStep == null) {
        await failedAttempt(tx, row);
        return { kind: 'invalid' as const };
      }
      const backupCodes = generateBackupCodes();
      const hashes = await hashBackupCodes(backupCodes);
      const now = new Date();
      await tx.platformMfaCredential.update({
        where: { principalId: row.principalId },
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
          backupCodeHashes: JSON.stringify(hashes),
          enrolledAt: now,
          lastVerifiedAt: now,
          lastUsedTimeStep: verified.timeStep,
        },
      });
      await tx.platformRefreshToken.updateMany({
        where: { principalId: row.principalId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'mfa_enrolled' },
      });
      await writePlatformAudit(tx as PrismaClient, {
        principalId: row.principalId,
        action: 'platform.auth.mfa.enroll',
        details: { backupCodeCount: backupCodes.length },
      });
      // Session uses the locked challenge-bound credentialVersion — never re-fetch.
      const issued = await issueTokensOnClient(tx, principal, now);
      return {
        kind: 'success' as const,
        principal,
        backupCodes,
        issued,
      };
    });
    if (result.kind === 'invalid') {
      fail(401, 'PlatformMfaInvalidCode', 'platform.mfa_invalid_code');
    }
    return res.json({
      ...result.issued,
      principal: safePrincipal(result.principal),
      backupCodes: result.backupCodes,
    });
  }));

  deps.app.post('/api/platform/v1/auth/mfa/verify', deps.limiter, route(async (req, res) => {
    const body = parseBody(verifySchema, req.body);
    const principalId = await resolveChallengePrincipalId(deps.prisma, body.challengeToken);
    const result = await deps.prisma.$transaction(async (tx) => {
      const principal = await lockPlatformPrincipalForMfa(tx, principalId);
      if (!principal || principal.status !== 'active') {
        fail(401, 'PlatformMfaChallengeInvalid', 'platform.mfa_invalid_challenge');
      }
      await lockPlatformMfaCredential(tx, principalId);
      const row = await loadValidatedMfaChallenge(
        tx,
        body.challengeToken,
        'login',
        principal.credentialVersion,
      );
      if (!row.secretCiphertext || row.state !== 'enrolled') {
        fail(409, 'PlatformMfaNotEnrolled', 'platform.mfa_not_enrolled');
      }
      const verified = verifyTotp(
        decryptMfaSecret(row.secretCiphertext, deps.mfaEncryptionKey),
        body.code,
      );
      let hashes = parseBackupCodeHashes(row.backupCodeHashes);
      let backupUsed = false;
      if (
        !verified.valid ||
        verified.timeStep == null ||
        (row.lastUsedTimeStep != null && verified.timeStep <= BigInt(row.lastUsedTimeStep))
      ) {
        const index = await matchingBackupCodeIndex(body.code, hashes);
        if (index < 0) {
          await failedAttempt(tx, row);
          return { kind: 'invalid' as const };
        }
        hashes = hashes.filter((_, hashIndex) => hashIndex !== index);
        backupUsed = true;
      }
      const now = new Date();
      await tx.platformMfaCredential.update({
        where: { principalId: row.principalId },
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
          ...(backupUsed ? { backupCodeHashes: JSON.stringify(hashes) } : {}),
        },
      });
      await writePlatformAudit(tx as PrismaClient, {
        principalId: row.principalId,
        action: backupUsed
          ? 'platform.auth.mfa.backup_used'
          : 'platform.auth.mfa.verify',
      });
      // Atomic with challenge consumption — uses locked challenge-bound version.
      const issued = await issueTokensOnClient(tx, principal, now);
      return { kind: 'success' as const, principal, issued };
    });
    if (result.kind === 'invalid') {
      fail(401, 'PlatformMfaInvalidCode', 'platform.mfa_invalid_code');
    }
    return res.json({
      ...result.issued,
      principal: safePrincipal(result.principal),
    });
  }));

  deps.app.post('/api/platform/v1/auth/refresh', deps.limiter, route(async (req, res) => {
    const body = parseBody(refreshSchema, req.body);
    const stored = await deps.prisma.platformRefreshToken.findUnique({
      where: { tokenHash: hashToken(body.refreshToken) },
    });
    if (!stored || stored.revokedAt || stored.expiresAt <= new Date()) {
      fail(401, 'PlatformUnauthorized', 'platform.unauthorized');
    }
    const principal = await deps.prisma.platformPrincipal.findFirst({
      where: { id: stored.principalId, status: 'active' },
    });
    const mfa = principal
      ? await deps.prisma.platformMfaCredential.findUnique({
        where: { principalId: principal.id },
      })
      : null;
    if (
      !principal ||
      stored.credentialVersion !== principal.credentialVersion ||
      mfa?.state !== 'enrolled' ||
      !mfa.enrolledAt ||
      stored.createdAt < mfa.enrolledAt
    ) {
      fail(401, 'PlatformUnauthorized', 'platform.unauthorized');
    }
    const consumed = await deps.prisma.platformRefreshToken.updateMany({
      where: { id: stored.id, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date(), revokedReason: 'rotated' },
    });
    if (consumed.count !== 1) fail(401, 'PlatformUnauthorized', 'platform.unauthorized');
    return res.json(await issueTokens(principal, stored.mfaVerifiedAt));
  }));

  deps.app.post('/api/platform/v1/auth/logout', route(async (req, res) => {
    const body = parseBody(logoutSchema, req.body);
    await deps.prisma.platformRefreshToken.updateMany({
      where: { tokenHash: hashToken(body.refreshToken), revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'logout' },
    });
    return res.status(204).send();
  }));

  deps.app.get('/api/platform/v1/auth/me', requirePlatformAuth, route(async (req, res) => {
    const principal = (req as PlatformRequest).platformPrincipal!;
    return res.json({
      id: principal.id,
      email: principal.email,
      name: principal.name,
      permissions: principal.permissions,
      authorizationVersion: principal.authorizationVersion,
      mfaRequired: true,
      mfaEnrolled: true,
    });
  }));

  return { requirePlatformAuth };
}
