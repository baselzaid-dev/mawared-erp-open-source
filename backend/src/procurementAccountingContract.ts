import {
  centsToMoney,
  isExactMoneyDecimalString,
  moneyToCents,
} from './payrollMoney';

/**
 * Procurement -> Accounting contract v1.
 *
 * Clean-room implementation derived from standard double-entry accounting
 * workflows. External open-source accounting systems are product/domain
 * references only; no external source code is copied here.
 *
 * This module intentionally produces an account-role posting plan instead of
 * database account ids. A later company-scoped account-role resolver maps each
 * role to a concrete ChartOfAccount before creating a JournalEntry.
 */

export const PROCUREMENT_ACCOUNTING_CONTRACT_VERSION = 1 as const;

export const PROCUREMENT_ACCOUNT_ROLES = [
  'accounts_payable',
  'inventory',
  'goods_received_not_invoiced',
  'purchase_expense',
  'input_vat',
  'bank',
  'cash',
] as const;

export type ProcurementAccountRole = (typeof PROCUREMENT_ACCOUNT_ROLES)[number];

export type ProcurementAccountingEvent =
  | 'purchase_receipt_posted'
  | 'purchase_return_approved'
  | 'supplier_bill_posted'
  | 'supplier_payment_posted';

export type ProcurementAccountingBlocker =
  | 'INVENTORY_VALUATION_NOT_CONFIGURED'
  | 'GRNI_ACCOUNTING_NOT_ENABLED'
  | 'TAX_ACCOUNTING_NOT_CONFIGURED'
  | 'SOURCE_RECEIPT_POSTING_REQUIRED'
  | 'SUPPLIER_BILL_MATCH_REQUIRED'
  | 'PRICE_VARIANCE_POLICY_REQUIRED';

export interface ProcurementAccountingPolicyV1 {
  /** AP is recognized only when the supplier bill is posted in v1. */
  payableRecognition: 'supplier_bill';
  /** No inventory journal is permitted until perpetual valuation is enabled. */
  inventoryValuation: 'disabled' | 'perpetual';
  /** Receipt posting is either deliberately absent or uses Inventory <-> GRNI. */
  receiptAccounting: 'none' | 'grni';
  /** VAT is fail-closed: a non-zero tax cannot be silently ignored. */
  taxAccounting: 'disabled' | 'input_vat';
}

export const DEFAULT_PROCUREMENT_ACCOUNTING_POLICY_V1: ProcurementAccountingPolicyV1 = {
  payableRecognition: 'supplier_bill',
  inventoryValuation: 'disabled',
  receiptAccounting: 'none',
  taxAccounting: 'disabled',
};

interface BasePostingInput {
  sourceId: string;
  currency?: string;
}

export interface PurchaseReceiptPostingInput extends BasePostingInput {
  event: 'purchase_receipt_posted';
  /** Exact inventory valuation for this receipt, not PO price arithmetic. */
  valuationAmount: string;
}

export interface PurchaseReturnPostingInput extends BasePostingInput {
  event: 'purchase_return_approved';
  /** Exact valuation being reversed from the posted receipt. */
  valuationAmount: string;
  /** The source receipt must already have produced an accounting posting. */
  sourceReceiptPosted: boolean;
}

export interface SupplierBillPostingInput extends BasePostingInput {
  event: 'supplier_bill_posted';
  expenseOrInventory: 'expense' | 'inventory';
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
  /**
   * Required for inventory bills in v1. It represents the GRNI amount matched
   * to posted receipts. V1 deliberately blocks price variance instead of
   * inventing a variance account/tolerance policy.
   */
  matchedReceiptNetAmount?: string;
}

export interface SupplierPaymentPostingInput extends BasePostingInput {
  event: 'supplier_payment_posted';
  amount: string;
  settlementAccountRole: 'bank' | 'cash';
}

export type ProcurementPostingInput =
  | PurchaseReceiptPostingInput
  | PurchaseReturnPostingInput
  | SupplierBillPostingInput
  | SupplierPaymentPostingInput;

export interface ProcurementPostingLine {
  accountRole: ProcurementAccountRole;
  debit: string;
  credit: string;
  memo: string;
}

export interface ReadyProcurementPostingPlan {
  status: 'ready';
  contractVersion: typeof PROCUREMENT_ACCOUNTING_CONTRACT_VERSION;
  sourceType: ProcurementAccountingEvent;
  sourceId: string;
  currency: string;
  lines: ProcurementPostingLine[];
  totalDebit: string;
  totalCredit: string;
}

