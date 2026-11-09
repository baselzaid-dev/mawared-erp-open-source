import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

const staffRole = {
  id: 'r-employee',
  companyId: 'c1',
  name: 'Employee',
  permissions: JSON.stringify(['attendance.clock']),
};

const hrRole = {
  id: 'r-hr',
  companyId: 'c1',
  name: 'HR Manager',
  permissions: JSON.stringify(['hr.manage', 'employees.update']),
};

const managerRole = {
  id: 'r-manager',
  companyId: 'c1',
  name: 'Department Manager',
  permissions: JSON.stringify(['employees.view_department', 'attendance.view_department']),
};

const ownerRole = {
  id: 'r-owner',
  companyId: 'c1',
  name: 'Admin',
  permissions: JSON.stringify(['admin.full']),
};

const employeeFixture = (overrides: Record<string, unknown> = {}) => ({
  id: 'e1',
  companyId: 'c1',
  employeeNum: 'E-001',
  jobTitle: 'Engineer',
  joiningDate: new Date('2025-01-10T00:00:00.000Z'),
  status: 'active',
  departmentId: 'd1',
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-01-01T00:00:00.000Z'),
  department: { id: 'd1', name: 'Engineering' },
  user: {
    id: 'u-staff',
    name: 'Staff Member',
    email: 'staff@example.com',
    roleId: staffRole.id,
    role: staffRole,
  },
  ...overrides,
});

const updatePayload = (overrides: Record<string, unknown> = {}) => ({
  name: 'Staff Member',
  email: 'staff@example.com',
  employeeNum: 'E-001',
  jobTitle: 'Engineer',
  joiningDate: '2025-01-10',
  departmentId: 'd1',
  roleId: staffRole.id,
  ...overrides,
});

