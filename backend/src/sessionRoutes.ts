import type express from 'express';
import jwt from 'jsonwebtoken';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  CannotRevokeCurrentSessionError,
  listSessionsForUser,
  revokeAllSessionsForUser,
  revokeSessionByPublicId,
  SessionNotFoundError,
} from './sessions';
import type { AccessTokenPayload } from './tokens';

interface SessionRequest extends express.Request {
  user?: {
    id: string;
    companyId: string;
    employeeId: string | null;
    permissions: string[];
  };
}

export interface SessionRoutesDeps {
  app: express.Express;
  prisma: PrismaClient;
  requireAuth: express.RequestHandler;
  jwtSecret: string;
  sensitiveLimiter?: express.RequestHandler;
}

class SessionRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

const revokeAllSchema = z.object({
  exceptCurrent: z.boolean(),
}).strict();

const sessionIdParamSchema = z.string().trim().uuid();

const fail = (status: number, code: string, messageKey: string): never => {
  throw new SessionRequestError(status, code, messageKey);
};

const route = (
  handler: (req: SessionRequest, res: express.Response) => Promise<unknown>,
): express.RequestHandler => async (request, response, next) => {
  try {
    await handler(request as SessionRequest, response);
  } catch (error) {
    if (error instanceof SessionRequestError) {
      return response.status(error.status).json({
        error: error.code,
        code: error.status,
        message: error.messageKey,
        messageKey: error.messageKey,
      });
    }
    if (error instanceof SessionNotFoundError) {
      return response.status(404).json({
        error: 'NotFound',
        code: 404,
        message: 'auth.session_not_found',
        messageKey: 'auth.session_not_found',
      });
    }
    if (error instanceof CannotRevokeCurrentSessionError) {
      return response.status(409).json({
        error: 'CurrentSession',
        code: 409,
        message: 'auth.session_revoke_current_forbidden',
        messageKey: 'auth.session_revoke_current_forbidden',
      });
    }
    return next(error);
  }
};

/** Resolve the caller's public session id from JWT claim and/or X-Session-Id header. */
export function resolveCurrentSessionId(
  req: express.Request,
  jwtSecret: string,
): string | null {
  const headerValue = req.headers['x-session-id'];
  const headerSessionId = typeof headerValue === 'string' ? headerValue.trim() : '';
  if (headerSessionId && sessionIdParamSchema.safeParse(headerSessionId).success) {
    return headerSessionId;
  }

  const authorization = req.headers.authorization;
  const match = typeof authorization === 'string'
    ? authorization.match(/^Bearer\s+(\S+)$/i)
    : null;
  const token = match?.[1];
  if (!token || !jwtSecret) return null;

  try {
    const payload = jwt.verify(token, jwtSecret) as AccessTokenPayload;
    return typeof payload.sessionId === 'string' && payload.sessionId.trim()
      ? payload.sessionId.trim()
      : null;
  } catch {
    return null;
  }
}

export function registerSessionRoutes({
  app,
  prisma,
  requireAuth,
  jwtSecret,
  sensitiveLimiter,
}: SessionRoutesDeps): void {
  const writeLimiter = sensitiveLimiter ?? ((_req, _res, next) => next());

  app.get('/api/v2/auth/sessions', requireAuth, route(async (req, res) => {
    const user = req.user!;
    const currentSessionId = resolveCurrentSessionId(req, jwtSecret);
    const sessions = await listSessionsForUser(
      prisma,
      user.id,
      user.companyId,
      currentSessionId,
    );
    return res.json(sessions);
  }));

  app.delete(
    '/api/v2/auth/sessions/:sessionId',
    requireAuth,
    writeLimiter,
    route(async (req, res) => {
      const parsed = sessionIdParamSchema.safeParse(req.params.sessionId);
      if (!parsed.success) fail(404, 'NotFound', 'auth.session_not_found');

      const user = req.user!;
      const currentSessionId = resolveCurrentSessionId(req, jwtSecret);
      await revokeSessionByPublicId(prisma, parsed.data, user, {
        allowCurrent: false,
        currentSessionId,
      });
      return res.status(204).send();
    }),
  );

  app.post(
    '/api/v2/auth/sessions/revoke-all',
    requireAuth,
    writeLimiter,
    route(async (req, res) => {
      const parsed = revokeAllSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'ValidationError',
          code: 400,
          message: 'auth.session_revoke_all_invalid',
          messageKey: 'auth.session_revoke_all_invalid',
        });
      }

      const user = req.user!;
      const currentSessionId = resolveCurrentSessionId(req, jwtSecret);
      const exceptSessionId = parsed.data.exceptCurrent ? currentSessionId : null;
      const result = await revokeAllSessionsForUser(
        prisma,
        user.id,
        user.companyId,
        {
          exceptSessionId,
          actorUserId: user.id,
        },
      );
      return res.json(result);
    }),
  );
}
