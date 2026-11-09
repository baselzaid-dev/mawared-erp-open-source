/**
 * Exact decimal-string quantity helpers for the purchasing screens.
 *
 * Purchasing quantities are `DECIMAL(18,3)` on the server and are only ever
 * computed there. The client still needs to compare and format them (for
 * "remaining", input validation and progress bars), so it does the same integer
 * milli-unit arithmetic with BigInt instead of parseFloat.
 */

/** A trailing "1." is not an exact quantity, so the fraction needs at least one digit. */
const QUANTITY_RE = /^(\d+)(?:\.(\d{1,3}))?$/;

export function parseQuantityToMilli(value: string | null | undefined): bigint | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const match = QUANTITY_RE.exec(trimmed);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(3, '0') || '0');
  return whole * 1000n + fraction;
}

export function milliToQuantityString(milli: bigint): string {
  const negative = milli < 0n;
  const abs = negative ? -milli : milli;
  const body = `${abs / 1000n}.${(abs % 1000n).toString().padStart(3, '0')}`;
  return negative ? `-${body}` : body;
}

/** Canonical `0.000` string, or null when the input is not an exact quantity. */
export function normalizeQuantityInput(value: string): string | null {
  const milli = parseQuantityToMilli(value);
  if (milli == null) return null;
  return milliToQuantityString(milli);
}

/** Formats for display with digit grouping; trailing zeros are trimmed to 0–3 places. */
export function formatQuantity(value: string | null | undefined): string {
  const milli = parseQuantityToMilli(value);
  if (milli == null) return '—';
  const whole = (milli / 1000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (milli % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Client-side pre-check only. The backend re-derives the position inside its
 * row lock and remains the authority; this exists so the user is not sent to
 * the server with an obviously impossible quantity.
 */
export function exceedsRemaining(quantity: string, remainingQuantity: string): boolean {
  const requested = parseQuantityToMilli(quantity);
  const remaining = parseQuantityToMilli(remainingQuantity);
  if (requested == null || remaining == null) return false;
  return requested > remaining;
}

export function isPositiveQuantity(value: string): boolean {
  const milli = parseQuantityToMilli(value);
  return milli != null && milli > 0n;
}

/** Received percentage of an order line, as an integer 0–100 for progress bars. */
export function receivedPercent(netReceived: string, ordered: string): number {
  const net = parseQuantityToMilli(netReceived);
  const total = parseQuantityToMilli(ordered);
  if (net == null || total == null || total === 0n) return 0;
  const capped = net > total ? total : net;
  return Number((capped * 100n) / total);
}
