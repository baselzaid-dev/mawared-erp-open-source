import express from 'express';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { PERMISSIONS } from '../src/permissions';
import { registerPayrollExportRoutes } from '../src/payrollExports';
import { makeApp, makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

const exportPermissions = [PERMISSIONS.PAYROLL_REPORT, PERMISSIONS.REPORTS_EXPORT];

const payrollToken = (
  permissions: string[] = exportPermissions,
  companyId = 'c1',
  id = 'u1',
) => tokenFor({ id, companyId, permissions });

const period = (overrides: Record<string, unknown> = {}) => ({
  id: 'period-1',
  companyId: 'c1',
  month: 7,
  year: 2026,
  status: 'approved',
  createdByUserId: 'creator-1',
  calculatedByUserId: 'calculator-1',
  approvedByUserId: 'approver-1',
  paidByUserId: null,
  calculatedAt: new Date('2026-07-01T00:00:00.000Z'),
  approvedAt: new Date('2026-07-02T00:00:00.000Z'),
  paidAt: null,
  calculationVersion: 1,
  calculationFingerprint: 'stored',
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  ...overrides,
});

const employee = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  companyId: 'c1',
  employeeNum: `EMP-${id}`,
  jobTitle: 'Specialist',
  joiningDate: new Date('2025-01-01T00:00:00.000Z'),
  status: 'active',
  departmentId: 'dept-1',
  department: { name: 'Operations' },
  user: { id: `user-${id}`, name: `Employee ${id}`, role: { permissions: '[]' } },
  ...overrides,
});

const ownerEmployee = (id = 'owner-1') => employee(id, {
  employeeNum: 'OWNER-1',
  user: { id: 'owner-user', name: 'Company Owner', role: { permissions: JSON.stringify(['admin.full']) } },
});

const payrollItem = (
  employeeId: string,
  netPay: string,
  overrides: Record<string, unknown> = {},
) => ({
  id: `item-${employeeId}`,
  companyId: 'c1',
  payrollPeriodId: 'period-1',
  employeeId,
  salaryRecordId: `salary-${employeeId}`,
  employeeNameSnapshot: employeeId === 'owner-1' ? 'Company Owner' : `Employee ${employeeId}`,
  employeeNumSnapshot: employeeId === 'owner-1' ? 'OWNER-1' : `EMP-${employeeId}`,
  departmentNameSnapshot: 'Operations',
  baseSalary: netPay,
  grossPay: netPay,
  totalDeductions: '0.00',
  netPay,
  currency: 'SAR',
  status: 'calculated',
  calculatedAt: new Date('2026-07-01T00:00:00.000Z'),
  employee: employeeId === 'owner-1' ? ownerEmployee() : employee(employeeId),
  ...overrides,
});

function makePayrollExportApp(prisma: ReturnType<typeof makeFakePrisma>) {
  const app = express();
  app.use(express.json());

  const requireAuth = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const header = req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const payload = jwt.verify(header.slice(7), TEST_SECRET) as {
        id: string;
        companyId: string;
        employeeId: string | null;
        permissions: string[];
      };
      (req as express.Request & { user?: typeof payload }).user = payload;
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };

  registerPayrollExportRoutes({ app, prisma: prisma as any, requireAuth });
  return app;
}

const exportRequest = (
  prisma: ReturnType<typeof makeFakePrisma>,
  body: Record<string, unknown>,
  permissions: string[] = exportPermissions,
) => {
  const req = request(makePayrollExportApp(prisma))
    .post('/api/v2/payroll/periods/period-1/exports')
    .set('Authorization', `Bearer ${payrollToken(permissions)}`)
    .send(body);

  if (body.format === 'xlsx' || body.format === 'pdf') {
    return req.buffer(true).parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
  }

  return req;
};

const seedApprovedPeriod = (
  prisma: ReturnType<typeof makeFakePrisma>,
  options: { includeOwner?: boolean } = {},
) => {
  prisma._store.payrollPeriods.push(period());
  prisma._store.employees.push(employee('employee-1'));
  prisma._store.payrollItems.push(payrollItem('employee-1', '1000.00'));
  if (options.includeOwner) {
    prisma._store.employees.push(ownerEmployee());
    prisma._store.payrollItems.push(payrollItem('owner-1', '5000.00'));
  }
  prisma.companyOwnership.findFirst.mockResolvedValue({ userId: 'owner-user' });
};

