import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { buildPurchasingReport, type PurchasingUser } from './purchasing';
import { PERMISSIONS } from './permissions';
import { neutralizeCsvCell } from './reports';

const MAX_EXPORT_ROWS = 5000;

const exportBodySchema = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf']),
  locale: z.enum(['ar', 'en']).optional().default('ar'),
});

type ExportFormat = z.infer<typeof exportBodySchema>['format'];
type ExportLocale = z.infer<typeof exportBodySchema>['locale'];

interface PurchasingExportRequest extends Request {
  user?: PurchasingUser;
}

interface PurchasingExportRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  exportLimiter?: RequestHandler;
}

class PurchasingExportError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
  }
}

type RequestRow = { requestNumber: string; title: string; requesterNameSnapshot: string; departmentNameSnapshot: string | null; status: string; totalEstimated: string; createdAt: string | null };
type OrderRow = { orderNumber: string; requestNumber: string; vendorNameSnapshot: string; status: string; totalAmount: string; createdAt: string | null };
type ReportSummary = {
  requestCount: number;
  orderCount: number;
  estimatedTotal: string;
  orderedTotal: string;
  receivedTotal: string;
  currency: string;
};

const hasPermission = (permissions: string[], permission: string): boolean =>
  permissions.includes(PERMISSIONS.ADMIN_FULL) || permissions.includes(permission);

const checkPurchasingExportPermissions = (
  req: PurchasingExportRequest,
  res: Response,
  next: NextFunction,
): Response | void => {
  const permissions = req.user?.permissions ?? [];
  if (
    hasPermission(permissions, PERMISSIONS.PURCHASING_REPORT) &&
    hasPermission(permissions, PERMISSIONS.REPORTS_EXPORT)
  ) {
    return next();
  }
  return res.status(403).json({
    error: 'Forbidden',
    message: 'لا تملك صلاحية تصدير تقرير المشتريات',
    code: 403,
  });
};

const todayLabel = (): string => new Date().toISOString().slice(0, 10);

const exportFilename = (format: ExportFormat): string =>
  `purchasing-${todayLabel()}.${format === 'xlsx' ? 'xlsx' : format}`;

const requestColumns = (locale: ExportLocale) =>
  locale === 'en'
    ? [
        { key: 'requestNumber', title: 'Request No.' },
        { key: 'title', title: 'Title' },
        { key: 'requesterNameSnapshot', title: 'Requester' },
        { key: 'departmentNameSnapshot', title: 'Department' },
        { key: 'status', title: 'Status' },
        { key: 'totalEstimated', title: 'Estimated Total' },
        { key: 'createdAt', title: 'Created At' },
      ]
    : [
        { key: 'requestNumber', title: 'رقم الطلب' },
        { key: 'title', title: 'العنوان' },
        { key: 'requesterNameSnapshot', title: 'مقدم الطلب' },
        { key: 'departmentNameSnapshot', title: 'القسم' },
        { key: 'status', title: 'الحالة' },
        { key: 'totalEstimated', title: 'الإجمالي التقديري' },
        { key: 'createdAt', title: 'تاريخ الإنشاء' },
      ];

const orderColumns = (locale: ExportLocale) =>
  locale === 'en'
    ? [
        { key: 'orderNumber', title: 'Order No.' },
        { key: 'requestNumber', title: 'Request No.' },
        { key: 'vendorNameSnapshot', title: 'Vendor' },
        { key: 'status', title: 'Status' },
        { key: 'totalAmount', title: 'Total Amount' },
        { key: 'createdAt', title: 'Created At' },
      ]
    : [
        { key: 'orderNumber', title: 'رقم الأمر' },
        { key: 'requestNumber', title: 'رقم الطلب' },
        { key: 'vendorNameSnapshot', title: 'المورد' },
        { key: 'status', title: 'الحالة' },
        { key: 'totalAmount', title: 'الإجمالي' },
        { key: 'createdAt', title: 'تاريخ الإنشاء' },
      ];

