import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionMemory } from '@/auth/sessionMemory';
import { payrollApi } from './api';

describe('company web payroll API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionMemory.clear();
  });

  it('lists payroll periods through the authenticated company-scoped contract', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      {
        id: 'pp-1',
        companyId: 'co-1',
        month: 8,
        year: 2026,
        status: 'draft',
        calculationVersion: 0,
        protectedRowsHidden: false,
        protectedRowCount: 0,
      },
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const periods = await payrollApi.listPeriods();

    expect(periods).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/payroll/periods');
    expect(fetchMock.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer access-token');
  });

  it('creates a period and calculates with optional recalculation reason', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'pp-1', status: 'draft' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        period: { id: 'pp-1', status: 'calculated', calculationVersion: 2 },
        items: [],
        visibleSummary: null,
        protectedRowsHidden: false,
        protectedRowCount: 0,
        recalculated: true,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await payrollApi.createPeriod({ month: 8, year: 2026 });
    await payrollApi.calculatePeriod('pp-1', { recalculationReason: 'Fix component rates' });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ month: 8, year: 2026 });
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/payroll/periods/pp-1/calculate');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({
      recalculationReason: 'Fix component rates',
    });
  });

  it('surfaces forbidden item responses without inventing rows', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Forbidden',
      code: 403,
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(payrollApi.getPeriodItems('pp-1')).rejects.toMatchObject({
      status: 403,
      code: 'Forbidden',
    });
  });

  it('posts adjustments, reopen, and ledger posting with Idempotency-Key', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        preview: true,
        direction: 'allowance',
        amount: '100.00',
        resultingGross: '5100.00',
        resultingDeductions: '0.00',
        resultingNet: '5100.00',
        redacted: false,
        requiresRecalculation: true,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        idempotent: false,
        adjustment: { id: 'adj-1', amount: '100.00' },
        requiresRecalculation: true,
        redacted: false,
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'pp-1',
        status: 'calculated',
        calculationVersion: 1,
        reopenedAt: '2026-08-07T00:00:00.000Z',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        idempotent: false,
        postingId: 'post-1',
        journalEntryId: 'je-1',
        calculationVersion: 1,
        totalDebit: '1000.00',
        totalCredit: '1000.00',
        lineCount: 2,
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await payrollApi.previewAdjustment('pp-1', 'item-1', {
      direction: 'allowance',
      amount: '100.00',
      reason: 'Bonus correction',
    });
    await payrollApi.applyAdjustment('pp-1', 'item-1', {
      direction: 'allowance',
      amount: '100.00',
      reason: 'Bonus correction',
    }, 'payroll-adjust-test-key-001');
    await payrollApi.reopenPeriod('pp-1', {
      reason: 'Need recalculation',
      confirm: true,
      confirmationPhrase: 'REOPEN-2026-08',
    });
    await payrollApi.postToLedger('pp-1', {
      expenseAccountId: 'acc-exp',
      payableAccountId: 'acc-pay',
    }, 'payroll-ledger-test-key-001');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/adjust/preview');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/adjust');
    expect(fetchMock.mock.calls[1][1].headers.get('Idempotency-Key')).toBe('payroll-adjust-test-key-001');
    expect(String(fetchMock.mock.calls[2][0])).toContain('/reopen');
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body))).toEqual({
      reason: 'Need recalculation',
      confirm: true,
      confirmationPhrase: 'REOPEN-2026-08',
    });
    expect(fetchMock.mock.calls[3][1].headers.get('Idempotency-Key')).toBe('payroll-ledger-test-key-001');
  });

  it('rejects stale approve conflicts without inventing success', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'PAYROLL_PERIOD_ALREADY_APPROVED',
      message: 'فترة الرواتب معتمدة مسبقاً',
      code: 'PAYROLL_PERIOD_ALREADY_APPROVED',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(payrollApi.approvePeriod('pp-1')).rejects.toMatchObject({
      status: 409,
      code: 'PAYROLL_PERIOD_ALREADY_APPROVED',
    });
  });
});
