import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, PERMISSIONS } from '../src/permissions';

const preview = readFileSync(
  join(process.cwd(), 'prisma', 'permission-previews', 'sprint7_task_permissions_preview.sql'),
  'utf8'
);

describe('Sprint 7 task permissions', () => {
  it('publishes every workflow key in the canonical backend set', () => {
    const expected = [
      PERMISSIONS.TASKS_VIEW_OWN,
      PERMISSIONS.TASKS_VIEW_DEPARTMENT,
      PERMISSIONS.TASKS_VIEW_COMPANY,
      PERMISSIONS.TASKS_CREATE,
      PERMISSIONS.TASKS_ASSIGN_DEPARTMENT,
      PERMISSIONS.TASKS_ASSIGN_COMPANY,
      PERMISSIONS.TASKS_REVIEW,
    ];
    expect(expected.every((permission) => ALL_PERMISSIONS.includes(permission))).toBe(true);
  });

  it('keeps the role preview read-only and preserves non-task permissions', () => {
    const executableSql = preview
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(preview).toContain('Every unrelated');
    expect(preview).toContain('tasks.assign_department');
    expect(preview).toContain('tasks.assign_company');
    expect(preview).toContain("('Employee', '[\"tasks.view_own\"]'::jsonb)");
    expect(executableSql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
  });
});
