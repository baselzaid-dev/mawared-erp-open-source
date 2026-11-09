import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

const employeeCreateBody = (overrides: Record<string, unknown> = {}) => ({
  email: 'New.Person@Example.test',
  password: 'test-only-value',
  name: 'New Person',
  roleId: 'role-employee',
  employeeNum: ' emp-101 ',
  jobTitle: 'Engineer',
  joiningDate: '2026-07-01',
  ...overrides,
});

describe('transactional LoginIdentity maintenance', () => {
  it('creates normalized profile fields and both identities with the employee account', async () => {
    const prisma = makeFakePrisma();
    prisma.role.findFirst.mockResolvedValue({
      id: 'role-employee',
      companyId: 'c1',
      permissions: '[]',
    });

    const response = await request(makeApp(prisma))
      .post('/api/employees')
      .set('Authorization', `Bearer ${tokenFor({ companyId: 'c1', permissions: ['employees.create'] })}`)
      .send(employeeCreateBody());

    expect(response.status).toBe(200);
    expect(prisma.employee.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyId: 'c1',
        employeeNum: 'emp-101',
        normalizedEmployeeNum: 'EMP-101',
      }),
    }));
    expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyId: 'c1',
        email: 'New.Person@Example.test',
        normalizedEmail: 'new.person@example.test',
      }),
    }));
    expect(prisma.loginIdentity.create).toHaveBeenCalledTimes(2);
    expect(prisma._store.loginIdentities.map((row: any) => row.normalizedIdentifier).sort())
      .toEqual(['emp-101', 'new.person@example.test']);
    expect(JSON.stringify(prisma._store.loginIdentities)).not.toMatch(/password/i);
  });

  it('returns 409 before the transaction for a company-local identity collision', async () => {
    const prisma = makeFakePrisma();
    prisma.loginIdentity.findFirst.mockResolvedValue({ id: 'reserved' });

    const response = await request(makeApp(prisma))
      .post('/api/employees')
      .set('Authorization', `Bearer ${tokenFor({ companyId: 'c1', permissions: ['employees.create'] })}`)
      .send(employeeCreateBody());

    expect(response.status).toBe(409);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('allows the same normalized identifiers when the reservation belongs to another company', async () => {
    const prisma = makeFakePrisma();
    prisma.loginIdentity.findFirst.mockImplementation(async ({ where }: any) =>
      where.companyId === 'c2' ? { id: 'foreign-reservation' } : null
    );
    prisma.role.findFirst.mockResolvedValue({
      id: 'role-employee',
      companyId: 'c1',
      permissions: '[]',
    });

    const response = await request(makeApp(prisma))
      .post('/api/employees')
      .set('Authorization', `Bearer ${tokenFor({ companyId: 'c1', permissions: ['employees.create'] })}`)
      .send(employeeCreateBody());

    expect(response.status).toBe(200);
    expect(prisma.loginIdentity.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: 'c1' }),
    }));
  });

  it('returns a controlled conflict when identity creation fails inside the transaction', async () => {
    const prisma = makeFakePrisma();
    prisma.role.findFirst.mockResolvedValue({
      id: 'role-employee',
      companyId: 'c1',
      permissions: '[]',
    });
    prisma.loginIdentity.create.mockRejectedValue({ code: 'P2002' });

    const response = await request(makeApp(prisma))
      .post('/api/employees')
      .set('Authorization', `Bearer ${tokenFor({ companyId: 'c1', permissions: ['employees.create'] })}`)
      .send(employeeCreateBody());

    expect(response.status).toBe(409);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma._store.auditLogs).toHaveLength(0);
    expect(prisma._store.loginIdentities).toHaveLength(0);
  });

  it('rejects a client-supplied companyId instead of trusting it', async () => {
    const prisma = makeFakePrisma();
    const response = await request(makeApp(prisma))
      .post('/api/employees')
      .set('Authorization', `Bearer ${tokenFor({ companyId: 'c1', permissions: ['employees.create'] })}`)
      .send(employeeCreateBody({ companyId: 'c2' }));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('ValidationError');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('preserves identity reservations on deactivation and restores them on reactivation', async () => {
    const prisma = makeFakePrisma();
    const employee = {
      id: 'employee-1',
      companyId: 'c1',
      employeeNum: 'EMP-101',
      status: 'active',
      user: {
        id: 'user-1',
        email: 'person@example.test',
        role: { permissions: '[]' },
      },
    };
    prisma.employee.findFirst.mockImplementation(async () => employee);
    const authorization = `Bearer ${tokenFor({
      companyId: 'c1',
      employeeId: 'manager-employee',
      permissions: ['employees.manage'],
    })}`;
    const app = makeApp(prisma);

    const deactivated = await request(app)
      .post('/api/employees/employee-1/deactivate')
      .set('Authorization', authorization);
    expect(deactivated.status).toBe(200);
    expect(prisma.loginIdentity.update).not.toHaveBeenCalled();
    expect(prisma.loginIdentity.create).not.toHaveBeenCalled();

    employee.status = 'inactive';
    prisma.loginIdentity.findMany.mockResolvedValue([
      { id: 'identity-email', type: 'email' },
      { id: 'identity-number', type: 'employee_number' },
    ]);
    const reactivated = await request(app)
      .post('/api/employees/employee-1/reactivate')
      .set('Authorization', authorization);
    expect(reactivated.status).toBe(200);
    expect(prisma.loginIdentity.update).toHaveBeenCalledTimes(4);
    expect(prisma.employee.update).toHaveBeenLastCalledWith({
      where: { id: 'employee-1' },
      data: { status: 'active' },
    });
  });
});