export interface DeferredProcurementPostingPlan {
  status: 'deferred';
  contractVersion: typeof PROCUREMENT_ACCOUNTING_CONTRACT_VERSION;
  sourceType: ProcurementAccountingEvent;
  sourceId: string;
  currency: string;
  blockers: ProcurementAccountingBlocker[];
}

export type ProcurementPostingPlan =
  | ReadyProcurementPostingPlan
  | DeferredProcurementPostingPlan;

const requireSourceId = (sourceId: string): string => {
  const normalized = sourceId.trim();
  if (!normalized) throw new Error('sourceId is required');
  if (normalized.length > 191) throw new Error('sourceId is too long');
  return normalized;
};

const normalizeCurrency = (currency?: string): string => {
  const normalized = (currency ?? 'SAR').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) throw new Error('currency must be a 3-letter ISO code');
  return normalized;
};

const exactNonNegativeCents = (label: string, value: string): bigint => {
  if (!isExactMoneyDecimalString(value)) {
    throw new Error(`${label} must be an exact decimal money string`);
  }
  const cents = moneyToCents(value);
  if (cents < 0n) throw new Error(`${label} cannot be negative`);
  return cents;
};

const exactPositiveCents = (label: string, value: string): bigint => {
  const cents = exactNonNegativeCents(label, value);
  if (cents === 0n) throw new Error(`${label} must be greater than zero`);
  return cents;
};

const debitLine = (
  accountRole: ProcurementAccountRole,
  cents: bigint,
  memo: string,
): ProcurementPostingLine => ({
  accountRole,
  debit: centsToMoney(cents),
  credit: '0.00',
  memo,
});

const creditLine = (
  accountRole: ProcurementAccountRole,
  cents: bigint,
  memo: string,
): ProcurementPostingLine => ({
  accountRole,
  debit: '0.00',
  credit: centsToMoney(cents),
  memo,
});

export const assertProcurementPostingPlanBalanced = (
  lines: ProcurementPostingLine[],
): { totalDebit: string; totalCredit: string } => {
  if (lines.length < 2) throw new Error('posting plan requires at least two lines');

  let debit = 0n;
  let credit = 0n;

  for (const line of lines) {
    const lineDebit = exactNonNegativeCents('line.debit', line.debit);
    const lineCredit = exactNonNegativeCents('line.credit', line.credit);
    if ((lineDebit === 0n) === (lineCredit === 0n)) {
      throw new Error('each posting line must contain exactly one positive debit or credit');
    }
    debit += lineDebit;
    credit += lineCredit;
  }

  if (debit === 0n || debit !== credit) {
    throw new Error('posting plan is not balanced');
  }

  return { totalDebit: centsToMoney(debit), totalCredit: centsToMoney(credit) };
};

const deferred = (
  input: ProcurementPostingInput,
  blockers: ProcurementAccountingBlocker[],
): DeferredProcurementPostingPlan => ({
  status: 'deferred',
  contractVersion: PROCUREMENT_ACCOUNTING_CONTRACT_VERSION,
  sourceType: input.event,
  sourceId: requireSourceId(input.sourceId),
  currency: normalizeCurrency(input.currency),
  blockers: [...new Set(blockers)],
});

const ready = (
  input: ProcurementPostingInput,
  lines: ProcurementPostingLine[],
): ReadyProcurementPostingPlan => {
  const totals = assertProcurementPostingPlanBalanced(lines);
  return {
    status: 'ready',
    contractVersion: PROCUREMENT_ACCOUNTING_CONTRACT_VERSION,
    sourceType: input.event,
    sourceId: requireSourceId(input.sourceId),
    currency: normalizeCurrency(input.currency),
    lines,
    ...totals,
  };
};

const planReceipt = (
  input: PurchaseReceiptPostingInput,
  policy: ProcurementAccountingPolicyV1,
): ProcurementPostingPlan => {
  const value = exactPositiveCents('valuationAmount', input.valuationAmount);
  const blockers: ProcurementAccountingBlocker[] = [];
  if (policy.inventoryValuation !== 'perpetual') blockers.push('INVENTORY_VALUATION_NOT_CONFIGURED');
  if (policy.receiptAccounting !== 'grni') blockers.push('GRNI_ACCOUNTING_NOT_ENABLED');
  if (blockers.length) return deferred(input, blockers);

  return ready(input, [
    debitLine('inventory', value, 'Inventory received'),
    creditLine('goods_received_not_invoiced', value, 'Goods received not invoiced'),
  ]);
};

