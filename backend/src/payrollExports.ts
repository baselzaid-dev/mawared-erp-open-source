import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { buildPayrollReport, type PayrollUser } from './payroll';
import { PERMISSIONS } from './permissions';
import { neutralizeCsvCell } from './reports';

const MAX_EXPORT_ROWS = 5000;

const exportBodySchema = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf']),
  locale: z.enum(['ar', 'en']).optional().default('ar'),
});

type ExportFormat = z.infer<typeof exportBodySchema>['format'];
type ExportLocale = z.infer<typeof exportBodySchema>['locale'];

interface PayrollExportRequest extends Request {
  user?: PayrollUser;
}

interface PayrollExportRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  exportLimiter?: RequestHandler;
}

class PayrollExportError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
  }
}

type ExportRow = Record<string, string | null>;
type ExportSummary = {
  visibleEmployeeCount: number;
  visibleGross: string;
  visibleDeductions: string;
  visibleNet: string;
  currency: string;
};

const hasPermission = (permissions: string[], permission: string): boolean =>
  permissions.includes(PERMISSIONS.ADMIN_FULL) || permissions.includes(permission);

const checkPayrollExportPermissions = (
  req: PayrollExportRequest,
  res: Response,
  next: NextFunction,
): Response | void => {
  const permissions = req.user?.permissions ?? [];
  if (
    hasPermission(permissions, PERMISSIONS.PAYROLL_REPORT) &&
    hasPermission(permissions, PERMISSIONS.REPORTS_EXPORT)
  ) {
    return next();
  }
  return res.status(403).json({
    error: 'Forbidden',
    message: 'لا تملك صلاحية تصدير تقرير الرواتب',
    code: 403,
  });
};

const periodLabel = (year: number, month: number): string =>
  `${year}-${String(month).padStart(2, '0')}`;

const exportFilename = (year: number, month: number, format: ExportFormat): string =>
  `payroll-${year}-${String(month).padStart(2, '0')}.${format === 'xlsx' ? 'xlsx' : format}`;

const columnDefinitions = (locale: ExportLocale) =>
  locale === 'en'
    ? [
        { key: 'employeeNum', title: 'Employee No.' },
        { key: 'employeeName', title: 'Employee Name' },
        { key: 'departmentName', title: 'Department' },
        { key: 'grossPay', title: 'Gross' },
        { key: 'totalDeductions', title: 'Deductions' },
        { key: 'netPay', title: 'Net' },
        { key: 'currency', title: 'Currency' },
        { key: 'status', title: 'Status' },
      ]
    : [
        { key: 'employeeNum', title: 'الرقم الوظيفي' },
        { key: 'employeeName', title: 'اسم الموظف' },
        { key: 'departmentName', title: 'القسم' },
        { key: 'grossPay', title: 'الإجمالي' },
        { key: 'totalDeductions', title: 'الخصومات' },
        { key: 'netPay', title: 'الصافي' },
        { key: 'currency', title: 'العملة' },
        { key: 'status', title: 'الحالة' },
      ];

const summaryLabels = (locale: ExportLocale) =>
  locale === 'en'
    ? {
        period: 'Payroll period',
        employees: 'Employees',
        gross: 'Gross total',
        deductions: 'Deductions total',
        net: 'Net total',
      }
    : {
        period: 'فترة الرواتب',
        employees: 'عدد الموظفين',
        gross: 'إجمالي الرواتب',
        deductions: 'إجمالي الخصومات',
        net: 'صافي الرواتب',
      };

const emptySummary = (): ExportSummary => ({
  visibleEmployeeCount: 0,
  visibleGross: '0.00',
  visibleDeductions: '0.00',
  visibleNet: '0.00',
  currency: 'SAR',
});

const normalizeSummary = (summary: ExportSummary | null | undefined): ExportSummary =>
  summary ?? emptySummary();

const quoteCsv = (value: unknown): string =>
  `"${neutralizeCsvCell(value).replace(/"/g, '""')}"`;

const rowValue = (row: ExportRow, key: string): string =>
  row[key] == null || row[key] === '' ? '' : String(row[key]);

const buildExportPayload = async (
  prisma: PrismaClient,
  user: PayrollUser,
  periodId: string,
) => {
  const source = await buildPayrollReport(prisma, user, periodId);
  const rows = source.rows as ExportRow[];
  if (rows.length > MAX_EXPORT_ROWS) {
    throw new PayrollExportError(
      413,
      'PAYROLL_EXPORT_ROW_LIMIT_EXCEEDED',
      'يتجاوز التصدير 5000 صف. يرجى تضييق النطاق.',
    );
  }
  return {
    periodLabel: periodLabel(source.period.year, source.period.month),
    year: source.period.year as number,
    month: source.period.month as number,
    rows,
    summary: normalizeSummary(source.visibleSummary as ExportSummary | null | undefined),
    periodId: source.period.id as string,
  };
};

