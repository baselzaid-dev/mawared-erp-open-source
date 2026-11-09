import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers';
import { chatToken, makeChatPrisma } from './chat_test_helpers';

const openDirect = (app: any, actorId = 'u1', employeeId = 'e1', recipientId = 'u2', permissions?: string[]) =>
  request(app)
    .post('/api/chat/direct')
    .set('Authorization', `Bearer ${chatToken(actorId, employeeId, 'c1', permissions ?? ['chat.view', 'chat.create_direct'])}`)
    .send({ userId: recipientId });

describe('Sprint 12K chat enhancements', () => {
  it('requires chat.create_direct to open a direct conversation', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const denied = await request(app)
      .post('/api/chat/direct')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1', 'c1', ['chat.view'])}`)
      .send({ userId: 'u2' });

    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('ChatCreateForbidden');
    expect(prisma._store.chatConversations).toHaveLength(0);
  });

  it('requires chat.create_department to open a department channel', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const denied = await request(app)
      .post('/api/chat/departments/d1/open')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1', 'c1', ['chat.view'])}`);

    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('ChatCreateForbidden');
    expect(prisma._store.chatConversations).toHaveLength(0);
  });

  it('lets company-wide directory browsers see every active employee', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const res = await request(app)
      .get('/api/chat/directory')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1', 'c1', ['chat.view', 'employees.view'])}`);

    expect(res.status).toBe(200);
    expect(res.body.some((row: any) => row.userId === 'ua')).toBe(true);
    expect(res.body.some((row: any) => row.userId === 'uh')).toBe(true);
  });

  it('does not widen directory for chat.create_department alone', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const res = await request(app)
      .get('/api/chat/directory')
      .set('Authorization', `Bearer ${chatToken('u3', 'e3', 'c1', [
        'chat.view',
        'chat.create_department',
        'chat.create_direct',
      ])}`);

    expect(res.status).toBe(200);
    expect(res.body.some((row: any) => row.userId === 'u1')).toBe(true);
    expect(res.body.some((row: any) => row.userId === 'u2')).toBe(true);
    expect(res.body.some((row: any) => row.userId === 'uh')).toBe(false);
    expect(res.body.some((row: any) => row.userId === 'ua')).toBe(false);
  });

  it('blocks cross-department direct opens for scoped employees', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const denied = await openDirect(app, 'u1', 'e1', 'uh');

    expect(denied.status).toBe(404);
    expect(denied.body.error).toBe('ChatRecipientNotFound');
    expect(prisma._store.chatConversations).toHaveLength(0);

    const allowed = await openDirect(app, 'u1', 'e1', 'u2');
    expect(allowed.status).toBe(200);
    expect(allowed.body.type).toBe('direct');
  });

  it('allows company-wide viewers to open cross-department directs', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const allowed = await openDirect(app, 'u1', 'e1', 'uh', [
      'chat.view',
      'chat.create_direct',
      'employees.view',
    ]);

    expect(allowed.status).toBe(200);
    expect(allowed.body.type).toBe('direct');
  });

  it('creates company announcements with optional first message and disabled replies', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const hrToken = chatToken('uh', 'eh', 'c1', [
      'chat.view',
      'chat.create_company_announcement',
    ]);
    const created = await request(app)
      .post('/api/chat/announcements')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ title: 'Holiday hours', body: 'Office closes at 2pm Friday.' });

    expect(created.status).toBe(201);
    expect(created.body.type).toBe('announcement');
    expect(created.body.title).toBe('Holiday hours');
    expect(prisma._store.chatConversations).toHaveLength(1);
    expect(prisma._store.chatConversations[0].repliesEnabled).toBe(false);
    expect(prisma._store.chatMessages).toHaveLength(1);

    const employeeToken = chatToken('u1', 'e1');
    const messages = await request(app)
      .get(`/api/chat/conversations/${created.body.id}/messages`)
      .set('Authorization', `Bearer ${employeeToken}`);
    expect(messages.status).toBe(200);
    expect(messages.body.items[0].body).toBe('Office closes at 2pm Friday.');

    const blocked = await request(app)
      .post(`/api/chat/conversations/${created.body.id}/messages`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ body: 'Can we leave earlier?' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('ChatRepliesDisabled');
  });

  it('exposes repliesEnabled true for direct chats and false for announcements', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await openDirect(app);
    expect(direct.status).toBe(200);
    expect(direct.body.repliesEnabled).toBe(true);
    expect(prisma._store.chatConversations[0].repliesEnabled).toBe(true);

    const dept = await request(app)
      .post('/api/chat/departments/d1/open')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1', 'c1', [
        'chat.view',
        'chat.create_department',
      ])}`);
    expect(dept.status).toBe(200);
    expect(dept.body.repliesEnabled).toBe(true);
    expect(
      prisma._store.chatConversations.find((row: any) => row.type === 'department')?.repliesEnabled
    ).toBe(true);

    const hrToken = chatToken('uh', 'eh', 'c1', [
      'chat.view',
      'chat.create_company_announcement',
    ]);
    const announcement = await request(app)
      .post('/api/chat/announcements')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ title: 'Closed replies' });
    expect(announcement.status).toBe(201);
    expect(announcement.body.repliesEnabled).toBe(false);
  });

  it('lists announcements and counts them in unread totals for any active employee', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const hrToken = chatToken('uh', 'eh', 'c1', [
      'chat.view',
      'chat.create_company_announcement',
    ]);
    const created = await request(app)
      .post('/api/chat/announcements')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ title: 'Policy update', body: 'New dress code starts Monday.' });

    const employeeToken = chatToken('u1', 'e1');
    const list = await request(app)
      .get('/api/chat/conversations')
      .set('Authorization', `Bearer ${employeeToken}`);
    const unread = await request(app)
      .get('/api/chat/unread-count')
      .set('Authorization', `Bearer ${employeeToken}`);

    expect(list.status).toBe(200);
    expect(list.body.items.some((row: any) => row.id === created.body.id && row.type === 'announcement')).toBe(true);
    expect(unread.body.unreadCount).toBe(1);
  });

  it('rejects announcement creation without chat.create_company_announcement', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const res = await request(app)
      .post('/api/chat/announcements')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({ title: 'Blocked' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ChatCreateForbidden');
  });

  it('stores replyToMessageId when replying inside an allowed conversation', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await openDirect(app);
    const senderToken = chatToken('u1', 'e1');
    const first = await request(app)
      .post(`/api/chat/conversations/${direct.body.id}/messages`)
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ body: 'original' });
    const reply = await request(app)
      .post(`/api/chat/conversations/${direct.body.id}/messages`)
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ body: 'follow-up', replyToMessageId: first.body.id });

    expect(reply.status).toBe(201);
    expect(reply.body.replyToMessageId).toBe(first.body.id);
  });

  it('rejects replies that reference a message from another conversation', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const left = await openDirect(app, 'u1', 'e1', 'u2');
    const right = await openDirect(app, 'u1', 'e1', 'u3');
    const foreign = await request(app)
      .post(`/api/chat/conversations/${left.body.id}/messages`)
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({ body: 'left only' });
    const blocked = await request(app)
      .post(`/api/chat/conversations/${right.body.id}/messages`)
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({ body: 'wrong thread', replyToMessageId: foreign.body.id });

    expect(blocked.status).toBe(404);
    expect(blocked.body.error).toBe('ChatMessageNotFound');
  });

  it('pins and unpins messages in the same conversation with chat.pin', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await openDirect(app);
    const sent = await request(app)
      .post(`/api/chat/conversations/${direct.body.id}/messages`)
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({ body: 'pin me' });
    const pinToken = chatToken('u1', 'e1', 'c1', ['chat.view', 'chat.create_direct', 'chat.pin']);

    const firstPin = await request(app)
      .post(`/api/chat/conversations/${direct.body.id}/pins`)
      .set('Authorization', `Bearer ${pinToken}`)
      .send({ messageId: sent.body.id });
    const duplicatePin = await request(app)
      .post(`/api/chat/conversations/${direct.body.id}/pins`)
      .set('Authorization', `Bearer ${pinToken}`)
      .send({ messageId: sent.body.id });
    const listed = await request(app)
      .get(`/api/chat/conversations/${direct.body.id}/pins`)
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`);

    expect(firstPin.status).toBe(201);
    expect(duplicatePin.status).toBe(200);
    expect(duplicatePin.body.messageId).toBe(sent.body.id);
    expect(listed.body.items).toHaveLength(1);

    const removed = await request(app)
      .delete(`/api/chat/conversations/${direct.body.id}/pins/${sent.body.id}`)
      .set('Authorization', `Bearer ${pinToken}`);
    const after = await request(app)
      .get(`/api/chat/conversations/${direct.body.id}/pins`)
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`);

    expect(removed.status).toBe(204);
    expect(after.body.items).toHaveLength(0);
  });

  it('rejects pin actions without chat.pin', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await openDirect(app);
    const sent = await request(app)
      .post(`/api/chat/conversations/${direct.body.id}/messages`)
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({ body: 'no pin permission' });
    const res = await request(app)
      .post(`/api/chat/conversations/${direct.body.id}/pins`)
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({ messageId: sent.body.id });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ChatCreateForbidden');
  });

  it('keeps admin.full opaque on non-member direct conversations', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await openDirect(app);
    const adminToken = chatToken('ua', 'ea', 'c1', ['admin.full']);

    const messages = await request(app)
      .get(`/api/chat/conversations/${direct.body.id}/messages`)
      .set('Authorization', `Bearer ${adminToken}`);
    const pins = await request(app)
      .get(`/api/chat/conversations/${direct.body.id}/pins`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(messages.status).toBe(404);
    expect(pins.status).toBe(404);
  });
});
