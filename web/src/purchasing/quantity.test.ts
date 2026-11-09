import { describe, expect, it } from 'vitest';
import {
  exceedsRemaining,
  formatQuantity,
  isPositiveQuantity,
  milliToQuantityString,
  normalizeQuantityInput,
  parseQuantityToMilli,
  receivedPercent,
} from './quantity';

describe('purchasing quantity helpers', () => {
  it('parses exact quantity strings into integer milli-units', () => {
    expect(parseQuantityToMilli('1')).toBe(1000n);
    expect(parseQuantityToMilli('1.5')).toBe(1500n);
    expect(parseQuantityToMilli('0.001')).toBe(1n);
    expect(parseQuantityToMilli('10.000')).toBe(10_000n);
  });

  it('rejects anything that is not an exact non-negative quantity', () => {
    for (const value of ['', ' ', '-1', '1.0001', '1e3', 'abc', '.5', '1.', '+1', null, undefined]) {
      expect(parseQuantityToMilli(value as string | null | undefined)).toBeNull();
    }
  });

  it('round-trips through the canonical three-decimal string', () => {
    expect(milliToQuantityString(1500n)).toBe('1.500');
    expect(normalizeQuantityInput('2')).toBe('2.000');
    expect(normalizeQuantityInput('2.5')).toBe('2.500');
    expect(normalizeQuantityInput('bad')).toBeNull();
  });

  it('formats for display without trailing zeros and never uses parseFloat', () => {
    expect(formatQuantity('1000.500')).toBe('1,000.5');
    expect(formatQuantity('3.000')).toBe('3');
    expect(formatQuantity('0.125')).toBe('0.125');
    expect(formatQuantity(null)).toBe('—');
    // 0.1 + 0.2 style drift is impossible: the value stays a decimal string.
    expect(formatQuantity('0.300')).toBe('0.3');
  });

  it('compares against the remaining quantity exactly', () => {
    expect(exceedsRemaining('5.001', '5.000')).toBe(true);
    expect(exceedsRemaining('5.000', '5.000')).toBe(false);
    expect(exceedsRemaining('4.999', '5.000')).toBe(false);
    // Unparseable input is left for the server to reject, not silently blocked.
    expect(exceedsRemaining('bad', '5.000')).toBe(false);
  });

  it('recognizes strictly positive quantities', () => {
    expect(isPositiveQuantity('0.001')).toBe(true);
    expect(isPositiveQuantity('0')).toBe(false);
    expect(isPositiveQuantity('0.000')).toBe(false);
    expect(isPositiveQuantity('-1')).toBe(false);
  });

  it('computes a clamped received percentage for progress bars', () => {
    expect(receivedPercent('5.000', '10.000')).toBe(50);
    expect(receivedPercent('10.000', '10.000')).toBe(100);
    // An audited over-receipt never renders past 100%.
    expect(receivedPercent('11.000', '10.000')).toBe(100);
    expect(receivedPercent('1.000', '0.000')).toBe(0);
  });
});
