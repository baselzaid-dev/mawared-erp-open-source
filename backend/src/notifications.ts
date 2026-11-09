import type { Express, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { PERMISSIONS } from './permissions';

interface NotificationUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface NotificationRequest extends Request {
  user?: NotificationUser;
}

interface NotificationRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
}

class NotificationRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

export const NOTIFICATION_CATEGORIES = [
  'general',
  'security',
  'workflow',
  'leave',
  'task',
  'attendance',
  'payroll',
  'chat',
  // P4: `purchasing` was already being written by purchasingOverride.ts but was
  // absent from this list, so those rows fell back to "general" in the DTO and
  // could never be filtered or preference-controlled. `training` is new in P4.
  'purchasing',
  'training',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const MANDATORY_NOTIFICATION_CATEGORIES = new Set<NotificationCategory>(['security']);

/**
 * Security boundary for notification deep-link descriptors.
 *
 * Write path (`validateNotificationDescriptor` / `createDomainNotifications`)
 * accepts only these keys. Read path (`shapeNotificationDto`) may also accept
 * documented legacy aliases in LEGACY_NOTIFICATION_ROUTE_ALIASES so older
 * stored rows remain routable without a database rewrite.
 *
 * `defaultResourceType` is read-only compatibility for rows that historically
 * omitted resourceType (auth/employee security notices). Writers must still
 * supply an explicit allowed resourceType.
 */
export const ALLOWLISTED_ROUTE_KEYS = {
  'leave.detail': { resourceTypes: ['leaveRequest', 'leave'] },
  'task.detail': { resourceTypes: ['task', 'taskAssignment'] },
  'attendance.today': { resourceTypes: ['attendance'] },
  'employees.list': { resourceTypes: ['employee'] },
  'employees.profile': { resourceTypes: ['security'], defaultResourceType: 'security' },
  'chat.conversation': { resourceTypes: ['chatConversation'] },
  'training.assignment.detail': { resourceTypes: ['trainingAssignment'] },
  'purchasing.requests.detail': { resourceTypes: ['purchase_request'] },
  'auth.sessions': { resourceTypes: ['security'], defaultResourceType: 'security' },
  'auth.change_password': { resourceTypes: ['security'], defaultResourceType: 'security' },
} as const;

export type AllowlistedRouteKey = keyof typeof ALLOWLISTED_ROUTE_KEYS;

/** Stored legacy route keys → canonical key emitted in DTOs. Not valid for new writes. */
export const LEGACY_NOTIFICATION_ROUTE_ALIASES: Readonly<Record<string, AllowlistedRouteKey>> = {
  // leaveOverride historically wrote the plural form before the allowlist settled on singular.
  'leaves.detail': 'leave.detail',
};

const ALLOWED_FILTER_KEYS = new Set([
  'status',
  'departmentId',
  'employeeId',
  'category',
  'scope',
]);

const categorySchema = z.enum(NOTIFICATION_CATEGORIES);

const listQuerySchema = z.object({
  category: categorySchema.optional(),
  read: z.enum(['true', 'false']).optional(),
  hidden: z.enum(['true', 'false']).optional(),
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

const readAllSchema = z.object({
  category: categorySchema.optional(),
}).strict();

const preferenceItemSchema = z.object({
  category: categorySchema,
  inAppEnabled: z.boolean(),
}).strict();

const preferencesPutSchema = z.object({
  preferences: z.array(preferenceItemSchema).min(1).max(NOTIFICATION_CATEGORIES.length),
}).strict();

const fail = (status: number, code: string, messageKey: string): never => {
  throw new NotificationRequestError(status, code, messageKey);
};

const iso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

const route = (
  handler: (req: NotificationRequest, res: Response) => Promise<unknown>,
): RequestHandler => async (request, response, next) => {
  try {
    await handler(request as NotificationRequest, response);
  } catch (error) {
    if (error instanceof NotificationRequestError) {
      return response.status(error.status).json({
        error: error.code,
        code: error.status,
        message: error.messageKey,
        messageKey: error.messageKey,
      });
    }
    return next(error);
  }
};

const actorFrom = (req: NotificationRequest): NotificationUser => {
  if (!req.user?.id || !req.user.companyId) {
    fail(401, 'Unauthorized', 'notification.unauthorized');
  }
  return req.user!;
};

const parseQuery = <T>(schema: z.ZodType<T>, query: unknown): T => {
  const parsed = schema.safeParse(query);
  if (!parsed.success) fail(400, 'InvalidRequest', 'notification.invalid_request');
  return parsed.data;
};

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail(400, 'InvalidRequest', 'notification.invalid_request');
  return parsed.data;
};

const encodeCursor = (createdAt: Date, id: string): string =>
  Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');

const decodeCursor = (cursor: string): { createdAt: Date; id: string } => {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) fail(400, 'InvalidRequest', 'notification.invalid_request');
    const createdAt = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (!id || Number.isNaN(createdAt.getTime())) {
      fail(400, 'InvalidRequest', 'notification.invalid_request');
    }
    return { createdAt, id };
  } catch {
    fail(400, 'InvalidRequest', 'notification.invalid_request');
  }
};

