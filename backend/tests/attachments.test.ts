import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';
import { attachmentLimits, assertContentMatchesDeclaredType } from '../src/attachments';
import { makeChatPrisma, chatToken } from './chat_test_helpers';
import { addPurchasingIdentity, makePurchasingPrisma } from './purchasing_test_helpers';

const pdfBase64 = Buffer.from('%PDF-1.4 mawared-test').toString('base64');
const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const exeDisguisedAsPdf = Buffer.concat([
  Buffer.from([0x4d, 0x5a]), // MZ
  Buffer.from(' this is not a pdf'),
]);

const purchasingToken = tokenFor({
  id: 'u1',
  companyId: 'c1',
  employeeId: 'e1',
  permissions: ['purchasing.view', 'purchasing.manage', 'purchasing.create'],
});

describe('QA Round 1 attachments API', () => {
  it('uploads, returns metadata, lists, and streams content with company isolation', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);

    const uploaded = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${purchasingToken}`)
      .send({
        purpose: 'purchasing',
        purchaseOrderId: 'po-1',
        originalFilename: 'quote.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });

    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toEqual(expect.objectContaining({
      originalFilename: 'quote.pdf',
      contentType: 'application/pdf',
      purpose: 'purchasing',
      purchaseOrderId: 'po-1',
      companyId: 'c1',
    }));
    expect(uploaded.body.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(uploaded.body.storageBytes).toBeUndefined();
    expect(prisma._store.auditLogs.some((row: any) => row.action === 'attachment.upload')).toBe(true);

    const listed = await request(app)
      .get('/api/attachments?purchaseOrderId=po-1')
      .set('Authorization', `Bearer ${purchasingToken}`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].id).toBe(uploaded.body.id);

    const content = await request(app)
      .get(`/api/attachments/${uploaded.body.id}/content`)
      .set('Authorization', `Bearer ${purchasingToken}`);
    expect(content.status).toBe(200);
    expect(content.headers['content-type']).toMatch(/application\/pdf/);
    expect(Buffer.from(content.body).toString()).toContain('%PDF-1.4');

    const foreign = await request(app)
      .get(`/api/attachments/${uploaded.body.id}`)
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-foreign',
        companyId: 'c2',
        employeeId: 'e9',
        permissions: ['purchasing.view', 'purchasing.manage'],
      })}`);
    expect(foreign.status).toBe(404);
  });

  it('rejects executables, oversized payloads, disallowed MIME types, and disguised content', async () => {
    const prisma = makeFakePrisma();
    const app = makeApp(prisma);

    const exe = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${purchasingToken}`)
      .send({
        purpose: 'purchasing',
        purchaseOrderId: 'po-1',
        originalFilename: 'malware.exe',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(exe.status).toBe(400);
    expect(exe.body.error).toBe('AttachmentExecutableRejected');

    const mime = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${purchasingToken}`)
      .send({
        purpose: 'purchasing',
        purchaseOrderId: 'po-1',
        originalFilename: 'note.txt',
        contentType: 'text/plain',
        contentBase64: Buffer.from('hello').toString('base64'),
      });
    expect(mime.status).toBe(415);

    const disguised = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${purchasingToken}`)
      .send({
        purpose: 'purchasing',
        purchaseOrderId: 'po-1',
        originalFilename: 'invoice.pdf',
        contentType: 'application/pdf',
        contentBase64: exeDisguisedAsPdf.toString('base64'),
      });
    expect(disguised.status).toBe(415);
    expect(disguised.body.error).toBe('AttachmentContentRejected');

    const oversized = Buffer.alloc(attachmentLimits.maxBytes + 1, 1).toString('base64');
    const big = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${purchasingToken}`)
      .send({
        purpose: 'purchasing',
        purchaseOrderId: 'po-1',
        originalFilename: 'big.pdf',
        contentType: 'application/pdf',
        contentBase64: oversized,
      });
    expect(big.status).toBe(413);
  });

  it('rejects obvious mismatched binary signatures at the helper boundary', () => {
    expect(() => assertContentMatchesDeclaredType('application/pdf', exeDisguisedAsPdf)).toThrow();
    expect(() => assertContentMatchesDeclaredType('image/png', Buffer.from('%PDF-1.4'))).toThrow();
    expect(() => assertContentMatchesDeclaredType('image/png', pngBytes)).not.toThrow();
    expect(() => assertContentMatchesDeclaredType('application/pdf', Buffer.from('%PDF-1.4'))).not.toThrow();
  });
});

