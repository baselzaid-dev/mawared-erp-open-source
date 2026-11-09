import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as OTPAuth from 'otpauth';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';
import { PLATFORM_PERMISSIONS } from '../src/platformAuth';

const PLATFORM_SECRET = 'platform-test-signing-secret-distinct-123456789';
const MFA_KEY = Buffer.alloc(32, 17).toString('base64');
const PASSWORD = 'Platform-password-123!';

function platformFixture() {
  const prisma = makeFakePrisma();
  const store = {
    principals: [] as any[],
    mfa: [] as any[],
    refreshTokens: [] as any[],
    audits: [] as any[],
    idempotency: [] as any[],
    companies: [] as any[],
    roles: [] as any[],
    users: [] as any[],
    ownerships: [] as any[],
    exemptions: [] as any[],
  };
  let sequence = 0;
  const id = (prefix: string) => `${prefix}-${++sequence}`;

  (prisma as any).platformPrincipal = {
    findUnique: vi.fn(async ({ where }: any) =>
      store.principals.find((row) =>
        where.id !== undefined ? row.id === where.id : row.normalizedEmail === where.normalizedEmail
      ) ?? null),
    findFirst: vi.fn(async ({ where }: any) =>
      store.principals.find((row) =>
        row.id === where.id && (!where.status || row.status === where.status)
      ) ?? null),
    count: vi.fn(async () => store.principals.length),
    create: vi.fn(async ({ data, select }: any) => {
      const row = {
        id: id('platform'),
        authorizationVersion: 1,
        credentialVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      store.principals.push(row);
      if (!select) return row;
      return Object.fromEntries(
        Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]])
      );
    }),
  };
  (prisma as any).platformMfaCredential = {
    findUnique: vi.fn(async ({ where }: any) =>
      store.mfa.find((row) =>
        where.principalId !== undefined
          ? row.principalId === where.principalId
          : row.challengeTokenHash === where.challengeTokenHash
      ) ?? null),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = store.mfa.find((row) => row.principalId === where.principalId);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const row = {
        state: 'pending',
        secretCiphertext: null,
        pendingSecretCiphertext: null,
        challengeAttempts: 0,
        failedAttempts: 0,
        lockedUntil: null,
        backupCodeHashes: '[]',
        enrolledAt: null,
        lastUsedTimeStep: null,
        ...create,
      };
      store.mfa.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = store.mfa.find((item) => item.principalId === where.principalId);
      Object.assign(row, data);
      return row;
    }),
  };
  (prisma as any).platformRefreshToken = {
    create: vi.fn(async ({ data }: any) => {
      const row = { id: id('prt'), revokedAt: null, createdAt: new Date(), ...data };
      store.refreshTokens.push(row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: any) =>
      store.refreshTokens.find((row) =>
        where.sessionId !== undefined
          ? row.sessionId === where.sessionId
          : row.tokenHash === where.tokenHash
      ) ?? null),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const rows = store.refreshTokens.filter((row) => {
        if (where.id !== undefined && row.id !== where.id) return false;
        if (where.principalId !== undefined && row.principalId !== where.principalId) return false;
        if (where.tokenHash !== undefined && row.tokenHash !== where.tokenHash) return false;
        if (where.revokedAt === null && row.revokedAt !== null) return false;
        if (where.expiresAt?.gt && row.expiresAt <= where.expiresAt.gt) return false;
        return true;
      });
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    }),
  };
  (prisma as any).platformAuditLog = {
    create: vi.fn(async ({ data }: any) => {
      const row = { id: id('paudit'), createdAt: new Date(), ...data };
      store.audits.push(row);
      return row;
    }),
  };
  prisma.$queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
    if (sql.includes('"PlatformPrincipal"') && sql.includes('FOR UPDATE')) {
      const principalId = values[0];
      const row = store.principals.find((item) => item.id === principalId);
      if (!row) return [];
      return [{
        id: row.id,
        email: row.email,
        name: row.name,
        status: row.status,
        permissions: row.permissions,
        authorizationVersion: row.authorizationVersion,
        credentialVersion: row.credentialVersion,
      }];
    }
    if (sql.includes('"PlatformMfaCredential"') && sql.includes('FOR UPDATE')) {
      const principalId = values[0];
      const row = store.mfa.find((item) => item.principalId === principalId);
      return row ? [{ principalId: row.principalId }] : [];
    }
    return [];
  });
  (prisma as any).platformIdempotencyKey = {
    findUnique: vi.fn(async ({ where }: any) =>
      store.idempotency.find((row) =>
        row.principalId === where.principalId_key.principalId &&
        row.key === where.principalId_key.key
      ) ?? null),
    create: vi.fn(async ({ data }: any) => {
      const row = { id: id('idem'), createdAt: new Date(), ...data };
      store.idempotency.push(row);
      return row;
    }),
  };
  prisma.company.create = vi.fn(async ({ data }: any) => {
    const row = { id: id('company'), createdAt: new Date(), updatedAt: new Date(), ...data };
    store.companies.push(row);
    return row;
  });
  prisma.company.findUnique = vi.fn(async ({ where }: any) =>
    store.companies.find((row) =>
      where.id !== undefined ? row.id === where.id : row.code === where.code
    ) ?? null);
  prisma.company.findMany = vi.fn(async () => store.companies);
  prisma.role.create = vi.fn(async ({ data }: any) => {
    const row = { id: id('role'), ...data };
    store.roles.push(row);
    return row;
  });
  prisma.user.create = vi.fn(async ({ data }: any) => {
    const row = { id: id('user'), createdAt: new Date(), updatedAt: new Date(), ...data };
    store.users.push(row);
    return row;
  });
  prisma.loginIdentity.create = vi.fn(async ({ data }: any) => ({ id: id('identity'), ...data }));
  prisma.companyOwnership.create = vi.fn(async ({ data }: any) => {
    const row = {
      id: id('ownership'),
      endedAt: null,
      user: store.users.find((user) => user.id === data.userId),
      ...data,
    };
    store.ownerships.push(row);
    return row;
  });
  prisma.companyOwnership.findFirst = vi.fn(async ({ where }: any) =>
    store.ownerships.find((row) =>
      row.companyId === where.companyId &&
      (!where.userId || row.userId === where.userId) &&
      row.status === (where.status ?? row.status)
    ) ?? null);
  (prisma as any).attendanceExemption = {
    create: vi.fn(async ({ data }: any) => {
      const row = { id: id('exemption'), version: 1, createdAt: new Date(), ...data };
      store.exemptions.push(row);
      return row;
    }),
  };

  return { prisma, store };
}

