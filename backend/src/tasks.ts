import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { writeAuditRequired } from './audit';
import { createDomainNotifications } from './notifications';
import { PERMISSIONS } from './permissions';
import { loadManagedDepartmentIds, loadPrimaryOwnerUserId } from './authorization';
import {
  createTaskSchema,
  taskCommentCreateSchema,
  taskCommentListQuerySchema,
  taskListQuerySchema,
  taskProgressSchema,
  taskReviewSchema,
  updateTaskSchema,
  validateBody,
  validateQuery,
} from './validation';

export interface TaskUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface TaskRequest extends Request {
  user?: TaskUser;
}

interface TaskRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
}

export type TaskScope = 'own' | 'department' | 'company';

export interface TaskListFilters {
  scope?: TaskScope;
  status?: string;
  priority?: string;
  from?: string;
  to?: string;
  employeeId?: string;
}

interface ScopeContext {
  kind: TaskScope;
  employeeId: string | null;
  departmentIds: string[];
}

export class TaskRequestError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string
  ) {
    super(message);
  }
}

const taskInclude = {
  creator: { select: { id: true, name: true } },
  assignments: {
    include: {
      employee: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              role: { select: { permissions: true } },
            },
          },
          department: { select: { id: true, name: true, managerId: true } },
        },
      },
      reviewer: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;

const assignmentInclude = {
  task: { include: { creator: { select: { id: true, name: true } } } },
  employee: {
    include: {
      user: {
        select: {
          id: true,
          name: true,
          role: { select: { permissions: true } },
        },
      },
      department: { select: { id: true, name: true, managerId: true } },
    },
  },
  reviewer: { select: { id: true, name: true } },
} as const;

const parsePermissions = (value: string | null | undefined): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((permission): permission is string => typeof permission === 'string')
      : [];
  } catch {
    return [];
  }
};

const isAdmin = (user: TaskUser): boolean => user.permissions.includes(PERMISSIONS.ADMIN_FULL);
const hasPermission = (user: TaskUser, permission: string): boolean =>
  isAdmin(user) || user.permissions.includes(permission);

const isOwnerEmployee = (employee: any, primaryOwnerUserId: string | null): boolean =>
  employee?.user?.id === primaryOwnerUserId ||
  parsePermissions(employee?.user?.role?.permissions).includes(PERMISSIONS.ADMIN_FULL);

const timestamp = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

const dateOnly = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString().slice(0, 10);

const assignmentShape = (assignment: any) => ({
  id: assignment.id,
  taskId: assignment.taskId,
  employee: {
    id: assignment.employee.id,
    employeeNum: assignment.employee.employeeNum,
    name: assignment.employee.user?.name ?? 'موظف',
    departmentId: assignment.employee.departmentId ?? null,
    departmentName: assignment.employee.department?.name ?? null,
  },
  status: assignment.status,
  completionDetails: assignment.completionDetails ?? null,
  submittedAt: timestamp(assignment.submittedAt),
  reviewer: assignment.reviewer
    ? { id: assignment.reviewer.id, name: assignment.reviewer.name }
    : null,
  reviewedAt: timestamp(assignment.reviewedAt),
  reviewNote: assignment.reviewNote ?? null,
  createdAt: timestamp(assignment.createdAt),
  updatedAt: timestamp(assignment.updatedAt),
});

const taskShape = (task: any, assignments: any[] = task.assignments ?? []) => ({
  id: task.id,
  companyId: task.companyId,
  title: task.title,
  description: task.description ?? null,
  priority: task.priority,
  dueDate: dateOnly(task.dueDate),
  status: task.status,
  creator: { id: task.creator.id, name: task.creator.name },
  assignments: assignments.map(assignmentShape),
  createdAt: timestamp(task.createdAt),
  updatedAt: timestamp(task.updatedAt),
});

const employeeShape = (employee: any) => ({
  employeeId: employee.id,
  employeeNum: employee.employeeNum,
  name: employee.user?.name ?? 'موظف',
  departmentId: employee.departmentId ?? null,
  departmentName: employee.department?.name ?? null,
});

const sendError = (res: Response, error: unknown): Response => {
  if (error instanceof TaskRequestError) {
    return res.status(error.status).json({
      error: error.errorCode,
      message: error.message,
      code: error.status,
    });
  }
  return res.status(500).json({
    error: 'TaskOperationFailed',
    message: 'تعذّر إكمال عملية المهمة حالياً',
    code: 500,
  });
};

