import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeForcedPasswordChange,
  isAccessTokenCredentialStale,
  isForcedChangeAllowedPath,
  isCredentialGateLoginBlocked,
  isTemporaryPasswordExpired,
  loadUserCredentialGate,
  registerForcedPasswordChangeRoutes,
  shapeMeCredentialFields,
} from '../src/forcedPasswordChange';
import { NEW_PASSWORD_MIN_LENGTH } from '../src/credentialSecrets';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

const TEMP_PASSWORD = 'TempPass123!';
const NEW_PASSWORD = 'NewSecurePass1';

type UserRow = {
  id: string;
  companyId: string;
  password: string;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: Date | null;
  passwordChangedAt: Date | null;
  credentialVersion: number;
  accountStatus: string;
};

function makeForcedChangePrisma(initialUser: UserRow) {
  const prisma = makeFakePrisma();
  let user = { ...initialUser };

  prisma.user.findFirst = vi.fn(async ({ where, select }: any = {}) => {
    if (where?.id !== user.id || where?.companyId !== user.companyId) return null;
    if (!select) return { ...user };
    const selected: Record<string, unknown> = {};
    for (const key of Object.keys(select)) {
      if (key in user) selected[key] = (user as Record<string, unknown>)[key];
    }
    return selected;
  });

  prisma.user.update = vi.fn(async ({ where, data }: any) => {
    if (where.id !== user.id || where.companyId !== user.companyId) {
      throw new Error('User not found');
    }
    const next = { ...user };
    if (data.password !== undefined) next.password = data.password;
    if (data.mustChangePassword !== undefined) next.mustChangePassword = data.mustChangePassword;
    if (data.temporaryPasswordExpiresAt !== undefined) {
      next.temporaryPasswordExpiresAt = data.temporaryPasswordExpiresAt;
    }
    if (data.passwordChangedAt !== undefined) next.passwordChangedAt = data.passwordChangedAt;
    if (data.credentialVersion?.increment) {
      next.credentialVersion += data.credentialVersion.increment;
    }
    if (data.authorizationVersion?.increment) {
      (next as UserRow & { authorizationVersion?: number }).authorizationVersion =
        ((user as UserRow & { authorizationVersion?: number }).authorizationVersion ?? 1) +
        data.authorizationVersion.increment;
    }
    user = next;
    return {
      ...user,
      credentialVersion: user.credentialVersion,
    };
  });

  prisma.user.updateMany = vi.fn(async ({ where, data }: any) => {
    if (where.id !== user.id || where.companyId !== user.companyId) return { count: 0 };
    if (where.accountStatus && user.accountStatus !== where.accountStatus) return { count: 0 };
    if (where.mustChangePassword !== undefined && user.mustChangePassword !== where.mustChangePassword) {
      return { count: 0 };
    }
    if (where.credentialVersion !== undefined && user.credentialVersion !== where.credentialVersion) {
      return { count: 0 };
    }
    if (where.temporaryPasswordExpiresAt?.gt) {
      const bound = where.temporaryPasswordExpiresAt.gt as Date;
      if (!user.temporaryPasswordExpiresAt || user.temporaryPasswordExpiresAt.getTime() <= bound.getTime()) {
        return { count: 0 };
      }
    }
    const next = { ...user };
    if (data.password !== undefined) next.password = data.password;
    if (data.mustChangePassword !== undefined) next.mustChangePassword = data.mustChangePassword;
    if (data.temporaryPasswordExpiresAt !== undefined) {
      next.temporaryPasswordExpiresAt = data.temporaryPasswordExpiresAt;
    }
    if (data.passwordChangedAt !== undefined) next.passwordChangedAt = data.passwordChangedAt;
    if (data.credentialVersion?.increment) {
      next.credentialVersion += data.credentialVersion.increment;
    }
    if (data.authorizationVersion?.increment) {
      (next as UserRow & { authorizationVersion?: number }).authorizationVersion =
        ((user as UserRow & { authorizationVersion?: number }).authorizationVersion ?? 1) +
        data.authorizationVersion.increment;
    }
    user = next;
    return { count: 1 };
  });

  prisma.refreshToken.updateMany = vi.fn(async ({ where, data }: any) => {
    const matching = prisma._store.refreshTokens.filter((row: any) => {
      if (where.userId !== undefined && row.userId !== where.userId) return false;
      if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
      if (where.revokedAt === null && row.revokedAt !== null) return false;
      return true;
    });
    matching.forEach((row: any) => Object.assign(row, data));
    return { count: matching.length };
  });

  return {
    prisma,
    getUser: () => user,
    setUser: (patch: Partial<UserRow>) => {
      user = { ...user, ...patch };
    },
  };
}

