import { authenticatedDownload, authenticatedRequest, type DownloadedFile } from '@/api/client';
import type { ReportCatalogEntry, ReportDetail } from './types';

const query = (filters: Record<string, string | number | boolean | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
};

export const reportsApi = {
  /**
   * The catalog is already filtered by the backend to the reports this user may
   * run, including reports published through the Wave 2 registration contract.
   */
  catalog(): Promise<ReportCatalogEntry[]> {
    return authenticatedRequest('/api/reports/catalog');
  },

  run(
    reportType: string,
    filters: Record<string, string | number | boolean | undefined> = {},
  ): Promise<ReportDetail> {
    return authenticatedRequest(`/api/reports/${encodeURIComponent(reportType)}${query(filters)}`);
  },

  /** Server-generated CSV: the export permission and row cap are enforced there. */
  exportCsv(
    reportType: string,
    filters: Record<string, string | number | boolean | null> = {},
  ): Promise<DownloadedFile> {
    return authenticatedDownload(
      '/api/reports/export',
      {
        method: 'POST',
        body: JSON.stringify({ reportType, format: 'csv', filters }),
      },
      `mawared_${reportType}.csv`,
    );
  },
};
