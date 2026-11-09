import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers';
import { makeChatPrisma, chatToken } from './chat_test_helpers';

const openDirect = (app: any, actorId = 'u1', employeeId = 'e1', recipientId = 'u2') =>
  request(app)
    .post('/api/chat/direct')
    .set('Authorization', `Bearer ${chatToken(actorId, employeeId)}`)
    .send({ userId: recipientId });

describe('Sprint 8 chat API', () => {
  it('returns only active same-company directory users with a safe projection', async () => {
    const prisma = makeChatPrisma();
    const res = await request(makeApp(prisma))
      .get('/api/chat/directory?query=employee&limit=20')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`);

    expect(res.status).toBe(200);
    expect(res.body.map((row: any) => row.userId)).toEqual(['u2']);
    expect(res.body[0]).toEqual(expect.objectContaining({
      displayName: 'Employee Two',
      employeeId: 'e2',
      departmentId: 'd1',
      roleName: 'Employee',
    }));
    expect(JSON.stringify(res.body)).not.toMatch(/password|email|permissions|hash/i);

    const all = await request(makeApp(prisma))
      .get('/api/chat/directory')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`);
    expect(all.body.map((row: any) => row.userId).sort()).toEqual(['u2', 'u3']);
    expect(all.body.some((row: any) => ['u1', 'ui', 'uf', 'ua', 'uh'].includes(row.userId))).toBe(false);
  });

  it('allows Primary Owner with null employeeId to load chat directory', async () => {
    const prisma = makeChatPrisma();
    const res = await request(makeApp(prisma))
      .get('/api/chat/directory')
      .set('Authorization', `Bearer ${chatToken('upo', null, 'c1', ['admin.full', 'chat.view', 'employees.view'])}`);

    expect(res.status).toBe(200);
    expect(res.body.some((row: any) => row.userId === 'u1')).toBe(true);
  });

  it('rejects inactive employees from chat while managers see them in directory', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const inactiveToken = chatToken('ui', 'ei');
    const denied = await request(app)
      .get('/api/chat/directory')
      .set('Authorization', `Bearer ${inactiveToken}`);
    expect(denied.status).toBe(403);

    const manager = await request(app)
      .get('/api/chat/directory')
      .set('Authorization', `Bearer ${chatToken('u3', 'e3', 'c1', ['chat.view', 'chat.create_direct', 'employees.view'])}`);
    expect(manager.status).toBe(200);
    const inactive = manager.body.find((row: any) => row.userId === 'ui');
    expect(inactive).toEqual(expect.objectContaining({
      displayName: 'Inactive',
      status: 'inactive',
    }));
  });

  it('opens one deterministic direct conversation with exactly two participants', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const first = await openDirect(app);
    const repeated = await openDirect(app);
    const reverse = await openDirect(app, 'u2', 'e2', 'u1');

    expect(first.status).toBe(200);
    expect(repeated.body.id).toBe(first.body.id);
    expect(reverse.body.id).toBe(first.body.id);
    expect(prisma._store.chatConversations).toHaveLength(1);
    expect(prisma._store.chatParticipants.filter((row: any) => row.active)).toHaveLength(2);
    expect(prisma._store.chatConversations[0].directKey).toBe('u1:u2');
    expect(JSON.stringify(first.body)).not.toMatch(/password|permissions|email/i);
  });

  it('handles concurrent direct-open attempts without duplicate conversations', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const [left, right] = await Promise.all([openDirect(app), openDirect(app)]);

    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    expect(left.body.id).toBe(right.body.id);
    expect(prisma._store.chatConversations).toHaveLength(1);
    expect(prisma._store.chatParticipants).toHaveLength(2);
  });

  it('rejects self and foreign direct recipients without existence leakage', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const self = await openDirect(app, 'u1', 'e1', 'u1');
    const foreign = await openDirect(app, 'u1', 'e1', 'uf');

    expect(self.status).toBe(400);
    expect(foreign.status).toBe(404);
    expect(prisma._store.chatConversations).toHaveLength(0);
  });

  it('opens department channels only for current members or managers', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const deptPerms = ['chat.view', 'chat.create_department'];
    const employee = await request(app)
      .post('/api/chat/departments/d1/open')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1', 'c1', deptPerms)}`);
    const manager = await request(app)
      .post('/api/chat/departments/d1/open')
      .set('Authorization', `Bearer ${chatToken('u3', 'e3', 'c1', deptPerms)}`);
    const hr = await request(app)
      .post('/api/chat/departments/d1/open')
      .set('Authorization', `Bearer ${chatToken('uh', 'eh', 'c1', deptPerms)}`);
    const admin = await request(app)
      .post('/api/chat/departments/d1/open')
      .set('Authorization', `Bearer ${chatToken('ua', 'ea', 'c1', ['admin.full'])}`);
    const foreign = await request(app)
      .post('/api/chat/departments/df/open')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1', 'c1', deptPerms)}`);

    expect(employee.status).toBe(200);
    expect(manager.status).toBe(200);
    expect(manager.body.id).toBe(employee.body.id);
    expect(hr.status).toBe(404);
    expect(admin.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(prisma._store.chatConversations).toHaveLength(1);
  });

  it('lists only current or managed departments for channel opening', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const employee = await request(app)
      .get('/api/chat/departments')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`);
    const manager = await request(app)
      .get('/api/chat/departments')
      .set('Authorization', `Bearer ${chatToken('u3', 'e3')}`);
    const hr = await request(app)
      .get('/api/chat/departments')
      .set('Authorization', `Bearer ${chatToken('uh', 'eh')}`);

    expect(employee.body).toEqual([{ id: 'd1', name: 'Engineering' }]);
    expect(manager.body).toEqual([{ id: 'd1', name: 'Engineering' }]);
    expect(hr.body).toEqual([{ id: 'd2', name: 'People' }]);
    expect(JSON.stringify(employee.body)).not.toMatch(/managerId|companyId/);
  });

  it('keeps direct histories private even from admin.full', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await openDirect(app);
    const adminToken = chatToken('ua', 'ea', 'c1', ['admin.full']);
    const messages = await request(app)
      .get(`/api/chat/conversations/${direct.body.id}/messages`)
      .set('Authorization', `Bearer ${adminToken}`);
    const list = await request(app)
      .get('/api/chat/conversations')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(messages.status).toBe(404);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);
  });

  it('sends, pages, notifies, and marks a direct conversation read safely', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await openDirect(app);
    const senderToken = chatToken('u1', 'e1');
    const receiverToken = chatToken('u2', 'e2');

    for (const body of ['one', 'two', 'three']) {
      const sent = await request(app)
        .post(`/api/chat/conversations/${direct.body.id}/messages`)
        .set('Authorization', `Bearer ${senderToken}`)
        .send({ body });
      expect(sent.status).toBe(201);
      expect(sent.body.body).toBe(body);
      expect(sent.body.isOwn).toBe(true);
    }

    const firstPage = await request(app)
      .get(`/api/chat/conversations/${direct.body.id}/messages?limit=2`)
      .set('Authorization', `Bearer ${receiverToken}`);
    const secondPage = await request(app)
      .get(`/api/chat/conversations/${direct.body.id}/messages?limit=2&before=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set('Authorization', `Bearer ${receiverToken}`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items.map((row: any) => row.body)).toEqual(['two', 'three']);
    expect(secondPage.body.items.map((row: any) => row.body)).toEqual(['one']);
    expect(new Set([...firstPage.body.items, ...secondPage.body.items].map((row: any) => row.id)).size).toBe(3);

    const listBeforeRead = await request(app)
      .get('/api/chat/conversations')
      .set('Authorization', `Bearer ${receiverToken}`);
    expect(listBeforeRead.body.items[0].unreadCount).toBe(3);
    const read = await request(app)
      .post(`/api/chat/conversations/${direct.body.id}/read`)
      .set('Authorization', `Bearer ${receiverToken}`);
    const unread = await request(app)
      .get('/api/chat/unread-count')
      .set('Authorization', `Bearer ${receiverToken}`);
    expect(read.body.unreadCount).toBe(0);
    expect(unread.body.unreadCount).toBe(0);

    expect(prisma._store.notifications).toHaveLength(3);
    expect(prisma._store.notifications.every((row: any) => row.userId === 'u2')).toBe(true);
    const sendAudits = prisma._store.auditLogs.filter((row: any) => row.action === 'chat.message.send');
    expect(sendAudits).toHaveLength(3);
    expect(sendAudits.every((row: any) => {
      const details = JSON.parse(row.details);
      return !('body' in details) && details.bodyLength > 0;
    })).toBe(true);
    expect(JSON.stringify(sendAudits)).not.toContain('three');
  });

  it('rejects invalid message bodies and nonmembers without creating messages', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await openDirect(app);
    const senderToken = chatToken('u1', 'e1');
    const blank = await request(app)
      .post(`/api/chat/conversations/${direct.body.id}/messages`)
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ body: '   ' });
    const oversized = await request(app)
      .post(`/api/chat/conversations/${direct.body.id}/messages`)
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ body: 'x'.repeat(4001) });
    const admin = await request(app)
      .post(`/api/chat/conversations/${direct.body.id}/messages`)
      .set('Authorization', `Bearer ${chatToken('ua', 'ea', 'c1', ['admin.full'])}`)
      .send({ body: 'private bypass' });

    expect(blank.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(admin.status).toBe(404);
    expect(prisma._store.chatMessages).toHaveLength(0);
  });

  it('does not fan out notifications for department messages', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const deptPerms = ['chat.view', 'chat.create_department'];
    const channel = await request(app)
      .post('/api/chat/departments/d1/open')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1', 'c1', deptPerms)}`);
    const sent = await request(app)
      .post(`/api/chat/conversations/${channel.body.id}/messages`)
      .set('Authorization', `Bearer ${chatToken('u1', 'e1', 'c1', deptPerms)}`)
      .send({ body: 'department update' });

    expect(sent.status).toBe(201);
    expect(prisma._store.notifications).toHaveLength(0);
  });

  it('enforces the configured message-send rate limit', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma, { chatMessageRateLimitWindowMs: 60_000, chatMessageRateLimitMax: 1 });
    const direct = await openDirect(app);
    const token = chatToken('u1', 'e1');
    const first = await request(app)
      .post(`/api/chat/conversations/${direct.body.id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'first' });
    const second = await request(app)
      .post(`/api/chat/conversations/${direct.body.id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'second' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(prisma._store.chatMessages).toHaveLength(1);
  });
});
