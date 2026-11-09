/**
 * Shared fixture for Commercial Wave 2 purchasing tests (Operations Slice E1).
 *
 * Builds a company `c1` with an approved two-line purchase request, an active
 * vendor and the four actors the Wave 2 segregation rules need, plus a second
 * company `c2` so every suite can assert cross-company isolation cheaply.
 */

import request from 'supertest';
import { makeApp, tokenFor } from './helpers';
import { addPurchasingIdentity, makePurchasingPrisma } from './purchasing_test_helpers';

export const REQUEST_ID = '10000000-0000-4000-8000-000000000901';
export const REQUEST_LINE_A = '20000000-0000-4000-8000-000000000901';
export const REQUEST_LINE_B = '20000000-0000-4000-8000-000000000902';
export const VENDOR_ID = '70000000-0000-4000-8000-000000000901';
export const VENDOR_B_ID = '70000000-0000-4000-8000-000000000902';
export const REQUESTER_EMPLOYEE_ID = '60000000-0000-4000-8000-000000000901';
export const BUYER_EMPLOYEE_ID = '60000000-0000-4000-8000-000000000902';
export const APPROVER_EMPLOYEE_ID = '60000000-0000-4000-8000-000000000903';

/** Foreign-company ids used for IDOR assertions. */
export const FOREIGN_REQUEST_ID = '10000000-0000-4000-8000-0000000009f1';
export const FOREIGN_ORDER_ID = '30000000-0000-4000-8000-0000000009f1';
export const FOREIGN_QUOTATION_ID = 'a0000000-0000-4000-8000-0000000009f1';

export const BUYER_PERMISSIONS = [
  'purchasing.view',
  'purchasing.manage',
  'purchasing.receive',
  'purchasing.report',
  'purchasing.quotation.manage',
  'purchasing.quotation.compare',
  'purchasing.return.create',
];

export const APPROVER_PERMISSIONS = [
  'purchasing.view',
  'purchasing.report',
  'purchasing.quotation.compare',
  'purchasing.return.approve',
];

export const buyerToken = () =>
  tokenFor({ id: 'u-buyer', employeeId: BUYER_EMPLOYEE_ID, permissions: BUYER_PERMISSIONS });

export const approverToken = () =>
  tokenFor({ id: 'u-approver', employeeId: APPROVER_EMPLOYEE_ID, permissions: APPROVER_PERMISSIONS });

export const requesterToken = () =>
  tokenFor({ id: 'u-requester', employeeId: REQUESTER_EMPLOYEE_ID, permissions: ['purchasing.view_own'] });

export const foreignToken = () =>
  tokenFor({
    id: 'u-foreign',
    companyId: 'c2',
    employeeId: '60000000-0000-4000-8000-0000000009f1',
    permissions: BUYER_PERMISSIONS,
  });

