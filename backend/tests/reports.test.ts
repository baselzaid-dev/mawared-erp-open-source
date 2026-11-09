import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { sanitizeAuditDetails } from '../src/audit';
import { buildReportCatalog, createCsv, neutralizeCsvCell } from '../src/reports';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';
import { expectPrivacySafe } from './privacyAssertions';

const DEPARTMENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DEPARTMENT_ID = '22222222-2222-4222-8222-222222222222';
const EMPLOYEE_ID = '33333333-3333-4333-8333-333333333333';

const reportUser = (permissions: string[]) => ({
  id: 'user-1',
  companyId: 'company-1',
  employeeId: EMPLOYEE_ID,
  permissions,
});

describe('unified report catalog', () => {
  it('returns only reports authorized by exact module permissions', () => {
    const employee = buildReportCatalog(reportUser([
      'attendance.view_own',
      'tasks.view_own',
      'reports.export',
    ])).map((item) => item.type);
    expect(employee).toEqual([]);

    const manager = buildReportCatalog(reportUser([
      'attendance.view_department',
      'tasks.view_department',
      'training.view_department',
      'training.report',
      'reports.export',
    ]));
    expect(manager.map((item) => item.type)).toEqual(['attendance', 'tasks', 'training']);
    expect(manager.every((item) => item.exportAvailable)).toBe(true);
    expect(manager.every((item) => item.availableScopes.join(',') === 'department')).toBe(true);

    const hr = buildReportCatalog(reportUser([
      'reports.view',
      'reports.export',
      'attendance.view',
      'leaves.view',
      'tasks.view_company',
      'payroll.report',
      'training.view_company',
      'training.report',
    ]));
    expect(hr.map((item) => item.type)).toEqual([
      'overview', 'attendance', 'leaves', 'tasks', 'payroll', 'training',
    ]);
    expect(hr.find((item) => item.type === 'overview')?.exportAvailable).toBe(false);
  });

  it('gives admin the audit report without an explicit reports permission', () => {
    const catalog = buildReportCatalog(reportUser(['admin.full']));
    // Built-in types first, then reports published through the Wave 2
    // registration contract (`source: 'registered'`).
    expect(catalog.map((item) => item.type)).toEqual([
      'overview', 'attendance', 'leaves', 'tasks', 'payroll', 'purchasing', 'training', 'audit',
      'purchasing_quotations', 'purchasing_receipts', 'purchasing_returns',
    ]);
    expect(catalog.find((item) => item.type === 'audit')?.exportAvailable).toBe(true);
    expect(catalog.filter((item) => item.source === 'built_in')).toHaveLength(8);
    expect(catalog.filter((item) => item.source === 'registered')).toHaveLength(3);
  });
});

