import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { ApiError } from '@/api/client';
import { hrApi } from '@/hr/api';
import { employeeCreateErrorMessage } from '@/hr/errorMessages';
import type { DepartmentRecord, EmployeeRecord, RoleOption } from '@/hr/types';
import type { Locale, Messages } from '@/i18n';
import { canCreateEmployees, canViewEmployees } from '@/permissions';
import { ResourceState, type ResourcePhase } from '@/components/ResourceState';

function statusLabel(status: string | null, messages: Messages): string {
  const normalized = (status ?? '').toLowerCase();
  if (normalized === 'active') return messages.statusActive;
  if (normalized === 'inactive') return messages.statusInactive;
  if (normalized === 'archived') return messages.statusArchived;
  return messages.statusUnknown;
}

function employeeDisplayName(employee: EmployeeRecord): string {
  return employee.user?.name?.trim() || employee.employeeNum;
}

function sortEmployees(employees: EmployeeRecord[], locale: Locale): EmployeeRecord[] {
  const collator = new Intl.Collator(locale === 'ar' ? 'ar' : 'en', { sensitivity: 'base' });
  return [...employees].sort((left, right) =>
    collator.compare(employeeDisplayName(left), employeeDisplayName(right)),
  );
}

export function EmployeesPage({
  locale,
  messages,
  permissions,
}: {
  locale: Locale;
  messages: Messages;
  permissions: readonly string[];
}) {
  const canView = canViewEmployees(permissions);
  const canCreate = canCreateEmployees(permissions);
  const [employees, setEmployees] = useState<EmployeeRecord[]>([]);
  const [phase, setPhase] = useState<ResourcePhase>(canView ? 'loading' : 'forbidden');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [departments, setDepartments] = useState<DepartmentRecord[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    employeeNum: '',
    jobTitle: '',
    joiningDate: '',
    roleId: '',
    departmentId: '',
  });

  const load = useCallback(async () => {
    if (!canView) {
      setPhase('forbidden');
      return;
    }
    setPhase('loading');
    try {
      const rows = await hrApi.listEmployees();
      setEmployees(sortEmployees(rows, locale));
      setPhase(rows.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setPhase('forbidden');
        return;
      }
      setPhase('error');
    }
  }, [canView, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = async () => {
    setFormError(null);
    setDialogOpen(true);
    try {
      const [roleRows, departmentRows] = await Promise.all([
        hrApi.listRoles(),
        hrApi.listDepartments(),
      ]);
      setRoles(roleRows);
      setDepartments(departmentRows);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setFormError(messages.employeesForbidden);
        return;
      }
      setFormError(messages.createEmployeeError);
    }
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await hrApi.createEmployee({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        employeeNum: form.employeeNum.trim(),
        jobTitle: form.jobTitle.trim(),
        joiningDate: form.joiningDate,
        roleId: form.roleId,
        departmentId: form.departmentId || null,
      });
      setDialogOpen(false);
      setForm({
        name: '',
        email: '',
        password: '',
        employeeNum: '',
        jobTitle: '',
        joiningDate: '',
        roleId: '',
        departmentId: '',
      });
      await load();
    } catch (error) {
      setFormError(employeeCreateErrorMessage(error, messages));
    } finally {
      setSaving(false);
    }
  };

  const sorted = useMemo(() => sortEmployees(employees, locale), [employees, locale]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.employeesTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.employeesSubtitle}
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
              onClick={() => void openCreate()}
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white transition hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {messages.addEmployee}
            </button>
          ) : null}
        </div>
      </div>

      {phase !== 'ready' ? (
        <ResourceState
          phase={phase}
          messages={messages}
          emptyMessage={messages.employeesEmpty}
          errorMessage={messages.employeesError}
          forbiddenMessage={messages.employeesForbidden}
          onRetry={() => void load()}
        />
      ) : (
        <>
          <div className="mt-6 hidden overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5 lg:block">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-start text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:bg-white/5">
                <tr>
                  <th className="px-5 py-4">{messages.employeeName}</th>
                  <th className="px-5 py-4">{messages.employeeNumber}</th>
                  <th className="px-5 py-4">{messages.jobTitle}</th>
                  <th className="px-5 py-4">{messages.department}</th>
                  <th className="px-5 py-4">{messages.role}</th>
                  <th className="px-5 py-4">{messages.status}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((employee) => (
                  <tr key={employee.id} className="border-t border-slate-100 dark:border-white/10">
                    <td className="px-5 py-4 font-extrabold text-slate-950 dark:text-white">
                      {employeeDisplayName(employee)}
                    </td>
                    <td className="px-5 py-4 font-semibold text-slate-600 dark:text-slate-300" dir="ltr">
                      {employee.employeeNum}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                      {employee.jobTitle || '—'}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                      {employee.department?.name ?? messages.noDepartment}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                      {employee.user?.roleName ?? messages.noRole}
                    </td>
                    <td className="px-5 py-4">
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-extrabold text-slate-600 dark:bg-white/10 dark:text-slate-200">
                        {statusLabel(employee.status, messages)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 grid gap-4 lg:hidden">
            {sorted.map((employee) => (
              <article
                key={employee.id}
                className="rounded-3xl border border-slate-200 bg-white p-5 shadow-panel dark:border-white/10 dark:bg-white/5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-extrabold text-slate-950 dark:text-white">
                      {employeeDisplayName(employee)}
                    </div>
                    <div className="mt-1 text-xs font-bold text-slate-400" dir="ltr">
                      {employee.employeeNum}
                    </div>
                  </div>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-extrabold text-slate-600 dark:bg-white/10 dark:text-slate-200">
                    {statusLabel(employee.status, messages)}
                  </span>
                </div>
                <dl className="mt-4 grid gap-3 border-t border-slate-100 pt-4 text-sm dark:border-white/10">
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.jobTitle}</dt>
                    <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200">
                      {employee.jobTitle || '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.department}</dt>
                    <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200">
                      {employee.department?.name ?? messages.noDepartment}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.role}</dt>
                    <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200">
                      {employee.user?.roleName ?? messages.noRole}
                    </dd>
                  </div>
                </dl>
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
            aria-label={messages.createEmployeeTitle}
            className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#0b1a31] sm:p-6"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-extrabold text-slate-950 dark:text-white">
                {messages.createEmployeeTitle}
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
              <input
                required
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                placeholder={messages.employeeName}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
              />
              <input
                required
                type="email"
                value={form.email}
                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                placeholder={messages.email}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
                dir="ltr"
              />
              <input
                required
                type="password"
                minLength={8}
                value={form.password}
                onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                placeholder={messages.temporaryPassword}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
                dir="ltr"
                autoComplete="new-password"
              />
              <input
                required
                value={form.employeeNum}
                onChange={(event) => setForm((current) => ({ ...current, employeeNum: event.target.value }))}
                placeholder={messages.employeeNumber}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
                dir="ltr"
              />
              <input
                required
                value={form.jobTitle}
                onChange={(event) => setForm((current) => ({ ...current, jobTitle: event.target.value }))}
                placeholder={messages.jobTitle}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
              />
              <label className="block text-xs font-bold text-slate-400">
                {messages.joiningDate}
                <input
                  required
                  type="date"
                  value={form.joiningDate}
                  onChange={(event) => setForm((current) => ({ ...current, joiningDate: event.target.value }))}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
                />
              </label>
              <select
                required
                value={form.roleId}
                onChange={(event) => setForm((current) => ({ ...current, roleId: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
              >
                <option value="">{messages.selectRole}</option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>{role.name}</option>
                ))}
              </select>
              <select
                value={form.departmentId}
                onChange={(event) => setForm((current) => ({ ...current, departmentId: event.target.value }))}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
              >
                <option value="">{messages.selectDepartment}</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>{department.name}</option>
                ))}
              </select>
              {formError ? (
                <p role="alert" className="text-sm font-bold text-red-600 dark:text-red-300">{formError}</p>
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
                  {saving ? messages.creatingEmployee : messages.createEmployeeSubmit}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
