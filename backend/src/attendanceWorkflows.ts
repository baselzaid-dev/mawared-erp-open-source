import { randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { loadManagedDepartmentIds, loadPrimaryOwnerUserId } from './authorization';
import { PERMISSIONS } from './permissions';

interface AttendanceWorkflowUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface AttendanceWorkflowRequest extends Request {
  user?: AttendanceWorkflowUser;
}

interface AttendanceWorkflowRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
}

class AttendanceWorkflowError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

export const EXEMPTION_REASON_CATEGORIES = [
  'owner_account',
  'admin_account',
  'field_assignment',
  'remote_work',
  'medical',
  'temporary_assignment',
] as const;

export type ExemptionReasonCategory = (typeof EXEMPTION_REASON_CATEGORIES)[number];

export const MANDATORY_EXEMPTION_CATEGORIES = new Set<ExemptionReasonCategory>(
  EXEMPTION_REASON_CATEGORIES,
);

const CORRECTION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
const idempotencyKeySchema = z.string().trim().min(8).max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const reasonSchema = z.string().trim().min(3).max(500);
const versionSchema = z.number().int().min(1);
const isoDateTimeSchema = z.string().datetime({ offset: true });

const correctionCreateSchema = z.object({
  clockIn: isoDateTimeSchema.optional(),
  clockOut: isoDateTimeSchema.optional(),
  reason: reasonSchema,
  expectedAttendanceVersion: versionSchema,
}).strict().superRefine((value, context) => {
  if (!value.clockIn && !value.clockOut) {
    context.addIssue({
      code: 'custom',
      message: 'At least one corrected clock time is required',
      path: ['clockIn'],
    });
  }
});

const correctionListSchema = z.object({
  status: z.enum(CORRECTION_STATUSES).optional(),
  employeeId: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

const correctionDecisionSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  reason: reasonSchema,
  expectedVersion: versionSchema,
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();

const exemptionListSchema = z.object({
  targetUserId: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['active', 'revoked']).optional(),
}).strict();

const exemptionCreateSchema = z.object({
  targetUserId: z.string().trim().min(1).max(100),
  validFrom: isoDateTimeSchema,
  validUntil: isoDateTimeSchema.optional(),
  reasonCategory: z.enum(EXEMPTION_REASON_CATEGORIES),
  note: z.string().trim().max(2000).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.validUntil && new Date(value.validUntil).getTime() <= new Date(value.validFrom).getTime()) {
    context.addIssue({
      code: 'custom',
      message: 'validUntil must be after validFrom',
      path: ['validUntil'],
    });
  }
});

