import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import type { Prisma, PrismaClient } from '@prisma/client';
import { PERMISSIONS } from './permissions';
import { generateRefreshToken, hashToken, signAccessToken, attachSessionIdToAccessToken } from './tokens';
import { writeAudit, writeAuditRequired } from './audit';
import { registerFinanceRoutes } from './finance';
import { registerPayrollRoutes } from './payroll';
import { registerPayrollPaymentRoutes } from './payrollPayments';
import { registerPayrollExportRoutes } from './payrollExports';
import { registerPayrollW1aRoutes } from './payrollW1a';
import { registerTaskRoutes } from './tasks';
import { registerChatRoutes } from './chat';
import { registerAttachmentRoutes } from './attachments';
import { registerPurchasingRoutes } from './purchasing';
import { registerVendorLifecycleRoutes } from './vendorLifecycle';
import { registerPurchasingOverrideRoutes } from './purchasingOverride';
import { registerPurchasingExportRoutes } from './purchasingExports';
import { registerPurchasingQuotationRoutes } from './purchasingQuotations';
import { registerPurchasingReceiptRoutes } from './purchasingReceipts';
// Side-effect import: registers the Wave 2 purchasing reports with the report
// registration contract exactly once per process, before routes are wired.
import './purchasingReports';
import { registerTrainingRoutes } from './training';
import { registerTrainingExportRoutes } from './trainingExports';
import { registerReportRoutes } from './reports';
import { registerReportTemplateRoutes } from './reportTemplates';
import { registerReportTemplateExportRoutes } from './reportTemplateExports';
import { registerAuthorizationRoutes } from './authorizationRoutes';
import { registerSessionRoutes } from './sessionRoutes';
import { registerAdminSessionRoutes } from './adminSessionRoutes';
import { registerNotificationRoutes } from './notifications';
import { registerAttendanceWorkflowRoutes } from './attendanceWorkflows';
import { registerLeaveOnBehalfRoutes } from './leaveOnBehalf';
import { registerLeaveOverrideRoutes } from './leaveOverride';
import { registerEmployeeCredentialRoutes } from './employeeCredentials';
import {
  createEmployeeAdminResetRateLimiter,
  registerEmployeeCredentialResetRoutes,
} from './employeeCredentialReset';
import { registerEmployeeArchiveRoutes } from './employeeArchive';
import { registerSearchRoutes } from './search';
import { registerTimelineRoutes } from './timelines';
import {
  beginUserMfaChallenge,
  registerMfaRoutes,
} from './mfaRoutes';
import { MfaConfigurationError, MfaRateLimitError } from './mfa';
import {
  DEFAULT_PLATFORM_RECENT_MFA_MAX_AGE_MS,
  assertPlatformRecentMfaMaxAgeMs,
  registerPlatformAuthRoutes,
} from './platformAuth';
import { registerPlatformRoutes } from './platformRoutes';
import {
  RECOVERY_ENVIRONMENT_BINDING_ENV,
  RECOVERY_RATE_LIMIT_PEPPER_ENV,
  RECOVERY_TOKEN_PEPPER_ENV,
} from './credentialRecovery/tokenCrypto';
import {
  createCompanyOwnerRecoveryRateLimiter,
  createCompanyOwnerRecoveryService,
  createDefaultOwnerRecoveryDeliveryAdapter,
  registerCompanyOwnerRecoveryRoutes,
} from './companyOwnerRecovery';
import { createRecoveryDeliveryAdapterFromEnv } from './credentialRecovery/deliveryFactory';
import { registerPlatformOwnerRecoveryRoutes } from './platformOwnerRecovery';
import { registerPlatformPrincipalRecoveryRoutes } from './platformPrincipalRecovery';
import { registerBreakGlassCompletionRoutes } from './platformRecovery/completion';
import {
  isAccessTokenCredentialStale,
  isForcedChangeAllowedPath,
  loadUserCredentialGate,
  registerForcedPasswordChangeRoutes,
  respondPasswordChangeRequired,
  shapeMeCredentialFields,
  isCredentialGateLoginBlocked,
} from './forcedPasswordChange';
import {
  canManagePrincipal,
  grantableCapabilities,
  hasEffectiveCapability,
  isPrimaryOwner as hasExplicitPrimaryOwnership,
  loadAuthorizationContext,
  loadManagedDepartmentIds,
  type AuthorizationContext,
} from './authorization';
import {
  IdentityCollisionError,
  IdentityInputError,
  isPrismaUniqueConflict,
  loginIdentityValues,
  normalizeCompanyCode,
  normalizeEmail,
  normalizeEmployeeNumber,
  normalizeLoginIdentifier,
  syncLoginIdentities,
} from './identity';
import {
  CorsOriginError,
  createAppLogger,
  finalErrorHandler,
  payloadSafetyGuard,
  requestContextMiddleware,
  requireJsonContentType,
  type AppLogger,
  type SafeRequestLogger,
} from './security';
import { createSingleFlightReadinessProbe } from './readiness';
import {
  aiChatSchema,
  companyLoginSchema,
  createDepartmentSchema,
  createEmployeeSchema,
  createSalaryRecordSchema,
  createLeaveSchema,
  leaveReportFiltersSchema,
  loginSchema,
  logoutSchema,
  manualAttendanceSchema,
  myLeaveFiltersSchema,
  refreshSchema,
  rejectReasonSchema,
  updateDepartmentSchema,
  updateEmployeeSchema,
  validateBody,
  validateQuery,
} from './validation';

// A process-local dummy hash keeps unknown-company and unknown-identity paths
// on the same password-verification primitive without storing a credential.
const dummyLoginHash = bcrypt.hash(crypto.randomBytes(32), 10);

/** Abstraction over the AI provider so tests never need a real Gemini key. */
export interface AiProvider {
  chat(message: string): Promise<string>;
}

export interface AppConfig {
  trustProxyHops?: number;
  jwtSecret?: string;
  /** Access-token lifetime (jsonwebtoken format). Default: 15m */
  accessTokenTtl?: string;
  /** Refresh-token lifetime in days. Default: 7 */
  refreshTokenTtlDays?: number;
  /** Login/refresh rate-limit window. Default: 15 minutes */
  authRateLimitWindowMs?: number;
  /** Max attempts per IP per window. Default: 10 */
  authRateLimitMax?: number;
  /** Base64-encoded 32-byte AES key for TOTP secrets. */
  mfaEncryptionKey?: string;
  /** MFA verification attempts per challenge/IP window. Default: 5. */
  mfaRateLimitMax?: number;
  /** Separate signing secret for Platform control-plane tokens. */
  platformJwtSecret?: string;
  platformAccessTokenTtl?: string;
  platformRefreshTokenTtlDays?: number;
  platformAuthRateLimitMax?: number;
  platformProvisionRateLimitWindowMs?: number;
  platformProvisionRateLimitMax?: number;
  /** Chat message-send rate-limit window. Default: 60 seconds. */
  chatMessageRateLimitWindowMs?: number;
  /** Chat messages per user/IP per window. Default: 60. */
  chatMessageRateLimitMax?: number;
  /** Explicit allowed CORS origins. Empty/undefined in production = deny cross-origin. */
  corsOrigins?: string[];
  /** CSV exports per IP per window. */
  exportRateLimitWindowMs?: number;
  exportRateLimitMax?: number;
  /** Sensitive state-changing requests per IP per window. */
  sensitiveRateLimitWindowMs?: number;
  sensitiveRateLimitMax?: number;
  /** AI proxy requests per IP per window. */
  aiRateLimitWindowMs?: number;
  aiRateLimitMax?: number;
  /** Test/operations hook. Entries are strictly metadata-only. */
  requestLogger?: SafeRequestLogger;
  /** Structured application logger; defaults to environment-aware backend logger. */
  appLogger?: AppLogger;
  /** Deadline for the `/readyz` dependency probe. Default: 2000ms. */
  readinessTimeoutMs?: number;
  isProduction?: boolean;
  /**
   * Dedicated pepper for E1 durable recovery rate-limit buckets.
   * Used by E2 employee admin reset and E3 owner recovery.
   */
  credentialRecoveryRateLimitPepper?: string;
  /** Dedicated recovery token pepper — never reuse JWT/MFA secrets. */
  credentialRecoveryTokenPepper?: string;
  /** Server-owned recovery environment binding (`class:fingerprint`). */
  credentialRecoveryEnvironmentBinding?: string;
  /** Injected delivery adapter (tests). Production constructs via E6 factory when unset. */
  credentialRecoveryDeliveryAdapter?: import('./credentialRecovery').RecoveryDeliveryAdapter;
  /** When true with incomplete email provider config, Production construction throws. */
  credentialRecoveryRequireEmailProvider?: boolean;
  /** Recent Platform MFA max age for owner-recovery initiate (ms). Default 15m. */
  platformOwnerRecoveryRecentMfaMaxAgeMs?: number;
}

export interface AppDeps {
  prisma: PrismaClient;
  aiProvider?: AiProvider | null;
  config?: AppConfig;
}

class SalaryRequestError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string
  ) {
    super(message);
  }
}

interface AuthRequest extends express.Request {
  user?: {
    id: string;
    companyId: string;
    employeeId: string | null;
    permissions: string[];
  };
}

type LeaveTransitionRow = Prisma.LeaveRequestGetPayload<{
  include: { employee: { select: { id: true; user: { select: { id: true } } } } };
}>;

interface LeaveTransitionPlan {
  update: Prisma.LeaveRequestUpdateManyMutationInput;
  historyAction: string;
  auditAction: string;
  reason?: string;
  successMessage: string;
  notify?: (tx: Prisma.TransactionClient, leave: LeaveTransitionRow) => Promise<void>;
}

type LeaveTransitionOutcome =
  | { kind: 'not_found' }
  | { kind: 'self' }
  | { kind: 'conflict' }
  | { kind: 'success'; message: string };

