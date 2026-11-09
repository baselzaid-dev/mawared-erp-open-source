import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import type express from 'express';
import jwt from 'jsonwebtoken';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import {
  canManagePrincipal,
  canTemporarilyDelegate,
  grantableCapabilities,
  hasEffectiveCapability,
  isCapabilityAllowedAtScope,
  loadAuthorizationContext,
  loadPrincipalSummary,
  type AuthorizationContext,
} from './authorization';
import { isCanonicalPermission, PERMISSIONS } from './permissions';
import { verifyEnrolledUserTotp } from './mfaRoutes';
import { MfaConfigurationError } from './mfa';

interface AuthorizationRequest extends express.Request {
  user?: {
    id: string;
    companyId: string;
    employeeId: string | null;
    permissions: string[];
  };
}

interface AuthorizationRoutesDeps {
  app: express.Express;
  prisma: PrismaClient;
  requireAuth: express.RequestHandler;
  sensitiveLimiter: express.RequestHandler;
  jwtSecret?: string;
  mfaEncryptionKey?: string;
}

type ManagedScope = {
  scopeType: 'company' | 'department';
  departmentId: string | null;
};

type PermissionOperation = ManagedScope & {
  action: 'grant' | 'revoke';
  capability: string;
};

type PermissionPreviewToken = {
  kind: 'permission-change';
  actorUserId: string;
  companyId: string;
  targetUserId: string;
  expectedAuthorizationVersion: number;
  reason: string;
  operations: PermissionOperation[];
  previewDigest: string;
};

type OwnershipPreviewToken = {
  kind: 'ownership-transfer';
  actorUserId: string;
  companyId: string;
  targetUserId: string;
  actorAuthorizationVersion: number;
  targetAuthorizationVersion: number;
  reason: string;
  confirmationText: string;
  previewDigest: string;
};

class AuthorizationRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

const reasonSchema = z.string().trim().min(3).max(500);
const userIdSchema = z.string().trim().min(1).max(100);
const idempotencyKeySchema = z.string().trim().min(8).max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const authorizationVersionSchema = z.number().int().min(1);
const scopeSchema = z.object({
  scopeType: z.enum(['company', 'department']),
  departmentId: z.string().trim().min(1).max(100).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.scopeType === 'company' && value.departmentId) {
    context.addIssue({ code: 'custom', message: 'Company scope cannot include a Department' });
  }
  if (value.scopeType === 'department' && !value.departmentId) {
    context.addIssue({ code: 'custom', message: 'Department scope requires a Department' });
  }
});
const permissionOperationSchema = z.object({
  action: z.enum(['grant', 'revoke']),
  capability: z.string().trim().min(3).max(100),
  scopeType: z.enum(['company', 'department']),
  departmentId: z.string().trim().min(1).max(100).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (!isCanonicalPermission(value.capability)) {
    context.addIssue({ code: 'custom', message: 'Unknown capability' });
  }
  if (isCanonicalPermission(value.capability) && !isCapabilityAllowedAtScope(value.capability, value.scopeType)) {
    context.addIssue({ code: 'custom', message: 'Capability is not supported at this scope' });
  }
  if (value.scopeType === 'company' && value.departmentId) {
    context.addIssue({ code: 'custom', message: 'Company scope cannot include a Department' });
  }
  if (value.scopeType === 'department' && !value.departmentId) {
    context.addIssue({ code: 'custom', message: 'Department scope requires a Department' });
  }
});
const permissionPreviewSchema = z.object({
  targetUserId: userIdSchema,
  expectedAuthorizationVersion: authorizationVersionSchema,
  reason: reasonSchema,
  operations: z.array(permissionOperationSchema).min(1).max(100),
}).strict();
const permissionApplySchema = z.object({
  previewId: z.string().min(20).max(20_000),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();
const delegationCreateSchema = z.object({
  recipientUserId: userIdSchema,
  capabilities: z.array(z.string().trim().min(3).max(100)).min(1).max(100),
  scopeType: z.enum(['company', 'department']),
  departmentId: z.string().trim().min(1).max(100).nullable().optional(),
  validFrom: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }),
  reason: reasonSchema,
  expectedAuthorizationVersion: authorizationVersionSchema,
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();
const delegationRevokeSchema = z.object({
  reason: reasonSchema,
  expectedAuthorizationVersion: authorizationVersionSchema,
}).strict();
const ownershipPreviewSchema = z.object({
  targetUserId: userIdSchema,
  reason: reasonSchema,
  password: z.string().min(1).max(512),
  totpCode: z.string().trim().regex(/^\d{6}$/),
}).strict();
const ownershipApplySchema = z.object({
  previewId: z.string().min(20).max(20_000),
  confirmationText: z.string().trim().min(1).max(100),
  expectedVersion: authorizationVersionSchema,
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();
const delegatedAdminCreateSchema = z.object({
  userId: userIdSchema,
  capabilities: z.array(z.string().trim().min(3).max(100)).min(1).max(100),
  reason: reasonSchema,
  expectedVersion: authorizationVersionSchema,
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();
const delegatedAdminRevokeSchema = z.object({
  reason: reasonSchema,
  expectedVersion: authorizationVersionSchema,
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();
const managerAssignmentSchema = z.object({
  userId: userIdSchema,
  reason: reasonSchema,
  expectedAuthorizationVersion: authorizationVersionSchema,
}).strict();
const managerRevokeSchema = z.object({
  reason: reasonSchema,
  expectedAuthorizationVersion: authorizationVersionSchema,
}).strict();

const fail = (status: number, code: string, messageKey: string): never => {
  throw new AuthorizationRequestError(status, code, messageKey);
};

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail(400, 'InvalidRequest', 'authorization.invalid_request');
  return parsed.data;
};

const stableJson = (value: unknown): string => {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  };
  return JSON.stringify(normalize(value));
};

const sha256 = (value: unknown): string =>
  crypto.createHash('sha256').update(stableJson(value)).digest('hex');

const normalizedScope = (scope: ManagedScope): ManagedScope => ({
  scopeType: scope.scopeType,
  departmentId: scope.scopeType === 'department' ? scope.departmentId : null,
});

const normalizedOperations = (operations: PermissionOperation[]): PermissionOperation[] => {
  const normalized = operations.map((operation) => ({
    action: operation.action,
    capability: operation.capability,
    ...normalizedScope(operation),
  }));
  const keys = normalized.map((operation) => stableJson(operation));
  if (new Set(keys).size !== keys.length) {
    fail(400, 'DuplicatePermissionOperation', 'authorization.duplicate_operation');
  }
  return normalized.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
};

const route = (
  handler: (req: AuthorizationRequest, res: express.Response) => Promise<unknown>,
): express.RequestHandler => async (request, response, next) => {
  try {
    await handler(request as AuthorizationRequest, response);
  } catch (error) {
    if (error instanceof AuthorizationRequestError) {
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
        message: 'authorization.concurrent_conflict',
        messageKey: 'authorization.concurrent_conflict',
      });
    }
    return next(error);
  }
};

const getIdempotencyKey = (req: express.Request, bodyKey?: string): string => {
  const header = req.header('Idempotency-Key');
  const candidate = header ?? bodyKey;
  const parsed = idempotencyKeySchema.safeParse(candidate);
  if (!parsed.success) fail(400, 'IdempotencyKeyRequired', 'authorization.idempotency_key_required');
  return parsed.data;
};

const requireSecret = (secret?: string): string => {
  if (!secret) fail(500, 'SystemConfigurationError', 'authorization.configuration_unavailable');
  return secret;
};

const signPreview = (payload: PermissionPreviewToken | OwnershipPreviewToken, secret: string): string =>
  jwt.sign(payload, secret, {
    algorithm: 'HS256',
    issuer: 'mawared-backend',
    audience: 'mawared-authorization-preview',
    expiresIn: '10m',
  });

const verifyPreview = <T extends PermissionPreviewToken | OwnershipPreviewToken>(
  token: string,
  secret: string,
  kind: T['kind'],
): T => {
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: 'mawared-backend',
      audience: 'mawared-authorization-preview',
    }) as T;
    if (decoded.kind !== kind) throw new Error('Wrong preview kind');
    return decoded;
  } catch {
    return fail(400, 'InvalidPreview', 'authorization.preview_invalid_or_expired');
  }
};

const loadActor = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  req: AuthorizationRequest,
): Promise<AuthorizationContext> => {
  const context = await loadAuthorizationContext(prisma, {
    userId: req.user!.id,
    companyId: req.user!.companyId,
  });
  if (!context) fail(401, 'InvalidSession', 'authorization.session_invalid');
  return context;
};