const exemptionRevokeSchema = z.object({
  reason: reasonSchema,
  expectedVersion: versionSchema,
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();

const fail = (status: number, code: string, messageKey: string): never => {
  throw new AttendanceWorkflowError(status, code, messageKey);
};

const iso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

const route = (
  handler: (req: AttendanceWorkflowRequest, res: Response) => Promise<unknown>,
): RequestHandler => async (request, response, next) => {
  try {
    await handler(request as AttendanceWorkflowRequest, response);
  } catch (error) {
    if (error instanceof AttendanceWorkflowError) {
      return response.status(error.status).json({
        error: error.code,
        code: error.status,
        message: error.messageKey,
        messageKey: error.messageKey,
      });
    }
    if ((error as { code?: string }).code === 'P2002') {
      return response.status(409).json({
        error: 'ConcurrentConflict',
        code: 409,
        message: 'attendance.concurrent_conflict',
        messageKey: 'attendance.concurrent_conflict',
      });
    }
    return next(error);
  }
};

const actorFrom = (req: AttendanceWorkflowRequest): AttendanceWorkflowUser => {
  if (!req.user?.id || !req.user.companyId) {
    fail(401, 'Unauthorized', 'attendance.unauthorized');
  }
  return req.user!;
};

const parseQuery = <T>(schema: z.ZodType<T>, query: unknown): T => {
  const parsed = schema.safeParse(query);
  if (!parsed.success) fail(400, 'InvalidRequest', 'attendance.invalid_request');
  return parsed.data;
};

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail(400, 'InvalidRequest', 'attendance.invalid_request');
  return parsed.data;
};

const hasPermission = (permissions: string[], permission: string): boolean =>
  permissions.includes(PERMISSIONS.ADMIN_FULL) || permissions.includes(permission);

const hasCompanyAttendanceScope = (permissions: string[]): boolean =>
  hasPermission(permissions, PERMISSIONS.ATTENDANCE_VIEW)
  || hasPermission(permissions, PERMISSIONS.ATTENDANCE_VIEW_COMPANY);

const hasDepartmentAttendanceScope = (permissions: string[]): boolean =>
  hasPermission(permissions, PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT);

const canReviewCorrections = (permissions: string[]): boolean =>
  hasPermission(permissions, PERMISSIONS.ATTENDANCE_REVIEW_CORRECTION);

const canManageExemptions = (permissions: string[]): boolean =>
  hasPermission(permissions, PERMISSIONS.EMPLOYEES_ATTENDANCE_EXEMPTION_MANAGE);

const getIdempotencyKey = (req: Request, bodyKey?: string): string => {
  const header = req.header('Idempotency-Key');
  const candidate = header ?? bodyKey;
  const parsed = idempotencyKeySchema.safeParse(candidate);
  if (!parsed.success) fail(400, 'IdempotencyKeyRequired', 'attendance.idempotency_key_required');
  return parsed.data;
};

const encodeCursor = (createdAt: Date, id: string): string =>
  Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');

const decodeCursor = (cursor: string): { createdAt: Date; id: string } => {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) fail(400, 'InvalidRequest', 'attendance.invalid_request');
    const createdAt = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (!id || Number.isNaN(createdAt.getTime())) {
      fail(400, 'InvalidRequest', 'attendance.invalid_request');
    }
    return { createdAt, id };
  } catch {
    fail(400, 'InvalidRequest', 'attendance.invalid_request');
  }
};

const intervalsOverlap = (
  leftFrom: Date,
  leftUntil: Date | null,
  rightFrom: Date,
  rightUntil: Date | null,
): boolean => {
  const leftEnd = leftUntil ?? new Date('9999-12-31T23:59:59.999Z');
  const rightEnd = rightUntil ?? new Date('9999-12-31T23:59:59.999Z');
  return leftFrom.getTime() < rightEnd.getTime() && rightFrom.getTime() < leftEnd.getTime();
};

export async function isUserAttendanceExempt(
  prisma: PrismaClient,
  companyId: string,
  userId: string,
  at: Date = new Date(),
): Promise<{ exempt: boolean; reasonCategory?: string }> {
  const row = await prisma.attendanceExemption.findFirst({
    where: {
      companyId,
      userId,
      status: 'active',
      validFrom: { lte: at },
      OR: [{ validUntil: null }, { validUntil: { gt: at } }],
    },
    orderBy: [{ validFrom: 'desc' }, { id: 'desc' }],
  });
  if (!row) return { exempt: false };
  return { exempt: true, reasonCategory: row.reasonCategory };
}

const loadEmployeeWithUser = async (
  prisma: PrismaClient,
  companyId: string,
  employeeId: string,
) => prisma.employee.findFirst({
  where: { id: employeeId, companyId },
  include: {
    user: { select: { id: true } },
    department: { select: { id: true } },
  },
});

const ensureEmployeeInScope = async (
  prisma: PrismaClient,
  actor: AttendanceWorkflowUser,
  employee: { id: string; departmentId: string | null },
): Promise<void> => {
  if (hasCompanyAttendanceScope(actor.permissions)) return;
  if (!hasDepartmentAttendanceScope(actor.permissions)) {
    fail(403, 'Forbidden', 'attendance.forbidden');
  }
  const managed = await loadManagedDepartmentIds(prisma, {
    companyId: actor.companyId,
    userId: actor.id,
  });
  if (!employee.departmentId || !managed.includes(employee.departmentId)) {
    fail(403, 'Forbidden', 'attendance.forbidden');
  }
};