function makeForcedChangeApp(prisma: ReturnType<typeof makeFakePrisma>) {
  const app = express();
  app.use(express.json());

  const requireAuth = (
    req: express.Request & { user?: Record<string, unknown> },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? header.match(/^Bearer\s+(\S+)$/i) : null;
    if (!match) return res.status(401).json({ error: 'Unauthorized' });
    try {
      req.user = jwt.verify(match[1], TEST_SECRET) as {
        id: string;
        companyId: string;
      };
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };

  registerForcedPasswordChangeRoutes({ app, prisma, requireAuth });
  return app;
}

describe('forced password change helpers', () => {
  it('allowlists only coordinator-approved paths', () => {
    expect(isForcedChangeAllowedPath('POST', '/api/v2/auth/change-temporary-password')).toBe(true);
    expect(isForcedChangeAllowedPath('POST', '/api/auth/logout')).toBe(true);
    expect(isForcedChangeAllowedPath('POST', '/api/v2/auth/refresh')).toBe(true);
    expect(isForcedChangeAllowedPath('GET', '/api/auth/me')).toBe(true);
    expect(isForcedChangeAllowedPath('GET', '/api/v2/auth/me')).toBe(true);
    expect(isForcedChangeAllowedPath('GET', '/api/dashboard/stats')).toBe(false);
    expect(isForcedChangeAllowedPath('POST', '/api/leaves')).toBe(false);
  });

  it('detects expired temporary credentials for login blocking', () => {
    const expiredGate = {
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() - 60_000),
      accountStatus: 'active',
      credentialVersion: 2,
      passwordChangedAt: null,
    };
    expect(isTemporaryPasswordExpired(expiredGate)).toBe(true);
    expect(isCredentialGateLoginBlocked(expiredGate)).toBe(true);
    expect(shapeMeCredentialFields(expiredGate).mustChangePassword).toBe(true);
  });
});