const createCsvExport = (
  locale: ExportLocale,
  period: string,
  rows: ExportRow[],
  summary: ExportSummary,
): string => {
  const columns = columnDefinitions(locale);
  const labels = summaryLabels(locale);
  const lines = [
    quoteCsv(`${labels.period}: ${period}`),
    '',
    columns.map((column) => quoteCsv(column.title)).join(','),
    ...rows.map((row) =>
      columns.map((column) => quoteCsv(rowValue(row, column.key))).join(','),
    ),
    '',
    [
      quoteCsv(labels.employees),
      quoteCsv(summary.visibleEmployeeCount),
      quoteCsv(labels.gross),
      quoteCsv(summary.visibleGross),
      quoteCsv(labels.deductions),
      quoteCsv(summary.visibleDeductions),
      quoteCsv(labels.net),
      quoteCsv(summary.visibleNet),
    ].join(','),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
};

const createXlsxExport = async (
  locale: ExportLocale,
  period: string,
  rows: ExportRow[],
  summary: ExportSummary,
): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(locale === 'en' ? 'Payroll' : 'الرواتب');
  const columns = columnDefinitions(locale);
  const labels = summaryLabels(locale);

  sheet.addRow([`${labels.period}: ${period}`]);
  sheet.addRow([]);
  sheet.addRow(columns.map((column) => column.title));
  for (const row of rows) {
    sheet.addRow(columns.map((column) => rowValue(row, column.key)));
  }
  sheet.addRow([]);
  sheet.addRow([
    labels.employees,
    String(summary.visibleEmployeeCount),
    labels.gross,
    summary.visibleGross,
    labels.deductions,
    summary.visibleDeductions,
    labels.net,
    summary.visibleNet,
  ]);

  for (const moneyColumn of ['grossPay', 'totalDeductions', 'netPay']) {
    const index = columns.findIndex((column) => column.key === moneyColumn) + 1;
    if (index <= 0) continue;
    sheet.getColumn(index).eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      if (rowNumber <= 3) return;
      cell.numFmt = '@';
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
};

const createPdfExport = (
  locale: ExportLocale,
  period: string,
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

    doc.fontSize(14).text(`${labels.period}: ${period}`);
    doc.moveDown();
    doc.fontSize(10).text(`${labels.employees}: ${summary.visibleEmployeeCount}`);
    doc.text(`${labels.gross}: ${summary.visibleGross} ${summary.currency}`);
    doc.text(`${labels.deductions}: ${summary.visibleDeductions} ${summary.currency}`);
    doc.text(`${labels.net}: ${summary.visibleNet} ${summary.currency}`);
    doc.moveDown();

    const header = columns.map((column) => column.title).join(' | ');
    doc.fontSize(9).text(header);
    doc.moveDown(0.5);

    for (const row of rows) {
      doc.text(columns.map((column) => rowValue(row, column.key)).join(' | '));
    }

    doc.end();
  });

const moduleError = (error: unknown): PayrollExportError | null => {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { status?: unknown; errorCode?: unknown; message?: unknown };
  if (typeof candidate.status !== 'number' || typeof candidate.errorCode !== 'string') return null;
  return new PayrollExportError(
    candidate.status,
    candidate.errorCode,
    typeof candidate.message === 'string' ? candidate.message : 'تعذر تصدير تقرير الرواتب',
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
  const known = error instanceof PayrollExportError ? error : moduleError(error);
  if (known) {
    return res.status(known.status).json({
      error: known.errorCode,
      message: known.message,
      code: known.status,
    });
  }
  return res.status(500).json({
    error: 'PAYROLL_EXPORT_FAILED',
    message: 'تعذر تصدير تقرير الرواتب حالياً',
    code: 500,
  });
};

export function registerPayrollExportRoutes({
  app,
  prisma,
  requireAuth,
  exportLimiter = (_req, _res, next) => next(),
}: PayrollExportRouteDeps): void {
  app.post(
    '/api/v2/payroll/periods/:id/exports',
    exportLimiter,
    requireAuth,
    checkPayrollExportPermissions,
    async (req: PayrollExportRequest, res) => {
      try {
        const body = exportBodySchema.parse(req.body ?? {});
        const payload = await buildExportPayload(prisma, req.user!, req.params.id);
        const filename = exportFilename(payload.year, payload.month, body.format);

        await writeAuditRequired(prisma, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'payroll.export',
          details: {
            periodId: payload.periodId,
            format: body.format,
            rowCount: payload.rows.length,
          },
        });

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        if (body.format === 'csv') {
          const csv = createCsvExport(body.locale, payload.periodLabel, payload.rows, payload.summary);
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Length', Buffer.byteLength(csv, 'utf8').toString());
          return res.status(200).send(csv);
        }

        if (body.format === 'xlsx') {
          const xlsx = await createXlsxExport(
            body.locale,
            payload.periodLabel,
            payload.rows,
            payload.summary,
          );
          res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          );
          res.setHeader('Content-Length', xlsx.length.toString());
          return res.status(200).send(xlsx);
        }

        const pdf = await createPdfExport(
          body.locale,
          payload.periodLabel,
          payload.rows,
          payload.summary,
        );
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdf.length.toString());
        return res.status(200).send(pdf);
      } catch (error) {
        return sendError(res, error);
      }
    },
  );
}