const parseFilterJson = (raw: string | null | undefined): { filterKey?: string; filterValue?: string } => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const filterKey = typeof parsed.filterKey === 'string' ? parsed.filterKey : undefined;
    const filterValue = typeof parsed.filterValue === 'string' ? parsed.filterValue : undefined;
    if (!filterKey || !ALLOWED_FILTER_KEYS.has(filterKey)) return {};
    if (!filterValue || filterValue.length > 120) return {};
    return { filterKey, filterValue };
  } catch {
    return {};
  }
};

export const validateNotificationDescriptor = (
  routeKey: string | null | undefined,
  resourceType: string | null | undefined,
  resourceId?: string | null,
  filterJson?: string | null,
): void => {
  if (!routeKey && !resourceType && !resourceId && !filterJson) return;
  if (!routeKey || !(routeKey in ALLOWLISTED_ROUTE_KEYS)) {
    fail(400, 'InvalidRouteKey', 'notification.invalid_route_key');
  }
  const allowed = ALLOWLISTED_ROUTE_KEYS[routeKey as AllowlistedRouteKey];
  if (!resourceType || !allowed.resourceTypes.includes(resourceType as never)) {
    fail(400, 'InvalidResourceType', 'notification.invalid_resource_type');
  }
  if (resourceId != null && (typeof resourceId !== 'string' || resourceId.length > 100)) {
    fail(400, 'InvalidRequest', 'notification.invalid_request');
  }
  const filters = parseFilterJson(filterJson);
  if (filterJson && !filters.filterKey) {
    fail(400, 'InvalidFilter', 'notification.invalid_filter');
  }
};

export const shapeNotificationDto = (row: {
  id: string;
  title: string;
  message: string;
  category?: string | null;
  routeKey?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  filterJson?: string | null;
  isRead: boolean;
  readAt?: Date | string | null;
  hiddenAt?: Date | string | null;
  createdAt: Date | string;
  userId?: string;
  companyId?: string;
}) => {
  const category = NOTIFICATION_CATEGORIES.includes(row.category as NotificationCategory)
    ? row.category
    : 'general';

  const dto: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    message: row.message,
    category,
    isRead: row.isRead,
    readAt: iso(row.readAt),
    hiddenAt: iso(row.hiddenAt),
    createdAt: iso(row.createdAt)!,
  };

  const resolvedRouteKey = resolveNotificationRouteKey(row.routeKey);
  if (resolvedRouteKey) {
    const allowed = ALLOWLISTED_ROUTE_KEYS[resolvedRouteKey];
    const resourceType = resolveDescriptorResourceType(
      allowed.resourceTypes as readonly string[],
      row.resourceType,
      'defaultResourceType' in allowed ? allowed.defaultResourceType : undefined,
    );
    if (resourceType) {
      dto.descriptor = {
        routeKey: resolvedRouteKey,
        resourceType,
        ...(row.resourceId ? { resourceId: row.resourceId } : {}),
        ...parseFilterJson(row.filterJson),
      };
    }
  }

  return dto;
};

const resolveNotificationRouteKey = (
  routeKey: string | null | undefined,
): AllowlistedRouteKey | undefined => {
  if (!routeKey) return undefined;
  if (routeKey in ALLOWLISTED_ROUTE_KEYS) return routeKey as AllowlistedRouteKey;
  return LEGACY_NOTIFICATION_ROUTE_ALIASES[routeKey];
};

const resolveDescriptorResourceType = (
  allowedTypes: readonly string[],
  resourceType: string | null | undefined,
  defaultResourceType: string | undefined,
): string | null => {
  if (resourceType) {
    return allowedTypes.includes(resourceType) ? resourceType : null;
  }
  return defaultResourceType && allowedTypes.includes(defaultResourceType)
    ? defaultResourceType
    : null;
};

export interface DomainNotificationDescriptor {
  routeKey: AllowlistedRouteKey;
  resourceType: string;
  resourceId?: string;
}

export interface DomainNotificationInput {
  companyId: string;
  userIds: readonly string[];
  title: string;
  message: string;
  category: NotificationCategory;
  descriptor?: DomainNotificationDescriptor;
}

