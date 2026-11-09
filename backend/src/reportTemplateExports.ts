import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { neutralizeCsvCell, type ReportUser } from './reports';
import {
  EXPORT_ROW_CAP_TOTAL,
  ReportTemplateError,
  compileBuiltInTemplate,
  mayExportReportTemplates,
  resolveAuthorizedTemplate,
  type CompiledTemplateDocument,
  type TemplateFormat,
  type TemplateModuleKey,
  type TemplateSection,
} from './reportTemplates';

/**
 * Sprint 12J Slice 2 — synchronous XLSX/PDF/CSV export for the report
 * template registry. Reuses compileBuiltInTemplate (which itself reuses
 * buildPayrollReport/buildPurchasingReport/buildTrainingReport) so export
 * data always matches preview data. No renderer accepts client SQL/fields.
 */

interface TemplateExportRequest extends Request {
  user?: ReportUser;
}

interface ReportTemplateExportRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  exportLimiter?: RequestHandler;
}

const filterValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

const exportBodySchema = z.strictObject({
  builtInKey: z.string().trim().min(1).max(60),
  templateVersion: z.coerce.number().int().min(1),
  scope: z.strictObject({
    departmentId: z.string().uuid('معرّف القسم غير صالح').optional(),
  }).optional(),
  filters: z.record(z.string().max(80), filterValue).optional().default({}),
  format: z.enum(['csv', 'xlsx', 'pdf']),
  locale: z.enum(['ar', 'en']).optional().default('ar'),
});

type ColumnDefinition = { key: string; title: string };

const MODULE_COLUMNS: Record<TemplateModuleKey, ColumnDefinition[]> = {
  attendance: [
    { key: 'employeeNum', title: 'الرقم الوظيفي' },
    { key: 'employeeName', title: 'اسم الموظف' },
    { key: 'departmentName', title: 'القسم' },
    { key: 'date', title: 'التاريخ' },
    { key: 'status', title: 'الحالة' },
    { key: 'clockIn', title: 'وقت الحضور' },
    { key: 'clockOut', title: 'وقت الانصراف' },
  ],
  leaves: [
    { key: 'employeeNum', title: 'الرقم الوظيفي' },
    { key: 'employeeName', title: 'اسم الموظف' },
    { key: 'departmentName', title: 'القسم' },
    { key: 'leaveType', title: 'نوع الإجازة' },
    { key: 'startDate', title: 'تاريخ البداية' },
    { key: 'endDate', title: 'تاريخ النهاية' },
    { key: 'totalDays', title: 'عدد الأيام' },
    { key: 'status', title: 'الحالة' },
  ],
  payroll: [
    { key: 'employeeNum', title: 'الرقم الوظيفي' },
    { key: 'employeeName', title: 'اسم الموظف' },
    { key: 'departmentName', title: 'القسم' },
    { key: 'grossPay', title: 'الإجمالي' },
    { key: 'totalDeductions', title: 'الخصومات' },
    { key: 'netPay', title: 'الصافي' },
    { key: 'currency', title: 'العملة' },
    { key: 'status', title: 'الحالة' },
  ],
  purchasing: [
    { key: 'recordType', title: 'نوع السجل' },
    { key: 'referenceNumber', title: 'الرقم المرجعي' },
    { key: 'titleOrVendor', title: 'العنوان أو المورد' },
    { key: 'departmentName', title: 'القسم' },
    { key: 'status', title: 'الحالة' },
    { key: 'amount', title: 'المبلغ' },
    { key: 'currency', title: 'العملة' },
    { key: 'createdAt', title: 'تاريخ الإنشاء' },
  ],
  training: [
    { key: 'courseCode', title: 'رمز الدورة' },
    { key: 'title', title: 'الدورة' },
    { key: 'category', title: 'التصنيف' },
    { key: 'startDate', title: 'تاريخ البداية' },
    { key: 'endDate', title: 'تاريخ النهاية' },
    { key: 'status', title: 'الحالة' },
    { key: 'assignmentCount', title: 'عدد التكليفات' },
    { key: 'completedCount', title: 'المكتملة' },
  ],
  employees: [
    { key: 'employeeNum', title: 'الرقم الوظيفي' },
    { key: 'employeeName', title: 'اسم الموظف' },
    { key: 'jobTitle', title: 'المسمى الوظيفي' },
    { key: 'departmentName', title: 'القسم' },
    { key: 'status', title: 'الحالة' },
    { key: 'joiningDate', title: 'تاريخ الالتحاق' },
    { key: 'isArchived', title: 'مؤرشف' },
    { key: 'archivedAt', title: 'تاريخ الأرشفة' },
  ],
  payments: [
    { key: 'payrollPeriodId', title: 'فترة الرواتب' },
    { key: 'amount', title: 'المبلغ' },
    { key: 'currency', title: 'العملة' },
    { key: 'paymentDate', title: 'تاريخ الدفع' },
    { key: 'reference', title: 'المرجع' },
    { key: 'status', title: 'الحالة' },
    { key: 'createdAt', title: 'تاريخ الإنشاء' },
    { key: 'voidedAt', title: 'تاريخ الإلغاء' },
  ],
};

const rowValue = (row: Record<string, unknown>, key: string): string =>
  neutralizeCsvCell(row[key] == null || row[key] === '' ? '' : String(row[key]));

const quoteCsv = (value: unknown): string => `"${neutralizeCsvCell(value).replace(/"/g, '""')}"`;

const todayLabel = (): string => new Date().toISOString().slice(0, 10);

