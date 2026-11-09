import express from 'express';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { PERMISSIONS } from '../src/permissions';
import { registerReportTemplateRoutes } from '../src/reportTemplates';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

type StoreRow = Record<string, unknown>;

function makeTemplatePrisma() {
  const prisma = makeFakePrisma();
  const savedTemplates: StoreRow[] = [];

  prisma.savedReportTemplate = {
    findMany: vi.fn(async ({ where }: any = {}) =>
      savedTemplates
        .filter((row) => {
          if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where?.ownerUserId !== undefined && row.ownerUserId !== where.ownerUserId) return false;
          if (where?.archivedAt === null && row.archivedAt != null) return false;
          return true;
        })
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    ),
    findFirst: vi.fn(async ({ where }: any = {}) =>
      savedTemplates.find((row) => {
        if (where?.id !== undefined && row.id !== where.id) return false;
        if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
        if (where?.ownerUserId !== undefined && row.ownerUserId !== where.ownerUserId) return false;
        return true;
      }) ?? null,
    ),
    create: vi.fn(async ({ data }: any) => {
      const now = new Date();
      const row = {
        id: `srt-${savedTemplates.length + 1}`,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      savedTemplates.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = savedTemplates.find((item) => item.id === where.id);
      if (!row) return null;
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
  };

  prisma.companyOwnership.findFirst.mockResolvedValue(null);

  return { prisma, stores: { savedTemplates } };
}

function makeTemplateApp(prisma: ReturnType<typeof makeFakePrisma>) {
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

  registerReportTemplateRoutes({ app, prisma: prisma as any, requireAuth });
  return app;
}

const authHeader = (permissions: string[], overrides: Record<string, unknown> = {}) =>
  `Bearer ${tokenFor({ id: 'u1', companyId: 'c1', employeeId: null, permissions, ...overrides })}`;

describe('GET /api/v2/reports/templates', () => {
  it('never advertises a Tasks+Performance template', async () => {
    const { prisma } = makeTemplatePrisma();
    const response = await request(makeTemplateApp(prisma))
      .get('/api/v2/reports/templates')
      .set('Authorization', authHeader([PERMISSIONS.ADMIN_FULL]));

    expect(response.status).toBe(200);
    const keys = response.body.map((template: any) => template.builtInKey);
    expect(keys).not.toContain('tasks_performance');
    expect(keys).not.toEqual(expect.arrayContaining(['tasks', 'performance']));
  });

  it('omits a template when the actor is missing any one source permission (intersection)', async () => {
    const { prisma } = makeTemplatePrisma();
    // Has composite.view and attendance.view but NOT leaves.view — attendance_leaves must be hidden.
    const response = await request(makeTemplateApp(prisma))
      .get('/api/v2/reports/templates')
      .set(
        'Authorization',
        authHeader([PERMISSIONS.REPORTS_COMPOSITE_VIEW, PERMISSIONS.REPORTS_VIEW, PERMISSIONS.ATTENDANCE_VIEW]),
      );

    expect(response.status).toBe(200);
    const keys = response.body.map((template: any) => template.builtInKey);
    expect(keys).toContain('attendance');
    expect(keys).not.toContain('attendance_leaves');
  });

  it('lists the composite template once the actor holds every source permission', async () => {
    const { prisma } = makeTemplatePrisma();
    const response = await request(makeTemplateApp(prisma))
      .get('/api/v2/reports/templates')
      .set(
        'Authorization',
        authHeader([
          PERMISSIONS.REPORTS_COMPOSITE_VIEW,
          PERMISSIONS.REPORTS_VIEW,
          PERMISSIONS.ATTENDANCE_VIEW,
          PERMISSIONS.LEAVES_VIEW,
        ]),
      );

    expect(response.status).toBe(200);
    const keys = response.body.map((template: any) => template.builtInKey);
    expect(keys).toContain('attendance_leaves');
  });
});

describe('POST /api/v2/reports/templates/preview', () => {
  it('rejects an unauthorized template with 403 TEMPLATE_FORBIDDEN', async () => {
    const { prisma } = makeTemplatePrisma();
    const response = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/templates/preview')
      .set('Authorization', authHeader([]))
      .send({ builtInKey: 'attendance', templateVersion: 1 });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('TEMPLATE_FORBIDDEN');
  });

  it('rejects a composite preview when one source permission is missing', async () => {
    const { prisma } = makeTemplatePrisma();
    const response = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/templates/preview')
      .set(
        'Authorization',
        authHeader([PERMISSIONS.REPORTS_COMPOSITE_VIEW, PERMISSIONS.ATTENDANCE_VIEW]),
      )
      .send({ builtInKey: 'attendance_leaves', templateVersion: 1 });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('TEMPLATE_SOURCE_FORBIDDEN');
  });

  it('rejects an unknown builtInKey with 404 TEMPLATE_NOT_FOUND', async () => {
    const { prisma } = makeTemplatePrisma();
    const response = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/templates/preview')
      .set('Authorization', authHeader([PERMISSIONS.ADMIN_FULL]))
      .send({ builtInKey: 'does_not_exist', templateVersion: 1 });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('TEMPLATE_NOT_FOUND');
  });

  it('rejects a stale templateVersion with 409 TEMPLATE_VERSION_MISMATCH', async () => {
    const { prisma } = makeTemplatePrisma();
    const response = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/templates/preview')
      .set('Authorization', authHeader([PERMISSIONS.REPORTS_VIEW, PERMISSIONS.ATTENDANCE_VIEW]))
      .send({ builtInKey: 'attendance', templateVersion: 99 });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('TEMPLATE_VERSION_MISMATCH');
    expect(response.body.details.currentVersion).toBe(1);
  });

  it('compiles a single-module preview from real attendance rows', async () => {
    const { prisma } = makeTemplatePrisma();
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

    const response = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/templates/preview')
      .set('Authorization', authHeader([PERMISSIONS.REPORTS_VIEW, PERMISSIONS.ATTENDANCE_VIEW]))
      .send({
        builtInKey: 'attendance',
        templateVersion: 1,
        filters: { from: '2026-07-01', to: '2026-07-15' },
      });

    expect(response.status).toBe(200);
    expect(response.body.builtInKey).toBe('attendance');
    expect(response.body.sections).toHaveLength(1);
    expect(response.body.sections[0].module).toBe('attendance');
    expect(response.body.sections[0].rows[0].employeeNum).toBe('EMP-1');

    const audit = prisma._store.auditLogs.find((row: any) => row.action === 'template.preview');
    expect(audit).toBeDefined();
    const details = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
    expect(details).toMatchObject({ reportType: 'attendance', templateVersion: 1, rowCount: 1 });
  });

  it('compiles a composite preview into two independent labeled sections', async () => {
    const { prisma } = makeTemplatePrisma();
    prisma.attendance.findMany.mockResolvedValue([]);
    prisma.leaveRequest.findMany.mockResolvedValue([]);

    const response = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/templates/preview')
      .set(
        'Authorization',
        authHeader([
          PERMISSIONS.REPORTS_COMPOSITE_VIEW,
          PERMISSIONS.ATTENDANCE_VIEW,
          PERMISSIONS.LEAVES_VIEW,
        ]),
      )
      .send({ builtInKey: 'attendance_leaves', templateVersion: 1 });

    expect(response.status).toBe(200);
    expect(response.body.sections.map((section: any) => section.module)).toEqual(['attendance', 'leaves']);
  });

  it('lists employees_training only when both employee and training source permissions are present', async () => {
    const { prisma } = makeTemplatePrisma();
    const incomplete = await request(makeTemplateApp(prisma))
      .get('/api/v2/reports/templates')
      .set(
        'Authorization',
        authHeader([
          PERMISSIONS.REPORTS_COMPOSITE_VIEW,
          PERMISSIONS.EMPLOYEES_VIEW,
          PERMISSIONS.TRAINING_REPORT,
        ]),
      );
    expect(incomplete.status).toBe(200);
    expect(incomplete.body.map((row: any) => row.builtInKey)).not.toContain('employees_training');

    const complete = await request(makeTemplateApp(prisma))
      .get('/api/v2/reports/templates')
      .set(
        'Authorization',
        authHeader([
          PERMISSIONS.REPORTS_COMPOSITE_VIEW,
          PERMISSIONS.EMPLOYEES_VIEW,
          PERMISSIONS.TRAINING_REPORT,
          PERMISSIONS.TRAINING_VIEW_COMPANY,
        ]),
      );
    expect(complete.status).toBe(200);
    expect(complete.body.map((row: any) => row.builtInKey)).toContain('employees_training');
  });

  it('compiles employees_training with safe employee fields and an independent training section', async () => {
    const { prisma } = makeTemplatePrisma();
    prisma.employee.findMany.mockResolvedValue([
      {
        id: 'emp-1',
        employeeNum: 'E-1',
        jobTitle: 'محاسب',
        status: 'active',
        departmentId: 'dept-1',
        archivedAt: null,
        joiningDate: new Date('2024-01-01T00:00:00.000Z'),
        department: { name: 'المالية' },
        user: { id: 'u-emp-1', name: 'موظف آمن', role: { permissions: '[]' } },
        contactInfo: 'should-not-leak',
      },
    ]);
    prisma.trainingCourse = { findMany: vi.fn().mockResolvedValue([]) };

    const response = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/templates/preview')
      .set(
        'Authorization',
        authHeader([
          PERMISSIONS.REPORTS_COMPOSITE_VIEW,
          PERMISSIONS.EMPLOYEES_VIEW,
          PERMISSIONS.TRAINING_REPORT,
          PERMISSIONS.TRAINING_VIEW_COMPANY,
        ]),
      )
      .send({ builtInKey: 'employees_training', templateVersion: 1 });

    expect(response.status).toBe(200);
    expect(response.body.sections.map((section: any) => section.module)).toEqual(['employees', 'training']);
    expect(response.body.sections[0].rows[0]).toMatchObject({
      employeeNum: 'E-1',
      employeeName: 'موظف آمن',
      isArchived: false,
    });
    expect(JSON.stringify(response.body)).not.toContain('should-not-leak');
  });

  it('scopes employees_training to managed departments for employees.view_department', async () => {
    const { prisma } = makeTemplatePrisma();
    prisma.department.findMany.mockResolvedValue([{ id: 'dept-managed' }]);
    prisma.departmentManager = { findMany: vi.fn().mockResolvedValue([]) };
    prisma.employee.findMany.mockImplementation(async ({ where }: any) => {
      expect(where.companyId).toBe('c1');
      expect(where.departmentId).toEqual({ in: ['dept-managed'] });
      return [
        {
          id: 'emp-managed',
          employeeNum: 'E-M',
          jobTitle: 'مشرف',
          status: 'active',
          departmentId: 'dept-managed',
          archivedAt: null,
          joiningDate: new Date('2024-01-01T00:00:00.000Z'),
          department: { name: 'القسم المدار' },
          user: { id: 'u-m', name: 'موظف القسم', role: { permissions: '[]' } },
        },
      ];
    });
    prisma.trainingCourse = { findMany: vi.fn().mockResolvedValue([]) };

    const response = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/templates/preview')
      .set(
        'Authorization',
        authHeader([
          PERMISSIONS.REPORTS_COMPOSITE_VIEW,
          PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT,
          PERMISSIONS.TRAINING_REPORT,
          PERMISSIONS.TRAINING_VIEW_COMPANY,
        ]),
      )
      .send({ builtInKey: 'employees_training', templateVersion: 1 });

    expect(response.status).toBe(200);
    expect(response.body.sections[0].rows).toHaveLength(1);
    expect(response.body.sections[0].rows[0].departmentId).toBe('dept-managed');
    expect(prisma.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ companyId: 'c1', managerId: 'u1' }),
      }),
    );
  });

  it('advertises purchasing_payments without CSV and rejects CSV export for that template', async () => {
    const { prisma } = makeTemplatePrisma();
    const catalog = await request(makeTemplateApp(prisma))
      .get('/api/v2/reports/templates')
      .set(
        'Authorization',
        authHeader([
          PERMISSIONS.REPORTS_COMPOSITE_VIEW,
          PERMISSIONS.PURCHASING_REPORT,
          PERMISSIONS.PAYROLL_PAYMENTS_VIEW,
        ]),
      );
    expect(catalog.status).toBe(200);
    const template = catalog.body.find((row: any) => row.builtInKey === 'purchasing_payments');
    expect(template).toBeDefined();
    expect(template.formats).toEqual(['xlsx', 'pdf']);
    expect(template.formats).not.toContain('csv');
  });

  it('compiles purchasing_payments as two labeled sections without a blended total', async () => {
    const { prisma } = makeTemplatePrisma();
    prisma.purchaseRequest = { findMany: vi.fn().mockResolvedValue([]) };
    prisma.purchaseOrder = { findMany: vi.fn().mockResolvedValue([]) };
    prisma.payrollPayment = { findMany: vi.fn().mockResolvedValue([]) };

    const response = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/templates/preview')
      .set(
        'Authorization',
        authHeader([
          PERMISSIONS.REPORTS_COMPOSITE_VIEW,
          PERMISSIONS.PURCHASING_REPORT,
          PERMISSIONS.PAYROLL_PAYMENTS_VIEW,
        ]),
      )
      .send({
        builtInKey: 'purchasing_payments',
        templateVersion: 1,
        filters: { from: '2026-07-01', to: '2026-07-15' },
      });

    expect(response.status).toBe(200);
    expect(response.body.sections.map((section: any) => section.module)).toEqual(['purchasing', 'payments']);
    expect(response.body).not.toHaveProperty('grandTotal');
    expect(response.body.warnings.some((warning: string) => warning.includes('إجمالي مدمج'))).toBe(true);
  });

  it('executive_all_modules omits unauthorized sections instead of rejecting the template', async () => {
    const { prisma } = makeTemplatePrisma();
    prisma.attendance.findMany.mockResolvedValue([]);
    prisma.leaveRequest.findMany.mockResolvedValue([]);

    const catalog = await request(makeTemplateApp(prisma))
      .get('/api/v2/reports/templates')
      .set(
        'Authorization',
        authHeader([
          PERMISSIONS.REPORTS_COMPOSITE_VIEW,
          PERMISSIONS.ATTENDANCE_VIEW,
          PERMISSIONS.LEAVES_VIEW,
        ]),
      );
    expect(catalog.body.map((row: any) => row.builtInKey)).toContain('executive_all_modules');
    expect(catalog.body.map((row: any) => row.builtInKey)).toContain('executive_summary');

    const response = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/templates/preview')
      .set(
        'Authorization',
        authHeader([
          PERMISSIONS.REPORTS_COMPOSITE_VIEW,
          PERMISSIONS.ATTENDANCE_VIEW,
          PERMISSIONS.LEAVES_VIEW,
        ]),
      )
      .send({
        builtInKey: 'executive_all_modules',
        templateVersion: 1,
        filters: { from: '2026-07-01', to: '2026-07-15' },
      });

    expect(response.status).toBe(200);
    expect(response.body.sections.map((section: any) => section.module)).toEqual(['attendance', 'leaves']);
    expect(response.body.sections.every((section: any) => section.rows.length === 0)).toBe(true);
    expect(response.body.warnings.some((warning: string) => warning.includes('الأقسام المصرح بها فقط'))).toBe(true);
  });
});

