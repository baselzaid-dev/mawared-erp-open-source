import { describe, expect, it } from 'vitest';
import { translations } from '@/i18n';
import {
  isAnnualLeaveType,
  leaveStatusLabel,
  leaveTypeLabel,
  normalizeLeaveType,
  workHoursLabel,
} from './format';

describe('leave and attendance format helpers', () => {
  it('normalizes bilingual leave types', () => {
    expect(normalizeLeaveType('سنوية')).toBe('annual');
    expect(normalizeLeaveType('study')).toBe('study');
    expect(isAnnualLeaveType('سنوية')).toBe(true);
    expect(leaveTypeLabel('sick', translations.en)).toBe(translations.en.leaveTypeSick);
    expect(leaveStatusLabel('pending_admin', translations.en)).toBe(
      translations.en.leaveStatusPendingAdmin,
    );
  });

  it('computes work hours and keeps incomplete pairs unavailable', () => {
    expect(
      workHoursLabel('2026-08-01T08:00:00.000Z', '2026-08-01T16:30:00.000Z'),
    ).toBe('8.5');
    expect(workHoursLabel('2026-08-01T08:00:00.000Z', null)).toBe('—');
  });
});
