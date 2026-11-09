import express from 'express';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { PERMISSIONS } from '../src/permissions';
import { registerPurchasingExportRoutes } from '../src/purchasingExports';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

const exportPermissions = [PERMISSIONS.PURCHASING_REPORT, PERMISSIONS.REPORTS_EXPORT];

const exportToken = (permissions: string[] = exportPermissions, id = 'u1') =>
  tokenFor({ id, companyId: 'c1', employeeId: null, permissions });

type StoreRow = Record<string, unknown>;

function makePurchasingExportPrisma() {
  const requests: StoreRow[] = [];
  const orders: StoreRow[] = [];
  const prisma = makeFakePrisma();

  prisma.purchaseRequest = {
    findMany: vi.fn(async ({ where, take }: any = {}) => {
      let rows = requests.filter((row) => {
        if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
        if (where?.status !== undefined && row.status !== where.status) return false;
        if (where?.departmentId !== undefined && row.departmentId !== where.departmentId) return false;
        return true;
      }).map((row) => ({ ...row }));
      if (take !== undefined) rows = rows.slice(0, take);
      return rows;
    }),
  };

  prisma.purchaseOrder = {
    findMany: vi.fn(async ({ where, take }: any = {}) => {
      let rows = orders.filter((row) => {
        if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
        if (where?.status !== undefined && row.status !== where.status) return false;
        if (where?.vendorId !== undefined && row.vendorId !== where.vendorId) return false;
        return true;
      }).map((row) => ({ ...row, purchaseRequest: requests.find((request) => request.id === row.purchaseRequestId) }));
      if (take !== undefined) rows = rows.slice(0, take);
      return rows;
    }),
  };

  prisma.companyOwnership.findFirst.mockResolvedValue(null);

  return { prisma, stores: { requests, orders } };
}

function makePurchasingExportApp(prisma: ReturnType<typeof makeFakePrisma>) {
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

  registerPurchasingExportRoutes({ app, prisma: prisma as any, requireAuth });
  return app;
}

