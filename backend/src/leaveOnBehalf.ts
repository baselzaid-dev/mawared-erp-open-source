import { randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { loadManagedDepartmentIds, loadPrimaryOwnerUserId } from './authorization';
import { PERMISSIONS } from './permissions';

interface LeaveOnBehalfUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface LeaveOnBehalfRequest extends Request {
  user?: LeaveOnBehalfUser;
}

interface LeaveOnBehalfRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
}

class LeaveOnBehalfError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
    readonly detail?: string,
  ) {
    super(messageKey);
  }
}

const idempotencyKeySchema = z.string().trim().min(8).max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const submissionReasonSchema = z.string().trim().min(1).max(500);

const onBehalfCreateSchema = z.object({
  employeeId: z.string().trim().min(1).max(100),
  leaveType: z.string().trim().min(1).max(50),
  startDate: z
    .string()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid startDate'),
  endDate: z
    .string()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid endDate'),
  reason: z.string().max(2000).nullish(),
  submissionReason: submissionReasonSchema,
  exitReentryRequested: z.boolean().optional().default(false),
  visaFeePaid: z.boolean().optional().default(false),
  clientActionId: z.string().trim().min(1).max(128).optional(),
}).strict();

const isAnnualLeave = (leaveType: string): boolean =>
  leaveType === 'annual' || leaveType === 'سنوية';

const isSickLeave = (leaveType: string): boolean =>
  leaveType === 'sick' || leaveType === 'مرضية';

const leaveTypeAliases: Record<string, string[]> = {
  annual: ['annual', 'سنوية'],
  'سنوية': ['annual', 'سنوية'],
  sick: ['sick', 'مرضية'],
  'مرضية': ['sick', 'مرضية'],
  special: ['special', 'طارئة'],
  'طارئة': ['special', 'طارئة'],
  unpaid: ['unpaid', 'بدون راتب'],
  'بدون راتب': ['unpaid', 'بدون راتب'],
  study: ['study', 'دراسية'],
  'دراسية': ['study', 'دراسية'],
};

const fail = (
  status: number,
  code: string,
  messageKey: string,
  message?: string,
): never => {
  throw new LeaveOnBehalfError(status, code, messageKey, message);
};

const route = (
  handler: (req: LeaveOnBehalfRequest, res: Response) => Promise<unknown>,
): RequestHandler => async (request, response, next) => {
  try {
    await handler(request as LeaveOnBehalfRequest, response);
  } catch (error) {
    if (error instanceof LeaveOnBehalfError) {
      return response.status(error.status).json({
        error: error.code,
        code: error.status,
        message: error.message ?? error.messageKey,
        messageKey: error.messageKey,
      });
    }
    return next(error);
  }
};

const actorFrom = (req: LeaveOnBehalfRequest): LeaveOnBehalfUser => {
  if (!req.user?.id || !req.user.companyId) {
    fail(401, 'Unauthorized', 'leaves.unauthorized');
  }
  return req.user!;
};

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail(400, 'InvalidRequest', 'leaves.invalid_request');
  return parsed.data;
};

const hasPermission = (permissions: string[], permission: string): boolean =>
  permissions.includes(PERMISSIONS.ADMIN_FULL) || permissions.includes(permission);

const hasCompanyLeaveScope = (permissions: string[]): boolean =>
  hasPermission(permissions, PERMISSIONS.LEAVES_VIEW)
  || hasPermission(permissions, PERMISSIONS.EMPLOYEES_VIEW);

const hasDepartmentLeaveScope = (permissions: string[]): boolean =>
  hasPermission(permissions, PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT);

const parseRolePermissions = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

const isOwnerRoleUser = (
  user: { role?: { permissions?: string | null } | null } | null | undefined,
): boolean => parseRolePermissions(user?.role?.permissions).includes(PERMISSIONS.ADMIN_FULL);

/**
 * Optional Idempotency-Key header: format is validated when present, but keys are
 * not persisted yet. Duplicate submits with the same key may create multiple rows
 * until a dedicated idempotency store lands in a follow-up migration.
 */
const validateOptionalIdempotencyKey = (req: Request): void => {
  const header = req.header('Idempotency-Key');
  if (header == null || header === '') return;
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    fail(400, 'IdempotencyKeyInvalid', 'leaves.idempotency_key_invalid');
  }
};

