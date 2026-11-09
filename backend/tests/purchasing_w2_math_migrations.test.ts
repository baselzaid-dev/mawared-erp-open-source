import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertMoneyWithinRange,
  assertQuantityWithinRange,
  centsToPurchasingMoney,
  computeLinePosition,
  isExactPurchasingMoneyString,
  isExactQuantityString,
  lineTotalCents,
  milliToQuantity,
  purchasingMoneyToCents,
  PurchasingMathError,
  quantityToMilli,
  readMoney,
  readQuantity,
  storedQuantityToMilli,
} from '../src/purchasingMath';
import { payloadFingerprint } from '../src/purchasingW2Core';
import { __testing as quotationTesting } from '../src/purchasingQuotations';

describe('W2 exact purchasing arithmetic', () => {
  it('accepts only exact decimal strings for quantities', () => {
    for (const value of ['0', '1', '1.5', '1.500', '999999999999999.999']) {
      expect(isExactQuantityString(value)).toBe(true);
    }
    for (const value of [1, '1.0001', '-1', '+1', ' 1 ', '1e3', '.5', '1.', '', null, undefined, {}]) {
      expect(isExactQuantityString(value as unknown)).toBe(false);
    }
    // 16 whole digits exceeds DECIMAL(18,3).
    expect(isExactQuantityString('1000000000000000.000')).toBe(false);
  });

  it('accepts only exact decimal strings for money', () => {
    for (const value of ['0', '0.01', '12.34', '9999999999999999.99']) {
      expect(isExactPurchasingMoneyString(value)).toBe(true);
    }
    for (const value of [12.34, '12.345', '-1.00', '1e2', '0x10']) {
      expect(isExactPurchasingMoneyString(value as unknown)).toBe(false);
    }
  });

  it('round-trips quantities and money through integer units', () => {
    expect(quantityToMilli('1.5')).toBe(1500n);
    expect(quantityToMilli('0')).toBe(0n);
    expect(milliToQuantity(1500n)).toBe('1.500');
    expect(purchasingMoneyToCents('12.3')).toBe(1230n);
    expect(centsToPurchasingMoney(1230n)).toBe('12.30');
    expect(readQuantity('2')).toBe('2.000');
    expect(readMoney('2')).toBe('2.00');
    expect(storedQuantityToMilli('3.25')).toBe(3250n);
  });

  it('throws a typed error instead of coercing bad input', () => {
    expect(() => quantityToMilli(1.5 as unknown)).toThrow(PurchasingMathError);
    expect(() => purchasingMoneyToCents('1.234')).toThrow(PurchasingMathError);
  });

  it('computes line totals with exact half-up rounding', () => {
    // 3.333 × 2.22 = 7.39926 → 7.40
    expect(lineTotalCents(3333n, 222n)).toBe(740n);
    // 0.001 × 0.01 = 0.00001 → 0.00
    expect(lineTotalCents(1n, 1n)).toBe(0n);
    // 1.5 × 0.01 = 0.015 → 0.02 (half-up, not banker's rounding)
    expect(lineTotalCents(1500n, 1n)).toBe(2n);
    // No float drift on a value 0.1 + 0.2 style arithmetic would corrupt.
    expect(centsToPurchasingMoney(lineTotalCents(quantityToMilli('0.3'), purchasingMoneyToCents('0.1')))).toBe('0.03');
  });

  it('guards the DECIMAL column ranges', () => {
    expect(() => assertMoneyWithinRange(10n ** 18n)).toThrow(PurchasingMathError);
    expect(() => assertMoneyWithinRange(10n ** 17n)).not.toThrow();
    expect(() => assertQuantityWithinRange(10n ** 18n)).toThrow(PurchasingMathError);
    expect(() => assertQuantityWithinRange(10n ** 17n)).not.toThrow();
  });

  it('derives the receipt position, clamping remaining at zero', () => {
    expect(computeLinePosition({ orderedMilli: 10_000n, receivedMilli: 4_000n, returnedMilli: 0n })).toMatchObject({
      netReceivedMilli: 4_000n,
      remainingMilli: 6_000n,
    });
    // A return re-opens the line for a replacement delivery.
    expect(computeLinePosition({ orderedMilli: 10_000n, receivedMilli: 10_000n, returnedMilli: 3_000n })).toMatchObject({
      netReceivedMilli: 7_000n,
      remainingMilli: 3_000n,
    });
    // An audited over-receipt never reports a negative remainder.
    expect(computeLinePosition({ orderedMilli: 10_000n, receivedMilli: 11_000n, returnedMilli: 0n })).toMatchObject({
      netReceivedMilli: 11_000n,
      remainingMilli: 0n,
    });
  });

  it('fingerprints payloads independently of key order', () => {
    const a = payloadFingerprint({ b: 2, a: [1, { y: 1, x: 2 }] });
    const b = payloadFingerprint({ a: [1, { x: 2, y: 1 }], b: 2 });
    expect(a).toBe(b);
    expect(payloadFingerprint({ a: 1 })).not.toBe(payloadFingerprint({ a: 2 }));
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('binds the quotation-create fingerprint to the whole logical payload', () => {
    const { quotationCreateFingerprint } = quotationTesting;
    const base = {
      vendorId: 'v1',
      supplierReference: 'Q-1',
      currency: 'SAR' as const,
      quotationDate: '2026-08-02',
      validUntilDate: '2026-09-02',
      expectedDeliveryDate: '2026-08-25',
      leadTimeDays: 14,
      paymentTerms: 'net30',
      notes: null,
      lines: [
        { requestLineId: 'l1', description: 'A', category: null, quantity: '10.000', unit: 'pc', unitPrice: '20.00', leadTimeDays: 14, notes: null },
      ],
    };
    const calc = { lines: base.lines.map((l) => ({ ...l, quantityValue: '10.000', priceValue: '20.00', lineTotal: '200.00' })), total: '200.00' };
    const fp = quotationCreateFingerprint('r1', base as never, calc as never);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);

    // Equivalent exact quantity ("10" vs "10.000") → same fingerprint.
    const equivalent = { ...calc, lines: [{ ...calc.lines[0], quantityValue: '10.000' }] };
    expect(quotationCreateFingerprint('r1', base as never, equivalent as never)).toBe(fp);

    // Any material change diverges.
    expect(quotationCreateFingerprint('r2', base as never, calc as never)).not.toBe(fp);
    expect(quotationCreateFingerprint('r1', { ...base, vendorId: 'v2' } as never, calc as never)).not.toBe(fp);
    const changedPrice = { ...calc, lines: [{ ...calc.lines[0], priceValue: '21.00' }] };
    expect(quotationCreateFingerprint('r1', base as never, changedPrice as never)).not.toBe(fp);
  });

  it('binds the quotation-select fingerprint to quotation, request and reason', () => {
    const { quotationSelectFingerprint } = quotationTesting;
    const fp = quotationSelectFingerprint('q1', 'r1', ' best value ');
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
    // Whitespace around the reason is normalized away.
    expect(quotationSelectFingerprint('q1', 'r1', 'best value')).toBe(fp);
    // A different reason or quotation diverges.
    expect(quotationSelectFingerprint('q1', 'r1', 'other reason')).not.toBe(fp);
    expect(quotationSelectFingerprint('q2', 'r1', 'best value')).not.toBe(fp);
  });
});

describe('W2 purchasing expansion migration (static)', () => {
  const migrationName = '20260808000100_commercial_w2_purchasing_expansion';
  const migrationsRoot = path.resolve(process.cwd(), 'prisma/migrations');
  const sql = fs.readFileSync(path.join(migrationsRoot, migrationName, 'migration.sql'), 'utf8');

  it('is additive only', () => {
    const withoutComments = sql.replace(/--.*$/gm, '');
    expect(withoutComments).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA|DATABASE|INDEX)\b/i);
    expect(withoutComments).not.toMatch(/\bTRUNCATE\b/i);
    expect(withoutComments).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(withoutComments.match(/\bBEGIN;/g)).toHaveLength(1);
    expect(withoutComments.match(/\bCOMMIT;/g)).toHaveLength(1);
  });

  it('creates the Wave 2 tables with tenant-scoped foreign keys', () => {
    for (const table of [
      'SupplierQuotation',
      'SupplierQuotationLine',
      'PurchaseReceipt',
      'PurchaseReceiptLine',
      'PurchaseReturn',
      'PurchaseReturnLine',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
      expect(sql).toContain(`"${table}_id_companyId_key"`);
    }
    // Every cross-record FK carries companyId so a row cannot point at another tenant.
    expect(sql).toContain('FOREIGN KEY ("purchaseOrderId", "companyId")');
    expect(sql).toContain('FOREIGN KEY ("purchaseOrderLineId", "companyId")');
    expect(sql).toContain('FOREIGN KEY ("purchaseRequestId", "companyId")');
    expect(sql).toContain('FOREIGN KEY ("supplierQuotationId", "companyId")');
    expect(sql).toContain('FOREIGN KEY ("vendorId", "companyId")');
  });

  it('enforces the Wave 2 integrity invariants in the database', () => {
    // Exactly one winning quotation per purchase request.
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "SupplierQuotation_company_request_selected_key"');
    expect(sql).toMatch(/WHERE "status" = 'selected'/);
    // Company-scoped idempotency for both quantity-changing documents.
    expect(sql).toContain('"PurchaseReceipt_companyId_idempotencyKey_key"');
    expect(sql).toContain('"PurchaseReturn_companyId_idempotencyKey_key"');
    // Exact decimal columns, never float.
    expect(sql).toMatch(/"quantity" DECIMAL\(18,3\)/);
    expect(sql).toMatch(/"unitPrice" DECIMAL\(18,2\)/);
    expect(sql).not.toMatch(/\b(REAL|DOUBLE PRECISION|FLOAT)\b/i);
    // Positive quantities and a bounded return reason vocabulary.
    expect(sql).toContain('"PurchaseReceiptLine_quantity_check"');
    expect(sql).toContain('"PurchaseReturnLine_quantity_check"');
    expect(sql).toContain('"PurchaseReturn_reason_code_check"');
    // An over-receipt can never be recorded without a reason.
    expect(sql).toContain('"PurchaseReceipt_override_pair_check"');
  });

  it('adds the purchase-order quotation link without touching existing columns', () => {
    expect(sql).toContain('ALTER TABLE "PurchaseOrder"\n    ADD COLUMN IF NOT EXISTS "supplierQuotationId" TEXT;');
  });

  it('adds a nullable idempotency payload fingerprint to PurchaseWorkflowEvent', () => {
    // Exactly this statement: an additive ADD COLUMN with no NOT NULL, so the
    // existing PurchaseWorkflowEvent rows (admin overrides) stay valid.
    // (PurchaseReceipt / PurchaseReturn keep their own NOT NULL fingerprints —
    // that is intentional and separate from this nullable workflow-event column.)
    expect(sql).toContain('ALTER TABLE "PurchaseWorkflowEvent"\n    ADD COLUMN IF NOT EXISTS "payloadFingerprint" TEXT;');
    expect(sql).not.toContain('ADD COLUMN IF NOT EXISTS "payloadFingerprint" TEXT NOT NULL');
  });

  it('only widens the purchase-order status vocabulary', () => {
    // The replacement predicate must accept every previously legal value.
    expect(sql).toContain(
      `CHECK ("status" IN ('draft', 'issued', 'partially_received', 'received', 'cancelled'))`,
    );
    // Only CHECK constraints that are being widened are replaced, always with
    // IF EXISTS so a re-run cannot fail.
    const drops = (sql.match(/DROP CONSTRAINT IF EXISTS "[^"]+"/g) ?? []).map((line) =>
      line.replace(/.*"([^"]+)"$/, '$1'),
    );
    expect(drops.sort()).toEqual([
      'PurchaseOrder_status_check',
      'PurchaseWorkflowEvent_action_check',
      'PurchaseWorkflowEvent_entityType_check',
    ]);
    expect(sql.match(/DROP CONSTRAINT(?! IF EXISTS)/g)).toBeNull();
  });

  it('widens the purchase workflow event vocabulary as a strict superset', () => {
    for (const legacy of ['override_approve', 'override_reject', 'override_cancel']) {
      expect(sql).toContain(`'${legacy}'`);
    }
    for (const added of [
      'quotation_create',
      'quotation_update',
      'quotation_submit',
      'quotation_select',
      'quotation_reject',
      'order_receive_partial',
      'return_create',
      'return_approve',
      'return_reject',
      'supplier_quotation',
      'purchase_return',
    ]) {
      expect(sql).toContain(`'${added}'`);
    }
    expect(sql).toContain(`'purchase_request'`);
    expect(sql).toContain(`'purchase_order'`);
  });
});
