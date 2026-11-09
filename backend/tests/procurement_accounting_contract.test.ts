import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROCUREMENT_ACCOUNTING_POLICY_V1,
  planProcurementPosting,
  type ProcurementAccountingPolicyV1,
} from '../src/procurementAccountingContract';

const inventoryPolicy: ProcurementAccountingPolicyV1 = {
  payableRecognition: 'supplier_bill',
  inventoryValuation: 'perpetual',
  receiptAccounting: 'grni',
  taxAccounting: 'input_vat',
};

describe('procurement accounting contract v1', () => {
  it('fails closed for receipts until inventory valuation and GRNI are configured', () => {
    const plan = planProcurementPosting({
      event: 'purchase_receipt_posted',
      sourceId: 'receipt-1',
      valuationAmount: '1250.00',
    });

    expect(plan.status).toBe('deferred');
    if (plan.status !== 'deferred') return;
    expect(plan.blockers).toEqual([
      'INVENTORY_VALUATION_NOT_CONFIGURED',
      'GRNI_ACCOUNTING_NOT_ENABLED',
    ]);
  });

  it('posts perpetual inventory receipts to inventory and GRNI when explicitly enabled', () => {
    const plan = planProcurementPosting(
      {
        event: 'purchase_receipt_posted',
        sourceId: 'receipt-2',
        valuationAmount: '1250.00',
      },
      inventoryPolicy,
    );

    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.totalDebit).toBe('1250.00');
    expect(plan.totalCredit).toBe('1250.00');
    expect(plan.lines).toEqual([
      {
        accountRole: 'inventory',
        debit: '1250.00',
        credit: '0.00',
        memo: 'Inventory received',
      },
      {
        accountRole: 'goods_received_not_invoiced',
        debit: '0.00',
        credit: '1250.00',
        memo: 'Goods received not invoiced',
      },
    ]);
  });

  it('requires the original receipt posting before accounting for a return', () => {
    const plan = planProcurementPosting(
      {
        event: 'purchase_return_approved',
        sourceId: 'return-1',
        valuationAmount: '100.00',
        sourceReceiptPosted: false,
      },
      inventoryPolicy,
    );

    expect(plan.status).toBe('deferred');
    if (plan.status !== 'deferred') return;
    expect(plan.blockers).toContain('SOURCE_RECEIPT_POSTING_REQUIRED');
  });

  it('recognizes AP at an expense supplier bill, not at receipt', () => {
    const plan = planProcurementPosting(
      {
        event: 'supplier_bill_posted',
        sourceId: 'bill-1',
        expenseOrInventory: 'expense',
        netAmount: '1000.00',
        taxAmount: '0.00',
        grossAmount: '1000.00',
      },
      DEFAULT_PROCUREMENT_ACCOUNTING_POLICY_V1,
    );

    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.lines.map((line) => line.accountRole)).toEqual([
      'purchase_expense',
      'accounts_payable',
    ]);
    expect(plan.totalDebit).toBe('1000.00');
  });

  it('adds recoverable input VAT only when tax accounting is configured', () => {
    const plan = planProcurementPosting(
      {
        event: 'supplier_bill_posted',
        sourceId: 'bill-vat',
        expenseOrInventory: 'expense',
        netAmount: '1000.00',
        taxAmount: '150.00',
        grossAmount: '1150.00',
      },
      { ...DEFAULT_PROCUREMENT_ACCOUNTING_POLICY_V1, taxAccounting: 'input_vat' },
    );

    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.lines.map((line) => line.accountRole)).toEqual([
      'purchase_expense',
      'input_vat',
      'accounts_payable',
    ]);
    expect(plan.totalDebit).toBe('1150.00');
    expect(plan.totalCredit).toBe('1150.00');
  });

  it('blocks non-zero tax instead of silently discarding it', () => {
    const plan = planProcurementPosting({
      event: 'supplier_bill_posted',
      sourceId: 'bill-vat-blocked',
      expenseOrInventory: 'expense',
      netAmount: '1000.00',
      taxAmount: '150.00',
      grossAmount: '1150.00',
    });

    expect(plan.status).toBe('deferred');
    if (plan.status !== 'deferred') return;
    expect(plan.blockers).toEqual(['TAX_ACCOUNTING_NOT_CONFIGURED']);
  });

  it('requires exact inventory matching until a price-variance policy exists', () => {
    const plan = planProcurementPosting(
      {
        event: 'supplier_bill_posted',
        sourceId: 'inventory-bill-1',
        expenseOrInventory: 'inventory',
        netAmount: '1000.00',
        taxAmount: '0.00',
        grossAmount: '1000.00',
        matchedReceiptNetAmount: '990.00',
      },
      inventoryPolicy,
    );

    expect(plan.status).toBe('deferred');
    if (plan.status !== 'deferred') return;
    expect(plan.blockers).toEqual(['PRICE_VARIANCE_POLICY_REQUIRED']);
  });

  it('settles AP against a selected cash/bank role using exact money strings', () => {
    const plan = planProcurementPosting({
      event: 'supplier_payment_posted',
      sourceId: 'payment-1',
      amount: '1250.35',
      settlementAccountRole: 'bank',
      currency: 'sar',
    });

    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.currency).toBe('SAR');
    expect(plan.lines.map((line) => line.accountRole)).toEqual(['accounts_payable', 'bank']);
    expect(plan.totalDebit).toBe('1250.35');
    expect(plan.totalCredit).toBe('1250.35');
  });

  it('rejects scientific and inconsistent monetary input', () => {
    expect(() => planProcurementPosting({
      event: 'supplier_payment_posted',
      sourceId: 'payment-bad',
      amount: '1e3',
      settlementAccountRole: 'cash',
    })).toThrow('exact decimal money string');

    expect(() => planProcurementPosting(
      {
        event: 'supplier_bill_posted',
        sourceId: 'bill-bad-total',
        expenseOrInventory: 'expense',
        netAmount: '100.00',
        taxAmount: '15.00',
        grossAmount: '114.99',
      },
      { ...DEFAULT_PROCUREMENT_ACCOUNTING_POLICY_V1, taxAccounting: 'input_vat' },
    )).toThrow('grossAmount must equal netAmount + taxAmount');
  });
});
