import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { createAppLogger, type AppLogger } from './appLogger';
import { classifyFinishedRequest, normalizeRouteCategory } from './metrics';
import { redactMetadata } from './redact';

interface SecurityRequest extends Request {
  requestId?: string;
  user?: {
    id?: string;
    companyId?: string;
  };
}

export interface SafeRequestLog {
  event: 'request' | 'unhandled_error';
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs?: number;
  userId?: string;
  companyId?: string;
  errorCode?: string;
  errorClass?: string;
  errorMessage?: string;
  timestamp: string;
}

export type SafeRequestLogger = (entry: SafeRequestLog) => void;

export class CorsOriginError extends Error {
  readonly status = 403;
  readonly errorCode = 'CORS_ORIGIN_FORBIDDEN';

  constructor() {
    super('Browser origin is not allowed');
  }
}

const REQUEST_ID_HEADER = 'x-request-id';
const MAX_INBOUND_REQUEST_ID_LENGTH = 128;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Canonical inbound request-ID policy for correlation headers. */
export function resolveRequestId(inbound: unknown): string {
  if (typeof inbound !== 'string') return randomUUID();
  const trimmed = inbound.trim();
  if (!trimmed || trimmed.length > MAX_INBOUND_REQUEST_ID_LENGTH) return randomUUID();
  if (/[\x00-\x1f\x7f\r\n]/.test(trimmed)) return randomUUID();
  if (!UUID_V4_PATTERN.test(trimmed)) return randomUUID();
  return trimmed.toLowerCase();
}

function readInboundRequestId(req: Request): unknown {
  const direct = req.headers[REQUEST_ID_HEADER];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0];
  return undefined;
}

const normalizedRoute = (req: Request): string => {
  const routePath = req.route?.path;
  if (typeof routePath === 'string') return `${req.baseUrl || ''}${routePath}`;
  return req.path || '/';
};

function emitRequestLog(
  appLogger: AppLogger,
  entry: SafeRequestLog,
  status: number,
): void {
  const fields = redactMetadata({
    requestId: entry.requestId,
    method: entry.method,
    route: entry.route,
    status: entry.status,
    durationMs: entry.durationMs,
    ...(entry.userId ? { actorId: entry.userId, principalType: 'user' } : {}),
    ...(entry.companyId ? { companyId: entry.companyId } : {}),
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    ...(entry.errorClass ? { errorClass: entry.errorClass } : {}),
    ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
  }) as Record<string, unknown>;

  if (status >= 500 || entry.event === 'unhandled_error') {
    appLogger.error(entry.event === 'unhandled_error' ? 'http.unhandled_error' : 'http.request.error', fields);
    return;
  }
  appLogger.warn('http.request.client_error', fields);
}

function toSafeRequestLogger(appLogger: AppLogger): SafeRequestLogger {
  return (entry) => {
    emitRequestLog(appLogger, entry, entry.status);
  };
}

export function requestContextMiddleware(options: {
  isProduction: boolean;
  logger?: SafeRequestLogger;
  appLogger?: AppLogger;
}): RequestHandler {
  const appLogger = options.appLogger ?? createAppLogger({ isProduction: options.isProduction });
  const logger = options.logger ?? (options.isProduction ? toSafeRequestLogger(appLogger) : undefined);

  return (req: SecurityRequest, res, next) => {
    const requestId = resolveRequestId(readInboundRequestId(req));
    const started = process.hrtime.bigint();
    req.requestId = requestId;
    res.locals.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (
        res.statusCode >= 400 &&
        body != null &&
        typeof body === 'object' &&
        !Array.isArray(body)
      ) {
        const record = body as Record<string, unknown>;
        const error = typeof record.error === 'string' ? record.error : 'RequestFailed';
        const message = typeof record.message === 'string'
          ? record.message
          : typeof record.error === 'string'
            ? record.error
            : 'تعذر إكمال الطلب';
        const code = typeof record.code === 'number' || typeof record.code === 'string'
          ? record.code
          : res.statusCode;
        res.locals.errorCode = error;
        return originalJson({ ...record, error, message, code, requestId });
      }
      return originalJson(body);
    }) as Response['json'];

    res.on('finish', () => {
      const durationMs = Math.round(
        (Number(process.hrtime.bigint() - started) / 1_000_000) * 100,
      ) / 100;
      const route = normalizedRoute(req);
      classifyFinishedRequest({
        routeCategory: normalizeRouteCategory(route),
        status: res.statusCode,
        durationMs,
        opaquePrivacy: res.locals.opaquePrivacy === true,
        errorCode: typeof res.locals.errorCode === 'string' ? res.locals.errorCode : undefined,
      });

      if (res.statusCode < 400) return;
      if (!logger) return;
      logger({
        event: 'request',
        requestId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs,
        ...(req.user?.id ? { userId: req.user.id } : {}),
        ...(req.user?.companyId ? { companyId: req.user.companyId } : {}),
        ...(typeof res.locals.errorCode === 'string'
          ? { errorCode: res.locals.errorCode }
          : {}),
        timestamp: new Date().toISOString(),
      });
    });
    next();
  };
}

