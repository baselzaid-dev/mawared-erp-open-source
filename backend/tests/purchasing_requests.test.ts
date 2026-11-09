import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeApp, tokenFor } from './helpers';
import { addPurchasingIdentity, makePurchasingPrisma } from './purchasing_test_helpers';

const DEPARTMENT_ID = '50000000-0000-4000-8000-000000000001';
const EMPLOYEE_ID = '60000000-0000-4000-8000-000000000001';
const MANAGER_EMPLOYEE_ID = '60000000-0000-4000-8000-000000000002';

describe('Sprint 9 purchase requests', () => {
  it('creates an exact-decimal request and routes it to the active department manager', async () => {
    const prisma = makePurchasingPrisma();
    addPurchasingIdentity(prisma, { userId: 'u-manager', employeeId: MANAGER_EMPLOYEE_ID, departmentId: DEPARTMENT_ID, managerId: 'u-manager', permissions: ['purchasing.view_department', 'purchasing.review_department'] });
    addPurchasingIdentity(prisma, { userId: 'u-requester', employeeId: EMPLOYEE_ID, departmentId: DEPARTMENT_ID, permissions: ['purchasing.create', 'purchasing.view_own'], name: 'طالب الشراء' });
    const app = makeApp(prisma);

    const response = await request(app)
      .post('/api/purchasing/requests')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-requester', employeeId: EMPLOYEE_ID, permissions: ['purchasing.create', 'purchasing.view_own'] })}`)
      .send({
        title: 'معدات مكتبية',
        currency: 'SAR',
        lines: [
          { description: 'بند أول', quantity: '1.005', unit: 'قطعة', estimatedUnitPrice: '10.01' },
          { description: 'بند ثان', quantity: '2.5', unit: 'قطعة', estimatedUnitPrice: '3.33' },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('pending_department');
    expect(response.body.totalEstimated).toBe('18.39');
    expect(response.body.lines.map((line: any) => line.estimatedTotal)).toEqual(['10.06', '8.33']);
    const nestedLines = prisma.purchaseRequest.create.mock.calls[0][0].data.lines.create;
    expect(nestedLines.every((line: any) => !('companyId' in line))).toBe(true);
    expect(prisma._store.notifications).toEqual(expect.arrayContaining([expect.objectContaining({ userId: 'u-manager' })]));
    expect(JSON.stringify(response.body)).not.toMatch(/password|permissions|hash|token/i);
    const audit = prisma._store.auditLogs.find((row: any) => row.action === 'purchasing.request.create');
    expect(audit.details).not.toContain('18.39');
    expect(audit.details).not.toContain('بند أول');
  });

  it('enforces department scope and blocks requester self-approval', async () => {
    const prisma = makePurchasingPrisma();
    addPurchasingIdentity(prisma, { userId: 'u-manager', employeeId: MANAGER_EMPLOYEE_ID, departmentId: DEPARTMENT_ID, managerId: 'u-manager', permissions: ['purchasing.view_department', 'purchasing.review_department'] });
    addPurchasingIdentity(prisma, { userId: 'u-requester', employeeId: EMPLOYEE_ID, departmentId: DEPARTMENT_ID, permissions: ['purchasing.create', 'purchasing.view_own', 'purchasing.approve'] });
    const app = makeApp(prisma);
    const create = await request(app)
      .post('/api/purchasing/requests')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-requester', employeeId: EMPLOYEE_ID, permissions: ['purchasing.create', 'purchasing.view_own', 'purchasing.approve'] })}`)
      .send({ title: 'طلب', lines: [{ description: 'بند', quantity: '1', unit: 'قطعة', estimatedUnitPrice: '1.00' }] });

    const review = await request(app)
      .post(`/api/purchasing/requests/${create.body.id}/department-review`)
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-manager', employeeId: MANAGER_EMPLOYEE_ID, permissions: ['purchasing.view_department', 'purchasing.review_department'] })}`)
      .send({ action: 'approve' });
    expect(review.status).toBe(200);
    expect(review.body.status).toBe('pending_purchasing');

    const selfApproval = await request(app)
      .post(`/api/purchasing/requests/${create.body.id}/purchasing-review`)
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-requester', employeeId: EMPLOYEE_ID, permissions: ['purchasing.approve'] })}`)
      .send({ action: 'approve' });
    expect(selfApproval.status).toBe(403);
    expect(selfApproval.body.error).toBe('SELF_REVIEW_BLOCKED');
  });

  it('requires an active linked employee and rejects foreign department review', async () => {
    const prisma = makePurchasingPrisma();
    const app = makeApp(prisma);
    const noEmployee = await request(app)
      .post('/api/purchasing/requests')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-none', employeeId: null, permissions: ['purchasing.create'] })}`)
      .send({ title: 'طلب', lines: [{ description: 'بند', quantity: '1', unit: 'قطعة', estimatedUnitPrice: '1.00' }] });
    expect(noEmployee.status).toBe(403);

    prisma._purchasing.requests.push({
      id: '10000000-0000-4000-8000-000000000099', companyId: 'c1', requestNumber: 'PR-TEST',
      requestedByEmployeeId: EMPLOYEE_ID, requesterNameSnapshot: 'موظف', requesterNumSnapshot: 'EMP-1',
      departmentId: DEPARTMENT_ID, status: 'pending_department', totalEstimated: '1.00', currency: 'SAR',
      createdAt: new Date(), updatedAt: new Date(),
    });
    addPurchasingIdentity(prisma, { userId: 'u-foreign-manager', employeeId: MANAGER_EMPLOYEE_ID, departmentId: '50000000-0000-4000-8000-000000000002', managerId: 'u-foreign-manager', permissions: ['purchasing.review_department'] });
    const foreign = await request(app)
      .post('/api/purchasing/requests/10000000-0000-4000-8000-000000000099/department-review')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-foreign-manager', employeeId: MANAGER_EMPLOYEE_ID, permissions: ['purchasing.review_department'] })}`)
      .send({ action: 'reject', note: 'غير تابع للقسم' });
    expect(foreign.status).toBe(403);
  });
});
