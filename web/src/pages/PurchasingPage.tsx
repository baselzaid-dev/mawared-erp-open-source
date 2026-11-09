import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  GitCompare,
  PackageCheck,
  Plus,
  RefreshCw,
  Undo2,
  X,
} from 'lucide-react';
import { ApiError } from '@/api/client';
import { ResourceState, type ResourcePhase } from '@/components/ResourceState';
import type { Locale, Messages } from '@/i18n';
import { formatMoneyAmount } from '@/payroll/money';
import {
  canApproveReturns,
  canCompareQuotations,
  canCreateReturns,
  canManageQuotations,
  canOverrideReceipt,
  canReceivePurchasing,
  canViewPurchasing,
  canViewQuotations,
} from '@/permissions';
import { purchasingApi } from '@/purchasing/api';
import {
  exceedsRemaining,
  formatQuantity,
  isPositiveQuantity,
  receivedPercent,
} from '@/purchasing/quantity';
import {
  RETURN_REASON_CODES,
  type OrderReceiptProgress,
  type PurchaseOrderRecord,
  type PurchaseRequestRecord,
  type PurchaseReturnRecord,
  type QuotationComparison,
  type QuotationRecord,
  type ReceiptRecord,
  type ReturnReasonCode,
} from '@/purchasing/types';
import { createLatestRequestGuard } from './latestRequestGuard';

type Tab = 'requests' | 'orders';

const panel =
  'rounded-3xl border border-slate-200 bg-white p-5 shadow-panel dark:border-white/10 dark:bg-white/5';
const primaryButton =
  'inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white transition hover:bg-brand-700 disabled:opacity-50';
const ghostButton =
  'inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-extrabold text-slate-700 transition hover:border-brand-300 hover:text-brand-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200';
const inputClass =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold outline-none ring-brand-500 focus:ring-2 dark:border-white/10 dark:bg-white/5';

function statusTone(status: string): string {
  if (['approved', 'received', 'selected'].includes(status)) {
    return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200';
  }
  if (['rejected', 'cancelled'].includes(status)) {
    return 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-200';
  }
  if (['ordered', 'issued', 'partially_received', 'submitted'].includes(status)) {
    return 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200';
  }
  return 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100';
}

function StatusChip({ status }: { status: string }) {
  return (
    <span className={`inline-flex rounded-lg px-2.5 py-1 text-xs font-extrabold ${statusTone(status)}`} dir="ltr">
      {status}
    </span>
  );
}

function errorPhase(error: unknown): ResourcePhase {
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return 'forbidden';
  return 'error';
}

function actionMessage(error: unknown, messages: Messages): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return messages.conflictRefresh;
    if (error.status === 403) return messages.purchasingForbidden;
  }
  return messages.purchasingError;
}

const returnReasonLabel = (code: ReturnReasonCode, messages: Messages): string => {
  switch (code) {
    case 'damaged':
      return messages.returnReasonDamaged;
    case 'wrong_item':
      return messages.returnReasonWrongItem;
    case 'excess_quantity':
      return messages.returnReasonExcess;
    case 'quality_rejected':
      return messages.returnReasonQuality;
    case 'expired':
      return messages.returnReasonExpired;
    default:
      return messages.returnReasonOther;
  }
};

