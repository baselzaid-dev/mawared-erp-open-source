import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ApiError } from '@/api/client';
import { ResourceState, type ResourcePhase } from '@/components/ResourceState';
import { hrApi } from '@/hr/api';
import {
  formatDisplayDate,
  formatDisplayTime,
  utcDateInputValue,
  workHoursLabel,
  yearBoundsUtc,
} from '@/hr/format';
import type { AttendanceRecord, DepartmentRecord } from '@/hr/types';
import type { Locale, Messages } from '@/i18n';
import { canViewAttendance, canViewCompanyLeaves } from '@/permissions';

function attendanceName(row: AttendanceRecord): string {
  return row.employee?.user?.name?.trim() || row.employee?.employeeNum || row.employeeId;
}

function attendanceStatusLabel(
  row: AttendanceRecord,
  messages: Messages,
): { label: string; missingCheckout: boolean } {
  const missingCheckout = Boolean(row.clockIn && !row.clockOut);
  if (missingCheckout) return { label: messages.attendanceMissingCheckout, missingCheckout: true };
  const status = (row.status ?? '').toLowerCase();
  if (status === 'present') return { label: messages.attendancePresent, missingCheckout: false };
  if (status === 'absent') return { label: messages.attendanceAbsent, missingCheckout: false };
  if (status === 'late') return { label: messages.attendanceLate, missingCheckout: false };
  return { label: messages.statusUnknown, missingCheckout: false };
}

