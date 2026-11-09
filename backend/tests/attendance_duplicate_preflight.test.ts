import { describe, expect, it, vi } from 'vitest';
import {
  analyzeAttendanceDuplicates,
  assertLocalDatabaseUrl,
  buildAttendanceDayKey,
  normalizeUtcCalendarDay,
  readAttendancePreflightRows,
  runAttendanceDuplicatePreflight,
  type AttendancePreflightRow,
} from '../scripts/m05/attendance_duplicate_preflight.ts';

const row = (
  id: string,
  companyId: string,
  employeeId: string,
  date: Date,
): AttendancePreflightRow => ({ id, companyId, employeeId, date });

describe('normalizeUtcCalendarDay', () => {
  it('normalizes timestamps to UTC calendar day', () => {
    expect(normalizeUtcCalendarDay(new Date('2026-07-09T23:30:00.000Z'))).toBe('2026-07-09');
    expect(normalizeUtcCalendarDay(new Date('2026-07-10T00:30:00.000Z'))).toBe('2026-07-10');
  });
});

describe('analyzeAttendanceDuplicates', () => {
  it('returns SAFE_ON_CLEAN_TEST_ONLY for a clean dataset', () => {
    const report = analyzeAttendanceDuplicates([
      row('a1', 'company-1', 'employee-1', new Date('2026-07-09T08:00:00.000Z')),
      row('a2', 'company-1', 'employee-2', new Date('2026-07-09T08:00:00.000Z')),
      row('a3', 'company-2', 'employee-1', new Date('2026-07-09T08:00:00.000Z')),
    ]);

    expect(report.scannedRowCount).toBe(3);
    expect(report.uniqueDayKeyCount).toBe(3);
    expect(report.duplicateGroupCount).toBe(0);
    expect(report.duplicateRowCount).toBe(0);
    expect(report.extraRowCount).toBe(0);
    expect(report.duplicateGroups).toEqual([]);
    expect(report.uniqueEnforcementRecommendation).toBe('SAFE_ON_CLEAN_TEST_ONLY');
    expect(report.uniqueConstraintStatus).toBe('DEFERRED_DO_NOT_ADD_IN_THIS_TASK');
    expect(report.notes.some((note) => note.includes('Do NOT add UNIQUE'))).toBe(true);
  });

  it('detects duplicates on the same UTC day regardless of clock time', () => {
    const report = analyzeAttendanceDuplicates([
      row('z-id', 'company-1', 'employee-1', new Date('2026-07-09T01:00:00.000Z')),
      row('a-id', 'company-1', 'employee-1', new Date('2026-07-09T22:00:00.000Z')),
      row('b-id', 'company-1', 'employee-1', new Date('2026-07-10T00:00:00.000Z')),
    ]);

    expect(report.duplicateGroupCount).toBe(1);
    expect(report.duplicateRowCount).toBe(2);
    expect(report.extraRowCount).toBe(1);
    expect(report.uniqueEnforcementRecommendation).toBe('DEFER');
    expect(report.duplicateGroups).toEqual([
      {
        companyId: 'company-1',
        employeeId: 'employee-1',
        utcDay: '2026-07-09',
        rowCount: 2,
        attendanceIds: ['a-id', 'z-id'],
      },
    ]);
  });

  it('does not treat adjacent UTC days as duplicates', () => {
    const report = analyzeAttendanceDuplicates([
      row('a1', 'company-1', 'employee-1', new Date('2026-07-09T23:59:59.000Z')),
      row('a2', 'company-1', 'employee-1', new Date('2026-07-10T00:00:00.000Z')),
    ]);

    expect(report.duplicateGroupCount).toBe(0);
    expect(report.uniqueEnforcementRecommendation).toBe('SAFE_ON_CLEAN_TEST_ONLY');
  });

  it('scopes duplicates by company and employee', () => {
    const report = analyzeAttendanceDuplicates([
      row('a1', 'company-1', 'employee-1', new Date('2026-07-09T08:00:00.000Z')),
      row('a2', 'company-1', 'employee-1', new Date('2026-07-09T18:00:00.000Z')),
      row('b1', 'company-1', 'employee-2', new Date('2026-07-09T08:00:00.000Z')),
      row('b2', 'company-1', 'employee-2', new Date('2026-07-09T18:00:00.000Z')),
      row('c1', 'company-2', 'employee-1', new Date('2026-07-09T08:00:00.000Z')),
      row('c2', 'company-2', 'employee-1', new Date('2026-07-09T18:00:00.000Z')),
    ]);

    expect(report.duplicateGroupCount).toBe(3);
    expect(report.extraRowCount).toBe(3);
    expect(report.duplicateGroups.map((group) => group.attendanceIds)).toEqual([
      ['a1', 'a2'],
      ['b1', 'b2'],
      ['c1', 'c2'],
    ]);
  });

  it('is deterministic and emits ids/counts only', () => {
    const rows = [
      row('dup-2', 'company-z', 'employee-z', new Date('2026-01-02T12:00:00.000Z')),
      row('dup-1', 'company-a', 'employee-a', new Date('2026-01-01T12:00:00.000Z')),
      row('dup-3', 'company-a', 'employee-a', new Date('2026-01-01T18:00:00.000Z')),
    ];

    const first = analyzeAttendanceDuplicates(rows);
    const second = analyzeAttendanceDuplicates([...rows].reverse());

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toMatch(/name|email|employeeNum/i);
    expect(first.duplicateGroups[0].attendanceIds).toEqual(['dup-1', 'dup-3']);
  });
});

describe('buildAttendanceDayKey', () => {
  it('builds a stable composite key', () => {
    const date = new Date('2026-07-09T15:00:00.000Z');
    expect(buildAttendanceDayKey('c1', 'e1', date)).toBe(`c1\u0000e1\u00002026-07-09`);
  });
});

describe('readAttendancePreflightRows / runAttendanceDuplicatePreflight', () => {
  it('reads attendance rows through a read-only transaction wrapper', async () => {
    const rows = [
      row('a1', 'company-1', 'employee-1', new Date('2026-07-09T08:00:00.000Z')),
    ];
    const executeRaw = vi.fn(async () => 0);
    const findMany = vi.fn(async () => rows);
    const database = {
      attendance: { findMany },
      $executeRaw: executeRaw,
      $transaction: async <T>(callback: (transaction: typeof database) => Promise<T>) => callback(database),
    };

    await expect(readAttendancePreflightRows(database)).resolves.toEqual(rows);
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledOnce();

    const report = await runAttendanceDuplicatePreflight(database);
    expect(report.uniqueEnforcementRecommendation).toBe('SAFE_ON_CLEAN_TEST_ONLY');
  });
});

describe('assertLocalDatabaseUrl', () => {
  it('accepts loopback PostgreSQL URLs', () => {
    expect(() => assertLocalDatabaseUrl('postgresql://user:pass@127.0.0.1:5432/mawared_test')).not.toThrow();
    expect(() => assertLocalDatabaseUrl('postgres://user:pass@localhost:5432/mawared_test')).not.toThrow();
  });

  it('refuses missing or non-local database URLs', () => {
    expect(() => assertLocalDatabaseUrl(undefined)).toThrow(/required/i);
    expect(() => assertLocalDatabaseUrl('postgresql://user:pass@fixture-4.example.test:5432/db'))
      .toThrow(/refuses non-local/i);
  });
});
