import type { Express, Request, RequestHandler, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { PrismaClient } from '@prisma/client';
import { writeAuditRequired } from './audit';
import { createDomainNotifications } from './notifications';
import { PERMISSIONS } from './permissions';
import { loadManagedDepartmentIds } from './authorization';
import {
  chatAnnouncementSchema,
  chatConversationListQuerySchema,
  chatDirectSchema,
  chatDirectoryQuerySchema,
  chatMessageListQuerySchema,
  chatMessageSendSchema,
  chatPinMessageSchema,
  validateBody,
  validateQuery,
} from './validation';

interface ChatUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface ChatRequest extends Request {
  user?: ChatUser;
}

interface ChatRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
  messageRateLimitWindowMs?: number;
  messageRateLimitMax?: number;
}

export class ChatRequestError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string
  ) {
    super(message);
  }
}

export type ChatAccessUser = ChatUser;

const userInclude = {
  employee: { include: { department: { select: { id: true, name: true, managerId: true } } } },
  role: { select: { name: true } },
} as const;

const conversationInclude = {
  department: { select: { id: true, name: true, managerId: true } },
  participants: {
    where: { active: true },
    include: { user: { include: userInclude } },
    orderBy: { joinedAt: 'asc' as const },
  },
  messages: {
    take: 1,
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    include: { sender: { include: userInclude } },
  },
};

const iso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

const hasPerm = (user: ChatUser, perm: string): boolean =>
  user.permissions.includes(PERMISSIONS.ADMIN_FULL) || user.permissions.includes(perm);

const mayBrowseCompanyDirectory = (user: ChatUser): boolean =>
  hasPerm(user, PERMISSIONS.EMPLOYEES_VIEW);

const isDirectRecipientAllowed = (actor: any, recipient: any, tokenUser: ChatUser): boolean => {
  if (mayBrowseCompanyDirectory(tokenUser)) return true;
  const actorDepartmentId = actor.employee?.departmentId ?? null;
  const managerId = actor.employee?.department?.managerId ?? null;
  return (
    recipient.employee?.departmentId === actorDepartmentId ||
    recipient.id === managerId
  );
};

const assertDirectRecipientAllowed = (actor: any, recipient: any, tokenUser: ChatUser): void => {
  if (!isDirectRecipientAllowed(actor, recipient, tokenUser)) {
    throw new ChatRequestError(404, 'ChatRecipientNotFound', 'المستخدم غير موجود');
  }
};

const requireCreatePerm = (user: ChatUser, perm: string): void => {
  if (!hasPerm(user, perm)) {
    throw new ChatRequestError(403, 'ChatCreateForbidden', 'لا تملك صلاحية إنشاء هذه المحادثة');
  }
};

const requirePinPerm = (user: ChatUser): void => {
  if (!hasPerm(user, PERMISSIONS.CHAT_PIN)) {
    throw new ChatRequestError(403, 'ChatCreateForbidden', 'لا تملك صلاحية تثبيت الرسائل');
  }
};

const safeUser = (user: any) => ({
  userId: user.id,
  displayName: user.name,
  title: user.employee?.jobTitle ?? null,
  employeeId: user.employee?.id ?? null,
  departmentId: user.employee?.departmentId ?? null,
  departmentName: user.employee?.department?.name ?? null,
  roleName: user.role?.name ?? '',
  status: user.employee?.status ?? 'active',
});

const safeSender = (user: any) => ({
  userId: user.id,
  displayName: user.name,
  roleName: user.role?.name ?? '',
  departmentName: user.employee?.department?.name ?? null,
});

const sendError = (res: Response, error: unknown): Response => {
  if (error instanceof ChatRequestError) {
    return res.status(error.status).json({
      error: error.errorCode,
      message: error.message,
      code: error.status,
    });
  }
  return res.status(500).json({
    error: 'ChatOperationFailed',
    message: 'تعذّر تنفيذ عملية المحادثة',
    code: 500,
  });
};

const isUniqueError = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === 'P2002';