describe('Attachment chat authorization (Blocker B/E)', () => {
  const openDirect = (app: any) =>
    request(app)
      .post('/api/chat/direct')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({ userId: 'u2' });

  it('allows active direct participant upload and returns durable message attachment metadata', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await openDirect(app);
    expect(direct.status).toBe(200);

    const uploaded = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({
        purpose: 'chat',
        conversationId: direct.body.id,
        originalFilename: 'note.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.chatMessageId).toBeTruthy();
    expect(prisma._store.chatMessages).toHaveLength(1);
    expect(prisma._store.auditLogs.some((row: any) => row.action === 'attachment.upload')).toBe(true);

    const messages = await request(app)
      .get(`/api/chat/conversations/${direct.body.id}/messages`)
      .set('Authorization', `Bearer ${chatToken('u2', 'e2')}`);
    expect(messages.status).toBe(200);
    expect(messages.body.items).toHaveLength(1);
    expect(messages.body.items[0].attachments).toEqual([
      expect.objectContaining({
        id: uploaded.body.id,
        originalFilename: 'note.pdf',
        contentType: 'application/pdf',
        byteSize: uploaded.body.byteSize,
      }),
    ]);

    const content = await request(app)
      .get(`/api/attachments/${uploaded.body.id}/content`)
      .set('Authorization', `Bearer ${chatToken('u2', 'e2')}`);
    expect(content.status).toBe(200);
  });

  it('rejects removed participant upload and download per canonical access policy', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await openDirect(app);
    const conversationId = direct.body.id;

    // Soft-remove u1 from the direct conversation.
    const participant = prisma._store.chatParticipants.find(
      (row: any) => row.conversationId === conversationId && row.userId === 'u1'
    );
    participant.active = false;

    const deniedUpload = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({
        purpose: 'chat',
        conversationId,
        originalFilename: 'note.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(deniedUpload.status).toBe(404);
    expect(prisma._store.chatMessages).toHaveLength(0);

    // Seed an attachment while u2 is still active, then remove u1 and deny download.
    participant.active = true;
    const uploaded = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({
        purpose: 'chat',
        conversationId,
        originalFilename: 'note.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(uploaded.status).toBe(201);
    participant.active = false;

    const deniedDownload = await request(app)
      .get(`/api/attachments/${uploaded.body.id}/content`)
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`);
    expect(deniedDownload.status).toBe(404);
  });

  it('rejects inaccessible department upload', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const dept = await request(app)
      .post('/api/chat/departments/d1/open')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1', 'c1', ['chat.view', 'chat.create_department'])}`);
    expect(dept.status).toBe(200);

    const denied = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${chatToken('uh', 'eh', 'c1', ['chat.view'])}`)
      .send({
        purpose: 'chat',
        conversationId: dept.body.id,
        originalFilename: 'note.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(denied.status).toBe(404);
  });

  it('rejects announcement reply attachments when replies are disabled', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const announcement = await request(app)
      .post('/api/chat/announcements')
      .set('Authorization', `Bearer ${chatToken('ua', 'ea', 'c1', ['admin.full', 'chat.view', 'chat.create_announcement'])}`)
      .send({ title: 'إعلان', body: 'نص' });
    expect(announcement.status).toBe(201);
    expect(announcement.body.repliesEnabled).toBe(false);

    const denied = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({
        purpose: 'chat',
        conversationId: announcement.body.id,
        originalFilename: 'note.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('ChatRepliesDisabled');
  });

  it('allows Primary Owner / manager chat attachment upload', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await openDirect(app);

    const owner = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${chatToken('ua', 'ea', 'c1', ['admin.full', 'chat.view'])}`)
      .send({
        purpose: 'chat',
        conversationId: direct.body.id,
        originalFilename: 'owner.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    // Owner is not a direct participant → canonical policy returns not found.
    expect(owner.status).toBe(404);

    const managerDept = await request(app)
      .post('/api/chat/departments/d1/open')
      .set('Authorization', `Bearer ${chatToken('u3', 'e3', 'c1', ['chat.view', 'chat.create_department'])}`);
    const managerUpload = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${chatToken('u3', 'e3', 'c1', ['chat.view', 'chat.create_department'])}`)
      .send({
        purpose: 'chat',
        conversationId: managerDept.body.id,
        originalFilename: 'mgr.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(managerUpload.status).toBe(201);
  });

  it('enforces chat message rate limit for attachment-generated messages', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma, { chatMessageRateLimitWindowMs: 60_000, chatMessageRateLimitMax: 1 });
    const direct = await openDirect(app);

    const first = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({
        purpose: 'chat',
        conversationId: direct.body.id,
        originalFilename: 'one.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({
        purpose: 'chat',
        conversationId: direct.body.id,
        originalFilename: 'two.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(second.status).toBe(429);
    expect(second.body.error).toBe('ChatRateLimitExceeded');
  });

  it('rejects cross-company conversation IDs', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await openDirect(app);

    const denied = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${chatToken('uf', 'ef', 'c2', ['chat.view', 'chat.create_direct'])}`)
      .send({
        purpose: 'chat',
        conversationId: direct.body.id,
        originalFilename: 'note.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(denied.status).toBe(404);
  });

  it('rejects unrelated same-company chat user and purchasing-only user from chat attachment', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await openDirect(app);
    const uploaded = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({
        purpose: 'chat',
        conversationId: direct.body.id,
        originalFilename: 'private.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(uploaded.status).toBe(201);

    const unrelated = await request(app)
      .get(`/api/attachments/${uploaded.body.id}/content`)
      .set('Authorization', `Bearer ${chatToken('uh', 'eh', 'c1', ['chat.view'])}`);
    expect(unrelated.status).toBe(404);

    const purchasingOnly = await request(app)
      .get(`/api/attachments/${uploaded.body.id}/content`)
      .set('Authorization', `Bearer ${tokenFor({
        id: 'up',
        companyId: 'c1',
        employeeId: 'ep',
        permissions: ['purchasing.view', 'purchasing.manage'],
      })}`);
    expect(purchasingOnly.status).toBe(404);
  });
});

describe('Attachment purchasing scope (Blocker C/D)', () => {
  function seedTwoOrders(prisma: ReturnType<typeof makePurchasingPrisma>) {
    addPurchasingIdentity(prisma, {
      userId: 'u-owner-req',
      employeeId: 'e-owner-req',
      departmentId: 'd1',
      permissions: ['purchasing.create', 'purchasing.view_own'],
      name: 'صاحب الطلب',
    });
    addPurchasingIdentity(prisma, {
      userId: 'u-peer',
      employeeId: 'e-peer',
      departmentId: 'd1',
      permissions: ['purchasing.view_own'],
      name: 'زميل',
    });
    addPurchasingIdentity(prisma, {
      userId: 'u-manager',
      employeeId: 'e-manager',
      departmentId: 'd1',
      permissions: ['purchasing.manage', 'purchasing.view', 'purchasing.create'],
      name: 'مدير المشتريات',
    });
    addPurchasingIdentity(prisma, {
      userId: 'u-admin',
      employeeId: 'e-admin',
      departmentId: 'd1',
      permissions: ['admin.full'],
      name: 'مسؤول',
    });
    addPurchasingIdentity(prisma, {
      userId: 'u-chat',
      employeeId: 'e-chat',
      departmentId: 'd1',
      permissions: ['chat.view'],
      name: 'محادثة فقط',
    });

    const ownRequest = {
      id: 'pr-own',
      companyId: 'c1',
      departmentId: 'd1',
      requestedByEmployeeId: 'e-owner-req',
      status: 'ordered',
      createdAt: new Date(),
    };
    const peerRequest = {
      id: 'pr-peer',
      companyId: 'c1',
      departmentId: 'd1',
      requestedByEmployeeId: 'e-peer',
      status: 'ordered',
      createdAt: new Date(),
    };
    prisma._purchasing.requests.push(ownRequest, peerRequest);
    prisma._purchasing.orders.push(
      {
        id: 'po-own',
        companyId: 'c1',
        purchaseRequestId: 'pr-own',
        status: 'draft',
        createdByUserId: 'u-manager',
        createdAt: new Date(),
      },
      {
        id: 'po-peer',
        companyId: 'c1',
        purchaseRequestId: 'pr-peer',
        status: 'draft',
        createdByUserId: 'u-manager',
        createdAt: new Date(),
      }
    );
    return { ownOrderId: 'po-own', peerOrderId: 'po-peer' };
  }

  it('allows purchase manager upload and authorized viewer download; blocks view_own peer and chat-only', async () => {
    const prisma = makePurchasingPrisma();
    const { ownOrderId, peerOrderId } = seedTwoOrders(prisma);
    const app = makeApp(prisma);

    const managerUpload = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-manager',
        employeeId: 'e-manager',
        permissions: ['purchasing.manage', 'purchasing.view', 'purchasing.create'],
      })}`)
      .send({
        purpose: 'purchasing',
        purchaseOrderId: ownOrderId,
        originalFilename: 'quote.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(managerUpload.status).toBe(201);

    const viewOwnReadOnly = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-peer',
        employeeId: 'e-peer',
        permissions: ['purchasing.view_own'],
      })}`)
      .send({
        purpose: 'purchasing',
        purchaseOrderId: peerOrderId,
        originalFilename: 'peer.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(viewOwnReadOnly.status).toBe(403);

    const creatorWithMutation = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-owner-req',
        employeeId: 'e-owner-req',
        permissions: ['purchasing.create', 'purchasing.view_own'],
      })}`)
      .send({
        purpose: 'purchasing',
        purchaseOrderId: ownOrderId,
        originalFilename: 'mine.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(creatorWithMutation.status).toBe(201);

    const uploadToPeer = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-owner-req',
        employeeId: 'e-owner-req',
        permissions: ['purchasing.create', 'purchasing.view_own'],
      })}`)
      .send({
        purpose: 'purchasing',
        purchaseOrderId: peerOrderId,
        originalFilename: 'other.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(uploadToPeer.status).toBe(404);

    const adminUpload = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-admin',
        employeeId: 'e-admin',
        permissions: ['admin.full'],
      })}`)
      .send({
        purpose: 'purchasing',
        purchaseOrderId: peerOrderId,
        originalFilename: 'admin.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(adminUpload.status).toBe(201);

    const ownViewerDownload = await request(app)
      .get(`/api/attachments/${managerUpload.body.id}/content`)
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-owner-req',
        employeeId: 'e-owner-req',
        permissions: ['purchasing.view_own'],
      })}`);
    expect(ownViewerDownload.status).toBe(200);

    const peerDenied = await request(app)
      .get(`/api/attachments/${managerUpload.body.id}/content`)
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-peer',
        employeeId: 'e-peer',
        permissions: ['purchasing.view_own'],
      })}`);
    expect(peerDenied.status).toBe(404);

    const chatOnlyDenied = await request(app)
      .get(`/api/attachments/${managerUpload.body.id}/content`)
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-chat',
        employeeId: 'e-chat',
        permissions: ['chat.view'],
      })}`);
    expect(chatOnlyDenied.status).toBe(404);

    const crossCompany = await request(app)
      .get(`/api/attachments/${managerUpload.body.id}/content`)
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-foreign',
        companyId: 'c2',
        employeeId: 'e-foreign',
        permissions: ['purchasing.view', 'purchasing.manage'],
      })}`);
    expect(crossCompany.status).toBe(404);
  });
});

describe('Attachment atomic audit (Blocker F)', () => {
  it('rolls back generated chat message and attachment when required audit fails', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await request(app)
      .post('/api/chat/direct')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({ userId: 'u2' });

    const originalCreate = prisma.auditLog.create;
    prisma.auditLog.create = vi.fn(async (args: any) => {
      if (args?.data?.action === 'attachment.upload') {
        throw new Error('audit unavailable');
      }
      return originalCreate(args);
    });

    const failed = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({
        purpose: 'chat',
        conversationId: direct.body.id,
        originalFilename: 'note.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(failed.status).toBe(500);
    expect(prisma._store.chatMessages).toHaveLength(0);
    expect(prisma.__memoryAttachments?.rows ?? []).toHaveLength(0);
    expect(prisma._store.auditLogs.some((row: any) => row.action === 'attachment.upload')).toBe(false);
  });

  it('commits message + attachment + audit together on success', async () => {
    const prisma = makeChatPrisma();
    const app = makeApp(prisma);
    const direct = await request(app)
      .post('/api/chat/direct')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({ userId: 'u2' });

    const uploaded = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${chatToken('u1', 'e1')}`)
      .send({
        purpose: 'chat',
        conversationId: direct.body.id,
        originalFilename: 'ok.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });
    expect(uploaded.status).toBe(201);
    expect(prisma._store.chatMessages).toHaveLength(1);
    expect(prisma.__memoryAttachments.rows).toHaveLength(1);
    expect(prisma._store.auditLogs.some((row: any) => row.action === 'attachment.upload')).toBe(true);
  });
});
