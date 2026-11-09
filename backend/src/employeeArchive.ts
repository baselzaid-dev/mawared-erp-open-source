import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import {
  canManagePrincipal,
  hasEffectiveCapability,
  loadAuthorizationContext,
  loadPrincipalSummary,
  type AuthorizationContext,
} from './authorization';
import {
  IdentityCollisionError,
  isPrismaUniqueConflict,
  syncLoginIdentities,
} from './identity';
import { PERMISSIONS } from './permissions';

interface ArchiveRouteUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface ArchiveRouteRequest extends Request {
  user?: ArchiveRouteUser;
}

interface EmployeeArchiveRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkPermission: (permission: string) => RequestHandler;
}

class EmployeeArchiveError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

const reasonSchema = z.string().trim().min(3).max(500);

const archiveBodySchema = z.object({
  reason: reasonSchema,
  expectedUpdatedAt: z
    .string()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid expectedUpdatedAt'),
}).strict();

const idempotencyKeySchema = z.string().trim().min(8).max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const fail = (
  status: number,
  code: string,
  messageKey: string,
): never => {
  throw new EmployeeArchiveError(status, code, messageKey);
};

const route = (
  handler: (req: ArchiveRouteRequest, res: Response) => Promise<unknown>,
): RequestHandler => async (request, response, next) => {
  try {
    await handler(request as ArchiveRouteRequest, response);
  } catch (error) {
    if (error instanceof EmployeeArchiveError) {
      return response.status(error.status).json({
        error: error.code,
        code: error.status,
        messageKey: error.messageKey,
      });
    }
    if (error instanceof IdentityCollisionError || isPrismaUniqueConflict(error)) {
      return response.status(409).json({
        error: 'LoginIdentityAlreadyExists',
        code: 409,
        messageKey: 'employees.login_identity_conflict',
      });
    }
    return next(error);
  }
};

const actorFrom = (req: ArchiveRouteRequest): ArchiveRouteUser => {
  if (!req.user?.id || !req.user.companyId) {
    fail(401, 'Unauthorized', 'employees.unauthorized');
  }
  return req.user!;
};

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail(400, 'InvalidRequest', 'employees.invalid_request');
  return parsed.data;
};

const validateOptionalIdempotencyKey = (req: Request): void => {
  const header = req.header('Idempotency-Key');
  if (header == null || header === '') return;
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    fail(400, 'IdempotencyKeyInvalid', 'employees.idempotency_key_invalid');
  }
};

const loadActorContext = async (
  prisma: PrismaClient,
  actor: ArchiveRouteUser,
): Promise<AuthorizationContext> => {
  const context = await loadAuthorizationContext(prisma, {
    userId: actor.id,
    companyId: actor.companyId,
  });
  if (!context) fail(401, 'Unauthorized', 'employees.unauthorized');
  return context!;
};

const rejectManageDecision = (reason: string): never => {
  if (reason === 'self' || reason === 'protected_owner' || reason === 'peer_manager') {
    return fail(403, 'Forbidden', 'employees.archive_forbidden');
  }
  if (reason === 'missing_scope') {
    return fail(403, 'Forbidden', 'employees.archive_forbidden');
  }
  return fail(404, 'NotFound', 'employees.employee_not_found');
};