const sectionLabels = (locale: ExportLocale) =>
  locale === 'en'
    ? {
        title: 'Purchasing report',
        requests: 'Purchase Requests',
        orders: 'Purchase Orders',
        summary: 'Summary',
        requestCount: 'Request count',
        orderCount: 'Order count',
        estimatedTotal: 'Estimated total',
        orderedTotal: 'Ordered total',
        receivedTotal: 'Received total',
      }
    : {
        title: 'تقرير المشتريات',
        requests: 'طلبات الشراء',
        orders: 'أوامر الشراء',
        summary: 'الملخص',
        requestCount: 'عدد الطلبات',
        orderCount: 'عدد الأوامر',
        estimatedTotal: 'الإجمالي التقديري',
        orderedTotal: 'إجمالي أوامر الشراء',
        receivedTotal: 'إجمالي المستلم',
      };

const quoteCsv = (value: unknown): string =>
  `"${neutralizeCsvCell(value).replace(/"/g, '""')}"`;

const rowValue = (row: Record<string, unknown>, key: string): string =>
  row[key] == null || row[key] === '' ? '' : String(row[key]);

const buildExportPayload = async (
  prisma: PrismaClient,
  user: PurchasingUser,
  rawFilters: unknown,
) => {
  const report = await buildPurchasingReport(prisma, user, rawFilters, 5001);
  const requests = report.requests as RequestRow[];
  const orders = report.orders as OrderRow[];
  if (requests.length > MAX_EXPORT_ROWS || orders.length > MAX_EXPORT_ROWS) {
    throw new PurchasingExportError(
      413,
      'PURCHASING_EXPORT_ROW_LIMIT_EXCEEDED',
      'يتجاوز التصدير 5000 صف. يرجى تضييق النطاق.',
    );
  }
  return {
    requests,
    orders,
    summary: report.summary as ReportSummary,
  };
};

const createCsvExport = (
  locale: ExportLocale,
  requests: RequestRow[],
  orders: OrderRow[],
  summary: ReportSummary,
): string => {
  const labels = sectionLabels(locale);
  const requestCols = requestColumns(locale);
  const orderCols = orderColumns(locale);
  const lines = [
    quoteCsv(labels.title),
    '',
    quoteCsv(labels.requests),
    requestCols.map((column) => quoteCsv(column.title)).join(','),
    ...requests.map((row) =>
      requestCols.map((column) => quoteCsv(rowValue(row as unknown as Record<string, unknown>, column.key))).join(','),
    ),
    '',
    quoteCsv(labels.orders),
    orderCols.map((column) => quoteCsv(column.title)).join(','),
    ...orders.map((row) =>
      orderCols.map((column) => quoteCsv(rowValue(row as unknown as Record<string, unknown>, column.key))).join(','),
    ),
    '',
    quoteCsv(labels.summary),
    [
      quoteCsv(labels.requestCount),
      quoteCsv(summary.requestCount),
      quoteCsv(labels.orderCount),
      quoteCsv(summary.orderCount),
    ].join(','),
    [
      quoteCsv(labels.estimatedTotal),
      quoteCsv(summary.estimatedTotal),
      quoteCsv(labels.orderedTotal),
      quoteCsv(summary.orderedTotal),
      quoteCsv(labels.receivedTotal),
      quoteCsv(summary.receivedTotal),
    ].join(','),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
};

const createXlsxExport = async (
  locale: ExportLocale,
  requests: RequestRow[],
  orders: OrderRow[],
  summary: ReportSummary,
): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(locale === 'en' ? 'Purchasing' : 'المشتريات');
  const labels = sectionLabels(locale);
  const requestCols = requestColumns(locale);
  const orderCols = orderColumns(locale);

  sheet.addRow([labels.title]);
  sheet.addRow([]);
  sheet.addRow([labels.requests]);
  sheet.addRow(requestCols.map((column) => column.title));
  for (const row of requests) {
    sheet.addRow(requestCols.map((column) => rowValue(row as unknown as Record<string, unknown>, column.key)));
  }
  sheet.addRow([]);
  sheet.addRow([labels.orders]);
  sheet.addRow(orderCols.map((column) => column.title));
  for (const row of orders) {
    sheet.addRow(orderCols.map((column) => rowValue(row as unknown as Record<string, unknown>, column.key)));
  }
  sheet.addRow([]);
  sheet.addRow([labels.summary]);
  sheet.addRow([labels.requestCount, String(summary.requestCount), labels.orderCount, String(summary.orderCount)]);
  sheet.addRow([labels.estimatedTotal, summary.estimatedTotal, labels.orderedTotal, summary.orderedTotal, labels.receivedTotal, summary.receivedTotal]);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
};

