import type { Prisma, PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, PERMISSIONS, isCanonicalPermission } from './permissions';

export type AuthorizationDb = PrismaClient | Prisma.TransactionClient;
export type AuthorizationScopeType = 'company' | 'department' | 'own';

export interface CapabilityScope {
  capability: string;
  scopeType: AuthorizationScopeType;
  departmentId: string | null;
  source: 'role' | 'ownership' | 'grant' | 'delegation';
  sourceId?: string;
  validUntil?: Date;
}

export interface AuthorizationContext {
  userId: string;
  companyId: string;
  employeeId: string | null;
  employeeDepartmentId: string | null;
  authorizationVersion: number;
  isPrimaryOwner: boolean;
  managedDepartmentIds: string[];
  baselinePermissions: string[];
  capabilities: CapabilityScope[];
  flatPermissions: string[];
}

export interface PrincipalSummary {
  userId: string;
  employeeId: string | null;
  departmentId: string | null;
  name: string;
  active: boolean;
  authorizationVersion: number;
  isPrimaryOwner: boolean;
  managedDepartmentIds: string[];
}

/**
 * Dual-read Manager scope while the legacy Department.managerId field remains.
 * M02 backfills DepartmentManager, and this union prevents a rollout window from
 * dropping either the old single Manager or a newly assigned additional one.
 */
export async function loadManagedDepartmentIds(
  db: AuthorizationDb,
  input: { companyId: string; userId: string },
): Promise<string[]> {
  // Some isolated unit-test clients and the short pre-M02 compatibility window
  // expose only the legacy Department delegate. Production Prisma after M02
  // always takes the membership branch as well.
  const membershipDelegate = (db as AuthorizationDb & {
    departmentManager?: AuthorizationDb['departmentManager'];
  }).departmentManager;
  const [legacyRows, membershipRows] = await Promise.all([
    db.department.findMany({
      where: { companyId: input.companyId, managerId: input.userId },
      select: { id: true },
    }),
    membershipDelegate
      ? membershipDelegate.findMany({
          where: { companyId: input.companyId, userId: input.userId, status: 'active' },
          select: { departmentId: true },
        })
      : Promise.resolve([]),
  ]);
  return [...new Set([
    ...legacyRows.map((row) => row.id),
    ...membershipRows.map((row) => row.departmentId),
  ])].sort();
}

const OWNER_IMPLICIT_CAPABILITIES = new Set<string>([
  PERMISSIONS.ADMIN_FULL,
  PERMISSIONS.COMPANY_OWNER_TRANSFER,
  PERMISSIONS.COMPANY_ADMIN_DELEGATE,
  PERMISSIONS.COMPANY_SETTINGS_MANAGE,
  PERMISSIONS.COMPANY_SESSIONS_MANAGE,
  PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
  PERMISSIONS.PERMISSIONS_DELEGATE_TEMPORARY,
  PERMISSIONS.PRINCIPALS_MANAGE_PEERS,
  PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
]);

const ADMIN_FULL_EXCLUSIONS = new Set<string>([
  PERMISSIONS.COMPANY_OWNER_TRANSFER,
  PERMISSIONS.COMPANY_ADMIN_DELEGATE,
  PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
  PERMISSIONS.PRINCIPALS_MANAGE_PEERS,
  PERMISSIONS.SALARY_VIEW_OWNER,
]);

const NON_DELEGABLE_CAPABILITIES = new Set<string>([
  PERMISSIONS.ADMIN_FULL,
  PERMISSIONS.COMPANY_OWNER_TRANSFER,
  PERMISSIONS.COMPANY_ADMIN_DELEGATE,
  PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
  PERMISSIONS.PRINCIPALS_MANAGE_PEERS,
  PERMISSIONS.SALARY_VIEW_OWNER,
]);

/**
 * Department-scoped grants are currently consumed only by the scoped
 * authorization-management routes. Legacy module routes still receive a flat
 * permission list, so accepting their broad capabilities at Department scope
 * would either do nothing or accidentally widen them to the whole Company.
 */