const canManagePrincipalIncludingInactive = async (
  prisma: PrismaClient,
  actor: AuthorizationContext,
  targetUserId: string,
  departmentId: string | null,
): Promise<{ allowed: boolean; reason: string }> => {
  const target = await loadPrincipalSummary(prisma, {
    companyId: actor.companyId,
    userId: targetUserId,
  });
  if (!target) return { allowed: false, reason: 'unavailable' };
  if (target.userId === actor.userId) return { allowed: false, reason: 'self' };
  if (target.isPrimaryOwner) return { allowed: false, reason: 'protected_owner' };
  if (actor.isPrimaryOwner) return { allowed: true, reason: 'owner' };

  if (target.active) {
    const companyDecision = await canManagePrincipal(prisma, actor, targetUserId, {
      scopeType: 'company',
    });
    if (companyDecision.allowed) return companyDecision;
    if (departmentId) {
      return canManagePrincipal(prisma, actor, targetUserId, {
        scopeType: 'department',
        departmentId,
      });
    }
    return companyDecision;
  }

  const canManageCompany = hasEffectiveCapability(
    actor,
    PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
    { scopeType: 'company' },
  ) && hasEffectiveCapability(
    actor,
    PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
    { scopeType: 'company' },
  );
  if (canManageCompany) {
    const targetContext = await loadAuthorizationContext(prisma, {
      userId: target.userId,
      companyId: actor.companyId,
    });
    if (targetContext) {
      const targetIsCompanyManager = hasEffectiveCapability(
        targetContext,
        PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
        { scopeType: 'company' },
      ) && hasEffectiveCapability(
        targetContext,
        PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
        { scopeType: 'company' },
      );
      if (targetIsCompanyManager && !hasEffectiveCapability(
        actor,
        PERMISSIONS.PRINCIPALS_MANAGE_PEERS,
        { scopeType: 'company' },
      )) {
        return { allowed: false, reason: 'peer_manager' };
      }
    }
    return { allowed: true, reason: 'company' };
  }

  const scopedDepartmentId = departmentId;
  if (scopedDepartmentId) {
    if (target.departmentId !== scopedDepartmentId) {
      return { allowed: false, reason: 'outside_department' };
    }
    const canManage = hasEffectiveCapability(actor, PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE, {
      scopeType: 'department',
      departmentId: scopedDepartmentId,
    }) && hasEffectiveCapability(actor, PERMISSIONS.PERMISSIONS_MANAGE_DEPARTMENT, {
      scopeType: 'department',
      departmentId: scopedDepartmentId,
    });
    if (!canManage) return { allowed: false, reason: 'missing_scope' };

    const actorIsManager = actor.managedDepartmentIds.includes(scopedDepartmentId);
    const targetIsPeer = target.managedDepartmentIds.includes(scopedDepartmentId);
    if (actorIsManager && targetIsPeer && !hasEffectiveCapability(
      actor,
      PERMISSIONS.PRINCIPALS_MANAGE_PEERS,
      { scopeType: 'department', departmentId: scopedDepartmentId },
    )) {
      return { allowed: false, reason: 'peer_manager' };
    }
    return { allowed: true, reason: 'department' };
  }

  return { allowed: false, reason: 'missing_scope' };
};

const assertEmployeeWithoutUserManageable = (
  actor: AuthorizationContext,
  departmentId: string | null,
): void => {
  if (actor.isPrimaryOwner) return;
  if (hasEffectiveCapability(actor, PERMISSIONS.EMPLOYEES_ARCHIVE, { scopeType: 'company' })) {
    return;
  }
  if (
    departmentId
    && actor.managedDepartmentIds.includes(departmentId)
    && hasEffectiveCapability(actor, PERMISSIONS.EMPLOYEES_ARCHIVE, {
      scopeType: 'department',
      departmentId,
    })
  ) {
    return;
  }
  fail(403, 'Forbidden', 'employees.archive_forbidden');
};

const assertArchiveTargetManageable = async (
  prisma: PrismaClient,
  actor: AuthorizationContext,
  employee: {
    id: string;
    departmentId: string | null;
    user: { id: string } | null;
  },
): Promise<void> => {
  if (actor.employeeId && actor.employeeId === employee.id) {
    fail(403, 'Forbidden', 'employees.archive_forbidden');
  }

  if (employee.user) {
    const decision = await canManagePrincipalIncludingInactive(
      prisma,
      actor,
      employee.user.id,
      employee.departmentId,
    );
    if (!decision.allowed) rejectManageDecision(decision.reason);
    return;
  }

  assertEmployeeWithoutUserManageable(actor, employee.departmentId);
};

const assertExpectedUpdatedAt = (
  employee: { updatedAt: Date },
  expectedUpdatedAt: string,
): void => {
  const expectedMs = Date.parse(expectedUpdatedAt);
  if (employee.updatedAt.getTime() !== expectedMs) {
    fail(412, 'StaleEmployeeVersion', 'employees.stale_employee_version');
  }
};

