import request from 'supertest';
import { vi } from 'vitest';
import { makeFakePrisma, tokenFor } from './helpers';

const chatToken = (
  id: string,
  employeeId: string | null,
  companyId = 'c1',
  permissions = ['chat.view', 'chat.create_direct'],
) => tokenFor({ id, employeeId, companyId, permissions });

function makeChatPrisma() {
  const prisma = makeFakePrisma();
  const departments = [
    { id: 'd1', companyId: 'c1', name: 'Engineering', managerId: 'u3' },
    { id: 'd2', companyId: 'c1', name: 'People', managerId: null },
    { id: 'df', companyId: 'c2', name: 'Foreign', managerId: 'uf' },
  ];
  const users: any[] = [
    { id: 'u1', companyId: 'c1', name: 'Employee One', role: { name: 'Employee', permissions: '["chat.view"]' }, employee: { id: 'e1', companyId: 'c1', status: 'active', jobTitle: 'Engineer', departmentId: 'd1' } },
    { id: 'u2', companyId: 'c1', name: 'Employee Two', role: { name: 'Employee', permissions: '["chat.view"]' }, employee: { id: 'e2', companyId: 'c1', status: 'active', jobTitle: 'Analyst', departmentId: 'd1' } },
    { id: 'u3', companyId: 'c1', name: 'Manager', role: { name: 'Department Manager', permissions: '["chat.view"]' }, employee: { id: 'e3', companyId: 'c1', status: 'active', jobTitle: 'Manager', departmentId: 'd1' } },
    { id: 'uh', companyId: 'c1', name: 'HR', role: { name: 'HR Manager', permissions: '["chat.view"]' }, employee: { id: 'eh', companyId: 'c1', status: 'active', jobTitle: 'HR', departmentId: 'd2' } },
    { id: 'ua', companyId: 'c1', name: 'Owner', role: { name: 'Admin', permissions: '["admin.full"]' }, accountStatus: 'active', employee: { id: 'ea', companyId: 'c1', status: 'active', jobTitle: 'CEO', departmentId: 'd2' } },
    { id: 'upo', companyId: 'c1', name: 'Primary Owner', role: { name: 'Primary Owner', permissions: '[]' }, accountStatus: 'active', employeeId: null, employee: null },
    { id: 'ui', companyId: 'c1', name: 'Inactive', role: { name: 'Employee', permissions: '["chat.view"]' }, accountStatus: 'active', employee: { id: 'ei', companyId: 'c1', status: 'inactive', jobTitle: 'Former', departmentId: 'd1' } },
    { id: 'uf', companyId: 'c2', name: 'Foreign', role: { name: 'Department Manager', permissions: '["chat.view"]' }, employee: { id: 'ef', companyId: 'c2', status: 'active', jobTitle: 'Manager', departmentId: 'df' } },
  ];
  const conversations: any[] = [];
  const participants: any[] = [];
  const messages: any[] = [];
  const pinnedMessages: any[] = [];

  const hydrateUser = (user: any) => user ? {
    ...user,
    employee: user.employee ? {
      ...user.employee,
      department: departments.find((department) => department.id === user.employee.departmentId) ?? null,
    } : null,
  } : null;
  const hydrateMessage = (message: any) => ({
    ...message,
    sender: hydrateUser(users.find((user) => user.id === message.senderUserId)),
    attachments: ((prisma as any).__memoryAttachments?.rows ?? [])
      .filter((attachment: any) => attachment.chatMessageId === message.id)
      .map((attachment: any) => ({
        id: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      })),
  });
  const hydrateConversation = (conversation: any) => ({
    ...conversation,
    department: departments.find((department) => department.id === conversation.departmentId) ?? null,
    participants: participants
      .filter((participant) => participant.conversationId === conversation.id && participant.active)
      .map((participant) => ({
        ...participant,
        user: hydrateUser(users.find((user) => user.id === participant.userId)),
      })),
    messages: messages
      .filter((message) => message.conversationId === conversation.id)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
      .slice(0, 1)
      .map(hydrateMessage),
  });

  prisma.user.findFirst.mockImplementation(async ({ where }: any) => {
    const user = users.find((candidate) =>
      (where.id === undefined || candidate.id === where.id) &&
      (where.companyId === undefined || candidate.companyId === where.companyId) &&
      (where.employee?.is?.status === undefined || candidate.employee?.status === where.employee.is.status)
    );
    return hydrateUser(user ?? null);
  });
  prisma.user.findMany.mockImplementation(async ({ where, take }: any = {}) => users
    .filter((candidate) => {
      if (where?.companyId !== undefined && candidate.companyId !== where.companyId) return false;
      if (where?.id?.not !== undefined && candidate.id === where.id.not) return false;
      if (where?.employee?.isNot === null) return candidate.employee != null;
      if (where?.employee?.is?.status !== undefined) {
        return candidate.employee?.status === where.employee.is.status;
      }
      return true;
    })
    .map(hydrateUser)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .slice(0, take ?? 200)
  );
  prisma.department.findFirst.mockImplementation(async ({ where }: any) =>
    departments.find((department) =>
      (where.id === undefined || department.id === where.id) &&
      (where.companyId === undefined || department.companyId === where.companyId)
    ) ?? null
  );
  prisma.department.findMany.mockImplementation(async ({ where, select }: any = {}) => {
    const rows = departments.filter((department) =>
      (where?.companyId === undefined || department.companyId === where.companyId) &&
      (where?.managerId === undefined || department.managerId === where.managerId) &&
      (!where?.id?.in || where.id.in.includes(department.id))
    );
    if (!select) return rows;
    return rows.map((row) => Object.fromEntries(
      Object.entries(select)
        .filter(([, enabled]) => enabled)
        .map(([key]) => [key, (row as any)[key]])
    ));
  });

  prisma.chatConversation = {
    findFirst: vi.fn(async ({ where }: any) => {
      const row = conversations.find((conversation) =>
        (where.id === undefined || conversation.id === where.id) &&
        (where.companyId === undefined || conversation.companyId === where.companyId) &&
        (where.type === undefined || conversation.type === where.type) &&
        (where.directKey === undefined || conversation.directKey === where.directKey) &&
        (where.departmentId === undefined || conversation.departmentId === where.departmentId)
      );
      return row ? hydrateConversation(row) : null;
    }),
    findMany: vi.fn(async ({ where, take }: any = {}) => conversations
      .filter((conversation) => {
        if (where?.companyId !== undefined && conversation.companyId !== where.companyId) return false;
        if (!where?.OR) return true;
        return where.OR.some((clause: any) => {
          if (clause.type !== conversation.type) return false;
          if (clause.type === 'direct') {
            return participants.some((participant) =>
              participant.conversationId === conversation.id &&
              participant.userId === clause.participants.some.userId &&
              participant.active === clause.participants.some.active
            );
          }
          if (clause.type === 'announcement') {
            return conversation.type === 'announcement';
          }
          return clause.departmentId?.in?.includes(conversation.departmentId);
        });
      })
      .map(hydrateConversation)
      .slice(0, take ?? conversations.length)
    ),
    create: vi.fn(async ({ data }: any) => {
      if (conversations.some((conversation) =>
        conversation.companyId === data.companyId &&
        ((data.directKey && conversation.directKey === data.directKey) ||
          (data.departmentId && conversation.departmentId === data.departmentId && conversation.type === data.type))
      )) {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      const now = new Date(2026, 6, 10, 10, 0, conversations.length);
      const row = {
        id: `conversation-${conversations.length + 1}`,
        departmentId: null,
        directKey: null,
        title: null,
        repliesEnabled: false,
        lastMessageAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      conversations.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = conversations.find((conversation) => conversation.id === where.id);
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
  };
  prisma.chatParticipant = {
    upsert: vi.fn(async ({ where, update, create }: any) => {
      let row = participants.find((participant) =>
        participant.conversationId === where.conversationId_userId.conversationId &&
        participant.userId === where.conversationId_userId.userId
      );
      if (row) Object.assign(row, update);
      else {
        row = { id: `participant-${participants.length + 1}`, joinedAt: new Date(), lastReadAt: null, ...create };
        participants.push(row);
      }
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const row of participants) {
        if (row.conversationId === where.conversationId && !where.userId.notIn.includes(row.userId)) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    }),
  };
  prisma.chatMessage = {
    findFirst: vi.fn(async ({ where }: any) => {
      const row = messages.find((message) =>
        (where.id === undefined || message.id === where.id) &&
        (where.companyId === undefined || message.companyId === where.companyId) &&
        (where.conversationId === undefined || message.conversationId === where.conversationId)
      );
      return row ? hydrateMessage(row) : null;
    }),
    findMany: vi.fn(async ({ where, take }: any) => messages
      .filter((message) => {
        if (message.companyId !== where.companyId || message.conversationId !== where.conversationId) return false;
        if (!where.OR) return true;
        return where.OR.some((clause: any) =>
          (clause.createdAt?.lt && message.createdAt < clause.createdAt.lt) ||
          (clause.createdAt instanceof Date && message.createdAt.getTime() === clause.createdAt.getTime() && message.id < clause.id.lt)
        );
      })
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
      .slice(0, take)
      .map(hydrateMessage)
    ),
    create: vi.fn(async ({ data }: any) => {
      const row = {
        id: `00000000-0000-4000-8000-${String(messages.length + 1).padStart(12, '0')}`,
        replyToMessageId: null,
        ...data,
      };
      messages.push(row);
      return hydrateMessage(row);
    }),
    count: vi.fn(async ({ where }: any) => messages.filter((message) =>
      message.companyId === where.companyId &&
      message.conversationId === where.conversationId &&
      message.senderUserId !== where.senderUserId.not &&
      (!where.createdAt?.gt || message.createdAt > where.createdAt.gt)
    ).length),
  };
  prisma.chatPinnedMessage = {
    findFirst: vi.fn(async ({ where }: any) => pinnedMessages.find((pin) =>
      (where.id === undefined || pin.id === where.id) &&
      (where.companyId === undefined || pin.companyId === where.companyId) &&
      (where.conversationId === undefined || pin.conversationId === where.conversationId) &&
      (where.messageId === undefined || pin.messageId === where.messageId)
    ) ?? null),
    findMany: vi.fn(async ({ where }: any = {}) => pinnedMessages
      .filter((pin) =>
        (where?.companyId === undefined || pin.companyId === where.companyId) &&
        (where?.conversationId === undefined || pin.conversationId === where.conversationId)
      )
      .sort((left, right) => right.pinnedAt.getTime() - left.pinnedAt.getTime() || right.id.localeCompare(left.id))
    ),
    create: vi.fn(async ({ data }: any) => {
      const row = {
        id: `pin-${pinnedMessages.length + 1}`,
        pinnedAt: new Date(),
        ...data,
      };
      pinnedMessages.push(row);
      return row;
    }),
    delete: vi.fn(async ({ where }: any) => {
      const index = pinnedMessages.findIndex((pin) => pin.id === where.id);
      if (index >= 0) pinnedMessages.splice(index, 1);
      return pinnedMessages[index] ?? { id: where.id };
    }),
  };

  prisma.$transaction = vi.fn(async (fn: any) => {
    const snapshots = {
      conversations: structuredClone(conversations),
      participants: structuredClone(participants),
      messages: structuredClone(messages),
      pinnedMessages: structuredClone(pinnedMessages),
      notificationLength: prisma._store.notifications.length,
      auditLength: prisma._store.auditLogs.length,
      memoryAttachments: prisma.__memoryAttachments?.rows
        ? prisma.__memoryAttachments.rows.map((row: any) => ({ ...row }))
        : null,
    };
    try {
      return await fn(prisma);
    } catch (error) {
      conversations.splice(0, conversations.length, ...snapshots.conversations);
      participants.splice(0, participants.length, ...snapshots.participants);
      messages.splice(0, messages.length, ...snapshots.messages);
      pinnedMessages.splice(0, pinnedMessages.length, ...snapshots.pinnedMessages);
      prisma._store.notifications.splice(snapshots.notificationLength);
      prisma._store.auditLogs.splice(snapshots.auditLength);
      if (snapshots.memoryAttachments && prisma.__memoryAttachments?.rows) {
        prisma.__memoryAttachments.rows.splice(
          0,
          prisma.__memoryAttachments.rows.length,
          ...snapshots.memoryAttachments
        );
      } else if (snapshots.memoryAttachments === null && prisma.__memoryAttachments?.rows) {
        prisma.__memoryAttachments.rows.splice(0, prisma.__memoryAttachments.rows.length);
      }
      throw error;
    }
  });
  prisma._store.chatConversations = conversations;
  prisma._store.chatParticipants = participants;
  prisma._store.chatMessages = messages;
  prisma._store.chatPinnedMessages = pinnedMessages;
  prisma._store.chatUsers = users;
  prisma._store.chatDepartments = departments;
  return prisma;
}


const openDirect = (app: any, actorId = 'u1', employeeId = 'e1', recipientId = 'u2') =>
  request(app)
    .post('/api/chat/direct')
    .set('Authorization', `Bearer ${chatToken(actorId, employeeId)}`)
    .send({ userId: recipientId });

export { makeChatPrisma, chatToken };
