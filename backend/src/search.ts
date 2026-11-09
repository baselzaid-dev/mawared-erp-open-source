import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { loadManagedDepartmentIds, loadPrimaryOwnerUserId, parseRolePermissions } from './authorization';
import { PERMISSIONS } from './permissions';

/**
 * Sprint 12L federated global search — GET /api/v2/search.
 *
 * A read model only: results never perform the linked action, and every result
 * carries an allowlisted routeKey/resourceType descriptor that the module
 * endpoint re-authorizes when opened. There is no `search.all` permission —
 * each source is scoped by that module's own view permissions, and a caller
 * without any source permission receives an empty page, never a 403 that
 * would signal existence.
 */

export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_MAX_QUERY_LENGTH = 100;
export const SEARCH_MAX_LIMIT = 25;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_CURSOR = 200;
/**
 * A cursor may point at the final reachable row even when `limit=1`.
 * Keeping the merged result set at or below this bound prevents a busy early
 * source from making later source types permanently unreachable.
 */
const SEARCH_RESULT_WINDOW = SEARCH_MAX_CURSOR + 1;

export const SEARCH_TYPES = [
  'employee',
  'vendor',
  'purchase_request',
  'training_course',
  'task',
  'chat_conversation',
] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

/**
 * Local security metrics (Sprint 12L "search security metrics"): counters only,
 * never query text or result data.
 */
export const searchSecurityMetrics = {
  requests: 0,
  rejectedInvalid: 0,
  rejectedShortQuery: 0,
  emptyPermissionRequests: 0,
  resultsReturned: 0,
  reset() {
    this.requests = 0;
    this.rejectedInvalid = 0;
    this.rejectedShortQuery = 0;
    this.emptyPermissionRequests = 0;
    this.resultsReturned = 0;
  },
};

interface SearchUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface SearchRequest extends Request {
  user?: SearchUser;
}

export interface SearchRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  searchLimiter?: RequestHandler;
}

const querySchema = z.object({
  q: z.string(),
  types: z.string().optional(),
  cursor: z.coerce.number().int().min(0).max(SEARCH_MAX_CURSOR).optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).optional(),
}).strip();

export interface SearchResultItem {
  type: SearchType;
  id: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  routeKey: string;
  resourceType: string;
  resourceId: string | null;
  filterJson: string | null;
}

const has = (user: SearchUser, permission: string): boolean =>
  user.permissions.includes(PERMISSIONS.ADMIN_FULL) || user.permissions.includes(permission);

const hasExact = (user: SearchUser, permission: string): boolean =>
  user.permissions.includes(permission);

const isProtectedUser = (
  candidate: { id?: string | null; role?: { permissions?: string | null } | null } | null | undefined,
  primaryOwnerUserId: string | null,
): boolean =>
  candidate?.id === primaryOwnerUserId ||
  parseRolePermissions(candidate?.role?.permissions).includes(PERMISSIONS.ADMIN_FULL);

const normalizeQuery = (raw: string): string => {
  try {
    return raw.normalize('NFKC').trim();
  } catch {
    return raw.trim();
  }
};

const typeOrder = new Map<SearchType, number>(SEARCH_TYPES.map((type, index) => [type, index]));

const sortResults = (items: SearchResultItem[]): SearchResultItem[] =>
  items.sort((left, right) =>
    (typeOrder.get(left.type)! - typeOrder.get(right.type)!) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id));

