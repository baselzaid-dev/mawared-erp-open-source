import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('RC2 MFA migration', () => {
  const sql = fs.readFileSync(
    path.resolve(
      process.cwd(),
      'prisma/migrations/20260721000100_rc2_mfa/migration.sql',
    ),
    'utf8',
  );

  it('is additive and tenant-safe', () => {
    expect(sql).toContain('CREATE TABLE "UserMfaCredential"');
    expect(sql).toContain('FOREIGN KEY ("userId", "companyId")');
    expect(sql).toContain('REFERENCES "User"("id", "companyId")');
    expect(sql).toContain('CHECK ("state" IN (\'pending\', \'enrolled\'))');
    expect(sql).toContain('ALTER TABLE "UserMfaCredential" ENABLE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    expect(sql).not.toMatch(/^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/im);
    expect(sql).not.toContain('CompanyOwnership');
  });
});
