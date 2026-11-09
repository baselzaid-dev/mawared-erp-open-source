import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const backendRoot = resolve(process.cwd());
const migration = readFileSync(join(
  backendRoot,
  'prisma',
  'migrations',
  '20260714000100_company_identity_login',
  'migration.sql',
), 'utf8');
const schema = readFileSync(join(backendRoot, 'prisma', 'schema.prisma'), 'utf8');

describe('Sprint 12B M01 company identity migration', () => {
  it('uses a transactional expand-preflight-backfill-contract flow', () => {
    expect(migration).toMatch(/BEGIN;[\s\S]*COMMIT;/);
    expect(migration).toContain('M01 preflight failed: duplicate normalized email');
    expect(migration).toContain('M01 preflight failed: duplicate normalized Employee number');
    expect(migration).toContain("WHEN \"id\" = '1' THEN 'CMP-DEMO'");
    expect(migration).toContain('normalize(btrim');
    expect(migration).toContain('NFKC');
  });

  it('contracts only the obsolete global email index and never deletes business data', () => {
    expect(migration).toContain('DROP INDEX "User_email_key";');
    expect(migration).not.toMatch(/\b(?:DELETE\s+FROM|TRUNCATE|DROP\s+(?:TABLE|COLUMN|SCHEMA|DATABASE))\b/i);
    expect(migration).not.toMatch(/UPDATE\s+"(?:Salary|Payroll|Task|Chat|Vendor|Purchase|Training|Report)/i);
  });

  it('enforces company-safe identities, sessions, canonical fields, and RLS', () => {
    expect(migration).toContain('LoginIdentity_companyId_normalizedIdentifier_key');
    expect(migration).toContain('LoginIdentity_companyId_userId_type_key');
    expect(migration).toContain('LoginIdentity_userId_companyId_fkey');
    expect(migration).toContain('RefreshToken_userId_companyId_fkey');
    expect(migration).toContain('User_employeeId_companyId_fkey');
    expect(migration).toContain('Company_code_immutable_trigger');
    expect(migration).toContain('ALTER TABLE "LoginIdentity" ENABLE ROW LEVEL SECURITY');
  });

  it('keeps Prisma aligned with the final tenant-scoped model', () => {
    expect(schema).toMatch(/model Company \{[\s\S]*code\s+String\s+@unique/);
    expect(schema).toMatch(/model LoginIdentity \{/);
    expect(schema).toContain('@@unique([companyId, normalizedIdentifier]');
    expect(schema).toContain('@@unique([companyId, normalizedEmail]');
    expect(schema).toContain('@@unique([companyId, normalizedEmployeeNum]');
    expect(schema).not.toMatch(/email\s+String\s+@unique/);
  });
});