async function searchEmployees(
  prisma: PrismaClient,
  user: SearchUser,
  query: string,
  take: number,
): Promise<SearchResultItem[]> {
  const companyWide = has(user, PERMISSIONS.EMPLOYEES_VIEW);
  const departmentOnly = !companyWide && hasExact(user, PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT);
  if (!companyWide && !departmentOnly) return [];

  let departmentFilter: Record<string, unknown> = {};
  if (departmentOnly) {
    const managed = await loadManagedDepartmentIds(prisma, {
      companyId: user.companyId,
      userId: user.id,
    });
    if (managed.length === 0) return [];
    departmentFilter = { departmentId: { in: managed } };
  }

  const rows = await prisma.employee.findMany({
    where: {
      companyId: user.companyId,
      archivedAt: null,
      ...departmentFilter,
      OR: [
        { user: { is: { name: { contains: query, mode: 'insensitive' } } } },
        { employeeNum: { contains: query, mode: 'insensitive' } },
        { jobTitle: { contains: query, mode: 'insensitive' } },
      ],
    },
    select: {
      id: true,
      employeeNum: true,
      jobTitle: true,
      departmentId: true,
      department: { select: { name: true } },
      user: { select: { id: true, name: true, role: { select: { permissions: true } } } },
    },
    take,
    orderBy: [{ employeeNum: 'asc' }, { id: 'asc' }],
  });

  // Owner privacy mirrors GET /api/employees: the Primary Owner / admin.full
  // employee record stays out of operational search unless the requester is an
  // owner-data viewer (hr.view / admin.full) or the owner themself.
  const explicitOwnerUserId = await loadPrimaryOwnerUserId(prisma, user.companyId);
  const requesterPrivileged =
    hasExact(user, PERMISSIONS.ADMIN_FULL) ||
    hasExact(user, PERMISSIONS.HR_VIEW) ||
    (explicitOwnerUserId !== null && explicitOwnerUserId === user.id);

  return rows
    .filter((row: any) => requesterPrivileged || (
      row.user?.id !== explicitOwnerUserId &&
      !parseRolePermissions(row.user?.role?.permissions).includes(PERMISSIONS.ADMIN_FULL)
    ))
    .map((row: any): SearchResultItem => ({
      type: 'employee',
      id: row.id,
      title: row.user?.name ?? row.employeeNum,
      subtitle: [row.jobTitle, row.department?.name].filter(Boolean).join(' — ') || null,
      status: null,
      routeKey: 'employees.list',
      resourceType: 'employee',
      resourceId: row.id,
      filterJson: `{"employeeId":"${row.id}"}`,
    }));
}

