import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionMemory } from '@/auth/sessionMemory';
import { financeApi } from './api';

describe('company web finance API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionMemory.clear();
  });

  it('lists chart of accounts through the authenticated company-scoped contract', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      {
        id: 'acc-1',
        companyId: 'co-1',
        code: '1000',
        name: 'Cash',
        type: 'Asset',
        parentId: null,
        status: 'active',
      },
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const accounts = await financeApi.listAccounts();

    expect(accounts).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v2/finance/chart-of-accounts');
    expect(fetchMock.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer access-token');
  });

  it('creates and archives cost centers without inventing success on forbidden', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'cc-1',
        code: 'OPS',
        name: 'Operations',
        status: 'active',
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'Forbidden',
        code: 403,
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(financeApi.createCostCenter({ code: 'OPS', name: 'Operations' })).resolves.toMatchObject({
      id: 'cc-1',
    });
    await expect(financeApi.archiveCostCenter('cc-1')).rejects.toMatchObject({
      status: 403,
      code: 'Forbidden',
    });
  });

  it('posts and reverses journals with Idempotency-Key headers', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'je-1',
        status: 'posted',
        lines: [],
        idempotent: false,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'je-2',
        status: 'posted',
        reversesJournalEntryId: 'je-1',
        lines: [],
        idempotent: false,
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await financeApi.postJournalEntry('je-1', 'journal-post-test-key-001');
    await financeApi.reverseJournalEntry('je-1', 'journal-reverse-test-key-001');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/journal-entries/je-1/post');
    expect(fetchMock.mock.calls[0][1].headers.get('Idempotency-Key')).toBe('journal-post-test-key-001');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/journal-entries/je-1/reverse');
    expect(fetchMock.mock.calls[1][1].headers.get('Idempotency-Key')).toBe('journal-reverse-test-key-001');
  });

  it('creates balanced draft journals with SAR default currency', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'je-1',
      status: 'draft',
      currency: 'SAR',
      lines: [],
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await financeApi.createJournalEntry({
      entryDate: '2026-08-07',
      reference: 'MAN-1',
      lines: [
        { accountId: 'a1', debit: '100.00', credit: '0.00' },
        { accountId: 'a2', debit: '0.00', credit: '100.00' },
      ],
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({
      entryDate: '2026-08-07',
      currency: 'SAR',
      lines: [
        { accountId: 'a1', debit: '100.00', credit: '0.00' },
        { accountId: 'a2', debit: '0.00', credit: '100.00' },
      ],
    });
  });

  it('surfaces journal conflict responses without inventing success', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'JOURNAL_NOT_DRAFT',
      code: 'JOURNAL_NOT_DRAFT',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(financeApi.patchJournalEntry('je-1', { memo: 'x' })).rejects.toMatchObject({
      status: 409,
      code: 'JOURNAL_NOT_DRAFT',
    });
  });
});