const DEPARTMENT_SCOPED_GRANT_CAPABILITIES = new Set<string>([
  PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
  PERMISSIONS.PERMISSIONS_MANAGE_DEPARTMENT,
  PERMISSIONS.PERMISSIONS_DELEGATE_TEMPORARY,
  PERMISSIONS.PRINCIPALS_MANAGE_PEERS,
]);

export function isCapabilityAllowedAtScope(
  capability: string,
  scopeType: 'company' | 'department',
): boolean {
  return isCanonicalPermission(capability) && (
    scopeType === 'company' || DEPARTMENT_SCOPED_GRANT_CAPABILITIES.has(capability)
  );
}

export function parseRolePermissions(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(
      (permission): permission is string =>
        typeof permission === 'string' && isCanonicalPermission(permission),
    ))];
  } catch {
    return [];
  }
}

const roleScope = (
  capability: string,
  managedDepartmentIds: string[],
  baselinePermissions: string[],
): Array<Pick<CapabilityScope, 'scopeType' | 'departmentId'>> => {
  if (capability.endsWith('_own')) {
    return [{ scopeType: 'own', departmentId: null }];
  }
  if (capability.includes('_department') || capability.endsWith('.manage_department')) {
    return managedDepartmentIds.map((departmentId) => ({
      scopeType: 'department' as const,
      departmentId,
    }));
  }
  const isDepartmentManagementRole =
    baselinePermissions.includes(PERMISSIONS.PERMISSIONS_MANAGE_DEPARTMENT) &&
    !baselinePermissions.includes(PERMISSIONS.PERMISSIONS_MANAGE_COMPANY);
  if (isDepartmentManagementRole && DEPARTMENT_SCOPED_GRANT_CAPABILITIES.has(capability)) {
    return managedDepartmentIds.map((departmentId) => ({
      scopeType: 'department' as const,
      departmentId,
    }));
  }
  return [{ scopeType: 'company', departmentId: null }];
};

export async function loadAuthorizationContext(
  db: AuthorizationDb,
  input: { userId: string; companyId: string; now?: Date },
): Promise<AuthorizationContext | null> {
  const now = input.now ?? new Date();
  const user = await db.user.findFirst({
    where: { id: input.userId, companyId: input.companyId },
    select: {
      id: true,
      companyId: true,
      employeeId: true,
      authorizationVersion: true,
      role: { select: { permissions: true } },
      employee: { select: { departmentId: true, status: true } },
    },
  });
  if (!user) return null;
  if (user.employee && user.employee.status !== 'active') return null;

  const [ownership, managerRows, accessGrants, delegations] = await Promise.all([
    db.companyOwnership.findFirst({
      where: {
        companyId: input.companyId,
        userId: input.userId,
        isPrimary: true,
        status: 'active',
      },
      select: { id: true },
    }),
    loadManagedDepartmentIds(db, input).then((departmentIds) =>
      departmentIds.map((departmentId) => ({ departmentId }))),
    db.accessGrant.findMany({
      where: { companyId: input.companyId, recipientUserId: input.userId, status: 'active' },
      select: {
        id: true,
        capability: true,
        scopeType: true,
        departmentId: true,
      },
    }),
    db.temporaryDelegation.findMany({
      where: {
        companyId: input.companyId,
        recipientUserId: input.userId,
        status: 'active',
        validFrom: { lte: now },
        validUntil: { gt: now },
      },
      select: {
        id: true,
        scopeType: true,
        departmentId: true,
        validUntil: true,
        capabilities: { select: { capability: true } },
      },
    }),
  ]);

  const managedDepartmentIds = [...new Set(managerRows.map((row) => row.departmentId))].sort();
  const baselinePermissions = parseRolePermissions(user.role.permissions);
  const capabilities: CapabilityScope[] = [];

  for (const capability of baselinePermissions) {
    for (const scope of roleScope(capability, managedDepartmentIds, baselinePermissions)) {
      capabilities.push({ capability, ...scope, source: 'role' });
    }
  }
  if (ownership) {
    for (const capability of OWNER_IMPLICIT_CAPABILITIES) {
      capabilities.push({
        capability,
        scopeType: 'company',
        departmentId: null,
        source: 'ownership',
        sourceId: ownership.id,
      });
    }
  }
  for (const grant of accessGrants) {
    if (grant.scopeType !== 'company' && grant.scopeType !== 'department') continue;
    if (!isCapabilityAllowedAtScope(grant.capability, grant.scopeType)) continue;
    if (grant.scopeType === 'department' && !grant.departmentId) continue;
    capabilities.push({
      capability: grant.capability,
      scopeType: grant.scopeType,
      departmentId: grant.departmentId,
      source: 'grant',
      sourceId: grant.id,
    });
  }
  for (const delegation of delegations) {
    if (delegation.scopeType !== 'company' && delegation.scopeType !== 'department') continue;
    if (delegation.scopeType === 'department' && !delegation.departmentId) continue;
    for (const item of delegation.capabilities) {
      if (!isCapabilityAllowedAtScope(item.capability, delegation.scopeType)) continue;
      capabilities.push({
        capability: item.capability,
        scopeType: delegation.scopeType,
        departmentId: delegation.departmentId,
        source: 'delegation',
        sourceId: delegation.id,
        validUntil: delegation.validUntil,
      });
    }
  }

  const flatPermissions = [...new Set([
    ...baselinePermissions,
    ...capabilities
      .filter((item) => item.scopeType === 'company')
      .map((item) => item.capability),
  ])];

  return {
    userId: user.id,
    companyId: user.companyId,
    employeeId: user.employeeId,
    employeeDepartmentId: user.employee?.departmentId ?? null,
    authorizationVersion: user.authorizationVersion,
    isPrimaryOwner: Boolean(ownership),
    managedDepartmentIds,
    baselinePermissions,
    capabilities,
    flatPermissions,
  };
}

