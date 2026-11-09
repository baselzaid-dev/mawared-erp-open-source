import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { PERMISSIONS } from './permissions';
import { neutralizeCsvCell } from './reports';
import { buildTrainingReport, type TrainingUser } from './training';

const MAX_EXPORT_ROWS = 5000;

const exportBodySchema = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf']),
  locale: z.enum(['ar', 'en']).optional().default('ar'),
});

type ExportFormat = z.infer<typeof exportBodySchema>['format'];
type ExportLocale = z.infer<typeof exportBodySchema>['locale'];

interface TrainingExportRequest extends Request {
  user?: TrainingUser;
}

interface TrainingExportRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  exportLimiter?: RequestHandler;
}

class TrainingExportError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
  }
}

type ExportRow = Record<string, string | number | null>;
type ExportSummary = Record<string, string | number | null>;

const hasPermission = (permissions: string[], permission: string): boolean =>
  permissions.includes(PERMISSIONS.ADMIN_FULL) || permissions.includes(permission);

const checkTrainingExportPermissions = (
  req: TrainingExportRequest,
  res: Response,
  next: NextFunction,
): Response | void => {
  const permissions = req.user?.permissions ?? [];
  if (hasPermission(permissions, PERMISSIONS.TRAINING_REPORT)) {
    return next();
  }
  return res.status(403).json({
    error: 'Forbidden',
    message: 'لا تملك صلاحية تصدير تقرير التدريب',
    code: 403,
  });
};

const todayLabel = (): string => new Date().toISOString().slice(0, 10);

const exportFilename = (format: ExportFormat): string =>
  `training-${todayLabel()}.${format === 'xlsx' ? 'xlsx' : format}`;

const columnDefinitions = (locale: ExportLocale) =>
  locale === 'en'
    ? [
        { key: 'courseCode', title: 'Course Code' },
        { key: 'title', title: 'Course' },
        { key: 'category', title: 'Category' },
        { key: 'deliveryMode', title: 'Delivery Mode' },
        { key: 'startDate', title: 'Start Date' },
        { key: 'endDate', title: 'End Date' },
        { key: 'status', title: 'Status' },
        { key: 'assignmentCount', title: 'Assignments' },
        { key: 'completedCount', title: 'Completed' },
      ]
    : [
        { key: 'courseCode', title: 'رمز الدورة' },
        { key: 'title', title: 'الدورة' },
        { key: 'category', title: 'التصنيف' },
        { key: 'deliveryMode', title: 'أسلوب التقديم' },
        { key: 'startDate', title: 'تاريخ البداية' },
        { key: 'endDate', title: 'تاريخ النهاية' },
        { key: 'status', title: 'الحالة' },
        { key: 'assignmentCount', title: 'عدد التكليفات' },
        { key: 'completedCount', title: 'المكتملة' },
      ];

const summaryLabels = (locale: ExportLocale) =>
  locale === 'en'
    ? {
        title: 'Training report',
        summary: 'Summary',
        courseCount: 'Course count',
        assignmentCount: 'Assignment count',
        completionRate: 'Completion rate %',
        averageProgress: 'Average progress %',
      }
    : {
        title: 'تقرير التدريب',
        summary: 'الملخص',
        courseCount: 'عدد الدورات',
        assignmentCount: 'عدد التكليفات',
        completionRate: 'نسبة الإكمال %',
        averageProgress: 'متوسط التقدم %',
      };

const quoteCsv = (value: unknown): string =>
  `"${neutralizeCsvCell(value).replace(/"/g, '""')}"`;

const rowValue = (row: ExportRow, key: string): string =>
  neutralizeCsvCell(row[key] == null || row[key] === '' ? '' : String(row[key]));

const flattenCourseRows = (courses: any[]): ExportRow[] =>
  courses.map((course) => ({
    courseCode: course.courseCode ?? '',
    title: course.title ?? '',
    category: course.category ?? '',
    deliveryMode: course.deliveryMode ?? '',
    startDate: course.startDate ?? '',
    endDate: course.endDate ?? '',
    status: course.status ?? '',
    assignmentCount: course.assignmentSummary?.total ?? 0,
    assignedCount: course.assignmentSummary?.assigned ?? 0,
    inProgressCount: course.assignmentSummary?.in_progress ?? 0,
    submittedCount: course.assignmentSummary?.submitted ?? 0,
    completedCount: course.assignmentSummary?.completed ?? 0,
    returnedCount: course.assignmentSummary?.returned ?? 0,
    cancelledCount: course.assignmentSummary?.cancelled ?? 0,
  }));

const buildExportPayload = async (
  prisma: PrismaClient,
  user: TrainingUser,
  rawFilters: unknown,
) => {
  const result = await buildTrainingReport(prisma, user, rawFilters, 5001);
  const rows = flattenCourseRows(result.report.courses);
  if (rows.length > MAX_EXPORT_ROWS) {
    throw new TrainingExportError(
      413,
      'TRAINING_EXPORT_ROW_LIMIT_EXCEEDED',
      'يتجاوز التصدير 5000 صف. يرجى تضييق النطاق.',
    );
  }
  return {
    rows,
    summary: result.report.summary as ExportSummary,
  };
};

