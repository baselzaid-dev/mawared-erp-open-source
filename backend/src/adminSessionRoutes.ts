import type { Express, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAudit, writeAuditRequired } from './audit';
import {
  canManagePrincipal,
  loadAuthorizationContext,
  loadPrincipalSummary,
  type AuthorizationContext,
  type PrincipalSummary,
} from './authorization';
import { PERMISSIONS } from './permissions';
import {
  listSessionsForUser,
  revokeAllSessionsForUser,
  type SessionSummary,
} from './sessions';

interface AdminSessionUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface AdminSessionRequest extends Request {
  user?: AdminSessionUser;
}

export interface AdminSessionRoutesDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkPermission: (permission: string) => RequestHandler;
  sensitiveLimiter?: RequestHandler;
}

class AdminSessionError extends Error {
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
const authorizationVersionSchema = z.number().int().min(1);
const idempotencyKeySchema = z.string().trim().min(8).max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const revokeAllBodySchema = z.object({
  reason: reasonSchema,
  expectedAuthorizationVersion: authorizationVersionSchema,
}).strict();

const fail = (
  status: number,
  code: string,
  messageKey: string,
): never => {
  throw new AdminSessionError(status, code, messageKey);
};

const route = (
  handler: (req: AdminSessionRequest, res: Response) => Promise<unknown>,
): RequestHandler => async (request, response, next) => {
  try {
    await handler(request as AdminSessionRequest, response);
  } catch (error) {
    if (error instanceof AdminSessionError) {
      return response.status(error.status).json({
        error: error.code,
        code: error.status,
        messageKey: error.messageKey,
      });
    }
    return next(error);
  }
};

const actorFrom = (req: AdminSessionRequest): AdminSessionUser => {
  if (!req.user?.id || !req.user.companyId) {
    fail(401, 'Unauthorized', 'security.sessions.unauthorized');
  }
  return req.user!;
};

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail(400, 'InvalidRequest', 'security.sessions.invalid_request');
  return parsed.data;
};

const parseTargetUserId = (raw: string): string => {
  const parsed = userIdSchema.safeParse(raw);
  if (!parsed.success) fail(404, 'NotFound', 'security.sessions.user_not_found');
  return parsed.data;
};

const validateOptionalIdempotencyKey = (req: Request): void => {
  const header = req.header('Idempotency-Key');
  if (header == null || header === '') return;
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    fail(400, 'IdempotencyKeyInvalid', 'security.sessions.idempotency_key_invalid');
  }
};

const loadActorContext = async (
  prisma: PrismaClient,
  actor: AdminSessionUser,
): Promise<AuthorizationContext> => {
  const context = await loadAuthorizationContext(prisma, {
    userId: actor.id,
    companyId: actor.companyId,
  });
  if (!context) fail(401, 'Unauthorized', 'security.sessions.unauthorized');
  return context!;
};

const rejectManageDecision = (reason: string): never => {
  if (reason === 'self' || reason === 'protected_owner' || reason === 'peer_manager') {
    return fail(403, 'Forbidden', 'security.sessions.forbidden');
  }
  if (reason === 'missing_scope') {
    return fail(403, 'Forbidden', 'security.sessions.forbidden');
  }
  return fail(404, 'NotFound', 'security.sessions.user_not_found');
};

const assertManageableTarget = async (
  prisma: PrismaClient,
  actor: AuthorizationContext,
  targetUserId: string,
): Promise<PrincipalSummary> => {
  const target = await loadPrincipalSummary(prisma, {
    companyId: actor.companyId,
    userId: targetUserId,
  });
  if (!target || !target.active) {
    return fail(404, 'NotFound', 'security.sessions.user_not_found');
  }

  const companyDecision = await canManagePrincipal(prisma, actor, targetUserId, {
    scopeType: 'company',
  });
  if (companyDecision.allowed) return companyDecision.target!;

  if (target.departmentId) {
    const departmentDecision = await canManagePrincipal(prisma, actor, targetUserId, {
      scopeType: 'department',
      departmentId: target.departmentId,
    });
    if (departmentDecision.allowed) return departmentDecision.target!;
    return rejectManageDecision(departmentDecision.reason);
  }

  return rejectManageDecision(companyDecision.reason);
};

const toAdminSessionSummaries = (sessions: SessionSummary[]) =>
  sessions.map(({ isCurrent: _ignored, ...session }) => session);

const notifySessionsRevoked = async (
  prisma: PrismaClient,
  companyId: string,
  userId: string,
) => {
  await prisma.notification.create({
    data: {
      companyId,
      userId,
      title: 'تم إنهاء جلسات تسجيل الدخول',
      message: 'قام مسؤول بإنهاء جميع جلسات تسجيل الدخول النشطة لحسابك. سجّل الدخول مرة أخرى للمتابعة.',
      category: 'security',
      // Navigation metadata only — never session tokens, hashes, or credentials.
      routeKey: 'auth.sessions',
      resourceType: 'security',
    },
  });
};

export function registerAdminSessionRoutes({
  app,
  prisma,
  requireAuth,
  checkPermission,
  sensitiveLimiter,
}: AdminSessionRoutesDeps): void {
  const writeLimiter = sensitiveLimiter ?? ((_req, _res, next) => next());
  const sessionPermission = checkPermission(PERMISSIONS.COMPANY_SESSIONS_MANAGE);

  app.get(
    '/api/v2/security/users/:userId/sessions',
    requireAuth,
    sessionPermission,
    route(async (req, res) => {
      const actor = actorFrom(req);
      const targetUserId = parseTargetUserId(req.params.userId);
      const actorContext = await loadActorContext(prisma, actor);
      await assertManageableTarget(prisma, actorContext, targetUserId);

      const sessions = await listSessionsForUser(
        prisma,
        targetUserId,
        actor.companyId,
        null,
      );

      await writeAudit(prisma, {
        companyId: actor.companyId,
        userId: actor.id,
        action: 'security.sessions.list',
        details: {
          targetUserId,
          sessionCount: sessions.length,
        },
      });

      return res.json(toAdminSessionSummaries(sessions));
    }),
  );

  app.post(
    '/api/v2/security/users/:userId/sessions/revoke-all',
    requireAuth,
    sessionPermission,
    writeLimiter,
    route(async (req, res) => {
      const actor = actorFrom(req);
      const targetUserId = parseTargetUserId(req.params.userId);
      const body = parseBody(revokeAllBodySchema, req.body);
      validateOptionalIdempotencyKey(req);

      const actorContext = await loadActorContext(prisma, actor);
      const target = await assertManageableTarget(prisma, actorContext, targetUserId);

      if (target.authorizationVersion !== body.expectedAuthorizationVersion) {
        fail(412, 'StaleAuthorizationVersion', 'security.sessions.stale_version');
      }

      const result = await revokeAllSessionsForUser(
        prisma,
        targetUserId,
        actor.companyId,
        { actorUserId: actor.id },
      );

      await writeAuditRequired(prisma, {
        companyId: actor.companyId,
        userId: actor.id,
        action: 'security.sessions.revoke_all',
        details: {
          targetUserId,
          revokedCount: result.revokedCount,
          revokedReason: body.reason,
        },
      });

      await notifySessionsRevoked(prisma, actor.companyId, targetUserId);

      return res.json(result);
    }),
  );
}

export {
  revokeAllBodySchema,
};
