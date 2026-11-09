import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Info, RefreshCw } from 'lucide-react';
import { ApiError } from '@/api/client';
import { ResourceState, type ResourcePhase } from '@/components/ResourceState';
import type { Locale, Messages } from '@/i18n';
import { formatMoneyAmount } from '@/payroll/money';
import { canManageSuppliers, canViewPurchasing, canViewSuppliers } from '@/permissions';
import { purchasingApi } from '@/purchasing/api';
import type { PurchaseOrderRecord, VendorRecord } from '@/purchasing/types';
import { createLatestRequestGuard } from './latestRequestGuard';

const panel =
  'rounded-3xl border border-slate-200 bg-white p-5 shadow-panel dark:border-white/10 dark:bg-white/5';
const ghostButton =
  'inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-extrabold text-slate-700 transition hover:border-brand-300 hover:text-brand-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200';

export function SuppliersPage({
  locale,
  messages,
  permissions,
}: {
  locale: Locale;
  messages: Messages;
  permissions: readonly string[];
}) {
  const canView = canViewSuppliers(permissions);
  const canManage = canManageSuppliers(permissions);
  const canSeeOrders = canViewPurchasing(permissions);

  const [phase, setPhase] = useState<ResourcePhase>(canView ? 'loading' : 'forbidden');
  const [vendors, setVendors] = useState<VendorRecord[]>([]);
  const [orders, setOrders] = useState<PurchaseOrderRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const guard = useRef(createLatestRequestGuard());

  const load = useCallback(async () => {
    if (!canView) {
      setPhase('forbidden');
      return;
    }
    const requestId = guard.current.begin();
    setPhase('loading');
    try {
      // Both lifecycle states, so the screen shows true vendor state.
      const [active, inactive, orderPage] = await Promise.all([
        purchasingApi.listVendors({ status: 'active', pageSize: 100 }),
        purchasingApi.listVendors({ status: 'inactive', pageSize: 100 }),
        canSeeOrders
          ? purchasingApi.listOrders({ pageSize: 100 })
          : Promise.resolve({ items: [] as PurchaseOrderRecord[], total: 0 }),
      ]);
      if (!guard.current.isCurrent(requestId)) return;
      const merged = [...active.items, ...inactive.items];
      setVendors(merged);
      setOrders(orderPage.items);
      setPhase(merged.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (!guard.current.isCurrent(requestId)) return;
      setPhase(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error');
    }
  }, [canSeeOrders, canView]);

  useEffect(() => {
    void load();
  }, [load]);

  const collator = useMemo(
    () => new Intl.Collator(locale === 'ar' ? 'ar' : 'en', { sensitivity: 'base' }),
    [locale],
  );
  const sorted = useMemo(
    () => [...vendors].sort((left, right) => collator.compare(left.name, right.name)),
    [collator, vendors],
  );
  const selected = sorted.find((vendor) => vendor.id === selectedId) ?? null;
  const selectedOrders = selected
    ? orders.filter((order) => order.vendorId === selected.id)
    : [];

  const toggleStatus = async (vendor: VendorRecord) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await purchasingApi.setVendorStatus(
        vendor.id,
        vendor.status === 'active' ? 'inactive' : 'active',
      );
      await load();
    } catch (error) {
      setActionError(
        error instanceof ApiError && error.status === 409
          ? messages.conflictRefresh
          : messages.suppliersError,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.suppliersTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.suppliersSubtitle}
          </p>
        </div>
        <button type="button" onClick={() => void load()} disabled={phase === 'loading' || !canView} className={ghostButton}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {messages.refresh}
        </button>
      </div>

      <p className="mt-4 inline-flex items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-500 dark:bg-white/5 dark:text-slate-400">
        <Info className="h-4 w-4" aria-hidden="true" />
        {messages.supplierSensitiveHidden}
      </p>

      {actionError ? (
        <p role="alert" className="mt-4 text-sm font-bold text-red-600 dark:text-red-300">{actionError}</p>
      ) : null}

      {phase !== 'ready' ? (
        <ResourceState
          phase={phase}
          messages={messages}
          emptyMessage={messages.suppliersEmpty}
          errorMessage={messages.suppliersError}
          forbiddenMessage={messages.suppliersForbidden}
          onRetry={() => void load()}
        />
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-start text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:bg-white/5">
                <tr>
                  <th className="px-5 py-4 text-start">{messages.supplierName}</th>
                  <th className="px-5 py-4 text-start">{messages.supplierCategory}</th>
                  <th className="px-5 py-4 text-start">{messages.supplierStatus}</th>
                  <th className="px-5 py-4" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((vendor) => (
                  <tr
                    key={vendor.id}
                    className={`border-t border-slate-100 dark:border-white/10 ${
                      selectedId === vendor.id ? 'bg-brand-50 dark:bg-brand-500/10' : ''
                    }`}
                  >
                    <td className="px-5 py-4 font-extrabold text-slate-950 dark:text-white">{vendor.name}</td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">{vendor.category ?? '—'}</td>
                    <td className="px-5 py-4">
                      <span
                        className={`inline-flex rounded-lg px-2.5 py-1 text-xs font-extrabold ${
                          vendor.status === 'active'
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200'
                            : 'bg-slate-200 text-slate-700 dark:bg-white/10 dark:text-slate-300'
                        }`}
                      >
                        {vendor.status === 'active' ? messages.activeStatus : messages.archivedStatus}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => setSelectedId(vendor.id)} className={ghostButton}>
                          {messages.viewDetails}
                        </button>
                        {canManage ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void toggleStatus(vendor)}
                            className={ghostButton}
                          >
                            {vendor.status === 'active' ? messages.deactivateSupplier : messages.reactivateSupplier}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <aside className={panel}>
            {selected ? (
              <>
                <h2 className="text-lg font-extrabold text-slate-950 dark:text-white">{selected.name}</h2>
                <dl className="mt-4 grid gap-3 text-sm">
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.supplierCategory}</dt>
                    <dd className="mt-1 font-semibold">{selected.category ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.supplierStatus}</dt>
                    <dd className="mt-1 font-semibold">
                      {selected.status === 'active' ? messages.activeStatus : messages.archivedStatus}
                    </dd>
                  </div>
                </dl>

                {canSeeOrders ? (
                  <>
                    <h3 className="mt-6 text-sm font-extrabold text-slate-950 dark:text-white">
                      {messages.supplierOrders}
                    </h3>
                    <ul className="mt-3 space-y-2">
                      {selectedOrders.length === 0 ? (
                        <li className="text-sm font-bold text-slate-500">{messages.purchasingEmpty}</li>
                      ) : (
                        selectedOrders.map((order) => (
                          <li
                            key={order.id}
                            className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-3 py-2 dark:border-white/10"
                          >
                            <span className="font-extrabold" dir="ltr">{order.orderNumber}</span>
                            <span className="text-xs font-semibold text-slate-500" dir="ltr">
                              {formatMoneyAmount(order.totalAmount, order.currency)}
                            </span>
                          </li>
                        ))
                      )}
                    </ul>
                  </>
                ) : null}
              </>
            ) : (
              <p className="text-sm font-bold text-slate-500">{messages.viewDetails}</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