const createPdfExport = (
  locale: ExportLocale,
  requests: RequestRow[],
  orders: OrderRow[],
  summary: ReportSummary,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const labels = sectionLabels(locale);
    const requestCols = requestColumns(locale);
    const orderCols = orderColumns(locale);
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ margin: 40, size: 'A4', compress: false });

    doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(14).text(labels.title);
    doc.moveDown();
    doc.fontSize(10).text(`${labels.requestCount}: ${summary.requestCount}`);
    doc.text(`${labels.orderCount}: ${summary.orderCount}`);
    doc.text(`${labels.estimatedTotal}: ${summary.estimatedTotal} ${summary.currency}`);
    doc.text(`${labels.orderedTotal}: ${summary.orderedTotal} ${summary.currency}`);
    doc.text(`${labels.receivedTotal}: ${summary.receivedTotal} ${summary.currency}`);
    doc.moveDown();

    doc.fontSize(11).text(labels.requests);
    doc.fontSize(9).text(requestCols.map((column) => column.title).join(' | '));
    doc.moveDown(0.5);
    for (const row of requests) {
      doc.text(requestCols.map((column) => rowValue(row as unknown as Record<string, unknown>, column.key)).join(' | '));
    }

    doc.moveDown();
    doc.fontSize(11).text(labels.orders);
    doc.fontSize(9).text(orderCols.map((column) => column.title).join(' | '));
    doc.moveDown(0.5);
    for (const row of orders) {
      doc.text(orderCols.map((column) => rowValue(row as unknown as Record<string, unknown>, column.key)).join(' | '));
    }

    doc.end();
  });

const moduleError = (error: unknown): PurchasingExportError | null => {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { status?: unknown; errorCode?: unknown; message?: unknown };
  if (typeof candidate.status !== 'number' || typeof candidate.errorCode !== 'string') return null;
  return new PurchasingExportError(
    candidate.status,
    candidate.errorCode,
    typeof candidate.message === 'string' ? candidate.message : 'تعذر تصدير تقرير المشتريات',
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
  const known = error instanceof PurchasingExportError ? error : moduleError(error);
  if (known) {
    return res.status(known.status).json({
      error: known.errorCode,
      message: known.message,
      code: known.status,
    });
  }
  return res.status(500).json({
    error: 'PURCHASING_EXPORT_FAILED',
    message: 'تعذر تصدير تقرير المشتريات حالياً',
    code: 500,
  });
};

export function registerPurchasingExportRoutes({
  app,
  prisma,
  requireAuth,
  exportLimiter = (_req, _res, next) => next(),
}: PurchasingExportRouteDeps): void {
  app.post(
    '/api/v2/purchasing/exports',
    exportLimiter,
    requireAuth,
    checkPurchasingExportPermissions,
    async (req: PurchasingExportRequest, res) => {
      try {
        const { format, locale, ...rawFilters } = (req.body ?? {}) as Record<string, unknown>;
        const body = exportBodySchema.parse({ format, locale });
        const payload = await buildExportPayload(prisma, req.user!, rawFilters);
        const filename = exportFilename(body.format);

        await writeAuditRequired(prisma, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'purchasing.export',
          details: {
            format: body.format,
            requestCount: payload.requests.length,
            orderCount: payload.orders.length,
          },
        });

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        if (body.format === 'csv') {
          const csv = createCsvExport(body.locale, payload.requests, payload.orders, payload.summary);
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Length', Buffer.byteLength(csv, 'utf8').toString());
          return res.status(200).send(csv);
        }

        if (body.format === 'xlsx') {
          const xlsx = await createXlsxExport(body.locale, payload.requests, payload.orders, payload.summary);
          res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          );
          res.setHeader('Content-Length', xlsx.length.toString());
          return res.status(200).send(xlsx);
        }

        const pdf = await createPdfExport(body.locale, payload.requests, payload.orders, payload.summary);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdf.length.toString());
        return res.status(200).send(pdf);
      } catch (error) {
        return sendError(res, error);
      }
    },
  );
}
