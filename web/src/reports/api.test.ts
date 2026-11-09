import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionMemory } from '@/auth/sessionMemory';
import { reportsApi } from './api';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const authenticate = () =>
  sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture

describe('company web reports API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionMemory.clear();
  });

  it('reads the permission-filtered catalog, including registered reports', async () => {
    authenticate();
    const fetchMock = vi.fn().mockResolvedValue(json([
      { type: 'purchasing', title: 'Purchasing', source: 'built_in', exportAvailable: true },
      { type: 'purchasing_receipts', title: 'Receipts', source: 'registered', module: 'purchasing', exportAvailable: true },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const catalog = await reportsApi.catalog();

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/reports/catalog');
    expect(catalog.map((entry) => entry.source)).toEqual(['built_in', 'registered']);
  });

  it('runs a registered report on its own detail route', async () => {
    authenticate();
    const fetchMock = vi.fn().mockResolvedValue(json({ rows: [], summary: {}, pagination: { page: 1, pageSize: 25, total: 0 } }));
    vi.stubGlobal('fetch', fetchMock);

    await reportsApi.run('purchasing_receipts', { from: '2026-08-01', to: '2026-08-31' });

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/api/reports/purchasing_receipts?from=2026-08-01&to=2026-08-31',
    );
  });

  it('downloads the server-generated CSV and honours a safe filename', async () => {
    authenticate();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('a,b\r\n1,2\r\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="mawared_purchasing_receipts_20260808T000000Z.csv"',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const file = await reportsApi.exportCsv('purchasing_receipts', { from: '2026-08-01', to: '2026-08-31' });

    expect(file.filename).toBe('mawared_purchasing_receipts_20260808T000000Z.csv');
    expect(await file.blob.text()).toContain('a,b');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/reports/export');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      reportType: 'purchasing_receipts',
      format: 'csv',
      filters: { from: '2026-08-01', to: '2026-08-31' },
    });
  });

  it('falls back to a safe filename when the server sends an unsafe one', async () => {
    authenticate();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('a\r\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="../../etc/passwd"',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const file = await reportsApi.exportCsv('purchasing_returns');

    expect(file.filename).toBe('mawared_purchasing_returns.csv');
  });

  it('surfaces an export refusal instead of producing an empty file', async () => {
    authenticate();
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'REPORT_EXPORT_FORBIDDEN' }, 403));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reportsApi.exportCsv('purchasing_quotations')).rejects.toMatchObject({
      status: 403,
      code: 'REPORT_EXPORT_FORBIDDEN',
    });
  });

  it('surfaces the shared row-cap error', async () => {
    authenticate();
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'REPORT_ROW_LIMIT_EXCEEDED' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reportsApi.run('purchasing_receipts')).rejects.toMatchObject({
      status: 400,
      code: 'REPORT_ROW_LIMIT_EXCEEDED',
    });
  });
});