const shapeArchiveEmployee = (employee: {
  id: string;
  companyId: string;
  employeeNum: string;
  jobTitle: string;
  joiningDate: Date;
  status: string;
  departmentId: string | null;
  archivedAt: Date | null;
  archiveReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  user?: {
    id: string;
    name: string;
    email: string;
    accountStatus: string;
    roleId?: string | null;
    role?: { id?: string; name?: string | null } | null;
  } | null;
  department?: { id: string; name: string } | null;
}) => ({
  id: employee.id,
  companyId: employee.companyId,
  employeeNum: employee.employeeNum,
  jobTitle: employee.jobTitle,
  joiningDate: employee.joiningDate,
  status: employee.status,
  departmentId: employee.departmentId ?? null,
  archivedAt: employee.archivedAt?.toISOString() ?? null,
  archiveReason: employee.archiveReason ?? null,
  createdAt: employee.createdAt,
  updatedAt: employee.updatedAt,
  user: employee.user
    ? {
        id: employee.user.id,
        name: employee.user.name,
        email: employee.user.email,
        accountStatus: employee.user.accountStatus,
        roleId: employee.user.roleId ?? employee.user.role?.id ?? null,
        roleName: employee.user.role?.name ?? null,
      }
    : null,
  department: employee.department
    ? { id: employee.department.id, name: employee.department.name }
    : null,
});

const notifyEmployeeArchive = async (
  prisma: PrismaClient,
  companyId: string,
  userId: string,
) => {
  await prisma.notification.create({
    data: {
      companyId,
      userId,
      title: 'تم أرشفة حسابك',
      message: 'تم أرشفة حساب الموظف الخاص بك. تواصل مع مسؤول الشركة إذا كنت تعتقد أن هذا خطأ.',
      category: 'security',
      // Navigation metadata only — never employee ids, credentials, or tokens.
      routeKey: 'employees.profile',
      resourceType: 'security',
    },
  });
};

const notifyEmployeeReactivate = async (
  prisma: PrismaClient,
  companyId: string,
  userId: string,
) => {
  await prisma.notification.create({
    data: {
      companyId,
      userId,
      title: 'تمت إعادة تفعيل حسابك',
      message: 'تمت إعادة تفعيل حساب الموظف الخاص بك. يمكنك تسجيل الدخول مجدداً بعد مراجعة الصلاحيات.',
      category: 'security',
      // Navigation metadata only — never employee ids, credentials, or tokens.
      routeKey: 'employees.profile',
      resourceType: 'security',
    },
  });
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
        email: true,
        accountStatus: true,
        roleId: true,
        role: { select: { id: true, name: true } },
      },
    },
    department: { select: { id: true, name: true } },
  },
});

export async function archiveEmployee(input: {
  prisma: PrismaClient;
  actor: ArchiveRouteUser;
  employeeId: string;
  reason: string;
  expectedUpdatedAt: string;
}) {
  const actorContext = await loadActorContext(input.prisma, input.actor);
  const employee = await loadTargetEmployee(
    input.prisma,
    input.actor.companyId,
    input.employeeId,
  );
  if (!employee) fail(404, 'NotFound', 'employees.employee_not_found');

  if (employee.archivedAt != null) {
    return shapeArchiveEmployee(employee);
  }

  await assertArchiveTargetManageable(input.prisma, actorContext, employee);
  assertExpectedUpdatedAt(employee, input.expectedUpdatedAt);

  const archivedAt = new Date();
  await input.prisma.$transaction(async (tx) => {
    const updated = await tx.employee.updateMany({
      where: {
        id: employee.id,
        companyId: input.actor.companyId,
        updatedAt: employee.updatedAt,
        archivedAt: null,
      },
      data: {
        archivedAt,
        archivedByUserId: input.actor.id,
        archiveReason: input.reason,
        status: 'inactive',
      },
    });
    if (updated.count !== 1) {
      const current = await tx.employee.findFirst({
        where: { id: employee.id, companyId: input.actor.companyId },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              accountStatus: true,
              roleId: true,
              role: { select: { id: true, name: true } },
            },
          },
          department: { select: { id: true, name: true } },
        },
      });
      if (current?.archivedAt != null) return;
      fail(412, 'StaleEmployeeVersion', 'employees.stale_employee_version');
    }

    if (employee.user) {
      await tx.user.update({
        where: { id: employee.user.id },
        data: { accountStatus: 'archived' },
      });
      await tx.refreshToken.updateMany({
        where: {
          userId: employee.user.id,
          companyId: input.actor.companyId,
          revokedAt: null,
        },
        data: {
          revokedAt: archivedAt,
          revokedReason: 'employee_archive',
        },
      });
    }

    await writeAuditRequired(tx, {
      companyId: input.actor.companyId,
      userId: input.actor.id,
      action: 'employee.archive',
      details: {
        employeeId: employee.id,
        targetUserId: employee.user?.id,
        archiveReason: input.reason,
      },
    });

    if (employee.user) {
      await notifyEmployeeArchive(tx as PrismaClient, input.actor.companyId, employee.user.id);
    }
  });

  const refreshed = await loadTargetEmployee(
    input.prisma,
    input.actor.companyId,
    employee.id,
  );
  if (!refreshed) fail(404, 'NotFound', 'employees.employee_not_found');
  return shapeArchiveEmployee(refreshed);
}