async function searchVendors(
  prisma: PrismaClient,
  user: SearchUser,
  query: string,
  take: number,
): Promise<SearchResultItem[]> {
  if (!has(user, PERMISSIONS.VENDORS_VIEW)) return [];
  const rows = await prisma.vendor.findMany({
    where: {
      companyId: user.companyId,
      status: { not: 'archived' },
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { category: { contains: query, mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, category: true, status: true },
    take,
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row: any): SearchResultItem => ({
    type: 'vendor',
    id: row.id,
    title: row.name,
    subtitle: row.category ?? null,
    status: row.status,
    routeKey: 'vendors.list',
    resourceType: 'vendor',
    resourceId: row.id,
    filterJson: `{"vendorId":"${row.id}"}`,
  }));
}

async function searchPurchaseRequests(
  prisma: PrismaClient,
  user: SearchUser,
  query: string,
  take: number,
): Promise<SearchResultItem[]> {
  let scopeKind: 'company' | 'department' | 'own';
  let scopeFilter: Record<string, unknown>;
  if (has(user, PERMISSIONS.PURCHASING_VIEW)) {
    scopeKind = 'company';
    scopeFilter = {};
  } else if (hasExact(user, PERMISSIONS.PURCHASING_VIEW_DEPARTMENT)) {
    scopeKind = 'department';
    const managed = await loadManagedDepartmentIds(prisma, {
      companyId: user.companyId,
      userId: user.id,
    });
    if (managed.length === 0) return [];
    scopeFilter = { departmentId: { in: managed } };
  } else if (hasExact(user, PERMISSIONS.PURCHASING_VIEW_OWN) && user.employeeId) {
    scopeKind = 'own';
    scopeFilter = { requestedByEmployeeId: user.employeeId };
  } else {
    return [];
  }

  const rows = await prisma.purchaseRequest.findMany({
    where: {
      companyId: user.companyId,
      ...scopeFilter,
      OR: [
        { title: { contains: query, mode: 'insensitive' } },
        { requestNumber: { contains: query, mode: 'insensitive' } },
      ],
    },
    select: {
      id: true,
      title: true,
      requestNumber: true,
      status: true,
      requester: {
        select: {
          user: { select: { id: true, role: { select: { permissions: true } } } },
        },
      },
    },
    take,
    orderBy: [{ requestNumber: 'asc' }, { id: 'asc' }],
  });
  const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, user.companyId);
  return rows
    .filter((row: any) =>
      scopeKind === 'own' ||
      hasExact(user, PERMISSIONS.ADMIN_FULL) ||
      !isProtectedUser(row.requester?.user, primaryOwnerUserId))
    .map((row: any): SearchResultItem => ({
      type: 'purchase_request',
      id: row.id,
      title: row.title,
      subtitle: row.requestNumber,
      status: row.status,
      routeKey: 'purchasing.requests',
      resourceType: 'purchaserequest',
      resourceId: row.id,
      filterJson: `{"requestId":"${row.id}"}`,
    }));
}

async function searchTrainingCourses(
  prisma: PrismaClient,
  user: SearchUser,
  query: string,
  take: number,
): Promise<SearchResultItem[]> {
  let scopeKind: 'company' | 'department' | 'own';
  let managedDepartmentIds: string[] = [];
  let scopeFilter: Record<string, unknown>;
  if (has(user, PERMISSIONS.TRAINING_VIEW_COMPANY)) {
    scopeKind = 'company';
    scopeFilter = {};
  } else if (hasExact(user, PERMISSIONS.TRAINING_VIEW_DEPARTMENT)) {
    scopeKind = 'department';
    managedDepartmentIds = await loadManagedDepartmentIds(prisma, {
      companyId: user.companyId,
      userId: user.id,
    });
    if (managedDepartmentIds.length === 0) return [];
    scopeFilter = {
      assignments: { some: { departmentIdSnapshot: { in: managedDepartmentIds } } },
    };
  } else if (hasExact(user, PERMISSIONS.TRAINING_VIEW_OWN) && user.employeeId) {
    scopeKind = 'own';
    scopeFilter = { assignments: { some: { employeeId: user.employeeId } } };
  } else {
    return [];
  }

  const rows = await prisma.trainingCourse.findMany({
    where: {
      companyId: user.companyId,
      status: { not: 'archived' },
      ...scopeFilter,
      OR: [
        { title: { contains: query, mode: 'insensitive' } },
        { courseCode: { contains: query, mode: 'insensitive' } },
      ],
    },
    select: {
      id: true,
      title: true,
      courseCode: true,
      status: true,
      assignments: {
        select: {
          employeeId: true,
          departmentIdSnapshot: true,
          employee: {
            select: {
              user: { select: { id: true, role: { select: { permissions: true } } } },
            },
          },
        },
      },
    },
    take,
    orderBy: [{ courseCode: 'asc' }, { id: 'asc' }],
  });
  const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, user.companyId);
  const mayViewProtected =
    hasExact(user, PERMISSIONS.ADMIN_FULL) ||
    hasExact(user, PERMISSIONS.HR_VIEW) ||
    primaryOwnerUserId === user.id;
  return rows
    .filter((row: any) => {
      if (scopeKind === 'company') return true;
      const scopedAssignments = (row.assignments ?? []).filter((assignment: any) =>
        scopeKind === 'own'
          ? assignment.employeeId === user.employeeId
          : managedDepartmentIds.includes(assignment.departmentIdSnapshot));
      return scopedAssignments.some((assignment: any) =>
        mayViewProtected ||
        !isProtectedUser(assignment.employee?.user, primaryOwnerUserId));
    })
    .map((row: any): SearchResultItem => ({
      type: 'training_course',
      id: row.id,
      title: row.title,
      subtitle: row.courseCode,
      status: row.status,
      routeKey: 'training.courses',
      resourceType: 'trainingcourse',
      resourceId: row.id,
      filterJson: `{"courseId":"${row.id}"}`,
    }));
}