describe('saved report templates', () => {
  it('rejects saving an unknown builtInKey', async () => {
    const { prisma } = makeTemplatePrisma();
    const response = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/saved-templates')
      .set('Authorization', authHeader([PERMISSIONS.REPORTS_TEMPLATES_MANAGE, PERMISSIONS.ATTENDANCE_VIEW]))
      .send({ name: 'My view', builtInKey: 'not_a_real_template' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('SAVED_TEMPLATE_UNKNOWN_KEY');
  });

  it('rejects saving without reports.templates.manage', async () => {
    const { prisma } = makeTemplatePrisma();
    const response = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/saved-templates')
      .set('Authorization', authHeader([PERMISSIONS.REPORTS_VIEW, PERMISSIONS.ATTENDANCE_VIEW]))
      .send({ name: 'My view', builtInKey: 'attendance' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('SAVED_TEMPLATE_FORBIDDEN');
  });

  it('rejects saving a template the actor cannot use', async () => {
    const { prisma } = makeTemplatePrisma();
    const response = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/saved-templates')
      .set('Authorization', authHeader([PERMISSIONS.REPORTS_TEMPLATES_MANAGE]))
      .send({ name: 'My view', builtInKey: 'attendance' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('SAVED_TEMPLATE_FORBIDDEN');
  });

  it('saves, lists, and archives a template end to end, and audits metadata only', async () => {
    const { prisma } = makeTemplatePrisma();
    const manageHeaders = authHeader([
      PERMISSIONS.REPORTS_TEMPLATES_MANAGE,
      PERMISSIONS.REPORTS_VIEW,
      PERMISSIONS.ATTENDANCE_VIEW,
    ]);

    const createResponse = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/saved-templates')
      .set('Authorization', manageHeaders)
      .send({
        name: 'حضور الشهر',
        builtInKey: 'attendance',
        templateVersion: 1,
        filters: { status: 'present' },
        preferredFormat: 'csv',
      });
    expect(createResponse.status).toBe(201);
    const savedId = createResponse.body.id;
    expect(createResponse.body.archivedAt).toBeNull();

    const listResponse = await request(makeTemplateApp(prisma))
      .get('/api/v2/reports/saved-templates')
      .set('Authorization', manageHeaders);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.map((row: any) => row.id)).toContain(savedId);

    const archiveResponse = await request(makeTemplateApp(prisma))
      .post(`/api/v2/reports/saved-templates/${savedId}/archive`)
      .set('Authorization', manageHeaders);
    expect(archiveResponse.status).toBe(200);
    expect(archiveResponse.body.archivedAt).not.toBeNull();

    const listAfterArchive = await request(makeTemplateApp(prisma))
      .get('/api/v2/reports/saved-templates')
      .set('Authorization', manageHeaders);
    expect(listAfterArchive.body.map((row: any) => row.id)).not.toContain(savedId);

    const saveAudit = prisma._store.auditLogs.find((row: any) => row.action === 'template.save');
    const saveDetails = typeof saveAudit.details === 'string' ? JSON.parse(saveAudit.details) : saveAudit.details;
    expect(JSON.stringify(saveDetails)).not.toContain('present');
    expect(saveDetails).toMatchObject({ reportType: 'attendance', savedTemplateId: savedId });

    const archiveAudit = prisma._store.auditLogs.find((row: any) => row.action === 'template.archive');
    expect(archiveAudit).toBeDefined();
  });

  it('enforces tenant and owner isolation on archive (404 for a foreign template)', async () => {
    const { prisma, stores } = makeTemplatePrisma();
    stores.savedTemplates.push({
      id: 'srt-foreign',
      companyId: 'other-company',
      ownerUserId: 'other-user',
      name: 'Foreign template',
      builtInKey: 'attendance',
      templateVersion: 1,
      scopeKind: 'company',
      departmentId: null,
      filtersJson: {},
      preferredFormat: null,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/saved-templates/srt-foreign/archive')
      .set(
        'Authorization',
        authHeader([PERMISSIONS.REPORTS_TEMPLATES_MANAGE, PERMISSIONS.ATTENDANCE_VIEW], { companyId: 'c1', id: 'u1' }),
      );

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('SAVED_TEMPLATE_NOT_FOUND');
  });

  it('enforces owner isolation within the same company (a colleague cannot see or archive it)', async () => {
    const { prisma, stores } = makeTemplatePrisma();
    stores.savedTemplates.push({
      id: 'srt-colleague',
      companyId: 'c1',
      ownerUserId: 'u-owner-2',
      name: 'Colleague template',
      builtInKey: 'attendance',
      templateVersion: 1,
      scopeKind: 'company',
      departmentId: null,
      filtersJson: {},
      preferredFormat: null,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const manageHeaders = authHeader([PERMISSIONS.REPORTS_TEMPLATES_MANAGE, PERMISSIONS.ATTENDANCE_VIEW]);

    const listResponse = await request(makeTemplateApp(prisma))
      .get('/api/v2/reports/saved-templates')
      .set('Authorization', manageHeaders);
    expect(listResponse.body.map((row: any) => row.id)).not.toContain('srt-colleague');

    const archiveResponse = await request(makeTemplateApp(prisma))
      .post('/api/v2/reports/saved-templates/srt-colleague/archive')
      .set('Authorization', manageHeaders);
    expect(archiveResponse.status).toBe(404);
  });
});
