import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Platform control-plane migration', () => {
  const sql = fs.readFileSync(
    path.resolve(
      process.cwd(),
      'prisma/migrations/20260721000200_rc2_platform_control_plane/migration.sql',
    ),
    'utf8',
  );

  it('uses separate principals, truthful attribution, RLS, and no M02 inference', () => {
    expect(sql).toContain('CREATE TABLE "PlatformPrincipal"');
    expect(sql).toContain('CREATE TABLE "PlatformRefreshToken"');
    expect(sql).toContain('CREATE TABLE "PlatformMfaCredential"');
    expect(sql).toContain('CREATE TABLE "PlatformAuditLog"');
    expect(sql).toContain('"CompanyOwnership_exactly_one_creator_check"');
    expect(sql).toContain('"AttendanceExemption_exactly_one_creator_check"');
    expect(sql).toContain('createdByPlatformPrincipalId');
    expect(sql).toContain('ALTER TABLE "PlatformPrincipal" ENABLE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+"CompanyOwnership"\s+SELECT/i);
    expect(sql).not.toMatch(/^\s*(?:DROP|TRUNCATE|DELETE)\b/im);
  });
});