const managedDepartmentIds = async (prisma: PrismaClient, user: TaskUser): Promise<string[]> => {
  return loadManagedDepartmentIds(prisma, { companyId: user.companyId, userId: user.id });
};

const resolveViewScope = async (
  prisma: PrismaClient,
  user: TaskUser,
  requested?: TaskScope
): Promise<ScopeContext> => {
  const selected: TaskScope = requested ?? (
    hasPermission(user, PERMISSIONS.TASKS_VIEW_COMPANY)
      ? 'company'
      : hasPermission(user, PERMISSIONS.TASKS_VIEW_DEPARTMENT)
        ? 'department'
        : 'own'
  );

  if (selected === 'company') {
    if (!hasPermission(user, PERMISSIONS.TASKS_VIEW_COMPANY)) {
      throw new TaskRequestError(403, 'TASK_SCOPE_FORBIDDEN', 'لا تملك صلاحية عرض مهام الشركة');
    }
    return { kind: selected, employeeId: user.employeeId, departmentIds: [] };
  }
  if (selected === 'department') {
    if (!hasPermission(user, PERMISSIONS.TASKS_VIEW_DEPARTMENT)) {
      throw new TaskRequestError(403, 'TASK_SCOPE_FORBIDDEN', 'لا تملك صلاحية عرض مهام القسم');
    }
    return {
      kind: selected,
      employeeId: user.employeeId,
      departmentIds: await managedDepartmentIds(prisma, user),
    };
  }
  if (!user.employeeId || !hasPermission(user, PERMISSIONS.TASKS_VIEW_OWN)) {
    throw new TaskRequestError(403, 'TASK_SCOPE_FORBIDDEN', 'لا تملك صلاحية عرض المهام الشخصية');
  }
  return { kind: selected, employeeId: user.employeeId, departmentIds: [] };
};

const visibleAssignments = (
  task: any,
  scope: ScopeContext,
  user: TaskUser,
  primaryOwnerUserId: string | null,
): any[] => {
  const assignments = task.assignments ?? [];
  const scoped = scope.kind === 'company'
    ? assignments
    : scope.kind === 'department'
      ? assignments.filter((assignment: any) =>
      assignment.employee.departmentId && scope.departmentIds.includes(assignment.employee.departmentId)
      )
      : assignments.filter((assignment: any) => assignment.employeeId === scope.employeeId);
  const mayViewOwner = isAdmin(user) || user.permissions.includes(PERMISSIONS.HR_VIEW);
  return mayViewOwner
    ? scoped
    : scoped.filter((assignment: any) =>
      !isOwnerEmployee(assignment.employee, primaryOwnerUserId)
    );
};

const assignmentScope = async (prisma: PrismaClient, user: TaskUser): Promise<ScopeContext> => {
  if (hasPermission(user, PERMISSIONS.TASKS_ASSIGN_COMPANY)) {
    return { kind: 'company', employeeId: user.employeeId, departmentIds: [] };
  }
  if (hasPermission(user, PERMISSIONS.TASKS_ASSIGN_DEPARTMENT)) {
    return {
      kind: 'department',
      employeeId: user.employeeId,
      departmentIds: await managedDepartmentIds(prisma, user),
    };
  }
  throw new TaskRequestError(403, 'TASK_ASSIGN_FORBIDDEN', 'لا تملك صلاحية إسناد المهام');
};

const ensureAssignmentScope = (
  employees: any[],
  scope: ScopeContext,
  primaryOwnerUserId: string | null,
): void => {
  if (employees.some((employee) => !employee.user)) {
    throw new TaskRequestError(400, 'TASK_EMPLOYEE_ACCOUNT_REQUIRED', 'أحد الموظفين المحددين لا يملك حساباً فعالاً');
  }
  if (employees.some((employee) => isOwnerEmployee(employee, primaryOwnerUserId))) {
    throw new TaskRequestError(403, 'TASK_OWNER_ASSIGNMENT_FORBIDDEN', 'لا يمكن إسناد المهام إلى حساب المدير العام');
  }
  if (
    scope.kind === 'department' &&
    employees.some((employee) => !employee.departmentId || !scope.departmentIds.includes(employee.departmentId))
  ) {
    throw new TaskRequestError(403, 'TASK_EMPLOYEE_OUT_OF_SCOPE', 'أحد الموظفين المحددين خارج نطاق أقسامك');
  }
};

