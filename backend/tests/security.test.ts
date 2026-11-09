import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

describe('permission checks (checkPermission)', () => {
  it('denies access without the required permission key', async () => {
    const app = makeApp(makeFakePrisma());
    const token = tokenFor({ permissions: ['leaves.view_own'] });
    const res = await request(app).get('/api/employees').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('grants access with the exact permission key', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findMany.mockResolvedValue([]);
    const app = makeApp(prisma);
    const token = tokenFor({ permissions: ['employees.view'] });
    const res = await request(app).get('/api/employees').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('admin.full bypasses individual keys (the only bypass)', async () => {
    const prisma = makeFakePrisma();
    prisma.employee.findMany.mockResolvedValue([]);
    const app = makeApp(prisma);
    const token = tokenFor({ permissions: ['admin.full'] });
    const res = await request(app).get('/api/employees').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('a role NAME of Admin grants nothing without admin.full', async () => {
    const app = makeApp(makeFakePrisma());
    // Token deliberately has no permissions; role names are not in the token
    // at all — authorization is purely permission-key based.
    const token = tokenFor({ permissions: [] });
    const res = await request(app).get('/api/employees').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe('multi-tenant isolation', () => {
  it('scopes employee queries to the companyId inside the signed token', async () => {
    const prisma = makeFakePrisma();
    let capturedWhere: any = null;
    prisma.employee.findMany.mockImplementation(async (args: any) => {
      capturedWhere = args.where;
      return [];
    });
    const app = makeApp(prisma);

    const token = tokenFor({ companyId: 'company-A', permissions: ['employees.view'] });
    const res = await request(app).get('/api/employees').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(capturedWhere.companyId).toBe('company-A');
  });

  it('rejects companyId and employeeId fields a client tries to smuggle in a leave body', async () => {
    const prisma = makeFakePrisma();
    let capturedData: any = null;
    prisma.leaveRequest.create.mockImplementation(async ({ data }: any) => {
      capturedData = data;
      return { id: 'LR-1', ...data };
    });
    const app = makeApp(prisma);

    const token = tokenFor({
      companyId: 'company-A',
      employeeId: 'emp-A',
      permissions: ['leaves.create'],
    });
    const res = await request(app)
      .post('/api/leaves')
      .set('Authorization', `Bearer ${token}`)
      .send({
        leaveType: 'special',
        startDate: '2026-07-10',
        endDate: '2026-07-11',
        companyId: 'company-B', // attack attempt — must be ignored
        employeeId: 'someone-else',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
    expect(capturedData).toBeNull();
  });

  it('scopes leave lookups for approval to the approver company', async () => {
    const prisma = makeFakePrisma();
    let capturedWhere: any = null;
    prisma.leaveRequest.findFirst.mockImplementation(async (args: any) => {
      capturedWhere = args.where;
      return null; // pretend the leave belongs to another company → 404
    });
    const app = makeApp(prisma);

    const token = tokenFor({ companyId: 'company-A', permissions: ['leaves.approve'] });
    const res = await request(app)
      .post('/api/leaves/lr-from-company-B/hr-approve')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(capturedWhere.companyId).toBe('company-A');
  });
});
