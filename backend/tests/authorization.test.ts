import { describe, expect, it } from 'vitest';
import {
  authorizationPrivacyBoundaries,
  canManagePrincipal,
  hasEffectiveCapability,
  loadAuthorizationContext,
  loadManagedDepartmentIds,
  parseRolePermissions,
  type AuthorizationContext,
} from '../src/authorization';
import { PERMISSIONS } from '../src/permissions';

const now = new Date('2026-07-18T10:00:00.000Z');

function authorizationDb(options: {
  userId?: string;
  ownerUserId?: string | null;
  targetDepartmentId?: string | null;
  targetManagers?: string[];
  targetPermissions?: string[];
  delegationWindow?: { validFrom: Date; validUntil: Date };
} = {}) {
  const userId = options.userId ?? 'u-manager';
  const users: Record<string, any> = {
    'u-manager': {
      id: 'u-manager',
      companyId: 'c1',
      employeeId: 'e-manager',
      name: 'Manager',
      authorizationVersion: 3,
      role: {
        permissions: JSON.stringify([
          PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
          PERMISSIONS.PERMISSIONS_MANAGE_DEPARTMENT,
          PERMISSIONS.TASKS_VIEW_DEPARTMENT,
        ]),
      },
      employee: { departmentId: 'd1', status: 'active' },
    },
    'u-target': {
      id: 'u-target',
      companyId: 'c1',
      employeeId: 'e-target',
      name: 'Target',
      authorizationVersion: 4,
      role: { permissions: JSON.stringify(options.targetPermissions ?? [PERMISSIONS.DASHBOARD_SELF]) },
      employee: { departmentId: options.targetDepartmentId ?? 'd1', status: 'active' },
    },
  };
  const targetManagers = options.targetManagers ?? [];
  return {
    user: {
      findFirst: async ({ where }: any) => users[where.id] ?? null,
    },
    department: {
      findMany: async ({ where }: any) => where.managerId === 'u-manager' ? [{ id: 'd1' }] : [],
      findFirst: async ({ where }: any) => ['d1', 'd2'].includes(where.id) ? { id: where.id } : null,
    },
    companyOwnership: {
      findFirst: async ({ where }: any) =>
        where.userId === (options.ownerUserId ?? null) ? { id: 'owner-row' } : null,
    },
    departmentManager: {
      findMany: async ({ where }: any) => {
        if (where.userId === 'u-manager') return [{ departmentId: 'd2' }];
        if (where.userId === 'u-target' && targetManagers.includes(where.departmentId ?? 'd1')) {
          return [{ departmentId: where.departmentId ?? 'd1' }];
        }
        if (where.userId === 'u-target') {
          return targetManagers.map((departmentId) => ({ departmentId }));
        }
        return [];
      },
    },
    accessGrant: {
      findMany: async ({ where }: any) => where.recipientUserId === userId
        ? [{
            id: 'grant-1',
            capability: PERMISSIONS.PRINCIPALS_MANAGE_PEERS,
            scopeType: 'department',
            departmentId: 'd2',
          }]
        : [],
    },
    temporaryDelegation: {
      findMany: async ({ where }: any) => {
        const window = options.delegationWindow ?? {
          validFrom: new Date('2026-07-18T09:00:00.000Z'),
          validUntil: new Date('2026-07-18T11:00:00.000Z'),
        };
        if (window.validFrom > where.validFrom.lte || window.validUntil <= where.validUntil.gt) return [];
        return [{
          id: 'delegation-1',
          scopeType: 'department',
          departmentId: 'd2',
          validUntil: window.validUntil,
          capabilities: [{ capability: PERMISSIONS.PERMISSIONS_DELEGATE_TEMPORARY }],
        }];
      },
    },
  } as any;
}