export function scopeCovers(
  held: Pick<CapabilityScope, 'scopeType' | 'departmentId'>,
  requested: { scopeType: 'company' | 'department'; departmentId: string | null },
): boolean {
  if (held.scopeType === 'company') return true;
  return requested.scopeType === 'department' &&
    held.scopeType === 'department' &&
    held.departmentId === requested.departmentId;
}

export function hasEffectiveCapability(
  context: AuthorizationContext,
  capability: string,
  requested: { scopeType: 'company' | 'department'; departmentId?: string | null },
): boolean {
  const normalizedScope = {
    scopeType: requested.scopeType,
    departmentId: requested.scopeType === 'department' ? requested.departmentId ?? null : null,
  } as const;
  if (normalizedScope.scopeType === 'department' && !normalizedScope.departmentId) return false;

  if (context.isPrimaryOwner && OWNER_IMPLICIT_CAPABILITIES.has(capability)) return true;
  if (context.capabilities.some(
    (item) => item.capability === capability && scopeCovers(item, normalizedScope),
  )) return true;

  const adminAtCompany = context.capabilities.some(
    (item) => item.capability === PERMISSIONS.ADMIN_FULL && item.scopeType === 'company',
  );
  return adminAtCompany && !ADMIN_FULL_EXCLUSIONS.has(capability);
}

export function canTemporarilyDelegate(capability: string): boolean {
  return isCanonicalPermission(capability) && !NON_DELEGABLE_CAPABILITIES.has(capability);
}

export function grantableCapabilities(
  context: AuthorizationContext,
  requested: { scopeType: 'company' | 'department'; departmentId?: string | null },
): string[] {
  return ALL_PERMISSIONS.filter((capability) =>
    capability !== PERMISSIONS.COMPANY_OWNER_TRANSFER &&
    capability !== PERMISSIONS.ADMIN_FULL &&
    isCapabilityAllowedAtScope(capability, requested.scopeType) &&
    hasEffectiveCapability(context, capability, requested),
  ).sort();
}

export async function loadPrincipalSummary(
  db: AuthorizationDb,
  input: { companyId: string; userId: string },
): Promise<PrincipalSummary | null> {
  const user = await db.user.findFirst({
    where: { id: input.userId, companyId: input.companyId },
    select: {
      id: true,
      name: true,
      employeeId: true,
      authorizationVersion: true,
      employee: { select: { departmentId: true, status: true } },
    },
  });
  if (!user) return null;
  const [ownership, managerRows] = await Promise.all([
    db.companyOwnership.findFirst({
      where: {
        companyId: input.companyId,
        userId: input.userId,
        isPrimary: true,
        status: 'active',
      },
      select: { id: true },
    }),
    loadManagedDepartmentIds(db, input).then((departmentIds) =>
      departmentIds.map((departmentId) => ({ departmentId }))),
  ]);
  return {
    userId: user.id,
    employeeId: user.employeeId,
    departmentId: user.employee?.departmentId ?? null,
    name: user.name,
    active: !user.employee || user.employee.status === 'active',
    authorizationVersion: user.authorizationVersion,
    isPrimaryOwner: Boolean(ownership),
    managedDepartmentIds: [...new Set(managerRows.map((row) => row.departmentId))].sort(),
  };
}

