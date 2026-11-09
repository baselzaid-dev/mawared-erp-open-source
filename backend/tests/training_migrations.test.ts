import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'prisma', 'migrations', '20260710000500_training_core', 'migration.sql'),
  'utf8'
);

describe('Sprint 10 Training migration', () => {
  it('creates the three Training tables and required lifecycle fields', () => {
    expect(sql).toContain('CREATE TABLE "TrainingCourse"');
    expect(sql).toContain('CREATE TABLE "TrainingResource"');
    expect(sql).toContain('CREATE TABLE "TrainingAssignment"');
    expect(sql).toContain('"courseCode" TEXT NOT NULL');
    expect(sql).toContain('"progressPercent" INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('"reviewedByUserId" TEXT');
  });

  it('enforces tenant-safe relations, checks, indexes, and retained history', () => {
    expect(sql).toContain('TrainingCourse_createdByUserId_companyId_fkey');
    expect(sql).toContain('TrainingResource_courseId_companyId_fkey');
    expect(sql).toContain('TrainingAssignment_employeeId_companyId_fkey');
    expect(sql).toContain('TrainingAssignment_courseId_employeeId_key');
    expect(sql).toContain('TrainingCourse_status_check');
    expect(sql).toContain('TrainingResource_url_credentials_check');
    expect(sql).toContain('TrainingAssignment_progress_check');
    expect(sql).toContain('TrainingAssignment_score_check');
  });

  it('enables RLS without direct-access policies', () => {
    expect(sql.match(/ENABLE ROW LEVEL SECURITY/g)?.length).toBe(3);
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
  });

  it('is additive and contains no destructive SQL', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
    expect(sql).not.toMatch(/ALTER TABLE "(Vendor|Purchase|Task|Chat|Payroll)/i);
  });
});