const planReturn = (
  input: PurchaseReturnPostingInput,
  policy: ProcurementAccountingPolicyV1,
): ProcurementPostingPlan => {
  const value = exactPositiveCents('valuationAmount', input.valuationAmount);
  const blockers: ProcurementAccountingBlocker[] = [];
  if (!input.sourceReceiptPosted) blockers.push('SOURCE_RECEIPT_POSTING_REQUIRED');
  if (policy.inventoryValuation !== 'perpetual') blockers.push('INVENTORY_VALUATION_NOT_CONFIGURED');
  if (policy.receiptAccounting !== 'grni') blockers.push('GRNI_ACCOUNTING_NOT_ENABLED');
  if (blockers.length) return deferred(input, blockers);

  return ready(input, [
    debitLine('goods_received_not_invoiced', value, 'Reverse GRNI for returned goods'),
    creditLine('inventory', value, 'Inventory returned to supplier'),
  ]);
};

const planSupplierBill = (
  input: SupplierBillPostingInput,
  policy: ProcurementAccountingPolicyV1,
): ProcurementPostingPlan => {
  const net = exactPositiveCents('netAmount', input.netAmount);
  const tax = exactNonNegativeCents('taxAmount', input.taxAmount);
  const gross = exactPositiveCents('grossAmount', input.grossAmount);
  if (net + tax !== gross) throw new Error('grossAmount must equal netAmount + taxAmount');

  if (tax > 0n && policy.taxAccounting !== 'input_vat') {
    return deferred(input, ['TAX_ACCOUNTING_NOT_CONFIGURED']);
  }

  if (input.expenseOrInventory === 'inventory') {
    const blockers: ProcurementAccountingBlocker[] = [];
    if (policy.inventoryValuation !== 'perpetual') blockers.push('INVENTORY_VALUATION_NOT_CONFIGURED');
    if (policy.receiptAccounting !== 'grni') blockers.push('GRNI_ACCOUNTING_NOT_ENABLED');
    if (input.matchedReceiptNetAmount === undefined) {
      blockers.push('SUPPLIER_BILL_MATCH_REQUIRED');
    } else {
      const matched = exactNonNegativeCents('matchedReceiptNetAmount', input.matchedReceiptNetAmount);
      if (matched !== net) blockers.push('PRICE_VARIANCE_POLICY_REQUIRED');
    }
    if (blockers.length) return deferred(input, blockers);
  }

  const lines: ProcurementPostingLine[] = [
    debitLine(
      input.expenseOrInventory === 'inventory'
        ? 'goods_received_not_invoiced'
        : 'purchase_expense',
      net,
      input.expenseOrInventory === 'inventory'
        ? 'Clear matched GRNI at supplier bill'
        : 'Recognize supplier expense',
    ),
  ];

  if (tax > 0n) lines.push(debitLine('input_vat', tax, 'Recognize recoverable input VAT'));
  lines.push(creditLine('accounts_payable', gross, 'Recognize supplier payable'));
  return ready(input, lines);
};

const planSupplierPayment = (
  input: SupplierPaymentPostingInput,
): ProcurementPostingPlan => {
  const amount = exactPositiveCents('amount', input.amount);
  return ready(input, [
    debitLine('accounts_payable', amount, 'Settle supplier payable'),
    creditLine(input.settlementAccountRole, amount, 'Supplier payment'),
  ]);
};

/**
 * Pure, deterministic planner. It performs no database writes and never invents
 * account ids. `ready` means the accounting outcome is fully specified by the
 * v1 contract; `deferred` means automatic posting must not occur yet.
 */
export const planProcurementPosting = (
  input: ProcurementPostingInput,
  policy: ProcurementAccountingPolicyV1 = DEFAULT_PROCUREMENT_ACCOUNTING_POLICY_V1,
): ProcurementPostingPlan => {
  requireSourceId(input.sourceId);
  normalizeCurrency(input.currency);

  switch (input.event) {
    case 'purchase_receipt_posted':
      return planReceipt(input, policy);
    case 'purchase_return_approved':
      return planReturn(input, policy);
    case 'supplier_bill_posted':
      return planSupplierBill(input, policy);
    case 'supplier_payment_posted':
      return planSupplierPayment(input);
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
};