/**
 * Single producer path for module notifications (P4).
 *
 * Before P4, Tasks/Training/Chat wrote `{companyId, userId, title, message}`
 * directly, so every row landed as an uncategorised "general" notification with
 * no deep link even though `task.detail` was already allowlisted. Routing
 * producers through here guarantees three things at once:
 *
 *  1. the category is a real one, so inbox filters and preferences work;
 *  2. the deep-link descriptor is validated against ALLOWLISTED_ROUTE_KEYS at
 *     write time, so an unroutable descriptor fails loudly instead of being
 *     silently dropped later by shapeNotificationDto;
 *  3. a recipient who disabled the category stops receiving it — preferences
 *     were previously stored but never consulted by any producer.
 *
 * Recipient preferences are read in ONE query for the whole batch rather than
 * per recipient, so fanning out to a large assignee list stays two queries plus
 * the inserts. Mandatory categories (security) ignore preferences entirely.
 *
 * `client` is the surrounding transaction when the caller has one, so the
 * notification commits or rolls back with the business mutation it describes.
 */
export const createDomainNotifications = async (
  client: any,
  input: DomainNotificationInput,
): Promise<number> => {
  const recipients = [...new Set(input.userIds.filter((id): id is string => !!id))];
  if (recipients.length === 0) return 0;

  if (!NOTIFICATION_CATEGORIES.includes(input.category)) {
    throw new Error(`unknown notification category: ${input.category}`);
  }
  if (input.descriptor) {
    // Throws (400-shaped) if the descriptor could never be routed by a client.
    validateNotificationDescriptor(
      input.descriptor.routeKey,
      input.descriptor.resourceType,
      input.descriptor.resourceId ?? null,
      null,
    );
  }

  let allowed = recipients;
  if (!MANDATORY_NOTIFICATION_CATEGORIES.has(input.category) && client.notificationPreference?.findMany) {
    const optedOut = await client.notificationPreference.findMany({
      where: {
        companyId: input.companyId,
        userId: { in: recipients },
        category: input.category,
        inAppEnabled: false,
      },
      select: { userId: true },
    });
    if (optedOut.length > 0) {
      const disabled = new Set(optedOut.map((row: { userId: string }) => row.userId));
      allowed = recipients.filter((userId) => !disabled.has(userId));
    }
  }

  for (const userId of allowed) {
    await client.notification.create({
      data: {
        companyId: input.companyId,
        userId,
        title: input.title,
        message: input.message,
        category: input.category,
        ...(input.descriptor
          ? {
              routeKey: input.descriptor.routeKey,
              resourceType: input.descriptor.resourceType,
              resourceId: input.descriptor.resourceId ?? null,
            }
          : {}),
      },
    });
  }
  return allowed.length;
};

const loadOwnNotification = async (
  prisma: PrismaClient,
  actor: NotificationUser,
  id: string,
) => {
  const row = await prisma.notification.findFirst({
    where: {
      id,
      userId: actor.id,
      companyId: actor.companyId,
    },
  });
  if (!row) fail(404, 'NotificationNotFound', 'notification.not_found');
  return row;
};

const defaultPreferences = (): Array<{
  category: NotificationCategory;
  inAppEnabled: boolean;
  mandatory: boolean;
}> =>
  NOTIFICATION_CATEGORIES.map((category) => ({
    category,
    inAppEnabled: true,
    mandatory: MANDATORY_NOTIFICATION_CATEGORIES.has(category),
  }));

const loadPreferencesResponse = async (
  prisma: PrismaClient,
  actor: NotificationUser,
) => {
  const rows = await prisma.notificationPreference.findMany({
    where: {
      companyId: actor.companyId,
      userId: actor.id,
    },
  });
  const byCategory = new Map(rows.map((row) => [row.category, row]));
  return {
    preferences: defaultPreferences().map((entry) => {
      const stored = byCategory.get(entry.category);
      const inAppEnabled = entry.mandatory
        ? true
        : stored?.inAppEnabled ?? true;
      return {
        category: entry.category,
        inAppEnabled,
        mandatory: entry.mandatory,
      };
    }),
  };
};

