import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { ApiError } from '@/api/client';
import { ResourceState, type ResourcePhase } from '@/components/ResourceState';
import { hrApi } from '@/hr/api';
import { leaveActionErrorMessage } from '@/hr/errorMessages';
import {
  employeeLeaveName,
  formatDisplayDate,
  leaveStageLabel,
  leaveStatusLabel,
  leaveTypeLabel,
  yearBoundsUtc,
} from '@/hr/format';
import type { LeaveRecord, LeaveTimelineEvent } from '@/hr/types';
import type { Locale, Messages } from '@/i18n';
import {
  canAccessApprovalInbox,
  canAdminApproveLeaves,
  canApproveLeaves,
  canViewCompanyLeaves,
} from '@/permissions';
import { createLatestRequestGuard } from './latestRequestGuard';

type InboxTab = 'pending' | 'approved' | 'rejected' | 'all';
type DecisionMode = 'approve' | 'reject' | null;

function canActOnLeave(
  leave: LeaveRecord,
  permissions: readonly string[],
  actorEmployeeId: string | null,
): boolean {
  if (actorEmployeeId && leave.employeeId === actorEmployeeId) return false;
  if (leave.status === 'pending_hr') return canApproveLeaves(permissions);
  if (leave.status === 'pending_admin') return canAdminApproveLeaves(permissions);
  return false;
}

