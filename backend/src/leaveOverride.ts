import type { Express, Request, RequestHandler, Response } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { PERMISSIONS } from './permissions';

/** Second-confirmation token required in the request body (RC2 override UX). */
export const LEAVE_OVERRIDE_CONFIRMATION = 'OVERRIDE';

const OVERRIDE_REASON_CATEGORY = 'admin_override';

const idempotencyKeySchema = z.string().trim().min(8).max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const reasonSchema = z.string().trim().min(1).max(500);
const isoDateTimeSchema = z.string().datetime({ offset: true });

const leaveOverrideBodySchema = z.object({
  action: z.enum(['approve', 'reject', 'cancel']),
  reason: reasonSchema,
  confirmation: z.literal(LEAVE_OVERRIDE_CONFIRMATION),
  expectedUpdatedAt: isoDateTimeSchema.optional(),
  expectedVersion: z.number().int().min(1).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.expectedVersion !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'LeaveRequest has no version column; send expectedUpdatedAt (ISO-8601) instead',
      path: ['expectedVersion'],
    });
  }
});

interface LeaveOverrideUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface LeaveOverrideRequest extends Request {
  user?: LeaveOverrideUser;
}

export interface LeaveOverrideRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkPermission: (permission: string) => RequestHandler;
}

class LeaveOverrideError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(messageKey);
  }
}

type LeaveRow = Prisma.LeaveRequestGetPayload<{
  include: {
    employee: {
      select: {
        id: true;
        employeeNum: true;
        departmentId: true;
        department: { select: { id: true; name: true } };
        user: { select: { id: true; name: true } };
      };
    };
  };
}>;

type LeaveOverrideOutcome =
  | { kind: 'not_found' }
  | { kind: 'self' }
  | { kind: 'version_mismatch'; currentUpdatedAt: string }
  | { kind: 'conflict' }
  | { kind: 'success'; leave: ReturnType<typeof shapeLeaveDto> };

const fail = (
  status: number,
  code: string,
  messageKey: string,
  details?: Record<string, unknown>,
): never => {
  throw new LeaveOverrideError(status, code, messageKey, details);
};

const route = (
  handler: (req: LeaveOverrideRequest, res: Response) => Promise<unknown>,
): RequestHandler => async (request, response, next) => {
  try {
    await handler(request as LeaveOverrideRequest, response);
  } catch (error) {
    if (error instanceof LeaveOverrideError) {
      return response.status(error.status).json({
        error: error.code,
        code: error.status,
        message: error.messageKey,
        messageKey: error.messageKey,
        ...(error.details ?? {}),
      });
    }
    if ((error as { code?: string }).code === 'P2002') {
      return response.status(409).json({
        error: 'ConcurrentConflict',
        code: 409,
        message: 'leave.concurrent_conflict',
        messageKey: 'leave.concurrent_conflict',
      });
    }
    return next(error);
  }
};

const actorFrom = (req: LeaveOverrideRequest): LeaveOverrideUser => {
  if (!req.user?.id || !req.user.companyId) {
    fail(401, 'Unauthorized', 'leave.unauthorized');
  }
  return req.user!;
};

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail(400, 'InvalidRequest', 'leave.invalid_request');
  return parsed.data;
};

const targetStatusForAction = (action: 'approve' | 'reject' | 'cancel'): string => {
  switch (action) {
    case 'approve':
      return 'approved';
    case 'reject':
      return 'rejected';
    case 'cancel':
      return 'cancelled';
    default:
      return action;
  }
};

const historyActionFor = (action: 'approve' | 'reject' | 'cancel'): string =>
  `override_${action}`;

const auditActionFor = (action: 'approve' | 'reject' | 'cancel'): string =>
  `leave.override_${action}`;

export const shapeLeaveDto = (row: LeaveRow | (LeaveRow & { status: string })) => ({
  id: row.id,
  employeeId: row.employeeId,
  leaveType: row.leaveType,
  startDate: row.startDate,
  endDate: row.endDate,
  totalDays: row.totalDays,
  reason: row.reason ?? null,
  status: row.status,
  exitReentryRequested: Boolean(row.exitReentryRequested),
  visaFeePaid: Boolean(row.visaFeePaid),
  rejectionReason: row.rejectionReason ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  employee: row.employee
    ? {
        id: row.employee.id,
        employeeNum: row.employee.employeeNum,
        name: row.employee.user?.name ?? 'موظف',
        departmentId: row.employee.departmentId ?? null,
        department: row.employee.department
          ? { id: row.employee.department.id, name: row.employee.department.name }
          : null,
      }
    : null,
});

const leaveInclude = {
  employee: {
    select: {
      id: true,
      employeeNum: true,
      departmentId: true,
      department: { select: { id: true, name: true } },
      user: { select: { id: true, name: true } },
    },
  },
} as const;