const assertScopeExists = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  companyId: string,
  scope: ManagedScope,
): Promise<void> => {
  if (scope.scopeType !== 'department') return;
  const department = await prisma.department.findFirst({
    where: { id: scope.departmentId!, companyId },
    select: { id: true },
  });
  if (!department) fail(404, 'ScopeNotFound', 'authorization.scope_not_found');
};

const assertManagementAuthority = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: AuthorizationContext,
  targetUserId: string,
  scope: ManagedScope,
) => {
  await assertScopeExists(prisma, actor.companyId, scope);
  const decision = await canManagePrincipal(prisma, actor, targetUserId, scope);
  if (!decision.allowed) fail(404, 'PrincipalNotFound', 'authorization.principal_not_found');
  return decision.target!;
};

const canDirectlyGrant = (
  actor: AuthorizationContext,
  capability: string,
  scope: ManagedScope,
): boolean => {
  if (capability === PERMISSIONS.ADMIN_FULL || capability === PERMISSIONS.COMPANY_OWNER_TRANSFER) {
    return false;
  }
  if (!isCapabilityAllowedAtScope(capability, scope.scopeType)) return false;
  if (capability === PERMISSIONS.SALARY_VIEW_OWNER) return actor.isPrimaryOwner;
  return hasEffectiveCapability(actor, capability, scope);
};

const safeEffectiveSummary = (context: AuthorizationContext) => ({
  userId: context.userId,
  authorizationVersion: context.authorizationVersion,
  isPrimaryOwner: context.isPrimaryOwner,
  managedDepartmentIds: context.managedDepartmentIds,
  capabilities: context.capabilities.map((capability) => ({
    capability: capability.capability,
    scopeType: capability.scopeType,
    departmentId: capability.departmentId,
    source: capability.source,
    validUntil: capability.validUntil?.toISOString() ?? null,
  })),
  // Flat company-usable keys for Android same-identity session soft-refresh.
  flatPermissions: context.flatPermissions,
});

const notify = async (
  prisma: Prisma.TransactionClient,
  companyId: string,
  userId: string,
  title: string,
  message: string,
) => {
  await prisma.notification.create({ data: { companyId, userId, title, message } });
};

const permissionRow = (operation: PermissionOperation) => ({
  capability: operation.capability,
  scopeType: operation.scopeType,
  departmentId: operation.departmentId,
});

