import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

const PERIOD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('unified reports two-company isolation matrix', () => {
  it('applies the signed company to every report and audit query', async () => {
    const prisma = makeFakePrisma();
    const captured: Record<string, any> = {};
    prisma.attendance.findMany.mockImplementation(async (args: any) => {
      captured.attendance = args.where;
      return [];
    });
    prisma.leaveRequest.findMany.mockImplementation(async (args: any) => {
      captured.leaves = args.where;
      return [];
    });
    prisma.task.findMany.mockImplementation(async (args: any) => {
      captured.tasks = args.where;
      return [];
    });
    prisma._store.payrollPeriods.push({
      id: PERIOD_ID,
      companyId: 'company-A',
      month: 6,
      year: 2026,
      status: 'approved',
      calculationVersion: 1,
      createdAt: new Date(),
      calculatedAt: new Date(),
      approvedAt: new Date(),
      paidAt: null,
    });
    prisma.payrollItem.findMany.mockImplementation(async (args: any) => {
      captured.payroll = args.where;
      return [];
    });
    prisma.purchaseRequest = {
      findMany: vi.fn(async (args: any) => {
        captured.purchasingRequests = args.where;
        return [];
      }),
    };
    prisma.purchaseOrder = {
      findMany: vi.fn(async (args: any) => {
        captured.purchasingOrders = args.where;
        return [];
      }),
    };
    prisma.trainingCourse = {
      findMany: vi.fn(async (args: any) => {
        captured.training = args.where;
        return [];
      }),
    };
    const originalAuditFindMany = prisma.auditLog.findMany;
    prisma.auditLog.findMany = vi.fn(async (args: any) => {
      captured.audit = args.where;
      return originalAuditFindMany(args);
    });

    const app = makeApp(prisma);
    const permissions = [
      'admin.full',
      'attendance.view',
      'leaves.view',
      'tasks.view_company',
      'payroll.report',
      'purchasing.report',
      'training.view_company',
      'training.report',
    ];
    const authorization = `Bearer ${tokenFor({ companyId: 'company-A', permissions })}`;
    const dated = { from: '2026-07-01', to: '2026-07-10' };

    const responses = [
      await request(app).get('/api/reports/attendance').query(dated).set('Authorization', authorization),
      await request(app).get('/api/reports/leaves').query(dated).set('Authorization', authorization),
      await request(app).get('/api/reports/tasks').query(dated).set('Authorization', authorization),
      await request(app).get('/api/reports/payroll').query({ periodId: PERIOD_ID }).set('Authorization', authorization),
      await request(app).get('/api/reports/purchasing').query(dated).set('Authorization', authorization),
      await request(app).get('/api/reports/training').query(dated).set('Authorization', authorization),
      await request(app).get('/api/audit-logs').query(dated).set('Authorization', authorization),
    ];

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
    for (const where of Object.values(captured)) {
      expect(where.companyId).toBe('company-A');
    }
  });
});
