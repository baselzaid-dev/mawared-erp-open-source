import { describe, expect, it } from 'vitest';
import { journalLinesBalanced } from './money';

describe('finance journal balance helpers', () => {
  it('accepts balanced one-side lines', () => {
    expect(journalLinesBalanced([
      { debit: '100.00', credit: '0.00' },
      { debit: '0.00', credit: '100.00' },
    ])).toBe(true);
  });

  it('rejects unbalanced or dual-sided lines', () => {
    expect(journalLinesBalanced([
      { debit: '100.00', credit: '0.00' },
      { debit: '0.00', credit: '90.00' },
    ])).toBe(false);
    expect(journalLinesBalanced([
      { debit: '50.00', credit: '50.00' },
      { debit: '0.00', credit: '0.00' },
    ])).toBe(false);
  });
});
