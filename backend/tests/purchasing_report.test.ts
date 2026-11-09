import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeApp, tokenFor } from './helpers';
import { addPurchasingIdentity, makePurchasingPrisma } from './purchasing_test_helpers';

describe('Sprint 9 purchasing report', () => {
  it('uses stored decimal strings, excludes cancelled cost, and hides owner requests', async () => {
    const prisma = makePurchasingPrisma();
    addPurchasingIdentity(prisma, { userId: 'u-normal', employeeId: '60000000-0000-4000-8000-000000000021', permissions: [] });
    addPurchasingIdentity(prisma, { userId: 'u-owner', employeeId: '60000000-0000-4000-8000-000000000022', permissions: [] });
    prisma.companyOwnership.findFirst.mockResolvedValue({ userId: 'u-owner' });
    const now = new Date('2026-07-10T10:00:00.000Z');
    prisma._purchasing.requests.push(
      { id: '10000000-0000-4000-8000-000000000021', companyId: 'c1', requestNumber: 'PR-NORMAL', requestedByEmployeeId: '60000000-0000-4000-8000-000000000021', requesterNameSnapshot: 'موظف', requesterNumSnapshot: 'EMP-21', title: 'عادي', status: 'received', totalEstimated: '10.10', currency: 'SAR', createdAt: now, updatedAt: now },
      { id: '10000000-0000-4000-8000-000000000022', companyId: 'c1', requestNumber: 'PR-OWNER', requestedByEmployeeId: '60000000-0000-4000-8000-000000000022', requesterNameSnapshot: 'مالك', requesterNumSnapshot: 'EMP-22', title: 'خاص', status: 'approved', totalEstimated: '999.00', currency: 'SAR', createdAt: now, updatedAt: now },
    );
    prisma._purchasing.orders.push(
      { id: '30000000-0000-4000-8000-000000000021', companyId: 'c1', orderNumber: 'PO-A', purchaseRequestId: '10000000-0000-4000-8000-000000000021', vendorId: 'v1', vendorNameSnapshot: 'مورد', status: 'received', subtotal: '10.10', totalAmount: '10.10', currency: 'SAR', createdByUserId: 'u-normal', createdAt: now, updatedAt: now },
      { id: '30000000-0000-4000-8000-000000000023', companyId: 'c1', orderNumber: 'PO-C', purchaseRequestId: '10000000-0000-4000-8000-000000000021', vendorId: 'v1', vendorNameSnapshot: 'مورد', status: 'cancelled', subtotal: '50.00', totalAmount: '50.00', currency: 'SAR', createdByUserId: 'u-normal', createdAt: now, updatedAt: now },
      { id: '30000000-0000-4000-8000-000000000022', companyId: 'c1', orderNumber: 'PO-OWNER', purchaseRequestId: '10000000-0000-4000-8000-000000000022', vendorId: 'v1', vendorNameSnapshot: 'مورد', status: 'issued', subtotal: '999.00', totalAmount: '999.00', currency: 'SAR', createdByUserId: 'u-owner', createdAt: now, updatedAt: now },
    );
    const app = makeApp(prisma);
    const response = await request(app)
      .get('/api/purchasing/report?from=2026-07-01&to=2026-07-31')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-reporter', employeeId: null, permissions: ['purchasing.report'] })}`);

    expect(response.status).toBe(200);
    expect(response.body.summary.requestCount).toBe(1);
    expect(response.body.summary.orderCount).toBe(2);
    expect(response.body.summary.estimatedTotal).toBe('10.10');
    expect(response.body.summary.orderedTotal).toBe('10.10');
    expect(response.body.summary.receivedTotal).toBe('10.10');
    expect(response.body.requests.map((row: any) => row.requestNumber)).not.toContain('PR-OWNER');
    const audit = prisma._store.auditLogs.find((row: any) => row.action === 'purchasing.report.read');
    expect(audit.details).not.toMatch(/10\.10|999|مورد|عادي/);
  });

  it('rejects report ranges longer than 366 days', async () => {
    const app = makeApp(makePurchasingPrisma());
    const response = await request(app)
      .get('/api/purchasing/report?from=2024-01-01&to=2026-01-02')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['purchasing.report'] })}`);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('DATE_RANGE_TOO_LONG');
  });
});
