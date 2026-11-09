import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeApp, makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

const TEST_PASSWORD = 'company-auth-test-only';

function company(id: string, code: string) {
  return { id, code, name: `Safe ${id}`, createdAt: new Date(), updatedAt: new Date() };
}

function user(companyId: string, hash: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `user-${companyId}`,
    companyId,
    employeeId: `employee-${companyId}`,
    email: 'shared@example.test',
    normalizedEmail: 'shared@example.test',
    password: hash,
    name: `User ${companyId}`,
    roleId: `role-${companyId}`,
    role: {
      id: `role-${companyId}`,
      name: 'Employee',
      permissions: '["attendance.view_own"]',
    },
    employee: { id: `employee-${companyId}`, status: 'active' },
    ...overrides,
  };
}

function identity(resolvedUser: any, type = 'email') {
  return {
    id: `identity-${resolvedUser.companyId}-${type}`,
    companyId: resolvedUser.companyId,
    userId: resolvedUser.id,
    type,
    normalizedIdentifier: type === 'email' ? 'shared@example.test' : 'emp-001',
    user: resolvedUser,
  };
}

describe('POST /api/v2/auth/login', () => {
  let prisma: any;
  let hash: string;
  const companies = [company('c1', 'CMP-ONE'), company('c2', 'CMP-TWO')];

  beforeEach(async () => {
    prisma = makeFakePrisma();
    hash = await bcrypt.hash(TEST_PASSWORD, 4);
    prisma.company.findUnique.mockImplementation(async ({ where }: any) =>
      companies.find((item) => item.code === where.code || item.id === where.id) ?? null
    );
  });

  function configureIdentity(users: any[], identifiers = ['shared@example.test', 'emp-001']) {
    prisma.loginIdentity.findUnique.mockImplementation(async ({ where }: any) => {
      const key = where.companyId_normalizedIdentifier;
      const resolvedUser = users.find((item) => item.companyId === key.companyId);
      if (!resolvedUser || !identifiers.includes(key.normalizedIdentifier)) return null;
      return identity(
        resolvedUser,
        key.normalizedIdentifier === 'emp-001' ? 'employee_number' : 'email',
      );
    });
  }

  it.each([
    ['  cmp-one  ', ' Shared@Example.Test ', 'email'],
    ['cmp-one', ' emp-001 ', 'employee_number'],
  ])('authenticates by company plus %s identifier', async (code, identifierValue, type) => {
    const resolvedUser = user('c1', hash);
    configureIdentity([resolvedUser]);

    const response = await request(makeApp(prisma))
      .post('/api/v2/auth/login')
      .send({ companyCode: code, identifier: identifierValue, password: TEST_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeTruthy();
    expect(response.body.company).toEqual({ id: 'c1', code: 'CMP-ONE', name: 'Safe c1' });
    expect(response.body.user.companyId).toBe('c1');
    expect(prisma.company.findUnique).toHaveBeenCalledWith({ where: { code: 'CMP-ONE' } });
    expect(prisma.loginIdentity.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        companyId_normalizedIdentifier: {
          companyId: 'c1',
          normalizedIdentifier: type === 'email' ? 'shared@example.test' : 'emp-001',
        },
      },
    }));

    const payload = jwt.verify(response.body.accessToken, TEST_SECRET) as any;
    expect(payload.companyId).toBe('c1');
    expect(payload.id).toBe('user-c1');
  });

  it('resolves the same email and Employee number independently in two companies', async () => {
    configureIdentity([user('c1', hash), user('c2', hash)]);
    const app = makeApp(prisma);

    for (const [companyCode, expectedCompany] of [['CMP-ONE', 'c1'], ['CMP-TWO', 'c2']]) {
      for (const identifierValue of ['shared@example.test', 'EMP-001']) {
        const response = await request(app)
          .post('/api/v2/auth/login')
          .send({ companyCode, identifier: identifierValue, password: TEST_PASSWORD });
        expect(response.status).toBe(200);
        expect(response.body.user.companyId).toBe(expectedCompany);
      }
    }
  });

  it('returns one indistinguishable failure for wrong company, identity, password, and inactive user', async () => {
    const active = user('c1', hash);
    const inactive = user('c1', hash, { employee: { id: 'employee-c1', status: 'inactive' } });
    const scenarios = [
      { code: 'CMP-MISSING', identifierValue: 'shared@example.test', password: TEST_PASSWORD, users: [active] },
      { code: 'CMP-ONE', identifierValue: 'missing@example.test', password: TEST_PASSWORD, users: [active] },
      { code: 'CMP-ONE', identifierValue: 'shared@example.test', password: 'wrong-value', users: [active] },
      { code: 'CMP-ONE', identifierValue: 'shared@example.test', password: TEST_PASSWORD, users: [inactive] },
      { code: 'BAD--CODE', identifierValue: 'shared@example.test', password: TEST_PASSWORD, users: [active] },
    ];

    const bodies: unknown[] = [];
    for (const scenario of scenarios) {
      prisma.loginIdentity.findUnique.mockReset();
      configureIdentity(scenario.users);
      const response = await request(makeApp(prisma))
        .post('/api/v2/auth/login')
        .send({
          companyCode: scenario.code,
          identifier: scenario.identifierValue,
          password: scenario.password,
        });
      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toMatch(/CMP-|Safe c|shared@example|employee-c1/i);
      bodies.push(response.body);
    }
    const withoutRequestId = (body: any) => {
      const { requestId: _requestId, ...stable } = body;
      return stable;
    };
    expect(bodies.map(withoutRequestId)).toEqual(
      bodies.map(() => withoutRequestId(bodies[0])),
    );
  });

  it('keeps the v2 login under the existing authentication rate limiter', async () => {
    const app = makeApp(prisma, { authRateLimitMax: 2, authRateLimitWindowMs: 60_000 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(app)
        .post('/api/v2/auth/login')
        .send({ companyCode: 'CMP-MISSING', identifier: 'missing', password: TEST_PASSWORD });
      expect(response.status).toBe(401);
    }
    const limited = await request(app)
      .post('/api/v2/auth/login')
      .send({ companyCode: 'CMP-MISSING', identifier: 'missing', password: TEST_PASSWORD });
    expect(limited.status).toBe(429);
  });

  it('stores the web device label on the issued session', async () => {
    configureIdentity([user('c1', hash)]);
    const response = await request(makeApp(prisma))
      .post('/api/v2/auth/login')
      .send({
        companyCode: 'CMP-ONE',
        identifier: 'shared@example.test',
        password: TEST_PASSWORD,
        deviceLabel: 'Mawared Web',
        platform: 'web',
      });

    expect(response.status).toBe(200);
    expect(prisma._store.refreshTokens[0]).toMatchObject({
      deviceLabel: 'Mawared Web',
      platform: 'web',
    });
  });

  it('never returns private database fields in the successful auth projection', async () => {
    configureIdentity([user('c1', hash)]);
    const response = await request(makeApp(prisma))
      .post('/api/v2/auth/login')
      .send({ companyCode: 'CMP-ONE', identifier: 'shared@example.test', password: TEST_PASSWORD });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(hash);
    expect(serialized).not.toMatch(/\bpassword\b|tokenHash|databaseUrl/i);
  });
});

