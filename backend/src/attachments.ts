import { createHash, randomUUID } from 'crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { PrismaClient } from '@prisma/client';
import { writeAuditRequired } from './audit';
import {
  ChatRequestError,
  ensureParticipant,
  loadAccessibleConversation,
  loadActor,
  type ChatAccessUser,
} from './chat';
import { PERMISSIONS } from './permissions';
import {
  assertVisibleRequest,
  PurchasingError,
  type PurchasingUser,
} from './purchasing';
import { loadVisibleTask, TaskRequestError, type TaskUser } from './tasks';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'com', 'msi', 'scr', 'ps1', 'vbs', 'js', 'jar', 'dll', 'sh', 'apk', 'ipa',
]);

interface AttachmentUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface AttachmentRequest extends Request {
  user?: AttachmentUser;
}

interface AttachmentRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
  messageRateLimitWindowMs?: number;
  messageRateLimitMax?: number;
}

class AttachmentError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string
  ) {
    super(message);
  }
}

const hasPerm = (user: AttachmentUser, perm: string): boolean =>
  user.permissions.includes(PERMISSIONS.ADMIN_FULL) || user.permissions.includes(perm);

const asChatUser = (user: AttachmentUser): ChatAccessUser => ({
  id: user.id,
  companyId: user.companyId,
  employeeId: user.employeeId,
  permissions: user.permissions,
});

const asPurchasingUser = (user: AttachmentUser): PurchasingUser => ({
  id: user.id,
  companyId: user.companyId,
  employeeId: user.employeeId,
  permissions: user.permissions,
});

const asTaskUser = (user: AttachmentUser): TaskUser => ({
  id: user.id,
  companyId: user.companyId,
  employeeId: user.employeeId,
  permissions: user.permissions,
});

/**
 * A task attachment is exactly as visible as its task. This defers to the same
 * `loadVisibleTask` scope authority the comment thread uses, so there is one
 * place — not three — deciding who can reach a task's collaboration surface.
 */
const assertTaskAttachmentAuthorized = async (
  client: any,
  user: AttachmentUser,
  taskId: string | null,
): Promise<void> => {
  if (!taskId) {
    throw new AttachmentError(400, 'AttachmentLinkRequired', 'يجب ربط مرفق المهمة بمهمة');
  }
  // Memory/unit drivers without a task surface are already gated by companyId
  // plus the purpose permission.
  if (!client.task?.findFirst) return;
  await loadVisibleTask(client, asTaskUser(user), taskId);
};

const sendError = (res: Response, error: unknown): Response => {
  if (error instanceof AttachmentError) {
    return res.status(error.status).json({
      error: error.errorCode,
      message: error.message,
      code: error.status,
    });
  }
  if (error instanceof ChatRequestError) {
    return res.status(error.status).json({
      error: error.errorCode,
      message: error.message,
      code: error.status,
    });
  }
  if (error instanceof PurchasingError) {
    return res.status(error.status).json({
      error: error.errorCode,
      message: error.message,
      code: error.status,
    });
  }
  if (error instanceof TaskRequestError) {
    return res.status(error.status).json({
      error: error.errorCode,
      message: error.message,
      code: error.status,
    });
  }
  return res.status(500).json({
    error: 'AttachmentOperationFailed',
    message: 'تعذّر تنفيذ عملية المرفق',
    code: 500,
  });
};