async function searchTasks(
  prisma: PrismaClient,
  user: SearchUser,
  query: string,
  take: number,
): Promise<SearchResultItem[]> {
  let scopeKind: 'company' | 'department' | 'own';
  let managedDepartmentIds: string[] = [];
  let scopeFilter: Record<string, unknown>;
  if (has(user, PERMISSIONS.TASKS_VIEW_COMPANY)) {
    scopeKind = 'company';
    scopeFilter = {};
  } else if (hasExact(user, PERMISSIONS.TASKS_VIEW_DEPARTMENT)) {
    scopeKind = 'department';
    managedDepartmentIds = await loadManagedDepartmentIds(prisma, {
      companyId: user.companyId,
      userId: user.id,
    });
    if (managedDepartmentIds.length === 0) return [];
    scopeFilter = {
      assignments: {
        some: { employee: { is: { departmentId: { in: managedDepartmentIds } } } },
      },
    };
  } else if (hasExact(user, PERMISSIONS.TASKS_VIEW_OWN) && user.employeeId) {
    scopeKind = 'own';
    scopeFilter = { assignments: { some: { employeeId: user.employeeId } } };
  } else {
    return [];
  }

  const rows = await prisma.task.findMany({
    where: {
      companyId: user.companyId,
      ...scopeFilter,
      title: { contains: query, mode: 'insensitive' },
    },
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      assignments: {
        select: {
          employeeId: true,
          employee: {
            select: {
              departmentId: true,
              user: { select: { id: true, role: { select: { permissions: true } } } },
            },
          },
        },
      },
    },
    take,
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
  });
  const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, user.companyId);
  const mayViewProtected =
    hasExact(user, PERMISSIONS.ADMIN_FULL) ||
    hasExact(user, PERMISSIONS.HR_VIEW) ||
    primaryOwnerUserId === user.id;
  return rows
    .filter((row: any) =>
      (row.assignments ?? []).some((assignment: any) => {
        const inScope = scopeKind === 'company'
          || (scopeKind === 'own' && assignment.employeeId === user.employeeId)
          || (scopeKind === 'department' &&
            managedDepartmentIds.includes(assignment.employee?.departmentId));
        return inScope && (
          mayViewProtected ||
          !isProtectedUser(assignment.employee?.user, primaryOwnerUserId)
        );
      }))
    .map((row: any): SearchResultItem => ({
      type: 'task',
      id: row.id,
      title: row.title,
      subtitle: row.priority ?? null,
      status: row.status,
      routeKey: 'task.detail',
      resourceType: 'task',
      resourceId: row.id,
      filterJson: null,
    }));
}

async function searchChatConversations(
  prisma: PrismaClient,
  user: SearchUser,
  query: string,
  take: number,
): Promise<SearchResultItem[]> {
  if (!has(user, PERMISSIONS.CHAT_VIEW) || !user.employeeId) return [];

  const actorEmployee = await prisma.employee.findFirst({
    where: {
      id: user.employeeId,
      companyId: user.companyId,
      status: 'active',
      archivedAt: null,
    },
    select: { departmentId: true },
  });
  if (!actorEmployee) return [];

  const accessibleDepartmentIds = new Set<string>();
  if (actorEmployee.departmentId) accessibleDepartmentIds.add(actorEmployee.departmentId);
  for (const departmentId of await loadManagedDepartmentIds(prisma, {
    companyId: user.companyId,
    userId: user.id,
  })) {
    accessibleDepartmentIds.add(departmentId);
  }

  // Access mirrors Chat itself: direct conversations require active membership;
  // Department channels use server-derived scope; announcements are company-wide.
  // Message bodies are never matched or returned.
  const rows = await prisma.chatConversation.findMany({
    where: {
      companyId: user.companyId,
      OR: [
        { type: 'direct', participants: { some: { userId: user.id, active: true } } },
        ...(accessibleDepartmentIds.size > 0
          ? [{ type: 'department', departmentId: { in: [...accessibleDepartmentIds] } }]
          : []),
        { type: 'announcement' },
      ],
    },
    select: {
      id: true,
      title: true,
      type: true,
      participants: {
        where: { active: true },
        select: { userId: true, user: { select: { name: true } } },
      },
    },
    take,
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
  });
  const normalizedQuery = query.toLocaleLowerCase();
  return rows
    .flatMap((row: any): SearchResultItem[] => {
      const peer = row.type === 'direct'
        ? row.participants?.find((participant: any) => participant.userId !== user.id)?.user
        : null;
      const title = row.type === 'direct'
        ? peer?.name ?? 'محادثة مباشرة'
        : row.title ?? (row.type === 'announcement' ? 'إعلان' : 'قناة القسم');
      if (!title.toLocaleLowerCase().includes(normalizedQuery)) return [];
      return [{
        type: 'chat_conversation',
        id: row.id,
        title,
        subtitle: row.type,
        status: null,
        routeKey: 'chat.conversation',
        resourceType: 'conversation',
        resourceId: row.id,
        filterJson: null,
      }];
    });
}