export const loadActor = async (client: any, tokenUser: ChatUser) => {
  const actor = await client.user.findFirst({
    where: { id: tokenUser.id, companyId: tokenUser.companyId },
    include: userInclude,
  });
  if (!actor || actor.companyId !== tokenUser.companyId) {
    throw new ChatRequestError(403, 'ChatUserInactive', 'المحادثة متاحة للموظفين النشطين فقط');
  }
  const accountActive = !actor.accountStatus || actor.accountStatus === 'active';
  if (!accountActive) {
    throw new ChatRequestError(403, 'ChatUserInactive', 'المحادثة متاحة للموظفين النشطين فقط');
  }
  // Linked employees must be active. Primary Owner / admin with null employeeId may use chat.
  if (actor.employee) {
    if (actor.employee.status !== 'active') {
      throw new ChatRequestError(403, 'ChatUserInactive', 'المحادثة متاحة للموظفين النشطين فقط');
    }
  } else if (!hasPerm(tokenUser, PERMISSIONS.ADMIN_FULL)) {
    throw new ChatRequestError(403, 'ChatUserInactive', 'المحادثة متاحة للموظفين النشطين فقط');
  }
  return actor;
};

const departmentIdsFor = async (client: any, actor: any): Promise<string[]> => {
  const ids = new Set<string>();
  if (actor.employee?.departmentId) ids.add(actor.employee.departmentId);
  const managed = await loadManagedDepartmentIds(client, {
    companyId: actor.companyId,
    userId: actor.id,
  });
  for (const departmentId of managed) ids.add(departmentId);
  return [...ids];
};

const conversationAccessOr = (actorId: string, departmentIds: string[]) => [
  { type: 'direct', participants: { some: { userId: actorId, active: true } } },
  ...(departmentIds.length > 0
    ? [{ type: 'department', departmentId: { in: departmentIds } }]
    : []),
  { type: 'announcement' },
];

export const loadAccessibleConversation = async (client: any, actor: any, conversationId: string) => {
  const conversation = await client.chatConversation.findFirst({
    where: { id: conversationId, companyId: actor.companyId },
    include: conversationInclude,
  });
  if (!conversation) {
    throw new ChatRequestError(404, 'ChatConversationNotFound', 'المحادثة غير موجودة');
  }
  if (conversation.type === 'direct') {
    const participant = conversation.participants.find(
      (row: any) => row.userId === actor.id && row.active
    );
    if (!participant) {
      throw new ChatRequestError(404, 'ChatConversationNotFound', 'المحادثة غير موجودة');
    }
    return conversation;
  }
  if (conversation.type === 'department') {
    const allowedDepartments = await departmentIdsFor(client, actor);
    const allowed = conversation.department && allowedDepartments.includes(conversation.department.id);
    if (!allowed) {
      throw new ChatRequestError(404, 'ChatConversationNotFound', 'المحادثة غير موجودة');
    }
    return conversation;
  }
  if (conversation.type === 'announcement') {
    return conversation;
  }
  throw new ChatRequestError(404, 'ChatConversationNotFound', 'المحادثة غير موجودة');
};

const unreadCount = async (client: any, conversation: any, actorId: string): Promise<number> => {
  const participant = conversation.participants.find(
    (row: any) => row.userId === actorId && row.active
  );
  return client.chatMessage.count({
    where: {
      companyId: conversation.companyId,
      conversationId: conversation.id,
      senderUserId: { not: actorId },
      ...(participant?.lastReadAt ? { createdAt: { gt: participant.lastReadAt } } : {}),
    },
  });
};

const conversationShape = async (client: any, conversation: any, actor: any) => {
  const peerParticipant = conversation.type === 'direct'
    ? conversation.participants.find((row: any) => row.userId !== actor.id && row.active)
    : null;
  const lastMessage = conversation.messages?.[0] ?? null;
  const participant = conversation.participants.find(
    (row: any) => row.userId === actor.id && row.active
  );
  const title = conversation.type === 'direct'
    ? peerParticipant?.user?.name ?? 'محادثة مباشرة'
    : conversation.type === 'announcement'
      ? conversation.title ?? 'إعلان'
      : conversation.title ?? conversation.department?.name ?? 'قناة القسم';
  return {
    id: conversation.id,
    type: conversation.type,
    title,
    peer: peerParticipant?.user ? safeUser(peerParticipant.user) : null,
    department: conversation.department
      ? { id: conversation.department.id, name: conversation.department.name }
      : null,
    lastMessagePreview: lastMessage?.body?.slice(0, 120) ?? null,
    lastMessageAt: iso(conversation.lastMessageAt ?? lastMessage?.createdAt),
    lastSender: lastMessage?.sender ? safeSender(lastMessage.sender) : null,
    unreadCount: await unreadCount(client, conversation, actor.id),
    readState: {
      active: participant?.active ?? false,
      lastReadAt: iso(participant?.lastReadAt),
    },
    createdAt: iso(conversation.createdAt),
    // Announcements default closed; direct/department remain replyable even when the
    // schema default is false (announcement-only policy).
    repliesEnabled: conversation.type === 'announcement'
      ? conversation.repliesEnabled !== false
      : true,
  };
};