const canReviewAssignment = async (
  prisma: PrismaClient,
  user: TaskUser,
  assignment: any
): Promise<boolean> => {
  if (isAdmin(user) || user.permissions.includes(PERMISSIONS.TASKS_VIEW_COMPANY)) return true;
  if (!user.permissions.includes(PERMISSIONS.TASKS_VIEW_DEPARTMENT)) return false;
  const departments = await managedDepartmentIds(prisma, user);
  return !!assignment.employee.departmentId && departments.includes(assignment.employee.departmentId);
};

/**
 * Every task notification carries the `task` category and the already-allowlisted
 * `task.detail` deep link. Before P4 these were written bare, so they arrived as
 * uncategorised "general" rows that no client could route and no preference could
 * silence. Only the task id travels — never the title, description or any
 * completion/review free text.
 */
const notifyTask = async (
  client: any,
  companyId: string,
  userIds: Array<string | null | undefined>,
  taskId: string,
  title: string,
  message: string
): Promise<void> => {
  await createDomainNotifications(client, {
    companyId,
    userIds: userIds.filter((id): id is string => !!id),
    title,
    message,
    category: 'task',
    descriptor: { routeKey: 'task.detail', resourceType: 'task', resourceId: taskId },
  });
};

const notifySubmissionReviewers = async (client: any, assignment: any, actorUserId: string) => {
  const recipientIds = new Set<string>();
  recipientIds.add(assignment.task.createdByUserId);
  if (assignment.employee.department?.managerId) {
    recipientIds.add(assignment.employee.department.managerId);
  }
  if (assignment.employee.department?.id && client.departmentManager?.findMany) {
    const managerRows = await client.departmentManager.findMany({
      where: {
        companyId: assignment.companyId,
        departmentId: assignment.employee.department.id,
        status: 'active',
      },
      select: { userId: true },
    });
    for (const manager of managerRows) recipientIds.add(manager.userId);
  }
  const companyReviewers = await client.user.findMany({
    where: { companyId: assignment.companyId },
    select: { id: true, role: { select: { permissions: true } } },
  });
  for (const reviewer of companyReviewers) {
    const permissions = parsePermissions(reviewer.role?.permissions);
    if (
      permissions.includes(PERMISSIONS.ADMIN_FULL) ||
      (permissions.includes(PERMISSIONS.TASKS_REVIEW) && permissions.includes(PERMISSIONS.TASKS_VIEW_COMPANY))
    ) {
      recipientIds.add(reviewer.id);
    }
  }
  recipientIds.delete(actorUserId);
  await notifyTask(
    client,
    assignment.companyId,
    [...recipientIds],
    assignment.taskId,
    'مهمة بانتظار المراجعة',
    'تم تسليم مهمة وأصبحت جاهزة للمراجعة.'
  );
};

const taskStatuses = new Set(['active', 'completed', 'cancelled']);

export async function loadScopedTasks(
  prisma: PrismaClient,
  user: TaskUser,
  query: TaskListFilters
): Promise<any[]> {
  const scope = await resolveViewScope(prisma, user, query.scope);
  const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, user.companyId);
  if (scope.kind === 'own' && query.employeeId && query.employeeId !== scope.employeeId) {
    throw new TaskRequestError(
      403,
      'TASK_EMPLOYEE_FILTER_FORBIDDEN',
      'لا يمكنك عرض مهام موظف آخر'
    );
  }
  const tasks = await prisma.task.findMany({
    where: { companyId: user.companyId },
    include: taskInclude,
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
  });
  return tasks.flatMap((task) => {
    const assignments = visibleAssignments(task, scope, user, primaryOwnerUserId);
    if (assignments.length === 0) return [];
    if (
      query.employeeId &&
      !assignments.some((assignment) => assignment.employeeId === query.employeeId)
    ) {
      return [];
    }
    if (query.priority && task.priority !== query.priority) return [];
    if (query.status) {
      if (taskStatuses.has(query.status) && task.status !== query.status) return [];
      if (
        !taskStatuses.has(query.status) &&
        !assignments.some((assignment) => assignment.status === query.status)
      ) {
        return [];
      }
    }
    const dueDate = dateOnly(task.dueDate);
    if (query.from && (!dueDate || dueDate < query.from)) return [];
    if (query.to && (!dueDate || dueDate > query.to)) return [];
    return [taskShape(task, assignments)];
  });
}