export function PurchasingPage({
  locale,
  messages,
  permissions,
  focusResourceId = null,
}: {
  locale: Locale;
  messages: Messages;
  permissions: readonly string[];
  /** Memory-only purchase-request id from a notification deep link. */
  focusResourceId?: string | null;
}) {
  const canView = canViewPurchasing(permissions);
  const canQuote = canManageQuotations(permissions);
  const canSeeQuotations = canViewQuotations(permissions);
  const canCompare = canCompareQuotations(permissions);
  const canReceive = canReceivePurchasing(permissions);
  const canOverride = canOverrideReceipt(permissions);
  const canRaiseReturn = canCreateReturns(permissions);
  const canReviewReturn = canApproveReturns(permissions);

  const [tab, setTab] = useState<Tab>('requests');
  const [phase, setPhase] = useState<ResourcePhase>(canView ? 'loading' : 'forbidden');
  const [requests, setRequests] = useState<PurchaseRequestRecord[]>([]);
  const [orders, setOrders] = useState<PurchaseOrderRecord[]>([]);
  const [selectedRequest, setSelectedRequest] = useState<PurchaseRequestRecord | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<PurchaseOrderRecord | null>(null);
  const guard = useRef(createLatestRequestGuard());
  const appliedFocusRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!canView) {
      setPhase('forbidden');
      return;
    }
    const requestId = guard.current.begin();
    setPhase('loading');
    try {
      const [requestPage, orderPage] = await Promise.all([
        purchasingApi.listRequests({ pageSize: 50 }),
        purchasingApi.listOrders({ pageSize: 50 }),
      ]);
      if (!guard.current.isCurrent(requestId)) return;
      setRequests(requestPage.items);
      setOrders(orderPage.items);
      setPhase(requestPage.items.length === 0 && orderPage.items.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (!guard.current.isCurrent(requestId)) return;
      setPhase(errorPhase(error));
    }
  }, [canView]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Open the purchase request a notification pointed at. Prefer the already-loaded
   * permission-filtered list; otherwise fetch the exact id. Backend remains the
   * authority — a 403/404 leaves the user on the list. Applied once per focus id
   * so Back does not immediately reopen the same detail.
   */
  useEffect(() => {
    if (!focusResourceId || !canView) return;
    if (appliedFocusRef.current === focusResourceId) return;
    const fromList = requests.find((request) => request.id === focusResourceId);
    if (fromList) {
      appliedFocusRef.current = focusResourceId;
      setTab('requests');
      setSelectedRequest(fromList);
      return;
    }
    if (phase !== 'ready' && phase !== 'empty') return;
    let cancelled = false;
    void (async () => {
      try {
        const request = await purchasingApi.getRequest(focusResourceId);
        if (cancelled) return;
        appliedFocusRef.current = focusResourceId;
        setTab('requests');
        setSelectedRequest(request);
      } catch {
        appliedFocusRef.current = focusResourceId;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canView, focusResourceId, phase, requests]);

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', { dateStyle: 'medium' }),
    [locale],
  );
  const formatDate = (value: string | null | undefined) =>
    value ? dateFormatter.format(new Date(value)) : '—';

  if (selectedRequest) {
    return (
      <RequestDetail
        locale={locale}
        messages={messages}
        request={selectedRequest}
        canQuote={canQuote}
        canSeeQuotations={canSeeQuotations}
        canCompare={canCompare}
        onBack={() => {
          setSelectedRequest(null);
          void load();
        }}
        formatDate={formatDate}
      />
    );
  }

  if (selectedOrder) {
    return (
      <OrderDetail
        messages={messages}
        order={selectedOrder}
        canReceive={canReceive}
        canOverride={canOverride}
        canRaiseReturn={canRaiseReturn}
        canReviewReturn={canReviewReturn}
        onBack={() => {
          setSelectedOrder(null);
          void load();
        }}
        formatDate={formatDate}
      />
    );
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.purchasingTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.purchasingSubtitle}
          </p>
        </div>
        <button type="button" onClick={() => void load()} disabled={phase === 'loading' || !canView} className={ghostButton}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {messages.refresh}
        </button>
      </div>

      <div className="mt-6 flex flex-wrap gap-2" role="tablist">
        {(['requests', 'orders'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={
              tab === value
                ? 'rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white'
                : 'rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-extrabold text-slate-600 dark:border-white/10 dark:text-slate-300'
            }
          >
            {value === 'requests' ? messages.purchasingRequestsTab : messages.purchasingOrdersTab}
          </button>
        ))}
      </div>

      {phase !== 'ready' ? (
        <ResourceState
          phase={phase}
          messages={messages}
          emptyMessage={messages.purchasingEmpty}
          errorMessage={messages.purchasingError}
          forbiddenMessage={messages.purchasingForbidden}
          onRetry={() => void load()}
        />
      ) : tab === 'requests' ? (
        <>
          <div className="mt-6 hidden overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5 lg:block">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-start text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:bg-white/5">
                <tr>
                  <th className="px-5 py-4">{messages.requestNumber}</th>
                  <th className="px-5 py-4">{messages.requester}</th>
                  <th className="px-5 py-4">{messages.department}</th>
                  <th className="px-5 py-4">{messages.status}</th>
                  <th className="px-5 py-4">{messages.amount}</th>
                  <th className="px-5 py-4">{messages.neededBy}</th>
                  <th className="px-5 py-4" />
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id} className="border-t border-slate-100 dark:border-white/10">
                    <td className="px-5 py-4 font-extrabold text-slate-950 dark:text-white" dir="ltr">
                      {request.requestNumber}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">{request.requesterNameSnapshot}</td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                      {request.departmentNameSnapshot ?? '—'}
                    </td>
                    <td className="px-5 py-4"><StatusChip status={request.status} /></td>
                    <td className="px-5 py-4 font-semibold text-slate-700 dark:text-slate-200" dir="ltr">
                      {formatMoneyAmount(request.totalEstimated, request.currency)}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">{formatDate(request.neededByDate)}</td>
                    <td className="px-5 py-4">
                      <button type="button" onClick={() => setSelectedRequest(request)} className={ghostButton}>
                        {messages.viewDetails}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 grid gap-4 lg:hidden">
            {requests.map((request) => (
              <article key={request.id} className={panel}>
                <div className="flex items-start justify-between gap-3">
                  <div className="font-extrabold text-slate-950 dark:text-white" dir="ltr">{request.requestNumber}</div>
                  <StatusChip status={request.status} />
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-600 dark:text-slate-300">{request.title}</p>
                <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 text-sm dark:border-white/10">
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.amount}</dt>
                    <dd className="mt-1 font-semibold" dir="ltr">{formatMoneyAmount(request.totalEstimated, request.currency)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.neededBy}</dt>
                    <dd className="mt-1 font-semibold">{formatDate(request.neededByDate)}</dd>
                  </div>
                </dl>
                <button type="button" onClick={() => setSelectedRequest(request)} className={`${ghostButton} mt-4 w-full justify-center`}>
                  {messages.viewDetails}
                </button>
              </article>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="mt-6 hidden overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5 lg:block">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-start text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:bg-white/5">
                <tr>
                  <th className="px-5 py-4">{messages.orderNumber}</th>
                  <th className="px-5 py-4">{messages.supplier}</th>
                  <th className="px-5 py-4">{messages.requestNumber}</th>
                  <th className="px-5 py-4">{messages.status}</th>
                  <th className="px-5 py-4">{messages.amount}</th>
                  <th className="px-5 py-4" />
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="border-t border-slate-100 dark:border-white/10">
                    <td className="px-5 py-4 font-extrabold text-slate-950 dark:text-white" dir="ltr">{order.orderNumber}</td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">{order.vendorNameSnapshot}</td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300" dir="ltr">
                      {order.request?.requestNumber ?? '—'}
                    </td>
                    <td className="px-5 py-4"><StatusChip status={order.status} /></td>
                    <td className="px-5 py-4 font-semibold text-slate-700 dark:text-slate-200" dir="ltr">
                      {formatMoneyAmount(order.totalAmount, order.currency)}
                    </td>
                    <td className="px-5 py-4">
                      <button type="button" onClick={() => setSelectedOrder(order)} className={ghostButton}>
                        {messages.viewDetails}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 grid gap-4 lg:hidden">
            {orders.map((order) => (
              <article key={order.id} className={panel}>
                <div className="flex items-start justify-between gap-3">
                  <div className="font-extrabold text-slate-950 dark:text-white" dir="ltr">{order.orderNumber}</div>
                  <StatusChip status={order.status} />
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-600 dark:text-slate-300">{order.vendorNameSnapshot}</p>
                <button type="button" onClick={() => setSelectedOrder(order)} className={`${ghostButton} mt-4 w-full justify-center`}>
                  {messages.viewDetails}
                </button>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Purchase request detail: quotations + comparison
// ---------------------------------------------------------------------------

function RequestDetail({
  locale,
  messages,
  request,
  canQuote,
  canSeeQuotations,
  canCompare,
  onBack,
  formatDate,
}: {
  locale: Locale;
  messages: Messages;
  request: PurchaseRequestRecord;
  canQuote: boolean;
  canSeeQuotations: boolean;
  canCompare: boolean;
  onBack: () => void;
  formatDate: (value: string | null | undefined) => string;
}) {
  const [phase, setPhase] = useState<ResourcePhase>(canSeeQuotations ? 'loading' : 'forbidden');
  const [quotations, setQuotations] = useState<QuotationRecord[]>([]);
  const [comparison, setComparison] = useState<QuotationComparison | null>(null);
  const [showComparison, setShowComparison] = useState(false);
  const [dialog, setDialog] = useState<'create' | 'award' | null>(null);
  const [awardTarget, setAwardTarget] = useState<QuotationRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const guard = useRef(createLatestRequestGuard());

  const load = useCallback(async () => {
    if (!canSeeQuotations) {
      setPhase('forbidden');
      return;
    }
    const requestId = guard.current.begin();
    setPhase('loading');
    try {
      const page = await purchasingApi.listQuotations(request.id);
      if (!guard.current.isCurrent(requestId)) return;
      setQuotations(page.items);
      setPhase(page.items.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (!guard.current.isCurrent(requestId)) return;
      setPhase(errorPhase(error));
    }
  }, [canSeeQuotations, request.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const openComparison = async () => {
    setBusy(true);
    setFormError(null);
    try {
      setComparison(await purchasingApi.compareQuotations(request.id));
      setShowComparison(true);
    } catch (error) {
      setFormError(actionMessage(error, messages));
    } finally {
      setBusy(false);
    }
  };

  const submitAward = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!awardTarget || busy) return;
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    if (!reason) return;
    setBusy(true);
    setFormError(null);
    try {
      await purchasingApi.selectQuotation(awardTarget.id, reason);
      setDialog(null);
      setAwardTarget(null);
      await load();
      if (showComparison) setComparison(await purchasingApi.compareQuotations(request.id));
    } catch (error) {
      setFormError(actionMessage(error, messages));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl">
      <button type="button" onClick={onBack} className={ghostButton}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {messages.backToList}
      </button>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-950 dark:text-white" dir="ltr">
            {request.requestNumber}
          </h1>
          <p className="mt-1 text-sm font-semibold text-slate-600 dark:text-slate-300">{request.title}</p>
          <div className="mt-2"><StatusChip status={request.status} /></div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canCompare ? (
            <button type="button" onClick={() => void openComparison()} disabled={busy} className={ghostButton}>
              <GitCompare className="h-4 w-4" aria-hidden="true" />
              {messages.compareQuotations}
            </button>
          ) : null}
          {canQuote ? (
            <button type="button" onClick={() => { setFormError(null); setDialog('create'); }} className={primaryButton}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {messages.addQuotation}
            </button>
          ) : null}
        </div>
      </div>

      {formError ? (
        <p role="alert" className="mt-4 text-sm font-bold text-red-600 dark:text-red-300">{formError}</p>
      ) : null}

      <h2 className="mt-8 text-lg font-extrabold text-slate-950 dark:text-white">{messages.quotations}</h2>
      {phase !== 'ready' ? (
        <ResourceState
          phase={phase}
          messages={messages}
          emptyMessage={messages.quotationsEmpty}
          errorMessage={messages.purchasingError}
          forbiddenMessage={messages.quotationsForbidden}
          onRetry={() => void load()}
        />
      ) : (
        <div className="mt-4 grid gap-4">
          {quotations.map((quotation) => (
            <article key={quotation.id} className={panel}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-extrabold text-slate-950 dark:text-white" dir="ltr">
                    {quotation.quotationNumber}
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-600 dark:text-slate-300">
                    {quotation.vendorNameSnapshot}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip status={quotation.status} />
                  <span className="text-xs font-bold text-slate-400" dir="ltr">
                    {messages.quotationVersion} {quotation.version}
                  </span>
                </div>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 text-sm dark:border-white/10 md:grid-cols-4">
                <div>
                  <dt className="text-xs font-bold text-slate-400">{messages.amount}</dt>
                  <dd className="mt-1 font-extrabold" dir="ltr">
                    {formatMoneyAmount(quotation.totalAmount, quotation.currency)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-bold text-slate-400">{messages.validUntil}</dt>
                  <dd className="mt-1 font-semibold">{formatDate(quotation.validUntilDate)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold text-slate-400">{messages.expectedDelivery}</dt>
                  <dd className="mt-1 font-semibold">{formatDate(quotation.expectedDeliveryDate)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold text-slate-400">{messages.leadTimeDays}</dt>
                  <dd className="mt-1 font-semibold" dir="ltr">{quotation.leadTimeDays ?? '—'}</dd>
                </div>
              </dl>

              {canQuote ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {quotation.status === 'draft' ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setFormError(null);
                        try {
                          await purchasingApi.submitQuotation(quotation.id);
                          await load();
                        } catch (error) {
                          setFormError(actionMessage(error, messages));
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className={ghostButton}
                    >
                      {messages.submitQuotation}
                    </button>
                  ) : null}
                  {quotation.status === 'submitted' ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setAwardTarget(quotation);
                        setFormError(null);
                        setDialog('award');
                      }}
                      className={primaryButton}
                    >
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      {messages.selectQuotation}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}

      {showComparison && comparison ? (
        <ComparisonPanel
          messages={messages}
          comparison={comparison}
          onClose={() => setShowComparison(false)}
        />
      ) : null}

      {dialog === 'create' ? (
        <QuotationDialog
          locale={locale}
          messages={messages}
          request={request}
          busy={busy}
          error={formError}
          onClose={() => setDialog(null)}
          onSubmit={async (input) => {
            setBusy(true);
            setFormError(null);
            try {
              await purchasingApi.createQuotation(request.id, input);
              setDialog(null);
              await load();
            } catch (error) {
              setFormError(actionMessage(error, messages));
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {dialog === 'award' && awardTarget ? (
        <Dialog messages={messages} title={messages.selectQuotationTitle} onClose={() => setDialog(null)}>
          <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">{messages.selectQuotationHint}</p>
          <form className="mt-4 space-y-3" onSubmit={(event) => void submitAward(event)}>
            <label className="block text-sm font-bold text-slate-600 dark:text-slate-300">
              {messages.selectionReason}
              <input name="reason" required maxLength={500} className={`${inputClass} mt-1`} />
            </label>
            {formError ? (
              <p role="alert" className="text-sm font-bold text-red-600 dark:text-red-300">{formError}</p>
            ) : null}
            <div className="flex flex-wrap gap-2 pt-2">
              <button type="button" onClick={() => setDialog(null)} className={ghostButton}>{messages.cancel}</button>
              <button type="submit" disabled={busy} className={primaryButton}>
                {busy ? messages.submitting : messages.confirm}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}

function ComparisonPanel({
  messages,
  comparison,
  onClose,
}: {
  messages: Messages;
  comparison: QuotationComparison;
  onClose: () => void;
}) {
  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-extrabold text-slate-950 dark:text-white">{messages.comparisonTitle}</h2>
        <button type="button" onClick={onClose} className={ghostButton}>{messages.close}</button>
      </div>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{messages.comparisonNeutralNote}</p>

      <dl className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          [messages.comparableQuotations, String(comparison.totals.comparableQuotationCount)],
          [messages.lowestTotal, formatMoneyAmount(comparison.totals.lowestTotalAmount, comparison.totals.currency)],
          [messages.highestTotal, formatMoneyAmount(comparison.totals.highestTotalAmount, comparison.totals.currency)],
          [messages.totalSpread, formatMoneyAmount(comparison.totals.spreadAmount, comparison.totals.currency)],
        ].map(([label, value]) => (
          <div key={label} className={panel}>
            <dt className="text-xs font-bold text-slate-400">{label}</dt>
            <dd className="mt-1 text-lg font-extrabold text-slate-950 dark:text-white" dir="ltr">{value}</dd>
          </div>
        ))}
      </dl>

      {comparison.matrix.length === 0 ? (
        <p className="mt-4 text-sm font-bold text-slate-500">{messages.comparisonEmpty}</p>
      ) : (
        /* Tablet keeps the request-line column visible while the supplier
           columns scroll, so context is never lost. */
        <div className="mt-4 overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-start text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:bg-white/5">
              <tr>
                <th className="sticky start-0 z-10 bg-slate-50 px-4 py-3 text-start dark:bg-[#0d1b30]">
                  {messages.lineItem}
                </th>
                {comparison.quotations.map((quotation) => (
                  <th key={quotation.id} className="min-w-[10rem] px-4 py-3 text-start">
                    <div className="font-extrabold text-slate-700 dark:text-slate-200">{quotation.vendorNameSnapshot}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {quotation.isSelected ? (
                        <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-extrabold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200">
                          {messages.quotationSelected}
                        </span>
                      ) : null}
                      {quotation.validityExpired ? (
                        <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-extrabold text-amber-900 dark:bg-amber-500/15 dark:text-amber-100">
                          {messages.quotationExpired}
                        </span>
                      ) : null}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparison.matrix.map((row) => (
                <tr key={row.requestLineId} className="border-t border-slate-100 dark:border-white/10">
                  <th scope="row" className="sticky start-0 z-10 bg-white px-4 py-3 text-start font-extrabold text-slate-950 dark:bg-[#0b1a31] dark:text-white">
                    {row.description}
                    <div className="mt-1 text-xs font-bold text-slate-400" dir="ltr">
                      {formatQuantity(row.requestedQuantity)} {row.unit}
                    </div>
                  </th>
                  {row.cells.map((cell) => (
                    <td key={`${row.requestLineId}-${cell.quotationId}`} className="px-4 py-3 align-top">
                      {cell.quoted ? (
                        <div dir="ltr">
                          <div className="font-extrabold text-slate-900 dark:text-white">
                            {formatMoneyAmount(cell.lineTotal, comparison.totals.currency)}
                          </div>
                          <div className="mt-1 text-xs font-semibold text-slate-500 dark:text-slate-400">
                            {formatQuantity(cell.quantity)} × {formatMoneyAmount(cell.unitPrice, comparison.totals.currency)}
                          </div>
                          {cell.leadTimeDays != null ? (
                            <div className="mt-1 text-xs text-slate-400">
                              {messages.leadTimeDays}: {cell.leadTimeDays}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-xs font-bold text-slate-400">{messages.notQuoted}</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t-2 border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/5">
                <th scope="row" className="sticky start-0 z-10 bg-slate-50 px-4 py-3 text-start font-extrabold dark:bg-[#0d1b30]">
                  {messages.amount}
                </th>
                {comparison.quotations.map((quotation) => (
                  <td key={`total-${quotation.id}`} className="px-4 py-3 font-extrabold text-slate-950 dark:text-white" dir="ltr">
                    {formatMoneyAmount(quotation.totalAmount, quotation.currency)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function QuotationDialog({
  locale,
  messages,
  request,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  locale: Locale;
  messages: Messages;
  request: PurchaseRequestRecord;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: Parameters<typeof purchasingApi.createQuotation>[1]) => Promise<void>;
}) {
  const [vendors, setVendors] = useState<Array<{ id: string; name: string }>>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const page = await purchasingApi.listVendors({ status: 'active', pageSize: 100 });
        setVendors(page.items.map((vendor) => ({ id: vendor.id, name: vendor.name })));
      } catch {
        setVendors([]);
      }
    })();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const lines = request.lines
      .map((line) => ({
        requestLineId: line.id,
        description: line.description,
        category: line.category,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: (prices[line.id] ?? '').trim(),
      }))
      .filter((line) => line.unitPrice !== '');
    if (lines.length === 0) {
      setLocalError(messages.selectAtLeastOneLine);
      return;
    }
    if (lines.some((line) => !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(line.unitPrice))) {
      setLocalError(messages.invalidAmount);
      return;
    }
    setLocalError(null);
    const leadTime = String(form.get('leadTimeDays') ?? '').trim();
    await onSubmit({
      vendorId: String(form.get('vendorId') ?? ''),
      supplierReference: String(form.get('supplierReference') ?? '').trim() || null,
      quotationDate: String(form.get('quotationDate') ?? '') || null,
      validUntilDate: String(form.get('validUntilDate') ?? '') || null,
      expectedDeliveryDate: String(form.get('expectedDeliveryDate') ?? '') || null,
      leadTimeDays: leadTime === '' ? null : Number(leadTime),
      paymentTerms: String(form.get('paymentTerms') ?? '').trim() || null,
      notes: null,
      lines,
    });
  };

  return (
    <Dialog messages={messages} title={messages.createQuotationTitle} onClose={onClose} wide>
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-bold text-slate-600 dark:text-slate-300">
            {messages.supplier}
            <select name="vendorId" required className={`${inputClass} mt-1`}>
              <option value="">—</option>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>{vendor.name}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-bold text-slate-600 dark:text-slate-300">
            {messages.supplierReference}
            <input name="supplierReference" maxLength={120} className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-sm font-bold text-slate-600 dark:text-slate-300">
            {messages.quotationDate}
            <input type="date" name="quotationDate" className={`${inputClass} mt-1`} dir="ltr" />
          </label>
          <label className="block text-sm font-bold text-slate-600 dark:text-slate-300">
            {messages.validUntil}
            <input type="date" name="validUntilDate" className={`${inputClass} mt-1`} dir="ltr" />
          </label>
          <label className="block text-sm font-bold text-slate-600 dark:text-slate-300">
            {messages.expectedDelivery}
            <input type="date" name="expectedDeliveryDate" className={`${inputClass} mt-1`} dir="ltr" />
          </label>
          <label className="block text-sm font-bold text-slate-600 dark:text-slate-300">
            {messages.leadTimeDays}
            <input type="number" min={0} max={3650} name="leadTimeDays" className={`${inputClass} mt-1`} dir="ltr" />
          </label>
          <label className="block text-sm font-bold text-slate-600 dark:text-slate-300 sm:col-span-2">
            {messages.paymentTerms}
            <input name="paymentTerms" maxLength={300} className={`${inputClass} mt-1`} />
          </label>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-white/10">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs font-extrabold uppercase text-slate-400 dark:bg-white/5">
              <tr>
                <th className="px-3 py-2 text-start">{messages.lineItem}</th>
                <th className="px-3 py-2 text-start">{messages.quantity}</th>
                <th className="px-3 py-2 text-start">{messages.unitPrice}</th>
              </tr>
            </thead>
            <tbody>
              {request.lines.map((line) => (
                <tr key={line.id} className="border-t border-slate-100 dark:border-white/10">
                  <td className="px-3 py-2 font-semibold">{line.description}</td>
                  <td className="px-3 py-2" dir="ltr">{formatQuantity(line.quantity)} {line.unit}</td>
                  <td className="px-3 py-2">
                    <input
                      inputMode="decimal"
                      dir="ltr"
                      value={prices[line.id] ?? ''}
                      onChange={(event) => setPrices((current) => ({ ...current, [line.id]: event.target.value }))}
                      placeholder="0.00"
                      className={inputClass}
                      aria-label={`${messages.unitPrice} — ${line.description}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {(localError ?? error) ? (
          <p role="alert" className="text-sm font-bold text-red-600 dark:text-red-300">{localError ?? error}</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onClose} className={ghostButton}>{messages.cancel}</button>
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? messages.submitting : messages.addQuotation}
          </button>
        </div>
        <p className="text-xs text-slate-400" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
          {messages.comparisonNeutralNote}
        </p>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Purchase order detail: receipt progress, partial receipt, returns
// ---------------------------------------------------------------------------

function OrderDetail({
  messages,
  order,
  canReceive,
  canOverride,
  canRaiseReturn,
  canReviewReturn,
  onBack,
  formatDate,
}: {
  messages: Messages;
  order: PurchaseOrderRecord;
  canReceive: boolean;
  canOverride: boolean;
  canRaiseReturn: boolean;
  canReviewReturn: boolean;
  onBack: () => void;
  formatDate: (value: string | null | undefined) => string;
}) {
  const [phase, setPhase] = useState<ResourcePhase>('loading');
  const [progress, setProgress] = useState<OrderReceiptProgress | null>(null);
  const [receipts, setReceipts] = useState<ReceiptRecord[]>([]);
  const [returns, setReturns] = useState<PurchaseReturnRecord[]>([]);
  const [dialog, setDialog] = useState<'receipt' | 'return' | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const guard = useRef(createLatestRequestGuard());

  const load = useCallback(async () => {
    const requestId = guard.current.begin();
    setPhase('loading');
    try {
      const [receiptPage, returnPage] = await Promise.all([
        purchasingApi.listReceipts(order.id),
        purchasingApi.listReturns(order.id),
      ]);
      if (!guard.current.isCurrent(requestId)) return;
      setReceipts(receiptPage.items);
      setProgress(receiptPage.progress);
      setReturns(returnPage.items);
      setPhase('ready');
    } catch (error) {
      if (!guard.current.isCurrent(requestId)) return;
      setPhase(errorPhase(error));
    }
  }, [order.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setFormError(null);
    try {
      await action();
      setDialog(null);
      await load();
    } catch (error) {
      setFormError(actionMessage(error, messages));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl">
      <button type="button" onClick={onBack} className={ghostButton}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {messages.backToList}
      </button>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-950 dark:text-white" dir="ltr">{order.orderNumber}</h1>
          <p className="mt-1 text-sm font-semibold text-slate-600 dark:text-slate-300">{order.vendorNameSnapshot}</p>
          <div className="mt-2"><StatusChip status={order.status} /></div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canReceive && progress && !progress.fullyReceived ? (
            <>
              <button type="button" onClick={() => { setFormError(null); setDialog('receipt'); }} className={primaryButton}>
                <PackageCheck className="h-4 w-4" aria-hidden="true" />
                {messages.recordReceipt}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runAction(() => purchasingApi.receiveWholeOrder(order.id, null))}
                className={ghostButton}
              >
                {messages.receiveAllRemaining}
              </button>
            </>
          ) : null}
          {canRaiseReturn && progress?.anyReceived ? (
            <button type="button" onClick={() => { setFormError(null); setDialog('return'); }} className={ghostButton}>
              <Undo2 className="h-4 w-4" aria-hidden="true" />
              {messages.createReturn}
            </button>
          ) : null}
        </div>
      </div>

      {formError ? (
        <p role="alert" className="mt-4 text-sm font-bold text-red-600 dark:text-red-300">{formError}</p>
      ) : null}

      {phase !== 'ready' ? (
        <ResourceState
          phase={phase}
          messages={messages}
          emptyMessage={messages.purchasingEmpty}
          errorMessage={messages.purchasingError}
          forbiddenMessage={messages.purchasingForbidden}
          onRetry={() => void load()}
        />
      ) : (
        <>
          <h2 className="mt-8 text-lg font-extrabold text-slate-950 dark:text-white">{messages.receiptProgress}</h2>
          <div className="mt-4 overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-start text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:bg-white/5">
                <tr>
                  <th className="px-4 py-3 text-start">{messages.lineItem}</th>
                  <th className="px-4 py-3 text-start">{messages.orderedQuantity}</th>
                  <th className="px-4 py-3 text-start">{messages.receivedQuantity}</th>
                  <th className="px-4 py-3 text-start">{messages.returnedQuantity}</th>
                  <th className="px-4 py-3 text-start">{messages.netReceived}</th>
                  <th className="px-4 py-3 text-start">{messages.remainingQuantity}</th>
                </tr>
              </thead>
              <tbody>
                {(progress?.lines ?? []).map((line) => (
                  <tr key={line.purchaseOrderLineId} className="border-t border-slate-100 dark:border-white/10">
                    <td className="px-4 py-3 font-extrabold text-slate-950 dark:text-white">
                      {line.descriptionSnapshot}
                      <div className="mt-1 h-1.5 w-32 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                        <div
                          className="h-full rounded-full bg-brand-600"
                          style={{ width: `${receivedPercent(line.netReceivedQuantity, line.orderedQuantity)}%` }}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3" dir="ltr">{formatQuantity(line.orderedQuantity)} {line.unitSnapshot}</td>
                    <td className="px-4 py-3" dir="ltr">{formatQuantity(line.receivedQuantity)}</td>
                    <td className="px-4 py-3" dir="ltr">{formatQuantity(line.returnedQuantity)}</td>
                    <td className="px-4 py-3 font-semibold" dir="ltr">{formatQuantity(line.netReceivedQuantity)}</td>
                    <td className="px-4 py-3 font-extrabold" dir="ltr">{formatQuantity(line.remainingQuantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="mt-8 text-lg font-extrabold text-slate-950 dark:text-white">{messages.receiptHistory}</h2>
          <div className="mt-4 grid gap-3">
            {receipts.length === 0 ? (
              <p className="text-sm font-bold text-slate-500">{messages.purchasingEmpty}</p>
            ) : (
              receipts.map((receipt) => (
                <article key={receipt.id} className={panel}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-extrabold text-slate-950 dark:text-white" dir="ltr">{receipt.receiptNumber}</span>
                    <span className="text-xs font-bold text-slate-400">{formatDate(receipt.receivedAt)}</span>
                  </div>
                  <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                    {receipt.receivedBy?.name ?? '—'}
                    {receipt.overrideApplied ? (
                      <span className="ms-2 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-extrabold text-amber-900 dark:bg-amber-500/15 dark:text-amber-100">
                        {messages.overrideApplied}
                      </span>
                    ) : null}
                  </div>
                </article>
              ))
            )}
          </div>

          <h2 className="mt-8 text-lg font-extrabold text-slate-950 dark:text-white">{messages.returns}</h2>
          <p className="mt-1 text-xs text-slate-400">{messages.returnSegregationNote}</p>
          <div className="mt-4 grid gap-3">
            {returns.length === 0 ? (
              <p className="text-sm font-bold text-slate-500">{messages.returnsEmpty}</p>
            ) : (
              returns.map((row) => (
                <article key={row.id} className={panel}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-extrabold text-slate-950 dark:text-white" dir="ltr">{row.returnNumber}</span>
                    <StatusChip status={row.status} />
                  </div>
                  <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                    {returnReasonLabel(row.reasonCode, messages)} · {formatDate(row.createdAt)}
                  </div>
                  {canReviewReturn && row.status === 'pending_approval' ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void runAction(() => purchasingApi.reviewReturn(row.id, 'approve'))}
                        className={primaryButton}
                      >
                        {messages.approveReturn}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void runAction(() =>
                            purchasingApi.reviewReturn(row.id, 'reject', messages.rejectReturn),
                          )
                        }
                        className={ghostButton}
                      >
                        {messages.rejectReturn}
                      </button>
                    </div>
                  ) : null}
                </article>
              ))
            )}
          </div>
        </>
      )}

      {dialog === 'receipt' && progress ? (
        <ReceiptDialog
          messages={messages}
          progress={progress}
          canOverride={canOverride}
          busy={busy}
          error={formError}
          onClose={() => setDialog(null)}
          onSubmit={(input) => runAction(() => purchasingApi.recordReceipt(order.id, input))}
        />
      ) : null}

      {dialog === 'return' && progress ? (
        <ReturnDialog
          messages={messages}
          progress={progress}
          busy={busy}
          error={formError}
          onClose={() => setDialog(null)}
          onSubmit={(input) => runAction(() => purchasingApi.createReturn(order.id, input))}
        />
      ) : null}
    </div>
  );
}

function ReceiptDialog({
  messages,
  progress,
  canOverride,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  messages: Messages;
  progress: OrderReceiptProgress;
  canOverride: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: Parameters<typeof purchasingApi.recordReceipt>[1]) => Promise<void>;
}) {
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideConfirmation, setOverrideConfirmation] = useState('');

  const entered = progress.lines
    .map((line) => ({ line, value: (quantities[line.purchaseOrderLineId] ?? '').trim() }))
    .filter((entry) => entry.value !== '');
  const needsOverride = entered.some((entry) => exceedsRemaining(entry.value, entry.line.remainingQuantity));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (entered.length === 0) {
      setLocalError(messages.selectAtLeastOneLine);
      return;
    }
    if (entered.some((entry) => !isPositiveQuantity(entry.value))) {
      setLocalError(messages.invalidQuantity);
      return;
    }
    if (needsOverride && (!canOverride || overrideConfirmation !== 'OVERRIDE' || !overrideReason.trim())) {
      setLocalError(messages.quantityExceedsRemaining);
      return;
    }
    setLocalError(null);
    await onSubmit({
      lines: entered.map((entry) => ({
        purchaseOrderLineId: entry.line.purchaseOrderLineId,
        quantity: entry.value,
      })),
      ...(needsOverride
        ? { override: { confirmation: 'OVERRIDE' as const, reason: overrideReason.trim() } }
        : {}),
    });
  };

  return (
    <Dialog messages={messages} title={messages.recordReceiptTitle} onClose={onClose} wide>
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-white/10">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs font-extrabold uppercase text-slate-400 dark:bg-white/5">
              <tr>
                <th className="px-3 py-2 text-start">{messages.lineItem}</th>
                <th className="px-3 py-2 text-start">{messages.remainingQuantity}</th>
                <th className="px-3 py-2 text-start">{messages.receivedQuantity}</th>
              </tr>
            </thead>
            <tbody>
              {progress.lines.map((line) => (
                <tr key={line.purchaseOrderLineId} className="border-t border-slate-100 dark:border-white/10">
                  <td className="px-3 py-2 font-semibold">{line.descriptionSnapshot}</td>
                  <td className="px-3 py-2" dir="ltr">{formatQuantity(line.remainingQuantity)} {line.unitSnapshot}</td>
                  <td className="px-3 py-2">
                    <input
                      inputMode="decimal"
                      dir="ltr"
                      value={quantities[line.purchaseOrderLineId] ?? ''}
                      onChange={(event) =>
                        setQuantities((current) => ({ ...current, [line.purchaseOrderLineId]: event.target.value }))
                      }
                      placeholder="0.000"
                      className={inputClass}
                      aria-label={`${messages.receivedQuantity} — ${line.descriptionSnapshot}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {needsOverride ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/20 dark:bg-amber-500/10">
            <p className="text-sm font-extrabold text-amber-900 dark:text-amber-100">{messages.overReceiptTitle}</p>
            <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">{messages.overReceiptHint}</p>
            {canOverride ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block text-sm font-bold">
                  {messages.overReceiptConfirm}
                  <input
                    value={overrideConfirmation}
                    onChange={(event) => setOverrideConfirmation(event.target.value)}
                    className={`${inputClass} mt-1`}
                    dir="ltr"
                  />
                </label>
                <label className="block text-sm font-bold">
                  {messages.overReceiptReason}
                  <input
                    value={overrideReason}
                    onChange={(event) => setOverrideReason(event.target.value)}
                    maxLength={500}
                    className={`${inputClass} mt-1`}
                  />
                </label>
              </div>
            ) : null}
          </div>
        ) : null}

        {(localError ?? error) ? (
          <p role="alert" className="text-sm font-bold text-red-600 dark:text-red-300">{localError ?? error}</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onClose} className={ghostButton}>{messages.cancel}</button>
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? messages.submitting : messages.recordReceipt}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ReturnDialog({
  messages,
  progress,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  messages: Messages;
  progress: OrderReceiptProgress;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: Parameters<typeof purchasingApi.createReturn>[1]) => Promise<void>;
}) {
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reasonCode, setReasonCode] = useState<ReturnReasonCode>('damaged');
  const [localError, setLocalError] = useState<string | null>(null);

  const returnable = progress.lines.filter((line) => line.netReceivedQuantity !== '0.000');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const entered = returnable
      .map((line) => ({ line, value: (quantities[line.purchaseOrderLineId] ?? '').trim() }))
      .filter((entry) => entry.value !== '');
    if (entered.length === 0) {
      setLocalError(messages.selectAtLeastOneLine);
      return;
    }
    if (entered.some((entry) => !isPositiveQuantity(entry.value))) {
      setLocalError(messages.invalidQuantity);
      return;
    }
    if (entered.some((entry) => exceedsRemaining(entry.value, entry.line.netReceivedQuantity))) {
      setLocalError(messages.quantityExceedsRemaining);
      return;
    }
    setLocalError(null);
    await onSubmit({
      reasonCode,
      lines: entered.map((entry) => ({
        purchaseOrderLineId: entry.line.purchaseOrderLineId,
        quantity: entry.value,
      })),
    });
  };

  return (
    <Dialog messages={messages} title={messages.createReturnTitle} onClose={onClose} wide>
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <label className="block text-sm font-bold text-slate-600 dark:text-slate-300">
          {messages.returnReason}
          <select
            value={reasonCode}
            onChange={(event) => setReasonCode(event.target.value as ReturnReasonCode)}
            className={`${inputClass} mt-1`}
          >
            {RETURN_REASON_CODES.map((code) => (
              <option key={code} value={code}>{returnReasonLabel(code, messages)}</option>
            ))}
          </select>
        </label>

        <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-white/10">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs font-extrabold uppercase text-slate-400 dark:bg-white/5">
              <tr>
                <th className="px-3 py-2 text-start">{messages.lineItem}</th>
                <th className="px-3 py-2 text-start">{messages.netReceived}</th>
                <th className="px-3 py-2 text-start">{messages.returnedQuantity}</th>
              </tr>
            </thead>
            <tbody>
              {returnable.map((line) => (
                <tr key={line.purchaseOrderLineId} className="border-t border-slate-100 dark:border-white/10">
                  <td className="px-3 py-2 font-semibold">{line.descriptionSnapshot}</td>
                  <td className="px-3 py-2" dir="ltr">{formatQuantity(line.netReceivedQuantity)} {line.unitSnapshot}</td>
                  <td className="px-3 py-2">
                    <input
                      inputMode="decimal"
                      dir="ltr"
                      value={quantities[line.purchaseOrderLineId] ?? ''}
                      onChange={(event) =>
                        setQuantities((current) => ({ ...current, [line.purchaseOrderLineId]: event.target.value }))
                      }
                      placeholder="0.000"
                      className={inputClass}
                      aria-label={`${messages.returnedQuantity} — ${line.descriptionSnapshot}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {(localError ?? error) ? (
          <p role="alert" className="text-sm font-bold text-red-600 dark:text-red-300">{localError ?? error}</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onClose} className={ghostButton}>{messages.cancel}</button>
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? messages.submitting : messages.createReturn}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Dialog({
  messages,
  title,
  onClose,
  wide,
  children,
}: {
  messages: Messages;
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-950/50 p-4 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${wide ? 'max-w-3xl' : 'max-w-md'} rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#0b1a31] sm:p-6`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-extrabold text-slate-950 dark:text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-200"
            aria-label={messages.close}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