describe('legacy identity compatibility', () => {
  let hash: string;

  beforeEach(async () => {
    hash = await bcrypt.hash(TEST_PASSWORD, 4);
  });

  it('succeeds only for one globally eligible identity', async () => {
    const prisma = makeFakePrisma();
    const resolved = user('c1', hash);
    prisma.loginIdentity.findMany.mockResolvedValue([identity(resolved)]);
    const response = await request(makeApp(prisma))
      .post('/api/auth/login')
      .send({ email: 'shared@example.test', password: TEST_PASSWORD });
    expect(response.status).toBe(200);
    expect(response.body.user.companyId).toBe('c1');
    expect(response.body.company).toBeUndefined();
  });

  it.each([
    ['shared@example.test', 'email'],
    ['EMP-001', 'employee_number'],
  ])('fails generically instead of choosing the first company for %s', async (identifierValue, type) => {
    const prisma = makeFakePrisma();
    const first = user('c1', hash);
    const second = user('c2', hash);
    prisma.loginIdentity.findMany.mockResolvedValue([
      identity(first, type),
      identity(second, type),
    ]);
    const response = await request(makeApp(prisma))
      .post('/api/auth/login')
      .send({ email: identifierValue, password: TEST_PASSWORD });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Invalid credentials',
      message: 'Invalid credentials',
      code: 400,
      requestId: expect.any(String),
    });
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('keeps wrong-password and inactive legacy failures indistinguishable', async () => {
    const activePrisma = makeFakePrisma();
    activePrisma.loginIdentity.findMany.mockResolvedValue([identity(user('c1', hash))]);
    const wrongPassword = await request(makeApp(activePrisma))
      .post('/api/auth/login')
      .send({ email: 'shared@example.test', password: 'wrong-value' });

    const inactivePrisma = makeFakePrisma();
    const inactive = user('c1', hash, { employee: { id: 'employee-c1', status: 'inactive' } });
    inactivePrisma.loginIdentity.findMany.mockResolvedValue([identity(inactive)]);
    const inactiveAccount = await request(makeApp(inactivePrisma))
      .post('/api/auth/login')
      .send({ email: 'shared@example.test', password: TEST_PASSWORD });

    const stableBody = (body: any) => {
      const { requestId: _requestId, ...stable } = body;
      return stable;
    };
    expect(wrongPassword.status).toBe(400);
    expect(inactiveAccount.status).toBe(400);
    expect(stableBody(wrongPassword.body)).toEqual(stableBody(inactiveAccount.body));
    expect(JSON.stringify(inactiveAccount.body)).not.toMatch(/inactive|company|shared@example/i);
  });
});