async function claimLeaveOverride(input: {
  prisma: PrismaClient;
  leaveRequestId: string;
  companyId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  action: 'approve' | 'reject' | 'cancel';
  reason: string;
  expectedUpdatedAt?: string;
}): Promise<LeaveOverrideOutcome> {
  return input.prisma.$transaction(async (tx) => {
    const leave = await tx.leaveRequest.findFirst({
      where: { id: input.leaveRequestId, companyId: input.companyId },
      include: leaveInclude,
    });
    if (!leave) return { kind: 'not_found' };
    if (leave.employeeId === input.actorEmployeeId) return { kind: 'self' };

    const currentUpdatedAt = leave.updatedAt.toISOString();
    if (input.expectedUpdatedAt !== undefined) {
      const expected = new Date(input.expectedUpdatedAt).toISOString();
      if (expected !== currentUpdatedAt) {
        return { kind: 'version_mismatch', currentUpdatedAt };
      }
    }

    const fromStatus = leave.status;
    const toStatus = targetStatusForAction(input.action);
    if (fromStatus === toStatus) return { kind: 'conflict' };

    const update: Prisma.LeaveRequestUpdateManyMutationInput = { status: toStatus };
    if (input.action === 'reject') {
      update.rejectionReason = input.reason;
    }

    const claimed = await tx.leaveRequest.updateMany({
      where: {
        id: leave.id,
        companyId: input.companyId,
        status: fromStatus,
      },
      data: update,
    });

    if (claimed.count !== 1) {
      const stillVisible = await tx.leaveRequest.findFirst({
        where: { id: leave.id, companyId: input.companyId },
        select: { id: true },
      });
      return stillVisible ? { kind: 'conflict' } : { kind: 'not_found' };
    }

    const actor = await tx.user.findFirst({
      where: { id: input.actorUserId, companyId: input.companyId },
      select: { role: { select: { name: true } } },
    });

    await tx.leaveApprovalHistory.create({
      data: {
        companyId: input.companyId,
        leaveRequestId: leave.id,
        actionByUserId: input.actorUserId,
        action: historyActionFor(input.action),
        reason: input.reason,
        fromStatus,
        toStatus,
        isOverride: true,
        reasonCategory: OVERRIDE_REASON_CATEGORY,
        actorRoleSnapshot: actor?.role?.name ?? null,
      },
    });

    await writeAuditRequired(tx, {
      companyId: input.companyId,
      userId: input.actorUserId,
      action: auditActionFor(input.action),
      details: {
        leaveRequestId: leave.id,
        fromStatus,
        toStatus,
        isOverride: true,
      },
    });

    const notifyTitle = input.action === 'approve'
      ? 'تم تعديل حالة الإجازة (إجراء إداري)'
      : input.action === 'reject'
        ? 'تم رفض الإجازة (إجراء إداري)'
        : 'تم إلغاء الإجازة (إجراء إداري)';
    const notifyMessage = input.action === 'approve'
      ? 'تم اعتماد إجازتك عبر إجراء إداري استثنائي.'
      : input.action === 'reject'
        ? 'تم رفض إجازتك عبر إجراء إداري استثنائي.'
        : 'تم إلغاء إجازتك عبر إجراء إداري استثنائي.';

    if (leave.employee.user?.id) {
      await tx.notification.create({
        data: {
          companyId: input.companyId,
          userId: leave.employee.user.id,
          title: notifyTitle,
          message: notifyMessage,
          category: 'leave',
          routeKey: 'leave.detail',
          resourceType: 'leaveRequest',
          resourceId: leave.id,
        },
      });
    }

    const updatedLeave: LeaveRow = {
      ...leave,
      status: toStatus,
      rejectionReason: input.action === 'reject' ? input.reason : leave.rejectionReason,
      updatedAt: new Date(),
    };

    return { kind: 'success', leave: shapeLeaveDto(updatedLeave) };
  });
}

const sendLeaveOverrideOutcome = (res: Response, outcome: LeaveOverrideOutcome): Response => {
  if (outcome.kind === 'not_found') {
    return res.status(404).json({ error: 'NotFound', code: 404, message: 'leave.not_found' });
  }
  if (outcome.kind === 'self') {
    return res.status(403).json({
      error: 'Forbidden',
      code: 403,
      message: 'leave.override_self_forbidden',
      messageKey: 'leave.override_self_forbidden',
    });
  }
  if (outcome.kind === 'version_mismatch') {
    return res.status(412).json({
      error: 'VersionMismatch',
      code: 412,
      message: 'leave.updated_at_mismatch',
      messageKey: 'leave.updated_at_mismatch',
      currentUpdatedAt: outcome.currentUpdatedAt,
    });
  }
  if (outcome.kind === 'conflict') {
    return res.status(409).json({
      error: 'LeaveStateConflict',
      code: 409,
      message: 'leave.state_conflict',
      messageKey: 'leave.state_conflict',
    });
  }
  return res.json(outcome.leave);
};

export function registerLeaveOverrideRoutes({
  app,
  prisma,
  requireAuth,
  checkPermission,
}: LeaveOverrideRouteDeps): void {
  app.post(
    '/api/v2/leaves/:id/override',
    requireAuth,
    checkPermission(PERMISSIONS.LEAVES_ADMIN_OVERRIDE),
    route(async (req, res) => {
      const actor = actorFrom(req);
      const body = parseBody(leaveOverrideBodySchema, req.body);

      const outcome = await claimLeaveOverride({
        prisma,
        leaveRequestId: req.params.id,
        companyId: actor.companyId,
        actorUserId: actor.id,
        actorEmployeeId: actor.employeeId,
        action: body.action,
        reason: body.reason,
        expectedUpdatedAt: body.expectedUpdatedAt,
      });

      return sendLeaveOverrideOutcome(res, outcome);
    }),
  );
}

export {
  claimLeaveOverride,
  leaveOverrideBodySchema,
  targetStatusForAction,
};