describe('PUT /api/employees/:id', () => {
  it('requires employees.update', async () => {
    const app = makeApp(makeFakePrisma());
    const res = await request(app)
      .put('/api/employees/e1')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['employees.view'] })}`)
      .send({ name: 'Updated' });

    expect(res.status).toBe(403);
  });

  it('rejects non-editable fields and does not call the database', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const res = await request(app)
      .put('/api/employees/e1')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['employees.update'] })}`)
      .send({ ...updatePayload(), password: true, salary: 100 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/[\u0600-\u06ff]/);
    expect(prisma.employee.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    [updatePayload({ email: 'not-an-email' }), 'email'],
    [updatePayload({ joiningDate: '2026-02-30' }), 'joiningDate'],
  ])('returns Arabic validation for invalid %s', async (payload, field) => {
    const app = makeApp(makeFakePrisma());
    const res = await request(app)
      .put('/api/employees/e1')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['employees.update'] })}`)
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/[\u0600-\u06ff]/);
    expect(res.body.details.some((item: any) => item.field === field)).toBe(true);
  });

  it('returns 404 for an employee outside the requester company', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const res = await request(app)
      .put('/api/employees/e-other')
      .set('Authorization', `Bearer ${tokenFor({ companyId: 'c1', permissions: ['employees.update'] })}`)
      .send(updatePayload({ name: 'Updated' }));

    expect(res.status).toBe(404);
    expect(prisma.employee.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'e-other', companyId: 'c1' },
    }));
  });

  it('rejects duplicate email and employee number without updating', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValueOnce(employeeFixture());
    prisma.loginIdentity.findFirst.mockResolvedValue({ id: 'identity-existing' });
    const app = makeApp(prisma);
    const token = tokenFor({ permissions: ['employees.update'] });

    const emailRes = await request(app)
      .put('/api/employees/e1')
      .set('Authorization', `Bearer ${token}`)
      .send(updatePayload({ email: 'existing@example.com' }));
    expect(emailRes.status).toBe(409);

    prisma.employee.findFirst.mockResolvedValueOnce(employeeFixture());
    const numberRes = await request(app)
      .put('/api/employees/e1')
      .set('Authorization', `Bearer ${token}`)
      .send(updatePayload({ employeeNum: 'E-999' }));
    expect(numberRes.status).toBe(409);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects roles and departments from another company', async () => {
    const token = tokenFor({ permissions: ['employees.update'] });

    const rolePrisma = makeFakePrisma();
    rolePrisma.employee.findFirst.mockResolvedValue(employeeFixture());
    const roleRes = await request(makeApp(rolePrisma))
      .put('/api/employees/e1')
      .set('Authorization', `Bearer ${token}`)
      .send(updatePayload({ roleId: 'foreign-role' }));
    expect(roleRes.status).toBe(400);

    const departmentPrisma = makeFakePrisma();
    departmentPrisma.employee.findFirst.mockResolvedValue(employeeFixture());
    const departmentRes = await request(makeApp(departmentPrisma))
      .put('/api/employees/e1')
      .set('Authorization', `Bearer ${token}`)
      .send(updatePayload({ departmentId: 'foreign-department' }));
    expect(departmentRes.status).toBe(400);
  });

  it('blocks assigning a role with capabilities the actor cannot grant', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employeeFixture());
    prisma.role.findFirst.mockResolvedValue({
      id: 'r-finance',
      companyId: 'c1',
      name: 'Finance Manager',
      permissions: JSON.stringify(['finance.manage', 'salary.manage']),
    });

    const res = await request(makeApp(prisma))
      .put('/api/employees/e1')
      .set('Authorization', `Bearer ${tokenFor({ employeeId: 'e-hr', permissions: [
        'employees.update',
        'employees.permissions.manage',
        'permissions.manage_company',
      ] })}`)
      .send(updatePayload({ roleId: 'r-finance' }));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('RoleCapabilityNotGrantable');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('blocks changing an equal company permission manager without peer authority', async () => {
    const prisma = makeFakePrisma();
    const peerRole = {
      id: 'r-peer',
      companyId: 'c1',
      name: 'Company Permission Manager',
      permissions: JSON.stringify([
        'employees.permissions.manage',
        'permissions.manage_company',
      ]),
    };
    prisma.employee.findFirst.mockResolvedValue(employeeFixture({
      user: {
        id: 'u-peer',
        name: 'Peer Manager',
        email: 'peer@example.com',
        roleId: peerRole.id,
        role: peerRole,
      },
    }));
    prisma.user.findFirst.mockResolvedValue({
      id: 'u-peer',
      companyId: 'c1',
      employeeId: 'e-peer',
      name: 'Peer Manager',
      authorizationVersion: 4,
      role: peerRole,
      employee: { departmentId: 'd1', status: 'active' },
    });
    prisma.role.findFirst.mockResolvedValue(staffRole);

    const res = await request(makeApp(prisma))
      .put('/api/employees/e1')
      .set('Authorization', `Bearer ${tokenFor({ employeeId: 'e-actor', permissions: [
        'employees.update',
        'employees.permissions.manage',
        'permissions.manage_company',
        'attendance.clock',
      ] })}`)
      .send(updatePayload({ email: 'peer@example.com', roleId: staffRole.id }));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('RoleCapabilityNotGrantable');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('updates Employee and User atomically, audits field names, and returns a safe shape', async () => {
    const prisma = makeFakePrisma();
    const current = employeeFixture();
    prisma.employee.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === 'e1' && typeof where.id === 'string' ? current : null
    );
    prisma.user.findFirst.mockResolvedValue({
      id: 'u-staff',
      companyId: 'c1',
      employeeId: 'e1',
      name: 'Staff Member',
      authorizationVersion: 1,
      role: staffRole,
      employee: { departmentId: 'd1', status: 'active' },
    });
    prisma.role.findFirst.mockResolvedValue(hrRole);
    prisma.department.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === 'd2' ? { id: 'd2', companyId: 'c1', name: 'People' } : null
    );
    const app = makeApp(prisma);

    const res = await request(app)
      .put('/api/employees/e1')
      .set('Authorization', `Bearer ${tokenFor({ employeeId: 'e-hr', permissions: [
        'employees.update',
        'hr.view',
        'hr.manage',
        'employees.permissions.manage',
        'permissions.manage_company',
      ] })}`)
      .send(updatePayload({
        name: 'Updated Staff',
        email: 'updated@example.com',
        employeeNum: 'E-002',
        jobTitle: 'Senior Engineer',
        joiningDate: '2025-02-15',
        departmentId: 'd2',
        roleId: hrRole.id,
      }));

    expect(res.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.employee.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'e1' },
      data: expect.objectContaining({
        employeeNum: 'E-002',
        normalizedEmployeeNum: 'E-002',
        jobTitle: 'Senior Engineer',
        departmentId: 'd2',
      }),
    }));
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'u-staff' },
      data: {
        name: 'Updated Staff',
        email: 'updated@example.com',
        normalizedEmail: 'updated@example.com',
        roleId: hrRole.id,
      },
    }));
    expect(res.body.user.roleName).toBe('HR Manager');
    expect(res.body.department).toEqual({ id: 'd2', name: 'People' });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('permissions');

    const audit = prisma._store.auditLogs.at(-1);
    expect(audit.action).toBe('employee.update');
    const details = JSON.parse(audit.details);
    expect(details).toEqual({
      employeeId: 'e1',
      changedFields: ['name', 'roleId', 'employeeNum', 'jobTitle', 'joiningDate', 'departmentId'],
    });
    expect(audit.details).not.toContain('updated@example.com');
  });

  it('allows admin.full to update a non-owner employee', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employeeFixture());
    const res = await request(makeApp(prisma))
      .put('/api/employees/e1')
      .set('Authorization', `Bearer ${tokenFor({ employeeId: 'e-owner', permissions: ['admin.full'] })}`)
      .send(updatePayload({ name: 'Updated by Admin' }));

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { name: 'Updated by Admin' },
    }));
  });

  it('hides the owner from a non-HR updater', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employeeFixture({
      id: 'e-owner',
      user: { id: 'u-owner', name: 'Owner', email: 'owner@example.com', roleId: ownerRole.id, role: ownerRole },
    }));
    const res = await request(makeApp(prisma))
      .put('/api/employees/e-owner')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['employees.update'] })}`)
      .send(updatePayload({
        name: 'Changed',
        email: 'owner@example.com',
        employeeNum: 'E-001',
        roleId: ownerRole.id,
      }));

    expect(res.status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('preserves HR visibility for safe non-role owner updates', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employeeFixture({
      id: 'e-owner',
      user: { id: 'u-owner', name: 'Owner', email: 'owner@example.com', roleId: ownerRole.id, role: ownerRole },
    }));
    const res = await request(makeApp(prisma))
      .put('/api/employees/e-owner')
      .set('Authorization', `Bearer ${tokenFor({ employeeId: 'e-hr', permissions: ['employees.update', 'hr.view'] })}`)
      .send(updatePayload({
        name: 'Owner Updated',
        email: 'owner@example.com',
        roleId: ownerRole.id,
      }));

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { name: 'Owner Updated' },
    }));
  });

  it('blocks owner role changes and self-demotion', async () => {
    const ownerPrisma = makeFakePrisma();
    ownerPrisma.employee.findFirst.mockResolvedValue(employeeFixture({
      id: 'e-owner',
      user: { id: 'u-owner', name: 'Owner', email: 'owner@example.com', roleId: ownerRole.id, role: ownerRole },
    }));
    ownerPrisma.role.findFirst.mockResolvedValue(staffRole);
    const ownerRes = await request(makeApp(ownerPrisma))
      .put('/api/employees/e-owner')
      .set('Authorization', `Bearer ${tokenFor({ employeeId: 'e-hr', permissions: ['employees.update', 'hr.view'] })}`)
      .send(updatePayload({
        name: 'Owner',
        email: 'owner@example.com',
        roleId: staffRole.id,
      }));
    expect(ownerRes.status).toBe(403);

    const selfPrisma = makeFakePrisma();
    selfPrisma.employee.findFirst.mockResolvedValue(employeeFixture());
    selfPrisma.role.findFirst.mockResolvedValue(hrRole);
    const selfRes = await request(makeApp(selfPrisma))
      .put('/api/employees/e1')
      .set('Authorization', `Bearer ${tokenFor({ employeeId: 'e1', permissions: ['employees.update'] })}`)
      .send(updatePayload({ roleId: hrRole.id }));
    expect(selfRes.status).toBe(403);
  });

  it('does not allow assigning admin.full through employee editing', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findFirst.mockResolvedValue(employeeFixture());
    prisma.role.findFirst.mockResolvedValue(ownerRole);
    const res = await request(makeApp(prisma))
      .put('/api/employees/e1')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['admin.full'] })}`)
      .send(updatePayload({ roleId: ownerRole.id }));

    expect(res.status).toBe(403);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('department APIs', () => {
  const department = {
    id: 'd1',
    companyId: 'c1',
    name: 'Engineering',
    managerId: 'u-manager',
    manager: { id: 'u-manager', name: 'Manager' },
    _count: { employees: 3 },
  };

  it('returns safe company-scoped role options for employee forms', async () => {
    const prisma = makeFakePrisma();
    prisma.role.findMany.mockResolvedValue([
      { id: 'r1', name: 'Employee', permissions: JSON.stringify(['attendance.clock']) },
    ]);
    const res = await request(makeApp(prisma))
      .get('/api/roles')
      .set('Authorization', `Bearer ${tokenFor({ companyId: 'c1' })}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'r1', name: 'Employee' }]);
    expect(prisma.role.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'c1' },
    }));
    expect(JSON.stringify(res.body)).not.toContain('permissions');
  });

  it('denies an ordinary employee and returns company departments to HR', async () => {
    const denied = await request(makeApp(makeFakePrisma()))
      .get('/api/departments')
      .set('Authorization', `Bearer ${tokenFor({ permissions: [] })}`);
    expect(denied.status).toBe(403);

    const prisma = makeFakePrisma();
    prisma.department.findMany.mockResolvedValue([department]);
    const allowed = await request(makeApp(prisma))
      .get('/api/departments')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['hr.manage'] })}`);
    expect(allowed.status).toBe(200);
    expect(prisma.department.findMany.mock.calls[0][0].where).toEqual({ companyId: 'c1' });
    expect(allowed.body).toEqual([{ id: 'd1', name: 'Engineering', managerId: 'u-manager', managerName: 'Manager', activeEmployeeCount: 3 }]);
    expect(JSON.stringify(allowed.body)).not.toContain('permissions');
  });

  it('scopes a manager to departments they manage', async () => {
    const prisma = makeFakePrisma();
    prisma.department.findMany.mockResolvedValue([department]);
    const res = await request(makeApp(prisma))
      .get('/api/departments')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-manager', permissions: ['employees.view_department'] })}`);

    expect(res.status).toBe(200);
    expect(prisma.department.findMany.mock.calls[0][0].where).toEqual({
      companyId: 'c1',
      managerId: 'u-manager',
    });
  });

  it('lists only active, suitable manager candidates with safe fields', async () => {
    const prisma = makeFakePrisma();
    prisma.user.findMany.mockResolvedValue([
      { id: 'u-manager', name: 'Manager', role: managerRole, employee: { id: 'e-manager', departmentId: 'd1', status: 'active' } },
      { id: 'u-owner', name: 'Owner', role: ownerRole, employee: { id: 'e-owner', departmentId: null, status: 'active' } },
      { id: 'u-staff', name: 'Staff', role: staffRole, employee: { id: 'e-staff', departmentId: null, status: 'active' } },
    ]);
    const res = await request(makeApp(prisma))
      .get('/api/departments/manager-candidates')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['hr.manage'] })}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{
      userId: 'u-manager',
      employeeId: 'e-manager',
      name: 'Manager',
      roleName: 'Department Manager',
      departmentId: 'd1',
    }]);
    expect(JSON.stringify(res.body)).not.toMatch(/email|password|permissions/);
  });

  it('requires HR management permission for manager candidates and mutations', async () => {
    const token = tokenFor({ permissions: ['employees.view'] });
    const app = makeApp(makeFakePrisma());
    const candidates = await request(app).get('/api/departments/manager-candidates').set('Authorization', `Bearer ${token}`);
    const create = await request(app).post('/api/departments').set('Authorization', `Bearer ${token}`).send({ name: 'New' });
    const update = await request(app).put('/api/departments/d1').set('Authorization', `Bearer ${token}`).send({ name: 'Updated' });

    expect(candidates.status).toBe(403);
    expect(create.status).toBe(403);
    expect(update.status).toBe(403);
  });

  it('creates a department with a validated manager and audit record', async () => {
    const prisma = makeFakePrisma();
    prisma.department.findFirst.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue({
      id: 'u-manager',
      name: 'Manager',
      companyId: 'c1',
      role: managerRole,
      employee: { id: 'e-manager', departmentId: null, status: 'active' },
    });
    const res = await request(makeApp(prisma))
      .post('/api/departments')
      .set('Authorization', `Bearer ${tokenFor({ permissions: [
        'hr.manage',
        'employees.permissions.manage',
        'permissions.manage_company',
      ] })}`)
      .send({ name: 'New Department', managerId: 'u-manager' });

    expect(res.status).toBe(201);
    expect(prisma.department.create).toHaveBeenCalledWith({
      data: { companyId: 'c1', name: 'New Department', managerId: 'u-manager' },
    });
    expect(res.body.managerName).toBe('Manager');
    expect(prisma._store.auditLogs.at(-1).action).toBe('department.create');
  });

  it('does not let hr.manage alone assign a department manager', async () => {
    const prisma = makeFakePrisma();
    prisma.department.findFirst.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue({
      id: 'u-manager',
      name: 'Manager',
      companyId: 'c1',
      role: managerRole,
      employee: { id: 'e-manager', departmentId: null, status: 'active' },
    });
    const res = await request(makeApp(prisma))
      .post('/api/departments')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['hr.manage'] })}`)
      .send({ name: 'Unauthorized Department', managerId: 'u-manager' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('DepartmentManagerAuthorityRequired');
    expect(prisma.department.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate names and invalid managers', async () => {
    const duplicatePrisma = makeFakePrisma();
    duplicatePrisma.department.findFirst.mockResolvedValue({ id: 'd-existing' });
    const duplicate = await request(makeApp(duplicatePrisma))
      .post('/api/departments')
      .set('Authorization', `Bearer ${tokenFor({ permissions: [
        'hr.manage',
        'employees.permissions.manage',
        'permissions.manage_company',
      ] })}`)
      .send({ name: 'Engineering' });
    expect(duplicate.status).toBe(409);

    const managerPrisma = makeFakePrisma();
    managerPrisma.department.findFirst.mockResolvedValue(null);
    managerPrisma.user.findFirst.mockResolvedValue({
      id: 'u-foreign',
      companyId: 'c2',
      name: 'Foreign',
      role: managerRole,
      employee: { id: 'e-foreign', status: 'active' },
    });
    const invalidManager = await request(makeApp(managerPrisma))
      .post('/api/departments')
      .set('Authorization', `Bearer ${tokenFor({ permissions: [
        'hr.manage',
        'employees.permissions.manage',
        'permissions.manage_company',
      ] })}`)
      .send({ name: 'New Department', managerId: 'u-foreign' });
    expect(invalidManager.status).toBe(400);
    expect(managerPrisma.department.create).not.toHaveBeenCalled();
  });

  it('clears a department manager without moving employees', async () => {
    const prisma = makeFakePrisma();
    prisma.department.findFirst.mockResolvedValue(department);
    prisma.user.findFirst.mockResolvedValue({
      id: 'u-manager',
      companyId: 'c1',
      employeeId: 'e-manager',
      name: 'Manager',
      authorizationVersion: 1,
      role: managerRole,
      employee: { departmentId: 'd1', status: 'active' },
    });
    prisma.department.update.mockResolvedValue({ ...department, managerId: null, manager: null });
    const res = await request(makeApp(prisma))
      .put('/api/departments/d1')
      .set('Authorization', `Bearer ${tokenFor({ permissions: [
        'hr.manage',
        'employees.permissions.manage',
        'permissions.manage_company',
      ] })}`)
      .send({ managerId: null });

    expect(res.status).toBe(200);
    expect(prisma.department.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'd1' },
      data: { managerId: null },
    }));
    expect(prisma.employee.update).not.toHaveBeenCalled();
    expect(res.body.managerId).toBeNull();
    const details = JSON.parse(prisma._store.auditLogs.at(-1).details);
    expect(details.changedFields).toEqual(['managerId']);
  });

  it('accepts only an active same-company manager when updating a department', async () => {
    const prisma = makeFakePrisma();
    prisma.department.findFirst.mockResolvedValue(department);
    prisma.user.findFirst.mockResolvedValue({
      id: 'u-manager-2',
      companyId: 'c1',
      name: 'Second Manager',
      role: managerRole,
      employee: { id: 'e-manager-2', departmentId: 'd1', status: 'active' },
    });
    prisma.department.update.mockResolvedValue({
      ...department,
      managerId: 'u-manager-2',
      manager: { id: 'u-manager-2', name: 'Second Manager' },
    });

    const res = await request(makeApp(prisma))
      .put('/api/departments/d1')
      .set('Authorization', `Bearer ${tokenFor({ permissions: [
        'hr.manage',
        'employees.permissions.manage',
        'permissions.manage_company',
      ] })}`)
      .send({ managerId: 'u-manager-2' });

    expect(res.status).toBe(200);
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'u-manager-2', companyId: 'c1' },
    }));
    expect(prisma.department.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'd1' },
      data: { managerId: 'u-manager-2' },
    }));
  });

  it.each([
    ['cross-company', { id: 'u-foreign', companyId: 'c2', name: 'Foreign', role: managerRole, employee: { id: 'e-foreign', status: 'active' } }],
    ['nonexistent', null],
  ])('rejects a %s manager before any department update', async (_label, manager) => {
    const prisma = makeFakePrisma();
    prisma.department.findFirst.mockResolvedValue(department);
    prisma.user.findFirst.mockResolvedValue(manager);

    const res = await request(makeApp(prisma))
      .put('/api/departments/d1')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['hr.manage'] })}`)
      .send({ managerId: manager?.id ?? 'missing-manager' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidDepartmentManager');
    expect(prisma.department.update).not.toHaveBeenCalled();
    expect(prisma._store.auditLogs).toHaveLength(0);
  });

  it('returns 404 for cross-company updates and exposes no delete operation', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const token = tokenFor({ permissions: ['hr.manage'] });
    const update = await request(app)
      .put('/api/departments/foreign')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Updated' });
    const remove = await request(app)
      .delete('/api/departments/d1')
      .set('Authorization', `Bearer ${token}`);

    expect(update.status).toBe(404);
    expect(remove.status).toBe(404);
    expect(prisma.department.update).not.toHaveBeenCalled();
  });
});
