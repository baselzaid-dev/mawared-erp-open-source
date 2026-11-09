import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

const permissions = {
  hr: ['salary.view_company', 'salary.manage'],
  hrOwner: ['salary.view_company', 'salary.manage', 'salary.view_owner'],
  finance: ['salary.view_company'],
  admin: ['admin.full'],
};

function employee(options: {
  id?: string;
  companyId?: string;
  owner?: boolean;
  status?: string;
  joiningDate?: string;
} = {}) {
  return {
    id: options.id ?? 'emp-1',
    companyId: options.companyId ?? 'c1',
    employeeNum: 'EMP-001',
    jobTitle: 'Engineer',
    joiningDate: new Date(options.joiningDate ?? '2024-01-01T00:00:00.000Z'),
    status: options.status ?? 'active',
    department: { name: 'Engineering' },
    user: {
      id: options.owner ? 'owner-user' : 'employee-user',
      name: 'Test Employee',
      role: { permissions: JSON.stringify(options.owner ? ['admin.full'] : []) },
    },
  };
}

function salaryRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'salary-existing',
    companyId: 'c1',
    employeeId: 'emp-1',
    baseSalary: '1234.50',
    currency: 'SAR',
    effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
    effectiveTo: null,
    createdByUserId: 'hr-1',
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const auth = (perms: string[], companyId = 'c1') =>
  `Bearer ${tokenFor({ id: 'actor-1', companyId, permissions: perms })}`;

