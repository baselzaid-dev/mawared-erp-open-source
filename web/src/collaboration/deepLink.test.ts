import { describe, expect, it } from 'vitest';
import { ADMIN_FULL, PERMISSIONS } from '@/permissions';
import { isNavigable, resolveNotificationTarget } from './deepLink';

describe('notification deep links', () => {
  it('routes an allowlisted descriptor to the matching web screen', () => {
    expect(
      resolveNotificationTarget(
        { routeKey: 'task.detail', resourceType: 'task', resourceId: 'task-1' },
        [PERMISSIONS.TASKS_VIEW_OWN],
      ),
    ).toEqual({ route: 'tasks', resourceId: 'task-1' });

    expect(
      resolveNotificationTarget(
        { routeKey: 'training.assignment.detail', resourceType: 'trainingAssignment' },
        [PERMISSIONS.TRAINING_VIEW_OWN],
      ),
    ).toEqual({ route: 'training', resourceId: null });

    expect(
      resolveNotificationTarget(
        { routeKey: 'chat.conversation', resourceType: 'chatConversation', resourceId: 'c-1' },
        [PERMISSIONS.CHAT_VIEW],
      ),
    ).toEqual({ route: 'chat', resourceId: 'c-1' });
  });

  it('routes post-P4 canonical keys with resourceId preserved where relevant', () => {
    expect(
      resolveNotificationTarget(
        { routeKey: 'leave.detail', resourceType: 'leaveRequest', resourceId: 'lv-1' },
        [PERMISSIONS.LEAVES_VIEW_OWN],
      ),
    ).toEqual({ route: 'leaves', resourceId: 'lv-1' });

    expect(
      resolveNotificationTarget(
        {
          routeKey: 'purchasing.requests.detail',
          resourceType: 'purchase_request',
          resourceId: 'pr-9',
        },
        [PERMISSIONS.PURCHASING_VIEW_OWN],
      ),
    ).toEqual({ route: 'purchasing', resourceId: 'pr-9' });

    expect(
      resolveNotificationTarget(
        { routeKey: 'employees.profile', resourceType: 'security' },
        [PERMISSIONS.EMPLOYEES_VIEW],
      ),
    ).toEqual({ route: 'employees', resourceId: null });

    expect(
      resolveNotificationTarget(
        { routeKey: 'auth.sessions', resourceType: 'security' },
        [],
      ),
    ).toEqual({ route: 'sessions', resourceId: null });
  });

  it('supports the legacy leaves.detail alias without guessing unrelated modules', () => {
    expect(
      resolveNotificationTarget(
        { routeKey: 'leaves.detail', resourceType: 'leave', resourceId: 'lv-old' },
        [PERMISSIONS.LEAVES_VIEW],
      ),
    ).toEqual({ route: 'leaves', resourceId: 'lv-old' });
  });

  it('leaves auth.change_password non-navigable on Company Web', () => {
    expect(
      resolveNotificationTarget(
        { routeKey: 'auth.change_password', resourceType: 'security' },
        [ADMIN_FULL],
      ),
    ).toBeNull();
  });

  it('refuses to guess a destination for a key this client does not implement', () => {
    // The backend may legitimately emit keys for surfaces only Android has.
    expect(
      resolveNotificationTarget(
        { routeKey: 'attendance.correction.detail', resourceType: 'attendance' },
        [ADMIN_FULL],
      ),
    ).toBeNull();
  });

  it('does not offer a link the account could not open', () => {
    const employeeOnly = [PERMISSIONS.TASKS_VIEW_OWN];
    expect(
      resolveNotificationTarget(
        { routeKey: 'chat.conversation', resourceType: 'chatConversation' },
        employeeOnly,
      ),
    ).toBeNull();
    expect(
      isNavigable({ routeKey: 'chat.conversation', resourceType: 'chatConversation' }, employeeOnly),
    ).toBe(false);

    expect(
      resolveNotificationTarget(
        {
          routeKey: 'purchasing.requests.detail',
          resourceType: 'purchase_request',
          resourceId: 'pr-1',
        },
        employeeOnly,
      ),
    ).toBeNull();
    expect(
      resolveNotificationTarget(
        { routeKey: 'employees.profile', resourceType: 'security' },
        employeeOnly,
      ),
    ).toBeNull();
  });

  it('treats admin.full as the single bypass, matching the backend', () => {
    expect(
      resolveNotificationTarget({ routeKey: 'leave.detail', resourceType: 'leaveRequest' }, [
        ADMIN_FULL,
      ]),
    ).toEqual({ route: 'leaves', resourceId: null });

    expect(
      resolveNotificationTarget(
        {
          routeKey: 'purchasing.requests.detail',
          resourceType: 'purchase_request',
          resourceId: 'pr-1',
        },
        [ADMIN_FULL],
      ),
    ).toEqual({ route: 'purchasing', resourceId: 'pr-1' });
  });

  it('is a no-op when the server sent no descriptor at all', () => {
    expect(resolveNotificationTarget(undefined, [ADMIN_FULL])).toBeNull();
    expect(isNavigable(undefined, [ADMIN_FULL])).toBe(false);
  });
});
