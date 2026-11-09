import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { BookOpen, Plus, RefreshCw, X } from 'lucide-react';
import { ApiError } from '@/api/client';
import { ResourceState, type ResourcePhase } from '@/components/ResourceState';
import { financeApi } from '@/finance/api';
import { formatMoneyAmount, journalLinesBalanced, normalizeMoneyInput } from '@/finance/money';
import type {
  AccountType,
  ChartOfAccountRecord,
  CostCenterRecord,
  JournalEntryRecord,
  JournalLineInput,
} from '@/finance/types';
import type { Locale, Messages } from '@/i18n';
import {
  canApproveFinance,
  canCreateFinance,
  canManageFinance,
  canViewFinance,
} from '@/permissions';
import { createLatestRequestGuard } from './latestRequestGuard';

const journalGuard = createLatestRequestGuard();

type FinanceTab = 'accounts' | 'costCenters' | 'journals';

const ACCOUNT_TYPES: AccountType[] = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];

function actionErrorMessage(error: unknown, messages: Messages): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return messages.conflictError;
    if (error.status === 400 || error.status === 422) return messages.validationError;
    if (error.status === 403) return messages.financeForbidden;
  }
  return messages.actionError;
}

function journalStatusLabel(status: string, messages: Messages): string {
  switch (status) {
    case 'draft':
      return messages.journalDraft;
    case 'posted':
      return messages.journalPosted;
    case 'reversed':
      return messages.journalReversed;
    default:
      return status;
  }
}

function buildAccountTree(accounts: ChartOfAccountRecord[]): Array<ChartOfAccountRecord & { depth: number }> {
  const byParent = new Map<string | null, ChartOfAccountRecord[]>();
  for (const account of accounts) {
    const key = account.parentId;
    const list = byParent.get(key) ?? [];
    list.push(account);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.code.localeCompare(b.code));
  }
  const rows: Array<ChartOfAccountRecord & { depth: number }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const account of byParent.get(parentId) ?? []) {
      rows.push({ ...account, depth });
      walk(account.id, depth + 1);
    }
  };
  walk(null, 0);
  // Orphans (parent missing from set) still appear at root depth.
  const placed = new Set(rows.map((row) => row.id));
  for (const account of accounts) {
    if (!placed.has(account.id)) rows.push({ ...account, depth: 0 });
  }
  return rows;
}

function emptyLines(): JournalLineInput[] {
  return [
    { accountId: '', costCenterId: null, debit: '0.00', credit: '0.00', lineMemo: null },
    { accountId: '', costCenterId: null, debit: '0.00', credit: '0.00', lineMemo: null },
  ];
}