const exportFilename = (builtInKey: string, format: TemplateFormat): string =>
  `report-template-${builtInKey}-${todayLabel()}.${format === 'xlsx' ? 'xlsx' : format}`;

const createCsvExport = (document: CompiledTemplateDocument): string => {
  const lines: string[] = [
    quoteCsv(`${document.builtInKey} v${document.templateVersion}`),
  ];
  for (const section of document.sections) {
    const columns = MODULE_COLUMNS[section.module];
    lines.push('');
    lines.push(quoteCsv(section.title));
    lines.push(columns.map((column) => quoteCsv(column.title)).join(','));
    for (const row of section.rows) {
      lines.push(columns.map((column) => quoteCsv(rowValue(row, column.key))).join(','));
    }
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
};

const createXlsxExport = async (document: CompiledTemplateDocument): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  for (const section of document.sections) {
    const columns = MODULE_COLUMNS[section.module];
    const sheet = workbook.addWorksheet(section.title.slice(0, 31));
    sheet.addRow([section.title]);
    sheet.addRow([]);
    sheet.addRow(columns.map((column) => column.title));
    for (const row of section.rows) {
      sheet.addRow(columns.map((column) => rowValue(row, column.key)));
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
};

const createPdfExport = (document: CompiledTemplateDocument): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ margin: 40, size: 'A4', compress: false });
    doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(14).text(`${document.builtInKey} v${document.templateVersion}`);
    doc.moveDown();

    for (const section of document.sections) {
      const columns = MODULE_COLUMNS[section.module];
      doc.fontSize(11).text(section.title);
      doc.fontSize(9).text(columns.map((column) => column.title).join(' | '));
      doc.moveDown(0.5);
      for (const row of section.rows) {
        doc.text(columns.map((column) => rowValue(row, column.key)).join(' | '));
      }
      doc.moveDown();
    }

    doc.end();
  });

const totalRowCount = (sections: TemplateSection[]): number =>
  sections.reduce((sum, section) => sum + section.rowCount, 0);

const moduleError = (error: unknown): ReportTemplateError | null => {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { status?: unknown; errorCode?: unknown; message?: unknown; details?: unknown };
  if (typeof candidate.status !== 'number' || typeof candidate.errorCode !== 'string') return null;
  return new ReportTemplateError(
    candidate.status,
    candidate.errorCode,
    typeof candidate.message === 'string' ? candidate.message : 'تعذر تصدير القالب',
    candidate.details,
  );
};

const sendError = (res: Response, error: unknown): Response => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      error: 'TEMPLATE_VALIDATION_ERROR',
      message: 'بيانات التصدير غير صالحة',
      code: 400,
      details: error.issues,
    });
  }
  const known = error instanceof ReportTemplateError ? error : moduleError(error);
  if (known) {
    return res.status(known.status).json({
      error: known.errorCode,
      message: known.message,
      code: known.status,
      ...(known.details ? { details: known.details } : {}),
    });
  }
  return res.status(500).json({
    error: 'TEMPLATE_EXPORT_FAILED',
    message: 'تعذر تصدير القالب حالياً',
    code: 500,
  });
};

export function registerReportTemplateExportRoutes({
  app,
  prisma,
  requireAuth,
  exportLimiter = (_req, _res, next) => next(),
}: ReportTemplateExportRouteDeps): void {
  app.post(
    '/api/v2/reports/templates/exports',
    exportLimiter,
    requireAuth,
    async (req: TemplateExportRequest, res) => {
      try {
        const user = req.user!;
        const body = exportBodySchema.parse(req.body ?? {});
        const def = resolveAuthorizedTemplate(user, body.builtInKey, body.templateVersion);
        if (!mayExportReportTemplates(user)) {
          throw new ReportTemplateError(403, 'TEMPLATE_EXPORT_FORBIDDEN', 'لا تملك صلاحية تصدير التقارير');
        }
        if (!def.formats.includes(body.format)) {
          throw new ReportTemplateError(400, 'TEMPLATE_FORMAT_UNSUPPORTED', 'صيغة التصدير غير مدعومة لهذا القالب');
        }
        const document = await compileBuiltInTemplate(prisma, user, def, {
          filters: body.filters,
          departmentId: body.scope?.departmentId,
          rowCapPerSection: EXPORT_ROW_CAP_TOTAL,
        });
        if (totalRowCount(document.sections) > EXPORT_ROW_CAP_TOTAL) {
          throw new ReportTemplateError(
            413,
            'TEMPLATE_EXPORT_ROW_LIMIT_EXCEEDED',
            `يتجاوز التصدير ${EXPORT_ROW_CAP_TOTAL} صف. يرجى تضييق النطاق.`,
          );
        }

        const filename = exportFilename(def.builtInKey, body.format);

        await writeAuditRequired(prisma, {
          companyId: user.companyId,
          userId: user.id,
          action: 'template.export',
          details: {
            reportType: def.builtInKey,
            templateVersion: def.version,
            format: body.format,
            rowCount: totalRowCount(document.sections),
            sectionCount: document.sections.length,
          },
        });

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        if (body.format === 'csv') {
          const csv = createCsvExport(document);
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Length', Buffer.byteLength(csv, 'utf8').toString());
          return res.status(200).send(csv);
        }

        if (body.format === 'xlsx') {
          const xlsx = await createXlsxExport(document);
          res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          );
          res.setHeader('Content-Length', xlsx.length.toString());
          return res.status(200).send(xlsx);
        }

        const pdf = await createPdfExport(document);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdf.length.toString());
        return res.status(200).send(pdf);
      } catch (error) {
        return sendError(res, error);
      }
    },
  );
}
