import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, isCanonicalPermission } from '../src/permissions.ts';

const backendRoot = fileURLToPath(new URL('..', import.meta.url));
const migration = (relativePath: string) =>
  readFileSync(join(backendRoot, 'prisma', 'migrations', relativePath), 'utf8');

describe('Sprint 12H M07 payroll payments migration', () => {
  it('adds PayrollPayment ledger and paymentVersion additively', () => {
    const sql = migration(join('20260719000400_rc2_payroll_payments', 'migration.sql'));

    expect(sql).toContain('CREATE TABLE "PayrollPayment"');
    expect(sql).toContain('paymentVersion');
    expect(sql).toContain('idempotencyKey');
    expect(sql).toContain('isLegacyMigration');
    expect(sql).toContain('LEGACY_M07_MIGRATION');
    expect(sql).toContain('PayrollPayment_amount_positive_check');
    expect(sql).toContain('PayrollPayment_payrollPeriodId_companyId_fkey');
    expect(sql).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
  });

  it('registers payroll payment permission keys', () => {
    expect(PERMISSIONS.PAYROLL_PAYMENTS_VIEW).toBe('payroll.payments.view');
    expect(PERMISSIONS.PAYROLL_PAYMENTS_RECORD).toBe('payroll.payments.record');
    expect(PERMISSIONS.PAYROLL_PAYMENTS_VOID).toBe('payroll.payments.void');
    expect(isCanonicalPermission('payroll.payments.view')).toBe(true);
    expect(isCanonicalPermission('payroll.payments.record')).toBe(true);
    expect(isCanonicalPermission('payroll.payments.void')).toBe(true);
  });
});