/**
 * Single authority for "may this actor see this task at all".
 *
 * Comments, attachments and the timeline all route through here so a
 * collaboration surface can never be broader than the task it hangs off — the
 * exact security invariant Wave 3 calls out. An out-of-scope task is reported as
 * 404, not 403, so task existence is never signalled across departments.
 */
export const loadVisibleTask = async (
  prisma: PrismaClient,
  user: TaskUser,
  taskId: string
): Promise<{ task: any; assignments: any[] }> => {
  const task = await prisma.task.findFirst({
    where: { id: taskId, companyId: user.companyId },
    include: taskInclude,
  });
  if (!task) throw new TaskRequestError(404, 'TASK_NOT_FOUND', 'المهمة غير موجودة');
  const scope = await resolveViewScope(prisma, user);
  const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, user.companyId);
  const assignments = visibleAssignments(task, scope, user, primaryOwnerUserId);
  if (assignments.length === 0) {
    throw new TaskRequestError(404, 'TASK_NOT_FOUND', 'المهمة غير موجودة');
  }
  return { task, assignments };
};

/** Everyone already entitled to see the task: its creator plus its assignees. */
const taskParticipantUserIds = (task: any): string[] => [
  task.createdByUserId,
  ...(task.assignments ?? []).map((assignment: any) => assignment.employee?.user?.id),
].filter((id): id is string => !!id);

const commentShape = (comment: any) => ({
  id: comment.id,
  taskId: comment.taskId,
  body: comment.body,
  author: {
    id: comment.author?.id ?? comment.authorUserId,
    name: comment.author?.name ?? 'مستخدم',
  },
  createdAt: timestamp(comment.createdAt),
});

/** Keyset cursor over (createdAt, id) — same shape the notification inbox uses. */
const encodeCommentCursor = (createdAt: Date | string, id: string): string =>
  Buffer.from(`${new Date(createdAt).toISOString()}|${id}`, 'utf8').toString('base64url');

const decodeCommentCursor = (cursor: string): { createdAt: Date; id: string } => {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');
  const createdAt = separator > 0 ? new Date(decoded.slice(0, separator)) : new Date(Number.NaN);
  const id = separator > 0 ? decoded.slice(separator + 1) : '';
  if (!id || Number.isNaN(createdAt.getTime())) {
    throw new TaskRequestError(400, 'TASK_COMMENT_CURSOR_INVALID', 'مؤشر الصفحة غير صالح');
  }
  return { createdAt, id };
};