const SOURCES: Record<SearchType, (
  prisma: PrismaClient,
  user: SearchUser,
  query: string,
  take: number,
) => Promise<SearchResultItem[]>> = {
  employee: searchEmployees,
  vendor: searchVendors,
  purchase_request: searchPurchaseRequests,
  training_course: searchTrainingCourses,
  task: searchTasks,
  chat_conversation: searchChatConversations,
};

export async function runGlobalSearch(
  prisma: PrismaClient,
  user: SearchUser,
  input: { query: string; types?: SearchType[]; cursor?: number; limit?: number },
): Promise<{ items: SearchResultItem[]; nextCursor: number | null }> {
  const requestedTypes = [...new Set(
    input.types && input.types.length > 0 ? input.types : [...SEARCH_TYPES],
  )];
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? SEARCH_DEFAULT_LIMIT;
  const perSourceTake = Math.max(1, Math.floor(SEARCH_RESULT_WINDOW / requestedTypes.length));

  const perSource = await Promise.all(
    requestedTypes.map((type) => SOURCES[type](prisma, user, input.query, perSourceTake)),
  );
  const merged = sortResults(perSource.flat());
  const page = merged.slice(cursor, cursor + limit);
  const nextCursor = cursor + page.length < merged.length && cursor + page.length <= SEARCH_MAX_CURSOR
    ? cursor + page.length
    : null;
  return { items: page, nextCursor };
}

export function registerSearchRoutes({ app, prisma, requireAuth, searchLimiter }: SearchRouteDeps): void {
  const middleware: RequestHandler[] = searchLimiter ? [searchLimiter, requireAuth] : [requireAuth];

  app.get('/api/v2/search', ...middleware, async (req: SearchRequest, res: Response) => {
    searchSecurityMetrics.requests += 1;
    const user = req.user;
    if (!user?.id || !user.companyId) {
      return res.status(401).json({ error: 'Unauthorized', code: 401 });
    }

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      searchSecurityMetrics.rejectedInvalid += 1;
      return res.status(400).json({
        error: 'InvalidRequest',
        code: 400,
        message: 'search.invalid_request',
        messageKey: 'search.invalid_request',
      });
    }

    const query = normalizeQuery(parsed.data.q);
    if (query.length < SEARCH_MIN_QUERY_LENGTH || query.length > SEARCH_MAX_QUERY_LENGTH) {
      searchSecurityMetrics.rejectedShortQuery += 1;
      return res.status(400).json({
        error: 'QueryTooShort',
        code: 400,
        message: 'search.query_length',
        messageKey: 'search.query_length',
        minLength: SEARCH_MIN_QUERY_LENGTH,
        maxLength: SEARCH_MAX_QUERY_LENGTH,
      });
    }

    let types: SearchType[] | undefined;
    if (parsed.data.types !== undefined) {
      const requested = parsed.data.types.split(',').map((value) => value.trim()).filter(Boolean);
      if (requested.length === 0 ||
        requested.some((value) => !(SEARCH_TYPES as readonly string[]).includes(value))) {
        searchSecurityMetrics.rejectedInvalid += 1;
        return res.status(400).json({
          error: 'InvalidSearchType',
          code: 400,
          message: 'search.invalid_type',
          messageKey: 'search.invalid_type',
        });
      }
      types = [...new Set(requested)] as SearchType[];
    }

    try {
      const { items, nextCursor } = await runGlobalSearch(prisma, user, {
        query,
        types,
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
      });
      if (items.length === 0) searchSecurityMetrics.emptyPermissionRequests += 1;
      searchSecurityMetrics.resultsReturned += items.length;
      return res.json({ items, nextCursor });
    } catch {
      return res.status(500).json({
        error: 'SearchFailed',
        code: 500,
        message: 'search.failed',
        messageKey: 'search.failed',
      });
    }
  });
}
