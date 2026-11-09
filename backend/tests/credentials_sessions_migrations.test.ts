import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, isCanonicalPermission } from '../src/permissions.ts';

const backendRoot = fileURLToPath(new URL('..', import.meta.url));
const migration = (relativePath: string) =>
  readFileSync(join(backendRoot, 'prisma', 'migrations', relativePath), 'utf8');

describe('Sprint 12G M06 credentials/sessions migration', () => {
  it('adds credential, archive, and session metadata additively', () => {
    const sql = migration(
      join('20260719000300_rc2_credentials_sessions', 'migration.sql'),
    );

    expect(sql).toContain('mustChangePassword');
    expect(sql).toContain('credentialVersion');
    expect(sql).toContain('accountStatus');
    expect(sql).toContain('archivedAt');
    expect(sql).toContain('archiveReason');
    expect(sql).toContain('sessionId');
    expect(sql).toContain('bindingHash');
    expect(sql).toContain('RefreshToken_userId_companyId_fkey');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "RefreshToken_userId_fkey"');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "RefreshToken_userId_companyId_fkey"');
    expect(sql).toContain('M06 blocked');
    expect(sql).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  it('registers credential and archive permission keys', () => {
    expect(PERMISSIONS.EMPLOYEES_CREDENTIALS_CREATE).toBe('employees.credentials.create');
    expect(PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET).toBe('employees.credentials.reset');
    expect(PERMISSIONS.EMPLOYEES_ARCHIVE).toBe('employees.archive');
    expect(isCanonicalPermission('employees.credentials.create')).toBe(true);
    expect(isCanonicalPermission('employees.credentials.reset')).toBe(true);
    expect(isCanonicalPermission('employees.archive')).toBe(true);
  });
});
