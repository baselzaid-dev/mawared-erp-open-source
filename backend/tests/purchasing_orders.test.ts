import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeApp, tokenFor } from './helpers';
import { addPurchasingIdentity, makePurchasingPrisma } from './purchasing_test_helpers';

const REQUEST_ID = '10000000-0000-4000-8000-000000000010';
const REQUEST_LINE_ID = '20000000-0000-4000-8000-000000000010';
const VENDOR_ID = '70000000-0000-4000-8000-000000000010';
const EMPLOYEE_ID = '60000000-0000-4000-8000-000000000010';

function setupApprovedRequest() {
  const prisma = makePurchasingPrisma();
  addPurchasingIdentity(prisma, { userId: 'u-requester', employeeId: EMPLOYEE_ID, permissions: ['purchasing.view_own'] });
  addPurchasingIdentity(prisma, { userId: 'u-buyer', employeeId: '60000000-0000-4000-8000-000000000011', permissions: ['purchasing.manage', 'purchasing.receive', 'purchasing.view'] });
  prisma._purchasing.requests.push({
    id: REQUEST_ID, companyId: 'c1', requestNumber: 'PR-202607-TEST0001', requestedByEmployeeId: EMPLOYEE_ID,
    requesterNameSnapshot: 'طالب', requesterNumSnapshot: 'EMP-10', departmentId: null, departmentNameSnapshot: null,
    title: 'طلب معتمد', status: 'approved', totalEstimated: '12.00', currency: 'SAR', createdAt: new Date(), updatedAt: new Date(),
  });
  prisma._purchasing.requestLines.push({
    id: REQUEST_LINE_ID, companyId: 'c1', purchaseRequestId: REQUEST_ID, description: 'بند', quantity: '1.000',
    unit: 'قطعة', estimatedUnitPrice: '12.00', estimatedTotal: '12.00', createdAt: new Date(), updatedAt: new Date(),
  });
  prisma._store.vendors.push({
    id: VENDOR_ID, companyId: 'c1', name: 'مورد نشط', contact: null, email: null, taxNumber: null,
    category: null, status: 'active', createdAt: new Date(), updatedAt: new Date(),
  });
  return prisma;
}

