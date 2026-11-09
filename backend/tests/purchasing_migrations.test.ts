import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'prisma', 'migrations', '20260710000400_purchasing_core', 'migration.sql'),
  'utf8'
);

describe('Sprint 9 purchasing migration', () => {
  it('extends vendors and creates all purchasing tables additively', () => {
    expect(sql).toContain('ALTER TABLE "Vendor"');
    expect(sql).toContain('ADD COLUMN "status" TEXT NOT NULL DEFAULT \'active\'');
    expect(sql).toContain('CREATE TABLE "PurchaseRequest"');
    expect(sql).toContain('CREATE TABLE "PurchaseRequestLine"');
    expect(sql).toContain('CREATE TABLE "PurchaseOrder"');
    expect(sql).toContain('CREATE TABLE "PurchaseOrderLine"');
  });

  it('enforces tenant relations, exact amounts, lifecycle checks, and RLS', () => {
    expect(sql).toContain('PurchaseRequest_requestedByEmployeeId_companyId_fkey');
    expect(sql).toContain('PurchaseOrder_vendorId_companyId_fkey');
    expect(sql).toContain('DECIMAL(18,3)');
    expect(sql).toContain('DECIMAL(18,2)');
    expect(sql).toContain('Vendor_status_check');
    expect(sql).toContain('PurchaseRequest_status_check');
    expect(sql).toContain('PurchaseOrder_status_check');
    expect(sql.match(/ENABLE ROW LEVEL SECURITY/g)?.length).toBe(5);
  });

  it('adds the required partial uniqueness protections', () => {
    expect(sql).toContain('Vendor_companyId_active_name_key');
    expect(sql).toContain('lower(btrim("name"))');
    expect(sql).toContain('WHERE "status" = \'active\'');
    expect(sql).toContain('PurchaseOrder_active_request_key');
    expect(sql).toContain('WHERE "status" <> \'cancelled\'');
  });

  it('does not delete or destructively alter retained data', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
  });
});