export async function reactivateEmployee(input: {
  prisma: PrismaClient;
  actor: ArchiveRouteUser;
  employeeId: string;
  reason: string;
  expectedUpdatedAt: string;
}) {
  const actorContext = await loadActorContext(input.prisma, input.actor);
  const employee = await loadTargetEmployee(
    input.prisma,
    input.actor.companyId,
    input.employeeId,
  );
  if (!employee) fail(404, 'NotFound', 'employees.employee_not_found');
  if (employee.archivedAt == null) {
    fail(409, 'NotArchived', 'employees.not_archived');
  }

  await assertArchiveTargetManageable(input.prisma, actorContext, employee);
  assertExpectedUpdatedAt(employee, input.expectedUpdatedAt);

  await input.prisma.$transaction(async (tx) => {
    const updated = await tx.employee.updateMany({
      where: {
        id: employee.id,
        companyId: input.actor.companyId,
        updatedAt: employee.updatedAt,
        archivedAt: { not: null },
      },
      data: {
        archivedAt: null,
        archivedByUserId: null,
        archiveReason: null,
        status: 'active',
      },
    });
    if (updated.count !== 1) {
      fail(412, 'StaleEmployeeVersion', 'employees.stale_employee_version');
    }

    if (employee.user) {
      if (employee.user.accountStatus === 'archived' || employee.user.accountStatus === 'disabled') {
        await tx.user.update({
          where: { id: employee.user.id },
          data: { accountStatus: 'active' },
        });
      }
      await syncLoginIdentities(tx, {
        companyId: input.actor.companyId,
        userId: employee.user.id,
        email: employee.user.email,
        employeeNumber: employee.employeeNum,
      });
    }

    await writeAuditRequired(tx, {
      companyId: input.actor.companyId,
      userId: input.actor.id,
      action: 'employee.reactivate',
      details: {
        employeeId: employee.id,
        targetUserId: employee.user?.id,
        archiveReason: input.reason,
      },
    });

    if (employee.user) {
      await notifyEmployeeReactivate(tx as PrismaClient, input.actor.companyId, employee.user.id);
    }
  });

  const refreshed = await loadTargetEmployee(
    input.prisma,
    input.actor.companyId,
    employee.id,
  );
  if (!refreshed) fail(404, 'NotFound', 'employees.employee_not_found');
  return shapeArchiveEmployee(refreshed);
}

export function registerEmployeeArchiveRoutes({
  app,
  prisma,
  requireAuth,
  checkPermission,
}: EmployeeArchiveRouteDeps): void {
  app.post(
    '/api/v2/employees/:id/archive',
    requireAuth,
    checkPermission(PERMISSIONS.EMPLOYEES_ARCHIVE),
    route(async (req, res) => {
      validateOptionalIdempotencyKey(req);
      const actor = actorFrom(req);
      const body = parseBody(archiveBodySchema, req.body);
      const employeeId = String(req.params.id ?? '').trim();
      if (!employeeId) fail(400, 'InvalidRequest', 'employees.invalid_request');

      const dto = await archiveEmployee({
        prisma,
        actor,
        employeeId,
        reason: body.reason,
        expectedUpdatedAt: body.expectedUpdatedAt,
      });
      return res.status(200).json(dto);
    }),
  );

  app.post(
    '/api/v2/employees/:id/reactivate',
    requireAuth,
    checkPermission(PERMISSIONS.EMPLOYEES_ARCHIVE),
    route(async (req, res) => {
      validateOptionalIdempotencyKey(req);
      const actor = actorFrom(req);
      const body = parseBody(archiveBodySchema, req.body);
      const employeeId = String(req.params.id ?? '').trim();
      if (!employeeId) fail(400, 'InvalidRequest', 'employees.invalid_request');

      const dto = await reactivateEmployee({
        prisma,
        actor,
        employeeId,
        reason: body.reason,
        expectedUpdatedAt: body.expectedUpdatedAt,
      });
      return res.status(200).json(dto);
    }),
  );
}

export {
  archiveBodySchema,
};
