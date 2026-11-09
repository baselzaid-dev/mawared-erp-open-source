import bcrypt from 'bcrypt';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { makeApp, makeFakePrisma } from './helpers';

const PASSWORD = 'Owner-password-123!';
const MFA_KEY = Buffer.alloc(32, 11).toString('base64');

describe('Primary Owner backend MFA login', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let app: ReturnType<typeof makeApp>;
  let user: any;

  beforeEach(async () => {
    prisma = makeFakePrisma();
    user = {
      id: 'owner-1',
      companyId: 'c1',
      employeeId: null,
      email: 'owner@example.test',
      normalizedEmail: 'owner@example.test',
      password: await bcrypt.hash(PASSWORD, 4),
      name: 'Primary Owner',
      roleId: 'role-owner',
      authorizationVersion: 1,
      accountStatus: 'active',
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
      credentialVersion: 1,
      employee: null,
      role: { id: 'role-owner', name: 'Primary Owner', permissions: '[]' },
      company: { id: 'c1', code: 'CMP-OWNER', name: 'Owner Company' },
    };
    prisma.company.findUnique.mockResolvedValue(user.company);
    prisma.loginIdentity.findUnique.mockResolvedValue({
      companyId: 'c1',
      userId: user.id,
      user,
    });
    prisma.user.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === user.id && where.companyId === user.companyId ? user : null);
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.companyOwnership.findFirst.mockImplementation(async ({ where }: any) =>
      where.companyId === 'c1' && (!where.userId || where.userId === user.id)
        ? { id: 'ownership-1', userId: user.id }
        : null);
    app = makeApp(prisma, {
      mfaEncryptionKey: MFA_KEY,
      mfaRateLimitMax: 100,
    });
  });

  const login = () => request(app)
    .post('/api/v2/auth/login')
    .send({
      companyCode: 'CMP-OWNER',
      identifier: user.email,
      password: PASSWORD,
    });

  it('requires enrollment and issues no session until TOTP confirmation', async () => {
    const challenged = await login();
    expect(challenged.status).toBe(200);
    expect(challenged.body).toMatchObject({
      mfaRequired: true,
      enrollmentRequired: true,
    });
    expect(challenged.body.accessToken).toBeUndefined();
    expect(challenged.body.refreshToken).toBeUndefined();
    expect(prisma._store.refreshTokens).toHaveLength(0);

    const started = await request(app)
      .post('/api/v2/auth/mfa/enroll/start')
      .send({ challengeToken: challenged.body.challengeToken });
    expect(started.status).toBe(200);
    expect(started.body.manualSecret).toMatch(/^[A-Z2-7]+$/);
    expect(started.body.otpauthUri).toContain('otpauth://totp/');

    const code = new OTPAuth.TOTP({
      issuer: 'Mawared',
      label: 'test',
      secret: OTPAuth.Secret.fromBase32(started.body.manualSecret),
      digits: 6,
      period: 30,
    }).generate();
    const confirmed = await request(app)
      .post('/api/v2/auth/mfa/enroll/confirm')
      .send({
        challengeToken: challenged.body.challengeToken,
        code,
        deviceLabel: 'Mawared Web',
        platform: 'web',
      });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.accessToken).toBeTruthy();
    expect(confirmed.body.refreshToken).toBeTruthy();
    expect(confirmed.body.backupCodes).toHaveLength(10);
    expect(prisma._store.refreshTokens).toHaveLength(1);
    expect(prisma._store.refreshTokens[0]).toMatchObject({
      deviceLabel: 'Mawared Web',
      platform: 'web',
    });

    const stored = prisma._store.userMfaCredentials[0];
    expect(stored.state).toBe('enrolled');
    expect(stored.secretCiphertext).not.toContain(started.body.manualSecret);
    expect(stored.pendingSecretCiphertext).toBeNull();
    expect(stored.challengeTokenHash).toBeNull();
  });

  it('consumes a backup code once and rejects its reuse', async () => {
    const challenged = await login();
    const started = await request(app)
      .post('/api/v2/auth/mfa/enroll/start')
      .send({ challengeToken: challenged.body.challengeToken });
    const code = new OTPAuth.TOTP({
      issuer: 'Mawared',
      label: 'test',
      secret: OTPAuth.Secret.fromBase32(started.body.manualSecret),
    }).generate();
    const confirmed = await request(app)
      .post('/api/v2/auth/mfa/enroll/confirm')
      .send({ challengeToken: challenged.body.challengeToken, code });
    const backupCode = confirmed.body.backupCodes[0];

    const loginChallenge = await login();
    expect(loginChallenge.body.enrollmentRequired).toBe(false);
    const verified = await request(app)
      .post('/api/v2/auth/mfa/verify')
      .send({ challengeToken: loginChallenge.body.challengeToken, code: backupCode });
    expect(verified.status).toBe(200);
    expect(verified.body.accessToken).toBeTruthy();

    const replayChallenge = await login();
    const replay = await request(app)
      .post('/api/v2/auth/mfa/verify')
      .send({ challengeToken: replayChallenge.body.challengeToken, code: backupCode });
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({
      code: 'MfaInvalidCode',
      messageKey: 'auth.mfa_invalid_code',
    });
  });

  it('refresh issues JWT with ownership flatPermissions not empty role JSON', async () => {
    const challenged = await login();
    const started = await request(app)
      .post('/api/v2/auth/mfa/enroll/start')
      .send({ challengeToken: challenged.body.challengeToken });
    const code = new OTPAuth.TOTP({
      issuer: 'Mawared',
      label: 'test',
      secret: OTPAuth.Secret.fromBase32(started.body.manualSecret),
    }).generate();
    const confirmed = await request(app)
      .post('/api/v2/auth/mfa/enroll/confirm')
      .send({ challengeToken: challenged.body.challengeToken, code });
    expect(confirmed.status).toBe(200);
    const refreshToken = confirmed.body.refreshToken as string;

    // Align refresh-row createdAt with MFA enrollment so the MFA gate allows refresh.
    const stored = prisma._store.refreshTokens[0];
    const mfa = prisma._store.userMfaCredentials[0];
    stored.createdAt = new Date(mfa.enrolledAt.getTime() + 1000);

    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.token).toBeTruthy();

    const payload = JSON.parse(
      Buffer.from(String(refreshed.body.token).split('.')[1], 'base64url').toString('utf8'),
    );
    expect(payload.permissions).toContain('admin.full');
    expect(Array.isArray(payload.permissions)).toBe(true);
    expect(payload.permissions.length).toBeGreaterThan(0);
  });

  it('fails closed for a Primary Owner when the encryption key is absent', async () => {
    app = makeApp(prisma, { mfaEncryptionKey: undefined });
    const response = await login();
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: 'MfaUnavailable',
      messageKey: 'auth.mfa_unavailable',
    });
    expect(prisma._store.refreshTokens).toHaveLength(0);
  });

  it('keeps the existing limited forced-password session before MFA enrollment', async () => {
    user.mustChangePassword = true;
    user.temporaryPasswordExpiresAt = new Date(Date.now() + 60_000);

    const response = await login();

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeTruthy();
    expect(response.body.user.mustChangePassword).toBe(true);
    expect(response.body.mfaRequired).toBeUndefined();
    expect(prisma._store.userMfaCredentials).toHaveLength(0);
  });

  it('keeps a per-user lockout across newly attempted password logins', async () => {
    const enrollmentChallenge = await login();
    const started = await request(app)
      .post('/api/v2/auth/mfa/enroll/start')
      .send({ challengeToken: enrollmentChallenge.body.challengeToken });
    const totp = new OTPAuth.TOTP({
      issuer: 'Mawared',
      label: 'test',
      secret: OTPAuth.Secret.fromBase32(started.body.manualSecret),
    });
    await request(app)
      .post('/api/v2/auth/mfa/enroll/confirm')
      .send({
        challengeToken: enrollmentChallenge.body.challengeToken,
        code: totp.generate(),
      });

    const loginChallenge = await login();
    const validNow = totp.generate();
    const invalidCode = validNow === '000000' ? '000001' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const denied = await request(app)
        .post('/api/v2/auth/mfa/verify')
        .send({
          challengeToken: loginChallenge.body.challengeToken,
          code: invalidCode,
        });
      expect(denied.status).toBe(401);
    }

    const locked = await login();
    expect(locked.status).toBe(429);
    expect(locked.body).toMatchObject({
      code: 'MfaRateLimited',
      messageKey: 'auth.mfa_rate_limited',
    });
    expect(locked.body.challengeToken).toBeUndefined();
  });
});
