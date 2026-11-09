import express from 'express';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { PERMISSIONS } from '../src/permissions';
import { registerReportTemplateExportRoutes } from '../src/reportTemplateExports';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

function makeExportPrisma() {
  const prisma = makeFakePrisma();
  prisma.companyOwnership.findFirst.mockResolvedValue(null);
  return prisma;
}

function makeExportApp(prisma: ReturnType<typeof makeFakePrisma>) {
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

  registerReportTemplateExportRoutes({ app, prisma: prisma as any, requireAuth });
  return app;
}

const authHeader = (permissions: string[]) =>
  `Bearer ${tokenFor({ id: 'u1', companyId: 'c1', employeeId: null, permissions })}`;

const exportRequest = (
  prisma: ReturnType<typeof makeFakePrisma>,
  body: Record<string, unknown>,
  permissions: string[],
) => {
  const req = request(makeExportApp(prisma))
    .post('/api/v2/reports/templates/exports')
    .set('Authorization', authHeader(permissions))
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

const fullPermissions = [
  PERMISSIONS.REPORTS_VIEW,
  PERMISSIONS.ATTENDANCE_VIEW,
  PERMISSIONS.REPORTS_EXPORT,
];

const baseBody = { builtInKey: 'attendance', templateVersion: 1, format: 'csv' as const };

describe('POST /api/v2/reports/templates/exports', () => {
  it('returns 403 without reports.export even if the template itself is authorized', async () => {
    const prisma = makeExportPrisma();
    const response = await exportRequest(prisma, baseBody, [
      PERMISSIONS.REPORTS_VIEW,
      PERMISSIONS.ATTENDANCE_VIEW,
    ]);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('TEMPLATE_EXPORT_FORBIDDEN');
  });

  it('returns 403 TEMPLATE_FORBIDDEN when the template baseline permission is missing, even with reports.export', async () => {
    const prisma = makeExportPrisma();
    const response = await exportRequest(prisma, baseBody, [PERMISSIONS.REPORTS_EXPORT]);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('TEMPLATE_FORBIDDEN');
  });

  it('returns 409 on a stale templateVersion', async () => {
    const prisma = makeExportPrisma();
    const response = await exportRequest(
      prisma,
      { ...baseBody, templateVersion: 42 },
      fullPermissions,
    );
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('TEMPLATE_VERSION_MISMATCH');
  });

  it('returns 400 for an invalid export format', async () => {
    const prisma = makeExportPrisma();
    const response = await exportRequest(prisma, { ...baseBody, format: 'docx' }, fullPermissions);
    expect(response.status).toBe(400);
  });

  it('rejects CSV export for purchasing_payments (xlsx/pdf only)', async () => {
    const prisma = makeExportPrisma();
    prisma.purchaseRequest = { findMany: vi.fn().mockResolvedValue([]) };
    prisma.purchaseOrder = { findMany: vi.fn().mockResolvedValue([]) };
    prisma.payrollPayment = { findMany: vi.fn().mockResolvedValue([]) };

    const response = await exportRequest(
      prisma,
      {
        builtInKey: 'purchasing_payments',
        templateVersion: 1,
        format: 'csv',
        filters: { from: '2026-07-01', to: '2026-07-15' },
      },
      [
        PERMISSIONS.REPORTS_COMPOSITE_VIEW,
        PERMISSIONS.PURCHASING_REPORT,
        PERMISSIONS.PAYROLL_PAYMENTS_VIEW,
        PERMISSIONS.REPORTS_EXPORT,
      ],
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('TEMPLATE_FORMAT_UNSUPPORTED');
  });

  it('exports purchasing_payments as xlsx and pdf without blended totals', async () => {
    const prisma = makeExportPrisma();
    prisma.purchaseRequest = { findMany: vi.fn().mockResolvedValue([]) };
    prisma.purchaseOrder = { findMany: vi.fn().mockResolvedValue([]) };
    prisma.payrollPayment = {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'pay-1',
          payrollPeriodId: 'pp-1',
          amount: '100.50',
          currency: 'SAR',
          paymentDate: new Date('2026-07-10T00:00:00.000Z'),
          reference: 'REF-1',
          status: 'posted',
          createdAt: new Date('2026-07-10T01:00:00.000Z'),
          voidedAt: null,
          isLegacyMigration: false,
        },
      ]),
    };
    const perms = [
      PERMISSIONS.REPORTS_COMPOSITE_VIEW,
      PERMISSIONS.PURCHASING_REPORT,
      PERMISSIONS.PAYROLL_PAYMENTS_VIEW,
      PERMISSIONS.REPORTS_EXPORT,
    ];
    const body = {
      builtInKey: 'purchasing_payments',
      templateVersion: 1,
      filters: { from: '2026-07-01', to: '2026-07-15' },
    };

    const xlsx = await exportRequest(prisma, { ...body, format: 'xlsx' }, perms);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);

    const pdf = await exportRequest(prisma, { ...body, format: 'pdf' }, perms);
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('neutralizes formula-like values in xlsx cells', async () => {
    const prisma = makeExportPrisma();
    prisma.attendance.findMany.mockResolvedValue([
      {
        id: 'att-1',
        employeeId: 'emp-1',
        date: new Date('2026-07-10T00:00:00.000Z'),
        clockIn: null,
        clockOut: null,
        status: 'present',
        employee: {
          employeeNum: '=CMD',
          departmentId: 'dept-1',
          department: { name: '+evil' },
          user: { id: 'u-emp-1', name: '@danger', role: { permissions: '[]' } },
        },
      },
    ]);
    const xlsx = await exportRequest(prisma, { ...baseBody, format: 'xlsx' }, fullPermissions);
    expect(xlsx.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.body as Buffer);
    const values = workbook.worksheets[0].getSheetValues().flat().filter(Boolean).map(String);
    expect(values.some((value) => value === "'=CMD")).toBe(true);
    expect(values.some((value) => value === "'+evil")).toBe(true);
    expect(values.some((value) => value === "'@danger")).toBe(true);
  });

  it('returns 200 for csv, xlsx, and pdf with correct content types', async () => {
    const prisma = makeExportPrisma();
    prisma.attendance.findMany.mockResolvedValue([
      {
        id: 'att-1',
        employeeId: 'emp-1',
        date: new Date('2026-07-10T00:00:00.000Z'),
        clockIn: new Date('2026-07-10T08:00:00.000Z'),
        clockOut: new Date('2026-07-10T16:00:00.000Z'),
        status: 'present',
        employee: {
          employeeNum: 'EMP-1',
          departmentId: 'dept-1',
          department: { name: 'العمليات' },
          user: { id: 'u-emp-1', name: 'موظف تجريبي', role: { permissions: '[]' } },
        },
      },
    ]);

    const csv = await exportRequest(prisma, { ...baseBody, format: 'csv' }, fullPermissions);
    const xlsx = await exportRequest(prisma, { ...baseBody, format: 'xlsx' }, fullPermissions);
    const pdf = await exportRequest(prisma, { ...baseBody, format: 'pdf' }, fullPermissions);

    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('EMP-1');

    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.body as Buffer);
    const values = workbook.worksheets[0].getSheetValues().flat().filter(Boolean).map(String);
    expect(values.some((value) => value.includes('EMP-1'))).toBe(true);

    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('audits export metadata only (ids/keys/versions/counts) and never logs row content', async () => {
    const prisma = makeExportPrisma();
    prisma.attendance.findMany.mockResolvedValue([
      {
        id: 'att-1',
        employeeId: 'emp-1',
        date: new Date('2026-07-10T00:00:00.000Z'),
        clockIn: null,
        clockOut: null,
        status: 'present',
        employee: {
          employeeNum: 'EMP-SECRET',
          departmentId: 'dept-1',
          department: { name: 'قسم سري' },
          user: { id: 'u-emp-1', name: 'اسم سري', role: { permissions: '[]' } },
        },
      },
    ]);

    const response = await exportRequest(prisma, { ...baseBody, format: 'csv' }, fullPermissions);
    expect(response.status).toBe(200);

    const audit = prisma._store.auditLogs.find((row: any) => row.action === 'template.export');
    expect(audit).toBeDefined();
    const details = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
    expect(details).toMatchObject({ reportType: 'attendance', templateVersion: 1, format: 'csv', rowCount: 1 });
    expect(JSON.stringify(details)).not.toContain('سري');
    expect(JSON.stringify(details)).not.toContain('EMP-SECRET');
  });

  it('returns 413 when the compiled export exceeds the total row cap', async () => {
    const prisma = makeExportPrisma();
    const rows = Array.from({ length: 5001 }, (_, index) => ({
      id: `att-${index}`,
      employeeId: `emp-${index}`,
      date: new Date('2026-07-10T00:00:00.000Z'),
      clockIn: null,
      clockOut: null,
      status: 'present',
      employee: {
        employeeNum: `EMP-${index}`,
        departmentId: 'dept-1',
        department: { name: 'العمليات' },
        user: { id: `u-emp-${index}`, name: 'موظف', role: { permissions: '[]' } },
      },
    }));
    prisma.attendance.findMany.mockResolvedValue(rows);

    const response = await exportRequest(prisma, { ...baseBody, format: 'csv' }, fullPermissions);
    expect(response.status).toBe(413);
    expect(response.body.error).toBe('TEMPLATE_EXPORT_ROW_LIMIT_EXCEEDED');
  });
});
