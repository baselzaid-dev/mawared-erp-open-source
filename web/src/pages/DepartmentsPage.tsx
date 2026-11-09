import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { ApiError } from '@/api/client';
import { hrApi } from '@/hr/api';
import { departmentCreateErrorMessage } from '@/hr/errorMessages';
import type { DepartmentRecord } from '@/hr/types';
import type { Locale, Messages } from '@/i18n';
import { canManageDepartments, canViewDepartments } from '@/permissions';
import { ResourceState, type ResourcePhase } from '@/components/ResourceState';

function sortDepartments(departments: DepartmentRecord[], locale: Locale): DepartmentRecord[] {
  const collator = new Intl.Collator(locale === 'ar' ? 'ar' : 'en', { sensitivity: 'base' });
  return [...departments].sort((left, right) => collator.compare(left.name, right.name));
}

export function DepartmentsPage({
  locale,
  messages,
  permissions,
}: {
  locale: Locale;
  messages: Messages;
  permissions: readonly string[];
}) {
  const canView = canViewDepartments(permissions);
  const canManage = canManageDepartments(permissions);
  const [departments, setDepartments] = useState<DepartmentRecord[]>([]);
  const [phase, setPhase] = useState<ResourcePhase>(canView ? 'loading' : 'forbidden');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canView) {
      setPhase('forbidden');
      return;
    }
    setPhase('loading');
    try {
      const rows = await hrApi.listDepartments();
      setDepartments(sortDepartments(rows, locale));
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

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await hrApi.createDepartment({ name: name.trim(), managerId: null });
      setDialogOpen(false);
      setName('');
      await load();
    } catch (error) {
      setFormError(departmentCreateErrorMessage(error, messages));
    } finally {
      setSaving(false);
    }
  };

  const sorted = useMemo(() => sortDepartments(departments, locale), [departments, locale]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.departmentsTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.departmentsSubtitle}
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
          {canManage ? (
            <button
              type="button"
              onClick={() => {
                setFormError(null);
                setDialogOpen(true);
              }}
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white transition hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {messages.addDepartment}
            </button>
          ) : null}
        </div>
      </div>

      {phase !== 'ready' ? (
        <ResourceState
          phase={phase}
          messages={messages}
          emptyMessage={messages.departmentsEmpty}
          errorMessage={messages.departmentsError}
          forbiddenMessage={messages.departmentsForbidden}
          onRetry={() => void load()}
        />
      ) : (
        <>
          <div className="mt-6 hidden overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5 lg:block">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-start text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:bg-white/5">
                <tr>
                  <th className="px-5 py-4">{messages.departmentName}</th>
                  <th className="px-5 py-4">{messages.manager}</th>
                  <th className="px-5 py-4">{messages.activeEmployees}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((department) => (
                  <tr key={department.id} className="border-t border-slate-100 dark:border-white/10">
                    <td className="px-5 py-4 font-extrabold text-slate-950 dark:text-white">
                      {department.name}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                      {department.managerName ?? messages.noManager}
                    </td>
                    <td className="px-5 py-4 font-semibold text-slate-600 dark:text-slate-300" dir="ltr">
                      {department.activeEmployeeCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 grid gap-4 lg:hidden">
            {sorted.map((department) => (
              <article
                key={department.id}
                className="rounded-3xl border border-slate-200 bg-white p-5 shadow-panel dark:border-white/10 dark:bg-white/5"
              >
                <div className="font-extrabold text-slate-950 dark:text-white">{department.name}</div>
                <dl className="mt-4 grid gap-3 border-t border-slate-100 pt-4 text-sm dark:border-white/10">
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.manager}</dt>
                    <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200">
                      {department.managerName ?? messages.noManager}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.activeEmployees}</dt>
                    <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200" dir="ltr">
                      {department.activeEmployeeCount}
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
            aria-label={messages.createDepartmentTitle}
            className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#0b1a31] sm:p-6"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-extrabold text-slate-950 dark:text-white">
                {messages.createDepartmentTitle}
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
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={messages.departmentName}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5"
              />
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
                  {saving ? messages.creatingDepartment : messages.createDepartmentSubmit}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
