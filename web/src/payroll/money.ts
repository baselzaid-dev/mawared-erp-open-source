/**
 * Exact decimal-string helpers for display and client-side UX checks.
 * Avoid IEEE float arithmetic — work on integer cents via BigInt.
 */

const MONEY_RE = /^(-?)(\d+)(?:\.(\d{0,2}))?$/;

export function parseMoneyToCents(value: string | null | undefined): bigint | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const match = MONEY_RE.exec(trimmed);
  if (!match) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = BigInt((match[3] ?? '').padEnd(2, '0').slice(0, 2) || '0');
  return sign * (whole * 100n + fraction);
}

export function centsToMoneyString(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const fraction = abs % 100n;
  const body = `${whole.toString()}.${fraction.toString().padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}

/** Format a decimal money string with grouping; never uses parseFloat. */
export function formatMoneyAmount(
  value: string | null | undefined,
  currency = 'SAR',
): string {
  if (value == null || String(value).trim() === '') return '—';
  const cents = parseMoneyToCents(value);
  if (cents == null) return '—';
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toString();
  const fraction = (abs % 100n).toString().padStart(2, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${fraction} ${currency}`;
}

export function normalizeMoneyInput(value: string): string | null {
  const cents = parseMoneyToCents(value);
  if (cents == null || cents < 0n) return null;
  return centsToMoneyString(cents);
}

export function createIdempotencyKey(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const key = `${prefix}-${uuid}`.replace(/[^A-Za-z0-9._:-]/g, '-');
  return key.slice(0, 120);
}

/** Must match backend `payrollReopenConfirmationPhrase`. */
export function payrollReopenConfirmationPhrase(year: number, month: number): string {
  return `REOPEN-${year}-${String(month).padStart(2, '0')}`;
}