describe('Sprint 12C effective authorization policy', () => {
  it('keeps only canonical role permissions and unions legacy/new Manager scope', async () => {
    expect(parseRolePermissions(JSON.stringify([
      PERMISSIONS.TASKS_VIEW_DEPARTMENT,
      'unknown.permission',
      PERMISSIONS.TASKS_VIEW_DEPARTMENT,
    ]))).toEqual([PERMISSIONS.TASKS_VIEW_DEPARTMENT]);

    const db = authorizationDb();
    await expect(loadManagedDepartmentIds(db, { companyId: 'c1', userId: 'u-manager' }))
      .resolves.toEqual(['d1', 'd2']);
  });

  it('unions Role, scoped grant, and only currently effective delegation', async () => {
    const active = await loadAuthorizationContext(authorizationDb(), {
      companyId: 'c1',
      userId: 'u-manager',
      now,
    });
    expect(active?.managedDepartmentIds).toEqual(['d1', 'd2']);
    expect(hasEffectiveCapability(active!, PERMISSIONS.TASKS_VIEW_DEPARTMENT, {
      scopeType: 'department',
      departmentId: 'd1',
    })).toBe(true);
    expect(hasEffectiveCapability(active!, PERMISSIONS.PRINCIPALS_MANAGE_PEERS, {
      scopeType: 'department',
      departmentId: 'd2',
    })).toBe(true);
    expect(hasEffectiveCapability(active!, PERMISSIONS.PERMISSIONS_DELEGATE_TEMPORARY, {
      scopeType: 'department',
      departmentId: 'd2',
    })).toBe(true);
    expect(hasEffectiveCapability(active!, PERMISSIONS.PRINCIPALS_MANAGE_PEERS, {
      scopeType: 'company',
    })).toBe(false);

    const expired = await loadAuthorizationContext(authorizationDb({
      delegationWindow: {
        validFrom: new Date('2026-07-18T08:00:00.000Z'),
        validUntil: now,
      },
    }), { companyId: 'c1', userId: 'u-manager', now });
    expect(hasEffectiveCapability(expired!, PERMISSIONS.PERMISSIONS_DELEGATE_TEMPORARY, {
      scopeType: 'department',
      departmentId: 'd2',
    })).toBe(false);
  });

  it('requires explicit peer authority to manage another company-level permission manager', async () => {
    const db = authorizationDb({
      targetPermissions: [
        PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
        PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
      ],
    });
    const actor: AuthorizationContext = {
      userId: 'u-manager',
      companyId: 'c1',
      employeeId: 'e-manager',
      employeeDepartmentId: 'd1',
      authorizationVersion: 3,
      isPrimaryOwner: false,
      managedDepartmentIds: [],
      baselinePermissions: [],
      capabilities: [
        { capability: PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE, scopeType: 'company', departmentId: null, source: 'grant' },
        { capability: PERMISSIONS.PERMISSIONS_MANAGE_COMPANY, scopeType: 'company', departmentId: null, source: 'grant' },
      ],
      flatPermissions: [],
    };

    await expect(canManagePrincipal(db, actor, 'u-target', { scopeType: 'company' }))
      .resolves.toMatchObject({ allowed: false, reason: 'peer_manager' });
    actor.capabilities.push({
      capability: PERMISSIONS.PRINCIPALS_MANAGE_PEERS,
      scopeType: 'company',
      departmentId: null,
      source: 'grant',
    });
    await expect(canManagePrincipal(db, actor, 'u-target', { scopeType: 'company' }))
      .resolves.toMatchObject({ allowed: true, reason: 'company' });
  });

  it('denies cross-Department, peer Manager, self, and Primary Owner management', async () => {
    const db = authorizationDb({ targetManagers: ['d1'] });
    const actor: AuthorizationContext = {
      userId: 'u-manager',
      companyId: 'c1',
      employeeId: 'e-manager',
      employeeDepartmentId: 'd1',
      authorizationVersion: 3,
      isPrimaryOwner: false,
      managedDepartmentIds: ['d1'],
      baselinePermissions: [],
      capabilities: [
        { capability: PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE, scopeType: 'department', departmentId: 'd1', source: 'grant' },
        { capability: PERMISSIONS.PERMISSIONS_MANAGE_DEPARTMENT, scopeType: 'department', departmentId: 'd1', source: 'grant' },
      ],
      flatPermissions: [],
    };

    await expect(canManagePrincipal(db, actor, 'u-manager', {
      scopeType: 'department', departmentId: 'd1',
    })).resolves.toMatchObject({ allowed: false, reason: 'self' });
    await expect(canManagePrincipal(db, actor, 'u-target', {
      scopeType: 'department', departmentId: 'd2',
    })).resolves.toMatchObject({ allowed: false, reason: 'outside_department' });
    await expect(canManagePrincipal(db, actor, 'u-target', {
      scopeType: 'department', departmentId: 'd1',
    })).resolves.toMatchObject({ allowed: false, reason: 'peer_manager' });

    actor.capabilities.push({
      capability: PERMISSIONS.PRINCIPALS_MANAGE_PEERS,
      scopeType: 'department',
      departmentId: 'd1',
      source: 'grant',
    });
    await expect(canManagePrincipal(db, actor, 'u-target', {
      scopeType: 'department', departmentId: 'd1',
    })).resolves.toMatchObject({ allowed: true });

    const ownerDb = authorizationDb({ ownerUserId: 'u-target', targetManagers: ['d1'] });
    await expect(canManagePrincipal(ownerDb, actor, 'u-target', {
      scopeType: 'department', departmentId: 'd1',
    })).resolves.toMatchObject({ allowed: false, reason: 'protected_owner' });
  });

  it('never lets admin.full imply ownership, owner salary, or private Chat membership', () => {
    const admin: AuthorizationContext = {
      userId: 'u-admin',
      companyId: 'c1',
      employeeId: 'e-admin',
      employeeDepartmentId: null,
      authorizationVersion: 1,
      isPrimaryOwner: false,
      managedDepartmentIds: [],
      baselinePermissions: [PERMISSIONS.ADMIN_FULL],
      capabilities: [{ capability: PERMISSIONS.ADMIN_FULL, scopeType: 'company', departmentId: null, source: 'role' }],
      flatPermissions: [PERMISSIONS.ADMIN_FULL],
    };
    expect(hasEffectiveCapability(admin, PERMISSIONS.SALARY_VIEW_OWNER, { scopeType: 'company' })).toBe(false);
    expect(hasEffectiveCapability(admin, PERMISSIONS.COMPANY_OWNER_TRANSFER, { scopeType: 'company' })).toBe(false);
    expect(authorizationPrivacyBoundaries.adminFullDoesNotImplyOwnerSalary).toBe(true);
    expect(authorizationPrivacyBoundaries.privateChatRequiresMembership).toBe(true);
  });
});