describe('POST /api/v2/payroll/periods/:id/exports', () => {
  it('returns 403 without payroll.report or without reports.export', async () => {
    const prisma = makeFakePrisma();
    seedApprovedPeriod(prisma);

    const missingReport = await exportRequest(prisma, { format: 'csv' }, [PERMISSIONS.REPORTS_EXPORT]);
    const missingExport = await exportRequest(prisma, { format: 'csv' }, [PERMISSIONS.PAYROLL_REPORT]);

    expect(missingReport.status).toBe(403);
    expect(missingExport.status).toBe(403);
  });

  it('returns 400 for an invalid export format', async () => {
    const prisma = makeFakePrisma();
    seedApprovedPeriod(prisma);

    const response = await exportRequest(prisma, { format: 'docx' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('ValidationError');
  });

  it('returns 409 when the payroll period is not approved or paid', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period({ status: 'calculated' }));
    prisma._store.payrollItems.push(payrollItem('employee-1', '1000.00'));

    const response = await exportRequest(prisma, { format: 'csv' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('PAYROLL_REPORT_NOT_AVAILABLE');
  });

  it('returns 200 for csv, xlsx, and pdf with the correct content types', async () => {
    const prisma = makeFakePrisma();
    seedApprovedPeriod(prisma);

    const csv = await exportRequest(prisma, { format: 'csv' });
    const xlsx = await exportRequest(prisma, { format: 'xlsx' });
    const pdf = await exportRequest(prisma, { format: 'pdf' });

    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toContain('payroll-2026-07.csv');

    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
    expect(xlsx.headers['content-disposition']).toContain('payroll-2026-07.xlsx');

    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdf.headers['content-disposition']).toContain('payroll-2026-07.pdf');
  });

  it('hides owner rows and totals without salary.view_owner', async () => {
    const prisma = makeFakePrisma();
    seedApprovedPeriod(prisma, { includeOwner: true });

    const response = await exportRequest(prisma, { format: 'csv' });

    expect(response.status).toBe(200);
    expect(response.text).toContain('1000.00');
    expect(response.text).not.toContain('5000.00');
    expect(response.text).not.toContain('Company Owner');
    expect(response.text).toContain('"1"');
    expect(response.text).toContain('2026-07');
  });

  it('includes owner rows when salary.view_owner is granted', async () => {
    const prisma = makeFakePrisma();
    seedApprovedPeriod(prisma, { includeOwner: true });

    const response = await exportRequest(
      prisma,
      { format: 'csv' },
      [...exportPermissions, PERMISSIONS.SALARY_VIEW_OWNER],
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('1000.00');
    expect(response.text).toContain('5000.00');
    expect(response.text).toContain('Company Owner');
    expect(response.text).toContain('"2"');
  });

  it('keeps visible row count and visibleNet identical across csv, xlsx, and pdf', async () => {
    const prisma = makeFakePrisma();
    seedApprovedPeriod(prisma, { includeOwner: true });

    const csv = await exportRequest(prisma, { format: 'csv' });
    const xlsx = await exportRequest(prisma, { format: 'xlsx' });
    const pdf = await exportRequest(prisma, { format: 'pdf', locale: 'en' });

    expect(csv.status).toBe(200);
    expect(xlsx.status).toBe(200);
    expect(pdf.status).toBe(200);

    expect(csv.text).toContain('1000.00');
    expect(csv.text).not.toContain('5000.00');
    expect(csv.text).toContain('"1"');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.body as Buffer);
    const sheet = workbook.worksheets[0];
    expect(String(sheet.getCell('B6').value)).toBe('1');
    expect(String(sheet.getCell('D6').value)).toBe('1000.00');
    expect(String(sheet.getCell('H6').value)).toBe('1000.00');

    const pdfBody = pdf.body as Buffer;
    expect(pdfBody.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdfBody.length).toBeGreaterThan(100);
    expect(pdf.headers['content-disposition']).toContain('payroll-2026-07.pdf');

    const exportAudits = prisma._store.auditLogs
      .filter((entry: any) => entry.action === 'payroll.export')
      .map((entry: any) => (typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details));
    expect(exportAudits).toHaveLength(3);
    expect(exportAudits.every((details: any) => details.rowCount === 1)).toBe(true);
  });

  it('audits export metadata only and never logs salaries or tokens', async () => {
    const prisma = makeFakePrisma();
    seedApprovedPeriod(prisma);

    const response = await exportRequest(prisma, { format: 'csv' });
    expect(response.status).toBe(200);

    const audit = prisma._store.auditLogs.find((entry: any) => entry.action === 'payroll.export');
    expect(audit).toBeDefined();
    const auditDetails = typeof audit.details === 'string'
      ? JSON.parse(audit.details)
      : audit.details;
    expect(auditDetails).toMatchObject({
      periodId: 'period-1',
      rowCount: 1,
    });
    expect(JSON.stringify(auditDetails)).not.toContain('1000.00');
    expect(JSON.stringify(auditDetails)).not.toContain('password');
    expect(JSON.stringify(auditDetails)).not.toContain('token');
    expect(JSON.stringify(response.body)).not.toContain('Bearer');
  });

  it('returns 413 when the visible export exceeds 5000 rows', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    for (let index = 0; index < 5001; index += 1) {
      const employeeId = `employee-${index}`;
      prisma._store.employees.push(employee(employeeId));
      prisma._store.payrollItems.push(payrollItem(employeeId, '100.00'));
    }

    const response = await exportRequest(prisma, { format: 'csv' });
    expect(response.status).toBe(413);
    expect(response.body.error).toBe('PAYROLL_EXPORT_ROW_LIMIT_EXCEEDED');
  });
});

describe('payroll export route registration proposal', () => {
  it('documents that payroll routes remain available from the main app factory', async () => {
    const prisma = makeFakePrisma();
    seedApprovedPeriod(prisma);
    const mainApp = makeApp(prisma);
    const list = await request(mainApp)
      .get('/api/payroll/periods')
      .set('Authorization', `Bearer ${payrollToken(['payroll.view'])}`);
    expect(list.status).toBe(200);
  });
});
