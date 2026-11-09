import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, PERMISSIONS } from '../src/permissions';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma',
    'migrations',
    '20260710000600_reporting_security_indexes',
    'migration.sql'
  ),
  'utf8'
);

const preview = readFileSync(
  join(
    process.cwd(),
    'prisma',
    'permission-previews',
    'sprint11_reporting_permissions_preview.sql'
  ),
  'utf8'
);

describe('Sprint 11 reporting permissions and indexes', () => {
  it('registers reports.export as a canonical permission', () => {
    expect(PERMISSIONS.REPORTS_EXPORT).toBe('reports.export');
    expect(ALL_PERMISSIONS).toContain(PERMISSIONS.REPORTS_EXPORT);
  });

  it('creates only the seven demonstrated reporting indexes', () => {
    expect(migration.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(7);
    expect(migration).toContain('"AuditLog"("companyId", "createdAt")');
    expect(migration).toContain('"AuditLog"("companyId", "action", "createdAt")');
    expect(migration).toContain('"Notification"("userId", "isRead", "createdAt")');
    expect(migration).toContain('"Attendance"("companyId", "employeeId", "date")');
    expect(migration).toContain('"LeaveRequest"("companyId", "status", "createdAt")');
  });

  it('contains no destructive or data-mutating SQL', () => {
    expect(migration).not.toMatch(/\b(?:DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER)\b/i);
  });

  it('keeps the permission preview read-only and scoped to the managed subset', () => {
    expect(preview).toContain("('reports.export')");
    expect(preview).toContain("('Department Manager', '[\"reports.export\"]'::jsonb)");
    expect(preview).toContain("('Employee', '[]'::jsonb)");
    expect(preview).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|ALTER|DROP)\b/i);
  });
});