const attachmentMetaShape = (attachment: any) => ({
  id: attachment.id,
  originalFilename: attachment.originalFilename,
  contentType: attachment.contentType,
  byteSize: attachment.byteSize,
});

const messageShape = (message: any, actorId: string) => ({
  id: message.id,
  conversationId: message.conversationId,
  sender: safeSender(message.sender),
  body: message.body,
  replyToMessageId: message.replyToMessageId ?? null,
  createdAt: iso(message.createdAt),
  isOwn: message.senderUserId === actorId,
  attachments: Array.isArray(message.attachments)
    ? message.attachments.map(attachmentMetaShape)
    : [],
});

const pinShape = (pin: any) => ({
  id: pin.id,
  conversationId: pin.conversationId,
  messageId: pin.messageId,
  pinnedByUserId: pin.pinnedByUserId,
  pinnedAt: iso(pin.pinnedAt),
});

const encodeCursor = (conversationId: string, message: any): string =>
  Buffer.from(JSON.stringify({
    conversationId,
    createdAt: new Date(message.createdAt).toISOString(),
    id: message.id,
  })).toString('base64url');

const decodeCursor = (value: string, conversationId: string) => {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      decoded?.conversationId !== conversationId ||
      typeof decoded?.id !== 'string' ||
      typeof decoded?.createdAt !== 'string' ||
      Number.isNaN(Date.parse(decoded.createdAt))
    ) {
      throw new Error('invalid');
    }
    return { id: decoded.id as string, createdAt: new Date(decoded.createdAt as string) };
  } catch {
    throw new ChatRequestError(400, 'ChatCursorInvalid', 'مؤشر الرسائل غير صالح');
  }
};

export const ensureParticipant = async (client: any, conversationId: string, companyId: string, userId: string) =>
  client.chatParticipant.upsert({
    where: { conversationId_userId: { conversationId, userId } },
    update: { active: true },
    create: { conversationId, companyId, userId, active: true },
  });


