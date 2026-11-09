import { randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import {
  generateTemporaryPassword,
  hashPassword,
  shapeOneTimeCredentialDto,
  temporaryPasswordExpiresAt,
} from './credentialSecrets';
import { loadManagedDepartmentIds } from './authorization';
import {
  IdentityCollisionError,
  IdentityInputError,
  isPrismaUniqueConflict,
  loginIdentityValues,
  normalizeEmail,
  syncLoginIdentities,
} from './identity';
import { PERMISSIONS } from './permissions';

interface CredentialRouteUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface CredentialRouteRequest extends Request {
  user?: CredentialRouteUser;
}

interface EmployeeCredentialRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
}

class EmployeeCredentialError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
    readonly detail?: string,
  ) {
    super(messageKey);
  }
}

const createCredentialSchema = z.object({
  email: z.string().trim().min(1).max(320),
}).strict();

const fail = (
  status: number,
  code: string,
  messageKey: string,
  detail?: string,
): never => {
  throw new EmployeeCredentialError(status, code, messageKey, detail);
};

const route = (
  handler: (req: CredentialRouteRequest, res: Response) => Promise<unknown>,
): RequestHandler => async (request, response, next) => {
  try {
    await handler(request as CredentialRouteRequest, response);
  } catch (error) {
    if (error instanceof EmployeeCredentialError) {
      return response.status(error.status).json({
        error: error.code,
        code: error.status,
        message: error.detail ?? error.messageKey,
        messageKey: error.messageKey,
      });
    }
    if (error instanceof IdentityInputError) {
      return response.status(400).json({
        error: 'InvalidRequest',
        code: 400,
        message: error.message,
        messageKey: 'employees.invalid_request',
      });
    }
    if (error instanceof IdentityCollisionError || isPrismaUniqueConflict(error)) {
      return response.status(409).json({
        error: 'LoginIdentityAlreadyExists',
        code: 409,
        message: 'Login identity is already reserved',
        messageKey: 'employees.login_identity_conflict',
      });
    }
    return next(error);
  }
};

const actorFrom = (req: CredentialRouteRequest): CredentialRouteUser => {
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

const hasPermission = (permissions: string[], permission: string): boolean =>
  permissions.includes(PERMISSIONS.ADMIN_FULL) || permissions.includes(permission);

const hasCompanyEmployeeScope = (permissions: string[]): boolean =>
  hasPermission(permissions, PERMISSIONS.EMPLOYEES_VIEW);

const hasDepartmentEmployeeScope = (permissions: string[]): boolean =>
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
        role: { select: { permissions: true } },
      },
    },
    department: {
      select: { id: true },
    },
  },
});

const ensureTargetEmployeeManageable = async (
  prisma: PrismaClient,
  actor: CredentialRouteUser,
  employee: {
    id: string;
    status: string;
    archivedAt: Date | null;
    departmentId: string | null;
    user: { id: string } | null;
  },
): Promise<void> => {
  if (employee.archivedAt != null) {
    fail(404, 'NotFound', 'employees.employee_not_found');
  }

  if (employee.status.toLowerCase() !== 'active') {
    fail(409, 'InactiveEmployee', 'employees.inactive_employee');
  }

  if (employee.user) {
    fail(409, 'CredentialAlreadyExists', 'employees.credential_already_exists');
  }

  if (hasCompanyEmployeeScope(actor.permissions)) return;

  if (!hasDepartmentEmployeeScope(actor.permissions)) {
    fail(403, 'Forbidden', 'employees.forbidden');
  }

  const managedDepartmentIds = await loadManagedDepartmentIds(prisma, {
    companyId: actor.companyId,
    userId: actor.id,
  });
  if (!employee.departmentId || !managedDepartmentIds.includes(employee.departmentId)) {
    fail(403, 'Forbidden', 'employees.forbidden');
  }
};

const resolveDefaultEmployeeRole = async (
  prisma: PrismaClient,
  companyId: string,
) => {
  const role = await prisma.role.findFirst({
    where: { companyId, name: 'Employee' },
    select: { id: true, permissions: true },
  });
  if (!role) {
    fail(400, 'InvalidRequest', 'employees.default_role_missing');
  }
  if (parseRolePermissions(role.permissions).includes(PERMISSIONS.ADMIN_FULL)) {
    fail(403, 'Forbidden', 'employees.admin_role_forbidden');
  }
  return role;
};

export function registerEmployeeCredentialRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
}: EmployeeCredentialRouteDeps): void {
  app.post(
    '/api/v2/employees/:id/credentials',
    requireAuth,
    checkAnyPermission(PERMISSIONS.EMPLOYEES_CREDENTIALS_CREATE),
    route(async (req, res) => {
      const actor = actorFrom(req);
      const body = parseBody(createCredentialSchema, req.body);
      const employeeId = String(req.params.id ?? '').trim();
      if (!employeeId) fail(400, 'InvalidRequest', 'employees.invalid_request');

      const employee = await loadTargetEmployee(prisma, actor.companyId, employeeId);
      if (!employee) fail(404, 'NotFound', 'employees.employee_not_found');

      await ensureTargetEmployeeManageable(prisma, actor, employee);

      const email = normalizeEmail(body.email);
      const normalizedEmail = email;
      const employeeRole = await resolveDefaultEmployeeRole(prisma, actor.companyId);

      const { emailIdentifier, employeeNumberIdentifier } = loginIdentityValues(
        email,
        employee.employeeNum,
      );
      const identityCollision = await prisma.loginIdentity.findFirst({
        where: {
          companyId: actor.companyId,
          normalizedIdentifier: { in: [emailIdentifier, employeeNumberIdentifier] },
        },
        select: { id: true },
      });
      if (identityCollision) {
        fail(409, 'LoginIdentityAlreadyExists', 'employees.login_identity_conflict');
      }

      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hashPassword(temporaryPassword.reveal());
      const expiresAt = temporaryPasswordExpiresAt();
      const credentialVersion = 1;
      const passwordChangedAt = new Date();

      await prisma.$transaction(async (tx) => {
        const current = await tx.employee.findFirst({
          where: { id: employee.id, companyId: actor.companyId },
          include: { user: { select: { id: true } } },
        });
        if (!current) fail(404, 'NotFound', 'employees.employee_not_found');
        if (current.user) {
          fail(409, 'CredentialAlreadyExists', 'employees.credential_already_exists');
        }

        const user = await tx.user.create({
          data: {
            id: randomUUID(),
            companyId: actor.companyId,
            employeeId: employee.id,
            email,
            normalizedEmail,
            password: passwordHash,
            name: employee.jobTitle?.trim() || employee.employeeNum,
            roleId: employeeRole.id,
            accountStatus: 'active',
            mustChangePassword: true,
            temporaryPasswordExpiresAt: expiresAt,
            credentialVersion,
            passwordChangedAt,
          },
        });

        await syncLoginIdentities(tx, {
          companyId: actor.companyId,
          userId: user.id,
          email,
          employeeNumber: employee.employeeNum,
        });

        await writeAuditRequired(tx, {
          companyId: actor.companyId,
          userId: actor.id,
          action: 'employee.credentials.create',
          details: {
            employeeId: employee.id,
            userId: user.id,
          },
        });

        return user;
      });

      return res.status(201).json(
        shapeOneTimeCredentialDto(temporaryPassword, credentialVersion, expiresAt),
      );
    }),
  );
}