describe('Sprint 9 purchase orders', () => {
  it('creates exact server totals, issues, and receives the full order atomically', async () => {
    const prisma = setupApprovedRequest();
    const app = makeApp(prisma);
    const buyerToken = tokenFor({ id: 'u-buyer', employeeId: '60000000-0000-4000-8000-000000000011', permissions: ['purchasing.manage', 'purchasing.receive', 'purchasing.view'] });
    const create = await request(app)
      .post('/api/purchasing/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        purchaseRequestId: REQUEST_ID, vendorId: VENDOR_ID, currency: 'SAR',
        lines: [{ requestLineId: REQUEST_LINE_ID, description: 'بند', quantity: '3.333', unit: 'قطعة', unitPrice: '2.22' }],
      });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe('draft');
    expect(create.body.totalAmount).toBe('7.40');
    expect(prisma._purchasing.requests[0].status).toBe('ordered');
    const nestedLines = prisma.purchaseOrder.create.mock.calls[0][0].data.lines.create;
    expect(nestedLines.every((line: any) => !('companyId' in line))).toBe(true);

    const issue = await request(app)
      .post(`/api/purchasing/orders/${create.body.id}/issue`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(issue.status).toBe(200);
    expect(issue.body.status).toBe('issued');

    const receive = await request(app)
      .post(`/api/purchasing/orders/${create.body.id}/receive`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ receiptNote: 'استلام إداري كامل' });
    expect(receive.status).toBe(200);
    expect(receive.body.status).toBe('received');
    expect(prisma._purchasing.requests[0].status).toBe('received');
    expect(receive.body.totalAmount).toBe('7.40');
  });

  it('returns an explicit conflict for an inactive same-company vendor without mutation', async () => {
    const prisma = setupApprovedRequest();
    prisma._store.vendors[0].status = 'inactive';
    const app = makeApp(prisma);
    const auth = `Bearer ${tokenFor({ id: 'u-buyer', employeeId: '60000000-0000-4000-8000-000000000011', permissions: ['purchasing.manage'] })}`;
    const blocked = await request(app).post('/api/purchasing/orders').set('Authorization', auth).send({
      purchaseRequestId: REQUEST_ID, vendorId: VENDOR_ID,
      lines: [{ description: 'بند', quantity: '1', unit: 'قطعة', unitPrice: '1.00' }],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({
      error: 'VendorInactive',
      message: 'المورد غير نشط ولا يمكن استخدامه في أمر شراء جديد',
      code: 409,
    });
    expect(blocked.body.requestId).toEqual(expect.any(String));
    expect(prisma._purchasing.orders).toHaveLength(0);
    expect(prisma._purchasing.orderLines).toHaveLength(0);
    expect(prisma._purchasing.requests[0].status).toBe('approved');
    expect(prisma._store.notifications).toHaveLength(0);
    expect(prisma._store.auditLogs).toHaveLength(0);
  });

  it('keeps missing and foreign vendors behind the same safe 404 response', async () => {
    for (const vendor of [
      { id: '70000000-0000-4000-8000-000000000099', companyId: 'c1' },
      { id: '70000000-0000-4000-8000-000000000098', companyId: 'c2' },
    ]) {
      const prisma = setupApprovedRequest();
      if (vendor.companyId === 'c2') {
        prisma._store.vendors.push({ ...prisma._store.vendors[0], id: vendor.id, companyId: vendor.companyId });
      }
      const app = makeApp(prisma);
      const auth = `Bearer ${tokenFor({ id: 'u-buyer', employeeId: '60000000-0000-4000-8000-000000000011', permissions: ['purchasing.manage'] })}`;
      const blocked = await request(app).post('/api/purchasing/orders').set('Authorization', auth).send({
        purchaseRequestId: REQUEST_ID, vendorId: vendor.id,
        lines: [{ description: 'بند', quantity: '1', unit: 'قطعة', unitPrice: '1.00' }],
      });
      expect(blocked.status).toBe(404);
      expect(blocked.body.error).toBe('ACTIVE_VENDOR_NOT_FOUND');
      expect(prisma._purchasing.orders).toHaveLength(0);
      expect(prisma._purchasing.orderLines).toHaveLength(0);
      expect(prisma._purchasing.requests[0].status).toBe('approved');
    }
  });

  it('blocks switching a retained draft to an inactive vendor', async () => {
    const prisma = setupApprovedRequest();
    const app = makeApp(prisma);
    const auth = `Bearer ${tokenFor({ id: 'u-buyer', employeeId: '60000000-0000-4000-8000-000000000011', permissions: ['purchasing.manage'] })}`;

    const created = await request(app).post('/api/purchasing/orders').set('Authorization', auth).send({
      purchaseRequestId: REQUEST_ID, vendorId: VENDOR_ID,
      lines: [{ description: 'بند', quantity: '1', unit: 'قطعة', unitPrice: '1.00' }],
    });
    prisma._store.vendors[0].status = 'inactive';
    const blocked = await request(app).put(`/api/purchasing/orders/${created.body.id}`).set('Authorization', auth).send({
      vendorId: VENDOR_ID,
      lines: [{ id: created.body.lines[0].id, description: 'بديل', quantity: '1', unit: 'قطعة', unitPrice: '2.00' }],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('VendorInactive');
    expect(prisma._purchasing.orders).toHaveLength(1);
    expect(prisma._purchasing.orderLines).toHaveLength(1);
    expect(prisma._purchasing.orderLines[0].descriptionSnapshot).toBe('بند');
    expect(prisma._purchasing.requests[0].status).toBe('ordered');
  });

  it('preserves the existing line-removal guard for a retained draft', async () => {
    const prisma = setupApprovedRequest();
    const app = makeApp(prisma);
    const auth = `Bearer ${tokenFor({ id: 'u-buyer', employeeId: '60000000-0000-4000-8000-000000000011', permissions: ['purchasing.manage'] })}`;
    const created = await request(app).post('/api/purchasing/orders').set('Authorization', auth).send({
      purchaseRequestId: REQUEST_ID, vendorId: VENDOR_ID,
      lines: [{ description: 'بند', quantity: '1', unit: 'قطعة', unitPrice: '1.00' }],
    });
    const removal = await request(app).put(`/api/purchasing/orders/${created.body.id}`).set('Authorization', auth).send({
      vendorId: VENDOR_ID,
      lines: [{ description: 'بديل', quantity: '1', unit: 'قطعة', unitPrice: '2.00' }],
    });
    expect(removal.status).toBe(400);
    expect(removal.body.error).toBe('ORDER_LINE_REMOVAL_NOT_ALLOWED');
  });

  it('cancels without deleting history and returns the request to approved', async () => {
    const prisma = setupApprovedRequest();
    const app = makeApp(prisma);
    const auth = `Bearer ${tokenFor({ id: 'u-buyer', employeeId: '60000000-0000-4000-8000-000000000011', permissions: ['purchasing.manage'] })}`;
    const created = await request(app).post('/api/purchasing/orders').set('Authorization', auth).send({
      purchaseRequestId: REQUEST_ID, vendorId: VENDOR_ID,
      lines: [{ description: 'بند', quantity: '1', unit: 'قطعة', unitPrice: '5.00' }],
    });
    const cancelled = await request(app).post(`/api/purchasing/orders/${created.body.id}/cancel`).set('Authorization', auth).send({ cancellationReason: 'تغيير المورد' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(prisma._purchasing.orders).toHaveLength(1);
    expect(prisma._purchasing.orderLines).toHaveLength(1);
    expect(prisma._purchasing.requests[0].status).toBe('approved');
  });
});
