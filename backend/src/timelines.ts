import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import {
  loadManagedDepartmentIds,
  loadPrimaryOwnerUserId,
  parseRolePermissions,
} from './authorization';
import { sanitizeAuditDetails } from './audit';
import { PERMISSIONS } from './permissions';
import { loadVisibleTask, TaskRequestError } from './tasks';

/**
 * Sprint 12L timeline adapters (read-only, no new migration).
 *
 * Every timeline is a presentation over existing domain history: chronological,
 * safe actor snapshot (name/role only), state transition, timestamp, and the
 * authorized reason — never raw AuditLog JSON. Out-of-scope targets return an
 * opaque 404 so existence is not signalled.
 */

export interface TimelineEvent {
  at: string;
  type: string;
  summary: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorName: string | null;
  actorRole: string | null;
  reason: string | null;
  override: boolean;
}

interface TimelineUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface TimelineRequest extends Request {
  user?: TimelineUser;
}

export interface TimelineRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
}

const has = (user: TimelineUser, permission: string): boolean =>
  user.permissions.includes(PERMISSIONS.ADMIN_FULL) || user.permissions.includes(permission);

const hasExact = (user: TimelineUser, permission: string): boolean =>
  user.permissions.includes(permission);

const isProtectedUser = (
  candidate: { id?: string | null; role?: { permissions?: string | null } | null } | null | undefined,
  primaryOwnerUserId: string | null,
): boolean =>
  candidate?.id === primaryOwnerUserId ||
  parseRolePermissions(candidate?.role?.permissions).includes(PERMISSIONS.ADMIN_FULL);

const canViewProtectedUser = (
  user: TimelineUser,
  primaryOwnerUserId: string | null,
): boolean =>
  hasExact(user, PERMISSIONS.ADMIN_FULL) ||
  hasExact(user, PERMISSIONS.HR_VIEW) ||
  primaryOwnerUserId === user.id;

const opaqueNotFound = (res: Response): Response => {
  res.locals.opaquePrivacy = true;
  return res.status(404).json({ error: 'NotFound', code: 404, message: 'timeline.not_found' });
};

const event = (
  at: Date | string | null | undefined,
  type: string,
  summary: string,
  extra: Partial<Omit<TimelineEvent, 'at' | 'type' | 'summary'>> = {},
): TimelineEvent | null => {
  if (at == null) return null;
  return {
    at: new Date(at).toISOString(),
    type,
    summary,
    fromStatus: extra.fromStatus ?? null,
    toStatus: extra.toStatus ?? null,
    actorName: extra.actorName ?? null,
    actorRole: extra.actorRole ?? null,
    reason: extra.reason ?? null,
    override: extra.override ?? false,
  };
};

const finalize = (events: Array<TimelineEvent | null>): TimelineEvent[] =>
  (events.filter(Boolean) as TimelineEvent[])
    .sort((left, right) => left.at.localeCompare(right.at) || left.type.localeCompare(right.type));

const managedDepartments = (prisma: PrismaClient, user: TimelineUser): Promise<string[]> =>
  loadManagedDepartmentIds(prisma, { companyId: user.companyId, userId: user.id });

const auditDetails = (row: { details?: unknown }): Record<string, unknown> =>
  sanitizeAuditDetails(row.details);

const auditActor = (row: any): Pick<TimelineEvent, 'actorName' | 'actorRole'> => ({
  actorName: row.user?.name ?? null,
  actorRole: row.user?.role?.name ?? null,
});

