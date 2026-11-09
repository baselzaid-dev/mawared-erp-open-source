import type { Prisma } from '@prisma/client';
import {
  canManagePrincipal,
  loadAuthorizationContext,
  type AuthorizationContext,
  type AuthorizationDb,
} from './authorization';
import { PERMISSIONS } from './permissions';

export type CredentialResetAuthDb = AuthorizationDb;

export class CredentialResetAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

const fail = (
  status: number,
  code: string,
  messageKey: string,
): never => {
  throw new CredentialResetAuthError(status, code, messageKey);
};

type LockedEmployeeState = {
  id: string;
  companyId: string;
  departmentId: string | null;
  status: string;
  archivedAt: Date | null;
  user: {
    id: string;
    companyId: string;
    employeeId: string | null;
    accountStatus: string;
    credentialVersion: number;
    password: string;
    authorizationVersion: number;
  } | null;
};

type LockedActorState = {
  id: string;
  accountStatus: string;
  authorizationVersion: number;
  employee: { status: string; archivedAt: Date | null } | null;
};

/**
 * Transaction-scoped advisory lock for company + employee credential reset.
 * Production / disposable PostgreSQL always executes this.
 * Unit-test doubles may provide a no-op `$executeRaw` mock.
 */
export async function acquireEmployeeCredentialResetLock(
  tx: Prisma.TransactionClient,
  companyId: string,
  employeeId: string,
): Promise<void> {
  if (typeof tx.$executeRaw !== 'function') {
    throw new CredentialResetAuthError(
      500,
      'InternalError',
      'credentials.reset_failed',
    );
  }
  const key = `mawared-e2-credential-reset:${companyId}:${employeeId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

async function lockEmployeeRow(
  tx: Prisma.TransactionClient,
  employeeId: string,
  companyId: string,
): Promise<void> {
  if (typeof tx.$queryRaw !== 'function') {
    throw new CredentialResetAuthError(
      500,
      'InternalError',
      'credentials.reset_failed',
    );
  }
  await tx.$queryRaw`
    SELECT id
    FROM "Employee"
    WHERE id = ${employeeId}
      AND "companyId" = ${companyId}
    FOR UPDATE
  `;
}

async function lockUserRow(
  tx: Prisma.TransactionClient,
  userId: string,
  companyId: string,
): Promise<void> {
  if (typeof tx.$queryRaw !== 'function') {
    throw new CredentialResetAuthError(
      500,
      'InternalError',
      'credentials.reset_failed',
    );
  }
  await tx.$queryRaw`
    SELECT id
    FROM "User"
    WHERE id = ${userId}
      AND "companyId" = ${companyId}
    FOR UPDATE
  `;
}

async function loadEmployeeState(
  tx: CredentialResetAuthDb,
  employeeId: string,
  companyId: string,
): Promise<LockedEmployeeState | null> {
  const employee = await tx.employee.findFirst({
    where: { id: employeeId, companyId },
    select: {
      id: true,
      companyId: true,
      departmentId: true,
      status: true,
      archivedAt: true,
      user: {
        select: {
          id: true,
          companyId: true,
          employeeId: true,
          accountStatus: true,
          credentialVersion: true,
          password: true,
          authorizationVersion: true,
        },
      },
    },
  });
  return employee;
}

async function loadActorState(
  tx: CredentialResetAuthDb,
  actorUserId: string,
  companyId: string,
): Promise<LockedActorState | null> {
  return tx.user.findFirst({
    where: { id: actorUserId, companyId },
    select: {
      id: true,
      accountStatus: true,
      authorizationVersion: true,
      employee: { select: { status: true, archivedAt: true } },
    },
  });
}

function mapManageDenial(reason: string): never {
  if (
    reason === 'self'
    || reason === 'protected_owner'
    || reason === 'peer_manager'
    || reason === 'missing_scope'
    || reason === 'outside_department'
  ) {
    return fail(403, 'Forbidden', 'credentials.reset_forbidden');
  }
  return fail(404, 'NotFound', 'credentials.employee_not_found');
}

function assertActiveEmployeeTarget(employee: LockedEmployeeState): asserts employee is LockedEmployeeState & {
  user: NonNullable<LockedEmployeeState['user']>;
} {
  if (!employee) {
    fail(404, 'NotFound', 'credentials.employee_not_found');
  }
  if (employee.archivedAt != null) {
    fail(404, 'NotFound', 'credentials.employee_not_found');
  }
  if (employee.status.toLowerCase() !== 'active') {
    fail(404, 'NotFound', 'credentials.employee_not_found');
  }
  if (!employee.user) {
    fail(404, 'NotFound', 'credentials.employee_not_found');
  }
  if (
    employee.user.companyId !== employee.companyId
    || employee.user.employeeId !== employee.id
  ) {
    fail(404, 'NotFound', 'credentials.employee_not_found');
  }
  if (employee.user.accountStatus !== 'active') {
    fail(404, 'NotFound', 'credentials.employee_not_found');
  }
}

function assertActiveActor(actor: LockedActorState | null): asserts actor is LockedActorState {
  if (!actor || actor.accountStatus !== 'active') {
    fail(401, 'Unauthorized', 'credentials.unauthorized');
  }
  if (
    actor.employee
    && (actor.employee.archivedAt != null || actor.employee.status.toLowerCase() !== 'active')
  ) {
    fail(401, 'Unauthorized', 'credentials.unauthorized');
  }
}

/**
 * Whether the transaction-loaded actor context currently holds reset capability.
 * JWT/request permission arrays are never consulted here.
 */
export function actorHasCredentialResetPermission(actorContext: AuthorizationContext): boolean {
  return actorContext.isPrimaryOwner
    || actorContext.flatPermissions.includes(PERMISSIONS.ADMIN_FULL)
    || actorContext.flatPermissions.includes(PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET)
    || actorContext.baselinePermissions.includes(PERMISSIONS.ADMIN_FULL)
    || actorContext.baselinePermissions.includes(PERMISSIONS.EMPLOYEES_CREDENTIALS_RESET);
}

export interface CredentialResetAuthorizedTarget {
  employeeId: string;
  departmentId: string | null;
  targetUserId: string;
  credentialVersion: number;
  passwordHash: string;
  actorContext: AuthorizationContext;
  actorAuthorizationVersion: number;
}

/**
 * Authoritative in-transaction authorization for Track D admin reset.
 *
 * Lock order (after advisory lock on company+employeeId):
 * 1. Employee row
 * 2. Target User row
 * 3. Actor User row
 * Then reload all authoritative state and decide from post-lock evidence only.
 *
 * Actor User FOR UPDATE serializes against RC2 authorization mutations that
 * increment the actor's authorizationVersion (grants, delegations, manager
 * assignment/revocation, permission apply).
 */
export async function authorizeEmployeeCredentialResetInTransaction(
  tx: CredentialResetAuthDb,
  input: {
    actorUserId: string;
    actorCompanyId: string;
    employeeId: string;
  },
): Promise<CredentialResetAuthorizedTarget> {
  const prismaTx = tx as Prisma.TransactionClient;

  // 1) Lock Employee first (existence checked only after lock).
  await lockEmployeeRow(prismaTx, input.employeeId, input.actorCompanyId);
  const employeeAfterEmployeeLock = await loadEmployeeState(
    tx,
    input.employeeId,
    input.actorCompanyId,
  );
  if (!employeeAfterEmployeeLock) {
    fail(404, 'NotFound', 'credentials.employee_not_found');
  }
  assertActiveEmployeeTarget(employeeAfterEmployeeLock);

  // 2) Lock linked target User, then actor User.
  await lockUserRow(prismaTx, employeeAfterEmployeeLock.user.id, input.actorCompanyId);
  await lockUserRow(prismaTx, input.actorUserId, input.actorCompanyId);

  // 3) Reload authoritative state only after all required row locks are held.
  const employee = await loadEmployeeState(tx, input.employeeId, input.actorCompanyId);
  if (!employee || employee.companyId !== input.actorCompanyId) {
    fail(404, 'NotFound', 'credentials.employee_not_found');
  }
  assertActiveEmployeeTarget(employee);

  const actorUser = await loadActorState(tx, input.actorUserId, input.actorCompanyId);
  assertActiveActor(actorUser);

  // Authorization evidence is loaded only after the actor User row lock.
  const actorContext = await loadAuthorizationContext(tx, {
    userId: input.actorUserId,
    companyId: input.actorCompanyId,
  });
  if (!actorContext) {
    fail(401, 'Unauthorized', 'credentials.unauthorized');
  }

  // Fence: context version must match the locked actor row (mutations bump it).
  if (actorContext.authorizationVersion !== actorUser.authorizationVersion) {
    fail(403, 'Forbidden', 'credentials.reset_forbidden');
  }

  if (!actorHasCredentialResetPermission(actorContext)) {
    fail(403, 'Forbidden', 'credentials.reset_forbidden');
  }

  const companyDecision = await canManagePrincipal(tx, actorContext, employee.user.id, {
    scopeType: 'company',
  });
  if (companyDecision.allowed) {
    return {
      employeeId: employee.id,
      departmentId: employee.departmentId,
      targetUserId: employee.user.id,
      credentialVersion: employee.user.credentialVersion,
      passwordHash: employee.user.password,
      actorContext,
      actorAuthorizationVersion: actorUser.authorizationVersion,
    };
  }

  if (employee.departmentId) {
    const departmentDecision = await canManagePrincipal(tx, actorContext, employee.user.id, {
      scopeType: 'department',
      departmentId: employee.departmentId,
    });
    if (departmentDecision.allowed) {
      return {
        employeeId: employee.id,
        departmentId: employee.departmentId,
        targetUserId: employee.user.id,
        credentialVersion: employee.user.credentialVersion,
        passwordHash: employee.user.password,
        actorContext,
        actorAuthorizationVersion: actorUser.authorizationVersion,
      };
    }
    return mapManageDenial(departmentDecision.reason);
  }

  return mapManageDenial(companyDecision.reason);
}
