import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { tokenFor } from './helpers';
import { buildReportCatalog, neutralizeCsvCell } from '../src/reports';
import {
  REPORT_REGISTRY_CONTRACT_VERSION,
  getRegisteredReport,
  listRegisteredReports,
  registerReport,
  __unregisterForTests,
} from '../src/reportRegistry';
import '../src/purchasingReports';
import {
  APPROVER_PERMISSIONS,
  BUYER_PERMISSIONS,
  REQUEST_ID,
  VENDOR_ID,
  buyerToken,
  createIssuedOrder,
  foreignToken,
  makeW2Prisma,
  quotationBody,
  w2App,
} from './purchasing_w2_fixture';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const reportUser = (permissions: string[]) => ({
  id: 'u1',
  companyId: 'c1',
  employeeId: 'e1',
  permissions,
});

describe('W2 report registration contract', () => {
  it('publishes the three Wave 2 purchasing reports at contract version 1', () => {
    expect(REPORT_REGISTRY_CONTRACT_VERSION).toBe(1);
    const keys = listRegisteredReports().map((definition) => definition.key);
    expect(keys).toEqual(
      expect.arrayContaining(['purchasing_quotations', 'purchasing_receipts', 'purchasing_returns']),
    );
    for (const key of keys) {
      const definition = getRegisteredReport(key)!;
      expect(definition.contractVersion).toBe(REPORT_REGISTRY_CONTRACT_VERSION);
      expect(definition.columns.length).toBeGreaterThan(0);
      expect(typeof definition.canAccess).toBe('function');
    }
  });

  it('refuses reserved keys, duplicates, wrong versions and empty columns', () => {
    const base = {
      contractVersion: REPORT_REGISTRY_CONTRACT_VERSION,
      title: 't',
      description: 'd',
      module: 'test',
      supportedFilters: [] as string[],
      containsFinancialData: false,
      maximumRangeDays: 30,
      availableScopes: ['company'] as const,
      exportable: true,
      canAccess: () => true,
      columns: [{ key: 'a', title: 'A' }],
      load: async () => {
        throw new Error('unused');
      },
    };
    expect(() => registerReport({ ...base, key: 'payroll' } as any)).toThrow(/reserved/);
    expect(() => registerReport({ ...base, key: 'purchasing_returns' } as any)).toThrow(/already registered/);
    expect(() => registerReport({ ...base, key: 'Bad-Key' } as any)).toThrow(/invalid report key/);
    expect(() => registerReport({ ...base, key: 'w2_probe', contractVersion: 2 } as any)).toThrow(
      /contract version/,
    );
    expect(() => registerReport({ ...base, key: 'w2_probe', columns: [] } as any)).toThrow(
      /export column/,
    );

    // A valid registration works and can be removed again without leaking state.
    const created = registerReport({ ...base, key: 'w2_probe' } as any);
    expect(getRegisteredReport('w2_probe')).toBeTruthy();
    expect(created.key).toBe('w2_probe');
    expect(__unregisterForTests('w2_probe')).toBe(true);
    expect(getRegisteredReport('w2_probe')).toBeUndefined();
  });

  it('gates each registered report behind its own permission predicate', () => {
    const reportOnly = buildReportCatalog(reportUser(['purchasing.report'])).map((item) => item.type);
    expect(reportOnly).toContain('purchasing_receipts');
    expect(reportOnly).toContain('purchasing_returns');
    // Quotation pricing needs an explicit quotation permission.
    expect(reportOnly).not.toContain('purchasing_quotations');

    const withQuotations = buildReportCatalog(
      reportUser(['purchasing.report', 'purchasing.quotation.compare']),
    ).map((item) => item.type);
    expect(withQuotations).toContain('purchasing_quotations');

    const none = buildReportCatalog(reportUser(['leaves.view'])).map((item) => item.type);
    expect(none).not.toContain('purchasing_receipts');
  });
});

