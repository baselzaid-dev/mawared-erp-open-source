import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, isCanonicalPermission } from '../src/permissions.ts';

const backendRoot = fileURLToPath(new URL('..', import.meta.url));
const migration = (relativePath: string) =>
  readFileSync(join(backendRoot, 'prisma', 'migrations', relativePath), 'utf8');

describe('Sprint 12I M08 vendor purchasing lifecycle migration', () => {
  it('adds Vendor archive fields and PurchaseWorkflowEvent additively', () => {
    const sql = migration(join('20260719000500_rc2_vendor_purchasing_lifecycle', 'migration.sql'));

    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "Vendor_status_check"');
    expect(sql).toContain('lifecycleVersion');
    expect(sql).toContain('archivedAt');
    expect(sql).toContain('CREATE TABLE "PurchaseWorkflowEvent"');
    expect(sql).toContain('override_approve');
    expect(sql).toContain('Vendor_archive_pair_check');
    expect(sql).toContain('PurchaseWorkflowEvent_actorUserId_companyId_fkey');
    expect(sql).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
  });

  it('registers purchasing override and vendor archive permission keys', () => {
    expect(PERMISSIONS.PURCHASING_ADMIN_OVERRIDE).toBe('purchasing.admin_override');
    expect(PERMISSIONS.VENDORS_ARCHIVE).toBe('vendors.archive');
    expect(isCanonicalPermission('purchasing.admin_override')).toBe(true);
    expect(isCanonicalPermission('vendors.archive')).toBe(true);
  });
});
