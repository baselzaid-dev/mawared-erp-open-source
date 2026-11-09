import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const backendRoot = fileURLToPath(new URL('..', import.meta.url));
const migration = (relativePath: string) =>
  readFileSync(join(backendRoot, 'prisma', 'migrations', relativePath), 'utf8');

describe('Sprint 6A migration files', () => {
  it('keeps the baseline limited to the pre-Sprint-6A schema', () => {
    const sql = migration(join('0_init', 'migration.sql'));

    expect(sql).toContain('CREATE TABLE "PayrollPeriod"');
    expect(sql.match(/CREATE TABLE /g)).toHaveLength(14);
    expect(sql).toContain('CONSTRAINT "Employee_companyId_fkey"');
    expect(sql).toContain('CONSTRAINT "ChartOfAccount_companyId_fkey"');
    expect(sql).toContain('"idx_Employee_companyId"');
    expect(sql).toContain('"idx_Employee_departmentId"');
    expect(sql).toContain('"idx_User_companyId"');
    expect(sql).toContain('"idx_User_roleId"');
    expect(sql).toContain('"Role_companyId_lower_name_key"');
    expect(sql).toMatch(/\("companyId", lower\(name\)\)/);
    expect(sql).not.toContain('SalaryRecord');
    expect(sql).not.toContain('PayrollItem');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
  });

  it('keeps the salary/payroll migration additive and Decimal-safe', () => {
    const sql = migration(
      join('20260710000100_salary_payroll_foundation', 'migration.sql')
    );

    expect(sql).toContain('CREATE TABLE "SalaryRecord"');
    expect(sql).toContain('CREATE TABLE "PayrollItem"');
    expect(sql).toContain('DECIMAL(18,2)');
    expect(sql).toContain('SalaryRecord_one_open_record_per_employee_key');
    expect(sql).toContain('SalaryRecord_baseSalary_nonnegative_check');
    expect(sql).toContain('PayrollItem_netPay_consistency_check');
    expect(sql).toContain('PayrollPeriod_companyId_year_month_key');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
  });
});
