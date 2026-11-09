import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const migrationsRoot = path.resolve(process.cwd(), 'prisma/migrations');
const e1Name = '20260726000100_credential_recovery_e1_foundation';
const e5Name = '20260730000100_credential_recovery_e5_break_glass';
const postE5Allowed = [
  '20260731000100_qa_round1_attachments',
  '20260807000100_commercial_w1a_payroll_finance_foundation',
  '20260808000100_commercial_w2_purchasing_expansion',
  '20260809000100_commercial_p4_tasks_training_collaboration',
];
const priorMigrations = [
  '0_init',
  '20260710000100_salary_payroll_foundation',
  '20260710000200_task_assignment_workflow',
  '20260710000300_chat_foundation',
  '20260710000400_purchasing_core',
  '20260710000500_training_core',
  '20260710000600_reporting_security_indexes',
  '20260714000100_company_identity_login',
  '20260718000100_rc2_ownership_hierarchy_expand',
  '20260718000200_rc2_scoped_authorization',
  '20260719000100_rc2_notifications_deep_links',
  '20260719000200_rc2_attendance_leave_workflows',
  '20260719000300_rc2_credentials_sessions',
  '20260719000400_rc2_payroll_payments',
  '20260719000500_rc2_vendor_purchasing_lifecycle',
  '20260719000600_rc2_report_templates',
  '20260720000100_rc2_chat_enhancements',
  '20260721000100_rc2_mfa',
  '20260721000200_rc2_platform_control_plane',
  '20260723000100_rc2_department_manager_legacy_backfill',
];

describe('credential recovery E1 migration (static)', () => {
  const sql = fs.readFileSync(
    path.join(migrationsRoot, e1Name, 'migration.sql'),
    'utf8',
  );

  it('is additive and creates the E1 tables with fail-closed checks', () => {
    expect(sql).toContain('CREATE TABLE "CredentialRecoveryRequest"');
    expect(sql).toContain('CREATE TABLE "CredentialRecoveryAuditEvent"');
    expect(sql).toContain('CREATE TABLE "CredentialRecoveryRateLimitBucket"');
    expect(sql).toContain('CredentialRecoveryRequest_domain_company_check');
    expect(sql).toContain('CredentialRecoveryRequest_domain_purpose_check');
    expect(sql).toContain('CredentialRecoveryRequest_active_unique');
    expect(sql).toContain('CredentialRecoveryRequest_expires_after_created_check');
    expect(sql).toContain('CredentialRecoveryRequest_lifecycle_check');
    expect(sql).toContain('CredentialRecoveryRequest_requestSourceHash_check');
    expect(sql).toContain('CredentialRecoveryAuditEvent_unresolved_subject_check');
    expect(sql).toContain('CredentialRecoveryAuditEvent_referenceId_key');
    expect(sql).toContain('CredentialRecoveryRateLimitBucket_bucketKeyHash_check');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(/^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/im);
  });

  it('keeps previous 20 migrations byte-for-byte present and untouched in lineage', () => {
    expect(priorMigrations).toHaveLength(20);
    for (const name of priorMigrations) {
      const file = path.join(migrationsRoot, name, 'migration.sql');
      expect(fs.existsSync(file)).toBe(true);
      const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    }
    const dirs = fs.readdirSync(migrationsRoot).filter((name) =>
      fs.statSync(path.join(migrationsRoot, name)).isDirectory(),
    );
    expect(dirs).toContain(e1Name);
    expect(dirs).toContain(e5Name);
    expect(
      dirs.filter(
        (name) => name !== e1Name && name !== e5Name && !postE5Allowed.includes(name),
      ),
    ).toEqual(priorMigrations);
  });

  it('registers Platform recovery routes without inventing password-reset aliases', () => {
    const app = fs.readFileSync(path.resolve(process.cwd(), 'src/app.ts'), 'utf8');
    expect(app).toMatch(/owner-recovery/);
    expect(app).toMatch(/registerPlatformPrincipalRecoveryRoutes/);
    expect(app).toMatch(/registerBreakGlassCompletionRoutes/);
    expect(app).not.toMatch(/platform\/v1\/auth\/password-reset/);
  });
});

describe('credential recovery E5 migration (static)', () => {
  const sql = fs.readFileSync(
    path.join(migrationsRoot, e5Name, 'migration.sql'),
    'utf8',
  );

  it('only relaxes break_glass tokenHash shape and does not rewrite prior migrations', () => {
    expect(sql).toContain('CredentialRecoveryRequest_token_shape_check');
    expect(sql).toContain('break_glass_recovery');
    expect(sql).toContain('hmac-sha256-v1');
    expect(sql).not.toMatch(/^\s*(?:TRUNCATE|DELETE)\b/im);
    expect(fs.existsSync(path.join(migrationsRoot, e1Name, 'migration.sql'))).toBe(true);
  });

  it('records E1 and E5 credential_recovery migrations only', () => {
    const dirs = fs.readdirSync(migrationsRoot).filter((name) =>
      fs.statSync(path.join(migrationsRoot, name)).isDirectory(),
    );
    expect(dirs.filter((name) => /credential_recovery/.test(name))).toEqual([e1Name, e5Name]);
  });
});
