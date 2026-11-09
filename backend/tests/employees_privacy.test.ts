import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

// Regression guard: GET /api/employees must never leak user.password (bcrypt
// hash) and must expose the role as a string (roleName), so the Android client
// can parse it. Discovered during staging QA on 2026-07-07.
describe('GET /api/employees privacy + shape', () => {
  it('omits user.password and returns roleName as a string', async () => {
    const prisma = makeFakePrisma();
    // The route uses a Prisma `select`, so the fake returns exactly what that
    // select would produce (no password field, role reduced to { name }).
    prisma.employee.findMany = async () => [
      {
        id: 'e1',
        companyId: 'c1',
        employeeNum: 'E-001',
        jobTitle: 'Engineer',
        joiningDate: '2026-01-01',
        departmentId: null,
        user: { id: 'u1', name: 'Test User', email: 'user@example.com', role: { name: 'Admin' } },
        department: null,
      },
    ];

    const app = makeApp(prisma);
    const token = tokenFor({ companyId: 'c1', permissions: ['employees.view'] });
    const res = await request(app).get('/api/employees').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const user = res.body[0].user;
    expect(user).toBeTruthy();
    expect(user.password).toBeUndefined();
    expect('password' in user).toBe(false);
    expect(user.roleName).toBe('Admin');
    // role must not be leaked as a nested object either
    expect(user.role).toBeUndefined();
    expect(user.name).toBe('Test User');
    expect(user.email).toBe('user@example.com');
  });

  it('requires employees.view permission', async () => {
    const app = makeApp(makeFakePrisma());
    const res = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${tokenFor({ permissions: [] })}`);
    expect(res.status).toBe(403);
  });

  // Owner/admin personal-data privacy rule.
  const ownerAndStaff = [
    {
      id: 'e-owner',
      companyId: 'c1',
      employeeNum: 'E-OWNER',
      jobTitle: 'CEO',
      joiningDate: '2026-01-01',
      status: 'active',
      departmentId: null,
      user: {
        id: 'u-owner',
        name: 'Owner',
        email: 'owner@example.com',
        role: { name: 'Admin', permissions: JSON.stringify(['admin.full']) },
      },
      department: null,
    },
    {
      id: 'e-staff',
      companyId: 'c1',
      employeeNum: 'E-STAFF',
      jobTitle: 'Engineer',
      joiningDate: '2026-01-01',
      status: 'active',
      departmentId: null,
      user: {
        id: 'u-staff',
        name: 'Staff',
        email: 'staff@example.com',
        role: { name: 'Employee', permissions: JSON.stringify(['attendance.clock']) },
      },
      department: null,
    },
  ];

  it('hides the owner (admin.full) employee record from a non-HR viewer', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findMany = async () => ownerAndStaff as any;
    const app = makeApp(prisma);
    // A viewer who can list employees (employees.view) but is NOT HR (no hr.view)
    // must not see the owner's personal record.
    const token = tokenFor({ companyId: 'c1', permissions: ['employees.view'] });
    const res = await request(app).get('/api/employees').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((e: any) => e.id);
    expect(ids).toContain('e-staff');
    expect(ids).not.toContain('e-owner');
    // permissions must never be leaked in the shaped user
    expect(res.body[0].user.role).toBeUndefined();
  });

  it('lets HR (hr.view) see the owner employee record', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findMany = async () => ownerAndStaff as any;
    const app = makeApp(prisma);
    const token = tokenFor({ companyId: 'c1', permissions: ['employees.view', 'hr.view'] });
    const res = await request(app).get('/api/employees').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((e: any) => e.id);
    expect(ids).toContain('e-owner');
    expect(ids).toContain('e-staff');
  });

  it('scopes a department manager and still hides the owner', async () => {
    const prisma = makeFakePrisma();
    prisma.department.findMany = async () => [{ id: 'd-managed' }] as any;
    prisma.employee.findMany = async (args: any) => {
      expect(args.where).toEqual({
        companyId: 'c1',
        departmentId: { in: ['d-managed'] },
      });
      return ownerAndStaff as any;
    };
    const app = makeApp(prisma);
    const token = tokenFor({
      id: 'u-manager',
      companyId: 'c1',
      permissions: ['employees.view_department'],
    });

    const res = await request(app).get('/api/employees').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.map((employee: any) => employee.id)).toEqual(['e-staff']);
    expect(JSON.stringify(res.body)).not.toContain('permissions');
  });
});