export function makeW2Prisma(requestStatus = 'approved') {
  const prisma = makePurchasingPrisma();
  addPurchasingIdentity(prisma, {
    userId: 'u-requester',
    employeeId: REQUESTER_EMPLOYEE_ID,
    permissions: ['purchasing.view_own'],
  });
  addPurchasingIdentity(prisma, {
    userId: 'u-buyer',
    employeeId: BUYER_EMPLOYEE_ID,
    permissions: BUYER_PERMISSIONS,
  });
  addPurchasingIdentity(prisma, {
    userId: 'u-approver',
    employeeId: APPROVER_EMPLOYEE_ID,
    permissions: APPROVER_PERMISSIONS,
  });
  addPurchasingIdentity(prisma, {
    userId: 'u-foreign',
    employeeId: '60000000-0000-4000-8000-0000000009f1',
    companyId: 'c2',
    permissions: BUYER_PERMISSIONS,
  });

  const now = new Date('2026-08-01T08:00:00.000Z');
  prisma._purchasing.requests.push({
    id: REQUEST_ID,
    companyId: 'c1',
    requestNumber: 'PR-202608-W2000001',
    requestedByEmployeeId: REQUESTER_EMPLOYEE_ID,
    requesterNameSnapshot: 'طالب',
    requesterNumSnapshot: 'EMP-901',
    departmentId: null,
    departmentNameSnapshot: null,
    title: 'طلب معتمد للموجة الثانية',
    justification: null,
    neededByDate: new Date('2026-08-20T00:00:00.000Z'),
    status: requestStatus,
    totalEstimated: '300.00',
    currency: 'SAR',
    createdAt: now,
    updatedAt: now,
  });
  prisma._purchasing.requestLines.push(
    {
      id: REQUEST_LINE_A,
      companyId: 'c1',
      purchaseRequestId: REQUEST_ID,
      description: 'حاسوب محمول',
      category: 'أجهزة',
      quantity: '10.000',
      unit: 'قطعة',
      estimatedUnitPrice: '20.00',
      estimatedTotal: '200.00',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: REQUEST_LINE_B,
      companyId: 'c1',
      purchaseRequestId: REQUEST_ID,
      description: 'حقيبة',
      category: 'ملحقات',
      quantity: '5.000',
      unit: 'قطعة',
      estimatedUnitPrice: '20.00',
      estimatedTotal: '100.00',
      createdAt: now,
      updatedAt: now,
    },
  );

  // A foreign-company request/order/quotation for IDOR assertions.
  prisma._purchasing.requests.push({
    id: FOREIGN_REQUEST_ID,
    companyId: 'c2',
    requestNumber: 'PR-202608-FOREIGN1',
    requestedByEmployeeId: '60000000-0000-4000-8000-0000000009f1',
    requesterNameSnapshot: 'أجنبي',
    requesterNumSnapshot: 'EMP-F1',
    departmentId: null,
    departmentNameSnapshot: null,
    title: 'طلب شركة أخرى',
    status: 'approved',
    totalEstimated: '10.00',
    currency: 'SAR',
    createdAt: now,
    updatedAt: now,
  });

  prisma._store.vendors.push(
    {
      id: VENDOR_ID,
      companyId: 'c1',
      name: 'مورد أول',
      contact: null,
      email: null,
      taxNumber: null,
      category: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: VENDOR_B_ID,
      companyId: 'c1',
      name: 'مورد ثانٍ',
      contact: null,
      email: null,
      taxNumber: null,
      category: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
  );

  return prisma;
}

export const w2App = (prisma: any) => makeApp(prisma);

/** Quotation body helper: two lines matching the fixture request lines. */
export const quotationBody = (vendorId: string, unitPriceA: string, unitPriceB: string) => ({
  vendorId,
  supplierReference: 'Q-2026-001',
  currency: 'SAR',
  quotationDate: '2026-08-02',
  validUntilDate: '2026-09-02',
  expectedDeliveryDate: '2026-08-25',
  leadTimeDays: 14,
  paymentTerms: 'صافي 30 يوماً',
  notes: null,
  lines: [
    {
      requestLineId: REQUEST_LINE_A,
      description: 'حاسوب محمول',
      category: 'أجهزة',
      quantity: '10.000',
      unit: 'قطعة',
      unitPrice: unitPriceA,
      leadTimeDays: 14,
      notes: null,
    },
    {
      requestLineId: REQUEST_LINE_B,
      description: 'حقيبة',
      category: 'ملحقات',
      quantity: '5.000',
      unit: 'قطعة',
      unitPrice: unitPriceB,
      leadTimeDays: 7,
      notes: null,
    },
  ],
});

/** Creates a draft order for the fixture request, issues it, and returns it. */
export async function createIssuedOrder(app: any, token: string, supplierQuotationId?: string) {
  const created = await request(app)
    .post('/api/purchasing/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      purchaseRequestId: REQUEST_ID,
      vendorId: VENDOR_ID,
      currency: 'SAR',
      ...(supplierQuotationId ? { supplierQuotationId } : {}),
      lines: [
        { requestLineId: REQUEST_LINE_A, description: 'حاسوب محمول', quantity: '10.000', unit: 'قطعة', unitPrice: '20.00' },
        { requestLineId: REQUEST_LINE_B, description: 'حقيبة', quantity: '5.000', unit: 'قطعة', unitPrice: '20.00' },
      ],
    });
  if (created.status !== 201) {
    throw new Error(`order create failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const issued = await request(app)
    .post(`/api/purchasing/orders/${created.body.id}/issue`)
    .set('Authorization', `Bearer ${token}`);
  if (issued.status !== 200) {
    throw new Error(`order issue failed: ${issued.status} ${JSON.stringify(issued.body)}`);
  }
  return issued.body;
}
