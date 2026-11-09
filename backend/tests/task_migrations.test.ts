import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'prisma', 'migrations', '20260710000200_task_assignment_workflow', 'migration.sql'),
  'utf8'
);

describe('Sprint 7 task migration', () => {
  it('creates the task workflow with tenant-safe restrictive relationships', () => {
    expect(sql).toContain('CREATE TABLE "Task"');
    expect(sql).toContain('CREATE TABLE "TaskAssignment"');
    expect(sql).toContain('Task_createdByUserId_companyId_fkey');
    expect(sql).toContain('TaskAssignment_taskId_companyId_fkey');
    expect(sql).toContain('TaskAssignment_employeeId_companyId_fkey');
    expect(sql).toContain('TaskAssignment_reviewedByUserId_companyId_fkey');
    expect(sql.match(/ON DELETE RESTRICT/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('adds the required uniqueness indexes and allow-list checks', () => {
    expect(sql).toContain('TaskAssignment_taskId_employeeId_key');
    expect(sql).toContain('Task_companyId_status_idx');
    expect(sql).toContain('TaskAssignment_companyId_employeeId_status_idx');
    expect(sql).toContain("CHECK (\"priority\" IN ('low', 'normal', 'high', 'urgent'))");
    expect(sql).toContain("CHECK (\"status\" IN ('active', 'completed', 'cancelled'))");
    expect(sql).toContain("CHECK (\"status\" IN ('assigned', 'in_progress', 'submitted', 'accepted', 'returned'))");
    expect(sql).toContain('ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "TaskAssignment" ENABLE ROW LEVEL SECURITY');
  });

  it('contains no destructive data or schema operation', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
  });
});