const sanitizeFilename = (raw: string): string => {
  const base = raw.replace(/[/\\]/g, '_').replace(/\0/g, '').trim();
  const cleaned = base
    .replace(/[^\w.\u0600-\u06FF\- ()[\]]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(0, 180);
  const safe = cleaned.replace(/^\.+/, '').trim() || 'attachment.bin';
  const ext = safe.includes('.') ? safe.split('.').pop()!.toLowerCase() : '';
  if (EXECUTABLE_EXTENSIONS.has(ext)) {
    throw new AttachmentError(400, 'AttachmentExecutableRejected', 'نوع الملف التنفيذي غير مسموح');
  }
  return safe;
};

const normalizeMime = (value: string): string => value.trim().toLowerCase().split(';')[0]!.trim();

const assertMimeAllowed = (contentType: string): string => {
  const mime = normalizeMime(contentType);
  if (!ALLOWED_MIME.has(mime)) {
    throw new AttachmentError(415, 'AttachmentMimeRejected', 'نوع الملف غير مسموح');
  }
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
};

const startsWithBytes = (buf: Buffer, sig: number[]): boolean => {
  if (buf.length < sig.length) return false;
  return sig.every((byte, index) => buf[index] === byte);
};

const looksLikeWindowsExecutable = (buf: Buffer): boolean =>
  startsWithBytes(buf, [0x4d, 0x5a]) || // MZ
  startsWithBytes(buf, [0x7f, 0x45, 0x4c, 0x46]); // ELF

const looksLikeScript = (buf: Buffer): boolean => {
  const head = buf.subarray(0, Math.min(buf.length, 64)).toString('utf8');
  return head.startsWith('#!') ||
    /^\s*<\?php/i.test(head) ||
    /^\s*<%/i.test(head);
};

/**
 * Minimum content-signature verification for supported binary formats.
 * This is not antivirus / malware scanning — it only rejects obvious
 * mismatched or disguised executable/script payloads.
 */
export const assertContentMatchesDeclaredType = (mime: string, bytes: Buffer): void => {
  if (looksLikeWindowsExecutable(bytes) || looksLikeScript(bytes)) {
    throw new AttachmentError(
      415,
      'AttachmentContentRejected',
      'محتوى الملف لا يطابق النوع المصرّح أو يبدو تنفيذياً'
    );
  }

  const ok = (() => {
    switch (mime) {
      case 'application/pdf':
        return bytes.subarray(0, 5).toString('utf8') === '%PDF-';
      case 'image/jpeg':
        return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
      case 'image/png':
        return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      case 'image/webp':
        return bytes.length >= 12 &&
          bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
          bytes.subarray(8, 12).toString('ascii') === 'WEBP';
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        // OOXML is a ZIP package.
        return startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
          startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
          startsWithBytes(bytes, [0x50, 0x4b, 0x07, 0x08]);
      case 'application/msword':
      case 'application/vnd.ms-excel':
        // Legacy OLE Compound File.
        return startsWithBytes(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
      case 'text/csv': {
        // Constrain CSV to printable text without NULs when magic-byte verification
        // is not available for this format.
        if (bytes.includes(0)) return false;
        const sample = bytes.subarray(0, Math.min(bytes.length, 2048)).toString('utf8');
        return !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(sample);
      }
      default:
        return false;
    }
  })();

  if (!ok) {
    throw new AttachmentError(
      415,
      'AttachmentContentRejected',
      'محتوى الملف لا يطابق النوع المصرّح'
    );
  }
};

const decodeBase64Payload = (value: string): Buffer => {
  const cleaned = value.replace(/\s+/g, '');
  if (!cleaned || cleaned.length > Math.ceil(MAX_BYTES * 4 / 3) + 64) {
    throw new AttachmentError(413, 'AttachmentTooLarge', 'حجم المرفق يتجاوز الحد المسموح (5 ميغابايت)');
  }
  try {
    return Buffer.from(cleaned, 'base64');
  } catch {
    throw new AttachmentError(400, 'AttachmentPayloadInvalid', 'محتوى المرفق غير صالح');
  }
};

const metadataShape = (row: any) => ({
  id: row.id,
  companyId: row.companyId,
  originalFilename: row.originalFilename,
  contentType: row.contentType,
  byteSize: row.byteSize,
  sha256: row.sha256,
  uploadedByUserId: row.uploadedByUserId,
  purpose: row.purpose,
  purchaseOrderId: row.purchaseOrderId ?? null,
  chatMessageId: row.chatMessageId ?? null,
  taskId: row.taskId ?? null,
  createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
});

const assertCanUploadPurpose = (user: AttachmentUser, purpose: string): void => {
  if (purpose === 'chat') {
    if (!hasPerm(user, PERMISSIONS.CHAT_VIEW)) {
      throw new AttachmentError(403, 'AttachmentForbidden', 'لا تملك صلاحية إرفاق ملفات للمحادثة');
    }
    return;
  }
  if (purpose === 'purchasing') {
    // Mutation: view_own alone is not enough.
    if (
      !hasPerm(user, PERMISSIONS.PURCHASING_CREATE) &&
      !hasPerm(user, PERMISSIONS.PURCHASING_MANAGE)
    ) {
      throw new AttachmentError(403, 'AttachmentForbidden', 'لا تملك صلاحية إرفاق ملفات للمشتريات');
    }
    return;
  }
  if (purpose === 'task') {
    // Mutation gate. Whether this specific task is reachable is a separate,
    // stricter check (assertTaskAttachmentAuthorized) — holding the permission
    // never implies access to a task outside the actor's own scope.
    if (!hasPerm(user, PERMISSIONS.TASKS_ATTACHMENT_MANAGE)) {
      throw new AttachmentError(403, 'AttachmentForbidden', 'لا تملك صلاحية إرفاق ملفات للمهام');
    }
    return;
  }
  throw new AttachmentError(400, 'AttachmentPurposeInvalid', 'غرض المرفق غير صالح');
};

/** In-memory driver used when Prisma Attachment model is unavailable in tests. */
export function createMemoryAttachmentStore() {
  const rows: any[] = [];
  return {
    rows,
    create: async (data: any) => {
      const row = {
        id: data.id ?? randomUUID(),
        createdAt: data.createdAt ?? new Date(),
        ...data,
      };
      rows.push(row);
      return row;
    },
    delete: async ({ where }: any) => {
      const index = rows.findIndex((row) =>
        (where.id === undefined || row.id === where.id) &&
        (where.companyId === undefined || row.companyId === where.companyId)
      );
      if (index >= 0) rows.splice(index, 1);
      return { count: index >= 0 ? 1 : 0 };
    },
    findFirst: async ({ where }: any) =>
      rows.find((row) =>
        (where.id === undefined || row.id === where.id) &&
        (where.companyId === undefined || row.companyId === where.companyId) &&
        (where.purchaseOrderId === undefined || row.purchaseOrderId === where.purchaseOrderId) &&
        (where.chatMessageId === undefined || row.chatMessageId === where.chatMessageId) &&
        (where.taskId === undefined || row.taskId === where.taskId)
      ) ?? null,
    findMany: async ({ where, take }: any = {}) =>
      rows
        .filter((row) =>
          (where?.companyId === undefined || row.companyId === where.companyId) &&
          (where?.purchaseOrderId === undefined || row.purchaseOrderId === where.purchaseOrderId) &&
          (where?.chatMessageId === undefined || row.chatMessageId === where.chatMessageId) &&
          (where?.taskId === undefined || row.taskId === where.taskId) &&
          (where?.purpose === undefined || row.purpose === where.purpose)
        )
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, take ?? 50),
  };
}

const resolveAttachmentDelegate = (prisma: any) => {
  if (prisma?.attachment?.create && prisma?.attachment?.findFirst) {
    return prisma.attachment;
  }
  if (!prisma.__memoryAttachments) {
    prisma.__memoryAttachments = createMemoryAttachmentStore();
  }
  return prisma.__memoryAttachments;
};

const usesPrismaAttachment = (prisma: any): boolean =>
  Boolean(prisma?.attachment?.create && prisma?.attachment?.findFirst);

/**
 * Assert the actor may read the linked resource for a stored attachment.
 * Does not trust client purpose query params — uses the row's purpose + FKs.
 */
const assertCanAccessAttachment = async (client: any, user: AttachmentUser, row: any): Promise<void> => {
  if (row.companyId !== user.companyId) {
    throw new AttachmentError(404, 'AttachmentNotFound', 'المرفق غير موجود');
  }

  if (row.purpose === 'chat') {
    if (!hasPerm(user, PERMISSIONS.CHAT_VIEW)) {
      throw new AttachmentError(404, 'AttachmentNotFound', 'المرفق غير موجود');
    }
    if (!client.chatMessage?.findFirst || !client.chatConversation?.findFirst) {
      // Memory/unit drivers without chat surface: company + chat.view already gated.
      return;
    }
    const actor = await loadActor(client, asChatUser(user));
    let conversationId: string | null = null;
    if (row.chatMessageId) {
      const message = await client.chatMessage.findFirst({
        where: { id: row.chatMessageId, companyId: user.companyId },
        select: { id: true, conversationId: true },
      });
      if (!message) {
        throw new AttachmentError(404, 'AttachmentNotFound', 'المرفق غير موجود');
      }
      conversationId = message.conversationId;
    }
    if (!conversationId) {
      throw new AttachmentError(404, 'AttachmentNotFound', 'المرفق غير موجود');
    }
    await loadAccessibleConversation(client, actor, conversationId);
    return;
  }

  if (row.purpose === 'purchasing') {
    if (
      !hasPerm(user, PERMISSIONS.PURCHASING_VIEW) &&
      !hasPerm(user, PERMISSIONS.PURCHASING_VIEW_OWN) &&
      !hasPerm(user, PERMISSIONS.PURCHASING_VIEW_DEPARTMENT) &&
      !hasPerm(user, PERMISSIONS.PURCHASING_MANAGE) &&
      !hasPerm(user, PERMISSIONS.PURCHASING_CREATE)
    ) {
      throw new AttachmentError(404, 'AttachmentNotFound', 'المرفق غير موجود');
    }
    if (!row.purchaseOrderId) {
      throw new AttachmentError(404, 'AttachmentNotFound', 'المرفق غير موجود');
    }
    // Memory/unit drivers without a purchasing surface already gated by companyId.
    if (!client.purchaseOrder?.findFirst) {
      return;
    }
    const order = await client.purchaseOrder.findFirst({
      where: { id: row.purchaseOrderId, companyId: user.companyId },
      include: { purchaseRequest: true },
    });
    if (!order?.purchaseRequest) {
      throw new AttachmentError(404, 'AttachmentNotFound', 'المرفق غير موجود');
    }
    await assertVisibleRequest(client, asPurchasingUser(user), order.purchaseRequest);
    return;
  }

  if (row.purpose === 'task') {
    // Read side deliberately accepts any task-view permission: an assignee who
    // can open the task can read its attachments even without the upload key.
    if (
      !hasPerm(user, PERMISSIONS.TASKS_VIEW_OWN) &&
      !hasPerm(user, PERMISSIONS.TASKS_VIEW_DEPARTMENT) &&
      !hasPerm(user, PERMISSIONS.TASKS_VIEW_COMPANY)
    ) {
      throw new AttachmentError(404, 'AttachmentNotFound', 'المرفق غير موجود');
    }
    if (!row.taskId) {
      throw new AttachmentError(404, 'AttachmentNotFound', 'المرفق غير موجود');
    }
    if (!client.task?.findFirst) return;
    // loadVisibleTask throws 404 for an out-of-scope task; remap so the caller
    // never learns whether the attachment or the task was the reason.
    try {
      await loadVisibleTask(client, asTaskUser(user), row.taskId);
    } catch (error) {
      if (error instanceof TaskRequestError) {
        throw new AttachmentError(404, 'AttachmentNotFound', 'المرفق غير موجود');
      }
      throw error;
    }
    return;
  }

  throw new AttachmentError(404, 'AttachmentNotFound', 'المرفق غير موجود');
};

const assertWritablePurchaseOrder = async (
  client: any,
  user: AttachmentUser,
  purchaseOrderId: string
): Promise<void> => {
  const order = await client.purchaseOrder?.findFirst?.({
    where: { id: purchaseOrderId, companyId: user.companyId },
    include: { purchaseRequest: true },
  });
  if (!order && client.purchaseOrder) {
    throw new AttachmentError(404, 'PurchaseOrderNotFound', 'أمر الشراء غير موجود');
  }
  if (!order) return; // memory-only tests without purchaseOrder surface
  if (!order.purchaseRequest) {
    throw new AttachmentError(404, 'PurchaseOrderNotFound', 'أمر الشراء غير موجود');
  }
  await assertVisibleRequest(client, asPurchasingUser(user), order.purchaseRequest);
};

const assertChatUploadAuthorized = async (
  client: any,
  user: AttachmentUser,
  conversationId: string | null,
  linkedChatMessageId: string | null
): Promise<{ conversationId: string | null; actor: any }> => {
  const actor = await loadActor(client, asChatUser(user));
  if (conversationId) {
    const conversation = await loadAccessibleConversation(client, actor, conversationId);
    if (conversation.type === 'announcement' && conversation.repliesEnabled === false) {
      throw new ChatRequestError(403, 'ChatRepliesDisabled', 'الردود معطلة على هذا الإعلان');
    }
    if (conversation.type === 'direct') {
      const peers = conversation.participants.filter(
        (row: any) => row.userId !== actor.id && row.active
      );
      const directRecipient = peers.length === 1 ? peers[0].user : null;
      if (
        !directRecipient ||
        directRecipient.companyId !== actor.companyId ||
        directRecipient.employee?.status !== 'active'
      ) {
        throw new ChatRequestError(409, 'ChatRecipientInactive', 'لا يمكن إرسال رسالة إلى هذا المستخدم حالياً');
      }
    }
    return { conversationId, actor };
  }
  if (linkedChatMessageId) {
    const message = await client.chatMessage?.findFirst?.({
      where: { id: linkedChatMessageId, companyId: user.companyId },
      select: { id: true, conversationId: true },
    });
    if (!message && client.chatMessage) {
      throw new AttachmentError(404, 'ChatMessageNotFound', 'الرسالة غير موجودة');
    }
    if (message?.conversationId) {
      await loadAccessibleConversation(client, actor, message.conversationId);
      return { conversationId: message.conversationId, actor };
    }
  }
  throw new AttachmentError(400, 'AttachmentLinkRequired', 'يجب ربط مرفق المحادثة بمحادثة أو رسالة');
};

export function registerAttachmentRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
  messageRateLimitWindowMs = 60_000,
  messageRateLimitMax = 60,
}: AttachmentRouteDeps): void {
  const uploadGate = checkAnyPermission(
    PERMISSIONS.CHAT_VIEW,
    PERMISSIONS.PURCHASING_VIEW,
    PERMISSIONS.PURCHASING_VIEW_OWN,
    PERMISSIONS.PURCHASING_VIEW_DEPARTMENT,
    PERMISSIONS.PURCHASING_CREATE,
    PERMISSIONS.PURCHASING_MANAGE,
    // P4 task attachments. This is only the coarse "may touch the attachment
    // API at all" gate; per-purpose and per-resource checks run inside.
    PERMISSIONS.TASKS_VIEW_OWN,
    PERMISSIONS.TASKS_VIEW_DEPARTMENT,
    PERMISSIONS.TASKS_VIEW_COMPANY,
    PERMISSIONS.TASKS_ATTACHMENT_MANAGE,
  );

  // Same limiter keying as chat message sends so attachment-generated messages
  // cannot bypass the chat rate limit.
  const chatSendLimiter = rateLimit({
    windowMs: messageRateLimitWindowMs,
    limit: messageRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: AttachmentRequest) =>
      `${ipKeyGenerator(req.ip ?? '')}:${req.user?.id ?? 'anonymous'}`,
    message: {
      error: 'ChatRateLimitExceeded',
      message: 'تم إرسال رسائل كثيرة خلال وقت قصير. حاول مرة أخرى بعد قليل.',
      code: 429,
    },
    skip: (req: AttachmentRequest) => {
      const purpose = String((req.body as any)?.purpose ?? '').trim().toLowerCase();
      return purpose !== 'chat';
    },
  });

  app.post(
    '/api/attachments',
    requireAuth,
    uploadGate,
    chatSendLimiter,
    async (req: AttachmentRequest, res) => {
      try {
        const user = req.user!;
        const body = req.body ?? {};
        const purpose = String(body.purpose ?? '').trim().toLowerCase();
        assertCanUploadPurpose(user, purpose);

        const originalFilename = sanitizeFilename(String(body.originalFilename ?? body.filename ?? ''));
        const contentType = assertMimeAllowed(String(body.contentType ?? ''));
        if (typeof body.contentBase64 !== 'string') {
          throw new AttachmentError(400, 'AttachmentPayloadInvalid', 'يجب إرسال محتوى المرفق بصيغة Base64');
        }
        const storageBytes = decodeBase64Payload(body.contentBase64);
        if (storageBytes.length === 0) {
          throw new AttachmentError(400, 'AttachmentEmpty', 'الملف فارغ');
        }
        if (storageBytes.length > MAX_BYTES) {
          throw new AttachmentError(413, 'AttachmentTooLarge', 'حجم المرفق يتجاوز الحد المسموح (5 ميغابايت)');
        }
        assertContentMatchesDeclaredType(contentType, storageBytes);

        const purchaseOrderId =
          typeof body.purchaseOrderId === 'string' && body.purchaseOrderId.trim()
            ? body.purchaseOrderId.trim()
            : null;
        const chatMessageId =
          typeof body.chatMessageId === 'string' && body.chatMessageId.trim()
            ? body.chatMessageId.trim()
            : null;
        const conversationId =
          typeof body.conversationId === 'string' && body.conversationId.trim()
            ? body.conversationId.trim()
            : null;
        const taskId =
          typeof body.taskId === 'string' && body.taskId.trim()
            ? body.taskId.trim()
            : null;

        if (purpose === 'purchasing' && !purchaseOrderId) {
          throw new AttachmentError(400, 'AttachmentLinkRequired', 'يجب ربط مرفق المشتريات بأمر شراء');
        }
        if (purpose === 'task' && !taskId) {
          throw new AttachmentError(400, 'AttachmentLinkRequired', 'يجب ربط مرفق المهمة بمهمة');
        }

        let chatContext: { conversationId: string | null; actor: any } | null = null;
        if (purpose === 'chat') {
          chatContext = await assertChatUploadAuthorized(prisma, user, conversationId, chatMessageId);
        }
        if (purpose === 'purchasing' && purchaseOrderId) {
          await assertWritablePurchaseOrder(prisma, user, purchaseOrderId);
        }
        if (purpose === 'task') {
          await assertTaskAttachmentAuthorized(prisma, user, taskId);
        }

        const sha256 = createHash('sha256').update(storageBytes).digest('hex');
        const attachmentId = randomUUID();

        const commit = async (client: any) => {
          let linkedChatMessageId = chatMessageId;
          if (purpose === 'chat' && chatContext?.conversationId && !linkedChatMessageId) {
            if (client.chatParticipant?.upsert) {
              await ensureParticipant(
                client,
                chatContext.conversationId,
                user.companyId,
                user.id
              );
            }
            const now = new Date();
            const createdMessage = await client.chatMessage?.create?.({
              data: {
                companyId: user.companyId,
                conversationId: chatContext.conversationId,
                senderUserId: user.id,
                body: `مرفق: ${originalFilename}`,
                createdAt: now,
              },
            });
            if (createdMessage?.id) {
              linkedChatMessageId = createdMessage.id;
              await client.chatConversation?.update?.({
                where: { id: chatContext.conversationId },
                data: { lastMessageAt: now },
              });
            } else if (client.chatMessage) {
              throw new AttachmentError(500, 'AttachmentOperationFailed', 'تعذّر إنشاء رسالة المرفق');
            }
          }

          if (purpose === 'chat' && linkedChatMessageId && client.chatMessage?.findFirst) {
            const message = await client.chatMessage.findFirst({
              where: { id: linkedChatMessageId, companyId: user.companyId },
              select: { id: true },
            });
            if (!message) {
              throw new AttachmentError(404, 'ChatMessageNotFound', 'الرسالة غير موجودة');
            }
          }

          const payload = {
            id: attachmentId,
            companyId: user.companyId,
            storageBytes,
            originalFilename,
            contentType,
            byteSize: storageBytes.length,
            sha256,
            uploadedByUserId: user.id,
            purpose,
            purchaseOrderId,
            chatMessageId: linkedChatMessageId,
            taskId,
          };

          const delegate = resolveAttachmentDelegate(client);
          const row = usesPrismaAttachment(client)
            ? await client.attachment.create({ data: payload })
            : await delegate.create(payload);

          // Required audit — failure must roll back message + attachment.
          await writeAuditRequired(client, {
            companyId: user.companyId,
            userId: user.id,
            action: 'attachment.upload',
            details: {
              attachmentId: row.id,
              purpose,
              byteSize: row.byteSize,
              contentType: row.contentType,
              purchaseOrderId,
              chatMessageId: linkedChatMessageId,
              taskId,
            },
          });

          return row;
        };

        let row: any;
        if (typeof (prisma as any).$transaction === 'function') {
          // Real Prisma path + test fakes with $transaction: one atomic unit.
          // Memory attachment rows are snapshotted by enhanced test $transaction helpers.
          row = await (prisma as any).$transaction(async (tx: any) => commit(tx));
        } else {
          // Explicit memory-driver atomicity — not best-effort audit.
          const memory = resolveAttachmentDelegate(prisma);
          const messagesBefore = (prisma as any)._store?.chatMessages
            ? (prisma as any)._store.chatMessages.length
            : null;
          try {
            row = await commit(prisma);
          } catch (error) {
            if (memory?.rows) {
              const index = memory.rows.findIndex((candidate: any) => candidate.id === attachmentId);
              if (index >= 0) memory.rows.splice(index, 1);
            }
            if (messagesBefore != null && (prisma as any)._store?.chatMessages) {
              (prisma as any)._store.chatMessages.splice(messagesBefore);
            }
            throw error;
          }
        }

        return res.status(201).json(metadataShape(row));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.get('/api/attachments', requireAuth, uploadGate, async (req: AttachmentRequest, res) => {
    try {
      const user = req.user!;
      const purchaseOrderId =
        typeof req.query.purchaseOrderId === 'string' ? req.query.purchaseOrderId : undefined;
      const chatMessageId =
        typeof req.query.chatMessageId === 'string' ? req.query.chatMessageId : undefined;
      const taskId =
        typeof req.query.taskId === 'string' ? req.query.taskId : undefined;
      if (!purchaseOrderId && !chatMessageId && !taskId) {
        throw new AttachmentError(400, 'AttachmentQueryRequired', 'يجب تحديد أمر شراء أو رسالة أو مهمة');
      }
      const delegate = resolveAttachmentDelegate(prisma);
      const rows = await delegate.findMany({
        where: {
          companyId: user.companyId,
          ...(purchaseOrderId ? { purchaseOrderId } : {}),
          ...(chatMessageId ? { chatMessageId } : {}),
          ...(taskId ? { taskId } : {}),
        },
        take: 50,
        orderBy: { createdAt: 'desc' },
      });
      const visible: any[] = [];
      for (const row of rows) {
        try {
          await assertCanAccessAttachment(prisma, user, row);
          visible.push(row);
        } catch {
          // Resource-aware filter: omit inaccessible rows without leaking existence.
        }
      }
      return res.json(visible.map(metadataShape));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/attachments/:id', requireAuth, uploadGate, async (req: AttachmentRequest, res) => {
    try {
      const user = req.user!;
      const delegate = resolveAttachmentDelegate(prisma);
      const row = await delegate.findFirst({
        where: { id: req.params.id, companyId: user.companyId },
      });
      if (!row) {
        throw new AttachmentError(404, 'AttachmentNotFound', 'المرفق غير موجود');
      }
      await assertCanAccessAttachment(prisma, user, row);
      return res.json(metadataShape(row));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/attachments/:id/content', requireAuth, uploadGate, async (req: AttachmentRequest, res) => {
    try {
      const user = req.user!;
      const delegate = resolveAttachmentDelegate(prisma);
      const row = await delegate.findFirst({
        where: { id: req.params.id, companyId: user.companyId },
      });
      if (!row) {
        throw new AttachmentError(404, 'AttachmentNotFound', 'المرفق غير موجود');
      }
      await assertCanAccessAttachment(prisma, user, row);
      const bytes: Buffer = Buffer.isBuffer(row.storageBytes)
        ? row.storageBytes
        : Buffer.from(row.storageBytes);
      res.setHeader('Content-Type', row.contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(row.originalFilename)}"`
      );
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(bytes);
    } catch (error) {
      return sendError(res, error);
    }
  });
}

export const attachmentLimits = {
  maxBytes: MAX_BYTES,
  allowedMime: [...ALLOWED_MIME],
};
