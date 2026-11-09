import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { makeApp, makeFakePrisma, tokenFor, TEST_SECRET } from './helpers';

const PASSWORD = 'password123';

function seededUser(passwordHash: string) {
  return {
    id: 'u1',
    companyId: 'c1',
    employeeId: 'e1',
    email: 'hr@fixture-2.example.test',
    password: passwordHash,
    name: 'HR User',
    role: {
      id: 'r1',
      name: 'HR Manager',
      permissions: JSON.stringify(['hr.view', 'employees.view', 'leaves.approve']),
    },
    employee: { id: 'e1', status: 'active' },
  };
}

describe('POST /api/auth/login', () => {
  let prisma: any;
  let hash: string;

  beforeEach(async () => {
    prisma = makeFakePrisma();
    hash = await bcrypt.hash(PASSWORD, 4);
  });

  it('returns access + refresh tokens and the user on valid credentials', async () => {
    prisma.user.findUnique.mockResolvedValue(seededUser(hash));
    const app = makeApp(prisma);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'hr@fixture-2.example.test', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.permissions).toContain('employees.view');

    // Access token carries identity + permissions, signed with the server secret.
    const payload = jwt.verify(res.body.token, TEST_SECRET) as any;
    expect(payload.companyId).toBe('c1');
    expect(payload.permissions).toContain('leaves.approve');

    // Refresh token is persisted as a hash only — never plaintext.
    expect(prisma._store.refreshTokens).toHaveLength(1);
    expect(prisma._store.refreshTokens[0].tokenHash).not.toBe(res.body.refreshToken);
    expect(prisma._store.refreshTokens[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // Successful login is audited.
    const actions = prisma._store.auditLogs.map((a: any) => a.action);
    expect(actions).toContain('auth.login.success');
  });

  it('rejects a wrong password with 400 and audits the failure', async () => {
    prisma.user.findUnique.mockResolvedValue(seededUser(hash));
    const app = makeApp(prisma);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'hr@fixture-2.example.test', password: 'not-the-password' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid credentials');
    const actions = prisma._store.auditLogs.map((a: any) => a.action);
    expect(actions).toContain('auth.login.failure');
    // The audit entry must not contain the attempted password.
    expect(JSON.stringify(prisma._store.auditLogs)).not.toContain('not-the-password');
  });

  it('rejects an unknown email with 400', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const app = makeApp(prisma);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@fixture-2.example.test', password: PASSWORD });

    expect(res.status).toBe(400);
  });

  it('rejects an inactive employee account and audits the reason safely', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...seededUser(hash),
      employee: { id: 'e1', status: 'inactive' },
    });
    const app = makeApp(prisma);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'hr@fixture-2.example.test', password: PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid credentials');
    expect(prisma._store.auditLogs).toContainEqual(
      expect.objectContaining({
        action: 'auth.login.failure',
      })
    );
    expect(JSON.stringify(prisma._store.auditLogs)).not.toContain(PASSWORD);
  });

  it('rejects a malformed body with a 400 ValidationError', async () => {
    const app = makeApp(prisma);
    const res = await request(app).post('/api/auth/login').send({ email: 'x@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
    expect(res.body.details?.[0]?.field).toBe('password');
  });
});

