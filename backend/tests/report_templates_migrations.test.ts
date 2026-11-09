import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, isCanonicalPermission } from '../src/permissions.ts';

const backendRoot = fileURLToPath(new URL('..', import.meta.url));
const migration = (relativePath: string) =>
  readFileSync(join(backendRoot, 'prisma', 'migrations', relativePath), 'utf8');

describe('Sprint 12J M09 saved report templates migration', () => {
  it('adds SavedReportTemplate additively without SQL/blob storage', () => {
    const sql = migration(join('20260719000600_rc2_report_templates', 'migration.sql'));

    expect(sql).toContain('CREATE TABLE "SavedReportTemplate"');
    expect(sql).toContain('builtInKey');
    expect(sql).toContain('filtersJson');
    expect(sql).toContain('SavedReportTemplate_ownerUserId_companyId_fkey');
    expect(sql).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
  });

  it('registers composite and template permission keys', () => {
    expect(PERMISSIONS.REPORTS_COMPOSITE_VIEW).toBe('reports.composite.view');
    expect(PERMISSIONS.REPORTS_TEMPLATES_MANAGE).toBe('reports.templates.manage');
    expect(isCanonicalPermission('reports.composite.view')).toBe(true);
    expect(isCanonicalPermission('reports.templates.manage')).toBe(true);
  });
});