export function registerChatRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
  messageRateLimitWindowMs = 60_000,
  messageRateLimitMax = 60,
}: ChatRouteDeps): void {
  const chatGate = checkAnyPermission(PERMISSIONS.CHAT_VIEW);
  const sendLimiter = rateLimit({
    windowMs: messageRateLimitWindowMs,
    limit: messageRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: ChatRequest) =>
      `${ipKeyGenerator(req.ip ?? '')}:${req.user?.id ?? 'anonymous'}`,
    message: {
      error: 'ChatRateLimitExceeded',
      message: 'تم إرسال رسائل كثيرة خلال وقت قصير. حاول مرة أخرى بعد قليل.',
      code: 429,
    },
  });

  app.get('/api/chat/directory', requireAuth, chatGate, async (req: ChatRequest, res) => {
    const query = validateQuery(chatDirectoryQuerySchema, req, res);
    if (!query) return;
    try {
      const actor = await loadActor(prisma, req.user!);
      const includeInactive = mayBrowseCompanyDirectory(req.user!);
      const users = await prisma.user.findMany({
        where: {
          companyId: actor.companyId,
          id: { not: actor.id },
          employee: includeInactive
            ? { isNot: null }
            : { is: { status: 'active' } },
        },
        include: userInclude,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: 200,
      });
      const scopedUsers = includeInactive
        ? users
        : users.filter((user: any) => {
            const actorDepartmentId = actor.employee?.departmentId ?? null;
            const managerId = actor.employee?.department?.managerId ?? null;
            return user.employee?.departmentId === actorDepartmentId || user.id === managerId;
          });
      const needle = query.query?.toLocaleLowerCase() ?? '';
      const result = scopedUsers
        .map(safeUser)
        .filter((user) => !needle || [
          user.displayName,
          user.title,
          user.departmentName,
          user.roleName,
          user.status,
        ].some((value) => value?.toLocaleLowerCase().includes(needle)))
        .slice(0, query.limit);
      return res.json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/chat/direct', requireAuth, chatGate, async (req: ChatRequest, res) => {
    const body = validateBody(chatDirectSchema, req, res);
    if (!body) return;
    try {
      requireCreatePerm(req.user!, PERMISSIONS.CHAT_CREATE_DIRECT);
      const actor = await loadActor(prisma, req.user!);
      if (body.userId === actor.id) {
        throw new ChatRequestError(400, 'ChatSelfDirectForbidden', 'لا يمكنك بدء محادثة مباشرة مع نفسك');
      }
      // Managers/owners may open history threads with inactive employees; send still
      // blocks inactive recipients. Self-service directory stays active-only.
      const allowInactivePeer = mayBrowseCompanyDirectory(req.user!);
      const recipient = await prisma.user.findFirst({
        where: {
          id: body.userId,
          companyId: actor.companyId,
          employee: allowInactivePeer
            ? { isNot: null }
            : { is: { status: 'active' } },
        },
        include: userInclude,
      });
      if (!recipient) {
        throw new ChatRequestError(404, 'ChatRecipientNotFound', 'المستخدم غير موجود');
      }
      assertDirectRecipientAllowed(actor, recipient, req.user!);
      const pair = [actor.id, recipient.id].sort();
      const directKey = pair.join(':');

      const open = async () => prisma.$transaction(async (tx) => {
        let conversation = await tx.chatConversation.findFirst({
          where: { companyId: actor.companyId, directKey, type: 'direct' },
        });
        if (!conversation) {
          conversation = await tx.chatConversation.create({
            data: {
              companyId: actor.companyId,
              type: 'direct',
              directKey,
              createdByUserId: actor.id,
              repliesEnabled: true,
            },
          });
        }
        for (const userId of pair) {
          await ensureParticipant(tx, conversation.id, actor.companyId, userId);
        }
        await tx.chatParticipant.updateMany({
          where: { conversationId: conversation.id, userId: { notIn: pair } },
          data: { active: false },
        });
        await writeAuditRequired(tx, {
          companyId: actor.companyId,
          userId: actor.id,
          action: 'chat.direct.open',
          details: { conversationId: conversation.id, recipientUserId: recipient.id },
        });
        return conversation.id;
      });

      let conversationId: string;
      try {
        conversationId = await open();
      } catch (error) {
        if (!isUniqueError(error)) throw error;
        conversationId = await open();
      }
      const conversation = await loadAccessibleConversation(prisma, actor, conversationId);
      return res.status(200).json(await conversationShape(prisma, conversation, actor));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/chat/departments', requireAuth, chatGate, async (req: ChatRequest, res) => {
    try {
      const actor = await loadActor(prisma, req.user!);
      const departmentIds = await departmentIdsFor(prisma, actor);
      if (departmentIds.length === 0) return res.json([]);
      const departments = await prisma.department.findMany({
        where: { companyId: actor.companyId, id: { in: departmentIds } },
        select: { id: true, name: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      return res.json(departments);
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post(
    '/api/chat/departments/:departmentId/open',
    requireAuth,
    chatGate,
    async (req: ChatRequest, res) => {
      try {
        requireCreatePerm(req.user!, PERMISSIONS.CHAT_CREATE_DEPARTMENT);
        const actor = await loadActor(prisma, req.user!);
        const department = await prisma.department.findFirst({
          where: { id: req.params.departmentId, companyId: actor.companyId },
          select: { id: true, name: true, companyId: true, managerId: true },
        });
        if (!department) {
          throw new ChatRequestError(404, 'ChatDepartmentNotFound', 'القسم غير موجود');
        }
        const allowed = (await departmentIdsFor(prisma, actor)).includes(department.id);
        if (!allowed) {
          throw new ChatRequestError(404, 'ChatDepartmentNotFound', 'القسم غير موجود');
        }

        const open = async () => prisma.$transaction(async (tx) => {
          let conversation = await tx.chatConversation.findFirst({
            where: { companyId: actor.companyId, departmentId: department.id, type: 'department' },
          });
          if (!conversation) {
            conversation = await tx.chatConversation.create({
              data: {
                companyId: actor.companyId,
                type: 'department',
                departmentId: department.id,
                title: department.name,
                createdByUserId: actor.id,
                repliesEnabled: true,
              },
            });
          }
          await ensureParticipant(tx, conversation.id, actor.companyId, actor.id);
          return conversation.id;
        });

        let conversationId: string;
        try {
          conversationId = await open();
        } catch (error) {
          if (!isUniqueError(error)) throw error;
          conversationId = await open();
        }
        const conversation = await loadAccessibleConversation(prisma, actor, conversationId);
        return res.json(await conversationShape(prisma, conversation, actor));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post('/api/chat/announcements', requireAuth, chatGate, async (req: ChatRequest, res) => {
    const body = validateBody(chatAnnouncementSchema, req, res);
    if (!body) return;
    try {
      requireCreatePerm(req.user!, PERMISSIONS.CHAT_CREATE_COMPANY_ANNOUNCEMENT);
      const actor = await loadActor(prisma, req.user!);
      const conversation = await prisma.$transaction(async (tx) => {
        const now = new Date();
        const created = await tx.chatConversation.create({
          data: {
            companyId: actor.companyId,
            type: 'announcement',
            title: body.title,
            repliesEnabled: false,
            createdByUserId: actor.id,
            lastMessageAt: body.body ? now : null,
          },
        });
        await ensureParticipant(tx, created.id, actor.companyId, actor.id);
        if (body.body) {
          await tx.chatMessage.create({
            data: {
              companyId: actor.companyId,
              conversationId: created.id,
              senderUserId: actor.id,
              body: body.body,
              createdAt: now,
            },
          });
        }
        await writeAuditRequired(tx, {
          companyId: actor.companyId,
          userId: actor.id,
          action: 'chat.announcement.create',
          details: {
            conversationId: created.id,
            titleLength: body.title.length,
            bodyLength: body.body?.length ?? 0,
          },
        });
        return created;
      });
      const hydrated = await loadAccessibleConversation(prisma, actor, conversation.id);
      return res.status(201).json(await conversationShape(prisma, hydrated, actor));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/chat/conversations', requireAuth, chatGate, async (req: ChatRequest, res) => {
    const query = validateQuery(chatConversationListQuerySchema, req, res);
    if (!query) return;
    try {
      const actor = await loadActor(prisma, req.user!);
      const departmentIds = await departmentIdsFor(prisma, actor);
      const conversations = await prisma.chatConversation.findMany({
        where: {
          companyId: actor.companyId,
          OR: conversationAccessOr(actor.id, departmentIds),
        },
        include: conversationInclude,
        take: 200,
      });
      conversations.sort((left: any, right: any) => {
        const leftActivity = new Date(left.lastMessageAt ?? left.createdAt).getTime();
        const rightActivity = new Date(right.lastMessageAt ?? right.createdAt).getTime();
        return rightActivity - leftActivity || String(right.id).localeCompare(String(right.id));
      });
      const page = conversations.slice(query.offset, query.offset + query.limit);
      const items = await Promise.all(
        page.map((conversation: any) => conversationShape(prisma, conversation, actor))
      );
      return res.json({
        items,
        nextOffset: query.offset + query.limit < conversations.length
          ? query.offset + query.limit
          : null,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get(
    '/api/chat/conversations/:id/messages',
    requireAuth,
    chatGate,
    async (req: ChatRequest, res) => {
      const query = validateQuery(chatMessageListQuerySchema, req, res);
      if (!query) return;
      try {
        const actor = await loadActor(prisma, req.user!);
        await loadAccessibleConversation(prisma, actor, req.params.id);
        const cursor = query.before ? decodeCursor(query.before, req.params.id) : null;
        const messages = await prisma.chatMessage.findMany({
          where: {
            companyId: actor.companyId,
            conversationId: req.params.id,
            ...(cursor
              ? {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                }
              : {}),
          },
          include: {
            sender: { include: userInclude },
            attachments: {
              select: {
                id: true,
                originalFilename: true,
                contentType: true,
                byteSize: true,
              },
            },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
        const hasMore = messages.length > query.limit;
        const page = messages.slice(0, query.limit);
        const nextCursor = hasMore && page.length > 0
          ? encodeCursor(req.params.id, page[page.length - 1])
          : null;
        return res.json({
          items: page.reverse().map((message: any) => messageShape(message, actor.id)),
          nextCursor,
          order: 'chronological',
        });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/chat/conversations/:id/messages',
    requireAuth,
    chatGate,
    sendLimiter,
    async (req: ChatRequest, res) => {
      const body = validateBody(chatMessageSendSchema, req, res);
      if (!body) return;
      try {
        const actor = await loadActor(prisma, req.user!);
        const message = await prisma.$transaction(async (tx) => {
          const conversation = await loadAccessibleConversation(tx, actor, req.params.id);
          if (conversation.type === 'announcement' && conversation.repliesEnabled === false) {
            throw new ChatRequestError(403, 'ChatRepliesDisabled', 'الردود معطلة على هذا الإعلان');
          }
          if (body.replyToMessageId) {
            const replyTarget = await tx.chatMessage.findFirst({
              where: {
                id: body.replyToMessageId,
                companyId: actor.companyId,
                conversationId: conversation.id,
              },
            });
            if (!replyTarget) {
              throw new ChatRequestError(404, 'ChatMessageNotFound', 'الرسالة المرجعية غير موجودة');
            }
          }
          let directRecipient: any = null;
          if (conversation.type === 'direct') {
            const peers = conversation.participants.filter(
              (row: any) => row.userId !== actor.id && row.active
            );
            directRecipient = peers.length === 1 ? peers[0].user : null;
            if (
              !directRecipient ||
              directRecipient.companyId !== actor.companyId ||
              directRecipient.employee?.status !== 'active'
            ) {
              throw new ChatRequestError(409, 'ChatRecipientInactive', 'لا يمكن إرسال رسالة إلى هذا المستخدم حالياً');
            }
          }
          await ensureParticipant(tx, conversation.id, actor.companyId, actor.id);
          const now = new Date();
          const created = await tx.chatMessage.create({
            data: {
              companyId: actor.companyId,
              conversationId: conversation.id,
              senderUserId: actor.id,
              body: body.body,
              replyToMessageId: body.replyToMessageId ?? null,
              createdAt: now,
            },
            include: {
              sender: { include: userInclude },
              attachments: {
                select: {
                  id: true,
                  originalFilename: true,
                  contentType: true,
                  byteSize: true,
                },
              },
            },
          });
          await tx.chatConversation.update({
            where: { id: conversation.id },
            data: { lastMessageAt: now },
          });
          // Direct messages only. Department and announcement conversations
          // deliberately do NOT fan out a notification row per member — unread
          // state already covers them, and a row per member per message is the
          // classic notification storm. (Guarded by an existing chat test.)
          if (directRecipient) {
            await createDomainNotifications(tx, {
              companyId: actor.companyId,
              userIds: [directRecipient.id],
              title: 'رسالة داخلية جديدة',
              message: 'لديك رسالة جديدة في المحادثات الداخلية.',
              category: 'chat',
              // The conversation id only — never the message body or a preview.
              descriptor: {
                routeKey: 'chat.conversation',
                resourceType: 'chatConversation',
                resourceId: conversation.id,
              },
            });
          }
          await writeAuditRequired(tx, {
            companyId: actor.companyId,
            userId: actor.id,
            action: 'chat.message.send',
            details: {
              conversationId: conversation.id,
              messageId: created.id,
              type: conversation.type,
              bodyLength: body.body.length,
              replyToMessageId: body.replyToMessageId ?? null,
            },
          });
          return created;
        });
        return res.status(201).json(messageShape(message, actor.id));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/chat/conversations/:id/read',
    requireAuth,
    chatGate,
    async (req: ChatRequest, res) => {
      try {
        const actor = await loadActor(prisma, req.user!);
        const conversation = await loadAccessibleConversation(prisma, actor, req.params.id);
        await prisma.chatParticipant.upsert({
          where: { conversationId_userId: { conversationId: conversation.id, userId: actor.id } },
          update: { active: true, lastReadAt: new Date() },
          create: {
            companyId: actor.companyId,
            conversationId: conversation.id,
            userId: actor.id,
            active: true,
            lastReadAt: new Date(),
          },
        });
        return res.json({ conversationId: conversation.id, unreadCount: 0 });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.get('/api/chat/unread-count', requireAuth, chatGate, async (req: ChatRequest, res) => {
    try {
      const actor = await loadActor(prisma, req.user!);
      const departmentIds = await departmentIdsFor(prisma, actor);
      const conversations = await prisma.chatConversation.findMany({
        where: {
          companyId: actor.companyId,
          OR: conversationAccessOr(actor.id, departmentIds),
        },
        include: conversationInclude,
      });
      const counts = await Promise.all(
        conversations.map((conversation: any) => unreadCount(prisma, conversation, actor.id))
      );
      return res.json({ unreadCount: counts.reduce((sum, count) => sum + count, 0) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get(
    '/api/chat/conversations/:id/pins',
    requireAuth,
    chatGate,
    async (req: ChatRequest, res) => {
      try {
        const actor = await loadActor(prisma, req.user!);
        await loadAccessibleConversation(prisma, actor, req.params.id);
        const pins = await prisma.chatPinnedMessage.findMany({
          where: {
            companyId: actor.companyId,
            conversationId: req.params.id,
          },
          orderBy: [{ pinnedAt: 'desc' }, { id: 'desc' }],
        });
        return res.json({ items: pins.map(pinShape) });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/chat/conversations/:id/pins',
    requireAuth,
    chatGate,
    async (req: ChatRequest, res) => {
      const body = validateBody(chatPinMessageSchema, req, res);
      if (!body) return;
      try {
        requirePinPerm(req.user!);
        const actor = await loadActor(prisma, req.user!);
        const conversation = await loadAccessibleConversation(prisma, actor, req.params.id);
        const message = await prisma.chatMessage.findFirst({
          where: {
            id: body.messageId,
            companyId: actor.companyId,
            conversationId: conversation.id,
          },
        });
        if (!message) {
          throw new ChatRequestError(404, 'ChatMessageNotFound', 'الرسالة غير موجودة');
        }
        const existing = await prisma.chatPinnedMessage.findFirst({
          where: {
            companyId: actor.companyId,
            conversationId: conversation.id,
            messageId: body.messageId,
          },
        });
        if (existing) {
          return res.status(200).json(pinShape(existing));
        }
        const pin = await prisma.$transaction(async (tx) => {
          const created = await tx.chatPinnedMessage.create({
            data: {
              companyId: actor.companyId,
              conversationId: conversation.id,
              messageId: body.messageId,
              pinnedByUserId: actor.id,
            },
          });
          await writeAuditRequired(tx, {
            companyId: actor.companyId,
            userId: actor.id,
            action: 'chat.message.pin',
            details: {
              conversationId: conversation.id,
              messageId: body.messageId,
            },
          });
          return created;
        });
        return res.status(201).json(pinShape(pin));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.delete(
    '/api/chat/conversations/:id/pins/:messageId',
    requireAuth,
    chatGate,
    async (req: ChatRequest, res) => {
      try {
        requirePinPerm(req.user!);
        const actor = await loadActor(prisma, req.user!);
        await loadAccessibleConversation(prisma, actor, req.params.id);
        const pin = await prisma.chatPinnedMessage.findFirst({
          where: {
            companyId: actor.companyId,
            conversationId: req.params.id,
            messageId: req.params.messageId,
          },
        });
        if (!pin) {
          throw new ChatRequestError(404, 'ChatPinNotFound', 'التثبيت غير موجود');
        }
        await prisma.$transaction(async (tx) => {
          await tx.chatPinnedMessage.delete({ where: { id: pin.id } });
          await writeAuditRequired(tx, {
            companyId: actor.companyId,
            userId: actor.id,
            action: 'chat.message.unpin',
            details: {
              conversationId: req.params.id,
              messageId: req.params.messageId,
            },
          });
        });
        return res.status(204).send();
      } catch (error) {
        return sendError(res, error);
      }
    }
  );
}
