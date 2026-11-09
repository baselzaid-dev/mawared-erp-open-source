import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { ApiError } from '@/api/client';
import { ResourceState, type ResourcePhase } from '@/components/ResourceState';
import { financeApi } from '@/finance/api';
import type { ChartOfAccountRecord } from '@/finance/types';
import type { Locale, Messages } from '@/i18n';
import { payrollApi } from '@/payroll/api';
import {
  createIdempotencyKey,
  formatMoneyAmount,
  normalizeMoneyInput,
  payrollReopenConfirmationPhrase,
} from '@/payroll/money';
import type {
  AdjustPreviewResponse,
  PayrollItemRecord,
  PayrollItemsResponse,
  PayrollPeriodRecord,
} from '@/payroll/types';
import {
  canAdjustPayroll,
  canApprovePayroll,
  canManagePayroll,
  canPostPayrollToLedger,
  canReopenPayroll,
  canViewPayroll,
} from '@/permissions';
import { createLatestRequestGuard } from './latestRequestGuard';

const itemsGuard = createLatestRequestGuard();

function periodStatusLabel(status: string, messages: Messages): string {
  switch (status) {
    case 'draft':
      return messages.periodDraft;
    case 'calculated':
      return messages.periodCalculated;
    case 'approved':
      return messages.periodApproved;
    case 'paid':
      return messages.periodPaid;
    default:
      return status;
  }
}

function actionErrorMessage(error: unknown, messages: Messages): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return messages.conflictError;
    if (error.status === 400 || error.status === 422) return messages.validationError;
    if (error.status === 403) return messages.payrollForbidden;
  }
  return messages.actionError;
}

