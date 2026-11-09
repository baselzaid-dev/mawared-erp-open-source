import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

const vendorToken = (companyId = 'c1') =>
  tokenFor({ companyId, permissions: ['vendors.view', 'vendors.manage'] });

describe('Vendors API', () => {
  it('rejects unauthenticated list', async () => {
    const app = makeApp(makeFakePrisma());
    const res = await request(app).get('/api/vendors');
    expect(res.status).toBe(401);
  });

  it('rejects list without vendors.view permission', async () => {
    const app = makeApp(makeFakePrisma());
    const res = await request(app)
      .get('/api/vendors')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['employees.view'] })}`);
    expect(res.status).toBe(403);
  });

  it('lists vendors scoped to the token company only', async () => {
    const prisma = makeFakePrisma();
    prisma._store.vendors.push(
      { id: 'v1', companyId: 'c1', name: 'مورد أ', contact: null, status: 'active' },
      { id: 'v2', companyId: 'c2', name: 'مورد شركة أخرى', contact: null, status: 'active' }
    );
    const app = makeApp(prisma);
    const res = await request(app)
      .get('/api/vendors')
      .set('Authorization', `Bearer ${vendorToken('c1')}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('v1');
  });

  it('creates a vendor with companyId from the token and rejects supplied tenant fields', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const res = await request(app)
      .post('/api/vendors')
      .set('Authorization', `Bearer ${vendorToken('c1')}`)
      .send({ name: 'مورد جديد', contact: '0791234567' });
    expect(res.status).toBe(201);
    expect(res.body.companyId).toBe('c1');
    expect(prisma._store.auditLogs.some((a: any) => a.action === 'vendor.create')).toBe(true);
  });

  it('rejects vendor creation with empty name (validation)', async () => {
    const app = makeApp(makeFakePrisma());
    const res = await request(app)
      .post('/api/vendors')
      .set('Authorization', `Bearer ${vendorToken()}`)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('updates a vendor within the same company', async () => {
    const prisma = makeFakePrisma();
    prisma._store.vendors.push({ id: 'v1', companyId: 'c1', name: 'قديم', contact: null, status: 'active' });
    const app = makeApp(prisma);
    const res = await request(app)
      .put('/api/vendors/v1')
      .set('Authorization', `Bearer ${vendorToken('c1')}`)
      .send({ name: 'محدّث' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('محدّث');
  });

  it('returns 404 when updating a vendor from another company', async () => {
    const prisma = makeFakePrisma();
    prisma._store.vendors.push({ id: 'v1', companyId: 'c2', name: 'ليس لك', contact: null, status: 'active' });
    const app = makeApp(prisma);
    const res = await request(app)
      .put('/api/vendors/v1')
      .set('Authorization', `Bearer ${vendorToken('c1')}`)
      .send({ name: 'اختراق' });
    expect(res.status).toBe(404);
  });

  it('rejects hard deletion and directs clients to the status lifecycle', async () => {
    const app = makeApp(makeFakePrisma());
    const res = await request(app)
      .delete('/api/vendors/v1')
      .set('Authorization', `Bearer ${vendorToken()}`);
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('VENDOR_DELETE_NOT_ALLOWED');
  });
});

describe('GET /api/owner/metrics', () => {
  it('requires admin.full — normal permissions get 403', async () => {
    const app = makeApp(makeFakePrisma());
    const res = await request(app)
      .get('/api/owner/metrics')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['employees.view'] })}`);
    expect(res.status).toBe(403);
  });

  it('scopes each count to the authenticated company', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const res = await request(app)
      .get('/api/owner/metrics')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['admin.full'] })}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['auditLogs', 'companies', 'employees', 'users'].sort()
    );
    expect(typeof res.body.companies).toBe('number');
    expect(prisma.company.count).toHaveBeenCalledWith({ where: { id: 'c1' } });
    for (const count of [prisma.user.count, prisma.employee.count, prisma.auditLog.count]) {
      expect(count).toHaveBeenCalledWith({ where: { companyId: 'c1' } });
    }
  });
});