export function ApprovalsPage({
  locale,
  messages,
  permissions,
  actorEmployeeId,
}: {
  locale: Locale;
  messages: Messages;
  permissions: readonly string[];
  actorEmployeeId: string | null;
}) {
  const canAccess = canAccessApprovalInbox(permissions);
  const canBrowseHistory = canViewCompanyLeaves(permissions);
  const [tab, setTab] = useState<InboxTab>('pending');
  const [rows, setRows] = useState<LeaveRecord[]>([]);
  const [phase, setPhase] = useState<ResourcePhase>(canAccess ? 'loading' : 'forbidden');
  const [selected, setSelected] = useState<LeaveRecord | null>(null);
  const [timeline, setTimeline] = useState<LeaveTimelineEvent[]>([]);
  const [decisionMode, setDecisionMode] = useState<DecisionMode>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const detailsRequestGuard = useRef(createLatestRequestGuard());

  const load = useCallback(async () => {
    if (!canAccess) {
      setPhase('forbidden');
      return;
    }
    setPhase('loading');
    try {
      if (tab === 'pending') {
        const pending = await hrApi.listPendingLeaves();
        setRows(pending);
        setPhase(pending.length === 0 ? 'empty' : 'ready');
        return;
      }
      if (!canBrowseHistory) {
        setRows([]);
        setPhase('forbidden');
        return;
      }
      const bounds = yearBoundsUtc();
      const report = await hrApi.listLeaveReport({
        from: bounds.from,
        to: bounds.to,
        status: tab === 'all' ? undefined : tab,
      });
      setRows(report.requests);
      setPhase(report.requests.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setPhase('forbidden');
        return;
      }
      setPhase('error');
    }
  }, [canAccess, canBrowseHistory, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetails = async (leave: LeaveRecord) => {
    const requestId = detailsRequestGuard.current.begin();
    setSelected(leave);
    setTimeline([]);
    setDecisionMode(null);
    setRejectReason('');
    setActionError(null);
    try {
      const [fresh, history] = await Promise.all([
        hrApi.getLeave(leave.id).catch(() => leave),
        hrApi.getLeaveTimeline(leave.id).catch(() => ({ events: [] as LeaveTimelineEvent[] })),
      ]);
      if (!detailsRequestGuard.current.isCurrent(requestId)) return;
      setSelected(fresh);
      setTimeline(history.events ?? []);
    } catch {
      if (detailsRequestGuard.current.isCurrent(requestId)) setTimeline([]);
    }
  };

  const refreshSelected = async (id: string) => {
    const requestId = detailsRequestGuard.current.begin();
    try {
      const fresh = await hrApi.getLeave(id);
      if (!detailsRequestGuard.current.isCurrent(requestId)) return null;
      setSelected(fresh);
      setRows((current) => current.map((row) => (row.id === id ? fresh : row)));
      if (tab === 'pending' && fresh.status !== 'pending_hr' && fresh.status !== 'pending_admin') {
        setRows((current) => current.filter((row) => row.id !== id));
      }
      const history = await hrApi.getLeaveTimeline(id).catch(() => ({ events: [] as LeaveTimelineEvent[] }));
      if (!detailsRequestGuard.current.isCurrent(requestId)) return null;
      setTimeline(history.events ?? []);
      return fresh;
    } catch {
      if (!detailsRequestGuard.current.isCurrent(requestId)) return null;
      await load();
      if (!detailsRequestGuard.current.isCurrent(requestId)) return null;
      setSelected(null);
      setTimeline([]);
      return null;
    }
  };

  const runDecision = async () => {
    if (!selected || !decisionMode || busy) return;
    if (decisionMode === 'reject' && !rejectReason.trim()) {
      setActionError(messages.leaveRejectReasonRequired);
      return;
    }
    setBusy(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      const isAdminStage = selected.status === 'pending_admin';
      if (decisionMode === 'approve') {
        if (isAdminStage) await hrApi.adminApproveLeave(selected.id);
        else await hrApi.hrApproveLeave(selected.id);
      } else if (isAdminStage) {
        await hrApi.adminRejectLeave(selected.id, rejectReason.trim());
      } else {
        await hrApi.hrRejectLeave(selected.id, rejectReason.trim());
      }
      setActionSuccess(messages.leaveActionSuccess);
      setDecisionMode(null);
      setRejectReason('');
      await refreshSelected(selected.id);
      await load();
    } catch (error) {
      setActionError(leaveActionErrorMessage(error, messages));
      if (error instanceof ApiError && (error.status === 409 || error.status === 403 || error.status === 404)) {
        await refreshSelected(selected.id);
      }
    } finally {
      setBusy(false);
    }
  };

  const tabs = useMemo(() => {
    const items: Array<{ id: InboxTab; label: string }> = [
      { id: 'pending', label: messages.tabPending },
    ];
    if (canBrowseHistory) {
      items.push(
        { id: 'approved', label: messages.tabApproved },
        { id: 'rejected', label: messages.tabRejected },
        { id: 'all', label: messages.tabAll },
      );
    }
    return items;
  }, [canBrowseHistory, messages]);

  const selectedCanAct =
    selected && canActOnLeave(selected, permissions, actorEmployeeId)
      ? selected.status === 'pending_hr' || selected.status === 'pending_admin'
      : false;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.approvalsTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.approvalsSubtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={phase === 'loading' || !canAccess}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-extrabold text-slate-700 transition hover:border-brand-300 hover:text-brand-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {messages.refresh}
        </button>
      </div>

      <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label={messages.approvalsTitle}>
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`rounded-xl px-4 py-2.5 text-sm font-extrabold transition ${
              tab === item.id
                ? 'bg-brand-600 text-white'
                : 'border border-slate-200 bg-white text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {actionSuccess ? (
        <p
          role="status"
          className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-100"
        >
          {actionSuccess}
        </p>
      ) : null}

      {phase !== 'ready' ? (
        <ResourceState
          phase={phase}
          messages={messages}
          emptyMessage={messages.approvalsEmpty}
          errorMessage={messages.approvalsError}
          forbiddenMessage={messages.approvalsForbidden}
          onRetry={() => void load()}
        />
      ) : (
        <>
          <div className="mt-6 hidden overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5 lg:block">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-start text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:bg-white/5">
                <tr>
                  <th className="px-5 py-4">{messages.employeeName}</th>
                  <th className="px-5 py-4">{messages.department}</th>
                  <th className="px-5 py-4">{messages.leaveType}</th>
                  <th className="px-5 py-4">{messages.duration}</th>
                  <th className="px-5 py-4">{messages.currentStage}</th>
                  <th className="px-5 py-4">{messages.createdAt}</th>
                  <th className="px-5 py-4">{messages.viewDetails}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-slate-100 dark:border-white/10">
                    <td className="px-5 py-4 font-extrabold text-slate-950 dark:text-white">
                      {employeeLeaveName(row)}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                      {row.employee?.department?.name ?? messages.noDepartment}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                      {leaveTypeLabel(row.leaveType, messages)}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300" dir="ltr">
                      {formatDisplayDate(row.startDate, locale)} → {formatDisplayDate(row.endDate, locale)} ({row.totalDays})
                    </td>
                    <td className="px-5 py-4">
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-extrabold text-slate-600 dark:bg-white/10 dark:text-slate-200">
                        {leaveStageLabel(row, messages)}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300" dir="ltr">
                      {formatDisplayDate(row.createdAt, locale)}
                    </td>
                    <td className="px-5 py-4">
                      <button
                        type="button"
                        onClick={() => void openDetails(row)}
                        className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-extrabold text-slate-700 dark:border-white/10 dark:text-slate-200"
                      >
                        {messages.viewDetails}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 grid gap-4 lg:hidden">
            {rows.map((row) => (
              <article
                key={row.id}
                className="rounded-3xl border border-slate-200 bg-white p-5 shadow-panel dark:border-white/10 dark:bg-white/5"
              >
                <div className="font-extrabold text-slate-950 dark:text-white">
                  {employeeLeaveName(row)}
                </div>
                <div className="mt-1 text-xs font-bold text-slate-400">
                  {leaveTypeLabel(row.leaveType, messages)} · {leaveStatusLabel(row.status, messages)}
                </div>
                <button
                  type="button"
                  onClick={() => void openDetails(row)}
                  className="mt-4 rounded-xl border border-slate-200 px-3 py-2 text-xs font-extrabold text-slate-700 dark:border-white/10 dark:text-slate-200"
                >
                  {messages.viewDetails}
                </button>
              </article>
            ))}
          </div>
        </>
      )}

      {selected ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={messages.viewDetails}
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#0b1a31] sm:p-6"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-extrabold text-slate-950 dark:text-white">
                {employeeLeaveName(selected)}
              </h2>
              <button
                type="button"
                onClick={() => {
                  detailsRequestGuard.current.invalidate();
                  setSelected(null);
                  setTimeline([]);
                  setDecisionMode(null);
                  setActionError(null);
                }}
                className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-200"
                aria-label={messages.close}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-bold text-slate-400">{messages.department}</dt>
                <dd className="mt-1 font-semibold">
                  {selected.employee?.department?.name ?? messages.noDepartment}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-bold text-slate-400">{messages.leaveType}</dt>
                <dd className="mt-1 font-semibold">{leaveTypeLabel(selected.leaveType, messages)}</dd>
              </div>
              <div>
                <dt className="text-xs font-bold text-slate-400">{messages.duration}</dt>
                <dd className="mt-1 font-semibold" dir="ltr">
                  {formatDisplayDate(selected.startDate, locale)} → {formatDisplayDate(selected.endDate, locale)} ({selected.totalDays})
                </dd>
              </div>
              <div>
                <dt className="text-xs font-bold text-slate-400">{messages.currentStage}</dt>
                <dd className="mt-1 font-semibold">{leaveStageLabel(selected, messages)}</dd>
              </div>
              <div>
                <dt className="text-xs font-bold text-slate-400">{messages.submittedBy}</dt>
                <dd className="mt-1 font-semibold">{employeeLeaveName(selected)}</dd>
              </div>
              <div>
                <dt className="text-xs font-bold text-slate-400">{messages.createdAt}</dt>
                <dd className="mt-1 font-semibold" dir="ltr">
                  {formatDisplayDate(selected.createdAt, locale)}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs font-bold text-slate-400">{messages.notes}</dt>
                <dd className="mt-1 font-semibold">{selected.reason || '—'}</dd>
              </div>
              {selected.rejectionReason ? (
                <div className="sm:col-span-2">
                  <dt className="text-xs font-bold text-slate-400">{messages.rejectionReason}</dt>
                  <dd className="mt-1 font-semibold">{selected.rejectionReason}</dd>
                </div>
              ) : null}
            </dl>

            <div className="mt-6">
              <h3 className="text-sm font-extrabold text-slate-950 dark:text-white">
                {messages.actionHistory}
              </h3>
              {timeline.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">{messages.noTimeline}</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {timeline.map((event) => (
                    <li
                      key={`${event.at}-${event.type}-${event.summary}`}
                      className="rounded-2xl border border-slate-200 px-4 py-3 text-sm dark:border-white/10"
                    >
                      <div className="font-extrabold text-slate-900 dark:text-white">{event.summary}</div>
                      <div className="mt-1 text-xs text-slate-500" dir="ltr">
                        {formatDisplayDate(event.at, locale)}
                        {event.actorName ? ` · ${event.actorName}` : ''}
                        {event.actorRole ? ` (${event.actorRole})` : ''}
                      </div>
                      {event.fromStatus || event.toStatus ? (
                        <div className="mt-1 text-xs text-slate-500">
                          {event.fromStatus ?? '—'} → {event.toStatus ?? '—'}
                        </div>
                      ) : null}
                      {event.reason ? (
                        <div className="mt-1 text-xs font-semibold text-slate-600 dark:text-slate-300">
                          {event.reason}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {selectedCanAct ? (
              <div className="mt-6 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDecisionMode('approve');
                    setActionError(null);
                  }}
                  className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white transition hover:bg-brand-700 disabled:opacity-50"
                >
                  {messages.approve}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDecisionMode('reject');
                    setActionError(null);
                  }}
                  className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-extrabold text-red-700 transition hover:bg-red-100 disabled:opacity-50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
                >
                  {messages.reject}
                </button>
              </div>
            ) : null}

            {decisionMode ? (
              <div className="mt-4 rounded-2xl border border-slate-200 p-4 dark:border-white/10">
                <h4 className="text-sm font-extrabold text-slate-950 dark:text-white">
                  {decisionMode === 'approve'
                    ? messages.confirmApproveTitle
                    : messages.confirmRejectTitle}
                </h4>
                <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                  {decisionMode === 'approve'
                    ? messages.confirmApproveBody
                    : messages.confirmRejectBody}
                </p>
                {decisionMode === 'reject' ? (
                  <label className="mt-3 block text-xs font-bold text-slate-400">
                    {messages.rejectionReason}
                    <textarea
                      required
                      value={rejectReason}
                      onChange={(event) => setRejectReason(event.target.value)}
                      placeholder={messages.rejectReasonPlaceholder}
                      rows={3}
                      className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
                    />
                  </label>
                ) : null}
                {actionError ? (
                  <p role="alert" className="mt-3 text-sm font-bold text-red-600 dark:text-red-300">
                    {actionError}
                  </p>
                ) : null}
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDecisionMode(null)}
                    className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-extrabold text-slate-700 dark:border-white/10 dark:text-slate-200"
                  >
                    {messages.cancel}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runDecision()}
                    className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white transition hover:bg-brand-700 disabled:opacity-50"
                  >
                    {busy ? messages.processingAction : decisionMode === 'approve' ? messages.approve : messages.reject}
                  </button>
                </div>
              </div>
            ) : actionError ? (
              <p role="alert" className="mt-4 text-sm font-bold text-red-600 dark:text-red-300">
                {actionError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