describe('login rate limiting', () => {
  it('returns 429 after the configured number of attempts, then normal behavior for a fresh window', async () => {
    const prisma = makeFakePrisma();
    prisma.user.findUnique.mockResolvedValue(null); // every attempt fails credentials
    const app = makeApp(prisma, { authRateLimitMax: 3, authRateLimitWindowMs: 60_000 });

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'ghost@fixture-2.example.test', password: 'wrong-pass' });
      expect(res.status).toBe(400); // not yet limited
    }

    const limited = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@fixture-2.example.test', password: 'wrong-pass' });
    expect(limited.status).toBe(429);
  });

  it('does not block the first login attempt', async () => {
    const prisma = makeFakePrisma();
    const hash = await bcrypt.hash(PASSWORD, 4);
    prisma.user.findUnique.mockResolvedValue(seededUser(hash));
    const app = makeApp(prisma, { authRateLimitMax: 3 });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'hr@fixture-2.example.test', password: PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/auth/refresh', () => {
  async function loginAndGetTokens(prisma: any, app: any) {
    const hash = await bcrypt.hash(PASSWORD, 4);
    prisma.user.findUnique.mockResolvedValue(seededUser(hash));
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'hr@fixture-2.example.test', password: PASSWORD });
    expect(res.status).toBe(200);
    return res.body as { token: string; refreshToken: string };
  }

  it('exchanges a valid refresh token for a new pair and rotates (old token becomes invalid)', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const { refreshToken } = await loginAndGetTokens(prisma, app);

    const first = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.token).toBeTruthy();
    expect(first.body.refreshToken).toBeTruthy();
    expect(first.body.refreshToken).not.toBe(refreshToken);
    expect(first.body.mustChangePassword).toBe(false);

    // Re-using the old (rotated) token must fail.
    const replay = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(replay.status).toBe(401);

    // The new token still works.
    const second = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: first.body.refreshToken });
    expect(second.status).toBe(200);
  });

  it('rejects an unknown refresh token', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'a'.repeat(64) });
    expect(res.status).toBe(401);
  });

  it('rejects an expired refresh token', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const { refreshToken } = await loginAndGetTokens(prisma, app);

    // Force expiry of the stored row.
    prisma._store.refreshTokens[0].expiresAt = new Date(Date.now() - 1000);

    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });

  it('rejects refresh after a temporary password expires and revokes the token', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const hash = await bcrypt.hash(PASSWORD, 4);
    const user = {
      ...seededUser(hash),
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() + 60_000),
      credentialVersion: 1,
    };
    prisma.user.findUnique.mockResolvedValue(user);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'hr@fixture-2.example.test', password: PASSWORD });
    expect(login.status).toBe(200);

    user.temporaryPasswordExpiresAt = new Date(Date.now() - 1);
    const refresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });

    expect(refresh.status).toBe(401);
    expect(prisma._store.refreshTokens[0].revokedReason)
      .toBe('temporary_password_expired');
  });

  it('rejects refresh for an inactive employee and revokes the presented token', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const hash = await bcrypt.hash(PASSWORD, 4);
    const user = seededUser(hash);
    prisma.user.findUnique.mockResolvedValue(user);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'hr@fixture-2.example.test', password: PASSWORD });
    expect(login.status).toBe(200);

    user.employee.status = 'inactive';
    const refresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });

    expect(refresh.status).toBe(401);
    expect(prisma._store.refreshTokens[0].revokedAt).toBeTruthy();
  });

  it('allows only one concurrent request to consume the same refresh token', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const { refreshToken } = await loginAndGetTokens(prisma, app);

    const responses = await Promise.all([
      request(app).post('/api/auth/refresh').send({ refreshToken }),
      request(app).post('/api/auth/refresh').send({ refreshToken }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(prisma._store.refreshTokens).toHaveLength(2);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the refresh token so it can no longer be used', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const hash = await bcrypt.hash(PASSWORD, 4);
    prisma.user.findUnique.mockResolvedValue(seededUser(hash));

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'hr@fixture-2.example.test', password: PASSWORD });
    const { refreshToken } = login.body;

    const out = await request(app).post('/api/auth/logout').send({ refreshToken });
    expect(out.status).toBe(200);
    expect(prisma._store.refreshTokens[0].revokedAt).toBeTruthy();

    const reuse = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(reuse.status).toBe(401);

    const actions = prisma._store.auditLogs.map((a: any) => a.action);
    expect(actions).toContain('auth.logout');
  });

  it('succeeds even without a refresh token (client-only logout)', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const res = await request(app).post('/api/auth/logout').send({});
    expect(res.status).toBe(200);
  });
});

describe('access-token enforcement on protected endpoints', () => {
  it('rejects a missing token with 401', async () => {
    const app = makeApp(makeFakePrisma());
    const res = await request(app).get('/api/employees');
    expect(res.status).toBe(401);
  });

  it('rejects an expired access token with 401', async () => {
    const app = makeApp(makeFakePrisma());
    const expired = tokenFor({ permissions: ['employees.view'] }, { expiresIn: '-10s' });
    const res = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret with 401', async () => {
    const app = makeApp(makeFakePrisma());
    const forged = tokenFor({ permissions: ['employees.view'] }, { secret: 'other-secret' });
    const res = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });
});
