import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Play, RefreshCw } from 'lucide-react';
import { ApiError } from '@/api/client';
import { ResourceState, type ResourcePhase } from '@/components/ResourceState';
import type { Locale, Messages } from '@/i18n';
import { canExportReports, canViewReports } from '@/permissions';
import { reportsApi } from '@/reports/api';
import type { ReportCatalogEntry, ReportDetail } from '@/reports/types';
import { createLatestRequestGuard } from './latestRequestGuard';

const panel =
  'rounded-3xl border border-slate-200 bg-white p-5 shadow-panel dark:border-white/10 dark:bg-white/5';
const primaryButton =
  'inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white transition hover:bg-brand-700 disabled:opacity-50';
const ghostButton =
  'inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-extrabold text-slate-700 transition hover:border-brand-300 hover:text-brand-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200';
const inputClass =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5';

/** The overview report has its own dashboard surface and is not run here. */
const RUNNABLE = (entry: ReportCatalogEntry) => entry.type !== 'overview';

function cellText(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'boolean') return value ? '✓' : '—';
  return String(value);
}

export function ReportsPage({
  locale,
  messages,
  permissions,
}: {
  locale: Locale;
  messages: Messages;
  permissions: readonly string[];
}) {
  const canView = canViewReports(permissions);
  const canExport = canExportReports(permissions);

  const [phase, setPhase] = useState<ResourcePhase>(canView ? 'loading' : 'forbidden');
  const [catalog, setCatalog] = useState<ReportCatalogEntry[]>([]);
  const [selected, setSelected] = useState<ReportCatalogEntry | null>(null);
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [detailPhase, setDetailPhase] = useState<ResourcePhase | 'idle'>('idle');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [exporting, setExporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const guard = useRef(createLatestRequestGuard());
  const detailGuard = useRef(createLatestRequestGuard());

  const loadCatalog = useCallback(async () => {
    if (!canView) {
      setPhase('forbidden');
      return;
    }
    const requestId = guard.current.begin();
    setPhase('loading');
    try {
      const entries = (await reportsApi.catalog()).filter(RUNNABLE);
      if (!guard.current.isCurrent(requestId)) return;
      setCatalog(entries);
      setPhase(entries.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (!guard.current.isCurrent(requestId)) return;
      setPhase(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error');
    }
  }, [canView]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const runReport = async (entry: ReportCatalogEntry) => {
    const requestId = detailGuard.current.begin();
    setSelected(entry);
    setDetailPhase('loading');
    setActionError(null);
    try {
      const filters: Record<string, string> = {};
      if (from && to) {
        filters.from = from;
        filters.to = to;
      }
      const result = await reportsApi.run(entry.type, filters);
      if (!detailGuard.current.isCurrent(requestId)) return;
      setDetail(result);
      setDetailPhase(result.rows.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (!detailGuard.current.isCurrent(requestId)) return;
      setDetail(null);
      setDetailPhase(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error');
    }
  };

  const exportReport = async () => {
    if (!selected || exporting) return;
    setExporting(true);
    setActionError(null);
    try {
      const filters: Record<string, string> = {};
      if (from && to) {
        filters.from = from;
        filters.to = to;
      }
      const file = await reportsApi.exportCsv(selected.type, filters);
      const url = URL.createObjectURL(file.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setActionError(
        error instanceof ApiError && error.status === 403
          ? messages.exportForbidden
          : messages.reportsError,
      );
    } finally {
      setExporting(false);
    }
  };

  const columns = detail?.rows.length ? Object.keys(detail.rows[0]) : [];

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.reportsTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.reportsSubtitle}
          </p>
        </div>
        <button type="button" onClick={() => void loadCatalog()} disabled={phase === 'loading' || !canView} className={ghostButton}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {messages.refresh}
        </button>
      </div>

      {phase !== 'ready' ? (
        <ResourceState
          phase={phase}
          messages={messages}
          emptyMessage={messages.reportsEmpty}
          errorMessage={messages.reportsError}
          forbiddenMessage={messages.reportsForbidden}
          onRetry={() => void loadCatalog()}
        />
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <section>
            <h2 className="text-sm font-extrabold uppercase tracking-wider text-slate-400">
              {messages.reportCatalog}
            </h2>
            <ul className="mt-3 grid gap-3">
              {catalog.map((entry) => (
                <li key={entry.type}>
                  <article className={`${panel} ${selected?.type === entry.type ? 'ring-2 ring-brand-500' : ''}`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <h3 className="font-extrabold text-slate-950 dark:text-white">{entry.title}</h3>
                      {entry.source === 'registered' ? (
                        <span className="rounded-md bg-sky-100 px-2 py-0.5 text-[10px] font-extrabold text-sky-800 dark:bg-sky-500/15 dark:text-sky-200">
                          {messages.reportRegisteredBadge}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">{entry.description}</p>
                    <button
                      type="button"
                      onClick={() => void runReport(entry)}
                      className={`${primaryButton} mt-4`}
                    >
                      <Play className="h-4 w-4" aria-hidden="true" />
                      {messages.runReport}
                    </button>
                  </article>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-bold text-slate-600 dark:text-slate-300">
                {messages.reportFrom}
                <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className={`${inputClass} mt-1`} dir="ltr" />
              </label>
              <label className="block text-sm font-bold text-slate-600 dark:text-slate-300">
                {messages.reportTo}
                <input type="date" value={to} onChange={(event) => setTo(event.target.value)} className={`${inputClass} mt-1`} dir="ltr" />
              </label>
            </div>

            {selected ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <h2 className="me-auto text-lg font-extrabold text-slate-950 dark:text-white">{selected.title}</h2>
                {canExport && selected.exportAvailable ? (
                  <button type="button" onClick={() => void exportReport()} disabled={exporting} className={ghostButton}>
                    <Download className="h-4 w-4" aria-hidden="true" />
                    {exporting ? messages.exporting : messages.exportCsv}
                  </button>
                ) : null}
              </div>
            ) : null}

            {actionError ? (
              <p role="alert" className="mt-3 text-sm font-bold text-red-600 dark:text-red-300">{actionError}</p>
            ) : null}

            {detailPhase === 'idle' ? (
              <p className="mt-6 text-sm font-bold text-slate-500">{messages.runReport}</p>
            ) : detailPhase !== 'ready' ? (
              <ResourceState
                phase={detailPhase}
                messages={messages}
                emptyMessage={messages.reportNoRows}
                errorMessage={messages.reportsError}
                forbiddenMessage={messages.reportsForbidden}
                onRetry={() => selected && void runReport(selected)}
              />
            ) : detail ? (
              <>
                <h3 className="mt-6 text-sm font-extrabold uppercase tracking-wider text-slate-400">
                  {messages.reportSummary}
                </h3>
                <dl className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
                  {Object.entries(detail.summary).map(([key, value]) => (
                    <div key={key} className={panel}>
                      <dt className="text-xs font-bold text-slate-400" dir="ltr">{key}</dt>
                      <dd className="mt-1 text-lg font-extrabold text-slate-950 dark:text-white" dir="ltr">
                        {cellText(value)}
                      </dd>
                    </div>
                  ))}
                </dl>

                {detail.protectedRowsHidden ? (
                  <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900 dark:bg-amber-500/10 dark:text-amber-100">
                    {messages.reportProtectedRows}
                  </p>
                ) : null}

                <h3 className="mt-6 text-sm font-extrabold uppercase tracking-wider text-slate-400">
                  {messages.reportRows}
                </h3>
                <div className="mt-3 overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:bg-white/5">
                      <tr>
                        {columns.map((column) => (
                          <th key={column} className="whitespace-nowrap px-4 py-3 text-start" dir="ltr">{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {detail.rows.map((row, index) => (
                        <tr key={index} className="border-t border-slate-100 dark:border-white/10">
                          {columns.map((column) => (
                            <td key={column} className="whitespace-nowrap px-4 py-3 text-slate-600 dark:text-slate-300">
                              {cellText(row[column])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-xs text-slate-400" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
                  {messages.reportRowCapNote}
                </p>
              </>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