export function registerAuthorizationRoutes({
  app,
  prisma,
  requireAuth,
  sensitiveLimiter,
  jwtSecret,
  mfaEncryptionKey,
}: AuthorizationRoutesDeps): void {
  app.get('/api/v2/authorization/effective', requireAuth, route(async (req, res) => {
    const context = await loadActor(prisma, req);
    return res.json(safeEffectiveSummary(context));
  }));

  app.get('/api/v2/company/principals/manageable', requireAuth, route(async (req, res) => {
    const actor = await loadActor(prisma, req);
    const departmentId = typeof req.query.departmentId === 'string' ? req.query.departmentId : null;
    const scope: ManagedScope = departmentId
      ? { scopeType: 'department', departmentId }
      : { scopeType: 'company', departmentId: null };
    await assertScopeExists(prisma, actor.companyId, scope);

    const users = await prisma.user.findMany({
      where: {
        companyId: actor.companyId,
        id: { not: actor.userId },
        OR: [{ employeeId: null }, { employee: { is: { status: 'active' } } }],
        ...(departmentId ? { employee: { is: { status: 'active', departmentId } } } : {}),
      },
      select: {
        id: true,
        name: true,
        employeeId: true,
        authorizationVersion: true,
        employee: { select: { departmentId: true } },
      },
      orderBy: { name: 'asc' },
      take: 500,
    });
    const manageable = [];
    for (const user of users) {
      const decision = await canManagePrincipal(prisma, actor, user.id, scope);
      if (!decision.allowed) continue;
      manageable.push({
        userId: user.id,
        employeeId: user.employeeId,
        name: user.name,
        departmentId: user.employee?.departmentId ?? null,
        authorizationVersion: user.authorizationVersion,
        managedDepartmentIds: decision.target?.managedDepartmentIds ?? [],
      });
    }
    return res.json(manageable);
  }));

  app.get('/api/v2/company/permissions/grantable', requireAuth, route(async (req, res) => {
    const actor = await loadActor(prisma, req);
    const targetUserId = typeof req.query.targetUserId === 'string' ? req.query.targetUserId : '';
    if (!targetUserId) fail(400, 'TargetRequired', 'authorization.target_required');
    const departmentId = typeof req.query.departmentId === 'string' ? req.query.departmentId : null;
    const scope: ManagedScope = departmentId
      ? { scopeType: 'department', departmentId }
      : { scopeType: 'company', departmentId: null };
    const target = await assertManagementAuthority(prisma, actor, targetUserId, scope);
    const capabilities = grantableCapabilities(actor, scope)
      .filter((capability) => canDirectlyGrant(actor, capability, scope));
    if (actor.isPrimaryOwner && !capabilities.includes(PERMISSIONS.SALARY_VIEW_OWNER)) {
      capabilities.push(PERMISSIONS.SALARY_VIEW_OWNER);
      capabilities.sort();
    }
    return res.json({
      targetUserId,
      targetAuthorizationVersion: target.authorizationVersion,
      scope,
      capabilities,
    });
  }));

  app.post('/api/v2/company/permissions/preview', requireAuth, route(async (req, res) => {
    const body = parseBody(permissionPreviewSchema, req.body);
    const operations = normalizedOperations(body.operations.map((operation) => ({
      ...operation,
      departmentId: operation.departmentId ?? null,
    })));
    const actor = await loadActor(prisma, req);
    const scopes = new Map(operations.map((operation) => [stableJson(normalizedScope(operation)), normalizedScope(operation)]));
    let target = null;
    for (const scope of scopes.values()) {
      target = await assertManagementAuthority(prisma, actor, body.targetUserId, scope);
    }
    if (!target || target.authorizationVersion !== body.expectedAuthorizationVersion) {
      fail(412, 'StaleAuthorizationVersion', 'authorization.stale_version');
    }
    for (const operation of operations) {
      if (!canDirectlyGrant(actor, operation.capability, operation)) {
        fail(403, 'CapabilityNotGrantable', 'authorization.capability_not_grantable');
      }
    }

    const active = await prisma.accessGrant.findMany({
      where: {
        companyId: actor.companyId,
        recipientUserId: body.targetUserId,
        grantKind: 'direct',
        status: 'active',
      },
      select: { capability: true, scopeType: true, departmentId: true },
    });
    const activeKeys = new Set(active.map((grant) => stableJson({
      capability: grant.capability,
      scopeType: grant.scopeType,
      departmentId: grant.departmentId,
    })));
    const changes = operations.map((operation) => {
      const exists = activeKeys.has(stableJson(permissionRow(operation)));
      if (operation.action === 'grant' && exists) {
        fail(409, 'GrantAlreadyActive', 'authorization.grant_already_active');
      }
      if (operation.action === 'revoke' && !exists) {
        fail(409, 'GrantNotActive', 'authorization.grant_not_active');
      }
      return { ...operation, before: exists ? 'active' : 'absent', after: exists ? 'revoked' : 'active' };
    });
    const previewDigest = sha256({
      actorUserId: actor.userId,
      companyId: actor.companyId,
      targetUserId: body.targetUserId,
      expectedAuthorizationVersion: body.expectedAuthorizationVersion,
      reason: body.reason,
      operations,
    });
    const previewId = signPreview({
      kind: 'permission-change',
      actorUserId: actor.userId,
      companyId: actor.companyId,
      targetUserId: body.targetUserId,
      expectedAuthorizationVersion: body.expectedAuthorizationVersion,
      reason: body.reason,
      operations,
      previewDigest,
    }, requireSecret(jwtSecret));
    return res.json({
      previewId,
      previewDigest,
      expiresInSeconds: 600,
      targetUserId: body.targetUserId,
      expectedAuthorizationVersion: body.expectedAuthorizationVersion,
      changes,
    });
  }));

  app.post('/api/v2/company/permissions/apply', requireAuth, route(async (req, res) => {
    const body = parseBody(permissionApplySchema, req.body);
    const idempotencyKey = getIdempotencyKey(req, body.idempotencyKey);
    const preview = verifyPreview<PermissionPreviewToken>(
      body.previewId,
      requireSecret(jwtSecret),
      'permission-change',
    );
    if (preview.actorUserId !== req.user!.id || preview.companyId !== req.user!.companyId) {
      fail(403, 'PreviewActorMismatch', 'authorization.preview_actor_mismatch');
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const duplicate = await tx.permissionChangeBatch.findFirst({
        where: { companyId: preview.companyId, actorUserId: preview.actorUserId, idempotencyKey },
      });
      if (duplicate) {
        if (duplicate.previewDigest !== preview.previewDigest) {
          fail(409, 'IdempotencyConflict', 'authorization.idempotency_conflict');
        }
        return { idempotent: true, resultingVersion: duplicate.resultingAuthorizationVersion };
      }

      const locked = await tx.$queryRaw<Array<{ authorizationVersion: number }>>(Prisma.sql`
        SELECT "authorizationVersion" FROM "User"
        WHERE "id" = ${preview.targetUserId} AND "companyId" = ${preview.companyId}
        FOR UPDATE
      `);
      if (locked.length !== 1) fail(404, 'PrincipalNotFound', 'authorization.principal_not_found');
      if (locked[0].authorizationVersion !== preview.expectedAuthorizationVersion) {
        fail(412, 'StaleAuthorizationVersion', 'authorization.stale_version');
      }
      const actor = await loadAuthorizationContext(tx, {
        userId: preview.actorUserId,
        companyId: preview.companyId,
      });
      if (!actor) fail(401, 'InvalidSession', 'authorization.session_invalid');
      for (const operation of preview.operations) {
        await assertManagementAuthority(tx, actor, preview.targetUserId, operation);
        if (!canDirectlyGrant(actor, operation.capability, operation)) {
          fail(403, 'CapabilityNotGrantable', 'authorization.capability_not_grantable');
        }
      }

      const resultingVersion = preview.expectedAuthorizationVersion + 1;
      const batch = await tx.permissionChangeBatch.create({
        data: {
          companyId: preview.companyId,
          targetUserId: preview.targetUserId,
          actorUserId: preview.actorUserId,
          idempotencyKey,
          previewDigest: preview.previewDigest,
          expectedAuthorizationVersion: preview.expectedAuthorizationVersion,
          resultingAuthorizationVersion: resultingVersion,
          reason: preview.reason,
        },
      });
      for (const operation of preview.operations) {
        const where = {
          companyId: preview.companyId,
          recipientUserId: preview.targetUserId,
          capability: operation.capability,
          scopeType: operation.scopeType,
          departmentId: operation.departmentId,
          grantKind: 'direct',
          status: 'active',
        } as const;
        if (operation.action === 'grant') {
          const existing = await tx.accessGrant.findFirst({ where, select: { id: true } });
          if (existing) fail(409, 'GrantAlreadyActive', 'authorization.grant_already_active');
          await tx.accessGrant.create({
            data: {
              companyId: preview.companyId,
              recipientUserId: preview.targetUserId,
              capability: operation.capability,
              scopeType: operation.scopeType,
              departmentId: operation.departmentId,
              grantedByUserId: preview.actorUserId,
              reason: preview.reason,
            },
          });
        } else {
          const existing = await tx.accessGrant.findFirst({ where, select: { id: true } });
          if (!existing) fail(409, 'GrantNotActive', 'authorization.grant_not_active');
          await tx.accessGrant.update({
            where: { id: existing.id },
            data: { status: 'revoked', revokedAt: new Date(), revokedByUserId: preview.actorUserId },
          });
        }
        await tx.permissionChangeHistory.create({
          data: {
            companyId: preview.companyId,
            batchId: batch.id,
            targetUserId: preview.targetUserId,
            actorUserId: preview.actorUserId,
            action: operation.action,
            capability: operation.capability,
            scopeType: operation.scopeType,
            departmentId: operation.departmentId,
            reason: preview.reason,
            beforeJson: stableJson({ status: operation.action === 'grant' ? 'absent' : 'active' }),
            afterJson: stableJson({ status: operation.action === 'grant' ? 'active' : 'revoked' }),
          },
        });
      }
      await tx.user.update({
        where: { id: preview.targetUserId },
        data: { authorizationVersion: { increment: 1 } },
      });
      await writeAuditRequired(tx as unknown as PrismaClient, {
        companyId: preview.companyId,
        userId: preview.actorUserId,
        action: 'authorization.permissions.apply',
        details: {
          targetUserId: preview.targetUserId,
          permissionChangeBatchId: batch.id,
          resultingAuthorizationVersion: resultingVersion,
          operationCount: preview.operations.length,
        },
      });
      await notify(
        tx,
        preview.companyId,
        preview.targetUserId,
        'تحديث الصلاحيات',
        'تم تحديث صلاحيات حسابك. افتح التطبيق مجدداً لمراجعة الوصول المتاح.',
      );
      return { idempotent: false, resultingVersion };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    const effective = await loadAuthorizationContext(prisma, {
      userId: preview.targetUserId,
      companyId: preview.companyId,
    });
    if (!effective) fail(404, 'PrincipalNotFound', 'authorization.principal_not_found');
    return res.json({ ...safeEffectiveSummary(effective), idempotent: outcome.idempotent });
  }));

  app.get('/api/v2/delegations', requireAuth, route(async (req, res) => {
    const actor = await loadActor(prisma, req);
    const companyScope = hasEffectiveCapability(actor, PERMISSIONS.PERMISSIONS_DELEGATE_TEMPORARY, {
      scopeType: 'company',
    });
    const authorizedDepartmentIds = actor.managedDepartmentIds.filter((departmentId) => hasEffectiveCapability(
      actor,
      PERMISSIONS.PERMISSIONS_DELEGATE_TEMPORARY,
      { scopeType: 'department', departmentId },
    ));
    const rows = await prisma.temporaryDelegation.findMany({
      where: {
        companyId: actor.companyId,
        OR: [
          { delegatorUserId: actor.userId },
          { recipientUserId: actor.userId },
          ...(authorizedDepartmentIds.length > 0
            ? [{ departmentId: { in: authorizedDepartmentIds } }]
            : []),
          ...(companyScope ? [{}] : []),
        ],
      },
      select: {
        id: true,
        delegatorUserId: true,
        recipientUserId: true,
        scopeType: true,
        departmentId: true,
        validFrom: true,
        validUntil: true,
        status: true,
        revokedAt: true,
        createdAt: true,
        capabilities: { select: { capability: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return res.json(rows.map((row) => ({
      ...row,
      validFrom: row.validFrom.toISOString(),
      validUntil: row.validUntil.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      effective: row.status === 'active' && row.validFrom <= new Date() && row.validUntil > new Date(),
      capabilities: row.capabilities.map((item) => item.capability).sort(),
    })));
  }));

  app.post('/api/v2/delegations', requireAuth, route(async (req, res) => {
    const body = parseBody(delegationCreateSchema, req.body);
    const idempotencyKey = getIdempotencyKey(req, body.idempotencyKey);
    const scope = normalizedScope({
      scopeType: body.scopeType,
      departmentId: body.departmentId ?? null,
    });
    const validFrom = new Date(body.validFrom);
    const validUntil = new Date(body.validUntil);
    if (validUntil <= validFrom || validUntil.getTime() - validFrom.getTime() > 90 * 24 * 60 * 60 * 1000) {
      fail(400, 'InvalidDelegationInterval', 'authorization.delegation_interval_invalid');
    }
    const capabilities = [...new Set(body.capabilities)].sort();
    if (
      capabilities.length !== body.capabilities.length ||
      capabilities.some((capability) => !isCapabilityAllowedAtScope(capability, scope.scopeType))
    ) {
      fail(400, 'InvalidCapability', 'authorization.capability_invalid');
    }
    const actor = await loadActor(prisma, req);
    if (!hasEffectiveCapability(actor, PERMISSIONS.PERMISSIONS_DELEGATE_TEMPORARY, scope)) {
      fail(403, 'DelegationForbidden', 'authorization.delegation_forbidden');
    }
    const target = await assertManagementAuthority(prisma, actor, body.recipientUserId, scope);
    if (target.authorizationVersion !== body.expectedAuthorizationVersion) {
      fail(412, 'StaleAuthorizationVersion', 'authorization.stale_version');
    }
    for (const capability of capabilities) {
      if (!canTemporarilyDelegate(capability) || !hasEffectiveCapability(actor, capability, scope)) {
        fail(403, 'CapabilityNotDelegable', 'authorization.capability_not_delegable');
      }
    }

    const delegation = await prisma.$transaction(async (tx) => {
      const duplicate = await tx.temporaryDelegation.findFirst({
        where: { companyId: actor.companyId, delegatorUserId: actor.userId, idempotencyKey },
        include: { capabilities: { select: { capability: true } } },
      });
      const requestDigest = sha256({
        recipientUserId: body.recipientUserId,
        capabilities,
        scope,
        validFrom: validFrom.toISOString(),
        validUntil: validUntil.toISOString(),
        reason: body.reason,
        expectedAuthorizationVersion: body.expectedAuthorizationVersion,
      });
      if (duplicate) {
        const duplicateDigest = sha256({
          recipientUserId: duplicate.recipientUserId,
          capabilities: duplicate.capabilities.map((item) => item.capability).sort(),
          scope: { scopeType: duplicate.scopeType, departmentId: duplicate.departmentId },
          validFrom: duplicate.validFrom.toISOString(),
          validUntil: duplicate.validUntil.toISOString(),
          reason: duplicate.reason,
          expectedAuthorizationVersion: body.expectedAuthorizationVersion,
        });
        if (duplicateDigest !== requestDigest) {
          fail(409, 'IdempotencyConflict', 'authorization.idempotency_conflict');
        }
        return duplicate;
      }
      const locked = await tx.$queryRaw<Array<{ authorizationVersion: number }>>(Prisma.sql`
        SELECT "authorizationVersion" FROM "User"
        WHERE "id" = ${body.recipientUserId} AND "companyId" = ${actor.companyId}
        FOR UPDATE
      `);
      if (locked.length !== 1 || locked[0].authorizationVersion !== body.expectedAuthorizationVersion) {
        fail(412, 'StaleAuthorizationVersion', 'authorization.stale_version');
      }
      const freshActor = await loadAuthorizationContext(tx, { userId: actor.userId, companyId: actor.companyId });
      if (!freshActor || !hasEffectiveCapability(freshActor, PERMISSIONS.PERMISSIONS_DELEGATE_TEMPORARY, scope)) {
        fail(403, 'DelegationForbidden', 'authorization.delegation_forbidden');
      }
      await assertManagementAuthority(tx, freshActor, body.recipientUserId, scope);
      for (const capability of capabilities) {
        if (!canTemporarilyDelegate(capability) || !hasEffectiveCapability(freshActor, capability, scope)) {
          fail(403, 'CapabilityNotDelegable', 'authorization.capability_not_delegable');
        }
      }
      const created = await tx.temporaryDelegation.create({
        data: {
          companyId: actor.companyId,
          delegatorUserId: actor.userId,
          recipientUserId: body.recipientUserId,
          scopeType: scope.scopeType,
          departmentId: scope.departmentId,
          validFrom,
          validUntil,
          reason: body.reason,
          idempotencyKey,
          capabilities: {
            create: capabilities.map((capability) => ({ companyId: actor.companyId, capability })),
          },
        },
        include: { capabilities: { select: { capability: true } } },
      });
      await tx.user.update({
        where: { id: body.recipientUserId },
        data: { authorizationVersion: { increment: 1 } },
      });
      await writeAuditRequired(tx as unknown as PrismaClient, {
        companyId: actor.companyId,
        userId: actor.userId,
        action: 'authorization.delegation.create',
        details: {
          delegationId: created.id,
          targetUserId: body.recipientUserId,
          operationCount: capabilities.length,
          resultingAuthorizationVersion: body.expectedAuthorizationVersion + 1,
          scope: scope.scopeType,
          departmentId: scope.departmentId,
        },
      });
      await notify(tx, actor.companyId, body.recipientUserId, 'تفويض صلاحيات مؤقت', 'تم منح حسابك تفويضاً مؤقتاً بصلاحيات محددة.');
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return res.status(201).json({
      id: delegation.id,
      recipientUserId: delegation.recipientUserId,
      scopeType: delegation.scopeType,
      departmentId: delegation.departmentId,
      validFrom: delegation.validFrom.toISOString(),
      validUntil: delegation.validUntil.toISOString(),
      status: delegation.status,
      capabilities: delegation.capabilities.map((item) => item.capability).sort(),
    });
  }));

  app.post('/api/v2/delegations/:id/revoke', requireAuth, route(async (req, res) => {
    const body = parseBody(delegationRevokeSchema, req.body);
    const actor = await loadActor(prisma, req);
    const existing = await prisma.temporaryDelegation.findFirst({
      where: { id: req.params.id, companyId: actor.companyId, status: 'active' },
      include: { capabilities: { select: { capability: true } } },
    });
    if (!existing) fail(404, 'DelegationNotFound', 'authorization.delegation_not_found');
    const scope = normalizedScope({
      scopeType: existing.scopeType as ManagedScope['scopeType'],
      departmentId: existing.departmentId,
    });
    if (existing.delegatorUserId !== actor.userId) {
      if (!hasEffectiveCapability(actor, PERMISSIONS.PERMISSIONS_DELEGATE_TEMPORARY, scope)) {
        fail(404, 'DelegationNotFound', 'authorization.delegation_not_found');
      }
      await assertManagementAuthority(prisma, actor, existing.recipientUserId, scope);
    }
    const revoked = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ authorizationVersion: number }>>(Prisma.sql`
        SELECT "authorizationVersion" FROM "User"
        WHERE "id" = ${existing.recipientUserId} AND "companyId" = ${actor.companyId}
        FOR UPDATE
      `);
      if (locked.length !== 1 || locked[0].authorizationVersion !== body.expectedAuthorizationVersion) {
        fail(412, 'StaleAuthorizationVersion', 'authorization.stale_version');
      }
      const freshActor = await loadAuthorizationContext(tx, {
        userId: actor.userId,
        companyId: actor.companyId,
      });
      if (!freshActor) fail(401, 'InvalidSession', 'authorization.session_invalid');
      if (existing.delegatorUserId !== freshActor.userId) {
        if (!hasEffectiveCapability(
          freshActor,
          PERMISSIONS.PERMISSIONS_DELEGATE_TEMPORARY,
          scope,
        )) {
          fail(404, 'DelegationNotFound', 'authorization.delegation_not_found');
        }
        await assertManagementAuthority(tx, freshActor, existing.recipientUserId, scope);
      }
      const changed = await tx.temporaryDelegation.updateMany({
        where: { id: existing.id, companyId: actor.companyId, status: 'active' },
        data: { status: 'revoked', revokedAt: new Date(), revokedByUserId: actor.userId },
      });
      if (changed.count !== 1) fail(409, 'DelegationAlreadyRevoked', 'authorization.delegation_already_revoked');
      await tx.user.update({
        where: { id: existing.recipientUserId },
        data: { authorizationVersion: { increment: 1 } },
      });
      await writeAuditRequired(tx as unknown as PrismaClient, {
        companyId: actor.companyId,
        userId: actor.userId,
        action: 'authorization.delegation.revoke',
        details: {
          delegationId: existing.id,
          targetUserId: existing.recipientUserId,
          operationCount: existing.capabilities.length,
          resultingAuthorizationVersion: body.expectedAuthorizationVersion + 1,
        },
      });
      await notify(tx, actor.companyId, existing.recipientUserId, 'إلغاء تفويض الصلاحيات', 'تم إلغاء تفويض صلاحيات مؤقت لحسابك.');
      return tx.temporaryDelegation.findUniqueOrThrow({
        where: { id: existing.id },
        include: { capabilities: { select: { capability: true } } },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return res.json({
      id: revoked.id,
      status: revoked.status,
      revokedAt: revoked.revokedAt?.toISOString() ?? null,
      recipientUserId: revoked.recipientUserId,
      capabilities: revoked.capabilities.map((item) => item.capability).sort(),
    });
  }));

  app.post('/api/v2/company/ownership/transfers/preview', sensitiveLimiter, requireAuth, route(async (req, res) => {
    const body = parseBody(ownershipPreviewSchema, req.body);
    const actor = await loadActor(prisma, req);
    if (!actor.isPrimaryOwner || body.targetUserId === actor.userId) {
      fail(403, 'OwnershipTransferForbidden', 'authorization.ownership_transfer_forbidden');
    }
    const actorUser = await prisma.user.findFirst({
      where: { id: actor.userId, companyId: actor.companyId },
      select: { password: true },
    });
    const passwordMatches = actorUser ? await bcrypt.compare(body.password, actorUser.password) : false;
    if (!passwordMatches) fail(401, 'RecentAuthenticationRequired', 'authorization.reauthentication_failed');
    let mfaMatches = false;
    try {
      mfaMatches = await verifyEnrolledUserTotp({
        prisma,
        userId: actor.userId,
        companyId: actor.companyId,
        code: body.totpCode,
        encryptionKey: mfaEncryptionKey,
      });
    } catch (error) {
      if (error instanceof MfaConfigurationError) {
        fail(503, 'MfaUnavailable', 'auth.mfa_unavailable');
      }
      throw error;
    }
    if (!mfaMatches) {
      fail(401, 'MfaVerificationRequired', 'authorization.mfa_verification_failed');
    }
    const target = await loadPrincipalSummary(prisma, { companyId: actor.companyId, userId: body.targetUserId });
    if (!target || !target.active || target.isPrimaryOwner) {
      fail(404, 'PrincipalNotFound', 'authorization.principal_not_found');
    }
    const confirmationText = 'TRANSFER OWNERSHIP';
    const previewDigest = sha256({
      actorUserId: actor.userId,
      companyId: actor.companyId,
      targetUserId: target.userId,
      actorAuthorizationVersion: actor.authorizationVersion,
      targetAuthorizationVersion: target.authorizationVersion,
      reason: body.reason,
    });
    const previewId = signPreview({
      kind: 'ownership-transfer',
      actorUserId: actor.userId,
      companyId: actor.companyId,
      targetUserId: target.userId,
      actorAuthorizationVersion: actor.authorizationVersion,
      targetAuthorizationVersion: target.authorizationVersion,
      reason: body.reason,
      confirmationText,
      previewDigest,
    }, requireSecret(jwtSecret));
    return res.json({
      previewId,
      previewDigest,
      expiresInSeconds: 600,
      confirmationText,
      fromUserId: actor.userId,
      target: {
        userId: target.userId,
        employeeId: target.employeeId,
        name: target.name,
        authorizationVersion: target.authorizationVersion,
      },
    });
  }));

  app.post('/api/v2/company/ownership/transfers', sensitiveLimiter, requireAuth, route(async (req, res) => {
    const body = parseBody(ownershipApplySchema, req.body);
    const idempotencyKey = getIdempotencyKey(req, body.idempotencyKey);
    const preview = verifyPreview<OwnershipPreviewToken>(
      body.previewId,
      requireSecret(jwtSecret),
      'ownership-transfer',
    );
    if (
      preview.actorUserId !== req.user!.id ||
      preview.companyId !== req.user!.companyId ||
      body.confirmationText !== preview.confirmationText
    ) {
      fail(403, 'OwnershipConfirmationFailed', 'authorization.ownership_confirmation_failed');
    }
    if (body.expectedVersion !== preview.actorAuthorizationVersion) {
      fail(412, 'StaleAuthorizationVersion', 'authorization.stale_version');
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${preview.companyId}, 0))`);
      const duplicate = await tx.ownershipTransfer.findFirst({
        where: { companyId: preview.companyId, transferredByUserId: preview.actorUserId, idempotencyKey },
      });
      if (duplicate) {
        if (duplicate.previewDigest !== preview.previewDigest) {
          fail(409, 'IdempotencyConflict', 'authorization.idempotency_conflict');
        }
        return { transfer: duplicate, idempotent: true };
      }
      const owners = await tx.companyOwnership.findMany({
        where: { companyId: preview.companyId, isPrimary: true, status: 'active' },
      });
      if (owners.length !== 1 || owners[0].userId !== preview.actorUserId) {
        fail(409, 'OwnershipChanged', 'authorization.ownership_changed');
      }
      const users = await tx.$queryRaw<Array<{ id: string; authorizationVersion: number; employeeActive: boolean }>>(Prisma.sql`
        SELECT u."id", u."authorizationVersion",
               (u."employeeId" IS NULL OR e."status" = 'active') AS "employeeActive"
        FROM "User" u
        LEFT JOIN "Employee" e ON e."id" = u."employeeId" AND e."companyId" = u."companyId"
        WHERE u."companyId" = ${preview.companyId}
          AND u."id" IN (${preview.actorUserId}, ${preview.targetUserId})
        ORDER BY u."id"
        FOR UPDATE OF u
      `);
      const fromUser = users.find((user) => user.id === preview.actorUserId);
      const toUser = users.find((user) => user.id === preview.targetUserId);
      if (
        !fromUser || !toUser || !toUser.employeeActive ||
        fromUser.authorizationVersion !== preview.actorAuthorizationVersion ||
        toUser.authorizationVersion !== preview.targetAuthorizationVersion
      ) {
        fail(412, 'StaleAuthorizationVersion', 'authorization.stale_version');
      }
      const endedAt = new Date();
      await tx.companyOwnership.create({
        data: {
          companyId: preview.companyId,
          userId: preview.targetUserId,
          isPrimary: true,
          status: 'active',
          effectiveAt: endedAt,
          createdByUserId: preview.actorUserId,
        },
      });
      const ended = await tx.companyOwnership.updateMany({
        where: { id: owners[0].id, companyId: preview.companyId, status: 'active' },
        data: {
          status: 'ended',
          endedAt,
          endedByUserId: preview.actorUserId,
        },
      });
      if (ended.count !== 1) fail(409, 'OwnershipChanged', 'authorization.ownership_changed');
      const transfer = await tx.ownershipTransfer.create({
        data: {
          companyId: preview.companyId,
          fromUserId: preview.actorUserId,
          toUserId: preview.targetUserId,
          reason: preview.reason,
          transferredByUserId: preview.actorUserId,
          idempotencyKey,
          previewDigest: preview.previewDigest,
        },
      });
      await tx.user.updateMany({
        where: { companyId: preview.companyId, id: { in: [preview.actorUserId, preview.targetUserId] } },
        data: { authorizationVersion: { increment: 1 } },
      });
      await tx.refreshToken.updateMany({
        where: {
          companyId: preview.companyId,
          userId: { in: [preview.actorUserId, preview.targetUserId] },
          revokedAt: null,
        },
        data: { revokedAt: endedAt },
      });
      await writeAuditRequired(tx as unknown as PrismaClient, {
        companyId: preview.companyId,
        userId: preview.actorUserId,
        action: 'authorization.ownership.transfer',
        details: {
          ownershipTransferId: transfer.id,
          fromUserId: preview.actorUserId,
          targetUserId: preview.targetUserId,
          resultingAuthorizationVersion: preview.targetAuthorizationVersion + 1,
        },
      });
      await notify(tx, preview.companyId, preview.actorUserId, 'تم نقل الملكية الأساسية', 'اكتملت عملية نقل الملكية الأساسية للشركة وتم إبطال الجلسات السابقة.');
      await notify(tx, preview.companyId, preview.targetUserId, 'أصبحت المالك الأساسي', 'تم نقل الملكية الأساسية للشركة إلى حسابك. سجّل الدخول مجدداً للمتابعة.');
      // Force deferred ownership constraints while failures are still inside
      // this route's transaction error boundary.
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      return { transfer, idempotent: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const owner = await loadPrincipalSummary(prisma, { companyId: preview.companyId, userId: preview.targetUserId });
    return res.json({
      transferId: result.transfer.id,
      idempotent: result.idempotent,
      owner: owner ? {
        userId: owner.userId,
        employeeId: owner.employeeId,
        name: owner.name,
        authorizationVersion: owner.authorizationVersion,
      } : null,
      sessionsRevoked: true,
    });
  }));

  app.post('/api/v2/company/delegated-admins', requireAuth, route(async (req, res) => {
    const body = parseBody(delegatedAdminCreateSchema, req.body);
    const idempotencyKey = getIdempotencyKey(req, body.idempotencyKey);
    const actor = await loadActor(prisma, req);
    if (!actor.isPrimaryOwner || !hasEffectiveCapability(actor, PERMISSIONS.COMPANY_ADMIN_DELEGATE, { scopeType: 'company' })) {
      fail(403, 'DelegatedAdminForbidden', 'authorization.delegated_admin_forbidden');
    }
    const target = await assertManagementAuthority(prisma, actor, body.userId, { scopeType: 'company', departmentId: null });
    if (target.authorizationVersion !== body.expectedVersion) {
      fail(412, 'StaleAuthorizationVersion', 'authorization.stale_version');
    }
    const capabilities = [...new Set(body.capabilities)].sort();
    if (
      capabilities.length !== body.capabilities.length ||
      capabilities.some((capability) => !isCanonicalPermission(capability) || !canDirectlyGrant(actor, capability, { scopeType: 'company', departmentId: null }))
    ) {
      fail(403, 'CapabilityNotGrantable', 'authorization.capability_not_grantable');
    }
    const digest = sha256({ actorUserId: actor.userId, companyId: actor.companyId, body: { ...body, idempotencyKey: undefined }, capabilities });
    const batch = await prisma.$transaction(async (tx) => {
      const duplicate = await tx.permissionChangeBatch.findFirst({
        where: { companyId: actor.companyId, actorUserId: actor.userId, idempotencyKey },
      });
      if (duplicate) {
        if (duplicate.previewDigest !== digest) fail(409, 'IdempotencyConflict', 'authorization.idempotency_conflict');
        return duplicate;
      }
      const locked = await tx.$queryRaw<Array<{ authorizationVersion: number }>>(Prisma.sql`
        SELECT "authorizationVersion" FROM "User"
        WHERE "id" = ${body.userId} AND "companyId" = ${actor.companyId}
        FOR UPDATE
      `);
      if (locked.length !== 1 || locked[0].authorizationVersion !== body.expectedVersion) {
        fail(412, 'StaleAuthorizationVersion', 'authorization.stale_version');
      }
      const freshActor = await loadAuthorizationContext(tx, { userId: actor.userId, companyId: actor.companyId });
      if (!freshActor?.isPrimaryOwner) fail(403, 'DelegatedAdminForbidden', 'authorization.delegated_admin_forbidden');
      await assertManagementAuthority(tx, freshActor, body.userId, { scopeType: 'company', departmentId: null });
      const created = await tx.permissionChangeBatch.create({
        data: {
          companyId: actor.companyId,
          targetUserId: body.userId,
          actorUserId: actor.userId,
          idempotencyKey,
          previewDigest: digest,
          expectedAuthorizationVersion: body.expectedVersion,
          resultingAuthorizationVersion: body.expectedVersion + 1,
          reason: body.reason,
        },
      });
      for (const capability of capabilities) {
        const existing = await tx.accessGrant.findFirst({
          where: { companyId: actor.companyId, recipientUserId: body.userId, capability, scopeType: 'company', departmentId: null, status: 'active' },
        });
        if (existing) fail(409, 'GrantAlreadyActive', 'authorization.grant_already_active');
        await tx.accessGrant.create({
          data: {
            companyId: actor.companyId,
            recipientUserId: body.userId,
            capability,
            scopeType: 'company',
            departmentId: null,
            grantedByUserId: actor.userId,
            reason: body.reason,
            grantKind: 'delegated_admin',
          },
        });
        await tx.permissionChangeHistory.create({
          data: {
            companyId: actor.companyId,
            batchId: created.id,
            targetUserId: body.userId,
            actorUserId: actor.userId,
            action: 'grant',
            capability,
            scopeType: 'company',
            departmentId: null,
            reason: body.reason,
            beforeJson: stableJson({ status: 'absent' }),
            afterJson: stableJson({ status: 'active', grantKind: 'delegated_admin' }),
          },
        });
      }
      await tx.user.update({ where: { id: body.userId }, data: { authorizationVersion: { increment: 1 } } });
      await writeAuditRequired(tx as unknown as PrismaClient, {
        companyId: actor.companyId,
        userId: actor.userId,
        action: 'authorization.delegated_admin.create',
        details: { targetUserId: body.userId, permissionChangeBatchId: created.id, operationCount: capabilities.length, resultingAuthorizationVersion: body.expectedVersion + 1 },
      });
      await notify(tx, actor.companyId, body.userId, 'تفويض إدارة الشركة', 'تم منح حسابك صلاحيات إدارة محددة للشركة.');
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return res.status(201).json({
      userId: body.userId,
      capabilities,
      authorizationVersion: batch.resultingAuthorizationVersion,
    });
  }));

  app.delete('/api/v2/company/delegated-admins/:userId', requireAuth, route(async (req, res) => {
    const body = parseBody(delegatedAdminRevokeSchema, req.body);
    const idempotencyKey = getIdempotencyKey(req, body.idempotencyKey);
    const actor = await loadActor(prisma, req);
    if (!actor.isPrimaryOwner) fail(403, 'DelegatedAdminForbidden', 'authorization.delegated_admin_forbidden');
    await assertManagementAuthority(prisma, actor, req.params.userId, { scopeType: 'company', departmentId: null });
    const active = await prisma.accessGrant.findMany({
      where: { companyId: actor.companyId, recipientUserId: req.params.userId, grantKind: 'delegated_admin', status: 'active' },
      select: { id: true, capability: true },
    });
    if (active.length === 0) fail(404, 'DelegatedAdminNotFound', 'authorization.delegated_admin_not_found');
    const digest = sha256({ actorUserId: actor.userId, companyId: actor.companyId, targetUserId: req.params.userId, body: { ...body, idempotencyKey: undefined }, capabilities: active.map((item) => item.capability).sort() });
    await prisma.$transaction(async (tx) => {
      const duplicate = await tx.permissionChangeBatch.findFirst({ where: { companyId: actor.companyId, actorUserId: actor.userId, idempotencyKey } });
      if (duplicate) {
        if (duplicate.previewDigest !== digest) fail(409, 'IdempotencyConflict', 'authorization.idempotency_conflict');
        return;
      }
      const locked = await tx.$queryRaw<Array<{ authorizationVersion: number }>>(Prisma.sql`
        SELECT "authorizationVersion" FROM "User"
        WHERE "id" = ${req.params.userId} AND "companyId" = ${actor.companyId}
        FOR UPDATE
      `);
      if (locked.length !== 1 || locked[0].authorizationVersion !== body.expectedVersion) {
        fail(412, 'StaleAuthorizationVersion', 'authorization.stale_version');
      }
      const freshActor = await loadAuthorizationContext(tx, {
        userId: actor.userId,
        companyId: actor.companyId,
      });
      if (!freshActor?.isPrimaryOwner) {
        fail(403, 'DelegatedAdminForbidden', 'authorization.delegated_admin_forbidden');
      }
      await assertManagementAuthority(
        tx,
        freshActor,
        req.params.userId,
        { scopeType: 'company', departmentId: null },
      );
      const batch = await tx.permissionChangeBatch.create({
        data: {
          companyId: actor.companyId,
          targetUserId: req.params.userId,
          actorUserId: actor.userId,
          idempotencyKey,
          previewDigest: digest,
          expectedAuthorizationVersion: body.expectedVersion,
          resultingAuthorizationVersion: body.expectedVersion + 1,
          reason: body.reason,
        },
      });
      const now = new Date();
      for (const grant of active) {
        const changed = await tx.accessGrant.updateMany({
          where: { id: grant.id, companyId: actor.companyId, status: 'active' },
          data: { status: 'revoked', revokedAt: now, revokedByUserId: actor.userId },
        });
        if (changed.count !== 1) fail(409, 'ConcurrentConflict', 'authorization.concurrent_conflict');
        await tx.permissionChangeHistory.create({
          data: {
            companyId: actor.companyId,
            batchId: batch.id,
            targetUserId: req.params.userId,
            actorUserId: actor.userId,
            action: 'revoke',
            capability: grant.capability,
            scopeType: 'company',
            departmentId: null,
            reason: body.reason,
            beforeJson: stableJson({ status: 'active', grantKind: 'delegated_admin' }),
            afterJson: stableJson({ status: 'revoked' }),
          },
        });
      }
      await tx.user.update({ where: { id: req.params.userId }, data: { authorizationVersion: { increment: 1 } } });
      await writeAuditRequired(tx as unknown as PrismaClient, {
        companyId: actor.companyId,
        userId: actor.userId,
        action: 'authorization.delegated_admin.revoke',
        details: { targetUserId: req.params.userId, permissionChangeBatchId: batch.id, operationCount: active.length, resultingAuthorizationVersion: body.expectedVersion + 1 },
      });
      await notify(tx, actor.companyId, req.params.userId, 'إلغاء تفويض إدارة الشركة', 'تم إلغاء صلاحيات الإدارة المفوضة لحسابك.');
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return res.status(204).send();
  }));

  app.get('/api/v2/departments/:departmentId/managers', requireAuth, route(async (req, res) => {
    const actor = await loadActor(prisma, req);
    const scope: ManagedScope = { scopeType: 'department', departmentId: req.params.departmentId };
    await assertScopeExists(prisma, actor.companyId, scope);
    if (
      !hasEffectiveCapability(actor, PERMISSIONS.PERMISSIONS_MANAGE_DEPARTMENT, scope) &&
      !hasEffectiveCapability(actor, PERMISSIONS.PERMISSIONS_MANAGE_COMPANY, { scopeType: 'company' })
    ) {
      fail(403, 'ManagerReadForbidden', 'authorization.manager_read_forbidden');
    }
    const rows = await prisma.departmentManager.findMany({
      where: { companyId: actor.companyId, departmentId: req.params.departmentId, status: 'active' },
      select: { id: true, userId: true, assignedAt: true, user: { select: { name: true, employeeId: true, authorizationVersion: true } } },
      orderBy: { assignedAt: 'asc' },
    });
    return res.json(rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      employeeId: row.user.employeeId,
      name: row.user.name,
      authorizationVersion: row.user.authorizationVersion,
      assignedAt: row.assignedAt.toISOString(),
    })));
  }));

  app.post('/api/v2/departments/:departmentId/managers', requireAuth, route(async (req, res) => {
    const body = parseBody(managerAssignmentSchema, req.body);
    const actor = await loadActor(prisma, req);
    const scope: ManagedScope = { scopeType: 'department', departmentId: req.params.departmentId };
    await assertScopeExists(prisma, actor.companyId, scope);
    if (!hasEffectiveCapability(actor, PERMISSIONS.PERMISSIONS_MANAGE_COMPANY, { scopeType: 'company' })) {
      fail(403, 'ManagerAssignmentForbidden', 'authorization.manager_assignment_forbidden');
    }
    const target = await assertManagementAuthority(prisma, actor, body.userId, scope);
    if (target.authorizationVersion !== body.expectedAuthorizationVersion) {
      fail(412, 'StaleAuthorizationVersion', 'authorization.stale_version');
    }
    const membership = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ authorizationVersion: number }>>(Prisma.sql`
        SELECT "authorizationVersion" FROM "User"
        WHERE "id" = ${body.userId} AND "companyId" = ${actor.companyId}
        FOR UPDATE
      `);
      if (locked.length !== 1 || locked[0].authorizationVersion !== body.expectedAuthorizationVersion) {
        fail(412, 'StaleAuthorizationVersion', 'authorization.stale_version');
      }
      const freshActor = await loadAuthorizationContext(tx, {
        userId: actor.userId,
        companyId: actor.companyId,
      });
      if (!freshActor || !hasEffectiveCapability(
        freshActor,
        PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
        { scopeType: 'company' },
      )) {
        fail(403, 'ManagerAssignmentForbidden', 'authorization.manager_assignment_forbidden');
      }
      await assertManagementAuthority(tx, freshActor, body.userId, scope);
      const existing = await tx.departmentManager.findFirst({
        where: { companyId: actor.companyId, departmentId: req.params.departmentId, userId: body.userId, status: 'active' },
      });
      if (existing) fail(409, 'ManagerAlreadyAssigned', 'authorization.manager_already_assigned');
      const created = await tx.departmentManager.create({
        data: {
          companyId: actor.companyId,
          departmentId: req.params.departmentId,
          userId: body.userId,
          assignedByUserId: actor.userId,
        },
      });
      await tx.user.update({ where: { id: body.userId }, data: { authorizationVersion: { increment: 1 } } });
      await writeAuditRequired(tx as unknown as PrismaClient, {
        companyId: actor.companyId,
        userId: actor.userId,
        action: 'authorization.department_manager.assign',
        details: { departmentManagerId: created.id, departmentId: req.params.departmentId, targetUserId: body.userId, resultingAuthorizationVersion: body.expectedAuthorizationVersion + 1 },
      });
      await notify(tx, actor.companyId, body.userId, 'تعيين مدير قسم', 'تم تعيين حسابك مديراً لأحد الأقسام.');
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return res.status(201).json({
      id: membership.id,
      departmentId: membership.departmentId,
      userId: membership.userId,
      assignedAt: membership.assignedAt.toISOString(),
      authorizationVersion: body.expectedAuthorizationVersion + 1,
    });
  }));

  app.post('/api/v2/departments/:departmentId/managers/:userId/revoke', requireAuth, route(async (req, res) => {
    const body = parseBody(managerRevokeSchema, req.body);
    const actor = await loadActor(prisma, req);
    const scope: ManagedScope = { scopeType: 'department', departmentId: req.params.departmentId };
    if (!hasEffectiveCapability(actor, PERMISSIONS.PERMISSIONS_MANAGE_COMPANY, { scopeType: 'company' })) {
      fail(403, 'ManagerAssignmentForbidden', 'authorization.manager_assignment_forbidden');
    }
    const target = await assertManagementAuthority(prisma, actor, req.params.userId, scope);
    if (target.authorizationVersion !== body.expectedAuthorizationVersion) {
      fail(412, 'StaleAuthorizationVersion', 'authorization.stale_version');
    }
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ authorizationVersion: number }>>(Prisma.sql`
        SELECT "authorizationVersion" FROM "User"
        WHERE "id" = ${req.params.userId} AND "companyId" = ${actor.companyId}
        FOR UPDATE
      `);
      if (locked.length !== 1 || locked[0].authorizationVersion !== body.expectedAuthorizationVersion) {
        fail(412, 'StaleAuthorizationVersion', 'authorization.stale_version');
      }
      const freshActor = await loadAuthorizationContext(tx, {
        userId: actor.userId,
        companyId: actor.companyId,
      });
      if (!freshActor || !hasEffectiveCapability(
        freshActor,
        PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
        { scopeType: 'company' },
      )) {
        fail(403, 'ManagerAssignmentForbidden', 'authorization.manager_assignment_forbidden');
      }
      await assertManagementAuthority(tx, freshActor, req.params.userId, scope);
      const membership = await tx.departmentManager.findFirst({
        where: { companyId: actor.companyId, departmentId: req.params.departmentId, userId: req.params.userId, status: 'active' },
      });
      if (!membership) fail(404, 'ManagerAssignmentNotFound', 'authorization.manager_assignment_not_found');
      const changed = await tx.departmentManager.updateMany({
        where: { id: membership.id, companyId: actor.companyId, status: 'active' },
        data: { status: 'ended', endedAt: new Date(), endedByUserId: actor.userId },
      });
      if (changed.count !== 1) fail(409, 'ConcurrentConflict', 'authorization.concurrent_conflict');
      await tx.department.updateMany({
        where: {
          id: req.params.departmentId,
          companyId: actor.companyId,
          managerId: req.params.userId,
        },
        data: { managerId: null },
      });
      await tx.user.update({ where: { id: req.params.userId }, data: { authorizationVersion: { increment: 1 } } });
      await writeAuditRequired(tx as unknown as PrismaClient, {
        companyId: actor.companyId,
        userId: actor.userId,
        action: 'authorization.department_manager.revoke',
        details: { departmentManagerId: membership.id, departmentId: req.params.departmentId, targetUserId: req.params.userId, resultingAuthorizationVersion: body.expectedAuthorizationVersion + 1 },
      });
      await notify(tx, actor.companyId, req.params.userId, 'إنهاء إدارة قسم', 'تم إنهاء تعيين حسابك مديراً لأحد الأقسام.');
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return res.status(204).send();
  }));
}
