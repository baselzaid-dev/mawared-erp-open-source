import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { ApiError } from '@/api/client';
import { ResourceState, type ResourcePhase } from '@/components/ResourceState';
import { hrApi } from '@/hr/api';
import { leaveCreateErrorMessage } from '@/hr/errorMessages';
import {
  employeeLeaveName,
  formatDisplayDate,
  isAnnualLeaveType,
  leaveStageLabel,
  leaveStatusLabel,
  leaveTypeLabel,
  yearBoundsUtc,
} from '@/hr/format';
import type { DepartmentRecord, LeaveRecord } from '@/hr/types';
import type { Locale, Messages } from '@/i18n';
import {
  canCreateLeaves,
  canViewCompanyLeaves,
  canViewLeaves,
} from '@/permissions';

const LEAVE_TYPES = [
  { value: 'annual', labelKey: 'leaveTypeAnnual' },
  { value: 'sick', labelKey: 'leaveTypeSick' },
  { value: 'special', labelKey: 'leaveTypeSpecial' },
  { value: 'unpaid', labelKey: 'leaveTypeUnpaid' },
  { value: 'study', labelKey: 'leaveTypeStudy' },
] as const;

export function LeavesPage({
  locale,
  messages,
  permissions,
  focusResourceId = null,
}: {
  locale: Locale;
  messages: Messages;
  permissions: readonly string[];
  /** Memory-only leave id from a notification deep link. */
  focusResourceId?: string | null;
}) {
  const canView = canViewLeaves(permissions);
  const canCreate = canCreateLeaves(permissions);
  const companyScope = canViewCompanyLeaves(permissions);
  const defaults = yearBoundsUtc();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [status, setStatus] = useState('');
  const [leaveType, setLeaveType] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<LeaveRecord[]>([]);
  const [departments, setDepartments] = useState<DepartmentRecord[]>([]);
  const [phase, setPhase] = useState<ResourcePhase>(canView ? 'loading' : 'forbidden');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [detail, setDetail] = useState<LeaveRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    leaveType: 'annual',
    startDate: '',
    endDate: '',
    reason: '',
    exitReentryRequested: false,
    visaFeePaid: false,
  });

  const load = useCallback(async () => {
    if (!canView) {
      setPhase('forbidden');
      return;
    }
    setPhase('loading');
    try {
      const [leaveRows, departmentRows] = await Promise.all([
        companyScope
          ? hrApi
              .listLeaveReport({
                from,
                to,
                status: status || undefined,
                leaveType: leaveType || undefined,
              })
              .then((response) => response.requests)
          : hrApi.listMyLeaves({
              from,
              to,
              status: status || undefined,
              leaveType: leaveType || undefined,
            }),
        hrApi.listDepartments().catch(() => [] as DepartmentRecord[]),
      ]);
      setRows(leaveRows);
      setDepartments(departmentRows);
      setPhase(leaveRows.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setPhase('forbidden');
        return;
      }
      setPhase('error');
    }
  }, [canView, companyScope, from, leaveType, status, to]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Open the leave a notification pointed at via the authorized detail API.
   * Fail closed to the list when the id is missing/forbidden — never invent access.
   */
  useEffect(() => {
    if (!focusResourceId || !canView) return;
    let cancelled = false;
    void (async () => {
      try {
        const leave = await hrApi.getLeave(focusResourceId);
        if (!cancelled) setDetail(leave);
      } catch {
        // Keep the list; Backend already decided this account cannot see the row.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canView, focusResourceId]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (departmentId && row.employee?.departmentId !== departmentId) return false;
      if (!needle) return true;
      const name = employeeLeaveName(row).toLowerCase();
      const number = (row.employee?.employeeNum ?? '').toLowerCase();
      return name.includes(needle) || number.includes(needle);
    });
  }, [departmentId, rows, search]);

  const displayPhase: ResourcePhase =
    phase === 'ready' && filtered.length === 0 ? 'empty' : phase;

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (form.endDate && form.startDate && form.endDate < form.startDate) {
      setFormError(messages.leaveDateOrderError);
      return;
    }
    if (
      isAnnualLeaveType(form.leaveType) &&
      form.exitReentryRequested &&
      !form.visaFeePaid
    ) {
      setFormError(messages.leaveVisaFeeRequired);
      return;
    }
    setSaving(true);
    setFormError(null);
    setSuccessMessage(null);
    try {
      await hrApi.createLeave({
        leaveType: form.leaveType,
        startDate: form.startDate,
        endDate: form.endDate,
        reason: form.reason.trim() || null,
        exitReentryRequested: isAnnualLeaveType(form.leaveType)
          ? form.exitReentryRequested
          : false,
        visaFeePaid: isAnnualLeaveType(form.leaveType) ? form.visaFeePaid : false,
      });
      setDialogOpen(false);
      setForm({
        leaveType: 'annual',
        startDate: '',
        endDate: '',
        reason: '',
        exitReentryRequested: false,
        visaFeePaid: false,
      });
      setSuccessMessage(messages.leaveCreatedSuccess);
      await load();
    } catch (error) {
      setFormError(leaveCreateErrorMessage(error, messages));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.leavesTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.leavesSubtitle}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={phase === 'loading' || !canView}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-extrabold text-slate-700 transition hover:border-brand-300 hover:text-brand-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {messages.refresh}
          </button>
          {canCreate ? (
            <button
              type="button"
              onClick={() => {
                setFormError(null);
                setDialogOpen(true);
              }}
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white transition hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {messages.addLeave}
            </button>
          ) : null}
        </div>
      </div>

      {successMessage ? (
        <p
          role="status"
          className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-100"
        >
          {successMessage}
        </p>
      ) : null}

      <div className="mt-6 grid gap-3 rounded-3xl border border-slate-200 bg-white p-4 shadow-panel dark:border-white/10 dark:bg-white/5 md:grid-cols-2 xl:grid-cols-3">
        <label className="block text-xs font-bold text-slate-400">
          {messages.filterFrom}
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
          />
        </label>
        <label className="block text-xs font-bold text-slate-400">
          {messages.filterTo}
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
          />
        </label>
        <label className="block text-xs font-bold text-slate-400">
          {messages.filterStatus}
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
          >
            <option value="">{messages.allStatuses}</option>
            <option value="pending_hr">{messages.leaveStatusPendingHr}</option>
            <option value="pending_admin">{messages.leaveStatusPendingAdmin}</option>
            <option value="approved">{messages.leaveStatusApproved}</option>
            <option value="rejected">{messages.leaveStatusRejected}</option>
            <option value="cancelled">{messages.leaveStatusCancelled}</option>
          </select>
        </label>
        <label className="block text-xs font-bold text-slate-400">
          {messages.filterLeaveType}
          <select
            value={leaveType}
            onChange={(event) => setLeaveType(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
          >
            <option value="">{messages.allLeaveTypes}</option>
            {LEAVE_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {messages[type.labelKey]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-bold text-slate-400">
          {messages.filterDepartment}
          <select
            value={departmentId}
            onChange={(event) => setDepartmentId(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
          >
            <option value="">{messages.allDepartments}</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-bold text-slate-400">
          {messages.searchEmployee}
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={messages.searchEmployee}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
          />
        </label>
      </div>

      {displayPhase !== 'ready' ? (
        <ResourceState
          phase={displayPhase}
          messages={messages}
          emptyMessage={messages.leavesEmpty}
          errorMessage={messages.leavesError}
          forbiddenMessage={messages.leavesForbidden}
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
                  <th className="px-5 py-4">{messages.startDate}</th>
                  <th className="px-5 py-4">{messages.endDate}</th>
                  <th className="px-5 py-4">{messages.totalDays}</th>
                  <th className="px-5 py-4">{messages.status}</th>
                  <th className="px-5 py-4">{messages.currentStage}</th>
                  <th className="px-5 py-4">{messages.createdAt}</th>
                  <th className="px-5 py-4">{messages.rejectionReason}</th>
                  <th className="px-5 py-4">{messages.viewDetails}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
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
                      {formatDisplayDate(row.startDate, locale)}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300" dir="ltr">
                      {formatDisplayDate(row.endDate, locale)}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300" dir="ltr">
                      {row.totalDays}
                    </td>
                    <td className="px-5 py-4">
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-extrabold text-slate-600 dark:bg-white/10 dark:text-slate-200">
                        {leaveStatusLabel(row.status, messages)}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                      {leaveStageLabel(row, messages)}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300" dir="ltr">
                      {formatDisplayDate(row.createdAt, locale)}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                      {row.rejectionReason || '—'}
                    </td>
                    <td className="px-5 py-4">
                      <button
                        type="button"
                        onClick={() => setDetail(row)}
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
            {filtered.map((row) => (
              <article
                key={row.id}
                className="rounded-3xl border border-slate-200 bg-white p-5 shadow-panel dark:border-white/10 dark:bg-white/5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-extrabold text-slate-950 dark:text-white">
                      {employeeLeaveName(row)}
                    </div>
                    <div className="mt-1 text-xs font-bold text-slate-400">
                      {leaveTypeLabel(row.leaveType, messages)}
                    </div>
                  </div>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-extrabold text-slate-600 dark:bg-white/10 dark:text-slate-200">
                    {leaveStatusLabel(row.status, messages)}
                  </span>
                </div>
                <dl className="mt-4 grid gap-3 border-t border-slate-100 pt-4 text-sm dark:border-white/10">
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.department}</dt>
                    <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200">
                      {row.employee?.department?.name ?? messages.noDepartment}
                    </dd>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <dt className="text-xs font-bold text-slate-400">{messages.startDate}</dt>
                      <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200" dir="ltr">
                        {formatDisplayDate(row.startDate, locale)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-bold text-slate-400">{messages.endDate}</dt>
                      <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200" dir="ltr">
                        {formatDisplayDate(row.endDate, locale)}
                      </dd>
                    </div>
                  </div>
                  {row.rejectionReason ? (
                    <div>
                      <dt className="text-xs font-bold text-slate-400">{messages.rejectionReason}</dt>
                      <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200">
                        {row.rejectionReason}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                <button
                  type="button"
                  onClick={() => setDetail(row)}
                  className="mt-4 rounded-xl border border-slate-200 px-3 py-2 text-xs font-extrabold text-slate-700 dark:border-white/10 dark:text-slate-200"
                >
                  {messages.viewDetails}
                </button>
              </article>
            ))}
          </div>
        </>
      )}

      {dialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={messages.createLeaveTitle}
            className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#0b1a31] sm:p-6"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-extrabold text-slate-950 dark:text-white">
                {messages.createLeaveTitle}
              </h2>
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-200"
                aria-label={messages.close}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <form className="mt-5 space-y-3" onSubmit={(event) => void submitCreate(event)}>
              <label className="block text-xs font-bold text-slate-400">
                {messages.leaveType}
                <select
                  required
                  value={form.leaveType}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, leaveType: event.target.value }))
                  }
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
                >
                  {LEAVE_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {messages[type.labelKey]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs font-bold text-slate-400">
                {messages.startDate}
                <input
                  required
                  type="date"
                  value={form.startDate}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, startDate: event.target.value }))
                  }
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
                />
              </label>
              <label className="block text-xs font-bold text-slate-400">
                {messages.endDate}
                <input
                  required
                  type="date"
                  value={form.endDate}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, endDate: event.target.value }))
                  }
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
                />
              </label>
              <label className="block text-xs font-bold text-slate-400">
                {messages.reason}
                <textarea
                  value={form.reason}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, reason: event.target.value }))
                  }
                  rows={3}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
                />
              </label>
              {isAnnualLeaveType(form.leaveType) ? (
                <div className="space-y-2 rounded-2xl border border-slate-200 p-3 dark:border-white/10">
                  <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                    <input
                      type="checkbox"
                      checked={form.exitReentryRequested}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          exitReentryRequested: event.target.checked,
                          visaFeePaid: event.target.checked ? current.visaFeePaid : false,
                        }))
                      }
                    />
                    {messages.exitReentry}
                  </label>
                  {form.exitReentryRequested ? (
                    <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                      <input
                        type="checkbox"
                        checked={form.visaFeePaid}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            visaFeePaid: event.target.checked,
                          }))
                        }
                      />
                      {messages.visaFeePaid}
                    </label>
                  ) : null}
                </div>
              ) : null}
              {formError ? (
                <p role="alert" className="text-sm font-bold text-red-600 dark:text-red-300">
                  {formError}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setDialogOpen(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-extrabold text-slate-700 dark:border-white/10 dark:text-slate-200"
                >
                  {messages.cancel}
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white transition hover:bg-brand-700 disabled:opacity-50"
                >
                  {saving ? messages.creatingLeave : messages.createLeaveSubmit}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {detail ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={messages.viewDetails}
            className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#0b1a31] sm:p-6"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-extrabold text-slate-950 dark:text-white">
                {employeeLeaveName(detail)}
              </h2>
              <button
                type="button"
                onClick={() => setDetail(null)}
                className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-200"
                aria-label={messages.close}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <dl className="mt-5 grid gap-3 text-sm">
              <div>
                <dt className="text-xs font-bold text-slate-400">{messages.leaveType}</dt>
                <dd className="mt-1 font-semibold">{leaveTypeLabel(detail.leaveType, messages)}</dd>
              </div>
              <div>
                <dt className="text-xs font-bold text-slate-400">{messages.currentStage}</dt>
                <dd className="mt-1 font-semibold">{leaveStageLabel(detail, messages)}</dd>
              </div>
              <div>
                <dt className="text-xs font-bold text-slate-400">{messages.notes}</dt>
                <dd className="mt-1 font-semibold">{detail.reason || '—'}</dd>
              </div>
              {detail.rejectionReason ? (
                <div>
                  <dt className="text-xs font-bold text-slate-400">{messages.rejectionReason}</dt>
                  <dd className="mt-1 font-semibold">{detail.rejectionReason}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        </div>
      ) : null}
    </div>
  );
}