const exportRequest = (
  prisma: ReturnType<typeof makeFakePrisma>,
  body: Record<string, unknown>,
  permissions: string[] = exportPermissions,
) => {
  const req = request(makePurchasingExportApp(prisma))
    .post('/api/v2/purchasing/exports')
    .set('Authorization', `Bearer ${exportToken(permissions)}`)
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

const seedRequestRow = (overrides: Partial<StoreRow> = {}): StoreRow => ({
  id: 'PR-1',
  companyId: 'c1',
  requestNumber: 'PR-202607-0001',
  title: 'Office chairs',
  requesterNameSnapshot: 'Requester One',
  departmentNameSnapshot: 'Operations',
  status: 'approved',
  totalEstimated: '500.00',
  createdAt: new Date('2026-07-10T10:00:00.000Z'),
  updatedAt: new Date('2026-07-10T10:00:00.000Z'),
  ...overrides,
});

const seedOrderRow = (overrides: Partial<StoreRow> = {}): StoreRow => ({
  id: 'PO-1',
  companyId: 'c1',
  purchaseRequestId: 'PR-1',
  orderNumber: 'PO-202607-0001',
  vendorId: 'v1',
  vendorNameSnapshot: 'Vendor One',
  status: 'issued',
  totalAmount: '500.00',
  createdAt: new Date('2026-07-11T10:00:00.000Z'),
  updatedAt: new Date('2026-07-11T10:00:00.000Z'),
  ...overrides,
});

describe('POST /api/v2/purchasing/exports', () => {
  it('returns 403 without purchasing.report or without reports.export', async () => {
    const { prisma } = makePurchasingExportPrisma();

    const missingReport = await exportRequest(prisma, { format: 'csv' }, [PERMISSIONS.REPORTS_EXPORT]);
    const missingExport = await exportRequest(prisma, { format: 'csv' }, [PERMISSIONS.PURCHASING_REPORT]);

    expect(missingReport.status).toBe(403);
    expect(missingExport.status).toBe(403);
  });

  it('returns 400 for an invalid export format', async () => {
    const { prisma } = makePurchasingExportPrisma();

    const response = await exportRequest(prisma, { format: 'docx' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('ValidationError');
  });

  it('returns 200 for csv, xlsx, and pdf with the correct content types', async () => {
    const { prisma, stores } = makePurchasingExportPrisma();
    stores.requests.push(seedRequestRow());
    stores.orders.push(seedOrderRow());

    const csv = await exportRequest(prisma, { format: 'csv' });
    const xlsx = await exportRequest(prisma, { format: 'xlsx' });
    const pdf = await exportRequest(prisma, { format: 'pdf' });

    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/purchasing-\d{4}-\d{2}-\d{2}\.csv/);

    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
    expect(xlsx.headers['content-disposition']).toMatch(/purchasing-\d{4}-\d{2}-\d{2}\.xlsx/);

    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdf.headers['content-disposition']).toMatch(/purchasing-\d{4}-\d{2}-\d{2}\.pdf/);
  });

  it('includes request and order rows in the csv body and hides owner-only requests', async () => {
    const { prisma, stores } = makePurchasingExportPrisma();
    stores.requests.push(seedRequestRow());
    stores.orders.push(seedOrderRow());

    const response = await exportRequest(prisma, { format: 'csv' });

    expect(response.status).toBe(200);
    expect(response.text).toContain('PR-202607-0001');
    expect(response.text).toContain('PO-202607-0001');
    expect(response.text).toContain('500.00');
  });

  it('produces a well-formed xlsx workbook with request and order sections', async () => {
    const { prisma, stores } = makePurchasingExportPrisma();
    stores.requests.push(seedRequestRow());
    stores.orders.push(seedOrderRow());

    const response = await exportRequest(prisma, { format: 'xlsx' });
    expect(response.status).toBe(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as Buffer);
    const sheet = workbook.worksheets[0];
    const values = sheet.getSheetValues().flat().filter(Boolean).map(String);
    expect(values.some((value) => value.includes('PR-202607-0001'))).toBe(true);
    expect(values.some((value) => value.includes('PO-202607-0001'))).toBe(true);
  });

  it('produces a valid pdf document', async () => {
    const { prisma, stores } = makePurchasingExportPrisma();
    stores.requests.push(seedRequestRow());

    const response = await exportRequest(prisma, { format: 'pdf', locale: 'en' });
    expect(response.status).toBe(200);
    const pdfBody = response.body as Buffer;
    expect(pdfBody.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdfBody.length).toBeGreaterThan(100);
  });

  it('audits export metadata only and never logs vendor or request titles', async () => {
    const { prisma, stores } = makePurchasingExportPrisma();
    stores.requests.push(seedRequestRow());
    stores.orders.push(seedOrderRow());

    const response = await exportRequest(prisma, { format: 'csv' });
    expect(response.status).toBe(200);

    const audit = prisma._store.auditLogs.find((entry: StoreRow) => entry.action === 'purchasing.export');
    expect(audit).toBeDefined();
    const auditDetails = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
    expect(auditDetails).toMatchObject({ format: 'csv', requestCount: 1, orderCount: 1 });
    expect(JSON.stringify(auditDetails)).not.toContain('Office chairs');
    expect(JSON.stringify(auditDetails)).not.toContain('Vendor One');
  });

  it('returns 413 when the export exceeds the row limit', async () => {
    const { prisma, stores } = makePurchasingExportPrisma();
    for (let index = 0; index < 5001; index += 1) {
      stores.requests.push(seedRequestRow({ id: `PR-${index}`, requestNumber: `PR-202607-${index}` }));
    }

    const response = await exportRequest(prisma, { format: 'csv' });
    expect(response.status).toBe(413);
    expect(response.body.error).toBe('PURCHASING_EXPORT_ROW_LIMIT_EXCEEDED');
  });

  it('rejects an over-long date range using the shared purchasing report validation', async () => {
    const { prisma } = makePurchasingExportPrisma();

    const response = await exportRequest(prisma, { format: 'csv', from: '2024-01-01', to: '2026-01-02' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('DATE_RANGE_TOO_LONG');
  });
});