const loadTargetEmployee = async (
  prisma: PrismaClient,
  companyId: string,
  employeeId: string,
) => prisma.employee.findFirst({
  where: { id: employeeId, companyId },
  include: {
    user: {
      select: {
        id: true,
        name: true,
        role: { select: { permissions: true } },
      },
    },
    department: {
      select: {
        id: true,
        name: true,
        managerId: true,
      },
    },
  },
});

const ensureTargetEmployeeManageable = async (
  prisma: PrismaClient,
  actor: LeaveOnBehalfUser,
  employee: {
    id: string;
    status: string;
    departmentId: string | null;
    user: { id: string; role?: { permissions?: string | null } | null } | null;
  },
): Promise<void> => {
  if (actor.employeeId && actor.employeeId === employee.id) {
    fail(403, 'Forbidden', 'leaves.on_behalf_self_forbidden');
  }

  if (employee.status.toLowerCase() !== 'active') {
    fail(409, 'InactiveEmployee', 'leaves.inactive_employee');
  }

  const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, actor.companyId);
  if (primaryOwnerUserId && employee.user?.id === primaryOwnerUserId) {
    fail(403, 'Forbidden', 'leaves.protected_target');
  }
  if (isOwnerRoleUser(employee.user)) {
    fail(403, 'Forbidden', 'leaves.protected_target');
  }

  if (hasCompanyLeaveScope(actor.permissions)) return;

  if (!hasDepartmentLeaveScope(actor.permissions)) {
    fail(403, 'Forbidden', 'leaves.forbidden');
  }

  const managedDepartmentIds = await loadManagedDepartmentIds(prisma, {
    companyId: actor.companyId,
    userId: actor.id,
  });
  if (!employee.departmentId || !managedDepartmentIds.includes(employee.departmentId)) {
    fail(403, 'Forbidden', 'leaves.forbidden');
  }
};

const calcTotalDays = (startDate: string, endDate: string): number => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (end < start) {
    fail(400, 'InvalidRequest', 'leaves.end_before_start');
  }
  return Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
};

const ensureSickLeaveQuota = async (
  prisma: PrismaClient,
  companyId: string,
  employeeId: string,
  leaveType: string,
  totalDays: number,
): Promise<void> => {
  if (!isSickLeave(leaveType)) return;

  const currentYear = new Date().getFullYear();
  const usedLeaves = await prisma.leaveRequest.aggregate({
    _sum: { totalDays: true },
    where: {
      employeeId,
      companyId,
      leaveType: { in: leaveTypeAliases.sick },
      status: { in: ['approved', 'pending_hr', 'pending_admin'] },
      startDate: {
        gte: new Date(`${currentYear}-01-01T00:00:00.000Z`),
        lte: new Date(`${currentYear}-12-31T23:59:59.999Z`),
      },
    },
  });
  const used = usedLeaves._sum.totalDays || 0;
  if (used + totalDays > 14) {
    fail(
      400,
      'SickLeaveQuotaExceeded',
      'leaves.sick_quota_exceeded',
      `You only have ${14 - used} sick leave days remaining this year.`,
    );
  }
};