const ensureTargetUserManageable = async (
  prisma: PrismaClient,
  actor: AttendanceWorkflowUser,
  targetUserId: string,
): Promise<{ userId: string; employeeId: string | null; departmentId: string | null }> => {
  if (targetUserId === actor.id) fail(403, 'Forbidden', 'attendance.exemption_self_forbidden');

  const target = await prisma.user.findFirst({
    where: { id: targetUserId, companyId: actor.companyId },
    select: {
      id: true,
      employeeId: true,
      employee: { select: { id: true, departmentId: true, status: true } },
    },
  });
  if (!target) fail(404, 'NotFound', 'attendance.not_found');

  const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, actor.companyId);
  if (primaryOwnerUserId && target.id === primaryOwnerUserId) {
    fail(403, 'Forbidden', 'attendance.protected_target');
  }

  if (!canManageExemptions(actor.permissions)) {
    fail(403, 'Forbidden', 'attendance.forbidden');
  }

  const employee = target.employee;
  if (employee && employee.status === 'active') {
    await ensureEmployeeInScope(prisma, actor, employee);
    return {
      userId: target.id,
      employeeId: employee.id,
      departmentId: employee.departmentId,
    };
  }

  if (!hasCompanyAttendanceScope(actor.permissions)) {
    fail(403, 'Forbidden', 'attendance.forbidden');
  }

  return {
    userId: target.id,
    employeeId: target.employeeId,
    departmentId: employee?.departmentId ?? null,
  };
};

const canSubmitCorrection = async (
  prisma: PrismaClient,
  actor: AttendanceWorkflowUser,
  attendance: { employeeId: string },
): Promise<void> => {
  if (actor.employeeId && actor.employeeId === attendance.employeeId) return;
  if (hasPermission(actor.permissions, PERMISSIONS.ATTENDANCE_MANAGE_MANUAL)) {
    const employee = await loadEmployeeWithUser(prisma, actor.companyId, attendance.employeeId);
    if (!employee) fail(404, 'NotFound', 'attendance.not_found');
    await ensureEmployeeInScope(prisma, actor, employee);
    return;
  }
  fail(403, 'Forbidden', 'attendance.forbidden');
};

const canViewCorrection = async (
  prisma: PrismaClient,
  actor: AttendanceWorkflowUser,
  correction: {
    requestedByUserId: string;
    employeeId: string;
  },
): Promise<boolean> => {
  if (correction.requestedByUserId === actor.id) return true;
  if (!canReviewCorrections(actor.permissions)) return false;
  const employee = await loadEmployeeWithUser(prisma, actor.companyId, correction.employeeId);
  if (!employee) return false;
  try {
    await ensureEmployeeInScope(prisma, actor, employee);
    return true;
  } catch {
    return false;
  }
};

const shapeCorrectionDto = (row: {
  id: string;
  attendanceId: string;
  employeeId: string;
  requestedByUserId: string;
  requestedClockIn: Date | null;
  requestedClockOut: Date | null;
  reason: string;
  status: string;
  version: number;
  reviewedAt: Date | null;
  decisionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: row.id,
  attendanceId: row.attendanceId,
  employeeId: row.employeeId,
  requestedByUserId: row.requestedByUserId,
  requestedClockIn: iso(row.requestedClockIn),
  requestedClockOut: iso(row.requestedClockOut),
  reason: row.reason,
  status: row.status,
  version: row.version,
  reviewedAt: iso(row.reviewedAt),
  decisionReason: row.decisionReason,
  createdAt: iso(row.createdAt)!,
  updatedAt: iso(row.updatedAt)!,
});

const shapeAttendanceDto = (row: {
  id: string;
  employeeId: string;
  date: Date;
  clockIn: Date | null;
  clockOut: Date | null;
  status: string;
  version: number;
}) => ({
  id: row.id,
  employeeId: row.employeeId,
  date: iso(row.date)!,
  clockIn: iso(row.clockIn),
  clockOut: iso(row.clockOut),
  status: row.status,
  version: row.version,
});

