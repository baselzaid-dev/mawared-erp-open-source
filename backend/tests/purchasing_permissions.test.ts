import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, PERMISSIONS } from '../src/permissions';

const preview = readFileSync(
  join(process.cwd(), 'prisma', 'permission-previews', 'sprint9_purchasing_permissions_preview.sql'),
  'utf8'
);
const seed = readFileSync(join(process.cwd(), 'prisma', 'seed.ts'), 'utf8');

const roleLine = (role: string) => seed.split('\n').find((line) => line.includes(`name: '${role}'`)) ?? '';

describe('Sprint 9 purchasing permissions', () => {
  it('defines every managed purchasing permission canonically', () => {
    const expected = [
      'purchasing.view', 'purchasing.view_own', 'purchasing.view_department',
      'purchasing.create', 'purchasing.review_department', 'purchasing.approve',
      'purchasing.manage', 'purchasing.receive', 'purchasing.report',
      'vendors.view', 'vendors.manage',
    ];
    expect(ALL_PERMISSIONS).toEqual(expect.arrayContaining(expected));
    expect(PERMISSIONS.PURCHASING_VIEW_OWN).toBe('purchasing.view_own');
    expect(PERMISSIONS.PURCHASING_REVIEW_DEPARTMENT).toBe('purchasing.review_department');
  });

  it('keeps the least-privilege role mapping in the future seed', () => {
    expect(roleLine('Employee')).toContain("'purchasing.view_own', 'purchasing.create'");
    expect(roleLine('Department Manager')).toContain("'purchasing.review_department'");
    expect(roleLine('Purchasing Officer')).toContain("'purchasing.receive'");
    expect(roleLine('Finance Manager')).toContain("'vendors.view'");
    expect(roleLine('Accountant')).toContain("'purchasing.report'");
    expect(roleLine('HR Manager')).not.toContain("'purchasing.");
    expect(roleLine('Admin')).not.toContain("'purchasing.");
    expect(seed).toContain('managedPurchasingPermissions');
  });

  it('keeps the staging preview read-only and limited to the managed subset', () => {
    const executableSql = preview.split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(preview).toContain("('HR Manager', '[]'::jsonb)");
    expect(preview).toContain("('Employee', '[\"purchasing.view_own\",\"purchasing.create\"]'::jsonb)");
    expect(preview).toContain('WITH ORDINALITY');
    expect(executableSql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
  });
});
