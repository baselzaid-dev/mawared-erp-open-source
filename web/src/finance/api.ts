import { authenticatedRequest } from '@/api/client';
import { createIdempotencyKey } from './money';
import type {
  ChartOfAccountRecord,
  CostCenterRecord,
  CreateAccountInput,
  CreateCostCenterInput,
  CreateJournalInput,
  JournalEntryRecord,
  PatchAccountInput,
  PatchCostCenterInput,
  PatchJournalInput,
} from './types';

export const financeApi = {
  listAccounts(): Promise<ChartOfAccountRecord[]> {
    return authenticatedRequest('/api/v2/finance/chart-of-accounts');
  },

  createAccount(input: CreateAccountInput): Promise<ChartOfAccountRecord> {
    return authenticatedRequest('/api/v2/finance/chart-of-accounts', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  patchAccount(id: string, input: PatchAccountInput): Promise<ChartOfAccountRecord> {
    return authenticatedRequest(`/api/v2/finance/chart-of-accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  archiveAccount(id: string): Promise<ChartOfAccountRecord> {
    return authenticatedRequest(
      `/api/v2/finance/chart-of-accounts/${encodeURIComponent(id)}/archive`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
  },

  listCostCenters(): Promise<CostCenterRecord[]> {
    return authenticatedRequest('/api/v2/finance/cost-centers');
  },

  createCostCenter(input: CreateCostCenterInput): Promise<CostCenterRecord> {
    return authenticatedRequest('/api/v2/finance/cost-centers', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  patchCostCenter(id: string, input: PatchCostCenterInput): Promise<CostCenterRecord> {
    return authenticatedRequest(`/api/v2/finance/cost-centers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  archiveCostCenter(id: string): Promise<CostCenterRecord> {
    return authenticatedRequest(`/api/v2/finance/cost-centers/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  listJournalEntries(): Promise<JournalEntryRecord[]> {
    return authenticatedRequest('/api/v2/finance/journal-entries');
  },

  getJournalEntry(id: string): Promise<JournalEntryRecord> {
    return authenticatedRequest(`/api/v2/finance/journal-entries/${encodeURIComponent(id)}`);
  },

  createJournalEntry(input: CreateJournalInput): Promise<JournalEntryRecord> {
    return authenticatedRequest('/api/v2/finance/journal-entries', {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        currency: input.currency ?? 'SAR',
      }),
    });
  },

  patchJournalEntry(id: string, input: PatchJournalInput): Promise<JournalEntryRecord> {
    return authenticatedRequest(`/api/v2/finance/journal-entries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  postJournalEntry(
    id: string,
    idempotencyKey = createIdempotencyKey('journal-post'),
  ): Promise<JournalEntryRecord> {
    return authenticatedRequest(`/api/v2/finance/journal-entries/${encodeURIComponent(id)}/post`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({}),
    });
  },

  reverseJournalEntry(
    id: string,
    idempotencyKey = createIdempotencyKey('journal-reverse'),
  ): Promise<JournalEntryRecord> {
    return authenticatedRequest(
      `/api/v2/finance/journal-entries/${encodeURIComponent(id)}/reverse`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({}),
      },
    );
  },
};