const shapeLeaveOnBehalfDto = (
  row: {
    id: string;
    employeeId: string;
    leaveType: string;
    startDate: Date;
    endDate: Date;
    totalDays: number;
    reason?: string | null;
    status: string;
    exitReentryRequested?: boolean | null;
    visaFeePaid?: boolean | null;
    rejectionReason?: string | null;
    submittedByUserId?: string | null;
    submissionMode?: string | null;
    submissionReason?: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  employee: {
    id: string;
    employeeNum?: string | null;
    departmentId: string | null;
    user?: { id: string; name?: string | null } | null;
    department?: { id: string; name: string } | null;
  } | null,
) => ({
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
  submittedByUserId: row.submittedByUserId ?? null,
  submissionMode: row.submissionMode ?? 'self',
  submissionReason: row.submissionReason ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  employee: employee
    ? {
        id: employee.id,
        employeeNum: employee.employeeNum ?? null,
        name: employee.user?.name ?? 'موظف',
        departmentId: employee.departmentId ?? null,
        department: employee.department
          ? { id: employee.department.id, name: employee.department.name }
          : null,
      }
    : null,
});

const notifyLeaveReviewers = async (
  prisma: PrismaClient,
  actor: LeaveOnBehalfUser,
  employee: {
    departmentId: string | null;
    department?: { id: string; managerId: string | null } | null;
    user?: { id: string } | null;
  },
): Promise<void> => {
  const hrUsers = await prisma.user.findMany({
    where: {
      companyId: actor.companyId,
      role: { permissions: { contains: PERMISSIONS.HR_VIEW } },
    },
    select: { id: true },
  });
  for (const hr of hrUsers) {
    await prisma.notification.create({
      data: {
        companyId: actor.companyId,
        userId: hr.id,
        title: 'طلب إجازة جديد',
        message: 'تم تقديم طلب إجازة جديد للإعتماد.',
      },
    });
  }

  if (employee.department?.id) {
    const managerRows = await prisma.departmentManager.findMany({
      where: {
        companyId: actor.companyId,
        departmentId: employee.department.id,
        status: 'active',
      },
      select: { userId: true },
    });
    const managerIds = new Set([
      ...(employee.department.managerId ? [employee.department.managerId] : []),
      ...managerRows.map((row) => row.userId),
    ]);
    for (const managerId of managerIds) {
      if (managerId === actor.id) continue;
      await prisma.notification.create({
        data: {
          companyId: actor.companyId,
          userId: managerId,
          title: 'طلب إجازة جديد في قسمك',
          message: 'تم تقديم طلب إجازة جديد من قبل أحد موظفي قسمك.',
        },
      });
    }
  }

  if (employee.user?.id && employee.user.id !== actor.id) {
    await prisma.notification.create({
      data: {
        companyId: actor.companyId,
        userId: employee.user.id,
        title: 'تم تقديم إجازة نيابة عنك',
        message: 'تم تقديم طلب إجازة نيابة عنك وهو بانتظار المراجعة.',
      },
    });
  }
};

export function registerLeaveOnBehalfRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
}: LeaveOnBehalfRouteDeps): void {
  app.post(
    '/api/v2/leaves/on-behalf',
    requireAuth,
    checkAnyPermission(PERMISSIONS.LEAVES_CREATE_ON_BEHALF),
    route(async (req, res) => {
      validateOptionalIdempotencyKey(req);
      const actor = actorFrom(req);
      const body = parseBody(onBehalfCreateSchema, req.body);

      const employee = await loadTargetEmployee(prisma, actor.companyId, body.employeeId);
      if (!employee) fail(404, 'NotFound', 'leaves.employee_not_found');

      await ensureTargetEmployeeManageable(prisma, actor, employee);

      const totalDays = calcTotalDays(body.startDate, body.endDate);

      if (isAnnualLeave(body.leaveType) && body.exitReentryRequested && !body.visaFeePaid) {
        fail(400, 'InvalidRequest', 'leaves.visa_fee_required');
      }

      await ensureSickLeaveQuota(
        prisma,
        actor.companyId,
        employee.id,
        body.leaveType,
        totalDays,
      );

      const request = await prisma.$transaction(async (tx) => {
        const created = await tx.leaveRequest.create({
          data: {
            id: randomUUID(),
            companyId: actor.companyId,
            employeeId: employee.id,
            leaveType: body.leaveType,
            startDate: new Date(body.startDate),
            endDate: new Date(body.endDate),
            totalDays,
            reason: body.reason ?? null,
            exitReentryRequested: isAnnualLeave(body.leaveType)
              ? body.exitReentryRequested
              : false,
            visaFeePaid: isAnnualLeave(body.leaveType) ? body.visaFeePaid : false,
            status: 'pending_hr',
            submittedByUserId: actor.id,
            submissionMode: 'on_behalf',
            submissionReason: body.submissionReason,
          },
        });

        await writeAuditRequired(tx, {
          companyId: actor.companyId,
          userId: actor.id,
          action: 'leave.submit_on_behalf',
          details: {
            leaveRequestId: created.id,
            employeeId: employee.id,
            leaveType: body.leaveType,
            totalDays,
            submissionMode: 'on_behalf',
            clientActionId: body.clientActionId ?? null,
          },
        });

        return created;
      });

      await notifyLeaveReviewers(prisma, actor, employee);

      return res.status(201).json(shapeLeaveOnBehalfDto(request, employee));
    }),
  );
}
