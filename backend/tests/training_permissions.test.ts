import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, PERMISSIONS } from '../src/permissions';

const seed = readFileSync(join(process.cwd(), 'prisma', 'seed.ts'), 'utf8');
const preview = readFileSync(
  join(process.cwd(), 'prisma', 'permission-previews', 'sprint10_training_permissions_preview.sql'),
  'utf8'
);
const roleLine = (role: string) => seed.split('\n').find((line) => line.includes(`name: '${role}'`)) ?? '';

describe('Sprint 10 Training permissions', () => {
  it('defines the complete managed subset canonically', () => {
    const expected = [
      'training.view_own', 'training.view_department', 'training.view_company',
      'training.manage', 'training.assign', 'training.review', 'training.report',
    ];
    expect(ALL_PERMISSIONS).toEqual(expect.arrayContaining(expected));
    expect(PERMISSIONS.TRAINING_VIEW_DEPARTMENT).toBe('training.view_department');
    expect(PERMISSIONS.TRAINING_REPORT).toBe('training.report');
  });

  it('keeps the approved least-privilege future role mapping', () => {
    expect(roleLine('Employee')).toContain("'training.view_own'");
    expect(roleLine('Department Manager')).toContain("'training.view_department', 'training.report'");
    expect(roleLine('HR Manager')).toContain("'training.view_company', 'training.manage', 'training.assign', 'training.review', 'training.report'");
    for (const role of ['Accountant', 'Finance Manager', 'Purchasing Officer']) {
      expect(roleLine(role)).toContain("'training.view_own'");
      expect(roleLine(role)).not.toContain("'training.manage'");
    }
    expect(roleLine('Admin')).not.toContain("'training.");
    expect(seed).toContain('managedTrainingPermissions');
  });

  it('keeps the permission preview read-only and subset-limited', () => {
    const executableSql = preview.split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(preview).toContain("('Admin', '[]'::jsonb)");
    expect(preview).toContain('managed_permissions(permission)');
    expect(preview).toContain('WITH ORDINALITY');
    expect(executableSql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
  });
});