describe('scoped report endpoints', () => {
  it('binds a department manager attendance query to managed departments', async () => {
    const prisma = makeFakePrisma();
    prisma.department.findMany.mockResolvedValue([{ id: DEPARTMENT_ID }]);
    let where: any;
    prisma.attendance.findMany.mockImplementation(async (args: any) => {
      where = args.where;
      return [];
    });
    const app = makeApp(prisma);
    const token = tokenFor({
      companyId: 'company-A',
      permissions: ['attendance.view_department'],
    });

    const response = await request(app)
      .get('/api/reports/attendance')
      .query({ from: '2026-07-01', to: '2026-07-10' })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(where.companyId).toBe('company-A');
    expect(where.employee.departmentId.in).toEqual([DEPARTMENT_ID]);
    expect(response.body.scope.kind).toBe('department');
    expectPrivacySafe(response.body);
  });

  it('rejects a manager-selected department outside the managed scope', async () => {
    const prisma = makeFakePrisma();
    prisma.department.findMany.mockResolvedValue([{ id: DEPARTMENT_ID }]);
    const app = makeApp(prisma);
    const token = tokenFor({ permissions: ['attendance.view_department'] });

    const response = await request(app)
      .get('/api/reports/attendance')
      .query({
        from: '2026-07-01',
        to: '2026-07-10',
        departmentId: OTHER_DEPARTMENT_ID,
      })
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
  });

  it('hides owner leave rows from a non-HR report viewer', async () => {
    const prisma = makeFakePrisma();
    prisma.companyOwnership.findFirst.mockResolvedValue({ userId: 'owner-user' });
    prisma.leaveRequest.findMany.mockResolvedValue([
      {
        id: 'leave-owner', employeeId: 'owner-employee', leaveType: 'annual',
        startDate: new Date('2026-07-01T00:00:00Z'), endDate: new Date('2026-07-02T00:00:00Z'),
        totalDays: 2, status: 'approved', createdAt: new Date(),
        employee: { employeeNum: 'OWNER', departmentId: null, department: null,
          user: { id: 'owner-user', name: 'Owner', role: { permissions: '[]' } } },
      },
      {
        id: 'leave-normal', employeeId: EMPLOYEE_ID, leaveType: 'annual',
        startDate: new Date('2026-07-03T00:00:00Z'), endDate: new Date('2026-07-03T00:00:00Z'),
        totalDays: 1, status: 'approved', createdAt: new Date(),
        employee: { employeeNum: 'E-1', departmentId: DEPARTMENT_ID, department: { name: 'الهندسة' },
          user: { name: 'موظف', role: { permissions: '[]' } } },
      },
    ]);
    const app = makeApp(prisma);
    const response = await request(app)
      .get('/api/reports/leaves')
      .query({ from: '2026-07-01', to: '2026-07-10' })
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['leaves.view'] })}`);

    expect(response.status).toBe(200);
    expect(response.body.rows.map((row: any) => row.id)).toEqual(['leave-normal']);
    expect(response.body.summary.requestCount).toBe(1);
    expectPrivacySafe(response.body);
  });
});

describe('audit privacy', () => {
  it('recursively removes sensitive details and rejects invalid legacy JSON', () => {
    const sanitized = sanitizeAuditDetails(JSON.stringify({
      employeeId: EMPLOYEE_ID,
      status: 'approved',
      password: 'do-not-return',
      nested: { token: 'do-not-return', rowCount: 3 },
      changedFields: ['status', 'baseSalary'],
    }));
    expect(sanitized).toEqual({
      employeeId: EMPLOYEE_ID,
      status: 'approved',
      changedFields: ['status'],
    });
    expect(sanitizeAuditDetails('{broken')).toEqual({ redacted: true });
    expectPrivacySafe(sanitized);
  });

  it('returns sanitized tenant-scoped audit rows to admin only', async () => {
    const prisma = makeFakePrisma();
    prisma._store.auditLogs.push({
      id: 'audit-legacy',
      companyId: 'company-A',
      userId: '44444444-4444-4444-8444-444444444444',
      action: 'employee.update',
      details: JSON.stringify({ employeeId: EMPLOYEE_ID, password: 'hidden', rowCount: 1 }),
      createdAt: new Date('2026-07-10T12:00:00.000Z'),
      user: { id: '44444444-4444-4444-8444-444444444444', name: 'مدير' },
    });
    prisma._store.auditLogs.push({
      id: 'audit-other-company',
      companyId: 'company-B',
      userId: '55555555-5555-4555-8555-555555555555',
      action: 'employee.update',
      details: '{}',
      createdAt: new Date('2026-07-10T12:00:00.000Z'),
      user: { id: '55555555-5555-4555-8555-555555555555', name: 'Other' },
    });
    const app = makeApp(prisma);

    const denied = await request(app)
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['reports.view'] })}`);
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .get('/api/audit-logs')
      .query({ from: '2026-06-15', to: '2026-07-11' })
      .set('Authorization', `Bearer ${tokenFor({ companyId: 'company-A', permissions: ['admin.full'] })}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.items).toHaveLength(1);
    expect(allowed.body.items[0].details).toEqual({ employeeId: EMPLOYEE_ID, rowCount: 1 });
    expectPrivacySafe(allowed.body);
  });
});

describe('privacy-safe CSV export', () => {
  it('adds a UTF-8 BOM, quotes cells and neutralizes formula/newline/null-byte input', () => {
    expect(neutralizeCsvCell('\t=SUM(A1:A2)\r\n\0')).toBe("'=SUM(A1:A2)");
    const csv = createCsv('tasks', [{
      title: '=2+2', priority: 'high', dueDate: '2026-07-11', status: 'active',
      assignmentCount: 1, inProgressCount: 0, submittedCount: 0,
      acceptedCount: 0, returnedCount: 0,
    }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"\'=2+2"');
    expect(csv).not.toContain('\0');
  });

  it('requires both export permission and report visibility', async () => {
    const app = makeApp(makeFakePrisma());
    const response = await request(app)
      .post('/api/reports/export')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['reports.export'] })}`)
      .send({ reportType: 'attendance', filters: {}, format: 'csv' });
    expect(response.status).toBe(403);
  });

  it('exports Arabic attendance rows from the same safe report projection', async () => {
    const prisma = makeFakePrisma();
    prisma.attendance.findMany.mockResolvedValue([{
      id: 'attendance-1', employeeId: EMPLOYEE_ID,
      date: new Date('2026-07-10T00:00:00Z'), clockIn: null, clockOut: null, status: 'absent',
      employee: {
        employeeNum: 'E-1', departmentId: DEPARTMENT_ID, department: { name: 'الهندسة' },
        user: { name: '=موظف', role: { permissions: '[]' } },
      },
    }]);
    const app = makeApp(prisma);
    const response = await request(app)
      .post('/api/reports/export')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['attendance.view', 'reports.export'] })}`)
      .send({
        reportType: 'attendance',
        filters: { from: '2026-07-01', to: '2026-07-10' },
        format: 'csv',
      });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="mawared_attendance_/);
    expect(response.text.charCodeAt(0)).toBe(0xfeff);
    expect(response.text).toContain('الهندسة');
    expect(response.text).toContain("'=موظف");
    expect(prisma._store.auditLogs.at(-1)).toMatchObject({ action: 'report.export' });
    expect(prisma._store.auditLogs.at(-1).details).not.toContain('الهندسة');
  });

  it('rejects reports above the 5000-row export ceiling', async () => {
    const prisma = makeFakePrisma();
    prisma.attendance.findMany.mockResolvedValue(Array.from({ length: 5001 }, (_, index) => ({
      id: `attendance-${index}`,
      employeeId: EMPLOYEE_ID,
      date: new Date('2026-07-10T00:00:00Z'),
      clockIn: null,
      clockOut: null,
      status: 'absent',
      employee: { employeeNum: 'E-1', departmentId: null, department: null,
        user: { name: 'موظف', role: { permissions: '[]' } } },
    })));
    const app = makeApp(prisma);
    const response = await request(app)
      .post('/api/reports/export')
      .set('Authorization', `Bearer ${tokenFor({ permissions: ['attendance.view', 'reports.export'] })}`)
      .send({ reportType: 'attendance', filters: {}, format: 'csv' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('REPORT_ROW_LIMIT_EXCEEDED');
  });
});

describe('overview partial-load resilience', () => {
  it('treats missing approved payroll as an empty section without the generic warning', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);
    const response = await request(app)
      .get('/api/reports/overview')
      .set('Authorization', `Bearer ${tokenFor({
        permissions: ['reports.view', 'payroll.report'],
      })}`);

    expect(response.status).toBe(200);
    expect(response.body.sections.payroll).toEqual({ title: 'الرواتب', metrics: {} });
    expect(response.body.unavailableSections).not.toContain('payroll');
    expect(response.body.warnings).toEqual([]);
    expectPrivacySafe(response.body);
  });
});