const writeMethods = new Set(['POST', 'PUT', 'PATCH']);

export const requireJsonContentType: RequestHandler = (req, res, next) => {
  if (!writeMethods.has(req.method)) return next();
  const contentLength = Number(req.headers['content-length'] ?? 0);
  const hasBody = contentLength > 0 || typeof req.headers['transfer-encoding'] === 'string';
  if (!hasBody || req.is('application/json')) return next();
  // Attachment upload may use multipart; JSON base64 is preferred by the Android client.
  const path = req.path || req.url?.split('?')[0] || '';
  if (
    req.method === 'POST' &&
    path === '/api/attachments' &&
    req.is('multipart/form-data')
  ) {
    return next();
  }
  return res.status(415).json({
    error: 'UnsupportedMediaType',
    message: 'يجب إرسال جسم الطلب بصيغة JSON',
    code: 415,
  });
};

const dangerousKey = new Set(['__proto__', 'prototype', 'constructor']);

function inspectPayload(value: unknown, depth = 0): string | null {
  if (depth > 20) return 'بنية الطلب متداخلة أكثر من الحد المسموح';
  if (typeof value === 'string' && value.length > 20_000) {
    return 'يتضمن الطلب نصاً أطول من الحد المسموح';
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) return 'يتضمن الطلب قائمة أكبر من الحد المسموح';
    for (const item of value) {
      const issue = inspectPayload(item, depth + 1);
      if (issue) return issue;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 200) return 'يتضمن الطلب حقولاً أكثر من الحد المسموح';
  for (const [key, nested] of entries) {
    if (dangerousKey.has(key)) return 'يتضمن الطلب مفتاحاً غير مسموح';
    const issue = inspectPayload(nested, depth + 1);
    if (issue) return issue;
  }
  return null;
}

export const payloadSafetyGuard: RequestHandler = (req, res, next) => {
  const path = req.path || '';
  if (req.method === 'POST' && path === '/api/attachments') {
    return next();
  }
  const duplicateQuery = Object.values(req.query ?? {}).some((value) => Array.isArray(value));
  if (duplicateQuery) {
    return res.status(400).json({
      error: 'DuplicateQueryParameter',
      message: 'لا يسمح بتكرار معيار البحث نفسه',
      code: 400,
    });
  }
  const issue = inspectPayload(req.body);
  if (issue) {
    return res.status(400).json({
      error: 'UnsafePayload',
      message: issue,
      code: 400,
    });
  }
  return next();
};

const safeErrorText = (error: unknown): { errorClass: string; errorMessage: string } => {
  if (!(error instanceof Error)) {
    return { errorClass: 'UnknownError', errorMessage: 'Unhandled server error' };
  }
  const errorClass = error.constructor?.name?.replace(/[^A-Za-z0-9_]/g, '').slice(0, 80) || 'Error';
  return {
    errorClass,
    errorMessage: 'Unhandled server error',
  };
};

export function finalErrorHandler(options: {
  isProduction: boolean;
  logger?: SafeRequestLogger;
  appLogger?: AppLogger;
}): ErrorRequestHandler {
  const appLogger = options.appLogger ?? createAppLogger({ isProduction: options.isProduction });
  const logger = options.logger ?? (options.isProduction ? toSafeRequestLogger(appLogger) : undefined);

  return (error: any, req: SecurityRequest, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const requestId = req.requestId ?? res.locals.requestId ?? randomUUID();
    const type = typeof error?.type === 'string' ? error.type : '';
    if (type === 'entity.too.large') {
      return res.status(413).json({
        error: 'PayloadTooLarge',
        message: 'حجم الطلب يتجاوز الحد المسموح',
        code: 413,
        requestId,
      });
    }
    if (error instanceof SyntaxError && 'body' in error) {
      return res.status(400).json({
        error: 'InvalidJson',
        message: 'صيغة JSON غير صالحة',
        code: 400,
        requestId,
      });
    }
    if (error instanceof CorsOriginError) {
      return res.status(403).json({
        error: error.errorCode,
        message: 'مصدر المتصفح غير مسموح',
        code: 403,
        requestId,
      });
    }

    if (logger) {
      const safe = safeErrorText(error);
      logger({
        event: 'unhandled_error',
        requestId,
        method: req.method,
        route: normalizedRoute(req),
        status: 500,
        ...(req.user?.id ? { userId: req.user.id } : {}),
        ...(req.user?.companyId ? { companyId: req.user.companyId } : {}),
        errorCode: 'InternalServerError',
        errorClass: safe.errorClass,
        errorMessage: safe.errorMessage,
        timestamp: new Date().toISOString(),
      });
    }
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'حدث خطأ داخلي. استخدم رقم الطلب عند التواصل مع الدعم.',
      code: 500,
      requestId,
    });
  };
}

export { createAppLogger, type AppLogger };