export async function canManagePrincipal(
  db: AuthorizationDb,
  actor: AuthorizationContext,
  targetUserId: string,
  requested: { scopeType: 'company' | 'department'; departmentId?: string | null },
): Promise<{ allowed: boolean; target: PrincipalSummary | null; reason: string }> {
  const target = await loadPrincipalSummary(db, {
    companyId: actor.companyId,
    userId: targetUserId,
  });
  if (!target || !target.active) return { allowed: false, target, reason: 'unavailable' };
  if (target.userId === actor.userId) return { allowed: false, target, reason: 'self' };
  if (target.isPrimaryOwner) return { allowed: false, target, reason: 'protected_owner' };
  if (actor.isPrimaryOwner) return { allowed: true, target, reason: 'owner' };

  const departmentId = requested.scopeType === 'department'
    ? requested.departmentId ?? null
    : null;
  if (requested.scopeType === 'department') {
    if (!departmentId || target.departmentId !== departmentId) {
      return { allowed: false, target, reason: 'outside_department' };
    }
    const canManage = hasEffectiveCapability(actor, PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE, {
      scopeType: 'department',
      departmentId,
    }) && hasEffectiveCapability(actor, PERMISSIONS.PERMISSIONS_MANAGE_DEPARTMENT, {
      scopeType: 'department',
      departmentId,
    });
    if (!canManage) return { allowed: false, target, reason: 'missing_scope' };

    const actorIsManager = actor.managedDepartmentIds.includes(departmentId);
    const targetIsPeer = target.managedDepartmentIds.includes(departmentId);
    if (actorIsManager && targetIsPeer && !hasEffectiveCapability(
      actor,
      PERMISSIONS.PRINCIPALS_MANAGE_PEERS,
      { scopeType: 'department', departmentId },
    )) {
      return { allowed: false, target, reason: 'peer_manager' };
    }
    return { allowed: true, target, reason: 'department' };
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
    const targetContext = await loadAuthorizationContext(db, {
      userId: target.userId,
      companyId: actor.companyId,
    });
    const targetIsCompanyManager = Boolean(targetContext) && hasEffectiveCapability(
      targetContext!,
      PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
      { scopeType: 'company' },
    ) && hasEffectiveCapability(
      targetContext!,
      PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
      { scopeType: 'company' },
    );
    if (targetIsCompanyManager && !hasEffectiveCapability(
      actor,
      PERMISSIONS.PRINCIPALS_MANAGE_PEERS,
      { scopeType: 'company' },
    )) {
      return { allowed: false, target, reason: 'peer_manager' };
    }
  }
  return {
    allowed: canManageCompany,
    target,
    reason: canManageCompany ? 'company' : 'missing_scope',
  };
}

export async function loadPrimaryOwnerUserId(
  db: AuthorizationDb,
  companyId: string,
): Promise<string | null> {
  const owner = await db.companyOwnership.findFirst({
    where: { companyId, isPrimary: true, status: 'active' },
    select: { userId: true },
  });
  return owner?.userId ?? null;
}

export async function isPrimaryOwner(
  db: AuthorizationDb,
  companyId: string,
  userId: string,
): Promise<boolean> {
  const owner = await db.companyOwnership.findFirst({
    where: { companyId, userId, isPrimary: true, status: 'active' },
    select: { id: true },
  });
  return Boolean(owner);
}

export const authorizationPrivacyBoundaries = Object.freeze({
  ownerSalaryPermission: PERMISSIONS.SALARY_VIEW_OWNER,
  adminFullDoesNotImplyOwnerSalary: true,
  privateChatRequiresMembership: true,
});