describe('Sprint 6A salary API', () => {
  it('returns null instead of a fabricated zero when salary is not set', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employee());

    const res = await request(makeApp(prisma))
      .get('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.hr));

    expect(res.status).toBe(200);
    expect(res.body.currentSalary).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('baseSalary');
  });

  it('returns current salary as a two-decimal string with a safe employee shape', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employee());
    prisma._store.salaryRecords.push(salaryRecord());

    const res = await request(makeApp(prisma))
      .get('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.hr));

    expect(res.status).toBe(200);
    expect(res.body.currentSalary.baseSalary).toBe('1234.50');
    expect(res.body.currentSalary.currency).toBe('SAR');
    expect(Object.keys(res.body.employee).sort()).toEqual(
      ['departmentName', 'employeeNum', 'id', 'jobTitle', 'name'].sort()
    );
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|permissions|email/i);
  });

  it('does not treat a future salary as current before its effective date', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employee());
    prisma._store.salaryRecords.push(
      salaryRecord({ effectiveFrom: new Date('2099-01-01T00:00:00.000Z') })
    );

    const res = await request(makeApp(prisma))
      .get('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.hr));

    expect(res.status).toBe(200);
    expect(res.body.currentSalary).toBeNull();
  });

  it('returns salary history newest first', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employee());
    prisma._store.salaryRecords.push(
      salaryRecord({ id: 'older', effectiveFrom: new Date('2024-01-01T00:00:00.000Z') }),
      salaryRecord({ id: 'newer', effectiveFrom: new Date('2025-01-01T00:00:00.000Z') })
    );

    const res = await request(makeApp(prisma))
      .get('/api/employees/emp-1/salary/history')
      .set('Authorization', auth(permissions.hr));

    expect(res.status).toBe(200);
    expect(res.body.history.map((row: any) => row.id)).toEqual(['newer', 'older']);
  });

  it('closes the previous open record and creates a new immutable history row', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employee());
    prisma._store.salaryRecords.push(
      salaryRecord({ effectiveFrom: new Date('2024-01-01T00:00:00.000Z') })
    );

    const res = await request(makeApp(prisma))
      .post('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.hr))
      .send({ baseSalary: '2500.25', currency: 'SAR', effectiveFrom: '2025-01-01' });

    expect(res.status).toBe(201);
    expect(res.body.createdSalary.baseSalary).toBe('2500.25');
    expect(prisma._store.salaryRecords).toHaveLength(2);
    expect(prisma._store.salaryRecords[0].effectiveTo.toISOString().slice(0, 10)).toBe(
      '2024-12-31'
    );
    expect(prisma._store.salaryRecords[0].baseSalary).toBe('1234.50');
  });

  it('rejects duplicate or non-increasing effective dates with 409', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employee());
    prisma._store.salaryRecords.push(salaryRecord());

    const res = await request(makeApp(prisma))
      .post('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.hr))
      .send({ baseSalary: '2500.00', currency: 'SAR', effectiveFrom: '2025-01-01' });

    expect(res.status).toBe(409);
    expect(prisma._store.salaryRecords).toHaveLength(1);
  });

  it('rejects a salary effective before joining date', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employee({ joiningDate: '2025-06-01' }));

    const res = await request(makeApp(prisma))
      .post('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.hr))
      .send({ baseSalary: '2500.00', currency: 'SAR', effectiveFrom: '2025-05-01' });

    expect(res.status).toBe(400);
    expect(prisma._store.salaryRecords).toHaveLength(0);
  });

  it('blocks salary changes for inactive employees', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employee({ status: 'inactive' }));

    const res = await request(makeApp(prisma))
      .post('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.hr))
      .send({ baseSalary: '2500.00', currency: 'SAR', effectiveFrom: '2025-01-01' });

    expect(res.status).toBe(409);
  });

  it.each([
    { baseSalary: '-1.00', currency: 'SAR', effectiveFrom: '2025-01-01' },
    { baseSalary: '1.234', currency: 'SAR', effectiveFrom: '2025-01-01' },
    { baseSalary: '10000000.01', currency: 'SAR', effectiveFrom: '2025-01-01' },
    { baseSalary: '2500.00', currency: 'USD', effectiveFrom: '2025-01-01' },
    { baseSalary: '2500.00', currency: 'SAR', effectiveFrom: '2025-02-30' },
    { baseSalary: '2500.00', currency: 'SAR', effectiveFrom: '2025-01-01', companyId: 'c2' },
  ])('rejects unsafe salary request %#', async (body) => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employee());

    const res = await request(makeApp(prisma))
      .post('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.hr))
      .send(body);

    expect(res.status).toBe(400);
    expect(prisma._store.salaryRecords).toHaveLength(0);
  });

  it('allows HR with salary view-owner to read and manage owner salary', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employee({ owner: true }));

    const read = await request(makeApp(prisma))
      .get('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.hrOwner));
    const create = await request(makeApp(prisma))
      .post('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.hrOwner))
      .send({ baseSalary: '2500.00', currency: 'SAR', effectiveFrom: '2025-01-01' });

    expect(read.status).toBe(200);
    expect(create.status).toBe(201);
  });

  it('does not let admin-full alone read or manage an owner salary', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employee({ owner: true }));
    const app = makeApp(prisma);

    const read = await request(app)
      .get('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.admin));
    const create = await request(app)
      .post('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.admin))
      .send({ baseSalary: '2500.00', currency: 'SAR', effectiveFrom: '2025-01-01' });

    expect(read.status).toBe(404);
    expect(create.status).toBe(404);
  });

  it('allows admin-full to manage a non-owner salary', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employee());

    const res = await request(makeApp(prisma))
      .post('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.admin))
      .send({ baseSalary: '2500.00', currency: 'SAR', effectiveFrom: '2025-01-01' });

    expect(res.status).toBe(201);
  });

  it('allows Finance read-only access to non-owner salary', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employee());
    const app = makeApp(prisma);

    const read = await request(app)
      .get('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.finance));
    const create = await request(app)
      .post('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.finance))
      .send({ baseSalary: '2500.00', currency: 'SAR', effectiveFrom: '2025-01-01' });

    expect(read.status).toBe(200);
    expect(create.status).toBe(403);
  });

  it.each([['Employee'], ['Department Manager'], ['Accountant']])(
    'blocks direct salary access for %s',
    async () => {
      const prisma = makeFakePrisma();
      prisma.employee.findFirst.mockResolvedValue(employee());

      const res = await request(makeApp(prisma))
        .get('/api/employees/emp-1/salary')
        .set('Authorization', auth([]));

      expect(res.status).toBe(403);
    }
  );

  it('returns a safe 404 for a cross-company or hidden target', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(null);

    const res = await request(makeApp(prisma))
      .get('/api/employees/other-company/salary')
      .set('Authorization', auth(permissions.hr));

    expect(res.status).toBe(404);
  });

  it('audits read, history, and create without recording salary amounts', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employee());
    const app = makeApp(prisma);

    await request(app)
      .get('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.hr));
    await request(app)
      .get('/api/employees/emp-1/salary/history')
      .set('Authorization', auth(permissions.hr));
    await request(app)
      .post('/api/employees/emp-1/salary')
      .set('Authorization', auth(permissions.hr))
      .send({ baseSalary: '9876.54', currency: 'SAR', effectiveFrom: '2025-01-01' });

    expect(prisma._store.auditLogs.map((row: any) => row.action)).toEqual([
      'salary.read',
      'salary.history.read',
      'salary.record.create',
    ]);
    expect(prisma._store.auditLogs.map((row: any) => row.details).join(' ')).not.toContain(
      '9876.54'
    );
  });

  it('keeps salary out of the general employee list response', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findMany.mockResolvedValue([employee()]);

    const res = await request(makeApp(prisma))
      .get('/api/employees')
      .set('Authorization', auth(['employees.view']));

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    // Credential flags like mustChangePassword are allowed; raw password/salary payloads are not.
    expect(body).not.toMatch(/salary|baseSalary|permissions/i);
    expect(body).not.toMatch(/"password"\s*:/);
  });
});