export function PayrollPage({
  locale,
  messages,
  permissions,
}: {
  locale: Locale;
  messages: Messages;
  permissions: readonly string[];
}) {
  void locale;
  const canView = canViewPayroll(permissions);
  const canManage = canManagePayroll(permissions);
  const canApprove = canApprovePayroll(permissions);
  const canAdjust = canAdjustPayroll(permissions);
  const canReopen = canReopenPayroll(permissions);
  const canPostLedger = canPostPayrollToLedger(permissions);

  const [periods, setPeriods] = useState<PayrollPeriodRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PayrollItemsResponse | null>(null);
  const [accounts, setAccounts] = useState<ChartOfAccountRecord[]>([]);
  const [phase, setPhase] = useState<ResourcePhase>(canView ? 'loading' : 'forbidden');
  const [detailPhase, setDetailPhase] = useState<ResourcePhase>('empty');
  const [busy, setBusy] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createMonth, setCreateMonth] = useState(new Date().getUTCMonth() + 1);
  const [createYear, setCreateYear] = useState(new Date().getUTCFullYear());

  const [reasonOpen, setReasonOpen] = useState<'recalculate' | 'reopen' | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [reopenConfirmed, setReopenConfirmed] = useState(false);
  const [reopenPhraseInput, setReopenPhraseInput] = useState('');

  const [adjustItem, setAdjustItem] = useState<PayrollItemRecord | null>(null);
  const [adjustDirection, setAdjustDirection] = useState<'allowance' | 'deduction'>('allowance');
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustPreview, setAdjustPreview] = useState<AdjustPreviewResponse | null>(null);
  const adjustIdempotencyKeyRef = useRef<string | null>(null);

  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [expenseAccountId, setExpenseAccountId] = useState('');
  const [payableAccountId, setPayableAccountId] = useState('');
  const [deductionAccountId, setDeductionAccountId] = useState('');

  const selectedPeriod =
    detail?.period ?? periods.find((period) => period.id === selectedId) ?? null;

  const loadPeriods = useCallback(async () => {
    if (!canView) {
      setPhase('forbidden');
      return;
    }
    setPhase('loading');
    setErrorMessage(null);
    try {
      const rows = await payrollApi.listPeriods();
      setPeriods(rows);
      setPhase(rows.length === 0 ? 'empty' : 'ready');
      if (selectedId && !rows.some((row) => row.id === selectedId)) {
        setSelectedId(null);
        setDetail(null);
        setDetailPhase('empty');
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setPhase('forbidden');
        return;
      }
      setPhase('error');
    }
  }, [canView, selectedId]);

  const loadDetail = useCallback(async (periodId: string) => {
    const requestId = itemsGuard.begin();
    setDetailPhase('loading');
    try {
      const payload = await payrollApi.getPeriodItems(periodId);
      if (!itemsGuard.isCurrent(requestId)) return;
      setDetail(payload);
      setDetailPhase(payload.items.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (!itemsGuard.isCurrent(requestId)) return;
      if (error instanceof ApiError && error.status === 403) {
        setDetailPhase('forbidden');
        return;
      }
      setDetailPhase('error');
    }
  }, []);

  useEffect(() => {
    void loadPeriods();
  }, [loadPeriods]);

  useEffect(() => {
    if (!selectedId) {
      itemsGuard.invalidate();
      setDetail(null);
      setDetailPhase('empty');
      return;
    }
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  const expenseAccounts = useMemo(
    () => accounts.filter((row) => row.status === 'active' && row.type === 'Expense'),
    [accounts],
  );
  const liabilityAccounts = useMemo(
    () => accounts.filter((row) => row.status === 'active' && row.type === 'Liability'),
    [accounts],
  );

  const summary = detail?.fullSummary ?? detail?.visibleSummary ?? selectedPeriod?.visibleSummary;

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      await action();
      setSuccessMessage(messages.actionSuccess);
      await loadPeriods();
      if (selectedId) await loadDetail(selectedId);
    } catch (error) {
      setErrorMessage(actionErrorMessage(error, messages));
      if (error instanceof ApiError && error.status === 409 && selectedId) {
        await loadPeriods();
        await loadDetail(selectedId);
      }
    } finally {
      setBusy(false);
    }
  };

  const onCreatePeriod = async (event: FormEvent) => {
    event.preventDefault();
    await runAction(async () => {
      const created = await payrollApi.createPeriod({ month: createMonth, year: createYear });
      setCreateOpen(false);
      setSelectedId(created.id);
    });
  };

  const onCalculate = async () => {
    if (!selectedPeriod) return;
    if (selectedPeriod.status === 'calculated') {
      setReasonText('');
      setReasonOpen('recalculate');
      return;
    }
    await runAction(async () => {
      await payrollApi.calculatePeriod(selectedPeriod.id);
    });
  };

  const onConfirmRecalculate = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedPeriod || !reasonText.trim()) return;
    await runAction(async () => {
      await payrollApi.calculatePeriod(selectedPeriod.id, {
        recalculationReason: reasonText.trim(),
      });
      setReasonOpen(null);
      setReasonText('');
    });
  };

  const onApprove = async () => {
    if (!selectedPeriod) return;
    await runAction(async () => {
      await payrollApi.approvePeriod(selectedPeriod.id);
    });
  };

  const expectedReopenPhrase = selectedPeriod
    ? payrollReopenConfirmationPhrase(selectedPeriod.year, selectedPeriod.month)
    : '';

  const onConfirmReopen = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !selectedPeriod
      || !reasonText.trim()
      || !reopenConfirmed
      || reopenPhraseInput.trim() !== expectedReopenPhrase
    ) {
      return;
    }
    await runAction(async () => {
      await payrollApi.reopenPeriod(selectedPeriod.id, {
        reason: reasonText.trim(),
        confirm: true,
        confirmationPhrase: reopenPhraseInput.trim(),
      });
      setReasonOpen(null);
      setReasonText('');
      setReopenConfirmed(false);
      setReopenPhraseInput('');
    });
  };

  const openLedgerDialog = async () => {
    setLedgerOpen(true);
    setExpenseAccountId('');
    setPayableAccountId('');
    setDeductionAccountId('');
    try {
      const rows = await financeApi.listAccounts();
      setAccounts(rows);
    } catch {
      setAccounts([]);
    }
  };

  const onPostToLedger = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedPeriod || !expenseAccountId || !payableAccountId) return;
    await runAction(async () => {
      await payrollApi.postToLedger(selectedPeriod.id, {
        expenseAccountId,
        payableAccountId,
        ...(deductionAccountId ? { deductionAccountId } : {}),
      });
      setLedgerOpen(false);
    });
  };

  const onPreviewAdjust = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedPeriod || !adjustItem) return;
    const amount = normalizeMoneyInput(adjustAmount);
    if (!amount || !adjustReason.trim()) {
      setErrorMessage(messages.validationError);
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    try {
      const preview = await payrollApi.previewAdjustment(selectedPeriod.id, adjustItem.id, {
        direction: adjustDirection,
        amount,
        reason: adjustReason.trim(),
      });
      setAdjustPreview(preview);
    } catch (error) {
      setErrorMessage(actionErrorMessage(error, messages));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    // New confirmation intent when the adjustment payload changes.
    adjustIdempotencyKeyRef.current = null;
  }, [adjustItem?.id, adjustDirection, adjustAmount, adjustReason]);

  const onConfirmAdjust = async () => {
    if (!selectedPeriod || !adjustItem) return;
    const amount = normalizeMoneyInput(adjustAmount);
    if (!amount || !adjustReason.trim()) return;
    if (!adjustIdempotencyKeyRef.current) {
      adjustIdempotencyKeyRef.current = createIdempotencyKey('payroll-adjust');
    }
    const idempotencyKey = adjustIdempotencyKeyRef.current;
    await runAction(async () => {
      await payrollApi.applyAdjustment(
        selectedPeriod.id,
        adjustItem.id,
        {
          direction: adjustDirection,
          amount,
          reason: adjustReason.trim(),
        },
        idempotencyKey,
      );
      adjustIdempotencyKeyRef.current = null;
      setAdjustItem(null);
      setAdjustPreview(null);
      setAdjustAmount('');
      setAdjustReason('');
    });
  };

  const canCalculate =
    canManage && selectedPeriod && (selectedPeriod.status === 'draft' || selectedPeriod.status === 'calculated');
  const canApproveAction = canApprove && selectedPeriod?.status === 'calculated';
  const canReopenAction =
    canReopen &&
    selectedPeriod?.status === 'approved' &&
    !selectedPeriod.paidAt &&
    !selectedPeriod.ledgerPostedAt;
  const canPostAction =
    canPostLedger &&
    selectedPeriod &&
    (selectedPeriod.status === 'approved' || selectedPeriod.status === 'paid') &&
    !selectedPeriod.ledgerPostedAt;
  const canAdjustAction = canAdjust && selectedPeriod?.status === 'calculated' && !selectedPeriod.ledgerPostedAt;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.payrollTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.payrollSubtitle}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage ? (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              disabled={busy || !canView}
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white shadow-lg shadow-brand-700/20 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {messages.createPeriod}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void loadPeriods()}
            disabled={phase === 'loading' || !canView || busy}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-extrabold text-slate-700 transition hover:border-brand-300 hover:text-brand-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {messages.refresh}
          </button>
        </div>
      </div>

      {successMessage ? (
        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-100">
          {successMessage}
        </div>
      ) : null}
      {errorMessage ? (
        <div role="alert" className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200">
          {errorMessage}
        </div>
      ) : null}

      {phase !== 'ready' ? (
        <ResourceState
          phase={phase === 'loading' || phase === 'empty' || phase === 'error' || phase === 'forbidden' ? phase : 'empty'}
          messages={messages}
          emptyMessage={messages.payrollEmpty}
          errorMessage={messages.payrollError}
          forbiddenMessage={messages.payrollForbidden}
          onRetry={() => void loadPeriods()}
        />
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-panel dark:border-white/10 dark:bg-white/5">
            <h2 className="text-sm font-extrabold text-slate-900 dark:text-white">{messages.payrollTitle}</h2>
            <ul className="mt-3 space-y-2">
              {periods.map((period) => {
                const active = period.id === selectedId;
                return (
                  <li key={period.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(period.id)}
                      className={`w-full rounded-2xl px-3 py-3 text-start transition ${
                        active
                          ? 'bg-brand-600 text-white'
                          : 'bg-slate-50 hover:bg-slate-100 dark:bg-white/5 dark:hover:bg-white/10'
                      }`}
                    >
                      <div className="text-sm font-extrabold" dir="ltr">
                        {String(period.month).padStart(2, '0')}/{period.year}
                      </div>
                      <div className={`mt-1 text-xs font-bold ${active ? 'text-white/80' : 'text-slate-500 dark:text-slate-400'}`}>
                        {periodStatusLabel(period.status, messages)}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-panel dark:border-white/10 dark:bg-white/5 sm:p-6">
            {!selectedPeriod ? (
              <p className="text-sm font-bold text-slate-500 dark:text-slate-400">{messages.selectPeriod}</p>
            ) : (
              <>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-lg font-extrabold text-slate-950 dark:text-white">
                      {messages.periodDetail}
                    </h2>
                    <p className="mt-1 text-sm font-bold text-slate-500 dark:text-slate-400" dir="ltr">
                      {String(selectedPeriod.month).padStart(2, '0')}/{selectedPeriod.year} ·{' '}
                      {periodStatusLabel(selectedPeriod.status, messages)} · v
                      {selectedPeriod.calculationVersion}
                    </p>
                    <p className="mt-1 text-xs font-bold text-slate-400">
                      {selectedPeriod.ledgerPostedAt ? messages.ledgerPosted : messages.ledgerNotPosted}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {canCalculate ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onCalculate()}
                        className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-extrabold disabled:opacity-50 dark:border-white/10"
                      >
                        {selectedPeriod.status === 'calculated' ? messages.recalculate : messages.calculate}
                      </button>
                    ) : null}
                    {canApproveAction ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onApprove()}
                        className="rounded-xl bg-brand-600 px-3 py-2 text-xs font-extrabold text-white disabled:opacity-50"
                      >
                        {messages.approvePeriod}
                      </button>
                    ) : null}
                    {canReopenAction ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setReasonText('');
                          setReopenConfirmed(false);
                          setReasonOpen('reopen');
                        }}
                        className="rounded-xl border border-amber-300 px-3 py-2 text-xs font-extrabold text-amber-800 disabled:opacity-50 dark:border-amber-500/40 dark:text-amber-200"
                      >
                        {messages.reopenPeriod}
                      </button>
                    ) : null}
                    {canPostAction ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void openLedgerDialog()}
                        className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-extrabold disabled:opacity-50 dark:border-white/10"
                      >
                        {messages.postToLedger}
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  {[
                    { label: messages.grossPay, value: summary?.visibleGross },
                    { label: messages.deductions, value: summary?.visibleDeductions },
                    { label: messages.netPay, value: summary?.visibleNet },
                  ].map((card) => (
                    <article
                      key={card.label}
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/5"
                    >
                      <div className="text-xs font-extrabold uppercase tracking-wider text-slate-400">
                        {card.label}
                      </div>
                      <div className="mt-2 text-lg font-extrabold text-slate-950 dark:text-white" dir="ltr">
                        {formatMoneyAmount(card.value ?? null, summary?.currency ?? 'SAR')}
                      </div>
                    </article>
                  ))}
                </div>

                {(detail?.protectedRowsHidden || selectedPeriod.protectedRowsHidden) ? (
                  <p className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">
                    {messages.protectedOwnerRows}
                    {detail?.protectedRowCount || selectedPeriod.protectedRowCount
                      ? ` (${detail?.protectedRowCount ?? selectedPeriod.protectedRowCount})`
                      : ''}
                  </p>
                ) : null}

                {detailPhase !== 'ready' ? (
                  <ResourceState
                    phase={detailPhase === 'loading' || detailPhase === 'empty' || detailPhase === 'error' || detailPhase === 'forbidden' ? detailPhase : 'empty'}
                    messages={messages}
                    emptyMessage={messages.payrollEmpty}
                    errorMessage={messages.payrollError}
                    forbiddenMessage={messages.payrollForbidden}
                    onRetry={() => selectedId && void loadDetail(selectedId)}
                  />
                ) : (
                  <>
                    <div className="mt-5 hidden overflow-x-auto md:block">
                      <table className="min-w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 text-start text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:border-white/10">
                            <th className="px-3 py-2">{messages.employeeName}</th>
                            <th className="px-3 py-2">{messages.employeeNumber}</th>
                            <th className="px-3 py-2">{messages.department}</th>
                            <th className="px-3 py-2">{messages.grossPay}</th>
                            <th className="px-3 py-2">{messages.deductions}</th>
                            <th className="px-3 py-2">{messages.netPay}</th>
                            {canAdjustAction ? <th className="px-3 py-2" /> : null}
                          </tr>
                        </thead>
                        <tbody>
                          {detail?.items.map((item) => (
                            <tr key={item.id} className="border-b border-slate-100 dark:border-white/5">
                              <td className="px-3 py-3 font-bold text-slate-900 dark:text-white">{item.employeeName}</td>
                              <td className="px-3 py-3 font-semibold text-slate-500" dir="ltr">{item.employeeNum}</td>
                              <td className="px-3 py-3 text-slate-500">{item.departmentName ?? messages.noDepartment}</td>
                              <td className="px-3 py-3 font-bold" dir="ltr">{formatMoneyAmount(item.grossPay, item.currency)}</td>
                              <td className="px-3 py-3 font-bold" dir="ltr">{formatMoneyAmount(item.totalDeductions, item.currency)}</td>
                              <td className="px-3 py-3 font-bold" dir="ltr">{formatMoneyAmount(item.netPay, item.currency)}</td>
                              {canAdjustAction ? (
                                <td className="px-3 py-3">
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => {
                                      setAdjustItem(item);
                                      setAdjustPreview(null);
                                      setAdjustAmount('');
                                      setAdjustReason('');
                                      setAdjustDirection('allowance');
                                    }}
                                    className="text-xs font-extrabold text-brand-700 disabled:opacity-50 dark:text-brand-300"
                                  >
                                    {messages.adjustItem}
                                  </button>
                                </td>
                              ) : null}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-5 space-y-3 md:hidden">
                      {detail?.items.map((item) => (
                        <article
                          key={item.id}
                          className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/5"
                        >
                          <div className="font-extrabold text-slate-900 dark:text-white">{item.employeeName}</div>
                          <div className="mt-1 text-xs font-bold text-slate-500" dir="ltr">{item.employeeNum}</div>
                          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                            <div>
                              <div className="font-bold text-slate-400">{messages.grossPay}</div>
                              <div className="font-extrabold" dir="ltr">{formatMoneyAmount(item.grossPay, item.currency)}</div>
                            </div>
                            <div>
                              <div className="font-bold text-slate-400">{messages.deductions}</div>
                              <div className="font-extrabold" dir="ltr">{formatMoneyAmount(item.totalDeductions, item.currency)}</div>
                            </div>
                            <div>
                              <div className="font-bold text-slate-400">{messages.netPay}</div>
                              <div className="font-extrabold" dir="ltr">{formatMoneyAmount(item.netPay, item.currency)}</div>
                            </div>
                          </div>
                          {canAdjustAction ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setAdjustItem(item);
                                setAdjustPreview(null);
                                setAdjustAmount('');
                                setAdjustReason('');
                              }}
                              className="mt-3 text-xs font-extrabold text-brand-700 disabled:opacity-50"
                            >
                              {messages.adjustItem}
                            </button>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        </div>
      )}

      {createOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
          <form
            role="dialog"
            aria-modal="true"
            onSubmit={(event) => void onCreatePeriod(event)}
            className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#0b182c]"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-extrabold">{messages.createPeriodTitle}</h3>
              <button type="button" onClick={() => setCreateOpen(false)} aria-label={messages.close}>
                <X className="h-5 w-5" />
              </button>
            </div>
            <label className="mt-4 block text-xs font-bold text-slate-400">
              {messages.periodMonth}
              <input
                type="number"
                min={1}
                max={12}
                required
                value={createMonth}
                onChange={(event) => setCreateMonth(Number(event.target.value))}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5"
              />
            </label>
            <label className="mt-3 block text-xs font-bold text-slate-400">
              {messages.periodYear}
              <input
                type="number"
                min={2020}
                max={2100}
                required
                value={createYear}
                onChange={(event) => setCreateYear(Number(event.target.value))}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5"
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setCreateOpen(false)} className="rounded-xl px-4 py-2.5 text-sm font-extrabold">
                {messages.cancel}
              </button>
              <button type="submit" disabled={busy} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
                {busy ? messages.processingAction : messages.create}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {reasonOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
          <form
            role="dialog"
            aria-modal="true"
            onSubmit={(event) => void (reasonOpen === 'recalculate' ? onConfirmRecalculate(event) : onConfirmReopen(event))}
            className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#0b182c]"
          >
            <h3 className="text-lg font-extrabold">
              {reasonOpen === 'recalculate' ? messages.recalculateReasonTitle : messages.reopenReasonTitle}
            </h3>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              {reasonOpen === 'recalculate' ? messages.recalculateReasonBody : messages.reopenReasonBody}
            </p>
            <label className="mt-4 block text-xs font-bold text-slate-400">
              {messages.reason}
              <textarea
                required
                maxLength={500}
                value={reasonText}
                onChange={(event) => setReasonText(event.target.value)}
                placeholder={messages.recalculateReasonPlaceholder}
                className="mt-1 min-h-24 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5"
              />
            </label>
            {reasonOpen === 'reopen' ? (
              <>
                <label className="mt-3 flex items-center gap-2 text-sm font-bold">
                  <input
                    type="checkbox"
                    checked={reopenConfirmed}
                    onChange={(event) => setReopenConfirmed(event.target.checked)}
                  />
                  {messages.reopenConfirm}
                </label>
                <p className="mt-3 text-xs font-bold text-slate-500 dark:text-slate-400">
                  {messages.reopenPhraseHint}:{' '}
                  <span className="font-mono text-slate-800 dark:text-slate-100" dir="ltr">
                    {expectedReopenPhrase}
                  </span>
                </p>
                <label className="mt-2 block text-xs font-bold text-slate-400">
                  {messages.reopenPhraseLabel}
                  <input
                    required
                    value={reopenPhraseInput}
                    onChange={(event) => setReopenPhraseInput(event.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 font-mono text-sm font-semibold dark:border-white/10 dark:bg-white/5"
                    dir="ltr"
                    autoComplete="off"
                    aria-label={messages.reopenPhraseLabel}
                  />
                </label>
              </>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setReasonOpen(null);
                  setReasonText('');
                  setReopenConfirmed(false);
                  setReopenPhraseInput('');
                }}
                className="rounded-xl px-4 py-2.5 text-sm font-extrabold"
              >
                {messages.cancel}
              </button>
              <button
                type="submit"
                disabled={
                  busy
                  || !reasonText.trim()
                  || (
                    reasonOpen === 'reopen'
                    && (
                      !reopenConfirmed
                      || reopenPhraseInput.trim() !== expectedReopenPhrase
                    )
                  )
                }
                className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
              >
                {busy ? messages.processingAction : messages.confirm}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {ledgerOpen && selectedPeriod ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
          <form
            role="dialog"
            aria-modal="true"
            onSubmit={(event) => void onPostToLedger(event)}
            className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#0b182c]"
          >
            <h3 className="text-lg font-extrabold">{messages.postToLedgerTitle}</h3>
            <label className="mt-4 block text-xs font-bold text-slate-400">
              {messages.expenseAccount}
              <select
                required
                value={expenseAccountId}
                onChange={(event) => setExpenseAccountId(event.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5"
              >
                <option value="">{messages.selectAccount}</option>
                {expenseAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-xs font-bold text-slate-400">
              {messages.payableAccount}
              <select
                required
                value={payableAccountId}
                onChange={(event) => setPayableAccountId(event.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5"
              >
                <option value="">{messages.selectAccount}</option>
                {liabilityAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-xs font-bold text-slate-400">
              {messages.deductionAccount}
              <select
                value={deductionAccountId}
                onChange={(event) => setDeductionAccountId(event.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5"
              >
                <option value="">{messages.selectAccount}</option>
                {liabilityAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setLedgerOpen(false)} className="rounded-xl px-4 py-2.5 text-sm font-extrabold">
                {messages.cancel}
              </button>
              <button type="submit" disabled={busy || !expenseAccountId || !payableAccountId} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
                {busy ? messages.processingAction : messages.postToLedger}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {adjustItem && selectedPeriod ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#0b182c]"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-extrabold">{messages.adjustItem}</h3>
              <button
                type="button"
                onClick={() => {
                  setAdjustItem(null);
                  setAdjustPreview(null);
                }}
                aria-label={messages.close}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-2 text-sm font-bold text-slate-500">{adjustItem.employeeName}</p>
            <form onSubmit={(event) => void onPreviewAdjust(event)} className="mt-4 space-y-3">
              <label className="block text-xs font-bold text-slate-400">
                {messages.adjustDirection}
                <select
                  value={adjustDirection}
                  onChange={(event) => setAdjustDirection(event.target.value as 'allowance' | 'deduction')}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5"
                >
                  <option value="allowance">{messages.adjustAllowance}</option>
                  <option value="deduction">{messages.adjustDeduction}</option>
                </select>
              </label>
              <label className="block text-xs font-bold text-slate-400">
                {messages.adjustAmount}
                <input
                  required
                  value={adjustAmount}
                  onChange={(event) => setAdjustAmount(event.target.value)}
                  placeholder="0.00"
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5"
                  dir="ltr"
                />
              </label>
              <label className="block text-xs font-bold text-slate-400">
                {messages.adjustReason}
                <textarea
                  required
                  maxLength={500}
                  value={adjustReason}
                  onChange={(event) => setAdjustReason(event.target.value)}
                  className="mt-1 min-h-20 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5"
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-extrabold disabled:opacity-50 dark:border-white/10"
              >
                {messages.adjustPreview}
              </button>
            </form>
            {adjustPreview ? (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm dark:border-white/10 dark:bg-white/5">
                {adjustPreview.redacted ? (
                  <p className="font-bold text-amber-700 dark:text-amber-200">{messages.protectedOwnerHint}</p>
                ) : (
                  <dl className="space-y-1 font-bold" dir="ltr">
                    <div>{messages.resultingGross}: {formatMoneyAmount(adjustPreview.resultingGross)}</div>
                    <div>{messages.resultingDeductions}: {formatMoneyAmount(adjustPreview.resultingDeductions)}</div>
                    <div>{messages.resultingNet}: {formatMoneyAmount(adjustPreview.resultingNet)}</div>
                  </dl>
                )}
                <p className="mt-2 text-xs text-slate-500">{messages.requiresRecalculation}</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onConfirmAdjust()}
                  className="mt-3 w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
                >
                  {busy ? messages.processingAction : messages.adjustConfirm}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
