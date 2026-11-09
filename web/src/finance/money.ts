import { parseMoneyToCents } from '@/payroll/money';

export { createIdempotencyKey, formatMoneyAmount, normalizeMoneyInput, parseMoneyToCents } from '@/payroll/money';

export function journalLinesBalanced(
  lines: ReadonlyArray<{ debit: string; credit: string }>,
): boolean {
  if (lines.length < 2) return false;
  let debitTotal = 0n;
  let creditTotal = 0n;
  for (const line of lines) {
    const debit = parseMoneyToCents(line.debit);
    const credit = parseMoneyToCents(line.credit);
    if (debit == null || credit == null || debit < 0n || credit < 0n) return false;
    const debitPositive = debit > 0n;
    const creditPositive = credit > 0n;
    if (debitPositive === creditPositive) return false;
    debitTotal += debit;
    creditTotal += credit;
  }
  return debitTotal > 0n && debitTotal === creditTotal;
}