export function registerTaskRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
}: TaskRouteDeps): void {
  app.get(
    '/api/tasks/eligible-employees',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TASKS_ASSIGN_COMPANY, PERMISSIONS.TASKS_ASSIGN_DEPARTMENT),
    async (req: TaskRequest, res) => {
      try {
        const scope = await assignmentScope(prisma, req.user!);
        const employees = await prisma.employee.findMany({
          where: {
            companyId: req.user!.companyId,
            status: 'active',
            ...(scope.kind === 'department'
              ? { departmentId: { in: scope.departmentIds } }
              : {}),
          },
          include: {
            user: { select: { id: true, name: true, role: { select: { permissions: true } } } },
            department: { select: { id: true, name: true } },
          },
          orderBy: [{ department: { name: 'asc' } }, { employeeNum: 'asc' }],
        });
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        return res.json(
          employees
            .filter((employee) =>
              employee.user && !isOwnerEmployee(employee, primaryOwnerUserId)
            )
            .map(employeeShape)
        );
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/tasks',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TASKS_CREATE),
    async (req: TaskRequest, res) => {
      const body = validateBody(createTaskSchema, req, res);
      if (!body) return;
      try {
        const scope = await assignmentScope(prisma, req.user!);
        const employees = await prisma.employee.findMany({
          where: {
            companyId: req.user!.companyId,
            status: 'active',
            id: { in: body.employeeIds },
          },
          include: {
            user: { select: { id: true, name: true, role: { select: { permissions: true } } } },
            department: { select: { id: true, name: true } },
          },
        });
        if (employees.length !== body.employeeIds.length) {
          throw new TaskRequestError(400, 'TASK_EMPLOYEE_INVALID', 'أحد الموظفين المحددين غير صالح أو غير فعال');
        }
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        ensureAssignmentScope(employees, scope, primaryOwnerUserId);

        const taskId = await prisma.$transaction(async (tx) => {
          const task = await tx.task.create({
            data: {
              companyId: req.user!.companyId,
              title: body.title,
              description: body.description || null,
              priority: body.priority,
              dueDate: body.dueDate ? new Date(`${body.dueDate}T00:00:00.000Z`) : null,
              createdByUserId: req.user!.id,
              status: 'active',
            },
          });
          await tx.taskAssignment.createMany({
            data: employees.map((employee) => ({
              companyId: req.user!.companyId,
              taskId: task.id,
              employeeId: employee.id,
              status: 'assigned',
            })),
          });
          await notifyTask(
            tx,
            req.user!.companyId,
            employees.map((employee) => employee.user!.id),
            task.id,
            'مهمة جديدة',
            'تم إسناد مهمة جديدة إليك.'
          );
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'task.create',
            details: { taskId: task.id, assignmentCount: employees.length },
          });
          return task.id;
        });

        const task = await prisma.task.findFirst({
          where: { id: taskId, companyId: req.user!.companyId },
          include: taskInclude,
        });
        if (!task) throw new TaskRequestError(500, 'TASK_CREATE_READBACK_FAILED', 'تم إنشاء المهمة وتعذّر تحميلها');
        return res.status(201).json(taskShape(task));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.get(
    '/api/tasks',
    requireAuth,
    checkAnyPermission(
      PERMISSIONS.TASKS_VIEW_OWN,
      PERMISSIONS.TASKS_VIEW_DEPARTMENT,
      PERMISSIONS.TASKS_VIEW_COMPANY
    ),
    async (req: TaskRequest, res) => {
      const query = validateQuery(taskListQuerySchema, req, res);
      if (!query) return;
      try {
        return res.json(await loadScopedTasks(prisma, req.user!, query));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.get(
    '/api/tasks/:id',
    requireAuth,
    checkAnyPermission(
      PERMISSIONS.TASKS_VIEW_OWN,
      PERMISSIONS.TASKS_VIEW_DEPARTMENT,
      PERMISSIONS.TASKS_VIEW_COMPANY
    ),
    async (req: TaskRequest, res) => {
      try {
        const task = await prisma.task.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
          include: taskInclude,
        });
        if (!task) throw new TaskRequestError(404, 'TASK_NOT_FOUND', 'المهمة غير موجودة');
        const scope = await resolveViewScope(prisma, req.user!);
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        const assignments = visibleAssignments(task, scope, req.user!, primaryOwnerUserId);
        if (assignments.length === 0) throw new TaskRequestError(404, 'TASK_NOT_FOUND', 'المهمة غير موجودة');
        return res.json(taskShape(task, assignments));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.patch(
    '/api/task-assignments/:id/progress',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TASKS_VIEW_OWN),
    async (req: TaskRequest, res) => {
      const body = validateBody(taskProgressSchema, req, res);
      if (!body) return;
      try {
        const updated = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "TaskAssignment"
            WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId}
            FOR UPDATE
          `;
          const assignment = await tx.taskAssignment.findFirst({
            where: { id: req.params.id, companyId: req.user!.companyId },
            include: assignmentInclude,
          });
          if (!assignment || assignment.employeeId !== req.user!.employeeId) {
            throw new TaskRequestError(404, 'TASK_ASSIGNMENT_NOT_FOUND', 'إسناد المهمة غير موجود');
          }
          if (assignment.task.status !== 'active') {
            throw new TaskRequestError(409, 'TASK_NOT_ACTIVE', 'المهمة لم تعد نشطة');
          }
          const allowed: Record<string, string[]> = {
            assigned: ['in_progress', 'submitted'],
            in_progress: ['submitted'],
            returned: ['in_progress', 'submitted'],
          };
          if (!allowed[assignment.status]?.includes(body.status)) {
            throw new TaskRequestError(409, 'TASK_PROGRESS_INVALID', 'لا يمكن تنفيذ هذا الانتقال في حالة المهمة الحالية');
          }
          const data = body.status === 'submitted'
            ? {
                status: body.status,
                completionDetails: body.completionDetails,
                submittedAt: new Date(),
                reviewedByUserId: null,
                reviewedAt: null,
                reviewNote: null,
              }
            : { status: body.status };
          const result = await tx.taskAssignment.update({
            where: { id: assignment.id },
            data,
            include: assignmentInclude,
          });
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'task.assignment.progress',
            details: { taskId: assignment.taskId, assignmentId: assignment.id, status: body.status },
          });
          if (body.status === 'submitted') {
            await notifySubmissionReviewers(tx, result, req.user!.id);
          }
          return result;
        });
        return res.json(assignmentShape(updated));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/task-assignments/:id/review',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TASKS_REVIEW),
    async (req: TaskRequest, res) => {
      const body = validateBody(taskReviewSchema, req, res);
      if (!body) return;
      try {
        const result = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "TaskAssignment"
            WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId}
            FOR UPDATE
          `;
          const assignment = await tx.taskAssignment.findFirst({
            where: { id: req.params.id, companyId: req.user!.companyId },
            include: assignmentInclude,
          });
          if (!assignment) throw new TaskRequestError(404, 'TASK_ASSIGNMENT_NOT_FOUND', 'إسناد المهمة غير موجود');
          if (assignment.employeeId === req.user!.employeeId) {
            throw new TaskRequestError(403, 'TASK_SELF_REVIEW_FORBIDDEN', 'لا يمكنك مراجعة المهمة المسندة إليك');
          }
          if (!await canReviewAssignment(prisma, req.user!, assignment)) {
            throw new TaskRequestError(404, 'TASK_ASSIGNMENT_NOT_FOUND', 'إسناد المهمة غير موجود');
          }
          if (assignment.task.status !== 'active' || assignment.status !== 'submitted') {
            throw new TaskRequestError(409, 'TASK_REVIEW_INVALID', 'يمكن مراجعة المهام المسلّمة والنشطة فقط');
          }
          const nextStatus = body.action === 'accept' ? 'accepted' : 'returned';
          const reviewed = await tx.taskAssignment.update({
            where: { id: assignment.id },
            data: {
              status: nextStatus,
              reviewedByUserId: req.user!.id,
              reviewedAt: new Date(),
              reviewNote: body.reviewNote || null,
            },
            include: assignmentInclude,
          });
          let taskStatus = assignment.task.status;
          if (nextStatus === 'accepted') {
            const remaining = await tx.taskAssignment.count({
              where: { taskId: assignment.taskId, status: { not: 'accepted' } },
            });
            if (remaining === 0) {
              const completed = await tx.task.update({
                where: { id: assignment.taskId },
                data: { status: 'completed' },
              });
              taskStatus = completed.status;
            }
          }
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: body.action === 'accept' ? 'task.assignment.accept' : 'task.assignment.return',
            details: { taskId: assignment.taskId, assignmentId: assignment.id },
          });
          await notifyTask(
            tx,
            req.user!.companyId,
            [assignment.employee.user?.id],
            assignment.taskId,
            body.action === 'accept' ? 'تم قبول المهمة' : 'تمت إعادة المهمة',
            body.action === 'accept'
              ? 'تم قبول إنجاز المهمة.'
              : 'أعيدت المهمة لاستكمال المطلوب.'
          );
          return { assignment: reviewed, taskStatus };
        });
        return res.json({ assignment: assignmentShape(result.assignment), taskStatus: result.taskStatus });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/tasks/:id/cancel',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TASKS_CREATE, PERMISSIONS.TASKS_REVIEW),
    async (req: TaskRequest, res) => {
      try {
        const cancelled = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "Task"
            WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId}
            FOR UPDATE
          `;
          const task = await tx.task.findFirst({
            where: { id: req.params.id, companyId: req.user!.companyId },
            include: taskInclude,
          });
          if (!task) throw new TaskRequestError(404, 'TASK_NOT_FOUND', 'المهمة غير موجودة');
          if (task.status !== 'active') {
            throw new TaskRequestError(409, 'TASK_CANCEL_INVALID', 'يمكن إلغاء المهام النشطة فقط');
          }

          let inScope = isAdmin(req.user!) || req.user!.permissions.includes(PERMISSIONS.TASKS_VIEW_COMPANY);
          if (!inScope && req.user!.permissions.includes(PERMISSIONS.TASKS_VIEW_DEPARTMENT)) {
            const departments = await managedDepartmentIds(prisma, req.user!);
            inScope = task.assignments.every((assignment) =>
              assignment.employee.departmentId && departments.includes(assignment.employee.departmentId)
            );
          }
          const isCreator = task.createdByUserId === req.user!.id;
          const mayCancel = inScope && (
            isAdmin(req.user!) ||
            req.user!.permissions.includes(PERMISSIONS.TASKS_REVIEW) ||
            (isCreator && req.user!.permissions.includes(PERMISSIONS.TASKS_CREATE))
          );
          if (!mayCancel) throw new TaskRequestError(404, 'TASK_NOT_FOUND', 'المهمة غير موجودة');

          const updated = await tx.task.update({
            where: { id: task.id },
            data: { status: 'cancelled' },
          });
          await notifyTask(
            tx,
            req.user!.companyId,
            task.assignments.map((assignment) => assignment.employee.user?.id),
            task.id,
            'تم إلغاء المهمة',
            'تم إلغاء مهمة كانت مسندة إليك.'
          );
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'task.cancel',
            details: { taskId: task.id, assignmentCount: task.assignments.length },
          });
          return { ...task, ...updated };
        });
        return res.json(taskShape(cancelled));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  /**
   * P4 — edit an active task's own attributes.
   *
   * Deliberately cannot change `status` or assignments: those already have their
   * own audited transitions (`/cancel`, `/review`, `/progress`) and routing them
   * through a generic PATCH would let one permission bypass three others. The
   * strict Zod schema rejects such keys outright rather than ignoring them.
   *
   * Concurrency: the row is locked FOR UPDATE and the caller must echo the
   * `updatedAt` it read. Two racing editors therefore serialize on the lock and
   * the loser gets a 409 instead of silently clobbering the winner's fields.
   */
  app.patch(
    '/api/tasks/:id',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TASKS_EDIT),
    async (req: TaskRequest, res) => {
      const body = validateBody(updateTaskSchema, req, res);
      if (!body) return;
      try {
        const updated = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "Task"
            WHERE "id" = ${req.params.id} AND "companyId" = ${req.user!.companyId}
            FOR UPDATE
          `;
          const task = await tx.task.findFirst({
            where: { id: req.params.id, companyId: req.user!.companyId },
            include: taskInclude,
          });
          if (!task) throw new TaskRequestError(404, 'TASK_NOT_FOUND', 'المهمة غير موجودة');

          // Same scope/actor rule as cancel: in-scope, and either an admin, a
          // reviewer, or the creator.
          let inScope = isAdmin(req.user!) || req.user!.permissions.includes(PERMISSIONS.TASKS_VIEW_COMPANY);
          if (!inScope && req.user!.permissions.includes(PERMISSIONS.TASKS_VIEW_DEPARTMENT)) {
            const departments = await managedDepartmentIds(prisma, req.user!);
            inScope = task.assignments.every((assignment) =>
              assignment.employee.departmentId && departments.includes(assignment.employee.departmentId)
            );
          }
          const isCreator = task.createdByUserId === req.user!.id;
          const mayEdit = inScope && (
            isAdmin(req.user!) ||
            req.user!.permissions.includes(PERMISSIONS.TASKS_REVIEW) ||
            isCreator
          );
          if (!mayEdit) throw new TaskRequestError(404, 'TASK_NOT_FOUND', 'المهمة غير موجودة');

          if (task.status !== 'active') {
            throw new TaskRequestError(409, 'TASK_EDIT_INVALID', 'يمكن تعديل المهام النشطة فقط');
          }
          if (new Date(task.updatedAt).getTime() !== new Date(body.expectedUpdatedAt).getTime()) {
            throw new TaskRequestError(
              409,
              'TASK_EDIT_CONFLICT',
              'تم تعديل المهمة من مستخدم آخر. أعد تحميل المهمة ثم حاول مجدداً'
            );
          }

          const data: Record<string, unknown> = {};
          const changedFields: string[] = [];
          if (body.title !== undefined && body.title !== task.title) {
            data.title = body.title;
            changedFields.push('title');
          }
          if (body.description !== undefined) {
            const next = body.description || null;
            if (next !== (task.description ?? null)) {
              data.description = next;
              changedFields.push('description');
            }
          }
          if (body.priority !== undefined && body.priority !== task.priority) {
            data.priority = body.priority;
            changedFields.push('priority');
          }
          if (body.dueDate !== undefined) {
            const next = body.dueDate ? new Date(`${body.dueDate}T00:00:00.000Z`) : null;
            if (dateOnly(next) !== dateOnly(task.dueDate)) {
              data.dueDate = next;
              changedFields.push('dueDate');
            }
          }
          if (changedFields.length === 0) {
            throw new TaskRequestError(409, 'TASK_EDIT_NO_CHANGE', 'لا يوجد تغيير فعلي على المهمة');
          }

          const result = await tx.task.update({
            where: { id: task.id },
            data,
            include: taskInclude,
          });
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'task.edit',
            // `changedFields` is on the audit allow-list; the new values are not
            // (title/description are forbidden audit keys by design).
            details: { taskId: task.id, changedFields },
          });
          // Only a due-date or priority move is actionable for an assignee; a
          // wording fix is not, and notifying on it would be a storm.
          if (changedFields.includes('dueDate') || changedFields.includes('priority')) {
            await notifyTask(
              tx,
              req.user!.companyId,
              task.assignments
                .map((assignment) => assignment.employee.user?.id)
                .filter((id) => id !== req.user!.id),
              task.id,
              'تم تحديث مهمة',
              'تم تعديل موعد أو أولوية مهمة مسندة إليك.'
            );
          }
          return result;
        });
        return res.json(taskShape(updated));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  /**
   * P4 — task discussion thread.
   *
   * Reading needs no new permission: it reuses the task's own view scope through
   * `loadVisibleTask`, so a comment is never readable by anyone who could not
   * already open the task. Writing additionally needs `tasks.comment.create`.
   */
  app.get(
    '/api/tasks/:id/comments',
    requireAuth,
    checkAnyPermission(
      PERMISSIONS.TASKS_VIEW_OWN,
      PERMISSIONS.TASKS_VIEW_DEPARTMENT,
      PERMISSIONS.TASKS_VIEW_COMPANY
    ),
    async (req: TaskRequest, res) => {
      const query = validateQuery(taskCommentListQuerySchema, req, res);
      if (!query) return;
      try {
        const { task } = await loadVisibleTask(prisma, req.user!, req.params.id);
        const limit = query.limit ?? 50;
        const where: Record<string, unknown> = {
          companyId: req.user!.companyId,
          taskId: task.id,
        };
        if (query.cursor) {
          const cursor = decodeCommentCursor(query.cursor);
          where.OR = [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ];
        }
        const rows = await prisma.taskComment.findMany({
          where,
          include: { author: { select: { id: true, name: true } } },
          // Newest first with a cursor for older pages, matching the notification
          // inbox. Clients render the page reversed.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
        });
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];
        return res.json({
          items: page.map(commentShape),
          nextCursor: hasMore && last ? encodeCommentCursor(last.createdAt, last.id) : null,
          hasMore,
        });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/tasks/:id/comments',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TASKS_COMMENT_CREATE),
    async (req: TaskRequest, res) => {
      const body = validateBody(taskCommentCreateSchema, req, res);
      if (!body) return;
      try {
        const created = await prisma.$transaction(async (tx) => {
          const { task } = await loadVisibleTask(tx as unknown as PrismaClient, req.user!, req.params.id);
          // Terminal tasks are immutable, matching training/purchasing.
          if (task.status !== 'active') {
            throw new TaskRequestError(409, 'TASK_COMMENT_INVALID', 'يمكن التعليق على المهام النشطة فقط');
          }
          const comment = await tx.taskComment.create({
            data: {
              companyId: req.user!.companyId,
              taskId: task.id,
              authorUserId: req.user!.id,
              body: body.body,
            },
            include: { author: { select: { id: true, name: true } } },
          });
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'task.comment.create',
            // `bodyLength` is explicitly allow-listed operational metadata;
            // the comment text itself must never reach the audit log.
            details: { taskId: task.id, commentId: comment.id, bodyLength: body.body.length },
          });
          await notifyTask(
            tx,
            req.user!.companyId,
            taskParticipantUserIds(task).filter((id) => id !== req.user!.id),
            task.id,
            'تعليق جديد على مهمة',
            'تمت إضافة تعليق جديد على مهمة تخصك.'
          );
          return comment;
        });
        return res.status(201).json(commentShape(created));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.delete('/api/tasks/:id', requireAuth, (_req, res) => {
    return res.status(405).json({
      error: 'TaskDeleteNotAllowed',
      message: 'حذف المهام غير مسموح. استخدم إلغاء المهمة للحفاظ على السجل.',
      code: 405,
    });
  });
}
