import { describe, expect, it } from 'vitest';
import {
  createIdempotencyKey,
  formatMoneyAmount,
  parseMoneyToCents,
  payrollReopenConfirmationPhrase,
} from './money';

describe('payroll money display helpers', () => {
  it('formats decimal strings without float math', () => {
    expect(formatMoneyAmount('1234.5')).toBe('1,234.50 SAR');
    expect(formatMoneyAmount('0.01')).toBe('0.01 SAR');
    expect(formatMoneyAmount(null)).toBe('—');
    expect(formatMoneyAmount('not-money')).toBe('—');
  });

  it('parses to exact cents via BigInt', () => {
    expect(parseMoneyToCents('10.25')).toBe(1025n);
    expect(parseMoneyToCents('-1.00')).toBe(-100n);
    expect(parseMoneyToCents('1.999')).toBeNull();
  });

  it('builds reopen confirmation phrases matching the backend contract', () => {
    expect(payrollReopenConfirmationPhrase(2026, 8)).toBe('REOPEN-2026-08');
    expect(payrollReopenConfirmationPhrase(2026, 12)).toBe('REOPEN-2026-12');
  });

  it('creates stable-shaped idempotency keys', () => {
    const key = createIdempotencyKey('payroll-adjust');
    expect(key.startsWith('payroll-adjust-')).toBe(true);
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(120);
  });
});