export function FinancePage({
  locale,
  messages,
  permissions,
}: {
  locale: Locale;
  messages: Messages;
  permissions: readonly string[];
}) {
  void locale;
  const canView = canViewFinance(permissions);
  const canCreate = canCreateFinance(permissions);
  const canManage = canManageFinance(permissions);
  const canApprove = canApproveFinance(permissions);

  const [tab, setTab] = useState<FinanceTab>('accounts');
  const [accounts, setAccounts] = useState<ChartOfAccountRecord[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenterRecord[]>([]);
  const [journals, setJournals] = useState<JournalEntryRecord[]>([]);
  const [selectedJournal, setSelectedJournal] = useState<JournalEntryRecord | null>(null);
  const [phase, setPhase] = useState<ResourcePhase>(canView ? 'loading' : 'forbidden');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [accountDialog, setAccountDialog] = useState<'create' | 'edit' | null>(null);
  const [editingAccount, setEditingAccount] = useState<ChartOfAccountRecord | null>(null);
  const [accountForm, setAccountForm] = useState({
    code: '',
    name: '',
    type: 'Asset' as AccountType,
    parentId: '',
  });

  const [costDialog, setCostDialog] = useState<'create' | 'edit' | null>(null);
  const [editingCost, setEditingCost] = useState<CostCenterRecord | null>(null);
  const [costForm, setCostForm] = useState({ code: '', name: '', description: '' });

  const [journalDialog, setJournalDialog] = useState<'create' | 'edit' | null>(null);
  const [journalForm, setJournalForm] = useState({
    entryDate: new Date().toISOString().slice(0, 10),
    reference: '',
    memo: '',
    lines: emptyLines(),
  });

  const load = useCallback(async () => {
    if (!canView) {
      setPhase('forbidden');
      return;
    }
    setPhase('loading');
    setErrorMessage(null);
    try {
      if (tab === 'accounts') {
        const rows = await financeApi.listAccounts();
        setAccounts(rows);
        setPhase(rows.length === 0 ? 'empty' : 'ready');
      } else if (tab === 'costCenters') {
        const rows = await financeApi.listCostCenters();
        setCostCenters(rows);
        setPhase(rows.length === 0 ? 'empty' : 'ready');
      } else {
        const rows = await financeApi.listJournalEntries();
        setJournals(rows);
        setPhase(rows.length === 0 ? 'empty' : 'ready');
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setPhase('forbidden');
        return;
      }
      setPhase('error');
    }
  }, [canView, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      await action();
      setSuccessMessage(messages.actionSuccess);
      await load();
    } catch (error) {
      setErrorMessage(actionErrorMessage(error, messages));
      if (error instanceof ApiError && error.status === 409) await load();
    } finally {
      setBusy(false);
    }
  };

  const accountTree = useMemo(() => buildAccountTree(accounts), [accounts]);
  const filteredAccounts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return accountTree;
    return accountTree.filter(
      (row) =>
        row.code.toLowerCase().includes(needle) ||
        row.name.toLowerCase().includes(needle) ||
        row.type.toLowerCase().includes(needle),
    );
  }, [accountTree, search]);

  const filteredCostCenters = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return costCenters;
    return costCenters.filter(
      (row) =>
        row.code.toLowerCase().includes(needle) ||
        row.name.toLowerCase().includes(needle) ||
        (row.description ?? '').toLowerCase().includes(needle),
    );
  }, [costCenters, search]);

  const filteredJournals = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return journals;
    return journals.filter(
      (row) =>
        row.status.toLowerCase().includes(needle) ||
        row.entryDate.includes(needle) ||
        (row.reference ?? '').toLowerCase().includes(needle) ||
        (row.memo ?? '').toLowerCase().includes(needle),
    );
  }, [journals, search]);

  const displayPhase: ResourcePhase =
    phase === 'ready' &&
    ((tab === 'accounts' && filteredAccounts.length === 0) ||
      (tab === 'costCenters' && filteredCostCenters.length === 0) ||
      (tab === 'journals' && filteredJournals.length === 0)) &&
    search
      ? 'empty'
      : phase;

  const openCreateAccount = () => {
    setEditingAccount(null);
    setAccountForm({ code: '', name: '', type: 'Asset', parentId: '' });
    setAccountDialog('create');
  };

  const openEditAccount = (account: ChartOfAccountRecord) => {
    setEditingAccount(account);
    setAccountForm({
      code: account.code,
      name: account.name,
      type: account.type as AccountType,
      parentId: account.parentId ?? '',
    });
    setAccountDialog('edit');
  };

  const submitAccount = async (event: FormEvent) => {
    event.preventDefault();
    await runAction(async () => {
      if (accountDialog === 'create') {
        await financeApi.createAccount({
          code: accountForm.code.trim(),
          name: accountForm.name.trim(),
          type: accountForm.type,
          parentId: accountForm.parentId || null,
        });
      } else if (editingAccount) {
        await financeApi.patchAccount(editingAccount.id, {
          name: accountForm.name.trim(),
          type: accountForm.type,
          parentId: accountForm.parentId || null,
        });
      }
      setAccountDialog(null);
    });
  };

  const openCreateCost = () => {
    setEditingCost(null);
    setCostForm({ code: '', name: '', description: '' });
    setCostDialog('create');
  };

  const openEditCost = (row: CostCenterRecord) => {
    setEditingCost(row);
    setCostForm({ code: row.code, name: row.name, description: row.description ?? '' });
    setCostDialog('edit');
  };

  const submitCost = async (event: FormEvent) => {
    event.preventDefault();
    await runAction(async () => {
      if (costDialog === 'create') {
        await financeApi.createCostCenter({
          code: costForm.code.trim(),
          name: costForm.name.trim(),
          description: costForm.description.trim() || null,
        });
      } else if (editingCost) {
        await financeApi.patchCostCenter(editingCost.id, {
          name: costForm.name.trim(),
          description: costForm.description.trim() || null,
        });
      }
      setCostDialog(null);
    });
  };

  const openCreateJournal = async () => {
    if (accounts.length === 0) {
      try {
        setAccounts(await financeApi.listAccounts());
      } catch {
        /* ignore — create will fail closed */
      }
    }
    if (costCenters.length === 0) {
      try {
        setCostCenters(await financeApi.listCostCenters());
      } catch {
        /* optional */
      }
    }
    setJournalForm({
      entryDate: new Date().toISOString().slice(0, 10),
      reference: '',
      memo: '',
      lines: emptyLines(),
    });
    setJournalDialog('create');
  };

  const openEditJournal = async (journal: JournalEntryRecord) => {
    if (journal.status !== 'draft') return;
    const requestId = journalGuard.begin();
    setBusy(true);
    try {
      const detail = await financeApi.getJournalEntry(journal.id);
      if (!journalGuard.isCurrent(requestId)) return;
      if (accounts.length === 0) setAccounts(await financeApi.listAccounts().catch(() => []));
      if (costCenters.length === 0) setCostCenters(await financeApi.listCostCenters().catch(() => []));
      setSelectedJournal(detail);
      setJournalForm({
        entryDate: detail.entryDate,
        reference: detail.reference ?? '',
        memo: detail.memo ?? '',
        lines: detail.lines.map((line) => ({
          accountId: line.accountId,
          costCenterId: line.costCenterId,
          debit: line.debit,
          credit: line.credit,
          lineMemo: line.lineMemo,
        })),
      });
      setJournalDialog('edit');
    } catch (error) {
      setErrorMessage(actionErrorMessage(error, messages));
    } finally {
      setBusy(false);
    }
  };

  const submitJournal = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedLines = journalForm.lines.map((line) => ({
      accountId: line.accountId,
      costCenterId: line.costCenterId || null,
      debit: normalizeMoneyInput(line.debit) ?? '0.00',
      credit: normalizeMoneyInput(line.credit) ?? '0.00',
      lineMemo: line.lineMemo?.trim() || null,
    }));
    if (!journalLinesBalanced(normalizedLines)) {
      setErrorMessage(messages.journalUnbalanced);
      return;
    }
    await runAction(async () => {
      if (journalDialog === 'create') {
        await financeApi.createJournalEntry({
          entryDate: journalForm.entryDate,
          reference: journalForm.reference.trim() || null,
          memo: journalForm.memo.trim() || null,
          lines: normalizedLines,
        });
      } else if (selectedJournal) {
        await financeApi.patchJournalEntry(selectedJournal.id, {
          entryDate: journalForm.entryDate,
          reference: journalForm.reference.trim() || null,
          memo: journalForm.memo.trim() || null,
          lines: normalizedLines,
        });
      }
      setJournalDialog(null);
      setSelectedJournal(null);
    });
  };

  const openJournalDetail = async (id: string) => {
    const requestId = journalGuard.begin();
    setBusy(true);
    try {
      const detail = await financeApi.getJournalEntry(id);
      if (!journalGuard.isCurrent(requestId)) return;
      setSelectedJournal(detail);
    } catch (error) {
      setErrorMessage(actionErrorMessage(error, messages));
    } finally {
      setBusy(false);
    }
  };

  const activeAccounts = accounts.filter((row) => row.status === 'active');
  const activeCostCenters = costCenters.filter((row) => row.status === 'active');

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.financeTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.financeSubtitle}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tab === 'accounts' && canCreate ? (
            <button type="button" onClick={openCreateAccount} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
              <Plus className="h-4 w-4" /> {messages.createAccount}
            </button>
          ) : null}
          {tab === 'costCenters' && canCreate ? (
            <button type="button" onClick={openCreateCost} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
              <Plus className="h-4 w-4" /> {messages.createCostCenter}
            </button>
          ) : null}
          {tab === 'journals' && canCreate ? (
            <button type="button" onClick={() => void openCreateJournal()} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
              <Plus className="h-4 w-4" /> {messages.createJournal}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void load()}
            disabled={phase === 'loading' || !canView || busy}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-extrabold text-slate-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
          >
            <RefreshCw className="h-4 w-4" /> {messages.refresh}
          </button>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {(
          [
            ['accounts', messages.tabAccounts],
            ['costCenters', messages.tabCostCenters],
            ['journals', messages.tabJournals],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setTab(id);
              setSearch('');
              setSelectedJournal(null);
            }}
            className={`rounded-2xl px-4 py-2.5 text-sm font-extrabold transition ${
              tab === id
                ? 'bg-brand-600 text-white'
                : 'border border-slate-200 bg-white text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="mt-4 block text-xs font-bold text-slate-400">
        {messages.search}
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="mt-1 w-full max-w-md rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5"
        />
      </label>

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

      {displayPhase !== 'ready' ? (
        <ResourceState
          phase={displayPhase === 'loading' || displayPhase === 'empty' || displayPhase === 'error' || displayPhase === 'forbidden' ? displayPhase : 'empty'}
          messages={messages}
          emptyMessage={messages.financeEmpty}
          errorMessage={messages.financeError}
          forbiddenMessage={messages.financeForbidden}
          onRetry={() => void load()}
        />
      ) : null}

      {displayPhase === 'ready' && tab === 'accounts' ? (
        <div className="mt-6 overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-start text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:border-white/10">
                <th className="px-4 py-3">{messages.accountCode}</th>
                <th className="px-4 py-3">{messages.accountName}</th>
                <th className="px-4 py-3">{messages.accountType}</th>
                <th className="px-4 py-3">{messages.status}</th>
                {canManage ? <th className="px-4 py-3" /> : null}
              </tr>
            </thead>
            <tbody>
              {filteredAccounts.map((account) => (
                <tr key={account.id} className="border-b border-slate-100 dark:border-white/5">
                  <td className="px-4 py-3 font-bold" dir="ltr" style={{ paddingInlineStart: `${1 + account.depth * 1.25}rem` }}>
                    {account.code}
                  </td>
                  <td className="px-4 py-3 font-bold text-slate-900 dark:text-white">{account.name}</td>
                  <td className="px-4 py-3 text-slate-500">{account.type}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {account.status === 'active' ? messages.activeStatus : messages.archivedStatus}
                  </td>
                  {canManage ? (
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {account.status === 'active' ? (
                          <>
                            <button type="button" disabled={busy} onClick={() => openEditAccount(account)} className="text-xs font-extrabold text-brand-700 disabled:opacity-50">
                              {messages.edit}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void runAction(async () => { await financeApi.archiveAccount(account.id); })}
                              className="text-xs font-extrabold text-amber-700 disabled:opacity-50"
                            >
                              {messages.archive}
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {displayPhase === 'ready' && tab === 'costCenters' ? (
        <div className="mt-6 overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-start text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:border-white/10">
                <th className="px-4 py-3">{messages.costCenterCode}</th>
                <th className="px-4 py-3">{messages.costCenterName}</th>
                <th className="px-4 py-3">{messages.status}</th>
                {canManage ? <th className="px-4 py-3" /> : null}
              </tr>
            </thead>
            <tbody>
              {filteredCostCenters.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 dark:border-white/5">
                  <td className="px-4 py-3 font-bold" dir="ltr">{row.code}</td>
                  <td className="px-4 py-3 font-bold text-slate-900 dark:text-white">{row.name}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {row.status === 'active' ? messages.activeStatus : messages.archivedStatus}
                  </td>
                  {canManage ? (
                    <td className="px-4 py-3">
                      {row.status === 'active' ? (
                        <div className="flex gap-2">
                          <button type="button" disabled={busy} onClick={() => openEditCost(row)} className="text-xs font-extrabold text-brand-700 disabled:opacity-50">
                            {messages.edit}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void runAction(async () => { await financeApi.archiveCostCenter(row.id); })}
                            className="text-xs font-extrabold text-amber-700 disabled:opacity-50"
                          >
                            {messages.archive}
                          </button>
                        </div>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {displayPhase === 'ready' && tab === 'journals' ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-start text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:border-white/10">
                  <th className="px-4 py-3">{messages.journalDate}</th>
                  <th className="px-4 py-3">{messages.journalStatus}</th>
                  <th className="px-4 py-3">{messages.journalReference}</th>
                  <th className="px-4 py-3">{messages.journalTotalDebit}</th>
                </tr>
              </thead>
              <tbody>
                {filteredJournals.map((journal) => (
                  <tr key={journal.id} className="border-b border-slate-100 dark:border-white/5">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => void openJournalDetail(journal.id)}
                        className="font-extrabold text-brand-700 dark:text-brand-300"
                        dir="ltr"
                      >
                        {journal.entryDate}
                      </button>
                    </td>
                    <td className="px-4 py-3 font-bold">{journalStatusLabel(journal.status, messages)}</td>
                    <td className="px-4 py-3 text-slate-500">{journal.reference ?? '—'}</td>
                    <td className="px-4 py-3 font-bold" dir="ltr">
                      {formatMoneyAmount(journal.totalDebit, journal.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-panel dark:border-white/10 dark:bg-white/5">
            {!selectedJournal ? (
              <div className="flex h-full min-h-40 flex-col items-center justify-center text-center text-sm font-bold text-slate-500">
                <BookOpen className="mb-2 h-8 w-8 opacity-40" />
                {messages.viewDetails}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-extrabold">{messages.journalLines}</h2>
                    <p className="mt-1 text-sm text-slate-500" dir="ltr">
                      {selectedJournal.entryDate} · {journalStatusLabel(selectedJournal.status, messages)}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      {selectedJournal.reference ?? '—'} · {formatMoneyAmount(selectedJournal.totalDebit, selectedJournal.currency)} / {formatMoneyAmount(selectedJournal.totalCredit, selectedJournal.currency)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedJournal.status === 'draft' && canManage ? (
                      <button type="button" disabled={busy} onClick={() => void openEditJournal(selectedJournal)} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-extrabold disabled:opacity-50 dark:border-white/10">
                        {messages.editJournal}
                      </button>
                    ) : null}
                    {selectedJournal.status === 'draft' && canApprove ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void runAction(async () => {
                          const posted = await financeApi.postJournalEntry(selectedJournal.id);
                          setSelectedJournal(posted);
                        })}
                        className="rounded-xl bg-brand-600 px-3 py-2 text-xs font-extrabold text-white disabled:opacity-50"
                      >
                        {messages.postJournal}
                      </button>
                    ) : null}
                    {selectedJournal.status === 'posted' && canApprove ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void runAction(async () => {
                          await financeApi.reverseJournalEntry(selectedJournal.id);
                          const refreshed = await financeApi.getJournalEntry(selectedJournal.id);
                          setSelectedJournal(refreshed);
                        })}
                        className="rounded-xl border border-amber-300 px-3 py-2 text-xs font-extrabold text-amber-800 disabled:opacity-50"
                      >
                        {messages.reverseJournal}
                      </button>
                    ) : null}
                  </div>
                </div>
                {selectedJournal.status !== 'draft' ? (
                  <p className="mt-3 text-xs font-bold text-slate-400">{messages.journalImmutable}</p>
                ) : null}
                <ul className="mt-4 space-y-2">
                  {selectedJournal.lines.map((line) => (
                    <li key={`${line.lineNo}-${line.accountId}`} className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm dark:border-white/10 dark:bg-white/5">
                      <div className="font-extrabold" dir="ltr">#{line.lineNo} · {line.accountId}</div>
                      <div className="mt-1 flex gap-4 font-bold" dir="ltr">
                        <span>{messages.debit}: {formatMoneyAmount(line.debit)}</span>
                        <span>{messages.credit}: {formatMoneyAmount(line.credit)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      ) : null}

      {accountDialog ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
          <form role="dialog" aria-modal="true" onSubmit={(event) => void submitAccount(event)} className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#0b182c]">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-extrabold">{accountDialog === 'create' ? messages.createAccount : messages.editAccount}</h3>
              <button type="button" onClick={() => setAccountDialog(null)} aria-label={messages.close}><X className="h-5 w-5" /></button>
            </div>
            {accountDialog === 'create' ? (
              <label className="mt-4 block text-xs font-bold text-slate-400">
                {messages.accountCode}
                <input required value={accountForm.code} onChange={(e) => setAccountForm((f) => ({ ...f, code: e.target.value }))} className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5" />
              </label>
            ) : null}
            <label className="mt-3 block text-xs font-bold text-slate-400">
              {messages.accountName}
              <input required value={accountForm.name} onChange={(e) => setAccountForm((f) => ({ ...f, name: e.target.value }))} className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5" />
            </label>
            <label className="mt-3 block text-xs font-bold text-slate-400">
              {messages.accountType}
              <select value={accountForm.type} onChange={(e) => setAccountForm((f) => ({ ...f, type: e.target.value as AccountType }))} className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5">
                {ACCOUNT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-xs font-bold text-slate-400">
              {messages.accountParent}
              <select value={accountForm.parentId} onChange={(e) => setAccountForm((f) => ({ ...f, parentId: e.target.value }))} className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5">
                <option value="">{messages.noParent}</option>
                {activeAccounts.filter((row) => row.id !== editingAccount?.id).map((row) => (
                  <option key={row.id} value={row.id}>{row.code} — {row.name}</option>
                ))}
              </select>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setAccountDialog(null)} className="rounded-xl px-4 py-2.5 text-sm font-extrabold">{messages.cancel}</button>
              <button type="submit" disabled={busy} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">{busy ? messages.processingAction : messages.save}</button>
            </div>
          </form>
        </div>
      ) : null}

      {costDialog ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
          <form role="dialog" aria-modal="true" onSubmit={(event) => void submitCost(event)} className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#0b182c]">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-extrabold">{costDialog === 'create' ? messages.createCostCenter : messages.editCostCenter}</h3>
              <button type="button" onClick={() => setCostDialog(null)} aria-label={messages.close}><X className="h-5 w-5" /></button>
            </div>
            {costDialog === 'create' ? (
              <label className="mt-4 block text-xs font-bold text-slate-400">
                {messages.costCenterCode}
                <input required value={costForm.code} onChange={(e) => setCostForm((f) => ({ ...f, code: e.target.value }))} className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5" />
              </label>
            ) : null}
            <label className="mt-3 block text-xs font-bold text-slate-400">
              {messages.costCenterName}
              <input required value={costForm.name} onChange={(e) => setCostForm((f) => ({ ...f, name: e.target.value }))} className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5" />
            </label>
            <label className="mt-3 block text-xs font-bold text-slate-400">
              {messages.costCenterDescription}
              <textarea value={costForm.description} onChange={(e) => setCostForm((f) => ({ ...f, description: e.target.value }))} className="mt-1 min-h-20 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5" />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setCostDialog(null)} className="rounded-xl px-4 py-2.5 text-sm font-extrabold">{messages.cancel}</button>
              <button type="submit" disabled={busy} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">{busy ? messages.processingAction : messages.save}</button>
            </div>
          </form>
        </div>
      ) : null}

      {journalDialog ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
          <form role="dialog" aria-modal="true" onSubmit={(event) => void submitJournal(event)} className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#0b182c]">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-extrabold">{journalDialog === 'create' ? messages.createJournal : messages.editJournal}</h3>
              <button type="button" onClick={() => setJournalDialog(null)} aria-label={messages.close}><X className="h-5 w-5" /></button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-bold text-slate-400">
                {messages.journalDate}
                <input type="date" required value={journalForm.entryDate} onChange={(e) => setJournalForm((f) => ({ ...f, entryDate: e.target.value }))} className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5" />
              </label>
              <label className="block text-xs font-bold text-slate-400">
                {messages.journalReference}
                <input value={journalForm.reference} onChange={(e) => setJournalForm((f) => ({ ...f, reference: e.target.value }))} className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5" />
              </label>
            </div>
            <label className="mt-3 block text-xs font-bold text-slate-400">
              {messages.journalMemo}
              <textarea value={journalForm.memo} onChange={(e) => setJournalForm((f) => ({ ...f, memo: e.target.value }))} className="mt-1 min-h-16 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold dark:border-white/10 dark:bg-white/5" />
            </label>
            <div className="mt-4 space-y-3">
              {journalForm.lines.map((line, index) => (
                <div key={index} className="rounded-2xl border border-slate-200 p-3 dark:border-white/10">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="block text-xs font-bold text-slate-400">
                      {messages.accountName}
                      <select required value={line.accountId} onChange={(e) => setJournalForm((f) => {
                        const lines = [...f.lines];
                        lines[index] = { ...lines[index], accountId: e.target.value };
                        return { ...f, lines };
                      })} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold dark:border-white/10 dark:bg-white/5">
                        <option value="">{messages.selectAccount}</option>
                        {activeAccounts.map((account) => (
                          <option key={account.id} value={account.id}>{account.code} — {account.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-xs font-bold text-slate-400">
                      {messages.tabCostCenters}
                      <select value={line.costCenterId ?? ''} onChange={(e) => setJournalForm((f) => {
                        const lines = [...f.lines];
                        lines[index] = { ...lines[index], costCenterId: e.target.value || null };
                        return { ...f, lines };
                      })} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold dark:border-white/10 dark:bg-white/5">
                        <option value="">—</option>
                        {activeCostCenters.map((cc) => (
                          <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-xs font-bold text-slate-400">
                      {messages.debit}
                      <input value={line.debit} onChange={(e) => setJournalForm((f) => {
                        const lines = [...f.lines];
                        lines[index] = { ...lines[index], debit: e.target.value, credit: '0.00' };
                        return { ...f, lines };
                      })} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold dark:border-white/10 dark:bg-white/5" dir="ltr" />
                    </label>
                    <label className="block text-xs font-bold text-slate-400">
                      {messages.credit}
                      <input value={line.credit} onChange={(e) => setJournalForm((f) => {
                        const lines = [...f.lines];
                        lines[index] = { ...lines[index], credit: e.target.value, debit: '0.00' };
                        return { ...f, lines };
                      })} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold dark:border-white/10 dark:bg-white/5" dir="ltr" />
                    </label>
                  </div>
                  {journalForm.lines.length > 2 ? (
                    <button
                      type="button"
                      onClick={() => setJournalForm((f) => ({ ...f, lines: f.lines.filter((_, i) => i !== index) }))}
                      className="mt-2 text-xs font-extrabold text-red-600"
                    >
                      {messages.removeJournalLine}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setJournalForm((f) => ({
                ...f,
                lines: [...f.lines, { accountId: '', costCenterId: null, debit: '0.00', credit: '0.00', lineMemo: null }],
              }))}
              className="mt-3 text-sm font-extrabold text-brand-700"
            >
              {messages.addJournalLine}
            </button>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setJournalDialog(null)} className="rounded-xl px-4 py-2.5 text-sm font-extrabold">{messages.cancel}</button>
              <button type="submit" disabled={busy} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">{busy ? messages.processingAction : messages.save}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
