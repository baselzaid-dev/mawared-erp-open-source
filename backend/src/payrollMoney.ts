/** Exact money helpers for payroll/payment ledgers — never use IEEE floats. */

/** DECIMAL(18,2) supports at most 16 digits left of the decimal point. */
const DECIMAL_18_2_WHOLE_MAX_DIGITS = 16;

/**
 * Authoritative W1A request money: exact decimal *strings* only.
 * Rejects JSON numbers so values never enter IEEE floating-point first.
 */
export const isExactMoneyDecimalString = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  // Reject scientific notation, spaces, leading "+", and more than 2 fractional digits.
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(trimmed)) return false;
  return isWithinDecimal18_2(trimmed);
};

export const isWithinDecimal18_2 = (value: string): boolean => {
  const trimmed = value.trim();
  const absolute = trimmed.startsWith('-') ? trimmed.slice(1) : trimmed;
  const [whole] = absolute.split('.');
  return whole.length <= DECIMAL_18_2_WHOLE_MAX_DIGITS;
};

/** Canonical integer-cent string for audit metadata — never Number(bigint). */
export const centsToAuditString = (cents: bigint): string => cents.toString();

export const normalizeMoney = (
  value: { toString(): string } | string | number,
): string | null => {
  const raw = typeof value === 'number' ? value.toFixed(2) : value.toString();
  const match = /^-?\d+(?:\.\d{1,2})?$/.exec(raw.trim());
  if (!match) return null;
  const [whole, fraction = ''] = raw.trim().split('.');
  const normalized = `${whole}.${fraction.padEnd(2, '0')}`;
  if (!isWithinDecimal18_2(normalized)) return null;
  return normalized;
};

export const moneyToCents = (
  value: { toString(): string } | string | number,
): bigint => {
  const normalized = normalizeMoney(value);
  if (!normalized) {
    throw new Error(`Invalid money value: ${String(value)}`);
  }
  const negative = normalized.startsWith('-');
  const absolute = negative ? normalized.slice(1) : normalized;
  const [whole, fraction] = absolute.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  return negative ? -cents : cents;
};

export const centsToMoney = (cents: bigint): string => {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const formatted = `${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
  return negative ? `-${formatted}` : formatted;
};