const shapeExemptionDto = (
  row: {
    id: string;
    userId: string;
    employeeId: string | null;
    validFrom: Date;
    validUntil: Date | null;
    reasonCategory: string;
    note: string | null;
    status: string;
    version: number;
    createdAt: Date;
    revokedAt: Date | null;
  },
  includeNote: boolean,
) => ({
  id: row.id,
  userId: row.userId,
  employeeId: row.employeeId,
  validFrom: iso(row.validFrom)!,
  validUntil: iso(row.validUntil),
  reasonCategory: row.reasonCategory,
  ...(includeNote ? { note: row.note } : {}),
  status: row.status,
  version: row.version,
  createdAt: iso(row.createdAt)!,
  revokedAt: iso(row.revokedAt),
});

const notifyReviewers = async (
  client: Pick<PrismaClient, 'notification' | 'user'>,
  companyId: string,
  actorUserId: string,
  correctionId: string,
): Promise<void> => {
  const reviewers = await client.user.findMany({
    where: { companyId },
    select: { id: true, role: { select: { permissions: true } } },
  });
  const recipientIds = new Set<string>();
  for (const reviewer of reviewers) {
    let permissions: string[] = [];
    try {
      permissions = reviewer.role?.permissions
        ? JSON.parse(reviewer.role.permissions)
        : [];
    } catch {
      permissions = [];
    }
    if (
      permissions.includes(PERMISSIONS.ADMIN_FULL)
      || (permissions.includes(PERMISSIONS.ATTENDANCE_REVIEW_CORRECTION)
        && (permissions.includes(PERMISSIONS.ATTENDANCE_VIEW)
          || permissions.includes(PERMISSIONS.ATTENDANCE_VIEW_COMPANY)))
    ) {
      recipientIds.add(reviewer.id);
    }
  }
  recipientIds.delete(actorUserId);
  for (const userId of recipientIds) {
    await client.notification.create({
      data: {
        companyId,
        userId,
        title: 'طلب تصحيح حضور',
        message: 'يوجد طلب تصحيح حضور بانتظار المراجعة.',
        category: 'attendance',
        routeKey: 'attendance.today',
        resourceType: 'attendance',
        resourceId: correctionId,
      },
    });
  }
};

export function registerAttendanceWorkflowRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
}: AttendanceWorkflowRouteDeps): void {
  app.post(
    '/api/v2/attendance/:id/corrections',
    requireAuth,
    route(async (req, res) => {
      const actor = actorFrom(req);
      const body = parseBody(correctionCreateSchema, req.body);
      const attendance = await prisma.attendance.findFirst({
        where: { id: req.params.id, companyId: actor.companyId },
      });
      if (!attendance) fail(404, 'NotFound', 'attendance.not_found');

      await canSubmitCorrection(prisma, actor, attendance);

      if (attendance.version !== body.expectedAttendanceVersion) {
        fail(412, 'VersionMismatch', 'attendance.version_mismatch');
      }

      const pending = await prisma.attendanceCorrection.findFirst({
        where: {
          companyId: actor.companyId,
          attendanceId: attendance.id,
          status: 'pending',
        },
      });
      if (pending) fail(409, 'PendingCorrectionExists', 'attendance.pending_correction_exists');

      const requestedClockIn = body.clockIn ? new Date(body.clockIn) : null;
      const requestedClockOut = body.clockOut ? new Date(body.clockOut) : null;
      if (
        requestedClockIn
        && requestedClockOut
        && requestedClockOut.getTime() < requestedClockIn.getTime()
      ) {
        fail(400, 'InvalidRequest', 'attendance.invalid_request');
      }

      const created = await prisma.$transaction(async (tx) => {
        const correction = await tx.attendanceCorrection.create({
          data: {
            id: randomUUID(),
            companyId: actor.companyId,
            attendanceId: attendance.id,
            employeeId: attendance.employeeId,
            requestedByUserId: actor.id,
            requestedClockIn,
            requestedClockOut,
            reason: body.reason,
            status: 'pending',
          },
        });
        await tx.attendanceCorrectionHistory.create({
          data: {
            id: randomUUID(),
            companyId: actor.companyId,
            correctionId: correction.id,
            actorUserId: actor.id,
            action: 'submit',
            fromStatus: 'pending',
            toStatus: 'pending',
            safeReason: body.reason.slice(0, 500),
          },
        });
        await writeAuditRequired(tx, {
          companyId: actor.companyId,
          userId: actor.id,
          action: 'attendance.correction.submit',
          details: {
            correctionId: correction.id,
            attendanceId: attendance.id,
            employeeId: attendance.employeeId,
            status: correction.status,
          },
        });
        await notifyReviewers(tx as unknown as PrismaClient, actor.companyId, actor.id, correction.id);
        return correction;
      });

      return res.status(201).json(shapeCorrectionDto(created));
    }),
  );

  app.get(
    '/api/v2/attendance/corrections',
    requireAuth,
    route(async (req, res) => {
      const actor = actorFrom(req);
      const query = parseQuery(correctionListSchema, req.query);
      const limit = query.limit ?? 50;
      const reviewer = canReviewCorrections(actor.permissions);

      const where: Record<string, unknown> = {
        companyId: actor.companyId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.employeeId ? { employeeId: query.employeeId } : {}),
        ...(reviewer ? {} : { requestedByUserId: actor.id }),
      };
      if (query.cursor) {
        const cursor = decodeCursor(query.cursor);
        where.OR = [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ];
      }

      const rows = await prisma.attendanceCorrection.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });

      const visible: typeof rows = [];
      for (const row of rows) {
        if (await canViewCorrection(prisma, actor, row)) visible.push(row);
      }
      const hasMore = visible.length > limit;
      const page = hasMore ? visible.slice(0, limit) : visible;
      const last = page[page.length - 1];

      return res.json({
        items: page.map(shapeCorrectionDto),
        nextCursor: hasMore && last ? encodeCursor(new Date(last.createdAt), last.id) : null,
        hasMore,
      });
    }),
  );

  app.post(
    '/api/v2/attendance/corrections/:id/decision',
    requireAuth,
    checkAnyPermission(PERMISSIONS.ATTENDANCE_REVIEW_CORRECTION),
    route(async (req, res) => {
      const actor = actorFrom(req);
      const body = parseBody(correctionDecisionSchema, req.body);
      getIdempotencyKey(req, body.idempotencyKey);

      const correction = await prisma.attendanceCorrection.findFirst({
        where: { id: req.params.id, companyId: actor.companyId },
      });
      if (!correction) fail(404, 'NotFound', 'attendance.not_found');

      if (correction.requestedByUserId === actor.id) {
        fail(403, 'Forbidden', 'attendance.self_review_forbidden');
      }
      if (correction.status !== 'pending') {
        fail(409, 'CorrectionAlreadyDecided', 'attendance.correction_already_decided');
      }
      if (correction.version !== body.expectedVersion) {
        fail(412, 'VersionMismatch', 'attendance.version_mismatch');
      }

      const employee = await loadEmployeeWithUser(prisma, actor.companyId, correction.employeeId);
      if (!employee) fail(404, 'NotFound', 'attendance.not_found');
      await ensureEmployeeInScope(prisma, actor, employee);

      const toStatus = body.decision === 'accept' ? 'approved' : 'rejected';
      const historyAction = body.decision === 'accept' ? 'approve' : 'reject';

      const result = await prisma.$transaction(async (tx) => {
        const locked = await tx.attendanceCorrection.findFirst({
          where: {
            id: correction.id,
            companyId: actor.companyId,
            status: 'pending',
            version: body.expectedVersion,
          },
        });
        if (!locked) fail(409, 'CorrectionAlreadyDecided', 'attendance.correction_already_decided');

        const attendance = await tx.attendance.findFirst({
          where: { id: correction.attendanceId, companyId: actor.companyId },
        });
        if (!attendance) fail(404, 'NotFound', 'attendance.not_found');

        let updatedAttendance = attendance;
        if (body.decision === 'accept') {
          updatedAttendance = await tx.attendance.update({
            where: { id: attendance.id },
            data: {
              clockIn: correction.requestedClockIn ?? attendance.clockIn,
              clockOut: correction.requestedClockOut ?? attendance.clockOut,
              version: { increment: 1 },
            },
          });
        }

        const updatedCorrection = await tx.attendanceCorrection.update({
          where: { id: correction.id },
          data: {
            status: toStatus,
            reviewedByUserId: actor.id,
            reviewedAt: new Date(),
            decisionReason: body.reason,
            version: { increment: 1 },
          },
        });

        await tx.attendanceCorrectionHistory.create({
          data: {
            id: randomUUID(),
            companyId: actor.companyId,
            correctionId: correction.id,
            actorUserId: actor.id,
            action: historyAction,
            fromStatus: 'pending',
            toStatus,
            safeReason: body.reason.slice(0, 500),
          },
        });

        await writeAuditRequired(tx, {
          companyId: actor.companyId,
          userId: actor.id,
          action: `attendance.correction.${historyAction}`,
          details: {
            correctionId: correction.id,
            attendanceId: attendance.id,
            employeeId: correction.employeeId,
            status: toStatus,
            attendanceVersion: updatedAttendance.version,
          },
        });

        await tx.notification.create({
          data: {
            companyId: actor.companyId,
            userId: correction.requestedByUserId,
            title: body.decision === 'accept' ? 'تم قبول تصحيح الحضور' : 'تم رفض تصحيح الحضور',
            message: 'تمت مراجعة طلب تصحيح الحضور.',
            category: 'attendance',
            routeKey: 'attendance.today',
            resourceType: 'attendance',
            resourceId: correction.attendanceId,
          },
        });

        return { correction: updatedCorrection, attendance: updatedAttendance };
      });

      return res.json({
        correction: shapeCorrectionDto(result.correction),
        attendance: body.decision === 'accept' ? shapeAttendanceDto(result.attendance) : undefined,
      });
    }),
  );

  app.get(
    '/api/v2/attendance/exemptions',
    requireAuth,
    route(async (req, res) => {
      const actor = actorFrom(req);
      const query = parseQuery(exemptionListSchema, req.query);
      const manager = canManageExemptions(actor.permissions);

      if (!manager && query.targetUserId && query.targetUserId !== actor.id) {
        fail(403, 'Forbidden', 'attendance.forbidden');
      }

      const where: Record<string, unknown> = { companyId: actor.companyId };
      if (query.status) where.status = query.status;
      if (manager && query.targetUserId) {
        where.userId = query.targetUserId;
      } else if (!manager) {
        where.userId = actor.id;
      }

      const rows = await prisma.attendanceExemption.findMany({
        where,
        orderBy: [{ validFrom: 'desc' }, { id: 'desc' }],
      });

      const items = [];
      for (const row of rows) {
        if (manager && row.userId !== actor.id) {
          const target = await prisma.user.findFirst({
            where: { id: row.userId, companyId: actor.companyId },
            select: { employee: { select: { id: true, departmentId: true, status: true } } },
          });
          if (target?.employee?.status === 'active') {
            try {
              await ensureEmployeeInScope(prisma, actor, target.employee);
            } catch {
              continue;
            }
          } else if (!hasCompanyAttendanceScope(actor.permissions)) {
            continue;
          }
        }
        items.push(shapeExemptionDto(row, manager));
      }

      return res.json({ items });
    }),
  );

  app.post(
    '/api/v2/attendance/exemptions',
    requireAuth,
    checkAnyPermission(PERMISSIONS.EMPLOYEES_ATTENDANCE_EXEMPTION_MANAGE),
    route(async (req, res) => {
      const actor = actorFrom(req);
      const body = parseBody(exemptionCreateSchema, req.body);
      getIdempotencyKey(req, body.idempotencyKey);

      const target = await ensureTargetUserManageable(prisma, actor, body.targetUserId);
      const validFrom = new Date(body.validFrom);
      const validUntil = body.validUntil ? new Date(body.validUntil) : null;

      const overlapping = await prisma.attendanceExemption.findMany({
        where: {
          companyId: actor.companyId,
          userId: target.userId,
          status: 'active',
        },
      });
      if (overlapping.some((row) => intervalsOverlap(
        new Date(row.validFrom),
        row.validUntil ? new Date(row.validUntil) : null,
        validFrom,
        validUntil,
      ))) {
        fail(409, 'ExemptionOverlap', 'attendance.exemption_overlap');
      }

      const created = await prisma.$transaction(async (tx) => {
        const exemption = await tx.attendanceExemption.create({
          data: {
            id: randomUUID(),
            companyId: actor.companyId,
            userId: target.userId,
            employeeId: target.employeeId,
            validFrom,
            validUntil,
            reasonCategory: body.reasonCategory,
            note: body.note ?? null,
            status: 'active',
            createdByUserId: actor.id,
          },
        });
        await writeAuditRequired(tx, {
          companyId: actor.companyId,
          userId: actor.id,
          action: 'attendance.exemption.create',
          details: {
            exemptionId: exemption.id,
            targetUserId: target.userId,
            employeeId: target.employeeId,
            status: exemption.status,
          },
        });
        await tx.notification.create({
          data: {
            companyId: actor.companyId,
            userId: target.userId,
            title: 'تم تفعيل إعفاء الحضور',
            message: 'تم تسجيل إعفاء حضور على حسابك.',
            category: 'attendance',
            routeKey: 'attendance.today',
            resourceType: 'attendance',
          },
        });
        return exemption;
      });

      return res.status(201).json(shapeExemptionDto(created, true));
    }),
  );

  app.post(
    '/api/v2/attendance/exemptions/:id/revoke',
    requireAuth,
    checkAnyPermission(PERMISSIONS.EMPLOYEES_ATTENDANCE_EXEMPTION_MANAGE),
    route(async (req, res) => {
      const actor = actorFrom(req);
      const body = parseBody(exemptionRevokeSchema, req.body);
      getIdempotencyKey(req, body.idempotencyKey);

      const exemption = await prisma.attendanceExemption.findFirst({
        where: { id: req.params.id, companyId: actor.companyId },
      });
      if (!exemption) fail(404, 'NotFound', 'attendance.not_found');

      await ensureTargetUserManageable(prisma, actor, exemption.userId);

      if (exemption.status === 'revoked') {
        return res.json(shapeExemptionDto(exemption, true));
      }
      if (exemption.version !== body.expectedVersion) {
        fail(412, 'VersionMismatch', 'attendance.version_mismatch');
      }

      const revoked = await prisma.$transaction(async (tx) => {
        const updated = await tx.attendanceExemption.update({
          where: { id: exemption.id },
          data: {
            status: 'revoked',
            revokedAt: new Date(),
            revokedByUserId: actor.id,
            version: { increment: 1 },
          },
        });
        await writeAuditRequired(tx, {
          companyId: actor.companyId,
          userId: actor.id,
          action: 'attendance.exemption.revoke',
          details: {
            exemptionId: exemption.id,
            targetUserId: exemption.userId,
            status: updated.status,
          },
        });
        await tx.notification.create({
          data: {
            companyId: actor.companyId,
            userId: exemption.userId,
            title: 'تم إلغاء إعفاء الحضور',
            message: 'لم يعد إعفاء الحضور نشطاً على حسابك.',
            category: 'attendance',
            routeKey: 'attendance.today',
            resourceType: 'attendance',
          },
        });
        return updated;
      });

      return res.json(shapeExemptionDto(revoked, true));
    }),
  );
}
