import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  shapeNotificationDto,
  validateNotificationDescriptor,
} from '../src/notifications';
import { PERMISSIONS } from '../src/permissions';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

function seedNotification(
  store: any[],
  overrides: Partial<{
    id: string;
    companyId: string;
    userId: string;
    title: string;
    message: string;
    category: string;
    routeKey: string | null;
    resourceType: string | null;
    resourceId: string | null;
    filterJson: string | null;
    isRead: boolean;
    readAt: Date | null;
    hiddenAt: Date | null;
    createdAt: Date;
  }> = {},
) {
  const now = new Date();
  store.push({
    id: 'n-default',
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

describe('notifications v2', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    prisma = makeFakePrisma();
    app = makeApp(prisma);
  });

  it('lists only the authenticated user inbox', async () => {
    seedNotification(prisma._store.notifications, { id: 'n-own', userId: 'u1' });
    seedNotification(prisma._store.notifications, { id: 'n-other-user', userId: 'u2' });

    const res = await request(app)
      .get('/api/v2/notifications')
      .set(
        'Authorization',
        `Bearer ${tokenFor({ id: 'u1', permissions: [PERMISSIONS.NOTIFICATIONS_VIEW] })}`,
      );

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('n-own');
    expect(res.body.items[0]).not.toHaveProperty('userId');
    expect(res.body.items[0]).not.toHaveProperty('companyId');
  });

  it('hides a notification and excludes it from the default list', async () => {
    seedNotification(prisma._store.notifications, { id: 'n-hide-me', userId: 'u1' });
    const token = tokenFor({ id: 'u1', permissions: [PERMISSIONS.NOTIFICATIONS_VIEW] });

    const hideRes = await request(app)
      .post('/api/v2/notifications/n-hide-me/hide')
      .set('Authorization', `Bearer ${token}`);
    expect(hideRes.status).toBe(204);

    const listRes = await request(app)
      .get('/api/v2/notifications')
      .set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(0);

    const hiddenListRes = await request(app)
      .get('/api/v2/notifications?hidden=true')
      .set('Authorization', `Bearer ${token}`);
    expect(hiddenListRes.status).toBe(200);
    expect(hiddenListRes.body.items).toHaveLength(1);
    expect(hiddenListRes.body.items[0].hiddenAt).not.toBeNull();
  });

  it('marks all unread notifications as read with readAt dual-write', async () => {
    seedNotification(prisma._store.notifications, { id: 'n1', userId: 'u1', isRead: false });
    seedNotification(prisma._store.notifications, { id: 'n2', userId: 'u1', isRead: false });
    seedNotification(prisma._store.notifications, { id: 'n-read', userId: 'u1', isRead: true, readAt: new Date() });

    const res = await request(app)
      .post('/api/v2/notifications/read-all')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u1' })}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(2);
    expect(prisma._store.notifications.find((row) => row.id === 'n1')).toMatchObject({
      isRead: true,
    });
    expect(prisma._store.notifications.find((row) => row.id === 'n1').readAt).toBeTruthy();
    expect(prisma._store.notifications.find((row) => row.id === 'n2').readAt).toBeTruthy();
  });

  it('rejects disabling mandatory security notification preferences', async () => {
    const res = await request(app)
      .put('/api/v2/notifications/preferences')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u1' })}`)
      .send({
        preferences: [{ category: 'security', inAppEnabled: false }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MandatoryCategory');

    const getRes = await request(app)
      .get('/api/v2/notifications/preferences')
      .set('Authorization', `Bearer ${tokenFor({ id: 'u1' })}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.preferences.find((row: any) => row.category === 'security')).toMatchObject({
      inAppEnabled: true,
      mandatory: true,
    });
  });

  it('rejects unknown routeKey descriptors', () => {
    expect(() => validateNotificationDescriptor('unknown.route', 'leaveRequest')).toThrow();
    const dto = shapeNotificationDto({
      id: 'n1',
      title: 'Legacy',
      message: 'Safe text',
      category: 'leave',
      routeKey: 'unknown.route',
      resourceType: 'leaveRequest',
      resourceId: 'lr-1',
      isRead: false,
      createdAt: new Date(),
    });
    expect(dto.descriptor).toBeUndefined();
  });

  it('returns opaque 404 for cross-tenant or foreign inbox ids', async () => {
    seedNotification(prisma._store.notifications, {
      id: 'n-foreign',
      companyId: 'c2',
      userId: 'u9',
    });
    seedNotification(prisma._store.notifications, {
      id: 'n-same-company-other-user',
      companyId: 'c1',
      userId: 'u2',
    });

    const token = tokenFor({ id: 'u1', companyId: 'c1' });

    for (const id of ['n-foreign', 'n-same-company-other-user', 'missing-id']) {
      const readRes = await request(app)
        .post(`/api/v2/notifications/${id}/read`)
        .set('Authorization', `Bearer ${token}`);
      expect(readRes.status).toBe(404);
      expect(readRes.body.messageKey).toBe('notification.not_found');

      const hideRes = await request(app)
        .post(`/api/v2/notifications/${id}/hide`)
        .set('Authorization', `Bearer ${token}`);
      expect(hideRes.status).toBe(404);
      expect(hideRes.body.messageKey).toBe('notification.not_found');
    }
  });

  it('includes allowlisted typed descriptors without chat message bodies', () => {
    const dto = shapeNotificationDto({
      id: 'n-chat',
      title: 'رسالة داخلية جديدة',
      message: 'لديك رسالة جديدة في المحادثات الداخلية.',
      category: 'chat',
      routeKey: 'chat.conversation',
      resourceType: 'chatConversation',
      resourceId: 'conv-1',
      isRead: false,
      createdAt: new Date(),
    });

    expect(dto.descriptor).toEqual({
      routeKey: 'chat.conversation',
      resourceType: 'chatConversation',
      resourceId: 'conv-1',
    });
    expect(JSON.stringify(dto)).not.toMatch(/messageBody|bodyText|chatBody/i);
  });
});
