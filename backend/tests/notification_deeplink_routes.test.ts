import { describe, expect, it } from 'vitest';
import {
  ALLOWLISTED_ROUTE_KEYS,
  LEGACY_NOTIFICATION_ROUTE_ALIASES,
  shapeNotificationDto,
  validateNotificationDescriptor,
} from '../src/notifications';

const baseRow = {
  id: 'n-1',
  title: 'T',
  message: 'M',
  isRead: false,
  createdAt: new Date('2026-08-09T12:00:00.000Z'),
};

describe('notification deep-link route hygiene', () => {
  it('retains every canonical post-P4 route key through shapeNotificationDto', () => {
    const cases: Array<{
      routeKey: keyof typeof ALLOWLISTED_ROUTE_KEYS;
      resourceType: string;
      resourceId?: string;
    }> = [
      { routeKey: 'leave.detail', resourceType: 'leaveRequest', resourceId: 'lv-1' },
      { routeKey: 'purchasing.requests.detail', resourceType: 'purchase_request', resourceId: 'pr-1' },
      { routeKey: 'employees.profile', resourceType: 'security' },
      { routeKey: 'auth.sessions', resourceType: 'security' },
      { routeKey: 'auth.change_password', resourceType: 'security' },
    ];

    for (const entry of cases) {
      expect(() =>
        validateNotificationDescriptor(entry.routeKey, entry.resourceType, entry.resourceId ?? null),
      ).not.toThrow();

      const dto = shapeNotificationDto({
        ...baseRow,
        category: entry.routeKey.startsWith('auth') || entry.routeKey === 'employees.profile'
          ? 'security'
          : 'workflow',
        routeKey: entry.routeKey,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
      });

      expect(dto.descriptor).toEqual({
        routeKey: entry.routeKey,
        resourceType: entry.resourceType,
        ...(entry.resourceId ? { resourceId: entry.resourceId } : {}),
      });
    }
  });

  it('rejects wrong resourceType for known route keys', () => {
    expect(() => validateNotificationDescriptor('leave.detail', 'task')).toThrow();
    expect(() => validateNotificationDescriptor('auth.sessions', 'leaveRequest')).toThrow();
    expect(() =>
      validateNotificationDescriptor('purchasing.requests.detail', 'employee'),
    ).toThrow();

    const dto = shapeNotificationDto({
      ...baseRow,
      category: 'leave',
      routeKey: 'leave.detail',
      resourceType: 'task',
      resourceId: 'lv-1',
    });
    expect(dto.descriptor).toBeUndefined();
  });

  it('rejects unknown route keys and strips them from DTOs', () => {
    expect(() => validateNotificationDescriptor('payroll.secret', 'payroll')).toThrow();
    const dto = shapeNotificationDto({
      ...baseRow,
      category: 'payroll',
      routeKey: 'payroll.secret',
      resourceType: 'payroll',
      resourceId: 'p-1',
    });
    expect(dto.descriptor).toBeUndefined();
  });

  it('maps legacy leaves.detail rows to canonical leave.detail without widening types', () => {
    expect(LEGACY_NOTIFICATION_ROUTE_ALIASES['leaves.detail']).toBe('leave.detail');
    // Legacy key must not be writable.
    expect(() => validateNotificationDescriptor('leaves.detail', 'leave')).toThrow();

    const dto = shapeNotificationDto({
      ...baseRow,
      category: 'leave',
      routeKey: 'leaves.detail',
      resourceType: 'leave',
      resourceId: 'lv-legacy',
    });
    expect(dto.descriptor).toEqual({
      routeKey: 'leave.detail',
      resourceType: 'leave',
      resourceId: 'lv-legacy',
    });

    const wrongType = shapeNotificationDto({
      ...baseRow,
      category: 'leave',
      routeKey: 'leaves.detail',
      resourceType: 'task',
      resourceId: 'lv-legacy',
    });
    expect(wrongType.descriptor).toBeUndefined();
  });

  it('fills defaultResourceType only when historical rows omitted resourceType', () => {
    const sessions = shapeNotificationDto({
      ...baseRow,
      category: 'security',
      routeKey: 'auth.sessions',
      resourceType: null,
    });
    expect(sessions.descriptor).toEqual({
      routeKey: 'auth.sessions',
      resourceType: 'security',
    });

    const password = shapeNotificationDto({
      ...baseRow,
      category: 'security',
      routeKey: 'auth.change_password',
    });
    expect(password.descriptor).toEqual({
      routeKey: 'auth.change_password',
      resourceType: 'security',
    });

    const profile = shapeNotificationDto({
      ...baseRow,
      category: 'security',
      routeKey: 'employees.profile',
    });
    expect(profile.descriptor).toEqual({
      routeKey: 'employees.profile',
      resourceType: 'security',
    });
  });

  it('never places credential material in auth route metadata shapes', () => {
    for (const routeKey of ['auth.sessions', 'auth.change_password'] as const) {
      const dto = shapeNotificationDto({
        ...baseRow,
        category: 'security',
        routeKey,
        resourceType: 'security',
        // Producers must not set resourceId for these routes; assert DTO stays clean.
        resourceId: null,
        message: 'قام مسؤول بإنهاء جميع جلسات تسجيل الدخول النشطة لحسابك.',
      });
      expect(dto.descriptor).toEqual({ routeKey, resourceType: 'security' });
      expect((dto.descriptor as { resourceId?: string }).resourceId).toBeUndefined();
      expect(dto).not.toHaveProperty('temporaryPassword');
      expect(dto).not.toHaveProperty('tokenHash');
      expect(dto).not.toHaveProperty('refreshToken');
      expect(JSON.stringify(dto.descriptor)).not.toMatch(
        /tokenHash|refreshToken|temporaryPassword|Bearer|mfaSecret|sessionSecret/i,
      );
    }
  });

  it('keeps leave.detail accepting both leaveRequest and leave resource types', () => {
    expect(ALLOWLISTED_ROUTE_KEYS['leave.detail'].resourceTypes).toEqual(
      expect.arrayContaining(['leaveRequest', 'leave']),
    );
    expect(() => validateNotificationDescriptor('leave.detail', 'leave', 'lv-1')).not.toThrow();
    expect(() =>
      validateNotificationDescriptor('leave.detail', 'leaveRequest', 'lv-1'),
    ).not.toThrow();
  });
});
