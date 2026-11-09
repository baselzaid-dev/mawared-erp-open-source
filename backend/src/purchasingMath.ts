/**
 * Exact purchasing arithmetic — Commercial Wave 2 (Operations Slice E1).
 *
 * Purchasing quantities are `DECIMAL(18,3)` and purchasing money is
 * `DECIMAL(18,2)`. Every quantity/amount computed by the receipt, return and
 * quotation code paths goes through these helpers so no value ever passes
 * through IEEE floating point.
 *
 * Scales:
 *  - quantity → integer milli-units (1.500 → 1500n)
 *  - money    → integer cents       (1.50  → 150n)
 *
 * Rounding: `lineTotalCents` uses half-up on the exact integer product, matching
 * the rounding already used by `calculateLines` in `purchasing.ts`. Wave 2 does
 * not introduce UOM conversion; a quantity is always expressed in the unit
 * captured on the source line (Operations Slice D owns UOM).
 */

export const QUANTITY_SCALE = 3;
export const MONEY_SCALE = 2;

/** DECIMAL(18,3) → at most 15 digits left of the point. */
const QUANTITY_WHOLE_MAX_DIGITS = 18 - QUANTITY_SCALE;
/** DECIMAL(18,2) → at most 16 digits left of the point. */
const MONEY_WHOLE_MAX_DIGITS = 18 - MONEY_SCALE;

const QUANTITY_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/;
const MONEY_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

export class PurchasingMathError extends Error {
  constructor(readonly errorCode: string, message: string) {
    super(message);
  }
}

const wholeDigits = (value: string): number => value.split('.')[0].length;

/**
 * Authoritative Wave 2 quantity input: an exact non-negative decimal *string*
 * with at most 3 fractional digits. JSON numbers, scientific notation, signs and
 * padding are all rejected before the value can reach the database.
 */
export const isExactQuantityString = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  if (!QUANTITY_PATTERN.test(value)) return false;
  return wholeDigits(value) <= QUANTITY_WHOLE_MAX_DIGITS;
};

/** Same contract as `isExactQuantityString`, for `DECIMAL(18,2)` money. */
export const isExactPurchasingMoneyString = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  if (!MONEY_PATTERN.test(value)) return false;
  return wholeDigits(value) <= MONEY_WHOLE_MAX_DIGITS;
};

const toScaled = (value: string, scale: number): bigint => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
};

const fromScaled = (value: bigint, scale: number): string => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const formatted = `${absolute / divisor}.${(absolute % divisor).toString().padStart(scale, '0')}`;
  return negative ? `-${formatted}` : formatted;
};

/** Parses an exact quantity string into integer milli-units. */
export function quantityToMilli(value: unknown): bigint {
  if (!isExactQuantityString(value)) {
    throw new PurchasingMathError('INVALID_QUANTITY', 'الكمية غير صالحة');
  }
  return toScaled(value, QUANTITY_SCALE);
}

/** Formats integer milli-units back to a canonical `0.000` string. */
export const milliToQuantity = (milli: bigint): string => fromScaled(milli, QUANTITY_SCALE);

/** Parses an exact money string into integer cents. */
export function purchasingMoneyToCents(value: unknown): bigint {
  if (!isExactPurchasingMoneyString(value)) {
    throw new PurchasingMathError('INVALID_AMOUNT', 'المبلغ غير صالح');
  }
  return toScaled(value, MONEY_SCALE);
}

/** Formats integer cents back to a canonical `0.00` string. */
export const centsToPurchasingMoney = (cents: bigint): string => fromScaled(cents, MONEY_SCALE);

/**
 * Normalizes any Prisma `Decimal`/string/number read out of the database into a
 * canonical fixed-scale string. Read paths only — never a mutation input path.
 */
export function decimalToFixedString(value: unknown, scale: number): string {
  const raw = value == null ? '0' : String(value);
  const negative = raw.startsWith('-');
  const absolute = negative ? raw.slice(1) : raw;
  const [whole, fraction = ''] = absolute.split('.');
  const formatted = `${whole || '0'}.${fraction.padEnd(scale, '0').slice(0, scale)}`;
  return negative ? `-${formatted}` : formatted;
}

export const readQuantity = (value: unknown): string => decimalToFixedString(value, QUANTITY_SCALE);
export const readMoney = (value: unknown): string => decimalToFixedString(value, MONEY_SCALE);

/** Integer milli-units for a quantity already stored in the database. */
export const storedQuantityToMilli = (value: unknown): bigint =>
  toScaled(readQuantity(value), QUANTITY_SCALE);

/** Integer cents for money already stored in the database. */
export const storedMoneyToCents = (value: unknown): bigint => toScaled(readMoney(value), MONEY_SCALE);

/**
 * Exact line total = quantity × unit price, rounded half-up to cents.
 * `quantityMilli × priceCents` is an exact integer in milli-cents; adding half a
 * milli-unit before the integer division performs the half-up rounding without
 * ever leaving integer arithmetic.
 */
export function lineTotalCents(quantityMilli: bigint, priceCents: bigint): bigint {
  if (quantityMilli < 0n || priceCents < 0n) {
    throw new PurchasingMathError('INVALID_AMOUNT', 'المبلغ غير صالح');
  }
  return (quantityMilli * priceCents + 500n) / 1000n;
}

/** Guards a computed money value against the `DECIMAL(18,2)` column range. */
export function assertMoneyWithinRange(cents: bigint, errorCode = 'AMOUNT_OUT_OF_RANGE'): void {
  const limit = 10n ** BigInt(MONEY_WHOLE_MAX_DIGITS + MONEY_SCALE);
  if (cents >= limit || cents <= -limit) {
    throw new PurchasingMathError(errorCode, 'المبلغ يتجاوز الحد المسموح');
  }
}

/** Guards a computed quantity against the `DECIMAL(18,3)` column range. */
export function assertQuantityWithinRange(milli: bigint, errorCode = 'QUANTITY_OUT_OF_RANGE'): void {
  const limit = 10n ** BigInt(QUANTITY_WHOLE_MAX_DIGITS + QUANTITY_SCALE);
  if (milli >= limit || milli <= -limit) {
    throw new PurchasingMathError(errorCode, 'الكمية تتجاوز الحد المسموح');
  }
}

export const sumMilli = (values: Iterable<bigint>): bigint => {
  let total = 0n;
  for (const value of values) total += value;
  return total;
};

/**
 * Receipt/return position for one purchase order line.
 *
 * `remaining` is what may still be received: ordered − (received − returned).
 * A supplier return therefore re-opens the line for a replacement delivery, and
 * the invariant `0 <= net <= ordered` holds unless an audited over-receipt
 * override was applied.
 */
export interface LineQuantityPosition {
  orderedMilli: bigint;
  receivedMilli: bigint;
  returnedMilli: bigint;
  netReceivedMilli: bigint;
  remainingMilli: bigint;
}

export function computeLinePosition(input: {
  orderedMilli: bigint;
  receivedMilli: bigint;
  returnedMilli: bigint;
}): LineQuantityPosition {
  const netReceivedMilli = input.receivedMilli - input.returnedMilli;
  const remainingRaw = input.orderedMilli - netReceivedMilli;
  return {
    orderedMilli: input.orderedMilli,
    receivedMilli: input.receivedMilli,
    returnedMilli: input.returnedMilli,
    netReceivedMilli,
    // Over-receipt (via audited override) makes the raw remainder negative;
    // the receivable quantity is clamped at zero, never reported as negative.
    remainingMilli: remainingRaw > 0n ? remainingRaw : 0n,
  };
}