describe('W2 purchasing reports', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-15T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());
  const setup = async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const quotation = await request(app)
      .post(`/api/v2/purchasing/requests/${REQUEST_ID}/quotations`)
      .set(auth(buyerToken()))
      .set('Idempotency-Key', 'report-quote-001')
      .send(quotationBody(VENDOR_ID, '20.00', '20.00'));
    expect(quotation.status).toBe(201);

    const order = await createIssuedOrder(app, buyerToken());
    await request(app)
      .post(`/api/v2/purchasing/orders/${order.id}/receipts`)
      .set(auth(buyerToken()))
      .set('Idempotency-Key', 'report-receipt-001')
      .send({ lines: [{ purchaseOrderLineId: order.lines[0].id, quantity: '4.000' }] });
    const created = await request(app)
      .post(`/api/v2/purchasing/orders/${order.id}/returns`)
      .set(auth(buyerToken()))
      .set('Idempotency-Key', 'report-return-001')
      .send({
        reasonCode: 'damaged',
        lines: [{ purchaseOrderLineId: order.lines[0].id, quantity: '1.000' }],
      });
    expect(created.status).toBe(201);
    return { prisma, app, order, quotationId: quotation.body.id };
  };

  it('serves the quotation report from real captured data', async () => {
    const { app } = await setup();
    const response = await request(app)
      .get('/api/reports/purchasing_quotations?from=2026-07-01&to=2026-09-30')
      .set(auth(buyerToken()));
    expect(response.status).toBe(200);
    expect(response.body.summary.quotationCount).toBe(1);
    expect(response.body.summary.draftCount).toBe(1);
    expect(response.body.rows[0].totalAmount).toBe('300.00');
    expect(response.body.rows[0].vendorNameSnapshot).toBe('مورد أول');
    expect(response.body.pagination.total).toBe(1);
  });

  it('serves per-line receipt progress with exact quantities', async () => {
    const { app, order } = await setup();
    const response = await request(app)
      .get('/api/reports/purchasing_receipts?from=2026-07-01&to=2026-09-30')
      .set(auth(buyerToken()));
    expect(response.status).toBe(200);
    const first = response.body.rows.find(
      (row: any) => row.purchaseOrderLineId === order.lines[0].id,
    );
    expect(first.orderedQuantity).toBe('10.000');
    expect(first.receivedQuantity).toBe('4.000');
    expect(first.returnedQuantity).toBe('1.000');
    expect(first.netReceivedQuantity).toBe('3.000');
    expect(first.remainingQuantity).toBe('7.000');
    expect(first.fullyReceived).toBe(false);
    expect(response.body.summary.outstandingLineCount).toBe(2);

    const outstanding = await request(app)
      .get('/api/reports/purchasing_receipts?from=2026-07-01&to=2026-09-30&outstandingOnly=true')
      .set(auth(buyerToken()));
    expect(outstanding.body.rows).toHaveLength(2);
  });

  it('serves the return report', async () => {
    const { app } = await setup();
    const response = await request(app)
      .get('/api/reports/purchasing_returns?from=2026-07-01&to=2026-09-30')
      .set(auth(buyerToken()));
    expect(response.status).toBe(200);
    expect(response.body.summary.returnCount).toBe(1);
    expect(response.body.summary.pendingCount).toBe(1);
    expect(response.body.rows[0].reasonCode).toBe('damaged');
    expect(response.body.rows[0].quantity).toBe('1.000');
  });

  it('isolates registered reports by company', async () => {
    const { app } = await setup();
    const foreign = await request(app)
      .get('/api/reports/purchasing_receipts?from=2026-07-01&to=2026-09-30')
      .set(auth(foreignToken()));
    expect(foreign.status).toBe(200);
    expect(foreign.body.rows).toHaveLength(0);
    expect(foreign.body.summary.orderCount).toBe(0);
  });

  it('refuses a registered report without its permission', async () => {
    const { app } = await setup();
    const weak = tokenFor({ id: 'u-buyer', employeeId: 'e1', permissions: ['purchasing.view'] });
    const response = await request(app)
      .get('/api/reports/purchasing_receipts?from=2026-07-01&to=2026-09-30')
      .set(auth(weak));
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('REPORT_FORBIDDEN');
  });

  it('enforces the shared date-range guard', async () => {
    const { app } = await setup();
    const tooLong = await request(app)
      .get('/api/reports/purchasing_receipts?from=2024-01-01&to=2026-09-30')
      .set(auth(buyerToken()));
    expect(tooLong.status).toBe(400);
    const halfRange = await request(app)
      .get('/api/reports/purchasing_receipts?from=2026-07-01')
      .set(auth(buyerToken()));
    expect(halfRange.status).toBe(400);
  });

  it('exports a registered report through the shared CSV pipeline', async () => {
    const { app } = await setup();
    const exportToken = tokenFor({
      id: 'u-buyer',
      employeeId: '60000000-0000-4000-8000-000000000902',
      permissions: [...BUYER_PERMISSIONS, 'reports.export'],
    });
    const response = await request(app)
      .post('/api/reports/export')
      .set(auth(exportToken))
      .send({
        reportType: 'purchasing_receipts',
        format: 'csv',
        filters: { from: '2026-07-01', to: '2026-09-30' },
      });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('mawared_purchasing_receipts_');
    expect(response.text).toContain('رقم أمر الشراء');
    expect(response.text).toContain('10.000');
  });

  it('refuses exporting a registered report without reports.export', async () => {
    const { app } = await setup();
    const response = await request(app)
      .post('/api/reports/export')
      .set(auth(buyerToken()))
      .send({ reportType: 'purchasing_receipts', format: 'csv', filters: {} });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('REPORT_EXPORT_FORBIDDEN');
  });

  it('rejects an unknown report type at the export boundary', async () => {
    const { app } = await setup();
    const exportToken = tokenFor({
      id: 'u-buyer',
      employeeId: '60000000-0000-4000-8000-000000000902',
      permissions: [...BUYER_PERMISSIONS, 'reports.export'],
    });
    const response = await request(app)
      .post('/api/reports/export')
      .set(auth(exportToken))
      .send({ reportType: 'not_a_report', format: 'csv', filters: {} });
    expect(response.status).toBe(400);
  });

  it('neutralizes spreadsheet formulas in registered-report exports', async () => {
    const prisma = makeW2Prisma();
    prisma._store.vendors[0].name = '=cmd|calc';
    const app = w2App(prisma);
    const order = await createIssuedOrder(app, buyerToken());
    expect(order.vendorNameSnapshot).toBe('=cmd|calc');

    const exportToken = tokenFor({
      id: 'u-buyer',
      employeeId: '60000000-0000-4000-8000-000000000902',
      permissions: [...BUYER_PERMISSIONS, 'reports.export'],
    });
    const response = await request(app)
      .post('/api/reports/export')
      .set(auth(exportToken))
      .send({
        reportType: 'purchasing_receipts',
        format: 'csv',
        filters: { from: '2026-07-01', to: '2026-09-30' },
      });
    expect(response.status).toBe(200);
    expect(response.text).toContain("'=cmd|calc");
    expect(response.text).not.toMatch(/,"=cmd/);
    expect(neutralizeCsvCell('=1+1')).toBe("'=1+1");
  });

  it('caps a registered report at the shared 5,000-row limit', async () => {
    const prisma = makeW2Prisma();
    const app = w2App(prisma);
    const now = new Date('2026-08-05T08:00:00.000Z');
    for (let index = 0; index < 5001; index += 1) {
      prisma._purchasing.returns.push({
        id: `bulk-${index}`,
        companyId: 'c1',
        purchaseOrderId: 'bulk-order',
        returnNumber: `PRT-${index}`,
        status: 'pending_approval',
        reasonCode: 'damaged',
        createdByUserId: 'u-buyer',
        createdAt: now,
        updatedAt: now,
        idempotencyKey: `bulk-${index}`,
        payloadFingerprint: 'x',
      });
      prisma._purchasing.returnLines.push({
        id: `bulk-line-${index}`,
        companyId: 'c1',
        purchaseReturnId: `bulk-${index}`,
        purchaseOrderLineId: 'bulk-order-line',
        quantity: '1.000',
        createdAt: now,
      });
    }
    const response = await request(app)
      .get('/api/reports/purchasing_returns?from=2026-08-01&to=2026-08-31')
      .set(auth(buyerToken()));
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('REPORT_ROW_LIMIT_EXCEEDED');
  });
});
