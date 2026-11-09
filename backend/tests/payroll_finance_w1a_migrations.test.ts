import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, isCanonicalPermission } from '../src/permissions.ts';

const backendRoot = fileURLToPath(new URL('..', import.meta.url));
const migration = (relativePath: string) =>
  readFileSync(join(backendRoot, 'prisma', 'migrations', relativePath), 'utf8');

describe('Commercial W1A payroll finance migration safety', () => {
  it('adds finance and payroll foundation tables additively', () => {
    const sql = migration(join(
      '20260807000100_commercial_w1a_payroll_finance_foundation',
      'migration.sql',
    ));

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "CostCenter"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "JournalEntry"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "JournalEntryLine"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "PayrollLedgerPosting"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "PayrollComponentDefinition"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "PayrollItemComponentLine"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "PayrollItemAdjustment"');
    expect(sql).toContain('"idempotencyKey" TEXT NOT NULL');
    expect(sql).toContain('PayrollItemAdjustment_companyId_idempotencyKey_key');
    expect(sql).toContain('reopenedByUserId');
    expect(sql).toContain('ledgerPostedAt');
    expect(sql).toContain('ChartOfAccount_companyId_code_key');
    expect(sql).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(sql).not.toMatch(/^\s*DROP\s+CONSTRAINT\b/im);
  });

  it('registers W1A payroll permission keys', () => {
    expect(PERMISSIONS.PAYROLL_ITEM_ADJUST).toBe('payroll.item.adjust');
    expect(PERMISSIONS.PAYROLL_PERIOD_REOPEN).toBe('payroll.period.reopen');
    expect(isCanonicalPermission('payroll.item.adjust')).toBe(true);
    expect(isCanonicalPermission('payroll.period.reopen')).toBe(true);
  });
});