const createCsvExport = (
  locale: ExportLocale,
  rows: ExportRow[],
  summary: ExportSummary,
): string => {
  const columns = columnDefinitions(locale);
  const labels = summaryLabels(locale);
  const lines = [
    quoteCsv(labels.title),
    '',
    columns.map((column) => quoteCsv(column.title)).join(','),
    ...rows.map((row) =>
      columns.map((column) => quoteCsv(rowValue(row, column.key))).join(','),
    ),
    '',
    quoteCsv(labels.summary),
    [
      quoteCsv(labels.courseCount),
      quoteCsv(summary.courseCount ?? 0),
      quoteCsv(labels.assignmentCount),
      quoteCsv(summary.assignmentCount ?? 0),
    ].join(','),
    [
      quoteCsv(labels.completionRate),
      quoteCsv(summary.completionRatePercent ?? 0),
      quoteCsv(labels.averageProgress),
      quoteCsv(summary.averageProgressPercent ?? 0),
    ].join(','),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
};

const createXlsxExport = async (
  locale: ExportLocale,
  rows: ExportRow[],
  summary: ExportSummary,
): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(locale === 'en' ? 'Training' : 'التدريب');
  const columns = columnDefinitions(locale);
  const labels = summaryLabels(locale);

  sheet.addRow([labels.title]);
  sheet.addRow([]);
  sheet.addRow(columns.map((column) => column.title));
  for (const row of rows) {
    sheet.addRow(columns.map((column) => rowValue(row, column.key)));
  }
  sheet.addRow([]);
  sheet.addRow([
    labels.courseCount,
    String(summary.courseCount ?? 0),
    labels.assignmentCount,
    String(summary.assignmentCount ?? 0),
  ]);
  sheet.addRow([
    labels.completionRate,
    String(summary.completionRatePercent ?? 0),
    labels.averageProgress,
    String(summary.averageProgressPercent ?? 0),
  ]);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
};

const createPdfExport = (
  locale: ExportLocale,
  rows: ExportRow[],
  summary: ExportSummary,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const columns = columnDefinitions(locale);
    const labels = summaryLabels(locale);
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ margin: 40, size: 'A4', compress: false });

    doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(14).text(labels.title);
    doc.moveDown();
    doc.fontSize(10).text(`${labels.courseCount}: ${summary.courseCount ?? 0}`);
    doc.text(`${labels.assignmentCount}: ${summary.assignmentCount ?? 0}`);
    doc.text(`${labels.completionRate}: ${summary.completionRatePercent ?? 0}`);
    doc.text(`${labels.averageProgress}: ${summary.averageProgressPercent ?? 0}`);
    doc.moveDown();

    doc.fontSize(9).text(columns.map((column) => column.title).join(' | '));
    doc.moveDown(0.5);
    for (const row of rows) {
      doc.text(columns.map((column) => rowValue(row, column.key)).join(' | '));
    }

    doc.end();
  });

const moduleError = (error: unknown): TrainingExportError | null => {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { status?: unknown; errorCode?: unknown; message?: unknown };
  if (typeof candidate.status !== 'number' || typeof candidate.errorCode !== 'string') return null;
  return new TrainingExportError(
    candidate.status,
    candidate.errorCode,
    typeof candidate.message === 'string' ? candidate.message : 'تعذر تصدير تقرير التدريب',
  );
};

const sendError = (res: Response, error: unknown): Response => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'بيانات التصدير غير صالحة',
      code: 400,
      details: error.issues,
    });
  }
  const known = error instanceof TrainingExportError ? error : moduleError(error);
  if (known) {
    return res.status(known.status).json({
      error: known.errorCode,
      message: known.message,
      code: known.status,
    });
  }
  return res.status(500).json({
    error: 'TRAINING_EXPORT_FAILED',
    message: 'تعذر تصدير تقرير التدريب حالياً',
    code: 500,
  });
};

export function registerTrainingExportRoutes({
  app,
  prisma,
  requireAuth,
  exportLimiter = (_req, _res, next) => next(),
}: TrainingExportRouteDeps): void {
  app.post(
    '/api/training/exports',
    exportLimiter,
    requireAuth,
    checkTrainingExportPermissions,
    async (req: TrainingExportRequest, res) => {
      try {
        const { format, locale, ...rawFilters } = (req.body ?? {}) as Record<string, unknown>;
        const body = exportBodySchema.parse({ format, locale });
        const payload = await buildExportPayload(prisma, req.user!, rawFilters);
        const filename = exportFilename(body.format);

        await writeAuditRequired(prisma, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'training.export',
          details: {
            format: body.format,
            rowCount: payload.rows.length,
          },
        });

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        if (body.format === 'csv') {
          const csv = createCsvExport(body.locale, payload.rows, payload.summary);
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Length', Buffer.byteLength(csv, 'utf8').toString());
          return res.status(200).send(csv);
        }

        if (body.format === 'xlsx') {
          const xlsx = await createXlsxExport(body.locale, payload.rows, payload.summary);
          res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          );
          res.setHeader('Content-Length', xlsx.length.toString());
          return res.status(200).send(xlsx);
        }

        const pdf = await createPdfExport(body.locale, payload.rows, payload.summary);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdf.length.toString());
        return res.status(200).send(pdf);
      } catch (error) {
        return sendError(res, error);
      }
    },
  );
}