describe('POST /api/v2/auth/change-temporary-password', () => {
  let hash: string;
  let setup: ReturnType<typeof makeForcedChangePrisma>;
  let app: express.Express;

  beforeEach(async () => {
    hash = await bcrypt.hash(TEMP_PASSWORD, 4);
    setup = makeForcedChangePrisma({
      id: 'u1',
      companyId: 'c1',
      password: hash,
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      passwordChangedAt: null,
      credentialVersion: 1,
      accountStatus: 'active',
    });
    setup.prisma._store.refreshTokens.push(
      {
        id: 'rt-1',
        userId: 'u1',
        companyId: 'c1',
        tokenHash: 'hash-1',
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: null,
      },
      {
        id: 'rt-2',
        userId: 'u1',
        companyId: 'c1',
        tokenHash: 'hash-2',
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: null,
      },
    );
    app = makeForcedChangeApp(setup.prisma);
  });

  const authHeader = () => ({
    Authorization: `Bearer ${tokenFor({ id: 'u1', companyId: 'c1' })}`,
  });

  it('changes password, clears forced-change flag, revokes sessions, and audits safely', async () => {
    const res = await request(app)
      .post('/api/v2/auth/change-temporary-password')
      .set(authHeader())
      .send({
        temporaryPassword: TEMP_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      });

    expect(res.status).toBe(200);
    expect(res.body.changedAt).toBeTruthy();
    expect(res.body.sessionsRevoked).toBe(2);
    expect(res.body.temporaryPassword).toBeUndefined();
    expect(res.body.newPassword).toBeUndefined();

    const user = setup.getUser();
    expect(user.mustChangePassword).toBe(false);
    expect(user.temporaryPasswordExpiresAt).toBeNull();
    expect(user.passwordChangedAt).toBeTruthy();
    expect(user.credentialVersion).toBe(2);
    expect(setup.prisma.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        authorizationVersion: { increment: 1 },
      }),
    }));
    expect(await bcrypt.compare(NEW_PASSWORD, user.password)).toBe(true);

    expect(setup.prisma._store.refreshTokens.every((row: any) => row.revokedAt)).toBe(true);
    expect(setup.prisma._store.refreshTokens.every((row: any) => row.revokedReason === 'password_changed')).toBe(true);

    const audit = setup.prisma._store.auditLogs.find((row: any) => row.action === 'auth.password.change_forced');
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit?.details ?? '')).not.toContain(TEMP_PASSWORD);
    expect(JSON.stringify(audit?.details ?? '')).not.toContain(NEW_PASSWORD);
  });

  it('rejects a wrong temporary password with 401', async () => {
    const res = await request(app)
      .post('/api/v2/auth/change-temporary-password')
      .set(authHeader())
      .send({
        temporaryPassword: ['invalid', 'fixture', 'password'].join('-'),
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('InvalidTemporaryPassword');
    expect(res.body.messageKey).toBe('auth.temporary_password_invalid');
    expect(setup.getUser().mustChangePassword).toBe(true);
  });

  it('rejects confirm mismatch with 400', async () => {
    const res = await request(app)
      .post('/api/v2/auth/change-temporary-password')
      .set(authHeader())
      .send({
        temporaryPassword: TEMP_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: 'DifferentPass1',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ValidationError');
    expect(res.body.messageKey).toBe('password.confirm_mismatch');
  });

  it('rejects expired temporary credentials with 409', async () => {
    setup.setUser({
      temporaryPasswordExpiresAt: new Date(Date.now() - 60_000),
    });

    const res = await request(app)
      .post('/api/v2/auth/change-temporary-password')
      .set(authHeader())
      .send({
        temporaryPassword: TEMP_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TemporaryPasswordExpired');
    expect(res.body.messageKey).toBe('auth.temporary_password_expired');
  });

  it('rejects passwords shorter than policy with 400', async () => {
    const tooShort = 'a'.repeat(NEW_PASSWORD_MIN_LENGTH - 1);
    const res = await request(app)
      .post('/api/v2/auth/change-temporary-password')
      .set(authHeader())
      .send({
        temporaryPassword: TEMP_PASSWORD,
        newPassword: tooShort,
        confirmPassword: tooShort,
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ValidationError');
    expect(res.body.messageKey).toBe('password.too_short');
  });
});

describe('loadUserCredentialGate', () => {
  it('returns gate fields for coordinator middleware', async () => {
    const setup = makeForcedChangePrisma({
      id: 'u1',
      companyId: 'c1',
      password: 'hash',
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date('2026-07-20T12:00:00.000Z'),
      passwordChangedAt: null,
      credentialVersion: 3,
      accountStatus: 'active',
    });

    const gate = await loadUserCredentialGate(setup.prisma, 'u1', 'c1');
    expect(gate).toEqual({
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date('2026-07-20T12:00:00.000Z'),
      accountStatus: 'active',
      credentialVersion: 3,
      passwordChangedAt: null,
    });
  });
});

describe('isAccessTokenCredentialStale', () => {
  it('rejects mismatched credentialVersion claims regardless of iat', () => {
    const changedAt = new Date('2026-07-20T12:00:00.500Z');
    expect(isAccessTokenCredentialStale(
      { credentialVersion: 2, iat: Math.floor(changedAt.getTime() / 1000) + 100 },
      { credentialVersion: 3, passwordChangedAt: changedAt },
    )).toBe(true);
    expect(isAccessTokenCredentialStale(
      { credentialVersion: 3, iat: Math.floor(changedAt.getTime() / 1000) - 100 },
      { credentialVersion: 3, passwordChangedAt: changedAt },
    )).toBe(false);
  });

  it('treats same-second and earlier legacy tokens as stale (no positive grace)', () => {
    const changedAt = new Date('2026-07-20T12:00:00.800Z');
    const sameSecond = Math.floor(changedAt.getTime() / 1000);
    expect(isAccessTokenCredentialStale(
      { iat: sameSecond - 1 },
      { credentialVersion: 2, passwordChangedAt: changedAt },
    )).toBe(true);
    expect(isAccessTokenCredentialStale(
      { iat: sameSecond },
      { credentialVersion: 2, passwordChangedAt: changedAt },
    )).toBe(true);
    expect(isAccessTokenCredentialStale(
      { iat: sameSecond + 1 },
      { credentialVersion: 2, passwordChangedAt: changedAt },
    )).toBe(false);
  });

  it('fail-closes malformed legacy iat when passwordChangedAt exists', () => {
    const changedAt = new Date('2026-07-20T12:00:00.000Z');
    const gate = { credentialVersion: 2, passwordChangedAt: changedAt };
    expect(isAccessTokenCredentialStale({}, gate)).toBe(true);
    expect(isAccessTokenCredentialStale({ iat: '12' as unknown as number }, gate)).toBe(true);
    expect(isAccessTokenCredentialStale({ iat: Number.NaN }, gate)).toBe(true);
    expect(isAccessTokenCredentialStale({ iat: 12.5 }, gate)).toBe(true);
  });

  it('keeps RC1 compatibility when passwordChangedAt is null', () => {
    expect(isAccessTokenCredentialStale(
      { iat: 1 },
      { credentialVersion: 1, passwordChangedAt: null },
    )).toBe(false);
    expect(isAccessTokenCredentialStale(
      {},
      { credentialVersion: 1, passwordChangedAt: null },
    )).toBe(false);
  });

  it('rejects original legacy token after same-second reset and forced change', () => {
    // Simulate: reset and forced-change timestamps land in the same unix second.
    const second = 1_752_000_000;
    const resetAt = new Date(second * 1000 + 100);
    const forcedAt = new Date(second * 1000 + 900);
    const preResetLegacyIat = second; // issued during the same second as reset

    // After reset (mustChangePassword still true): legacy token already stale.
    expect(isAccessTokenCredentialStale(
      { iat: preResetLegacyIat },
      { credentialVersion: 4, passwordChangedAt: resetAt },
    )).toBe(true);

    // After forced change clears mustChangePassword in the same second: still stale.
    expect(isAccessTokenCredentialStale(
      { iat: preResetLegacyIat },
      { credentialVersion: 5, passwordChangedAt: forcedAt },
    )).toBe(true);

    // Temporary-login token issued at reset second becomes stale after forced change.
    expect(isAccessTokenCredentialStale(
      { iat: second },
      { credentialVersion: 5, passwordChangedAt: forcedAt },
    )).toBe(true);

    // New token with current credentialVersion succeeds.
    expect(isAccessTokenCredentialStale(
      { credentialVersion: 5, iat: second },
      { credentialVersion: 5, passwordChangedAt: forcedAt },
    )).toBe(false);
  });
});

describe('executeForcedPasswordChange direct', () => {
  it('rejects reusing the temporary password as the new password', async () => {
    const hash = await bcrypt.hash(TEMP_PASSWORD, 4);
    const setup = makeForcedChangePrisma({
      id: 'u1',
      companyId: 'c1',
      password: hash,
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() + 60_000),
      passwordChangedAt: null,
      credentialVersion: 1,
      accountStatus: 'active',
    });

    await expect(
      executeForcedPasswordChange(
        setup.prisma,
        { id: 'u1', companyId: 'c1' },
        {
          temporaryPassword: TEMP_PASSWORD,
          newPassword: TEMP_PASSWORD,
          confirmPassword: TEMP_PASSWORD,
        },
      ),
    ).rejects.toMatchObject({
      status: 400,
      messageKey: 'password.same_as_temporary',
    });
  });
});