describe('Platform Owner control plane', () => {
  let fixture: ReturnType<typeof platformFixture>;
  let app: ReturnType<typeof makeApp>;

  beforeEach(async () => {
    fixture = platformFixture();
    fixture.store.principals.push({
      id: 'platform-owner',
      email: 'platform@example.test',
      normalizedEmail: 'platform@example.test',
      password: await bcrypt.hash(PASSWORD, 4),
      name: 'Platform Owner',
      status: 'active',
      permissions: JSON.stringify(Object.values(PLATFORM_PERMISSIONS)),
      authorizationVersion: 1,
      credentialVersion: 1,
    });
    app = makeApp(fixture.prisma, {
      platformJwtSecret: PLATFORM_SECRET,
      mfaEncryptionKey: MFA_KEY,
      platformAuthRateLimitMax: 100,
    });
  });

  async function enrollPlatformOwner() {
    const login = await request(app)
      .post('/api/platform/v1/auth/login')
      .send({ email: 'platform@example.test', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.accessToken).toBeUndefined();

    const started = await request(app)
      .post('/api/platform/v1/auth/mfa/enroll/start')
      .send({ challengeToken: login.body.challengeToken });
    const code = new OTPAuth.TOTP({
      issuer: 'Mawared',
      label: 'platform',
      secret: OTPAuth.Secret.fromBase32(started.body.manualSecret),
    }).generate();
    const confirmed = await request(app)
      .post('/api/platform/v1/auth/mfa/enroll/confirm')
      .send({ challengeToken: login.body.challengeToken, code });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.backupCodes).toHaveLength(10);
    return confirmed.body;
  }

  it('keeps Platform and company authentication boundaries separate', async () => {
    const authenticated = await enrollPlatformOwner();
    const platformMe = await request(app)
      .get('/api/platform/v1/auth/me')
      .set('Authorization', `Bearer ${authenticated.accessToken}`);
    expect(platformMe.status).toBe(200);
    expect(platformMe.body.id).toBe('platform-owner');

    const platformOnCompany = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${authenticated.accessToken}`);
    expect(platformOnCompany.status).toBe(401);

    const companyOnPlatform = await request(app)
      .get('/api/platform/v1/auth/me')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(companyOnPlatform.status).toBe(401);

    const refreshed = await request(app)
      .post('/api/platform/v1/auth/refresh')
      .send({ refreshToken: authenticated.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.mfaVerifiedAt).toBe(authenticated.mfaVerifiedAt);

    const rotatedAccess = await request(app)
      .get('/api/platform/v1/auth/me')
      .set('Authorization', `Bearer ${authenticated.accessToken}`);
    expect(rotatedAccess.status).toBe(401);

    await request(app)
      .post('/api/platform/v1/auth/logout')
      .send({ refreshToken: refreshed.body.refreshToken });
    const loggedOutAccess = await request(app)
      .get('/api/platform/v1/auth/me')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`);
    expect(loggedOutAccess.status).toBe(401);
  });

  it('provisions Company and explicit account-only Primary Owner atomically', async () => {
    const authenticated = await enrollPlatformOwner();
    const payload = {
      name: 'New Company',
      companyCode: 'CMP-NEW',
      primaryOwner: {
        email: 'owner@new.test',
        name: 'New Primary Owner',
      },
    };
    const created = await request(app)
      .post('/api/platform/v1/companies')
      .set('Authorization', `Bearer ${authenticated.accessToken}`)
      .set('Idempotency-Key', 'platform-company-create-001')
      .send(payload);
    expect(created.status).toBe(201);
    expect(created.body.company.code).toBe('CMP-NEW');
    expect(created.body.company.primaryOwner.email).toBe('owner@new.test');
    expect(created.body.credentialDelivery.temporaryPassword).toBeTruthy();
    expect(fixture.store.ownerships[0]).toMatchObject({
      createdByUserId: null,
      createdByPlatformPrincipalId: 'platform-owner',
      isPrimary: true,
    });
    expect(fixture.store.exemptions[0]).toMatchObject({
      employeeId: null,
      reasonCategory: 'account_only_primary_owner',
      createdByPlatformPrincipalId: 'platform-owner',
    });
    expect(fixture.store.audits.at(-1).details).not.toContain('temporaryPassword');

    const retry = await request(app)
      .post('/api/platform/v1/companies')
      .set('Authorization', `Bearer ${authenticated.accessToken}`)
      .set('Idempotency-Key', 'platform-company-create-001')
      .send(payload);
    expect(retry.status).toBe(200);
    expect(retry.body.credentialDelivery).toBeNull();
    expect(retry.body.credentialAlreadyDelivered).toBe(true);
    expect(fixture.store.companies).toHaveLength(1);
  });

  it('rate limits company provisioning after authentication', async () => {
    app = makeApp(fixture.prisma, {
      platformJwtSecret: PLATFORM_SECRET,
      mfaEncryptionKey: MFA_KEY,
      platformAuthRateLimitMax: 100,
      platformProvisionRateLimitMax: 1,
    });
    const authenticated = await enrollPlatformOwner();
    const first = await request(app)
      .post('/api/platform/v1/companies')
      .set('Authorization', `Bearer ${authenticated.accessToken}`)
      .set('Idempotency-Key', 'platform-company-limit-001')
      .send({
        name: 'First Company',
        companyCode: 'CMP-FIRST',
        primaryOwner: { email: 'owner1@example.test', name: 'First Owner' },
      });
    expect(first.status).toBe(201);

    const limited = await request(app)
      .post('/api/platform/v1/companies')
      .set('Authorization', `Bearer ${authenticated.accessToken}`)
      .set('Idempotency-Key', 'platform-company-limit-002')
      .send({
        name: 'Second Company',
        companyCode: 'CMP-SECOND',
        primaryOwner: { email: 'owner2@example.test', name: 'Second Owner' },
      });
    expect(limited.status).toBe(429);
    expect(fixture.store.companies).toHaveLength(1);
  });

  it('rotates an abandoned enrollment secret when a new challenge starts', async () => {
    const firstLogin = await request(app)
      .post('/api/platform/v1/auth/login')
      .send({ email: 'platform@example.test', password: PASSWORD });
    const firstStart = await request(app)
      .post('/api/platform/v1/auth/mfa/enroll/start')
      .send({ challengeToken: firstLogin.body.challengeToken });
    const oldCode = new OTPAuth.TOTP({
      issuer: 'Mawared',
      label: 'platform',
      secret: OTPAuth.Secret.fromBase32(firstStart.body.manualSecret),
    }).generate();

    const secondLogin = await request(app)
      .post('/api/platform/v1/auth/login')
      .send({ email: 'platform@example.test', password: PASSWORD });
    const secondStart = await request(app)
      .post('/api/platform/v1/auth/mfa/enroll/start')
      .send({ challengeToken: secondLogin.body.challengeToken });
    expect(secondStart.body.manualSecret).not.toBe(firstStart.body.manualSecret);

    const oldSecretDenied = await request(app)
      .post('/api/platform/v1/auth/mfa/enroll/confirm')
      .send({ challengeToken: secondLogin.body.challengeToken, code: oldCode });
    expect(oldSecretDenied.status).toBe(401);
  });

  it('invalidates access tokens when credential or MFA state changes', async () => {
    const authenticated = await enrollPlatformOwner();
    fixture.store.principals[0].credentialVersion += 1;
    const credentialChanged = await request(app)
      .get('/api/platform/v1/auth/me')
      .set('Authorization', `Bearer ${authenticated.accessToken}`);
    expect(credentialChanged.status).toBe(401);

    fixture.store.principals[0].credentialVersion -= 1;
    fixture.store.mfa[0].state = 'pending';
    const mfaChanged = await request(app)
      .get('/api/platform/v1/auth/me')
      .set('Authorization', `Bearer ${authenticated.accessToken}`);
    expect(mfaChanged.status).toBe(401);
  });

  it('recovers an idempotent replay after a concurrent unique conflict', async () => {
    const authenticated = await enrollPlatformOwner();
    const payload = {
      name: 'Concurrent Company',
      companyCode: 'CMP-CONCURRENT',
      primaryOwner: {
        email: 'owner@concurrent.test',
        name: 'Concurrent Owner',
      },
    };
    const digest = crypto.createHash('sha256').update(JSON.stringify({
      name: payload.name,
      companyCode: payload.companyCode,
      primaryOwner: {
        email: payload.primaryOwner.email,
        name: payload.primaryOwner.name,
      },
    })).digest('hex');
    fixture.prisma.$transaction = vi.fn(async () => {
      const company = {
        id: 'company-winner',
        code: payload.companyCode,
        name: payload.name,
        createdAt: new Date(),
      };
      const owner = {
        id: 'user-winner',
        email: payload.primaryOwner.email,
        name: payload.primaryOwner.name,
      };
      fixture.store.companies.push(company);
      fixture.store.users.push(owner);
      fixture.store.ownerships.push({
        id: 'ownership-winner',
        companyId: company.id,
        userId: owner.id,
        user: owner,
        isPrimary: true,
        status: 'active',
        endedAt: null,
      });
      fixture.store.idempotency.push({
        id: 'idem-winner',
        principalId: 'platform-owner',
        key: 'platform-company-race-001',
        requestHash: digest,
        companyId: company.id,
      });
      throw Object.assign(new Error('unique conflict'), { code: 'P2002' });
    });

    const replay = await request(app)
      .post('/api/platform/v1/companies')
      .set('Authorization', `Bearer ${authenticated.accessToken}`)
      .set('Idempotency-Key', 'platform-company-race-001')
      .send(payload);

    expect(replay.status).toBe(200);
    expect(replay.body.credentialDelivery).toBeNull();
    expect(replay.body.credentialAlreadyDelivered).toBe(true);
    expect(fixture.store.companies).toHaveLength(1);
  });
});
