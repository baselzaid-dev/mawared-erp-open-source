import type { Messages } from '@/i18n';
import type { LeaveRecord, LeaveStatus, LeaveType } from './types';

export function utcDateInputValue(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function yearBoundsUtc(date = new Date()): { from: string; to: string } {
  const year = date.getUTCFullYear();
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

export function formatDisplayDate(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function formatDisplayTime(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

export function workHoursLabel(
  clockIn: string | null | undefined,
  clockOut: string | null | undefined,
): string {
  if (!clockIn || !clockOut) return '—';
  const start = new Date(clockIn).getTime();
  const end = new Date(clockOut).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  const hours = (end - start) / (1000 * 60 * 60);
  return hours.toFixed(1);
}

export function normalizeLeaveType(leaveType: LeaveType): string {
  const value = String(leaveType).toLowerCase();
  if (value === 'annual' || leaveType === 'سنوية') return 'annual';
  if (value === 'sick' || leaveType === 'مرضية') return 'sick';
  if (value === 'special' || leaveType === 'طارئة') return 'special';
  if (value === 'unpaid' || leaveType === 'بدون راتب') return 'unpaid';
  if (value === 'study' || leaveType === 'دراسية') return 'study';
  return value;
}

export function leaveTypeLabel(leaveType: LeaveType, messages: Messages): string {
  switch (normalizeLeaveType(leaveType)) {
    case 'annual':
      return messages.leaveTypeAnnual;
    case 'sick':
      return messages.leaveTypeSick;
    case 'special':
      return messages.leaveTypeSpecial;
    case 'unpaid':
      return messages.leaveTypeUnpaid;
    case 'study':
      return messages.leaveTypeStudy;
    default:
      return String(leaveType);
  }
}

export function leaveStatusLabel(status: LeaveStatus, messages: Messages): string {
  switch (status) {
    case 'pending_hr':
      return messages.leaveStatusPendingHr;
    case 'pending_admin':
      return messages.leaveStatusPendingAdmin;
    case 'approved':
      return messages.leaveStatusApproved;
    case 'rejected':
      return messages.leaveStatusRejected;
    case 'cancelled':
      return messages.leaveStatusCancelled;
    default:
      return String(status);
  }
}

export function leaveStageLabel(leave: LeaveRecord, messages: Messages): string {
  return leaveStatusLabel(leave.status, messages);
}

export function isAnnualLeaveType(leaveType: LeaveType): boolean {
  return normalizeLeaveType(leaveType) === 'annual';
}

export function employeeLeaveName(leave: LeaveRecord): string {
  return leave.employee?.name?.trim() || leave.employee?.employeeNum || leave.employeeId;
}