export function createApp({ prisma, aiProvider = null, config = {} }: AppDeps): express.Express {
  const app = express();

  const JWT_SECRET = config.jwtSecret;
  const ACCESS_TOKEN_TTL = config.accessTokenTtl ?? '15m';
  const REFRESH_TOKEN_TTL_DAYS = config.refreshTokenTtlDays ?? 7;

  if (config.isProduction && (!JWT_SECRET || Buffer.byteLength(JWT_SECRET, 'utf8') < 32)) {
    throw new Error('Production JWT signing configuration is missing or too weak');
  }
  if (
    config.platformJwtSecret &&
    (config.platformJwtSecret === JWT_SECRET ||
      (config.isProduction && Buffer.byteLength(config.platformJwtSecret, 'utf8') < 32))
  ) {
    throw new Error('Platform JWT signing configuration must be strong and separate');
  }
  if (config.isProduction && (!Number.isFinite(REFRESH_TOKEN_TTL_DAYS) || REFRESH_TOKEN_TTL_DAYS < 1)) {
    throw new Error('Production refresh-token lifetime configuration is invalid');
  }

  app.disable('x-powered-by');
  if (config.trustProxyHops) app.set('trust proxy', config.trustProxyHops);
  const appLogger = config.appLogger ?? createAppLogger({
    isProduction: Boolean(config.isProduction),
  });
  app.use(requestContextMiddleware({
    isProduction: Boolean(config.isProduction),
    logger: config.requestLogger,
    appLogger,
  }));
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: config.isProduction
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
  }));

  // ---------- CORS ----------
  // Native Android clients do not send an Origin header, so CORS only affects
  // browsers. Production requires an explicit allow-list via CORS_ORIGINS.
  const allowedOrigins = new Set(config.corsOrigins ?? []);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(new CorsOriginError());
    },
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Session-Id', 'Idempotency-Key'],
    optionsSuccessStatus: 204,
  }));

  app.use(requireJsonContentType);
  app.use((req, res, next) => {
    const path = req.path || '';
    if (req.method === 'POST' && path === '/api/attachments') {
      return express.json({ limit: '8mb' })(req, res, next);
    }
    return express.json({ limit: '1mb' })(req, res, next);
  });
  app.use(payloadSafetyGuard);

  // Public liveness probe for hosting platforms (Render health check).
  // Deliberately minimal: no DB call, no config, no secrets, no writes.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Readiness runs under a deadline: a hung database must fail closed as
  // "not ready" instead of leaving the probe pending until the platform's own
  // timeout fires. Single-flight so repeated platform probes against a hung
  // database cannot accumulate one pool connection each.
  const probeDatabaseReadiness = createSingleFlightReadinessProbe(
    () => prisma.$queryRaw`SELECT 1`,
    config.readinessTimeoutMs,
  );

  app.get('/readyz', async (req, res) => {
    const outcome = await probeDatabaseReadiness();
    if (outcome.ready) {
      return res.status(200).json({ status: 'ready' });
    }
    appLogger.warn('http.readiness_failed', {
      requestId: (req as any).requestId ?? res.locals.requestId,
      route: '/readyz',
      status: 503,
      errorCode: 'ServiceUnavailable',
      // Operator-facing only. A hung dependency and a refused dependency are
      // different incidents; the public body stays identical for both.
      readinessReason: outcome.reason,
    });
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'الخدمة غير جاهزة حالياً',
      code: 503,
    });
  });

  // ---------- MIDDLEWARE ----------
  const requireAuth = async (
    req: AuthRequest,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (!JWT_SECRET)
      return res.status(500).json({
        error: 'SystemConfigurationError',
        message: 'إعداد المصادقة غير متاح',
        code: 500,
      });
    const authorization = req.headers.authorization;
    const match = typeof authorization === 'string'
      ? authorization.match(/^Bearer\s+(\S+)$/i)
      : null;
    const token = match?.[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const payload = jwt.verify(token, JWT_SECRET) as AuthRequest['user'] & {
        permissions?: unknown;
        authorizationVersion?: unknown;
        credentialVersion?: unknown;
        iat?: unknown;
      };
      const id = typeof payload?.id === 'string' ? payload.id : '';
      const companyId = typeof payload?.companyId === 'string' ? payload.companyId : '';
      const employeeId = payload?.employeeId != null ? String(payload.employeeId) : null;
      if (!id || !companyId) throw new Error('Invalid token payload');
      const activeBindingCount = await prisma.user.count({
        where: {
          id,
          companyId,
          employeeId,
          OR: [
            { employeeId: null },
            { employee: { is: { status: 'active' } } },
          ],
        },
      });
      if (activeBindingCount !== 1) throw new Error('Invalid token tenant binding');

      let effectivePermissions = Array.isArray(payload!.permissions)
        ? (payload!.permissions as string[])
        : [];
      // Real Prisma clients resolve Role + active grants + unexpired
      // delegations on every request. Test doubles keep the signed-token path
      // so legacy route tests remain isolated from the RC2 persistence surface.
      if (typeof (prisma as PrismaClient & { $connect?: unknown }).$connect === 'function') {
        const authorizationContext = await loadAuthorizationContext(prisma, { userId: id, companyId });
        if (!authorizationContext) throw new Error('Invalid authorization context');
        if (
          !Number.isInteger(payload!.authorizationVersion) ||
          payload!.authorizationVersion !== authorizationContext.authorizationVersion
        ) {
          throw new Error('Stale authorization version');
        }
        effectivePermissions = authorizationContext.flatPermissions;
      }
      req.user = {
        id,
        companyId,
        employeeId,
        permissions: effectivePermissions,
      };
      const credentialGate = await loadUserCredentialGate(prisma, id, companyId);
      if (credentialGate?.accountStatus && credentialGate.accountStatus !== 'active') {
        throw new Error('Inactive account');
      }
      if (credentialGate && isAccessTokenCredentialStale(payload, credentialGate)) {
        throw new Error('Stale credential version');
      }
      if (credentialGate?.mustChangePassword) {
        if (!isForcedChangeAllowedPath(req.method, req.path)) {
          return respondPasswordChangeRequired(res);
        }
      }
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };

  const checkPermission = (requiredPermission: string) => {
    return (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
      const perms = req.user?.permissions ?? [];
      // admin.full is the ONLY bypass; everything else needs the exact key.
      if (perms.includes(PERMISSIONS.ADMIN_FULL) || perms.includes(requiredPermission)) {
        return next();
      }
      return res.status(403).json({ error: 'Forbidden' });
    };
  };

  const hasPermission = (permissions: string[], permission: string): boolean =>
    permissions.includes(PERMISSIONS.ADMIN_FULL) || permissions.includes(permission);

  class AuthorizationMutationDenied extends Error {}

  const mutationAuthorizationContext = async (
    db: PrismaClient | Prisma.TransactionClient,
    user: NonNullable<AuthRequest['user']>,
  ): Promise<AuthorizationContext | null> => {
    if (typeof (prisma as PrismaClient & { $connect?: unknown }).$connect === 'function') {
      return loadAuthorizationContext(db, { userId: user.id, companyId: user.companyId });
    }
    const isPrimaryOwner = await hasExplicitPrimaryOwnership(db, user.companyId, user.id);
    return {
      userId: user.id,
      companyId: user.companyId,
      employeeId: user.employeeId,
      employeeDepartmentId: null,
      authorizationVersion: 0,
      isPrimaryOwner,
      managedDepartmentIds: [],
      baselinePermissions: user.permissions,
      capabilities: user.permissions.map((capability) => ({
        capability,
        scopeType: 'company' as const,
        departmentId: null,
        source: 'role' as const,
      })),
      flatPermissions: user.permissions,
    };
  };

  const assertCompanyPrincipalMutation = async (
    db: PrismaClient | Prisma.TransactionClient,
    user: NonNullable<AuthRequest['user']>,
    targetUserId?: string | null,
  ): Promise<AuthorizationContext> => {
    const actor = await mutationAuthorizationContext(db, user);
    const mayManage = actor && hasEffectiveCapability(
      actor,
      PERMISSIONS.EMPLOYEES_PERMISSIONS_MANAGE,
      { scopeType: 'company' },
    ) && hasEffectiveCapability(
      actor,
      PERMISSIONS.PERMISSIONS_MANAGE_COMPANY,
      { scopeType: 'company' },
    );
    if (!actor || !mayManage || targetUserId === actor.userId) {
      throw new AuthorizationMutationDenied();
    }
    if (targetUserId) {
      const decision = await canManagePrincipal(
        db,
        actor,
        targetUserId,
        { scopeType: 'company' },
      );
      if (!decision.allowed) {
        throw new AuthorizationMutationDenied();
      }
    }
    return actor;
  };

  const checkAnyPermission = (...requiredPermissions: string[]) => {
    return (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
      const permissions = req.user?.permissions ?? [];
      if (
        permissions.includes(PERMISSIONS.ADMIN_FULL) ||
        requiredPermissions.some((permission) => permissions.includes(permission))
      ) {
        return next();
      }
      return res.status(403).json({
        error: 'Forbidden',
        message: 'لا تملك صلاحية تنفيذ هذا الإجراء',
        code: 403,
      });
    };
  };

  // ---- Explicit-owner and legacy-admin protected-principal privacy helpers ----
  // CompanyOwnership alone is ownership evidence. A legacy admin.full target
  // remains protected for privacy/peer-management compatibility, but never
  // receives ownership capabilities or an ownership row from this classification.
  const parseRolePermissions = (permissions: string | null | undefined): string[] => {
    if (!permissions) return [];
    try {
      const parsed = JSON.parse(permissions);
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : [];
    } catch {
      return [];
    }
  };
  const isOwnerUser = (user: { role?: { permissions?: string | null } | null } | null): boolean =>
    parseRolePermissions(user?.role?.permissions).includes(PERMISSIONS.ADMIN_FULL);
  const primaryOwnerUserId = async (companyId: string): Promise<string | null> => {
    const ownership = await prisma.companyOwnership.findFirst({
      where: { companyId, isPrimary: true, status: 'active' },
      select: { userId: true },
    });
    return ownership?.userId ?? null;
  };
  const isProtectedPrincipalUser = async (
    user: { id?: string; role?: { permissions?: string | null } | null } | null,
    companyId: string,
  ): Promise<boolean> => Boolean(user?.id) && (
    await hasExplicitPrimaryOwnership(prisma, companyId, user!.id!) || isOwnerUser(user)
  );
  const isOwnerDataViewer = (perms: string[]): boolean =>
    perms.includes(PERMISSIONS.ADMIN_FULL) || perms.includes(PERMISSIONS.HR_VIEW);

  // Salary privacy is deliberately independent from general owner-data visibility.
  // admin.full may manage a normal employee, but never bypasses salary.view_owner.
  const canAccessSalary = (
    permissions: string[],
    targetIsOwner: boolean,
    write: boolean
  ): boolean => {
    if (targetIsOwner && !permissions.includes(PERMISSIONS.SALARY_VIEW_OWNER)) return false;
    return write
      ? permissions.includes(PERMISSIONS.SALARY_MANAGE) || permissions.includes(PERMISSIONS.ADMIN_FULL)
      : permissions.includes(PERMISSIONS.SALARY_VIEW_COMPANY) || permissions.includes(PERMISSIONS.ADMIN_FULL);
  };

  const salaryTargetInclude = {
    user: {
      select: {
        id: true,
        name: true,
        role: { select: { permissions: true } },
      },
    },
    department: { select: { name: true } },
  } as const;

  const salaryEmployeeShape = (employee: any) => ({
    id: employee.id,
    employeeNum: employee.employeeNum,
    name: employee.user?.name ?? 'موظف',
    jobTitle: employee.jobTitle,
    departmentName: employee.department?.name ?? null,
  });

  const dateOnly = (value: Date | string): string => new Date(value).toISOString().slice(0, 10);
  const timestamp = (value: Date | string): string => new Date(value).toISOString();
  const moneyString = (value: { toString(): string } | string | number): string => {
    const raw = value.toString();
    const [whole, fraction = ''] = raw.split('.');
    return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
  };
  const salaryRecordShape = (record: any) => ({
    id: record.id,
    employeeId: record.employeeId,
    baseSalary: moneyString(record.baseSalary),
    currency: record.currency,
    effectiveFrom: dateOnly(record.effectiveFrom),
    effectiveTo: record.effectiveTo ? dateOnly(record.effectiveTo) : null,
    createdAt: timestamp(record.createdAt),
  });

  const currentSalaryWhere = (companyId: string, employeeId: string, today: Date) => ({
    companyId,
    employeeId,
    effectiveFrom: { lte: today },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
  });

  const salaryTargetNotFound = (res: express.Response) =>
    res.status(404).json({
      error: 'EmployeeNotFound',
      message: 'الموظف غير موجود',
      code: 404,
    });

  const salaryAccessDenied = (
    res: express.Response,
    permissions: string[],
    targetIsOwner: boolean,
    write: boolean
  ): boolean => {
    if (canAccessSalary(permissions, targetIsOwner, write)) return false;
    if (targetIsOwner) {
      salaryTargetNotFound(res);
    } else {
      res.status(403).json({
        error: 'Forbidden',
        message: 'لا تملك صلاحية الوصول إلى بيانات الراتب',
        code: 403,
      });
    }
    return true;
  };

  const isDepartmentManagerRole = (role: { permissions?: string | null } | null): boolean => {
    const permissions = parseRolePermissions(role?.permissions);
    return !permissions.includes(PERMISSIONS.ADMIN_FULL) && permissions.some((permission) =>
      permission === PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT ||
      permission === PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT ||
      permission === PERMISSIONS.HR_MANAGE
    );
  };

  // Strict limiter for credential endpoints only (not the whole API).
  const authLimiter = rateLimit({
    windowMs: config.authRateLimitWindowMs ?? 15 * 60 * 1000,
    limit: config.authRateLimitMax ?? 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'TooManyRequests', message: 'محاولات كثيرة. حاول مرة أخرى لاحقاً.', code: 429 },
  });

  const companyAuthLimiter = rateLimit({
    windowMs: config.authRateLimitWindowMs ?? 15 * 60 * 1000,
    limit: config.authRateLimitMax ?? 10,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const rawCode = typeof req.body?.companyCode === 'string' ? req.body.companyCode : '';
      let canonicalCandidate = '';
      try {
        canonicalCandidate = rawCode.normalize('NFKC').trim().toUpperCase().slice(0, 64);
      } catch {
        canonicalCandidate = '';
      }
      const networkKey = ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown');
      return crypto.createHash('sha256')
        .update(`${networkKey}\u0000${canonicalCandidate}`)
        .digest('hex');
    },
    message: { error: 'TooManyRequests', message: 'محاولات كثيرة. حاول مرة أخرى لاحقاً.', code: 429 },
  });

  const mfaLimiter = rateLimit({
    windowMs: config.authRateLimitWindowMs ?? 15 * 60 * 1000,
    limit: config.mfaRateLimitMax ?? 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const challenge = typeof req.body?.challengeToken === 'string'
        ? req.body.challengeToken.slice(0, 200)
        : '';
      const networkKey = ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown');
      return crypto.createHash('sha256')
        .update(`${networkKey}\u0000${challenge}`)
        .digest('hex');
    },
    message: {
      code: 'MfaRateLimited',
      messageKey: 'auth.mfa_rate_limited',
    },
  });

  const platformAuthLimiter = rateLimit({
    windowMs: config.authRateLimitWindowMs ?? 15 * 60 * 1000,
    limit: config.platformAuthRateLimitMax ?? 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      code: 'PlatformRateLimited',
      messageKey: 'platform.rate_limited',
    },
  });
  const platformProvisionLimiter = rateLimit({
    windowMs: config.platformProvisionRateLimitWindowMs ?? 60 * 60 * 1000,
    limit: config.platformProvisionRateLimitMax ?? 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const principalId = (req as express.Request & {
        platformPrincipal?: { id?: string };
      }).platformPrincipal?.id ?? 'unknown';
      const networkKey = ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown');
      return crypto.createHash('sha256')
        .update(`${networkKey}\u0000${principalId}`)
        .digest('hex');
    },
    message: {
      code: 'PlatformProvisionRateLimited',
      messageKey: 'platform.provision_rate_limited',
    },
  });

  const exportLimiter = rateLimit({
    windowMs: config.exportRateLimitWindowMs ?? 60_000,
    limit: config.exportRateLimitMax ?? 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'TooManyExportRequests',
      message: 'طلبات تصدير كثيرة. حاول مرة أخرى لاحقاً.',
      code: 429,
    },
  });

  const sensitiveLimiter = rateLimit({
    windowMs: config.sensitiveRateLimitWindowMs ?? 60_000,
    limit: config.sensitiveRateLimitMax ?? 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'TooManySensitiveRequests',
      message: 'طلبات كثيرة على عملية حساسة. حاول مرة أخرى لاحقاً.',
      code: 429,
    },
  });

  // Sprint 12L: global search is read-only but fans out across modules, so it
  // gets its own limiter bucket (reuses the sensitive-route configuration).
  const searchLimiter = rateLimit({
    windowMs: config.sensitiveRateLimitWindowMs ?? 60_000,
    limit: config.sensitiveRateLimitMax ?? 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'TooManySearchRequests',
      message: 'طلبات بحث كثيرة. حاول مرة أخرى لاحقاً.',
      code: 429,
    },
  });

  const aiLimiter = rateLimit({
    windowMs: config.aiRateLimitWindowMs ?? 60_000,
    limit: config.aiRateLimitMax ?? 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'TooManyAiRequests',
      message: 'طلبات كثيرة للمساعد الذكي. حاول مرة أخرى لاحقاً.',
      code: 429,
    },
  });

  const sensitiveWriteRoute = /^\/api\/(?:payroll|purchasing|training|attendance\/manual|employees\/[^/]+\/salary|leaves\/[^/]+\/(?:hr|admin)-(?:approve|reject))/;
  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method) || !sensitiveWriteRoute.test(req.path)) {
      return next();
    }
    return sensitiveLimiter(req, res, next);
  });

  const issueTokens = async (user: {
    id: string;
    companyId: string;
    employeeId: string | null;
    permissions: string[];
    authorizationVersion: number;
    credentialVersion: number;
  }, session: { deviceLabel?: string; platform?: string } = {}) => {
    const sessionId = crypto.randomUUID();
    const refresh = generateRefreshToken(REFRESH_TOKEN_TTL_DAYS);
    const credentialVersion = Number.isInteger(user.credentialVersion) && user.credentialVersion >= 1
      ? user.credentialVersion
      : 1;
    await prisma.refreshToken.create({
      data: {
        sessionId,
        userId: user.id,
        companyId: user.companyId,
        tokenHash: refresh.hash,
        expiresAt: refresh.expiresAt,
        credentialVersion,
        deviceLabel: session.deviceLabel ?? null,
        platform: session.platform ?? null,
      },
    });
    const accessToken = attachSessionIdToAccessToken(
      {
        id: user.id,
        companyId: user.companyId,
        employeeId: user.employeeId,
        permissions: user.permissions,
        authorizationVersion: user.authorizationVersion,
        credentialVersion,
      },
      sessionId,
      JWT_SECRET!,
      ACCESS_TOKEN_TTL,
    );
    return { accessToken, refreshToken: refresh.token, sessionId };
  };

  registerMfaRoutes({
    app,
    prisma,
    limiter: mfaLimiter,
    encryptionKey: config.mfaEncryptionKey,
    issueTokens,
  });
  const { requirePlatformAuth } = registerPlatformAuthRoutes({
    app,
    prisma,
    limiter: platformAuthLimiter,
    jwtSecret: config.platformJwtSecret,
    mfaEncryptionKey: config.mfaEncryptionKey,
    accessTokenTtl: config.platformAccessTokenTtl,
    refreshTokenTtlDays: config.platformRefreshTokenTtlDays,
  });
  registerPlatformRoutes({
    app,
    prisma,
    requirePlatformAuth,
    provisionLimiter: platformProvisionLimiter,
  });

  const recoveryRateLimitPepper = config.credentialRecoveryRateLimitPepper
    ?? process.env[RECOVERY_RATE_LIMIT_PEPPER_ENV]
    ?? null;
  const recoveryTokenPepper = config.credentialRecoveryTokenPepper
    ?? process.env[RECOVERY_TOKEN_PEPPER_ENV]
    ?? null;
  const recoveryEnvironmentBinding = config.credentialRecoveryEnvironmentBinding
    ?? process.env[RECOVERY_ENVIRONMENT_BINDING_ENV]
    ?? null;
  const ownerRecoveryService = createCompanyOwnerRecoveryService(prisma, {
    tokenPepper: recoveryTokenPepper,
    environmentBinding: recoveryEnvironmentBinding,
  });
  const ownerRecoveryRateLimiter = createCompanyOwnerRecoveryRateLimiter(
    prisma,
    recoveryRateLimitPepper,
    {
      useInMemoryStore: typeof (prisma as PrismaClient & { $connect?: unknown }).$connect !== 'function',
    },
  );
  const recoveryDeliveryConstruction = config.credentialRecoveryDeliveryAdapter
    ? {
      adapter: config.credentialRecoveryDeliveryAdapter,
      mode: 'https_transactional_email' as const,
    }
    : createRecoveryDeliveryAdapterFromEnv({
      prisma,
      isProduction: Boolean(config.isProduction),
      allowLocalHttp: !config.isProduction,
      env: {
        ...process.env,
        ...(config.credentialRecoveryRequireEmailProvider
          ? { RECOVERY_EMAIL_REQUIRE_PROVIDER: 'true' }
          : {}),
      },
    });
  const ownerRecoveryDelivery = recoveryDeliveryConstruction.adapter
    ?? createDefaultOwnerRecoveryDeliveryAdapter();
  if (recoveryDeliveryConstruction.mode === 'unavailable') {
    appLogger.warn('credential_recovery_e6_delivery_unavailable', {
      reason: recoveryDeliveryConstruction.reason ?? 'unavailable',
    });
  }
  const platformOwnerRecoveryMfaMaxAgeMs = config.platformOwnerRecoveryRecentMfaMaxAgeMs != null
    ? assertPlatformRecentMfaMaxAgeMs(config.platformOwnerRecoveryRecentMfaMaxAgeMs)
    : DEFAULT_PLATFORM_RECENT_MFA_MAX_AGE_MS;

  if (
    config.isProduction
    && (!ownerRecoveryService || !ownerRecoveryRateLimiter || !recoveryRateLimitPepper)
  ) {
    appLogger.warn('credential_recovery_e3_config_incomplete', {
      hasService: Boolean(ownerRecoveryService),
      hasRateLimiter: Boolean(ownerRecoveryRateLimiter),
    });
  }

  registerCompanyOwnerRecoveryRoutes({
    app,
    prisma,
    recoveryService: ownerRecoveryService,
    rateLimiter: ownerRecoveryRateLimiter,
    deliveryAdapter: ownerRecoveryDelivery,
    isProduction: Boolean(config.isProduction),
  });
  registerPlatformOwnerRecoveryRoutes({
    app,
    prisma,
    requirePlatformAuth,
    recoveryService: ownerRecoveryService,
    rateLimiter: ownerRecoveryRateLimiter,
    deliveryAdapter: ownerRecoveryDelivery,
    recentMfaMaxAgeMs: platformOwnerRecoveryMfaMaxAgeMs,
    rateLimitPepper: recoveryRateLimitPepper,
    isProduction: Boolean(config.isProduction),
  });
  // E4 Platform Principal self-service password recovery + safe discovery.
  // Reuses the same E1 CredentialRecoveryService / rate limiter / delivery adapter.
  registerPlatformPrincipalRecoveryRoutes({
    app,
    prisma,
    recoveryService: ownerRecoveryService,
    rateLimiter: ownerRecoveryRateLimiter,
    deliveryAdapter: ownerRecoveryDelivery,
    isProduction: Boolean(config.isProduction),
  });
  // E5 break-glass package completion (auth-plane only — does not execute break-glass).
  registerBreakGlassCompletionRoutes({
    app,
    prisma,
    recoveryService: ownerRecoveryService,
    limiter: platformAuthLimiter,
    isProduction: Boolean(config.isProduction),
  });

  const ownerMfaChallenge = async (user: any) => {
    if (user.mustChangePassword) return null;
    const isPrimaryOwner = await hasExplicitPrimaryOwnership(
      prisma,
      user.companyId,
      user.id,
    );
    if (!isPrimaryOwner) return null;
    return beginUserMfaChallenge({
      prisma,
      user,
      encryptionKey: config.mfaEncryptionKey,
    });
  };

  // The Android client sends Arabic leave-type labels; older tests/tools use
  // English. Business rules must match BOTH spellings (contract-mismatch fix).
  const isAnnualLeave = (t: string) => t === 'annual' || t === 'سنوية';
  const isSickLeave = (t: string) => t === 'sick' || t === 'مرضية';

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

  // User role permissions are selected only to enforce owner privacy. They are
  // removed by shapeLeaveRequest and never leave the API.
  const leaveSafeSelect = {
    id: true,
    employeeId: true,
    leaveType: true,
    startDate: true,
    endDate: true,
    totalDays: true,
    reason: true,
    status: true,
    exitReentryRequested: true,
    visaFeePaid: true,
    rejectionReason: true,
    createdAt: true,
    updatedAt: true,
    employee: {
      select: {
        id: true,
        employeeNum: true,
        departmentId: true,
        user: {
          select: {
            id: true,
            name: true,
            role: { select: { permissions: true } },
          },
        },
        department: { select: { id: true, name: true } },
      },
    },
  } as const;

  const shapeLeaveRequest = (row: any) => ({
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    employee: row.employee
      ? {
          id: row.employee.id,
          employeeNum: row.employee.employeeNum,
          name: row.employee.user?.name ?? 'موظف',
          departmentId: row.employee.departmentId ?? null,
          department: row.employee.department
            ? { id: row.employee.department.id, name: row.employee.department.name }
            : null,
        }
      : null,
  });

  const claimLeaveTransition = async (input: {
    leaveRequestId: string;
    companyId: string;
    actorUserId: string;
    actorEmployeeId: string | null;
    expectedStatus: string;
    buildPlan: (leave: LeaveTransitionRow) => LeaveTransitionPlan;
  }): Promise<LeaveTransitionOutcome> =>
    prisma.$transaction(async (tx) => {
      const leave = await tx.leaveRequest.findFirst({
        where: { id: input.leaveRequestId, companyId: input.companyId },
        include: { employee: { select: { id: true, user: { select: { id: true } } } } },
      });
      if (!leave) return { kind: 'not_found' };
      if (leave.employeeId === input.actorEmployeeId) return { kind: 'self' };

      const plan = input.buildPlan(leave);
      const claimed = await tx.leaveRequest.updateMany({
        where: {
          id: leave.id,
          companyId: input.companyId,
          status: input.expectedStatus,
        },
        data: plan.update,
      });

      if (claimed.count !== 1) {
        // Re-check only inside the already-authorized tenant scope. No current
        // status is returned, so a foreign-company identifier remains opaque.
        const stillVisible = await tx.leaveRequest.findFirst({
          where: { id: leave.id, companyId: input.companyId },
          select: { id: true },
        });
        return stillVisible ? { kind: 'conflict' } : { kind: 'not_found' };
      }

      await tx.leaveApprovalHistory.create({
        data: {
          companyId: input.companyId,
          leaveRequestId: leave.id,
          actionByUserId: input.actorUserId,
          action: plan.historyAction,
          ...(plan.reason ? { reason: plan.reason } : {}),
        },
      });
      await writeAuditRequired(tx, {
        companyId: input.companyId,
        userId: input.actorUserId,
        action: plan.auditAction,
        details: { leaveRequestId: leave.id },
      });
      await plan.notify?.(tx, leave);

      return { kind: 'success', message: plan.successMessage };
    });

  const sendLeaveTransition = (
    res: express.Response,
    outcome: LeaveTransitionOutcome,
    selfError: string,
  ) => {
    if (outcome.kind === 'not_found') return res.status(404).json({ error: 'Not found' });
    if (outcome.kind === 'self') return res.status(403).json({ error: selfError });
    if (outcome.kind === 'conflict') {
      return res.status(409).json({
        error: 'LeaveStateConflict',
        message: 'تمت معالجة طلب الإجازة مسبقاً أو تغيرت حالته',
        code: 409,
      });
    }
    return res.json({ message: outcome.message });
  };

  const leaveFilterWhere = (filters: {
    from?: string;
    to?: string;
    status?: string;
    leaveType?: string;
    employeeId?: string;
  }) => {
    const where: any = {};
    if (filters.from && filters.to) {
      // UTC is the current API-wide date contract; company timezones are not
      // configured yet. Overlap semantics keep multi-day leave visible.
      where.startDate = { lte: new Date(`${filters.to}T23:59:59.999Z`) };
      where.endDate = { gte: new Date(`${filters.from}T00:00:00.000Z`) };
    }
    if (filters.status) where.status = filters.status;
    if (filters.leaveType) where.leaveType = { in: leaveTypeAliases[filters.leaveType] };
    if (filters.employeeId) where.employeeId = filters.employeeId;
    return where;
  };

  // --------------- ROUTES: AUTH ---------------
  const authUserInclude = { role: true, employee: true, company: true } as const;
  const isLoginEligible = (user: any): boolean =>
    Boolean(user) &&
    (!user.accountStatus || user.accountStatus === 'active') &&
    (!user.employee || user.employee.status === 'active') &&
    !user.employee?.archivedAt;
  const genericLoginFailure = (res: express.Response, status: number) =>
    res.status(status).json({ error: 'Invalid credentials' });
  const shapeAuthenticatedUser = (user: any, permissions: string[]) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    companyId: user.companyId,
    employeeId: user.employeeId,
    roleId: user.role.id,
    roleName: user.role.name,
    permissions,
    mustChangePassword: Boolean(user.mustChangePassword),
    temporaryPasswordExpiresAt: user.temporaryPasswordExpiresAt
      ? new Date(user.temporaryPasswordExpiresAt).toISOString()
      : null,
  });
  const verifyResolvedLogin = async (user: any, password: string): Promise<boolean> => {
    const candidateHash = user?.password ?? await dummyLoginHash;
    const passwordMatches = await bcrypt.compare(password, candidateHash);
    if (!Boolean(user) || !passwordMatches || !isLoginEligible(user)) return false;
      if (
        isCredentialGateLoginBlocked({
          mustChangePassword: Boolean(user.mustChangePassword),
          temporaryPasswordExpiresAt: user.temporaryPasswordExpiresAt
            ? new Date(user.temporaryPasswordExpiresAt)
            : null,
          accountStatus: user.accountStatus ?? 'active',
          credentialVersion: user.credentialVersion ?? 1,
          passwordChangedAt: user.passwordChangedAt
            ? new Date(user.passwordChangedAt)
            : null,
        })
      ) {
        return false;
      }
    return true;
  };
  const bodyPassword = (body: unknown): string => {
    if (typeof body !== 'object' || body === null || !('password' in body)) return '';
    return typeof body.password === 'string' ? body.password : '';
  };

  app.post('/api/v2/auth/login', authLimiter, companyAuthLimiter, async (req, res) => {
    const body = validateBody(companyLoginSchema, req, res);
    if (!body) return;

    try {
      let companyCode: string;
      let normalizedIdentifier: string;
      try {
        companyCode = normalizeCompanyCode(body.companyCode);
        normalizedIdentifier = normalizeLoginIdentifier(body.identifier);
      } catch (error) {
        if (!(error instanceof IdentityInputError)) throw error;
        await verifyResolvedLogin(null, body.password);
        return genericLoginFailure(res, 401);
      }

      const company = await prisma.company.findUnique({ where: { code: companyCode } });
      const identity = company
        ? await prisma.loginIdentity.findUnique({
            where: {
              companyId_normalizedIdentifier: {
                companyId: company.id,
                normalizedIdentifier,
              },
            },
            include: { user: { include: authUserInclude } },
          })
        : null;
      const user = identity?.user ?? null;

      if (!await verifyResolvedLogin(user, body.password)) {
        if (user) {
          await writeAudit(prisma, {
            companyId: user.companyId,
            userId: user.id,
            action: 'auth.login.failure',
            details: { flow: 'v2' },
          });
        }
        return genericLoginFailure(res, 401);
      }

      if (!JWT_SECRET) {
        return res.status(500).json({
          error: 'SystemConfigurationError',
          message: 'إعداد المصادقة غير متاح',
          code: 500,
        });
      }

      const permissions = parseRolePermissions(user.role.permissions);
      const mfaChallenge = await ownerMfaChallenge(user);
      if (mfaChallenge) {
        await writeAudit(prisma, {
          companyId: user.companyId,
          userId: user.id,
          action: 'auth.login.mfa_challenge',
          details: { flow: 'v2' },
        });
        return res.json({
          ...mfaChallenge,
          user: {
            ...shapeAuthenticatedUser(user, permissions),
            mfaRequired: true,
            mfaEnrolled: !mfaChallenge.enrollmentRequired,
          },
          company: { id: company!.id, code: company!.code, name: company!.name },
        });
      }
      const { accessToken, refreshToken } = await issueTokens({
        id: user.id,
        companyId: user.companyId,
        employeeId: user.employeeId,
        permissions,
        authorizationVersion: user.authorizationVersion,
        credentialVersion: user.credentialVersion ?? 1,
      }, {
        deviceLabel: body.deviceLabel,
        platform: body.platform,
      });
      await writeAudit(prisma, {
        companyId: user.companyId,
        userId: user.id,
        action: 'auth.login.success',
        details: { flow: 'v2' },
      });

      return res.json({
        accessToken,
        refreshToken,
        user: shapeAuthenticatedUser(user, permissions),
        company: { id: company!.id, code: company!.code, name: company!.name },
      });
    } catch (error) {
      if (error instanceof MfaConfigurationError) {
        return res.status(503).json({
          code: 'MfaUnavailable',
          messageKey: 'auth.mfa_unavailable',
        });
      }
      if (error instanceof MfaRateLimitError) {
        return res.status(429).json({
          code: 'MfaRateLimited',
          messageKey: 'auth.mfa_rate_limited',
        });
      }
      return res.status(500).json({ error: 'Login failed' });
    }
  });

  app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
      const body = validateBody(loginSchema, req, res);
      if (!body) return;
      const normalizedIdentifier = normalizeLoginIdentifier(body.email);
      const identities = await prisma.loginIdentity.findMany({
        where: { normalizedIdentifier },
        include: { user: { include: authUserInclude } },
        take: 3,
      });
      const resolvedUsers = new Map<string, any>();
      const eligibleUsers = new Map<string, any>();
      for (const identity of identities) {
        resolvedUsers.set(`${identity.companyId}:${identity.userId}`, identity.user);
        if (isLoginEligible(identity.user)) {
          eligibleUsers.set(`${identity.companyId}:${identity.userId}`, identity.user);
        }
      }
      const user = eligibleUsers.size === 1 ? [...eligibleUsers.values()][0] : null;

      if (!await verifyResolvedLogin(user, body.password)) {
        const auditUser = resolvedUsers.size === 1 ? [...resolvedUsers.values()][0] : null;
        if (auditUser) {
          await writeAudit(prisma, {
            companyId: auditUser.companyId,
            userId: auditUser.id,
            action: 'auth.login.failure',
            details: { flow: 'legacy' },
          });
        }
        return genericLoginFailure(res, 400);
      }

      if (!JWT_SECRET) {
        return res.status(500).json({
          error: 'SystemConfigurationError',
          message: 'إعداد المصادقة غير متاح',
          code: 500,
        });
      }

      const permissions = parseRolePermissions(user.role.permissions);
      const mfaChallenge = await ownerMfaChallenge(user);
      if (mfaChallenge) {
        await writeAudit(prisma, {
          companyId: user.companyId,
          userId: user.id,
          action: 'auth.login.mfa_challenge',
          details: { flow: 'legacy' },
        });
        return res.json({
          ...mfaChallenge,
          user: {
            ...shapeAuthenticatedUser(user, permissions),
            mfaRequired: true,
            mfaEnrolled: !mfaChallenge.enrollmentRequired,
          },
          company: {
            id: user.company.id,
            code: user.company.code,
            name: user.company.name,
          },
        });
      }
      const { accessToken, refreshToken } = await issueTokens({
        id: user.id,
        companyId: user.companyId,
        employeeId: user.employeeId,
        permissions,
        authorizationVersion: user.authorizationVersion,
        credentialVersion: user.credentialVersion ?? 1,
      });
      await writeAudit(prisma, {
        companyId: user.companyId,
        userId: user.id,
        action: 'auth.login.success',
        details: { flow: 'legacy' },
      });

      return res.json({
        token: accessToken,
        refreshToken,
        user: shapeAuthenticatedUser(user, permissions),
      });
    } catch (error) {
      if (error instanceof IdentityInputError) {
        await verifyResolvedLogin(null, bodyPassword(req.body));
        return genericLoginFailure(res, 400);
      }
      if (error instanceof MfaConfigurationError) {
        return res.status(503).json({
          code: 'MfaUnavailable',
          messageKey: 'auth.mfa_unavailable',
        });
      }
      if (error instanceof MfaRateLimitError) {
        return res.status(429).json({
          code: 'MfaRateLimited',
          messageKey: 'auth.mfa_rate_limited',
        });
      }
      return res.status(500).json({ error: 'Login failed' });
    }
  });

  app.post('/api/auth/refresh', authLimiter, async (req, res) => {
    try {
      if (!JWT_SECRET)
        return res.status(500).json({ error: 'System configuration error: JWT_SECRET missing' });
      const body = validateBody(refreshSchema, req, res);
      if (!body) return;

      const tokenHash = hashToken(body.refreshToken);
      const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
      if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
        return res.status(401).json({ error: 'Invalid refresh token' });
      }

      const user = await prisma.user.findUnique({
        where: { id: stored.userId },
        include: authUserInclude,
      });
      if (!user || user.companyId !== stored.companyId || !isLoginEligible(user)) {
        await prisma.refreshToken.updateMany({
          where: { id: stored.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return res.status(401).json({ error: 'Invalid refresh token' });
      }
      if (
        Number.isInteger(stored.credentialVersion)
        && stored.credentialVersion !== (user.credentialVersion ?? 1)
      ) {
        await prisma.refreshToken.updateMany({
          where: { id: stored.id, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'credential_version_mismatch' },
        });
        return res.status(401).json({ error: 'Invalid refresh token' });
      }
      if (isCredentialGateLoginBlocked({
        mustChangePassword: Boolean(user.mustChangePassword),
        temporaryPasswordExpiresAt: user.temporaryPasswordExpiresAt
          ? new Date(user.temporaryPasswordExpiresAt)
          : null,
        accountStatus: user.accountStatus ?? 'active',
        credentialVersion: user.credentialVersion ?? 1,
        passwordChangedAt: user.passwordChangedAt
          ? new Date(user.passwordChangedAt)
          : null,
      })) {
        await prisma.refreshToken.updateMany({
          where: { id: stored.id, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'temporary_password_expired' },
        });
        return res.status(401).json({ error: 'Invalid refresh token' });
      }
      if (
        !user.mustChangePassword &&
        await hasExplicitPrimaryOwnership(prisma, stored.companyId, user.id)
      ) {
        const mfa = await prisma.userMfaCredential.findUnique({
          where: { userId: user.id },
        });
        if (
          mfa?.state !== 'enrolled' ||
          !mfa.enrolledAt ||
          stored.createdAt < mfa.enrolledAt
        ) {
          await prisma.refreshToken.updateMany({
            where: { id: stored.id, revokedAt: null },
            data: { revokedAt: new Date(), revokedReason: 'mfa_required' },
          });
          return res.status(401).json({ error: 'Invalid refresh token' });
        }
      }

      // Only one concurrent request may consume a refresh token.
      const consumed = await prisma.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date() },
      });
      if (consumed.count !== 1) {
        return res.status(401).json({ error: 'Invalid refresh token' });
      }

      // Must match MFA login: Primary Owner roles ship with permissions "[]" and
      // receive power via ownership / grants. Role-only refresh emptied JWT claims
      // and Android TokenAuthenticator then wiped live session permissions (QA Issue 10).
      const authorizationContext = await loadAuthorizationContext(prisma, {
        userId: user.id,
        companyId: stored.companyId,
      });
      const permissions = authorizationContext?.flatPermissions
        ?? parseRolePermissions(user.role.permissions);
      const { accessToken, refreshToken } = await issueTokens({
        id: user.id,
        companyId: stored.companyId,
        employeeId: user.employeeId,
        permissions,
        authorizationVersion: user.authorizationVersion,
        credentialVersion: user.credentialVersion ?? 1,
      }, {
        deviceLabel: stored.deviceLabel ?? undefined,
        platform: stored.platform ?? undefined,
      });

      await writeAudit(prisma, {
        companyId: stored.companyId,
        userId: user.id,
        action: 'auth.token.refresh',
      });

      res.json({
        token: accessToken,
        refreshToken,
        mustChangePassword: Boolean(user.mustChangePassword),
      });
    } catch (err) {
      res.status(500).json({ error: 'Refresh failed' });
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    try {
      const body = validateBody(logoutSchema, req, res);
      if (!body) return;
      if (body.refreshToken) {
        const tokenHash = hashToken(body.refreshToken);
        const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
        if (stored && !stored.revokedAt) {
          await prisma.refreshToken.update({
            where: { id: stored.id },
            data: { revokedAt: new Date() },
          });
          await writeAudit(prisma, {
            companyId: stored.companyId,
            userId: stored.userId,
            action: 'auth.logout',
          });
        }
      }
      // Always succeed: the client clears its local session regardless.
      res.json({ message: 'Logged out' });
    } catch (err) {
      res.status(500).json({ error: 'Logout failed' });
    }
  });

  app.get('/api/auth/me', requireAuth, async (req: AuthRequest, res) => {
    try {
      const user = await prisma.user.findFirst({
        where: { id: req.user!.id, companyId: req.user!.companyId },
        include: { role: true, company: true },
      });
      if (!user) return res.status(404).json({ error: 'User not found' });
      const gate = await loadUserCredentialGate(prisma, user.id, user.companyId);
      const mfaRequired = await hasExplicitPrimaryOwnership(prisma, user.companyId, user.id);
      const mfa = mfaRequired
        ? await prisma.userMfaCredential.findUnique({ where: { userId: user.id } })
        : null;
      res.json({
        id: user.id,
        name: user.name,
        email: user.email,
        companyId: user.companyId,
        employeeId: user.employeeId,
        roleId: user.role.id,
        roleName: user.role.name,
        permissions: parseRolePermissions(user.role.permissions),
        company: { id: user.company.id, code: user.company.code, name: user.company.name },
        ...(gate ? shapeMeCredentialFields(gate) : {}),
        mfaRequired,
        mfaEnrolled: mfa?.state === 'enrolled',
      });
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/company/current', requireAuth, async (req: AuthRequest, res) => {
    try {
      const company = await prisma.company.findUnique({
        where: { id: req.user!.companyId },
        select: { id: true, code: true, name: true },
      });
      if (!company) return res.status(404).json({ error: 'Not found' });
      return res.json(company);
    } catch {
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // --------------- ROUTES: EMPLOYEES & ROLES ---------------
  const employeeSafeInclude = {
    user: {
      select: {
        id: true,
        name: true,
        email: true,
        roleId: true,
        credentialVersion: true,
        accountStatus: true,
        mustChangePassword: true,
        role: { select: { id: true, name: true, permissions: true } },
      },
    },
    department: { select: { id: true, name: true } },
  } as const;

  const shapeEmployee = (employee: any) => ({
    id: employee.id,
    companyId: employee.companyId,
    employeeNum: employee.employeeNum,
    jobTitle: employee.jobTitle,
    joiningDate: employee.joiningDate,
    status: employee.status,
    departmentId: employee.departmentId ?? null,
    createdAt: employee.createdAt,
    updatedAt: employee.updatedAt,
    archivedAt: employee.archivedAt ?? null,
    user: employee.user
      ? {
          id: employee.user.id,
          name: employee.user.name,
          email: employee.user.email,
          roleId: employee.user.roleId ?? employee.user.role?.id ?? null,
          roleName: employee.user.role?.name ?? null,
          credentialVersion: employee.user.credentialVersion ?? 1,
          accountStatus: employee.user.accountStatus ?? 'active',
          mustChangePassword: Boolean(employee.user.mustChangePassword),
        }
      : null,
    department: employee.department
      ? { id: employee.department.id, name: employee.department.name }
      : null,
  });

  app.get('/api/roles', requireAuth, async (req: AuthRequest, res) => {
    try {
      const roles = await prisma.role.findMany({
        where: { companyId: req.user!.companyId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      res.json(roles.map((role) => ({ id: role.id, name: role.name })));
    } catch (err) {
      res.status(500).json({ error: 'Error fetching roles' });
    }
  });

  app.get(
    '/api/employees',
    requireAuth,
    checkAnyPermission(PERMISSIONS.EMPLOYEES_VIEW, PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT),
    async (req: AuthRequest, res) => {
      try {
        const companyWide = hasPermission(req.user!.permissions, PERMISSIONS.EMPLOYEES_VIEW);
        let filters: Record<string, unknown> = { companyId: req.user!.companyId };
        if (!companyWide) {
          const managedDepartmentIds = await loadManagedDepartmentIds(prisma, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
          });
          filters = {
            companyId: req.user!.companyId,
            departmentId: { in: managedDepartmentIds },
          };
        }
        const employees = await prisma.employee.findMany({
          where: filters,
          // Explicit select: never leak user.password (bcrypt hash), and expose
          // roleName as a string (the client's UserDto expects a string, not the
          // full role relation object). role.permissions is read only to detect
          // the owner/admin record for the privacy rule below, then dropped.
          include: employeeSafeInclude,
        });
        // Owner/admin personal data is sensitive: only HR (hr.view) or the owner
        // (admin.full) may see the admin.full employee record in operational lists.
        const explicitOwnerUserId = await primaryOwnerUserId(req.user!.companyId);
        const requesterPrivileged = isOwnerDataViewer(req.user!.permissions) ||
          explicitOwnerUserId === req.user!.id;
        const visible = employees.filter(
          (e: any) => requesterPrivileged ||
            (e.user?.id !== explicitOwnerUserId && !isOwnerUser(e.user))
        );
        const shaped = visible.map(shapeEmployee);
        res.json(shaped);
      } catch (err) {
        res.status(500).json({ error: 'Error fetching employees' });
      }
    }
  );

  app.post(
    '/api/employees',
    requireAuth,
    // employees.create matches the seeded HR Manager role (was employees.manage,
    // which no seeded role held — HR could never create employees).
    checkPermission(PERMISSIONS.EMPLOYEES_CREATE),
    async (req: AuthRequest, res) => {
      try {
        const body = validateBody(createEmployeeSchema, req, res);
        if (!body) return;
        const { email, password, name, roleId, employeeNum, jobTitle, joiningDate, departmentId } =
          body;
        const normalizedEmail = normalizeEmail(email);
        const normalizedEmployeeNum = normalizeEmployeeNumber(employeeNum);
        const { emailIdentifier, employeeNumberIdentifier } = loginIdentityValues(email, employeeNum);

        const identityCollision = await prisma.loginIdentity.findFirst({
          where: {
            companyId: req.user!.companyId,
            normalizedIdentifier: { in: [emailIdentifier, employeeNumberIdentifier] },
          },
          select: { id: true },
        });
        if (identityCollision) {
          return res.status(409).json({
            error: 'LoginIdentityAlreadyExists',
            message: 'البريد الإلكتروني أو الرقم الوظيفي مستخدم مسبقاً',
            code: 409,
          });
        }

        const role = await prisma.role.findFirst({
          where: { id: roleId, companyId: req.user!.companyId },
        });
        if (!role) return res.status(400).json({ error: 'الدور الوظيفي غير صالح' });

        if (role && parseRolePermissions(role.permissions).includes(PERMISSIONS.ADMIN_FULL)) {
          return res.status(403).json({
            error: 'EmployeeRoleForbidden',
            message: 'لا يمكن تعيين صلاحية المدير العام من شاشة الموظفين',
          });
        }

        if (departmentId) {
          const dept = await prisma.department.findFirst({
            where: { id: departmentId, companyId: req.user!.companyId },
          });
          if (!dept) return res.status(400).json({ error: 'القسم غير صالح' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const createdEmployeeId = await prisma.$transaction(async (tx) => {
          const emp = await tx.employee.create({
            data: {
              companyId: req.user!.companyId,
              employeeNum,
              normalizedEmployeeNum,
              jobTitle,
              joiningDate: new Date(joiningDate),
              departmentId: departmentId || null,
            },
          });

          const user = await tx.user.create({
            data: {
              companyId: req.user!.companyId,
              email,
              normalizedEmail,
              password: hashedPassword,
              name,
              roleId,
              employeeId: emp.id,
            },
          });
          await syncLoginIdentities(tx, {
            companyId: req.user!.companyId,
            userId: user.id,
            email,
            employeeNumber: employeeNum,
          });
          return emp.id;
        });

        await writeAudit(prisma, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'employee.create',
          details: { employeeId: createdEmployeeId, roleId },
        });

        res.json({ message: 'Employee created successfully' });
      } catch (err) {
        if (err instanceof IdentityCollisionError || isPrismaUniqueConflict(err)) {
          return res.status(409).json({
            error: 'EmployeeConflict',
            message: 'البريد الإلكتروني أو الرقم الوظيفي مستخدم مسبقاً',
            code: 409,
          });
        }
        if (err instanceof IdentityInputError) {
          return res.status(400).json({ error: 'بيانات الدخول للموظف غير صالحة' });
        }
        res.status(500).json({ error: 'Failed to create employee' });
      }
    }
  );

  app.put(
    '/api/employees/:id',
    requireAuth,
    checkPermission(PERMISSIONS.EMPLOYEES_UPDATE),
    async (req: AuthRequest, res) => {
      try {
        const body = validateBody(updateEmployeeSchema, req, res);
        if (!body) return;

        const employee = await prisma.employee.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
          include: employeeSafeInclude,
        });
        if (!employee) {
          return res.status(404).json({
            error: 'EmployeeNotFound',
            message: 'الموظف غير موجود',
            code: 404,
          });
        }
        if (!employee.user) {
          return res.status(400).json({
            error: 'EmployeeUserMissing',
            message: 'لا يوجد حساب مستخدم مرتبط بهذا الموظف',
            code: 400,
          });
        }

        const targetIsOwner = await isProtectedPrincipalUser(employee.user, req.user!.companyId);
        if (
          targetIsOwner &&
          employee.user.id !== req.user!.id &&
          !hasPermission(req.user!.permissions, PERMISSIONS.HR_VIEW)
        ) {
          return res.status(404).json({
            error: 'EmployeeNotFound',
            message: 'الموظف غير موجود',
            code: 404,
          });
        }

        const normalizedEmail = normalizeEmail(body.email);
        const normalizedEmployeeNum = normalizeEmployeeNumber(body.employeeNum);
        const { emailIdentifier, employeeNumberIdentifier } = loginIdentityValues(
          body.email,
          body.employeeNum,
        );
        const identityCollision = await prisma.loginIdentity.findFirst({
          where: {
            companyId: req.user!.companyId,
            normalizedIdentifier: { in: [emailIdentifier, employeeNumberIdentifier] },
            userId: { not: employee.user.id },
          },
          select: { id: true },
        });
        if (identityCollision) {
          return res.status(409).json({
            error: 'LoginIdentityAlreadyExists',
            message: 'البريد الإلكتروني أو الرقم الوظيفي مستخدم مسبقاً',
            code: 409,
          });
        }

        let selectedRole = employee.user.role;
        const roleChanged = body.roleId !== employee.user.roleId;
        if (roleChanged) {
          const role = await prisma.role.findFirst({
            where: { id: body.roleId, companyId: req.user!.companyId },
          });
          if (!role) {
            return res.status(400).json({
              error: 'InvalidRole',
              message: 'الدور الوظيفي غير صالح لهذه الشركة',
              code: 400,
            });
          }
          selectedRole = role;

          if (roleChanged && employee.id === req.user!.employeeId) {
            return res.status(403).json({
              error: 'SelfRoleChangeBlocked',
              message: 'لا يمكنك تغيير دور حسابك بنفسك',
              code: 403,
            });
          }
          if (roleChanged && targetIsOwner) {
            return res.status(403).json({
              error: 'OwnerRoleChangeBlocked',
              message: 'لا يمكن تغيير دور المدير العام',
              code: 403,
            });
          }
          if (roleChanged && parseRolePermissions(role.permissions).includes(PERMISSIONS.ADMIN_FULL)) {
            return res.status(403).json({
              error: 'OwnerRoleAssignmentBlocked',
              message: 'لا يمكن تعيين صلاحية المدير العام من شاشة الموظفين',
              code: 403,
            });
          }
          const actor = await assertCompanyPrincipalMutation(
            prisma,
            req.user!,
            employee.user.id,
          );
          const grantable = new Set(grantableCapabilities(actor, { scopeType: 'company' }));
          if (parseRolePermissions(role.permissions).some((permission) => !grantable.has(permission))) {
            return res.status(403).json({
              error: 'RoleCapabilityNotGrantable',
              message: 'لا يمكنك منح دور يحتوي على صلاحيات لا تملك حق منحها',
              code: 403,
            });
          }
        }

        let selectedDepartment = employee.department;
        const departmentChanged = body.departmentId !== employee.departmentId;
        if (departmentChanged && body.departmentId !== null) {
          const department = await prisma.department.findFirst({
            where: { id: body.departmentId, companyId: req.user!.companyId },
          });
          if (!department) {
            return res.status(400).json({
              error: 'InvalidDepartment',
              message: 'القسم غير صالح لهذه الشركة',
              code: 400,
            });
          }
          selectedDepartment = department;
        } else if (body.departmentId !== employee.departmentId) {
          selectedDepartment = null;
        }

        const employeeData: Record<string, unknown> = {};
        const userData: Record<string, unknown> = {};
        const changedFields: string[] = [];
        const currentJoiningDate = new Date(employee.joiningDate).toISOString().slice(0, 10);

        if (body.name !== undefined && body.name !== employee.user.name) {
          userData.name = body.name;
          changedFields.push('name');
        }
        if (body.email !== undefined && body.email !== employee.user.email) {
          userData.email = body.email;
          userData.normalizedEmail = normalizedEmail;
          changedFields.push('email');
        }
        if (roleChanged) {
          userData.roleId = body.roleId;
          changedFields.push('roleId');
        }
        if (body.employeeNum !== undefined && body.employeeNum !== employee.employeeNum) {
          employeeData.employeeNum = body.employeeNum;
          employeeData.normalizedEmployeeNum = normalizedEmployeeNum;
          changedFields.push('employeeNum');
        }
        if (body.jobTitle !== undefined && body.jobTitle !== employee.jobTitle) {
          employeeData.jobTitle = body.jobTitle;
          changedFields.push('jobTitle');
        }
        if (body.joiningDate !== undefined && body.joiningDate !== currentJoiningDate) {
          employeeData.joiningDate = new Date(`${body.joiningDate}T00:00:00.000Z`);
          changedFields.push('joiningDate');
        }
        if (departmentChanged) {
          employeeData.departmentId = body.departmentId;
          changedFields.push('departmentId');
        }

        let updatedEmployee: any = employee;
        let updatedUser: any = employee.user;
        if (changedFields.length > 0) {
          const updated = await prisma.$transaction(async (tx) => {
            if (roleChanged) {
              const freshActor = await assertCompanyPrincipalMutation(
                tx,
                req.user!,
                employee.user!.id,
              );
              const freshGrantable = new Set(grantableCapabilities(
                freshActor,
                { scopeType: 'company' },
              ));
              if (parseRolePermissions(selectedRole.permissions).some(
                (permission) => !freshGrantable.has(permission),
              )) {
                throw new AuthorizationMutationDenied();
              }
            }
            const nextEmployee = Object.keys(employeeData).length > 0
              ? await tx.employee.update({ where: { id: employee.id }, data: employeeData })
              : employee;
            const nextUser = Object.keys(userData).length > 0
              ? await tx.user.update({ where: { id: employee.user!.id }, data: userData })
              : employee.user;
            await syncLoginIdentities(tx, {
              companyId: req.user!.companyId,
              userId: employee.user!.id,
              email: body.email,
              employeeNumber: body.employeeNum,
            });
            await writeAudit(tx as PrismaClient, {
              companyId: req.user!.companyId,
              userId: req.user!.id,
              action: 'employee.update',
              details: { employeeId: employee.id, changedFields },
            });
            return { employee: nextEmployee, user: nextUser };
          });
          updatedEmployee = updated.employee;
          updatedUser = updated.user;
        }

        res.json(shapeEmployee({
          ...employee,
          ...updatedEmployee,
          departmentId: body.departmentId,
          department: selectedDepartment,
          user: {
            ...employee.user,
            ...updatedUser,
            roleId: body.roleId ?? employee.user.roleId,
            role: selectedRole,
          },
        }));
      } catch (err) {
        if (err instanceof AuthorizationMutationDenied) {
          return res.status(403).json({
            error: 'RoleCapabilityNotGrantable',
            message: 'لا يمكنك إدارة دور هذا المستخدم أو منح الصلاحيات المطلوبة',
            code: 403,
          });
        }
        if (err instanceof IdentityCollisionError || isPrismaUniqueConflict(err)) {
          return res.status(409).json({
            error: 'EmployeeConflict',
            message: 'البريد الإلكتروني أو الرقم الوظيفي مستخدم مسبقاً',
            code: 409,
          });
        }
        if (err instanceof IdentityInputError) {
          return res.status(400).json({ error: 'بيانات الدخول للموظف غير صالحة' });
        }
        res.status(500).json({ error: 'Failed to update employee' });
      }
    }
  );

  // Soft-deactivate an employee (sets status = 'inactive'). Uses the existing
  // Employee.status column, so NO migration is needed. This is destructive-ish,
  // so it requires employees.manage (admin.full bypasses). We never hard-delete,
  // never touch the owner (admin.full) record, and never let a user deactivate
  // themselves.
  app.post(
    '/api/employees/:id/deactivate',
    requireAuth,
    checkPermission(PERMISSIONS.EMPLOYEES_MANAGE),
    async (req: AuthRequest, res) => {
      try {
        const employee = await prisma.employee.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
          include: { user: { include: { role: true } } },
        });
        if (!employee) return res.status(404).json({ error: 'الموظف غير موجود' });

        if (employee.id === req.user!.employeeId) {
          return res.status(400).json({ error: 'لا يمكنك إيقاف حسابك الخاص' });
        }
        if (await isProtectedPrincipalUser(employee.user, req.user!.companyId)) {
          return res.status(403).json({ error: 'لا يمكن إيقاف حساب المدير العام' });
        }
        if (employee.status === 'inactive') {
          return res.status(400).json({ error: 'الموظف موقوف مسبقاً' });
        }

        const updated = await prisma.$transaction(async (tx) => {
          const nextEmployee = await tx.employee.update({
            where: { id: employee.id },
            data: { status: 'inactive' },
          });
          await tx.refreshToken.updateMany({
            where: { userId: employee.user!.id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          await writeAudit(tx as PrismaClient, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'employee.deactivate',
            details: { employeeId: employee.id },
          });
          return nextEmployee;
        });

        res.json({ id: updated.id, status: updated.status, message: 'Employee deactivated' });
      } catch (err) {
        res.status(500).json({ error: 'Failed to deactivate employee' });
      }
    }
  );

  app.post(
    '/api/employees/:id/reactivate',
    requireAuth,
    checkPermission(PERMISSIONS.EMPLOYEES_MANAGE),
    async (req: AuthRequest, res) => {
      try {
        const employee = await prisma.employee.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
          include: { user: { include: { role: true } } },
        });
        if (!employee) return res.status(404).json({ error: 'الموظف غير موجود' });
        if (!employee.user) {
          return res.status(400).json({ error: 'لا يوجد حساب مستخدم مرتبط بهذا الموظف' });
        }
        if (await isProtectedPrincipalUser(employee.user, req.user!.companyId)) {
          return res.status(403).json({ error: 'لا يمكن تعديل حالة حساب المدير العام من هنا' });
        }
        if (employee.status === 'active') {
          return res.status(409).json({ error: 'الموظف نشط مسبقاً' });
        }

        const updated = await prisma.$transaction(async (tx) => {
          await syncLoginIdentities(tx, {
            companyId: req.user!.companyId,
            userId: employee.user!.id,
            email: employee.user!.email,
            employeeNumber: employee.employeeNum,
          });
          const nextEmployee = await tx.employee.update({
            where: { id: employee.id },
            data: { status: 'active' },
          });
          await writeAudit(tx as PrismaClient, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'employee.reactivate',
            details: { employeeId: employee.id },
          });
          return nextEmployee;
        });

        return res.json({ id: updated.id, status: updated.status, message: 'Employee reactivated' });
      } catch (error) {
        if (error instanceof IdentityCollisionError || isPrismaUniqueConflict(error)) {
          return res.status(409).json({
            error: 'EmployeeConflict',
            message: 'تعذر إعادة التفعيل بسبب تعارض في بيانات الدخول',
            code: 409,
          });
        }
        return res.status(500).json({ error: 'Failed to reactivate employee' });
      }
    },
  );

  // --------------- ROUTES: EFFECTIVE-DATED SALARY RECORDS ---------------
  app.get('/api/employees/:id/salary', requireAuth, async (req: AuthRequest, res) => {
    try {
      const employee = await prisma.employee.findFirst({
        where: { id: req.params.id, companyId: req.user!.companyId },
        include: salaryTargetInclude,
      });
      if (!employee) return salaryTargetNotFound(res);

      const targetIsOwner = await isProtectedPrincipalUser(employee.user, req.user!.companyId);
      if (salaryAccessDenied(res, req.user!.permissions, targetIsOwner, false)) return;

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const currentSalary = await prisma.salaryRecord.findFirst({
        where: currentSalaryWhere(req.user!.companyId, employee.id, today),
        orderBy: { effectiveFrom: 'desc' },
      });

      await writeAuditRequired(prisma, {
        companyId: req.user!.companyId,
        userId: req.user!.id,
        action: 'salary.read',
        details: { employeeId: employee.id, salaryRecordId: currentSalary?.id ?? null },
      });
      return res.json({
        employee: salaryEmployeeShape(employee),
        currentSalary: currentSalary ? salaryRecordShape(currentSalary) : null,
      });
    } catch {
      return res.status(500).json({
        error: 'SalaryReadFailed',
        message: 'تعذّر تحميل بيانات الراتب',
        code: 500,
      });
    }
  });

  app.get('/api/employees/:id/salary/history', requireAuth, async (req: AuthRequest, res) => {
    try {
      const employee = await prisma.employee.findFirst({
        where: { id: req.params.id, companyId: req.user!.companyId },
        include: salaryTargetInclude,
      });
      if (!employee) return salaryTargetNotFound(res);

      const targetIsOwner = await isProtectedPrincipalUser(employee.user, req.user!.companyId);
      if (salaryAccessDenied(res, req.user!.permissions, targetIsOwner, false)) return;

      const history = await prisma.salaryRecord.findMany({
        where: { companyId: req.user!.companyId, employeeId: employee.id },
        orderBy: { effectiveFrom: 'desc' },
      });
      await writeAuditRequired(prisma, {
        companyId: req.user!.companyId,
        userId: req.user!.id,
        action: 'salary.history.read',
        details: { employeeId: employee.id },
      });
      return res.json({
        employee: salaryEmployeeShape(employee),
        history: history.map(salaryRecordShape),
      });
    } catch {
      return res.status(500).json({
        error: 'SalaryHistoryReadFailed',
        message: 'تعذّر تحميل سجل الرواتب',
        code: 500,
      });
    }
  });

  app.post('/api/employees/:id/salary', requireAuth, async (req: AuthRequest, res) => {
    const body = validateBody(createSalaryRecordSchema, req, res);
    if (!body) return;

    const employee = await prisma.employee.findFirst({
      where: { id: req.params.id, companyId: req.user!.companyId },
      include: salaryTargetInclude,
    });
    if (!employee) return salaryTargetNotFound(res);

    const targetIsOwner = await isProtectedPrincipalUser(employee.user, req.user!.companyId);
    if (salaryAccessDenied(res, req.user!.permissions, targetIsOwner, true)) return;
    if (employee.status.toLowerCase() !== 'active') {
      return res.status(409).json({
        error: 'InactiveEmployee',
        message: 'لا يمكن إضافة راتب لموظف غير نشط',
        code: 409,
      });
    }

    const effectiveFrom = new Date(`${body.effectiveFrom}T00:00:00.000Z`);
    const joiningDate = new Date(employee.joiningDate);
    joiningDate.setUTCHours(0, 0, 0, 0);
    if (effectiveFrom.getTime() < joiningDate.getTime()) {
      return res.status(400).json({
        error: 'SalaryBeforeJoiningDate',
        message: 'تاريخ سريان الراتب لا يمكن أن يسبق تاريخ التحاق الموظف',
        code: 400,
      });
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Employee"
          WHERE "id" = ${employee.id} AND "companyId" = ${req.user!.companyId}
          FOR UPDATE
        `;

        const latest = await tx.salaryRecord.findFirst({
          where: { companyId: req.user!.companyId, employeeId: employee.id },
          orderBy: { effectiveFrom: 'desc' },
        });
        if (latest && effectiveFrom.getTime() <= latest.effectiveFrom.getTime()) {
          throw new SalaryRequestError(
            409,
            'SalaryEffectiveDateConflict',
            'تاريخ سريان الراتب يجب أن يكون بعد آخر سجل راتب'
          );
        }

        if (latest?.effectiveTo == null && latest) {
          const previousEnd = new Date(effectiveFrom.getTime() - 86_400_000);
          await tx.salaryRecord.update({
            where: { id: latest.id },
            data: { effectiveTo: previousEnd },
          });
        }

        const createdSalary = await tx.salaryRecord.create({
          data: {
            companyId: req.user!.companyId,
            employeeId: employee.id,
            baseSalary: body.baseSalary,
            currency: 'SAR',
            effectiveFrom,
            createdByUserId: req.user!.id,
          },
        });
        await writeAuditRequired(tx, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'salary.record.create',
          details: {
            employeeId: employee.id,
            salaryRecordId: createdSalary.id,
            effectiveFrom: body.effectiveFrom,
          },
        });

        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const currentSalary = await tx.salaryRecord.findFirst({
          where: currentSalaryWhere(req.user!.companyId, employee.id, today),
          orderBy: { effectiveFrom: 'desc' },
        });
        return { createdSalary, currentSalary };
      });

      return res.status(201).json({
        employee: salaryEmployeeShape(employee),
        createdSalary: salaryRecordShape(result.createdSalary),
        currentSalary: result.currentSalary ? salaryRecordShape(result.currentSalary) : null,
      });
    } catch (error) {
      if (error instanceof SalaryRequestError) {
        return res.status(error.status).json({
          error: error.errorCode,
          message: error.message,
          code: error.status,
        });
      }
      if ((error as { code?: string }).code === 'P2002') {
        return res.status(409).json({
          error: 'SalaryEffectiveDateConflict',
          message: 'يوجد سجل راتب بهذا التاريخ مسبقاً',
          code: 409,
        });
      }
      return res.status(500).json({
        error: 'SalaryCreateFailed',
        message: 'تعذّر حفظ سجل الراتب',
        code: 500,
      });
    }
  });

  // --------------- ROUTES: DEPARTMENTS ---------------
  const shapeDepartment = (department: any) => ({
    id: department.id,
    name: department.name,
    managerId: department.managerId ?? null,
    managerName: department.manager?.name ?? null,
    activeEmployeeCount: department._count?.employees ?? 0,
  });

  const findDepartmentManager = async (managerId: string, companyId: string) => {
    const manager = await prisma.user.findFirst({
      where: { id: managerId, companyId },
      include: {
        role: true,
        employee: { select: { id: true, departmentId: true, status: true } },
      },
    });
    if (manager?.companyId !== companyId) return null;
    if (!manager?.employee || manager.employee.status !== 'active') return null;
    if (!isDepartmentManagerRole(manager.role)) return null;
    return manager;
  };

  app.get(
    '/api/departments',
    requireAuth,
    checkAnyPermission(
      PERMISSIONS.HR_MANAGE,
      PERMISSIONS.EMPLOYEES_VIEW,
      PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT,
      PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT
    ),
    async (req: AuthRequest, res) => {
      try {
        const permissions = req.user!.permissions;
        const companyWide =
          hasPermission(permissions, PERMISSIONS.HR_MANAGE) ||
          hasPermission(permissions, PERMISSIONS.EMPLOYEES_VIEW);
        const where: Record<string, unknown> = { companyId: req.user!.companyId };
        if (!companyWide) {
          where.id = {
            in: await loadManagedDepartmentIds(prisma, {
              companyId: req.user!.companyId,
              userId: req.user!.id,
            }),
          };
        }

        const departments = await prisma.department.findMany({
          where,
          orderBy: { name: 'asc' },
          include: {
            manager: { select: { id: true, name: true } },
            _count: {
              select: { employees: { where: { status: 'active' } } },
            },
          },
        });
        res.json(departments.map(shapeDepartment));
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch departments' });
      }
    }
  );

  app.get(
    '/api/departments/manager-candidates',
    requireAuth,
    checkPermission(PERMISSIONS.HR_MANAGE),
    async (req: AuthRequest, res) => {
      try {
        const users = await prisma.user.findMany({
          where: {
            companyId: req.user!.companyId,
            employee: { is: { status: 'active' } },
          },
          include: {
            role: true,
            employee: { select: { id: true, departmentId: true, status: true } },
          },
          orderBy: { name: 'asc' },
        });
        const candidates = users
          .filter((user: any) => user.employee && isDepartmentManagerRole(user.role))
          .map((user: any) => ({
            userId: user.id,
            employeeId: user.employee.id,
            name: user.name,
            roleName: user.role.name,
            departmentId: user.employee.departmentId ?? null,
          }));
        res.json(candidates);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch manager candidates' });
      }
    }
  );

  app.post(
    '/api/departments',
    requireAuth,
    checkPermission(PERMISSIONS.HR_MANAGE),
    async (req: AuthRequest, res) => {
      try {
        const body = validateBody(createDepartmentSchema, req, res);
        if (!body) return;

        const duplicate = await prisma.department.findFirst({
          where: {
            companyId: req.user!.companyId,
            name: { equals: body.name, mode: 'insensitive' },
          },
        });
        if (duplicate) {
          return res.status(409).json({
            error: 'DepartmentAlreadyExists',
            message: 'يوجد قسم بهذا الاسم مسبقاً',
            code: 409,
          });
        }

        const manager = body.managerId
          ? await findDepartmentManager(body.managerId, req.user!.companyId)
          : null;
        if (body.managerId && !manager) {
          return res.status(400).json({
            error: 'InvalidDepartmentManager',
            message: 'مدير القسم غير صالح أو لا ينتمي إلى الشركة',
            code: 400,
          });
        }
        if (body.managerId) {
          await assertCompanyPrincipalMutation(prisma, req.user!, body.managerId);
        }

        const department = await prisma.$transaction(async (tx) => {
          if (body.managerId) {
            await assertCompanyPrincipalMutation(tx, req.user!, body.managerId);
          }
          const created = await tx.department.create({
            data: {
              companyId: req.user!.companyId,
              name: body.name,
              managerId: body.managerId ?? null,
            },
          });
          if (body.managerId) {
            await tx.departmentManager.create({
              data: {
                companyId: req.user!.companyId,
                departmentId: created.id,
                userId: body.managerId,
                assignedByUserId: req.user!.id,
              },
            });
            await tx.user.update({
              where: { id: body.managerId },
              data: { authorizationVersion: { increment: 1 } },
            });
          }
          await writeAuditRequired(tx as unknown as PrismaClient, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'department.create',
            details: {
              departmentId: created.id,
              changedFields: body.managerId ? ['name', 'managerId'] : ['name'],
            },
          });
          return created;
        });
        res.status(201).json(shapeDepartment({
          ...department,
          manager: manager ? { id: manager.id, name: manager.name } : null,
          _count: { employees: 0 },
        }));
      } catch (err) {
        if (err instanceof AuthorizationMutationDenied) {
          return res.status(403).json({
            error: 'DepartmentManagerAuthorityRequired',
            message: 'لا تملك صلاحية تعيين مدير قسم',
            code: 403,
          });
        }
        if ((err as { code?: string }).code === 'P2002') {
          return res.status(409).json({
            error: 'DepartmentAlreadyExists',
            message: 'يوجد قسم بهذا الاسم مسبقاً',
            code: 409,
          });
        }
        res.status(500).json({ error: 'Failed to create department' });
      }
    }
  );

  app.put(
    '/api/departments/:id',
    requireAuth,
    checkPermission(PERMISSIONS.HR_MANAGE),
    async (req: AuthRequest, res) => {
      try {
        const body = validateBody(updateDepartmentSchema, req, res);
        if (!body) return;

        const department = await prisma.department.findFirst({
          where: { id: req.params.id, companyId: req.user!.companyId },
          include: {
            manager: { select: { id: true, name: true } },
            _count: {
              select: { employees: { where: { status: 'active' } } },
            },
          },
        });
        if (!department) {
          return res.status(404).json({
            error: 'DepartmentNotFound',
            message: 'القسم غير موجود',
            code: 404,
          });
        }

        if (body.name !== undefined && body.name.toLocaleLowerCase() !== department.name.toLocaleLowerCase()) {
          const duplicate = await prisma.department.findFirst({
            where: {
              companyId: req.user!.companyId,
              name: { equals: body.name, mode: 'insensitive' },
              id: { not: department.id },
            },
          });
          if (duplicate) {
            return res.status(409).json({
              error: 'DepartmentAlreadyExists',
              message: 'يوجد قسم بهذا الاسم مسبقاً',
              code: 409,
            });
          }
        }

        const managerProvided = Object.prototype.hasOwnProperty.call(body, 'managerId');
        const manager = managerProvided && body.managerId
          ? await findDepartmentManager(body.managerId, req.user!.companyId)
          : null;
        if (managerProvided && body.managerId && !manager) {
          return res.status(400).json({
            error: 'InvalidDepartmentManager',
            message: 'مدير القسم غير صالح أو لا ينتمي إلى الشركة',
            code: 400,
          });
        }

        const data: Record<string, unknown> = {};
        const changedFields: string[] = [];
        if (body.name !== undefined && body.name !== department.name) {
          data.name = body.name;
          changedFields.push('name');
        }
        if (managerProvided && body.managerId !== department.managerId) {
          data.managerId = body.managerId;
          changedFields.push('managerId');
        }

        if (changedFields.length === 0) return res.json(shapeDepartment(department));

        if (managerProvided && body.managerId !== department.managerId) {
          if (department.managerId) {
            await assertCompanyPrincipalMutation(prisma, req.user!, department.managerId);
          }
          if (body.managerId) {
            await assertCompanyPrincipalMutation(prisma, req.user!, body.managerId);
          }
        }

        const updated = await prisma.$transaction(async (tx) => {
          if (managerProvided && body.managerId !== department.managerId) {
            if (department.managerId) {
              await assertCompanyPrincipalMutation(tx, req.user!, department.managerId);
            }
            if (body.managerId) {
              await assertCompanyPrincipalMutation(tx, req.user!, body.managerId);
            }
          }
          const next = await tx.department.update({
            where: { id: department.id },
            data,
            include: {
              manager: { select: { id: true, name: true } },
              _count: {
                select: { employees: { where: { status: 'active' } } },
              },
            },
          });
          if (managerProvided && body.managerId !== department.managerId) {
            const changedManagerIds = new Set<string>();
            if (department.managerId) {
              await tx.departmentManager.updateMany({
                where: {
                  companyId: req.user!.companyId,
                  departmentId: department.id,
                  userId: department.managerId,
                  status: 'active',
                },
                data: {
                  status: 'ended',
                  endedAt: new Date(),
                  endedByUserId: req.user!.id,
                },
              });
              changedManagerIds.add(department.managerId);
            }
            if (body.managerId) {
              const activeMembership = await tx.departmentManager.findFirst({
                where: {
                  companyId: req.user!.companyId,
                  departmentId: department.id,
                  userId: body.managerId,
                  status: 'active',
                },
                select: { id: true },
              });
              if (!activeMembership) {
                await tx.departmentManager.create({
                  data: {
                    companyId: req.user!.companyId,
                    departmentId: department.id,
                    userId: body.managerId,
                    assignedByUserId: req.user!.id,
                  },
                });
              }
              changedManagerIds.add(body.managerId);
            }
            if (changedManagerIds.size > 0) {
              await tx.user.updateMany({
                where: {
                  companyId: req.user!.companyId,
                  id: { in: [...changedManagerIds] },
                },
                data: { authorizationVersion: { increment: 1 } },
              });
            }
          }
          await writeAuditRequired(tx as unknown as PrismaClient, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'department.update',
            details: { departmentId: department.id, changedFields },
          });
          return next;
        });
        res.json(shapeDepartment(updated));
      } catch (err) {
        if (err instanceof AuthorizationMutationDenied) {
          return res.status(403).json({
            error: 'DepartmentManagerAuthorityRequired',
            message: 'لا تملك صلاحية تعيين مدير قسم أو إلغاء تعيينه',
            code: 403,
          });
        }
        if ((err as { code?: string }).code === 'P2002') {
          return res.status(409).json({
            error: 'DepartmentAlreadyExists',
            message: 'يوجد قسم بهذا الاسم مسبقاً',
            code: 409,
          });
        }
        res.status(500).json({ error: 'Failed to update department' });
      }
    }
  );

  // --------------- ROUTES: LEAVES ---------------
  app.post('/api/leaves', requireAuth, checkPermission(PERMISSIONS.LEAVES_CREATE), async (req: AuthRequest, res) => {
    try {
      if (!req.user!.employeeId) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'لا يوجد ملف موظف مرتبط بهذا الحساب',
          code: 403,
        });
      }
      const body = validateBody(createLeaveSchema, req, res);
      if (!body) return;
      const { leaveType, startDate, endDate, reason, exitReentryRequested, visaFeePaid } = body;

      const start = new Date(startDate);
      const end = new Date(endDate);
      if (end < start) {
        return res
          .status(400)
          .json({ error: 'تاريخ النهاية لا يمكن أن يكون قبل تاريخ البداية' });
      }
      const calcTotalDays =
        Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;

      if (isAnnualLeave(leaveType) && exitReentryRequested && !visaFeePaid) {
        return res
          .status(400)
          .json({ error: 'الرجاء دفع رسوم التأشيرة ثم تقديم الطلب مرة أخرى' });
      }

      if (isSickLeave(leaveType)) {
        const currentYear = new Date().getFullYear();
        const usedLeaves = await prisma.leaveRequest.aggregate({
          _sum: { totalDays: true },
          where: {
            employeeId: req.user!.employeeId!,
            companyId: req.user!.companyId,
            leaveType: { in: leaveTypeAliases.sick },
            status: { in: ['approved', 'pending_hr', 'pending_admin'] },
            startDate: {
              gte: new Date(`${currentYear}-01-01T00:00:00.000Z`),
              lte: new Date(`${currentYear}-12-31T23:59:59.999Z`),
            },
          },
        });
        const used = usedLeaves._sum.totalDays || 0;
        if (used + calcTotalDays > 14) {
          return res
            .status(400)
            .json({ error: `You only have ${14 - used} sick leave days remaining this year.` });
        }
      }

      const request = await prisma.leaveRequest.create({
        data: {
          companyId: req.user!.companyId,
          employeeId: req.user!.employeeId!,
          leaveType,
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          totalDays: calcTotalDays,
          reason,
          exitReentryRequested: isAnnualLeave(leaveType) ? exitReentryRequested : false,
          visaFeePaid: isAnnualLeave(leaveType) ? visaFeePaid : false,
          status: 'pending_hr',
        },
      });

      await writeAudit(prisma, {
        companyId: req.user!.companyId,
        userId: req.user!.id,
        action: 'leave.submit',
        details: { leaveRequestId: request.id, leaveType, totalDays: calcTotalDays },
      });

      // Notify HR Managers
      const hrUsers = await prisma.user.findMany({
        where: {
          companyId: req.user!.companyId,
          role: { permissions: { contains: PERMISSIONS.HR_VIEW } },
        },
      });

      for (const hr of hrUsers) {
        await prisma.notification.create({
          data: {
            companyId: req.user!.companyId,
            userId: hr.id,
            title: 'طلب إجازة جديد',
            message: `تم تقديم طلب إجازة جديد للإعتماد.`,
          },
        });
      }

      // Notify Department Manager
      const employee = await prisma.employee.findUnique({
        where: { id: req.user!.employeeId! },
        include: { department: true },
      });
      if (employee?.department?.id) {
        const managerRows = await prisma.departmentManager.findMany({
          where: {
            companyId: req.user!.companyId,
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
          await prisma.notification.create({
            data: {
              companyId: req.user!.companyId,
              userId: managerId,
              title: 'طلب إجازة جديد في قسمك',
              message: `تم تقديم طلب إجازة جديد من قبل أحد موظفي قسمك.`,
            },
          });
        }
      }

      res.json(shapeLeaveRequest(request));
    } catch (err) {
      appLogger.error('leave.request.create_failed', {
        requestId: (req as any).requestId,
        actorId: req.user?.id,
        companyId: req.user?.companyId,
      });
      return res.status(500).json({
        error: 'InternalServerError',
        message: 'حدث خطأ داخلي. استخدم رقم الطلب عند التواصل مع الدعم.',
        code: 500,
        requestId: (req as any).requestId,
      });
    }
  });

  app.get('/api/leaves/my', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user!.employeeId) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'لا يوجد ملف موظف مرتبط بهذا الحساب',
          code: 403,
        });
      }
      const filters = validateQuery(myLeaveFiltersSchema, req, res);
      if (!filters) return;
      const requests = await prisma.leaveRequest.findMany({
        where: {
          ...leaveFilterWhere(filters),
          employeeId: req.user!.employeeId,
          companyId: req.user!.companyId,
        },
        select: leaveSafeSelect,
        orderBy: { createdAt: 'desc' },
      });
      res.json(requests.map(shapeLeaveRequest));
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch leaves.' });
    }
  });

  app.get(
    '/api/leaves/report',
    requireAuth,
    checkPermission(PERMISSIONS.LEAVES_VIEW),
    async (req: AuthRequest, res) => {
      try {
        const filters = validateQuery(leaveReportFiltersSchema, req, res);
        if (!filters) return;

        const explicitOwnerUserId = await primaryOwnerUserId(req.user!.companyId);
        const requesterPrivileged = isOwnerDataViewer(req.user!.permissions) ||
          explicitOwnerUserId === req.user!.id;
        if (filters.employeeId) {
          const target = await prisma.employee.findFirst({
            where: { id: filters.employeeId, companyId: req.user!.companyId },
            include: { user: { include: { role: true } } },
          });
          if (!target || (!requesterPrivileged &&
            (target.user?.id === explicitOwnerUserId || isOwnerUser(target.user)))) {
            return res.status(404).json({ error: 'الموظف غير موجود' });
          }
        }

        const rows = await prisma.leaveRequest.findMany({
          where: {
            ...leaveFilterWhere(filters),
            companyId: req.user!.companyId,
          },
          select: leaveSafeSelect,
          orderBy: { createdAt: 'desc' },
        });
        const visible = rows.filter(
          (row: any) => requesterPrivileged ||
            (row.employee?.user?.id !== explicitOwnerUserId && !isOwnerUser(row.employee?.user))
        );
        const requests = visible.map(shapeLeaveRequest);
        res.json({
          summary: {
            total: requests.length,
            pendingHr: requests.filter((row: any) => row.status === 'pending_hr').length,
            pendingAdmin: requests.filter((row: any) => row.status === 'pending_admin').length,
            approved: requests.filter((row: any) => row.status === 'approved').length,
            rejected: requests.filter((row: any) => row.status === 'rejected').length,
            cancelled: requests.filter((row: any) => row.status === 'cancelled').length,
            totalDays: requests.reduce((sum: number, row: any) => sum + (row.totalDays || 0), 0),
          },
          requests,
        });
      } catch (err) {
        res.status(500).json({ error: 'تعذر إعداد تقرير الإجازات' });
      }
    }
  );

  app.post('/api/leaves/:id/cancel', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user!.employeeId) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'لا يوجد ملف موظف مرتبط بهذا الحساب',
          code: 403,
        });
      }
      const leave = await prisma.leaveRequest.findFirst({
        where: {
          id: req.params.id,
          companyId: req.user!.companyId,
          employeeId: req.user!.employeeId,
        },
        select: leaveSafeSelect,
      });
      if (!leave) return res.status(404).json({ error: 'طلب الإجازة غير موجود' });

      const cancellationErrors: Record<string, string> = {
        pending_admin: 'لا يمكن إلغاء الطلب بعد تحويله للموافقة الإدارية. يرجى التواصل مع الموارد البشرية.',
        approved: 'لا يمكن إلغاء طلب إجازة تمت الموافقة عليه.',
        rejected: 'لا يمكن إلغاء طلب إجازة مرفوض.',
        cancelled: 'تم إلغاء طلب الإجازة مسبقاً.',
      };
      if (leave.status !== 'pending_hr') {
        return res.status(409).json({
          error: cancellationErrors[leave.status] ?? 'لا يمكن إلغاء طلب الإجازة بحالته الحالية.',
        });
      }

      const changed = await prisma.$transaction(async (tx) => {
        const result = await tx.leaveRequest.updateMany({
          where: {
            id: leave.id,
            companyId: req.user!.companyId,
            employeeId: req.user!.employeeId!,
            status: 'pending_hr',
          },
          data: { status: 'cancelled' },
        });
        if (result.count === 1) {
          await tx.leaveApprovalHistory.create({
            data: {
              companyId: req.user!.companyId,
              leaveRequestId: leave.id,
              actionByUserId: req.user!.id,
              action: 'cancel',
            },
          });
        }
        return result.count;
      });
      if (changed !== 1) {
        return res.status(409).json({
          error: 'تعذر إلغاء الطلب لأن حالته تغيرت. يرجى التحديث والمحاولة مرة أخرى.',
        });
      }
      await writeAudit(prisma, {
        companyId: req.user!.companyId,
        userId: req.user!.id,
        action: 'leave.cancel',
        details: { leaveRequestId: leave.id },
      });
      res.json(shapeLeaveRequest({ ...leave, status: 'cancelled' }));
    } catch (err) {
      res.status(500).json({ error: 'تعذر إلغاء طلب الإجازة' });
    }
  });

  app.get(
    '/api/leaves/pending',
    requireAuth,
    checkAnyPermission(PERMISSIONS.LEAVES_REVIEW, PERMISSIONS.LEAVES_APPROVE),
    async (req: AuthRequest, res) => {
      try {
        // HR sees 'pending_hr', Admin sees 'pending_admin'
        const statusFilter = req.user!.permissions.includes(PERMISSIONS.ADMIN_FULL)
          ? 'pending_admin'
          : 'pending_hr';

        const requests = await prisma.leaveRequest.findMany({
          where: { companyId: req.user!.companyId, status: statusFilter },
          select: leaveSafeSelect,
          orderBy: { createdAt: 'desc' },
        });
        const explicitOwnerUserId = await primaryOwnerUserId(req.user!.companyId);
        const requesterPrivileged = isOwnerDataViewer(req.user!.permissions) ||
          explicitOwnerUserId === req.user!.id;
        const visible = requests.filter(
          (row: any) => requesterPrivileged ||
            (row.employee?.user?.id !== explicitOwnerUserId && !isOwnerUser(row.employee?.user))
        );
        res.json(visible.map(shapeLeaveRequest));
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch pending requests.' });
      }
    }
  );

  app.get(
    '/api/leaves/:id',
    requireAuth,
    checkAnyPermission(
      PERMISSIONS.LEAVES_VIEW,
      PERMISSIONS.LEAVES_VIEW_OWN,
      PERMISSIONS.LEAVES_REVIEW,
      PERMISSIONS.LEAVES_APPROVE,
    ),
    async (req: AuthRequest, res) => {
      try {
        const canViewCompany =
          hasPermission(req.user!.permissions, PERMISSIONS.LEAVES_VIEW) ||
          hasPermission(req.user!.permissions, PERMISSIONS.LEAVES_REVIEW) ||
          hasPermission(req.user!.permissions, PERMISSIONS.LEAVES_APPROVE);
        const leave = await prisma.leaveRequest.findFirst({
          where: {
            id: req.params.id,
            companyId: req.user!.companyId,
            ...(!canViewCompany && req.user!.employeeId
              ? { employeeId: req.user!.employeeId }
              : {}),
          },
          select: leaveSafeSelect,
        });
        if (!leave) {
          return res.status(404).json({ error: 'Not found' });
        }
        if (!canViewCompany && leave.employeeId !== req.user!.employeeId) {
          return res.status(404).json({ error: 'Not found' });
        }
        const explicitOwnerUserId = await primaryOwnerUserId(req.user!.companyId);
        const requesterPrivileged = isOwnerDataViewer(req.user!.permissions) ||
          explicitOwnerUserId === req.user!.id;
        if (
          !requesterPrivileged &&
          (leave.employee?.user?.id === explicitOwnerUserId || isOwnerUser(leave.employee?.user))
        ) {
          return res.status(404).json({ error: 'Not found' });
        }
        res.json(shapeLeaveRequest(leave));
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch leave request.' });
      }
    }
  );

  app.post(
    '/api/leaves/:id/hr-approve',
    requireAuth,
    checkPermission(PERMISSIONS.LEAVES_APPROVE),
    async (req: AuthRequest, res) => {
      try {
        const outcome = await claimLeaveTransition({
          leaveRequestId: req.params.id,
          companyId: req.user!.companyId,
          actorUserId: req.user!.id,
          actorEmployeeId: req.user!.employeeId,
          expectedStatus: 'pending_hr',
          buildPlan: (leave) => {
            if (isAnnualLeave(leave.leaveType)) {
              return {
                update: { status: 'pending_admin', hrReviewerId: req.user!.employeeId },
                historyAction: 'escalate',
                auditAction: 'leave.hr_escalate',
                successMessage: 'Escalated to Admin',
                notify: async (tx) => {
                  const admins = await tx.user.findMany({
                    where: {
                      companyId: req.user!.companyId,
                      role: { permissions: { contains: PERMISSIONS.ADMIN_FULL } },
                    },
                  });
                  for (const admin of admins) {
                    await tx.notification.create({
                      data: {
                        companyId: req.user!.companyId,
                        userId: admin.id,
                        title: 'إجازة سنوية بانتظار الإعتماد',
                        message: 'طلب إجازة سنوية تم تصعيده للإعتماد النهائي.',
                      },
                    });
                  }
                },
              };
            }
            return {
              update: { status: 'approved', hrReviewerId: req.user!.employeeId },
              historyAction: 'hr_approve',
              auditAction: 'leave.hr_approve',
              successMessage: 'Approved',
              notify: async (tx, currentLeave) => {
                if (!currentLeave.employee.user) return;
                await tx.notification.create({
                  data: {
                    companyId: req.user!.companyId,
                    userId: currentLeave.employee.user.id,
                    title: 'تمت الموافقة',
                    message: 'تمت الموافقة على إجازتك المرفوعة.',
                  },
                });
              },
            };
          },
        });
        return sendLeaveTransition(res, outcome, 'Cannot approve own leave');
      } catch (err) {
        res.status(500).json({ error: 'Failed' });
      }
    }
  );

  app.post(
    '/api/leaves/:id/hr-reject',
    requireAuth,
    checkPermission(PERMISSIONS.LEAVES_APPROVE),
    async (req: AuthRequest, res) => {
      try {
        const body = validateBody(rejectReasonSchema, req, res);
        if (!body) return;
        const { reason } = body;
        const outcome = await claimLeaveTransition({
          leaveRequestId: req.params.id,
          companyId: req.user!.companyId,
          actorUserId: req.user!.id,
          actorEmployeeId: req.user!.employeeId,
          expectedStatus: 'pending_hr',
          buildPlan: () => ({
            update: {
              status: 'rejected',
              hrReviewerId: req.user!.employeeId,
              rejectionReason: reason,
            },
            historyAction: 'hr_reject',
            auditAction: 'leave.hr_reject',
            reason,
            successMessage: 'Rejected',
            notify: async (tx, leave) => {
              if (!leave.employee.user) return;
              await tx.notification.create({
                data: {
                  companyId: req.user!.companyId,
                  userId: leave.employee.user.id,
                  title: 'تم رفض الإجازة',
                  message: `تم رفض إجازتك من قبل الموارد البشرية. السبب: ${reason}`,
                },
              });
            },
          }),
        });
        return sendLeaveTransition(res, outcome, 'Cannot reject own leave');
      } catch (err) {
        res.status(500).json({ error: 'Failed' });
      }
    }
  );

  app.post(
    '/api/leaves/:id/admin-approve',
    requireAuth,
    checkPermission(PERMISSIONS.ADMIN_FULL),
    async (req: AuthRequest, res) => {
      try {
        const outcome = await claimLeaveTransition({
          leaveRequestId: req.params.id,
          companyId: req.user!.companyId,
          actorUserId: req.user!.id,
          actorEmployeeId: req.user!.employeeId,
          expectedStatus: 'pending_admin',
          buildPlan: () => ({
            update: { status: 'approved', adminApproverId: req.user!.employeeId },
            historyAction: 'admin_approve',
            auditAction: 'leave.admin_approve',
            successMessage: 'Approved by Admin',
            notify: async (tx, leave) => {
              if (!leave.employee.user) return;
              await tx.notification.create({
                data: {
                  companyId: req.user!.companyId,
                  userId: leave.employee.user.id,
                  title: 'تم الإعتماد النهائي',
                  message: 'تم إعتماد إجازتك السنوية من قبل الإدارة.',
                },
              });
            },
          }),
        });
        return sendLeaveTransition(res, outcome, 'Cannot approve own leave');
      } catch (err) {
        res.status(500).json({ error: 'Failed' });
      }
    }
  );

  app.post(
    '/api/leaves/:id/admin-reject',
    requireAuth,
    checkPermission(PERMISSIONS.ADMIN_FULL),
    async (req: AuthRequest, res) => {
      try {
        const body = validateBody(rejectReasonSchema, req, res);
        if (!body) return;
        const { reason } = body;
        const outcome = await claimLeaveTransition({
          leaveRequestId: req.params.id,
          companyId: req.user!.companyId,
          actorUserId: req.user!.id,
          actorEmployeeId: req.user!.employeeId,
          expectedStatus: 'pending_admin',
          buildPlan: () => ({
            update: {
              status: 'rejected',
              adminApproverId: req.user!.employeeId,
              rejectionReason: reason,
            },
            historyAction: 'admin_reject',
            auditAction: 'leave.admin_reject',
            reason,
            successMessage: 'Rejected by Admin',
            notify: async (tx, leave) => {
              if (!leave.employee.user) return;
              await tx.notification.create({
                data: {
                  companyId: req.user!.companyId,
                  userId: leave.employee.user.id,
                  title: 'تم رفض الإجازة السنوية',
                  message: `تم رفض إجازتك السنوية من قبل الإدارة. السبب: ${reason}`,
                },
              });
            },
          }),
        });
        return sendLeaveTransition(res, outcome, 'Cannot reject own leave');
      } catch (err) {
        res.status(500).json({ error: 'Failed' });
      }
    }
  );

  // --------------- ROUTES: DASHBOARD ---------------
  app.get('/api/dashboard/stats', requireAuth, async (req: AuthRequest, res) => {
    try {
      const filters = { companyId: req.user!.companyId };
      const empCount = await prisma.employee.count({ where: filters });

      // pending leaves for HR/Admin
      let pendingLeaves = 0;
      if (req.user!.permissions.includes(PERMISSIONS.ADMIN_FULL)) {
        pendingLeaves = await prisma.leaveRequest.count({
          where: { ...filters, status: 'pending_admin' },
        });
      } else if (req.user!.permissions.includes(PERMISSIONS.HR_VIEW)) {
        pendingLeaves = await prisma.leaveRequest.count({
          where: { ...filters, status: 'pending_hr' },
        });
      }

      // today's attendance
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const attCount = await prisma.attendance.count({
        where: { ...filters, date: { gte: today } },
      });

      res.json({ empCount, pendingLeaves, attCount });
    } catch (err) {
      res.status(500).json({ error: 'Stats failed' });
    }
  });

  // --------------- ROUTES: ATTENDANCE ---------------
  // Self clock-in/out is for regular staff (attendance.clock), NOT the general
  // manager: admin.full is explicitly blocked from clocking its own attendance.
  const blockAdminSelfClock = (
    req: AuthRequest,
    res: express.Response,
    next: express.NextFunction
  ) => {
    const perms = req.user?.permissions ?? [];
    if (perms.includes(PERMISSIONS.ADMIN_FULL)) {
      return res
        .status(403)
        .json({ error: 'تسجيل الحضور غير متاح لحساب المدير العام' });
    }
    if (!perms.includes(PERMISSIONS.ATTENDANCE_CLOCK)) {
      return res.status(403).json({ error: 'لا تملك صلاحية تسجيل الحضور' });
    }
    next();
  };

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const MAX_ATTENDANCE_RANGE_DAYS = 366;

  const parseUtcAttendanceDay = (value: string): Date | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
      ? parsed
      : null;
  };

  const startOfUtcDay = (value: Date): Date =>
    new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));

  const nextUtcDay = (value: Date): Date => new Date(value.getTime() + MS_PER_DAY);

  const optionalQueryString = (
    value: unknown,
    field: string,
    res: express.Response
  ): string | null | undefined => {
    if (value == null) return undefined;
    if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
      res.status(400).json({
        error: 'ValidationError',
        message: `قيمة ${field} غير صالحة`,
        code: 400,
      });
      return null;
    }
    return value;
  };

  const attendanceDateWhere = (
    req: AuthRequest,
    res: express.Response
  ): Record<string, unknown> | null => {
    const fromRaw = optionalQueryString(req.query.from, 'from', res);
    if (fromRaw === null) return null;
    const toRaw = optionalQueryString(req.query.to, 'to', res);
    if (toRaw === null) return null;

    const from = fromRaw ? parseUtcAttendanceDay(fromRaw) : null;
    const to = toRaw ? parseUtcAttendanceDay(toRaw) : null;
    if ((fromRaw && !from) || (toRaw && !to)) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'صيغة التاريخ يجب أن تكون yyyy-MM-dd',
        code: 400,
      });
      return null;
    }
    if (from && to && from.getTime() > to.getTime()) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'تاريخ البداية يجب ألا يكون بعد تاريخ النهاية',
        code: 400,
      });
      return null;
    }
    if (from && to && ((to.getTime() - from.getTime()) / MS_PER_DAY) + 1 > MAX_ATTENDANCE_RANGE_DAYS) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'نطاق الحضور لا يمكن أن يتجاوز 366 يوماً',
        code: 400,
      });
      return null;
    }

    return {
      ...(from ? { gte: from } : {}),
      ...(to ? { lt: nextUtcDay(to) } : {}),
    };
  };

  const managedDepartmentIds = async (req: AuthRequest): Promise<string[]> => {
    return loadManagedDepartmentIds(prisma, {
      companyId: req.user!.companyId,
      userId: req.user!.id,
    });
  };

  const hasCompanyAttendanceScope = (permissions: string[]): boolean =>
    permissions.includes(PERMISSIONS.ADMIN_FULL) ||
    permissions.includes(PERMISSIONS.ATTENDANCE_VIEW);

  app.post('/api/attendance/clock-in', requireAuth, blockAdminSelfClock, async (req: AuthRequest, res) => {
    try {
      const today = startOfUtcDay(new Date());
      const existing = await prisma.attendance.findFirst({
        where: {
          companyId: req.user!.companyId,
          employeeId: req.user!.employeeId!,
          date: { gte: today, lt: nextUtcDay(today) },
        },
      });
      if (existing) return res.status(400).json({ error: 'Already clocked in today' });

      const att = await prisma.attendance.create({
        data: {
          companyId: req.user!.companyId,
          employeeId: req.user!.employeeId!,
          date: new Date(),
          clockIn: new Date(),
          status: 'present',
        },
      });
      res.json(att);
    } catch (err) {
      res.status(500).json({ error: 'Failed to clock in' });
    }
  });

  app.post('/api/attendance/clock-out', requireAuth, blockAdminSelfClock, async (req: AuthRequest, res) => {
    try {
      const today = startOfUtcDay(new Date());
      const existing = await prisma.attendance.findFirst({
        where: {
          companyId: req.user!.companyId,
          employeeId: req.user!.employeeId!,
          date: { gte: today, lt: nextUtcDay(today) },
        },
      });
      if (!existing) return res.status(400).json({ error: 'Not clocked in today' });
      if (existing.clockOut) return res.status(400).json({ error: 'Already clocked out' });

      const att = await prisma.attendance.update({
        where: { id: existing.id },
        data: { clockOut: new Date() },
      });
      res.json(att);
    } catch (err) {
      res.status(500).json({ error: 'Failed to clock out' });
    }
  });

  // Explicit user select shared by attendance list endpoints. NEVER include the
  // raw user relation (that leaks password/bcrypt hash). role.permissions is
  // read only for the owner-privacy check and is dropped before responding.
  const attendanceEmployeeInclude = {
    employee: {
      select: {
        id: true,
        companyId: true,
        employeeNum: true,
        jobTitle: true,
        joiningDate: true,
        status: true,
        departmentId: true,
        createdAt: true,
        updatedAt: true,
        department: { select: { id: true, name: true } },
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: { select: { name: true, permissions: true } },
          },
        },
      },
    },
  } as const;

  const shapeAttendanceRow = (a: any) => ({
    ...a,
    employee: a.employee
      ? {
          ...a.employee,
          user: a.employee.user
            ? {
                id: a.employee.user.id,
                name: a.employee.user.name,
                email: a.employee.user.email,
                roleName: a.employee.user.role?.name ?? null,
              }
            : null,
        }
      : null,
  });

  app.get('/api/attendance/my', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (!req.user!.employeeId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const date = attendanceDateWhere(req, res);
      if (date === null) return;
      const att = await prisma.attendance.findMany({
        where: {
          employeeId: req.user!.employeeId,
          companyId: req.user!.companyId,
          ...(Object.keys(date).length > 0 ? { date } : {}),
        },
        include: attendanceEmployeeInclude,
        orderBy: { date: 'desc' },
      });
      // Own records: safe to include the requester's own name (no leak).
      res.json(att.map(shapeAttendanceRow));
    } catch (err) {
      res.status(500).json({ error: 'Failed to find attendance' });
    }
  });

  app.get(
    '/api/attendance/all',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const permissions = req.user!.permissions;
        const companyScope = hasCompanyAttendanceScope(permissions);
        const departmentScope = permissions.includes(PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT);
        if (!companyScope && !departmentScope) {
          return res.status(403).json({ error: 'Forbidden' });
        }

        const date = attendanceDateWhere(req, res);
        if (date === null) return;
        const requestedDepartmentId = optionalQueryString(req.query.departmentId, 'departmentId', res);
        if (requestedDepartmentId === null) return;
        const requestedEmployeeId = optionalQueryString(req.query.employeeId, 'employeeId', res);
        if (requestedEmployeeId === null) return;
        const requestedStatus = optionalQueryString(req.query.status, 'status', res);
        if (requestedStatus === null) return;
        if (requestedStatus && !['present', 'absent', 'late'].includes(requestedStatus)) {
          return res.status(400).json({
            error: 'ValidationError',
            message: 'حالة الحضور غير صالحة',
            code: 400,
          });
        }

        let allowedDepartmentIds: string[] | null = null;
        if (companyScope) {
          if (requestedDepartmentId) {
            const department = await prisma.department.findFirst({
              where: { id: requestedDepartmentId, companyId: req.user!.companyId },
              select: { id: true },
            });
            if (!department) {
              return res.status(400).json({
                error: 'ValidationError',
                message: 'القسم المحدد غير صالح',
                code: 400,
              });
            }
            allowedDepartmentIds = [requestedDepartmentId];
          }
        } else {
          const managedIds = await managedDepartmentIds(req);
          if (requestedDepartmentId && !managedIds.includes(requestedDepartmentId)) {
            return res.status(403).json({ error: 'Forbidden' });
          }
          allowedDepartmentIds = requestedDepartmentId ? [requestedDepartmentId] : managedIds;
        }

        const att = await prisma.attendance.findMany({
          where: {
            companyId: req.user!.companyId,
            ...(Object.keys(date).length > 0 ? { date } : {}),
            ...(requestedEmployeeId ? { employeeId: requestedEmployeeId } : {}),
            ...(requestedStatus ? { status: requestedStatus } : {}),
            ...(allowedDepartmentIds !== null
              ? { employee: { departmentId: { in: allowedDepartmentIds } } }
              : {}),
          },
          include: attendanceEmployeeInclude,
          orderBy: { date: 'desc' },
        });
        // Owner/admin attendance is hidden from non-HR viewers (privacy rule).
        const explicitOwnerUserId = await primaryOwnerUserId(req.user!.companyId);
        const requesterPrivileged = isOwnerDataViewer(req.user!.permissions) ||
          explicitOwnerUserId === req.user!.id;
        const visible = att.filter(
          (a: any) => requesterPrivileged ||
            (a.employee?.user?.id !== explicitOwnerUserId && !isOwnerUser(a.employee?.user))
        );
        res.json(visible.map(shapeAttendanceRow));
      } catch (err) {
        res.status(500).json({ error: 'Failed to find attendance' });
      }
    }
  );

  app.get(
    '/api/attendance/eligible-employees',
    requireAuth,
    checkPermission(PERMISSIONS.ATTENDANCE_MANAGE),
    async (req: AuthRequest, res) => {
      try {
        const permissions = req.user!.permissions;
        const companyScope = hasCompanyAttendanceScope(permissions);
        const departmentScope = permissions.includes(PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT);
        if (!companyScope && !departmentScope) {
          return res.status(403).json({ error: 'Forbidden' });
        }

        const allowedDepartmentIds = companyScope ? null : await managedDepartmentIds(req);
        const employees = await prisma.employee.findMany({
          where: {
            companyId: req.user!.companyId,
            status: 'active',
            ...(allowedDepartmentIds !== null
              ? { departmentId: { in: allowedDepartmentIds } }
              : {}),
          },
          select: {
            id: true,
            employeeNum: true,
            departmentId: true,
            department: { select: { id: true, name: true } },
            user: {
              select: {
                id: true,
                name: true,
                role: { select: { name: true, permissions: true } },
              },
            },
          },
          orderBy: { employeeNum: 'asc' },
        });

        const explicitOwnerUserId = await primaryOwnerUserId(req.user!.companyId);
        const requesterPrivileged = isOwnerDataViewer(permissions) || explicitOwnerUserId === req.user!.id;
        const visible = employees.filter((employee: any) => {
          const isSelf = employee.id === req.user!.employeeId;
          const protectedOwner = employee.user?.id === explicitOwnerUserId || isOwnerUser(employee.user);
          return !isSelf && (requesterPrivileged || !protectedOwner);
        });
        res.json(visible.map((employee: any) => ({
          employeeId: employee.id,
          employeeNum: employee.employeeNum,
          name: employee.user?.name ?? 'موظف',
          departmentId: employee.departmentId,
          departmentName: employee.department?.name ?? '',
          roleName: employee.user?.role?.name ?? null,
        })));
      } catch (err) {
        res.status(500).json({ error: 'Failed to find eligible employees' });
      }
    }
  );

  app.post(
    '/api/attendance/manual',
    requireAuth,
    checkPermission(PERMISSIONS.ATTENDANCE_MANAGE),
    async (req: AuthRequest, res) => {
      try {
        const body = validateBody(manualAttendanceSchema, req, res);
        if (!body) return;

        const permissions = req.user!.permissions;
        const companyScope = hasCompanyAttendanceScope(permissions);
        const departmentScope = permissions.includes(PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT);
        if (!companyScope && !departmentScope) {
          return res.status(403).json({ error: 'Forbidden' });
        }

        const employee = await prisma.employee.findFirst({
          where: { id: body.employeeId, companyId: req.user!.companyId },
          include: {
            department: true,
            user: { include: { role: true } },
          },
        });
        if (!employee) return res.status(404).json({ error: 'Employee not found' });
        if (employee.status !== 'active') {
          return res.status(400).json({
            error: 'ValidationError',
            message: 'لا يمكن إضافة حضور لموظف غير نشط',
            code: 400,
          });
        }

        if (employee.id === req.user!.employeeId) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'لا يمكن للمدير العام إدخال حضور يدوي لنفسه',
            code: 403,
          });
        }

        const targetIsProtectedOwner = await isProtectedPrincipalUser(employee.user, req.user!.companyId);
        const requesterIsExplicitOwner = await hasExplicitPrimaryOwnership(
          prisma,
          req.user!.companyId,
          req.user!.id,
        );
        if (!isOwnerDataViewer(permissions) && !requesterIsExplicitOwner && targetIsProtectedOwner) {
          return res.status(403).json({ error: 'Forbidden' });
        }

        if (!companyScope) {
          const managedIds = await managedDepartmentIds(req);
          if (!employee.departmentId || !managedIds.includes(employee.departmentId)) {
            return res.status(403).json({ error: 'Forbidden' });
          }
        }

        const workDate = parseUtcAttendanceDay(body.date)!;
        if (workDate.getTime() > startOfUtcDay(new Date()).getTime()) {
          return res.status(400).json({
            error: 'ValidationError',
            message: 'لا يمكن إضافة حضور بتاريخ مستقبلي',
            code: 400,
          });
        }
        if (body.status !== 'absent' && !body.clockIn) {
          return res.status(400).json({
            error: 'ValidationError',
            message: 'وقت الحضور مطلوب لهذه الحالة',
            code: 400,
          });
        }

        const clockIn = body.status === 'absent' || !body.clockIn
          ? null
          : new Date(`${body.date}T${body.clockIn}:00.000Z`);
        const clockOut = body.status === 'absent' || !body.clockOut
          ? null
          : new Date(`${body.date}T${body.clockOut}:00.000Z`);
        if (clockIn && clockOut && clockOut.getTime() < clockIn.getTime()) {
          return res.status(400).json({
            error: 'ValidationError',
            message: 'وقت الانصراف يجب ألا يكون قبل وقت الحضور',
            code: 400,
          });
        }

        const existing = await prisma.attendance.findFirst({
          where: {
            companyId: req.user!.companyId,
            employeeId: employee.id,
            date: { gte: workDate, lt: nextUtcDay(workDate) },
          },
        });
        if (existing) {
          return res.status(409).json({
            error: 'AttendanceAlreadyExists',
            message: 'يوجد سجل حضور لهذا الموظف في هذا اليوم مسبقاً',
            code: 409,
          });
        }

        const created = await prisma.attendance.create({
          data: {
            companyId: req.user!.companyId,
            employeeId: employee.id,
            date: workDate,
            clockIn,
            clockOut,
            status: body.status,
          },
          include: attendanceEmployeeInclude,
        });
        await writeAudit(prisma, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'attendance.manual_create',
          details: {
            attendanceId: created.id,
            employeeId: employee.id,
            date: body.date,
            status: body.status,
          },
        });
        res.status(201).json(shapeAttendanceRow(created));
      } catch (err) {
        res.status(500).json({ error: 'Failed to create manual attendance' });
      }
    }
  );

  // --------------- ROUTES: NOTIFICATIONS ---------------
  app.get('/api/notifications', requireAuth, async (req: AuthRequest, res) => {
    try {
      const notifications = await prisma.notification.findMany({
        where: { userId: req.user!.id, companyId: req.user!.companyId },
        orderBy: { createdAt: 'desc' },
      });
      res.json(notifications);
    } catch (err) {
      res.status(500).json({ error: 'Failed to find notifications' });
    }
  });

  app.get('/api/notifications/unread-count', requireAuth, async (req: AuthRequest, res) => {
    try {
      const count = await prisma.notification.count({
        where: { userId: req.user!.id, companyId: req.user!.companyId, isRead: false },
      });
      res.json({ count });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch count' });
    }
  });

  app.post('/api/notifications/:id/read', requireAuth, async (req: AuthRequest, res) => {
    try {
      const notif = await prisma.notification.findFirst({
        where: { id: req.params.id, userId: req.user!.id, companyId: req.user!.companyId },
      });
      if (!notif) return res.status(404).json({ error: 'Not found' });
      await prisma.notification.update({
        where: { id: notif.id },
        data: { isRead: true },
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed' });
    }
  });

  registerNotificationRoutes({ app, prisma, requireAuth, checkAnyPermission });
  registerAttendanceWorkflowRoutes({ app, prisma, requireAuth, checkAnyPermission });
  registerLeaveOnBehalfRoutes({ app, prisma, requireAuth, checkAnyPermission });
  registerLeaveOverrideRoutes({ app, prisma, requireAuth, checkPermission });
  registerEmployeeCredentialRoutes({ app, prisma, requireAuth, checkAnyPermission });
  registerEmployeeCredentialResetRoutes({
    app,
    prisma,
    requireAuth,
    checkPermission,
    rateLimiter: createEmployeeAdminResetRateLimiter(
      prisma,
      config.credentialRecoveryRateLimitPepper
        ?? process.env[RECOVERY_RATE_LIMIT_PEPPER_ENV]
        ?? null,
      {
        useInMemoryStore: typeof (prisma as PrismaClient & { $connect?: unknown }).$connect !== 'function',
      },
    ),
  });
  registerEmployeeArchiveRoutes({ app, prisma, requireAuth, checkPermission });
  registerForcedPasswordChangeRoutes({ app, prisma, requireAuth });

  // --------------- ROUTES: PURCHASING / VENDORS ---------------
  registerPurchasingRoutes({ app, prisma, requireAuth, checkAnyPermission });
  registerVendorLifecycleRoutes({ app, prisma, requireAuth, checkPermission });
  registerPurchasingOverrideRoutes({ app, prisma, requireAuth, checkPermission });
  registerPurchasingExportRoutes({ app, prisma, requireAuth, exportLimiter });
  // Commercial Wave 2 — Operations Slice E1.
  registerPurchasingQuotationRoutes({ app, prisma, requireAuth, checkAnyPermission });
  registerPurchasingReceiptRoutes({ app, prisma, requireAuth, checkAnyPermission });
  registerTrainingRoutes({ app, prisma, requireAuth, checkAnyPermission });
  registerTrainingExportRoutes({ app, prisma, requireAuth, exportLimiter });

  // --------------- ROUTES: PAYROLL ---------------
  registerPayrollRoutes({ app, prisma, requireAuth, checkAnyPermission });
  registerPayrollPaymentRoutes({ app, prisma, requireAuth, checkAnyPermission });
  registerPayrollExportRoutes({ app, prisma, requireAuth, exportLimiter });
  registerPayrollW1aRoutes({ app, prisma, requireAuth, checkAnyPermission });

  // --------------- ROUTES: FINANCE (W1A) ---------------
  registerFinanceRoutes({ app, prisma, requireAuth, checkAnyPermission });

  // --------------- ROUTES: TASKS ---------------
  registerTaskRoutes({ app, prisma, requireAuth, checkAnyPermission });

  registerChatRoutes({
    app,
    prisma,
    requireAuth,
    checkAnyPermission,
    messageRateLimitWindowMs: config.chatMessageRateLimitWindowMs,
    messageRateLimitMax: config.chatMessageRateLimitMax,
  });
  registerAttachmentRoutes({
    app,
    prisma,
    requireAuth,
    checkAnyPermission,
    messageRateLimitWindowMs: config.chatMessageRateLimitWindowMs,
    messageRateLimitMax: config.chatMessageRateLimitMax,
  });

  // --------------- ROUTES: GLOBAL SEARCH + TIMELINES (Sprint 12L) ---------------
  registerSearchRoutes({ app, prisma, requireAuth, searchLimiter });
  registerTimelineRoutes({ app, prisma, requireAuth, checkAnyPermission });

  registerReportRoutes({
    app,
    prisma,
    requireAuth,
    exportLimiter,
  });
  registerReportTemplateRoutes({ app, prisma, requireAuth });
  registerReportTemplateExportRoutes({ app, prisma, requireAuth, exportLimiter });

  registerAuthorizationRoutes({
    app,
    prisma,
    requireAuth,
    sensitiveLimiter,
    jwtSecret: JWT_SECRET,
    mfaEncryptionKey: config.mfaEncryptionKey,
  });

  registerSessionRoutes({
    app,
    prisma,
    requireAuth,
    jwtSecret: JWT_SECRET ?? '',
    sensitiveLimiter,
  });

  registerAdminSessionRoutes({
    app,
    prisma,
    requireAuth,
    checkPermission,
    sensitiveLimiter,
  });

  // Company administrators can see aggregate counts within their own company.
  app.get('/api/owner/metrics', requireAuth, checkPermission(PERMISSIONS.ADMIN_FULL), async (req: AuthRequest, res) => {
    const companyId = req.user?.companyId;
    if (!companyId) return res.status(403).json({ error: 'Forbidden' });
    try {
      const where = { companyId };
      const [companies, users, employees, auditLogs] = await Promise.all([
        prisma.company.count({ where: { id: companyId } }),
        prisma.user.count({ where }),
        prisma.employee.count({ where }),
        prisma.auditLog.count({ where }),
      ]);
      res.json({ companies, users, employees, auditLogs });
    } catch { res.status(500).json({ error: 'Metrics failed' }); }
  });

  // --------------- ROUTES: AI ASSISTANT (Gemini proxy) ---------------
  // The Android app must NEVER call Gemini directly — the key lives only on
  // this server. Route path matches the Android AiAssistantApi contract.
  app.post('/api/v1/ai/chat', aiLimiter, requireAuth, async (req: AuthRequest, res) => {
    const body = validateBody(aiChatSchema, req, res);
    if (!body) return;
    if (!aiProvider) {
      return res.status(503).json({
        error: 'AIUnavailable',
        message: 'خدمة الذكاء الاصطناعي غير مهيأة على الخادم.',
        code: 503,
      });
    }
    try {
      // Deliberately no logging of the prompt: it may contain personal HR data.
      const reply = await aiProvider.chat(body.message);
      res.json({ reply });
    } catch (err) {
      res.status(502).json({
        error: 'AIProviderError',
        message: 'تعذر الحصول على رد من خدمة الذكاء الاصطناعي.',
        code: 502,
      });
    }
  });

  app.use('/api', (_req, res) => {
    return res.status(404).json({
      error: 'RouteNotFound',
      message: 'المسار المطلوب غير موجود',
      code: 404,
    });
  });

  app.use(finalErrorHandler({
    isProduction: Boolean(config.isProduction),
    logger: config.requestLogger,
    appLogger,
  }));

  return app;
}