export function AttendancePage({
  locale,
  messages,
  permissions,
}: {
  locale: Locale;
  messages: Messages;
  permissions: readonly string[];
}) {
  const canView = canViewAttendance(permissions);
  const canLoadOnLeave = canViewCompanyLeaves(permissions);
  const today = utcDateInputValue();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [departmentId, setDepartmentId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<AttendanceRecord[]>([]);
  const [departments, setDepartments] = useState<DepartmentRecord[]>([]);
  const [onLeaveCount, setOnLeaveCount] = useState(0);
  const [phase, setPhase] = useState<ResourcePhase>(canView ? 'loading' : 'forbidden');

  const load = useCallback(async () => {
    if (!canView) {
      setPhase('forbidden');
      return;
    }
    setPhase('loading');
    try {
      const [attendanceRows, departmentRows, leaveReport] = await Promise.all([
        hrApi.listAttendance({
          from: from || undefined,
          to: to || undefined,
          departmentId: departmentId || undefined,
          employeeId: employeeId || undefined,
          status: status || undefined,
        }),
        hrApi.listDepartments().catch(() => [] as DepartmentRecord[]),
        canLoadOnLeave
          ? hrApi
              .listLeaveReport({
                from: from || yearBoundsUtc().from,
                to: to || yearBoundsUtc().to,
                status: 'approved',
                employeeId: employeeId || undefined,
              })
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      setRows(attendanceRows);
      setDepartments(departmentRows);
      const rangeFrom = from || today;
      const rangeTo = to || from || today;
      setOnLeaveCount(
        leaveReport
          ? leaveReport.requests.filter((leave) => {
              if (departmentId && leave.employee?.departmentId !== departmentId) return false;
              if (employeeId && leave.employeeId !== employeeId) return false;
              const start = String(leave.startDate).slice(0, 10);
              const end = String(leave.endDate).slice(0, 10);
              return start <= rangeTo && end >= rangeFrom;
            }).length
          : 0,
      );
      setPhase(attendanceRows.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setPhase('forbidden');
        return;
      }
      setPhase('error');
    }
  }, [canLoadOnLeave, canView, departmentId, employeeId, from, status, to, today]);

  useEffect(() => {
    void load();
  }, [load]);

  const employeeOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.employeeId, attendanceName(row));
    }
    return [...map.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => {
      const name = attendanceName(row).toLowerCase();
      const number = (row.employee?.employeeNum ?? '').toLowerCase();
      return name.includes(needle) || number.includes(needle);
    });
  }, [rows, search]);

  const kpis = useMemo(() => {
    let present = 0;
    let absent = 0;
    let late = 0;
    let missingCheckout = 0;
    for (const row of filtered) {
      const statusValue = (row.status ?? '').toLowerCase();
      if (row.clockIn && !row.clockOut) missingCheckout += 1;
      if (statusValue === 'absent') absent += 1;
      else if (statusValue === 'late') late += 1;
      else if (statusValue === 'present') present += 1;
    }
    return { present, absent, late, onLeave: onLeaveCount, missingCheckout };
  }, [filtered, onLeaveCount]);

  const displayPhase: ResourcePhase =
    phase === 'ready' && filtered.length === 0 && (search || status) ? 'empty' : phase;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.attendanceTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.attendanceSubtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={phase === 'loading' || !canView}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-extrabold text-slate-700 transition hover:border-brand-300 hover:text-brand-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {messages.refresh}
        </button>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          { label: messages.kpiPresent, value: kpis.present },
          { label: messages.kpiAbsent, value: kpis.absent },
          { label: messages.kpiLate, value: kpis.late },
          { label: messages.kpiOnLeave, value: kpis.onLeave },
          { label: messages.kpiMissingCheckout, value: kpis.missingCheckout },
        ].map((card) => (
          <article
            key={card.label}
            className="rounded-3xl border border-slate-200 bg-white p-5 shadow-panel dark:border-white/10 dark:bg-white/5"
          >
            <div className="text-xs font-extrabold uppercase tracking-wider text-slate-400">
              {card.label}
            </div>
            <div className="mt-2 text-2xl font-extrabold text-slate-950 dark:text-white" dir="ltr">
              {canView && phase !== 'forbidden' && phase !== 'error' ? card.value : '—'}
            </div>
          </article>
        ))}
      </div>

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
          {messages.filterEmployee}
          <select
            value={employeeId}
            onChange={(event) => setEmployeeId(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
          >
            <option value="">{messages.allEmployees}</option>
            {employeeOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-bold text-slate-400">
          {messages.filterStatus}
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
          >
            <option value="">{messages.allStatuses}</option>
            <option value="present">{messages.attendancePresent}</option>
            <option value="absent">{messages.attendanceAbsent}</option>
            <option value="late">{messages.attendanceLate}</option>
          </select>
        </label>
        <label className="block text-xs font-bold text-slate-400 md:col-span-2 xl:col-span-1">
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
          emptyMessage={messages.attendanceEmpty}
          errorMessage={messages.attendanceError}
          forbiddenMessage={messages.attendanceForbidden}
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
                  <th className="px-5 py-4">{messages.date}</th>
                  <th className="px-5 py-4">{messages.checkIn}</th>
                  <th className="px-5 py-4">{messages.checkOut}</th>
                  <th className="px-5 py-4">{messages.workHours}</th>
                  <th className="px-5 py-4">{messages.lateness}</th>
                  <th className="px-5 py-4">{messages.status}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const statusInfo = attendanceStatusLabel(row, messages);
                  return (
                    <tr key={row.id} className="border-t border-slate-100 dark:border-white/10">
                      <td className="px-5 py-4 font-extrabold text-slate-950 dark:text-white">
                        <div>{attendanceName(row)}</div>
                        <div className="mt-1 text-xs font-bold text-slate-400" dir="ltr">
                          {row.employee?.employeeNum ?? '—'}
                        </div>
                      </td>
                      <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                        {row.employee?.department?.name ?? messages.noDepartment}
                      </td>
                      <td className="px-5 py-4 text-slate-600 dark:text-slate-300" dir="ltr">
                        {formatDisplayDate(row.date, locale)}
                      </td>
                      <td className="px-5 py-4 text-slate-600 dark:text-slate-300" dir="ltr">
                        {formatDisplayTime(row.clockIn, locale)}
                      </td>
                      <td className="px-5 py-4 text-slate-600 dark:text-slate-300" dir="ltr">
                        {formatDisplayTime(row.clockOut, locale)}
                      </td>
                      <td className="px-5 py-4 text-slate-600 dark:text-slate-300" dir="ltr">
                        {workHoursLabel(row.clockIn, row.clockOut)}
                      </td>
                      <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                        {(row.status ?? '').toLowerCase() === 'late'
                          ? messages.attendanceLate
                          : messages.notAvailable}
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-extrabold ${
                            statusInfo.missingCheckout
                              ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-100'
                              : 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-200'
                          }`}
                        >
                          {statusInfo.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-6 grid gap-4 lg:hidden">
            {filtered.map((row) => {
              const statusInfo = attendanceStatusLabel(row, messages);
              return (
                <article
                  key={row.id}
                  className="rounded-3xl border border-slate-200 bg-white p-5 shadow-panel dark:border-white/10 dark:bg-white/5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-extrabold text-slate-950 dark:text-white">
                        {attendanceName(row)}
                      </div>
                      <div className="mt-1 text-xs font-bold text-slate-400" dir="ltr">
                        {row.employee?.employeeNum ?? '—'}
                      </div>
                    </div>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-extrabold text-slate-600 dark:bg-white/10 dark:text-slate-200">
                      {statusInfo.label}
                    </span>
                  </div>
                  <dl className="mt-4 grid gap-3 border-t border-slate-100 pt-4 text-sm dark:border-white/10">
                    <div>
                      <dt className="text-xs font-bold text-slate-400">{messages.department}</dt>
                      <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200">
                        {row.employee?.department?.name ?? messages.noDepartment}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-bold text-slate-400">{messages.date}</dt>
                      <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200" dir="ltr">
                        {formatDisplayDate(row.date, locale)}
                      </dd>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <dt className="text-xs font-bold text-slate-400">{messages.checkIn}</dt>
                        <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200" dir="ltr">
                          {formatDisplayTime(row.clockIn, locale)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-bold text-slate-400">{messages.checkOut}</dt>
                        <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200" dir="ltr">
                          {formatDisplayTime(row.clockOut, locale)}
                        </dd>
                      </div>
                    </div>
                    <div>
                      <dt className="text-xs font-bold text-slate-400">{messages.workHours}</dt>
                      <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200" dir="ltr">
                        {workHoursLabel(row.clockIn, row.clockOut)}
                      </dd>
                    </div>
                  </dl>
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
