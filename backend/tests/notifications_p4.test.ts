import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  createDomainNotifications,
  NOTIFICATION_CATEGORIES,
  shapeNotificationDto,
} from '../src/notifications';
import { PERMISSIONS } from '../src/permissions';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

/**
 * Commercial P4 — the shared notification producer and the v2 unread count.
 *
 * Before P4 every module wrote notification rows by hand, so a producer could
 * (and did) emit an uncategorised row, or a deep link the reader would silently
 * discard, or one that ignored the recipient's own preferences. These tests
 * hold the single producer to all three guarantees.
 */

const actorToken = tokenFor({
  id: 'u1',
  companyId: 'c1',
  employeeId: 'e1',
  permissions: [PERMISSIONS.NOTIFICATIONS_VIEW],
});

const seed = (store: any[], overrides: Record<string, unknown> = {}) => {
  store.push({
    id: `n-${store.length + 1}`,
    companyId: 'c1',
    userId: 'u1',
    title: 'Title',
    message: 'Safe summary only',
    category: 'general',
    routeKey: null,
    resourceType: null,
    resourceId: null,
    filterJson: null,
    isRead: false,
    readAt: null,
    hiddenAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
};

describe('P4 shared notification producer', () => {
  it('writes one row per recipient with the category and allowlisted descriptor', async () => {
    const prisma = makeFakePrisma();

    const written = await createDomainNotifications(prisma, {
      companyId: 'c1',
      userIds: ['user-a', 'user-b'],
      title: 'مهمة جديدة',
      message: 'تم إسناد مهمة جديدة إليك.',
      category: 'task',
      descriptor: { routeKey: 'task.detail', resourceType: 'task', resourceId: 'task-1' },
    });

    expect(written).toBe(2);
    expect(prisma._store.notifications).toHaveLength(2);
    for (const row of prisma._store.notifications) {
      expect(row.category).toBe('task');
      expect(row.routeKey).toBe('task.detail');
      expect(row.resourceType).toBe('task');
      expect(row.resourceId).toBe('task-1');
    }
  });

  it('de-duplicates recipients so one person is never told twice', async () => {
    const prisma = makeFakePrisma();

    const written = await createDomainNotifications(prisma, {
      companyId: 'c1',
      userIds: ['user-a', 'user-a', 'user-a'],
      title: 'T',
      message: 'M',
      category: 'task',
    });

    expect(written).toBe(1);
    expect(prisma._store.notifications).toHaveLength(1);
  });

  it('skips a recipient who disabled the category but still delivers to the others', async () => {
    const prisma = makeFakePrisma();
    prisma._store.notificationPreferences.push({
      id: 'pref-1',
      companyId: 'c1',
      userId: 'user-a',
      category: 'training',
      inAppEnabled: false,
    });

    const written = await createDomainNotifications(prisma, {
      companyId: 'c1',
      userIds: ['user-a', 'user-b'],
      title: 'T',
      message: 'M',
      category: 'training',
    });

    expect(written).toBe(1);
    expect(prisma._store.notifications.map((row: any) => row.userId)).toEqual(['user-b']);
  });

  it('ignores preferences for the mandatory security category', async () => {
    const prisma = makeFakePrisma();
    prisma._store.notificationPreferences.push({
      id: 'pref-1',
      companyId: 'c1',
      userId: 'user-a',
      category: 'security',
      inAppEnabled: false,
    });

    const written = await createDomainNotifications(prisma, {
      companyId: 'c1',
      userIds: ['user-a'],
      title: 'T',
      message: 'M',
      category: 'security',
    });

    expect(written).toBe(1);
  });

  it('reads preferences once for the whole fan-out rather than once per recipient', async () => {
    const prisma = makeFakePrisma();

    await createDomainNotifications(prisma, {
      companyId: 'c1',
      userIds: ['a', 'b', 'c', 'd', 'e'],
      title: 'T',
      message: 'M',
      category: 'task',
    });

    // Five recipients must not mean five preference queries.
    expect(prisma.notificationPreference.findMany).toHaveBeenCalledTimes(1);
  });

  it('refuses a descriptor the reader would silently discard', async () => {
    const prisma = makeFakePrisma();

    await expect(
      createDomainNotifications(prisma, {
        companyId: 'c1',
        userIds: ['user-a'],
        title: 'T',
        message: 'M',
        category: 'task',
        // Not on ALLOWLISTED_ROUTE_KEYS — must fail loudly at write time rather
        // than be dropped later by shapeNotificationDto.
        descriptor: { routeKey: 'task.secret' as never, resourceType: 'task' },
      }),
    ).rejects.toBeTruthy();
    expect(prisma._store.notifications).toHaveLength(0);
  });

  it('refuses a resource type the route key does not accept', async () => {
    const prisma = makeFakePrisma();

    await expect(
      createDomainNotifications(prisma, {
        companyId: 'c1',
        userIds: ['user-a'],
        title: 'T',
        message: 'M',
        category: 'chat',
        descriptor: { routeKey: 'chat.conversation', resourceType: 'leaveRequest' },
      }),
    ).rejects.toBeTruthy();
    expect(prisma._store.notifications).toHaveLength(0);
  });

  it('is a no-op for an empty recipient list', async () => {
    const prisma = makeFakePrisma();
    expect(
      await createDomainNotifications(prisma, {
        companyId: 'c1',
        userIds: [],
        title: 'T',
        message: 'M',
        category: 'task',
      }),
    ).toBe(0);
    expect(prisma.notificationPreference.findMany).not.toHaveBeenCalled();
  });
});

describe('P4 notification categories', () => {
  it('includes purchasing and training so those rows are filterable and displayable', () => {
    // `purchasing` was already being written by purchasingOverride.ts while
    // absent from this list, which made those rows render as "general".
    expect(NOTIFICATION_CATEGORIES).toContain('purchasing');
    expect(NOTIFICATION_CATEGORIES).toContain('training');
  });

  it('surfaces a purchasing row under its own category instead of general', () => {
    const dto = shapeNotificationDto({
      id: 'n-1',
      title: 'T',
      message: 'M',
      category: 'purchasing',
      isRead: false,
      createdAt: new Date(),
    });
    expect(dto.category).toBe('purchasing');
  });

  it('exposes the training deep link', () => {
    const dto = shapeNotificationDto({
      id: 'n-1',
      title: 'T',
      message: 'M',
      category: 'training',
      routeKey: 'training.assignment.detail',
      resourceType: 'trainingAssignment',
      resourceId: 'assignment-1',
      isRead: false,
      createdAt: new Date(),
    });
    expect(dto.descriptor).toEqual({
      routeKey: 'training.assignment.detail',
      resourceType: 'trainingAssignment',
      resourceId: 'assignment-1',
    });
  });
});

describe('P4 v2 unread count', () => {
  it('counts only the caller\'s own unread, non-hidden rows', async () => {
    const prisma = makeFakePrisma();
    seed(prisma._store.notifications, { id: 'n-1', isRead: false });
    seed(prisma._store.notifications, { id: 'n-2', isRead: true });
    seed(prisma._store.notifications, { id: 'n-3', isRead: false, hiddenAt: new Date() });
    // Another user's unread row in the same company must not be counted.
    seed(prisma._store.notifications, { id: 'n-4', isRead: false, userId: 'u2' });
    // Another company's row for the same user id must not be counted either.
    seed(prisma._store.notifications, { id: 'n-5', isRead: false, companyId: 'c2' });

    const response = await request(makeApp(prisma))
      .get('/api/v2/notifications/unread-count')
      .set('Authorization', `Bearer ${actorToken}`);

    expect(response.status).toBe(200);
    expect(response.body.unreadCount).toBe(1);
  });

  it('narrows the count to one category when asked', async () => {
    const prisma = makeFakePrisma();
    seed(prisma._store.notifications, { id: 'n-1', category: 'task' });
    seed(prisma._store.notifications, { id: 'n-2', category: 'task' });
    seed(prisma._store.notifications, { id: 'n-3', category: 'chat' });

    const response = await request(makeApp(prisma))
      .get('/api/v2/notifications/unread-count?category=task')
      .set('Authorization', `Bearer ${actorToken}`);

    expect(response.body.unreadCount).toBe(2);
  });

  it('rejects an unknown category rather than counting everything', async () => {
    const prisma = makeFakePrisma();
    seed(prisma._store.notifications);

    const response = await request(makeApp(prisma))
      .get('/api/v2/notifications/unread-count?category=not-a-category')
      .set('Authorization', `Bearer ${actorToken}`);

    expect(response.status).toBe(400);
  });

  it('needs the notifications.view permission', async () => {
    const prisma = makeFakePrisma();
    seed(prisma._store.notifications);

    const response = await request(makeApp(prisma))
      .get('/api/v2/notifications/unread-count')
      .set(
        'Authorization',
        `Bearer ${tokenFor({ id: 'u1', companyId: 'c1', employeeId: 'e1', permissions: [] })}`,
      );

    expect(response.status).toBe(403);
  });
});