export function registerTimelineRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
}: TimelineRouteDeps): void {
  app.get(
    '/api/v2/leaves/:id/timeline',
    requireAuth,
    checkAnyPermission(
      PERMISSIONS.LEAVES_VIEW_OWN,
      PERMISSIONS.LEAVES_VIEW,
      PERMISSIONS.LEAVES_REVIEW,
      PERMISSIONS.LEAVES_APPROVE,
    ),
    async (req: TimelineRequest, res: Response) => {
      const user = req.user!;
      try {
        const leave = await prisma.leaveRequest.findFirst({
          where: { id: req.params.id, companyId: user.companyId },
          include: {
            employee: {
              select: {
                id: true,
                user: {
                  select: {
                    id: true,
                    name: true,
                    role: { select: { permissions: true } },
                  },
                },
              },
            },
            submittedBy: { select: { name: true } },
            approvalHistory: {
              orderBy: { createdAt: 'asc' },
              include: { actionByUser: { select: { name: true } } },
            },
          },
        });
        if (!leave) return opaqueNotFound(res);

        const reviewer =
          has(user, PERMISSIONS.LEAVES_VIEW) ||
          has(user, PERMISSIONS.LEAVES_REVIEW) ||
          has(user, PERMISSIONS.LEAVES_APPROVE);
        const ownLeave = user.employeeId !== null && leave.employeeId === user.employeeId;
        if (!reviewer && !ownLeave) return opaqueNotFound(res);
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, user.companyId);
        if (
          !ownLeave &&
          isProtectedUser(leave.employee?.user, primaryOwnerUserId) &&
          !canViewProtectedUser(user, primaryOwnerUserId)
        ) {
          return opaqueNotFound(res);
        }

        const events = finalize([
          event(leave.createdAt, 'leave.submitted', 'Leave request submitted', {
            toStatus: 'pending_hr',
            actorName: leave.submissionMode === 'on_behalf'
              ? leave.submittedBy?.name ?? null
              : leave.employee?.user?.name ?? null,
            reason: leave.submissionMode === 'on_behalf' ? leave.submissionReason ?? null : null,
          }),
          ...(leave.approvalHistory ?? []).map((row: any) =>
            event(row.createdAt, `leave.${row.action}`, `Leave ${row.action.replace(/_/g, ' ')}`, {
              fromStatus: row.fromStatus ?? null,
              toStatus: row.toStatus ?? null,
              actorName: row.actionByUser?.name ?? null,
              actorRole: row.actorRoleSnapshot ?? null,
              reason: row.reason ?? null,
              override: Boolean(row.isOverride),
            })),
        ]);
        return res.json({ entityType: 'leave', entityId: leave.id, events });
      } catch {
        return res.status(500).json({ error: 'TimelineFailed', code: 500, message: 'timeline.failed' });
      }
    },
  );

  app.get(
    '/api/v2/purchasing/requests/:id/timeline',
    requireAuth,
    checkAnyPermission(
      PERMISSIONS.PURCHASING_VIEW_OWN,
      PERMISSIONS.PURCHASING_VIEW_DEPARTMENT,
      PERMISSIONS.PURCHASING_VIEW,
    ),
    async (req: TimelineRequest, res: Response) => {
      const user = req.user!;
      try {
        const request = await prisma.purchaseRequest.findFirst({
          where: { id: req.params.id, companyId: user.companyId },
          include: {
            requester: {
              select: {
                user: {
                  select: {
                    id: true,
                    role: { select: { permissions: true } },
                  },
                },
              },
            },
            departmentReviewer: { select: { name: true } },
            purchasingReviewer: { select: { name: true } },
            cancelledBy: { select: { name: true } },
          },
        });
        if (!request) return opaqueNotFound(res);

        if (!has(user, PERMISSIONS.PURCHASING_VIEW)) {
          if (hasExact(user, PERMISSIONS.PURCHASING_VIEW_DEPARTMENT)) {
            const managed = await managedDepartments(prisma, user);
            if (!request.departmentId || !managed.includes(request.departmentId)) {
              return opaqueNotFound(res);
            }
          } else if (
            !user.employeeId ||
            request.requestedByEmployeeId !== user.employeeId
          ) {
            return opaqueNotFound(res);
          }
        }

        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, user.companyId);
        const ownRequest =
          user.employeeId !== null && request.requestedByEmployeeId === user.employeeId;
        if (
          !ownRequest &&
          isProtectedUser(request.requester?.user, primaryOwnerUserId) &&
          !hasExact(user, PERMISSIONS.ADMIN_FULL)
        ) {
          return opaqueNotFound(res);
        }

        const [workflowEvents, creationAuditRows] = await Promise.all([
          prisma.purchaseWorkflowEvent.findMany({
            where: {
              companyId: user.companyId,
              entityType: 'purchase_request',
              entityId: request.id,
            },
            orderBy: { createdAt: 'asc' },
            include: { actor: { select: { name: true } } },
          }),
          prisma.auditLog.findMany({
            where: {
              companyId: user.companyId,
              action: 'purchasing.request.create',
              details: { contains: request.id },
            },
            orderBy: { createdAt: 'asc' },
            include: { user: { select: { name: true, role: { select: { name: true } } } } },
          }),
        ]);
        const creationAudit = creationAuditRows.find((row: any) =>
          auditDetails(row).requestId === request.id);
        const initialStatus = (() => {
          const status = creationAudit ? auditDetails(creationAudit).status : null;
          if (status === 'pending_department' || status === 'pending_purchasing') return status;
          if (request.departmentReviewedAt != null || request.status === 'pending_department') {
            return 'pending_department';
          }
          return 'pending_purchasing';
        })();

        const events = finalize([
          event(request.createdAt, 'purchase_request.created', 'Purchase request created', {
            toStatus: initialStatus,
            actorName: request.requesterNameSnapshot,
            actorRole: creationAudit?.user?.role?.name ?? null,
          }),
          event(request.departmentReviewedAt, 'purchase_request.department_reviewed', 'Department review recorded', {
            actorName: request.departmentReviewer?.name ?? null,
            reason: request.departmentReviewNote ?? null,
          }),
          event(request.purchasingReviewedAt, 'purchase_request.purchasing_reviewed', 'Purchasing review recorded', {
            actorName: request.purchasingReviewer?.name ?? null,
            reason: request.purchasingReviewNote ?? null,
          }),
          event(request.rejectedAt, 'purchase_request.rejected', 'Purchase request rejected', {
            toStatus: 'rejected',
          }),
          event(request.cancelledAt, 'purchase_request.cancelled', 'Purchase request cancelled', {
            toStatus: 'cancelled',
            actorName: request.cancelledBy?.name ?? null,
            reason: request.cancellationReason ?? null,
          }),
          ...workflowEvents.map((row: any) =>
            event(row.createdAt, `purchase_request.${row.action}`, `Workflow ${row.action.replace(/_/g, ' ')}`, {
              fromStatus: row.previousStatus,
              toStatus: row.newStatus,
              actorName: row.actor?.name ?? null,
              reason: row.reason,
              override: true,
            })),
        ]);
        return res.json({ entityType: 'purchase_request', entityId: request.id, events });
      } catch {
        return res.status(500).json({ error: 'TimelineFailed', code: 500, message: 'timeline.failed' });
      }
    },
  );

  app.get(
    '/api/v2/employees/:id/timeline',
    requireAuth,
    checkAnyPermission(PERMISSIONS.EMPLOYEES_VIEW, PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT),
    async (req: TimelineRequest, res: Response) => {
      const user = req.user!;
      try {
        const employee = await prisma.employee.findFirst({
          where: { id: req.params.id, companyId: user.companyId },
          select: {
            id: true,
            departmentId: true,
            status: true,
            joiningDate: true,
            createdAt: true,
            archivedAt: true,
            archiveReason: true,
            archivedBy: { select: { name: true } },
            user: { select: { id: true, role: { select: { permissions: true } } } },
          },
        });
        if (!employee) return opaqueNotFound(res);

        if (!has(user, PERMISSIONS.EMPLOYEES_VIEW)) {
          const managed = await managedDepartments(prisma, user);
          if (!employee.departmentId || !managed.includes(employee.departmentId)) {
            return opaqueNotFound(res);
          }
        }

        // Owner privacy mirrors the employees list: the owner's record is only
        // visible to owner-data viewers, so its timeline follows the same rule.
        const ownership = await prisma.companyOwnership.findFirst({
          where: { companyId: user.companyId, isPrimary: true, status: 'active' },
          select: { userId: true },
        });
        const ownerRecord = isProtectedUser(employee.user, ownership?.userId ?? null);
        const requesterPrivileged =
          hasExact(user, PERMISSIONS.ADMIN_FULL) ||
          hasExact(user, PERMISSIONS.HR_VIEW) ||
          (ownership?.userId != null && ownership.userId === user.id);
        if (ownerRecord && !requesterPrivileged) return opaqueNotFound(res);

        const lifecycleAuditRows = await prisma.auditLog.findMany({
          where: {
            companyId: user.companyId,
            action: { in: ['employee.archive', 'employee.reactivate'] },
            details: { contains: employee.id },
          },
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { name: true, role: { select: { name: true } } } } },
        });
        const lifecycleEvents = lifecycleAuditRows.flatMap((row: any) => {
          const details = auditDetails(row);
          if (details.employeeId !== employee.id) return [];
          const archived = row.action === 'employee.archive';
          if (!archived && row.action !== 'employee.reactivate') return [];
          return [event(
            row.createdAt,
            archived ? 'employee.archived' : 'employee.reactivated',
            archived ? 'Employee archived' : 'Employee reactivated',
            {
              fromStatus: archived ? 'active' : 'archived',
              toStatus: archived ? 'archived' : 'active',
              ...auditActor(row),
              reason: typeof details.archiveReason === 'string' ? details.archiveReason : null,
            },
          )];
        });

        // Event-specific fields only: no salary, credential, or audit payloads.
        const events = finalize([
          event(employee.createdAt, 'employee.created', 'Employee record created'),
          event(employee.joiningDate, 'employee.joined', 'Employment start date', {
            toStatus: 'active',
          }),
          ...lifecycleEvents,
          ...(lifecycleEvents.length === 0
            ? [event(employee.archivedAt, 'employee.archived', 'Employee archived', {
              fromStatus: 'active',
              toStatus: 'archived',
              actorName: employee.archivedBy?.name ?? null,
              reason: employee.archiveReason ?? null,
            })]
            : []),
        ]);
        return res.json({ entityType: 'employee', entityId: employee.id, events });
      } catch {
        return res.status(500).json({ error: 'TimelineFailed', code: 500, message: 'timeline.failed' });
      }
    },
  );

  app.get(
    '/api/v2/training/assignments/:id/timeline',
    requireAuth,
    checkAnyPermission(
      PERMISSIONS.TRAINING_VIEW_OWN,
      PERMISSIONS.TRAINING_VIEW_DEPARTMENT,
      PERMISSIONS.TRAINING_VIEW_COMPANY,
    ),
    async (req: TimelineRequest, res: Response) => {
      const user = req.user!;
      try {
        const assignment = await prisma.trainingAssignment.findFirst({
          where: { id: req.params.id, companyId: user.companyId },
          include: {
            employee: {
              select: {
                user: {
                  select: {
                    id: true,
                    role: { select: { permissions: true } },
                  },
                },
              },
            },
            assignedBy: { select: { name: true } },
            reviewedBy: { select: { name: true } },
            cancelledBy: { select: { name: true } },
          },
        });
        if (!assignment) return opaqueNotFound(res);

        if (!has(user, PERMISSIONS.TRAINING_VIEW_COMPANY)) {
          if (hasExact(user, PERMISSIONS.TRAINING_VIEW_DEPARTMENT)) {
            const managed = await managedDepartments(prisma, user);
            if (
              !assignment.departmentIdSnapshot ||
              !managed.includes(assignment.departmentIdSnapshot)
            ) {
              return opaqueNotFound(res);
            }
          } else if (!user.employeeId || assignment.employeeId !== user.employeeId) {
            return opaqueNotFound(res);
          }
        }

        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, user.companyId);
        const ownAssignment =
          user.employeeId !== null && assignment.employeeId === user.employeeId;
        if (
          !ownAssignment &&
          isProtectedUser(assignment.employee?.user, primaryOwnerUserId) &&
          !canViewProtectedUser(user, primaryOwnerUserId)
        ) {
          return opaqueNotFound(res);
        }

        const transitionAuditRows = await prisma.auditLog.findMany({
          where: {
            companyId: user.companyId,
            action: {
              in: ['training.assignment.submit', 'training.assignment.review'],
            },
            details: { contains: assignment.id },
          },
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { name: true, role: { select: { name: true } } } } },
        });
        const transitionRows = transitionAuditRows.filter(
          (row: any) => auditDetails(row).assignmentId === assignment.id,
        );
        const lastReviewIndex = transitionRows
          .map((row: any, index: number) => ({ row, index }))
          .filter(({ row }: any) => row.action === 'training.assignment.review')
          .at(-1)?.index ?? -1;
        const immutableTransitions = transitionRows.map((row: any, index: number) => {
          const details = auditDetails(row);
          if (row.action === 'training.assignment.submit') {
            return event(row.createdAt, 'assignment.submitted', 'Training submitted for review', {
              fromStatus: null,
              toStatus: 'submitted',
              ...auditActor(row),
            });
          }
          const reviewedStatus =
            details.status === 'completed' || details.status === 'returned'
              ? details.status
              : null;
          return event(
            row.createdAt,
            reviewedStatus === 'returned' ? 'assignment.returned' : 'assignment.completed',
            reviewedStatus === 'returned' ? 'Training returned' : 'Training completed',
            {
              fromStatus: 'submitted',
              toStatus: reviewedStatus,
              ...auditActor(row),
              reason: index === lastReviewIndex ? assignment.reviewNote ?? null : null,
            },
          );
        });
        const hasSubmitAudit = transitionRows.some(
          (row: any) => row.action === 'training.assignment.submit',
        );
        const hasReviewAudit = transitionRows.some(
          (row: any) => row.action === 'training.assignment.review',
        );

        const events = finalize([
          event(assignment.assignedAt, 'assignment.assigned', 'Training assigned', {
            toStatus: 'assigned',
            actorName: assignment.assignedBy?.name ?? null,
          }),
          event(assignment.startedAt, 'assignment.started', 'Training started', {
            fromStatus: 'assigned',
            toStatus: 'in_progress',
          }),
          ...immutableTransitions,
          ...(hasSubmitAudit
            ? []
            : [event(assignment.submittedAt, 'assignment.submitted', 'Training submitted for review', {
              toStatus: 'submitted',
            })]),
          ...(hasReviewAudit
            ? []
            : [event(assignment.reviewedAt, 'assignment.reviewed', 'Training reviewed', {
              toStatus: assignment.status === 'cancelled' ? null : assignment.status,
              actorName: assignment.reviewedBy?.name ?? null,
              reason: assignment.reviewNote ?? null,
            })]),
          event(assignment.cancelledAt, 'assignment.cancelled', 'Training assignment cancelled', {
            toStatus: 'cancelled',
            actorName: assignment.cancelledBy?.name ?? null,
            reason: assignment.cancellationReason ?? null,
          }),
        ]);
        return res.json({ entityType: 'training_assignment', entityId: assignment.id, events });
      } catch {
        return res.status(500).json({ error: 'TimelineFailed', code: 500, message: 'timeline.failed' });
      }
    },
  );

  /**
   * P4 — task timeline. Closes the gap RC2's own analysis named: every other
   * long-lived entity had a timeline adapter except Task.
   *
   * Visibility reuses `loadVisibleTask`, so the timeline is exactly as reachable
   * as the task, and an out-of-scope id returns the same opaque 404 the other
   * adapters use. Assignment transitions are reconstructed from the assignment
   * rows the actor may actually see, never from every assignment on the task.
   */
  app.get(
    '/api/v2/tasks/:id/timeline',
    requireAuth,
    checkAnyPermission(
      PERMISSIONS.TASKS_VIEW_OWN,
      PERMISSIONS.TASKS_VIEW_DEPARTMENT,
      PERMISSIONS.TASKS_VIEW_COMPANY,
    ),
    async (req: TimelineRequest, res: Response) => {
      const user = req.user!;
      try {
        let visible: { task: any; assignments: any[] };
        try {
          visible = await loadVisibleTask(prisma, user, req.params.id);
        } catch (error) {
          if (error instanceof TaskRequestError) return opaqueNotFound(res);
          throw error;
        }
        const { task, assignments } = visible;

        const editAuditRows = await prisma.auditLog.findMany({
          where: {
            companyId: user.companyId,
            action: { in: ['task.edit', 'task.comment.create'] },
            details: { contains: task.id },
          },
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { name: true, role: { select: { name: true } } } } },
        });
        const taskAuditEvents = editAuditRows
          .filter((row: any) => auditDetails(row).taskId === task.id)
          .map((row: any) =>
            row.action === 'task.edit'
              ? event(row.createdAt, 'task.edited', 'Task details updated', auditActor(row))
              : event(row.createdAt, 'task.commented', 'Comment added', auditActor(row)),
          );

        const assignmentEvents = assignments.flatMap((assignment: any) => {
          const who = assignment.employee?.user?.name ?? null;
          return [
            event(assignment.createdAt, 'assignment.assigned', 'Task assigned', {
              toStatus: 'assigned',
              actorName: task.creator?.name ?? null,
            }),
            event(assignment.submittedAt, 'assignment.submitted', 'Task submitted for review', {
              toStatus: 'submitted',
              actorName: who,
            }),
            event(
              assignment.reviewedAt,
              assignment.status === 'returned' ? 'assignment.returned' : 'assignment.accepted',
              assignment.status === 'returned' ? 'Task returned' : 'Task accepted',
              {
                fromStatus: 'submitted',
                toStatus: assignment.status,
                actorName: assignment.reviewer?.name ?? null,
                // reviewNote is the authorized reason on this adapter, matching
                // how the leave/training adapters surface their own note.
                reason: assignment.reviewNote ?? null,
              },
            ),
          ];
        });

        const events = finalize([
          event(task.createdAt, 'task.created', 'Task created', {
            toStatus: 'active',
            actorName: task.creator?.name ?? null,
          }),
          ...taskAuditEvents,
          ...assignmentEvents,
          ...(task.status === 'cancelled'
            ? [event(task.updatedAt, 'task.cancelled', 'Task cancelled', { toStatus: 'cancelled' })]
            : []),
          ...(task.status === 'completed'
            ? [event(task.updatedAt, 'task.completed', 'Task completed', { toStatus: 'completed' })]
            : []),
        ]);
        return res.json({ entityType: 'task', entityId: task.id, events });
      } catch {
        return res.status(500).json({ error: 'TimelineFailed', code: 500, message: 'timeline.failed' });
      }
    },
  );
}
