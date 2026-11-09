import express from 'express';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { PERMISSIONS } from '../src/permissions';
import { registerTrainingExportRoutes } from '../src/trainingExports';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';
import { addTrainingIdentity, makeTrainingPrisma, UUIDS } from './training_test_helpers';

const exportToken = (
  permissions: string[] = [
    PERMISSIONS.TRAINING_VIEW_COMPANY,
    PERMISSIONS.TRAINING_REPORT,
    PERMISSIONS.HR_VIEW,
  ],
  id = 'u1',
) => tokenFor({ id, companyId: 'c1', employeeId: null, permissions });

function makeTrainingExportApp(prisma: ReturnType<typeof makeFakePrisma>) {
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

  registerTrainingExportRoutes({ app, prisma: prisma as any, requireAuth });
  return app;
}

const exportRequest = (
  prisma: ReturnType<typeof makeFakePrisma>,
  body: Record<string, unknown>,
  permissions: string[] = [
    PERMISSIONS.TRAINING_VIEW_COMPANY,
    PERMISSIONS.TRAINING_REPORT,
    PERMISSIONS.HR_VIEW,
  ],
) => {
  const req = request(makeTrainingExportApp(prisma))
    .post('/api/training/exports')
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

const seedCourse = (index: number, overrides: Record<string, unknown> = {}) => ({
  id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  companyId: 'c1',
  courseCode: `TR-202607-${String(index).padStart(4, '0')}`,
  title: `Course ${index}`,
  description: 'Private description',
  category: 'leadership',
  instructorName: 'Trainer',
  deliveryMode: 'online',
  location: null,
  startDate: new Date('2026-07-01T00:00:00.000Z'),
  endDate: new Date('2026-07-10T00:00:00.000Z'),
  durationHours: 4,
  capacity: 10,
  status: 'published',
  createdByUserId: 'hr-1',
  createdAt: new Date('2026-07-01T08:00:00.000Z'),
  updatedAt: new Date('2026-07-01T08:00:00.000Z'),
  ...overrides,
});

const fixture = () => {
  const prisma = makeTrainingPrisma();
  addTrainingIdentity(prisma, {
    userId: 'hr-1',
    employeeId: UUIDS.employee3,
    departmentId: UUIDS.department1,
    permissions: ['training.view_company', 'training.report', 'hr.view'],
  });
  prisma.companyOwnership.findFirst.mockResolvedValue(null);
  prisma._training.courses.push(seedCourse(1));
  prisma._training.assignments.push({
    id: '30000000-0000-4000-8000-000000000001',
    companyId: 'c1',
    courseId: seedCourse(1).id,
    employeeId: UUIDS.employee3,
    employeeNameSnapshot: 'Employee Three',
    employeeNumSnapshot: 'EMP-0003',
    departmentIdSnapshot: UUIDS.department1,
    departmentNameSnapshot: 'Department One',
    status: 'completed',
    progressPercent: 100,
    score: 80,
    assignedByUserId: 'hr-1',
    assignedAt: new Date('2026-07-02T08:00:00.000Z'),
    startedAt: null,
    submittedAt: null,
    completedAt: new Date('2026-07-09T08:00:00.000Z'),
    reviewedByUserId: 'reviewer-1',
    reviewedAt: new Date('2026-07-09T08:00:00.000Z'),
    reviewNote: 'Private note',
    createdAt: new Date('2026-07-02T08:00:00.000Z'),
    updatedAt: new Date('2026-07-09T08:00:00.000Z'),
  });
  return prisma;
};

describe('POST /api/training/exports', () => {
  it('returns 403 without training.report', async () => {
    const prisma = fixture();
    const response = await exportRequest(prisma, { format: 'csv' }, ['training.view_company']);
    expect(response.status).toBe(403);
  });

  it('allows admin.full without training.report', async () => {
    const prisma = fixture();
    const response = await exportRequest(prisma, { format: 'csv' }, [PERMISSIONS.ADMIN_FULL]);
    expect(response.status).toBe(200);
  });

  it('returns 400 for an invalid export format', async () => {
    const prisma = fixture();
    const response = await exportRequest(prisma, { format: 'docx' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('ValidationError');
  });

  it('returns 200 for csv, xlsx, and pdf with the correct content types', async () => {
    const prisma = fixture();
    const csv = await exportRequest(prisma, { format: 'csv', scope: 'company' });
    const xlsx = await exportRequest(prisma, { format: 'xlsx', scope: 'company' });
    const pdf = await exportRequest(prisma, { format: 'pdf', scope: 'company' });

    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/training-\d{4}-\d{2}-\d{2}\.csv/);

    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
    expect(xlsx.headers['content-disposition']).toMatch(/training-\d{4}-\d{2}-\d{2}\.xlsx/);

    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdf.headers['content-disposition']).toMatch(/training-\d{4}-\d{2}-\d{2}\.pdf/);
  });

  it('includes flattened course rows in the csv body and neutralizes formula cells', async () => {
    const prisma = fixture();
    prisma._training.courses[0].title = '=HYPERLINK("evil")';
    const response = await exportRequest(prisma, { format: 'csv', scope: 'company' });

    expect(response.status).toBe(200);
    expect(response.text).toContain('TR-202607-0001');
    expect(response.text).toContain('"\'=HYPERLINK(""evil"")"');
    expect(response.text).not.toContain('Employee Three');
  });

  it('produces a well-formed xlsx workbook with course rows', async () => {
    const prisma = fixture();
    const response = await exportRequest(prisma, { format: 'xlsx', scope: 'company' });
    expect(response.status).toBe(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as Buffer);
    const values = workbook.worksheets[0].getSheetValues().flat().filter(Boolean).map(String);
    expect(values.some((value) => value.includes('TR-202607-0001'))).toBe(true);
    expect(values.some((value) => value.includes('Course 1'))).toBe(true);
  });

  it('neutralizes formula cells in xlsx exports', async () => {
    const prisma = fixture();
    prisma._training.courses[0].title = '=HYPERLINK("evil")';
    const response = await exportRequest(prisma, { format: 'xlsx', scope: 'company' });
    expect(response.status).toBe(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as Buffer);
    const values = workbook.worksheets[0].getSheetValues().flat().filter(Boolean).map(String);
    expect(values.some((value) => value === "'=HYPERLINK(\"evil\")")).toBe(true);
    expect(values.some((value) => value === '=HYPERLINK("evil")')).toBe(false);
  });

  it('produces a valid pdf document', async () => {
    const prisma = fixture();
    const response = await exportRequest(prisma, { format: 'pdf', locale: 'en', scope: 'company' });
    expect(response.status).toBe(200);
    const pdfBody = response.body as Buffer;
    expect(pdfBody.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdfBody.length).toBeGreaterThan(100);
  });

  it('audits export metadata only and never logs course titles', async () => {
    const prisma = fixture();
    const response = await exportRequest(prisma, { format: 'csv', scope: 'company' });
    expect(response.status).toBe(200);

    const audit = prisma._store.auditLogs.find((entry: any) => entry.action === 'training.export');
    expect(audit).toBeDefined();
    const auditDetails = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
    expect(auditDetails).toMatchObject({ format: 'csv', rowCount: 1 });
    expect(JSON.stringify(auditDetails)).not.toContain('Course 1');
    expect(JSON.stringify(auditDetails)).not.toContain('Employee Three');
  });

  it('returns 413 when the export exceeds the row limit', async () => {
    const prisma = makeTrainingPrisma();
    addTrainingIdentity(prisma, {
      userId: 'hr-1',
      permissions: ['training.view_company', 'training.report', 'hr.view'],
    });
    prisma.companyOwnership.findFirst.mockResolvedValue(null);
    for (let index = 0; index < 5001; index += 1) {
      prisma._training.courses.push(seedCourse(index + 1));
    }

    const response = await exportRequest(prisma, { format: 'csv', scope: 'company' });
    expect(response.status).toBe(413);
    expect(response.body.error).toBe('TRAINING_EXPORT_ROW_LIMIT_EXCEEDED');
  });

  it('rejects an over-long date range using the shared training report validation', async () => {
    const prisma = fixture();
    const response = await exportRequest(prisma, {
      format: 'csv',
      scope: 'company',
      from: '2024-01-01',
      to: '2026-01-02',
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('TRAINING_DATE_RANGE_TOO_LONG');
  });
});