export function registerNotificationRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
}: NotificationRouteDeps): void {
  app.get(
    '/api/v2/notifications',
    requireAuth,
    checkAnyPermission(PERMISSIONS.NOTIFICATIONS_VIEW),
    route(async (req, res) => {
      const actor = actorFrom(req);
      const query = parseQuery(listQuerySchema, req.query);
      const limit = query.limit ?? 50;
      const where: Record<string, unknown> = {
        companyId: actor.companyId,
        userId: actor.id,
      };
      if (query.category) where.category = query.category;
      if (query.read === 'true') where.isRead = true;
      if (query.read === 'false') where.isRead = false;
      if (query.hidden === 'true') {
        where.hiddenAt = { not: null };
      } else {
        where.hiddenAt = null;
      }
      if (query.cursor) {
        const cursor = decodeCursor(query.cursor);
        where.OR = [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ];
      }

      const rows = await prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return res.json({
        items: page.map(shapeNotificationDto),
        nextCursor: hasMore && last ? encodeCursor(new Date(last.createdAt), last.id) : null,
        hasMore,
      });
    }),
  );

  /**
   * P4 badge source. Deliberately different from the legacy
   * `/api/notifications/unread-count`, which counts hidden rows too and so can
   * report a badge the v2 inbox has no row to clear. Hidden rows are excluded
   * here to match what `GET /api/v2/notifications` actually returns.
   */
  app.get(
    '/api/v2/notifications/unread-count',
    requireAuth,
    checkAnyPermission(PERMISSIONS.NOTIFICATIONS_VIEW),
    route(async (req, res) => {
      const actor = actorFrom(req);
      const query = parseQuery(readAllSchema, req.query ?? {});
      const count = await prisma.notification.count({
        where: {
          companyId: actor.companyId,
          userId: actor.id,
          isRead: false,
          hiddenAt: null,
          ...(query.category ? { category: query.category } : {}),
        },
      });
      return res.json({ unreadCount: count });
    }),
  );

  app.post('/api/v2/notifications/:id/read', requireAuth, route(async (req, res) => {
    const actor = actorFrom(req);
    const row = await loadOwnNotification(prisma, actor, req.params.id);
    const now = new Date();
    const updated = row.isRead && row.readAt
      ? row
      : await prisma.notification.update({
          where: { id: row.id },
          data: { isRead: true, readAt: now },
        });
    return res.json(shapeNotificationDto(updated));
  }));

  app.post('/api/v2/notifications/read-all', requireAuth, route(async (req, res) => {
    const actor = actorFrom(req);
    const body = parseBody(readAllSchema, req.body ?? {});
    const now = new Date();
    const result = await prisma.notification.updateMany({
      where: {
        companyId: actor.companyId,
        userId: actor.id,
        isRead: false,
        hiddenAt: null,
        ...(body.category ? { category: body.category } : {}),
      },
      data: { isRead: true, readAt: now },
    });
    return res.json({ updatedCount: result.count });
  }));

  app.post('/api/v2/notifications/:id/hide', requireAuth, route(async (req, res) => {
    const actor = actorFrom(req);
    const row = await loadOwnNotification(prisma, actor, req.params.id);
    if (!row.hiddenAt) {
      await prisma.notification.update({
        where: { id: row.id },
        data: { hiddenAt: new Date() },
      });
    }
    return res.status(204).send();
  }));

  app.get('/api/v2/notifications/preferences', requireAuth, route(async (req, res) => {
    const actor = actorFrom(req);
    return res.json(await loadPreferencesResponse(prisma, actor));
  }));

  app.put('/api/v2/notifications/preferences', requireAuth, route(async (req, res) => {
    const actor = actorFrom(req);
    const body = parseBody(preferencesPutSchema, req.body ?? {});
    const seen = new Set<string>();
    for (const item of body.preferences) {
      if (seen.has(item.category)) fail(400, 'InvalidRequest', 'notification.invalid_request');
      seen.add(item.category);
      if (MANDATORY_NOTIFICATION_CATEGORIES.has(item.category) && !item.inAppEnabled) {
        fail(400, 'MandatoryCategory', 'notification.mandatory_category');
      }
    }

    await prisma.$transaction(async (tx) => {
      for (const item of body.preferences) {
        if (MANDATORY_NOTIFICATION_CATEGORIES.has(item.category)) continue;
        await tx.notificationPreference.upsert({
          where: {
            companyId_userId_category: {
              companyId: actor.companyId,
              userId: actor.id,
              category: item.category,
            },
          },
          create: {
            id: randomUUID(),
            companyId: actor.companyId,
            userId: actor.id,
            category: item.category,
            inAppEnabled: item.inAppEnabled,
          },
          update: {
            inAppEnabled: item.inAppEnabled,
          },
        });
      }
      await writeAuditRequired(tx, {
        companyId: actor.companyId,
        userId: actor.id,
        action: 'notification.preferences.update',
        details: {
          categories: body.preferences.map((item) => item.category),
          changedFields: body.preferences
            .filter((item) => !MANDATORY_NOTIFICATION_CATEGORIES.has(item.category))
            .map((item) => item.category),
        },
      });
    });

    return res.json(await loadPreferencesResponse(prisma, actor));
  }));
}