describe('session tenant binding', () => {
  it('preserves the web device metadata when rotating a refresh token', async () => {
    const prisma = makeFakePrisma();
    const hash = await bcrypt.hash(TEST_PASSWORD, 4);
    const resolved = user('c1', hash);
    prisma.company.findUnique.mockResolvedValue(company('c1', 'CMP-ONE'));
    prisma.loginIdentity.findUnique.mockResolvedValue(identity(resolved));
    prisma.user.findUnique.mockResolvedValue(resolved);
    const app = makeApp(prisma);
    const login = await request(app)
      .post('/api/v2/auth/login')
      .send({
        companyCode: 'CMP-ONE',
        identifier: 'shared@example.test',
        password: TEST_PASSWORD,
        deviceLabel: 'Mawared Web',
        platform: 'web',
      });
    expect(login.status).toBe(200);

    const refresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });

    expect(refresh.status).toBe(200);
    expect(prisma._store.refreshTokens[1]).toMatchObject({
      deviceLabel: 'Mawared Web',
      platform: 'web',
    });
  });

  it('revokes a refresh token when its stored company differs from the User company', async () => {
    const prisma = makeFakePrisma();
    const hash = await bcrypt.hash(TEST_PASSWORD, 4);
    const resolved = user('c1', hash);
    prisma.company.findUnique.mockResolvedValue(company('c1', 'CMP-ONE'));
    prisma.loginIdentity.findUnique.mockResolvedValue(identity(resolved));
    prisma.user.findUnique.mockResolvedValue({ ...resolved, companyId: 'c2' });
    const app = makeApp(prisma);
    const login = await request(app)
      .post('/api/v2/auth/login')
      .send({ companyCode: 'CMP-ONE', identifier: 'shared@example.test', password: TEST_PASSWORD });
    expect(login.status).toBe(200);

    const refresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });
    expect(refresh.status).toBe(401);
    expect(prisma._store.refreshTokens[0].revokedAt).toBeTruthy();
  });

  it('rejects a validly signed token whose User and company binding do not exist', async () => {
    const prisma = makeFakePrisma();
    prisma.user.count.mockResolvedValue(0);
    const response = await request(makeApp(prisma))
      .get('/api/company/current')
      .set('Authorization', `Bearer ${tokenFor({ id: 'user-c1', companyId: 'c2' })}`);
    expect(response.status).toBe(401);
    expect(prisma.company.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a token whose Employee claim is not bound to the same User and company', async () => {
    const prisma = makeFakePrisma();
    prisma.user.count.mockImplementation(async ({ where }: any) =>
      where.id === 'user-c1' &&
      where.companyId === 'c1' &&
      where.employeeId === 'employee-c1' ? 1 : 0
    );
    const response = await request(makeApp(prisma))
      .get('/api/company/current')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'user-c1',
        companyId: 'c1',
        employeeId: 'employee-c2',
      })}`);

    expect(response.status).toBe(401);
    expect(prisma.user.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ employeeId: 'employee-c2' }),
    }));
  });

  it('returns auth and company identity only from the authenticated tenant', async () => {
    const prisma = makeFakePrisma();
    const boundCompany = company('c1', 'CMP-ONE');
    prisma.user.findFirst.mockResolvedValue({
      ...user('c1', 'unused'),
      company: boundCompany,
    });
    prisma.company.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'c1' ? boundCompany : null
    );
    const app = makeApp(prisma);
    const authorization = `Bearer ${tokenFor({ id: 'user-c1', companyId: 'c1' })}`;

    const me = await request(app).get('/api/auth/me').set('Authorization', authorization);
    expect(me.status).toBe(200);
    expect(me.body.company).toEqual({ id: 'c1', code: 'CMP-ONE', name: 'Safe c1' });

    const current = await request(app)
      .get('/api/company/current?companyId=c2')
      .set('Authorization', authorization);
    expect(current.status).toBe(200);
    expect(current.body.id).toBe('c1');
    expect(prisma.company.findUnique).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'c1' },
    }));
  });
});
