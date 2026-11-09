import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { RecoveryPrincipalDomain } from './contracts';
import type { RecoveryInternalReasonCode } from './errors';

export const RECOVERY_AUDIT_EVENT_TYPES = [
  'recovery_request_issued',
  'recovery_request_superseded',
  'recovery_request_consumed',
  'recovery_request_rejected',
  'recovery_request_invalidated',
  'recovery_delivery_recorded',
  'recovery_rate_limit_triggered',
  'recovery_alert_raised',
] as const;
export type RecoveryAuditEventType = (typeof RECOVERY_AUDIT_EVENT_TYPES)[number];

export const RECOVERY_AUDIT_ACTOR_TYPES = [
  'anonymous',
  'platform_owner',
  'primary_owner',
  'company_admin',
  'employee',
  'system',
  'support',
] as const;
export type RecoveryAuditActorType = (typeof RECOVERY_AUDIT_ACTOR_TYPES)[number];

export const RECOVERY_AUDIT_RESULTS = [
  'success',
  'failure',
  'denied',
  'expired',
  'limited',
] as const;
export type RecoveryAuditResult = (typeof RECOVERY_AUDIT_RESULTS)[number];

export const RECOVERY_AUDIT_SUBJECT_DOMAINS = [
  'platform_principal',
  'company_primary_owner',
  'company_employee',
  'unresolved',
] as const;
export type RecoveryAuditSubjectDomain = (typeof RECOVERY_AUDIT_SUBJECT_DOMAINS)[number];

const ALLOWED_REASON_CODES = new Set<string>([
  'issued',
  'superseded',
  'consumed',
  'invalid_or_expired_token',
  'token_already_used',
  'credential_version_mismatch',
  'environment_mismatch',
  'purpose_mismatch',
  'domain_mismatch',
  'company_mismatch',
  'algorithm_mismatch',
  'rate_limited',
  'policy_rejected',
  'target_unresolved',
  'admin_cancelled',
  'security_event',
  'expired',
  'delivery_dispatched',
  'delivery_failed',
  'alert_threshold',
  'callback_failed',
  'concurrent_conflict',
]);

const FORBIDDEN_KEY = /(?:password|temporarypassword|newpassword|token|tokenhash|resettoken|recoverytoken|authorization|cookie|accesstoken|refreshtoken|mfasecret|otpauth|backupcode|databaseurl|providerraw|providerresponse|secret|body|rawerror|stack|email|phone|ipaddress|recoveryurl|url)/i;
const FORBIDDEN_VALUE = /(?:bearer\s+|-----BEGIN |https?:\/\/|postgres(?:ql)?:\/\/|\botpauth:\/\/|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|hmac-sha256-v1:[a-f0-9]{32,})/i;

export interface RecoveryAuditEventInput {
  eventType: RecoveryAuditEventType;
  actorType: RecoveryAuditActorType;
  actorId?: string | null;
  subjectId?: string | null;
  subjectDomain: RecoveryAuditSubjectDomain;
  companyId?: string | null;
  result: RecoveryAuditResult;
  reasonCode: string;
  recoveryRequestId?: string | null;
  requestId: string;
  sourceBucketHash?: string | null;
  referenceId?: string;
  timestamp?: Date;
}

export class RecoveryAuditSanitizationError extends Error {
  readonly rejectedKeys: string[];

  constructor(message: string, rejectedKeys: string[] = []) {
    super(message);
    this.name = 'RecoveryAuditSanitizationError';
    this.rejectedKeys = rejectedKeys;
  }
}

export interface RecoveryAuditActorInput {
  actorType?: RecoveryAuditActorType | null;
  actorId?: string | null;
  /** Used only when actorType is absent. Never invented from actorId alone. */
  defaultActorType: RecoveryAuditActorType;
}

export interface RecoveryAuditActor {
  actorType: RecoveryAuditActorType;
  actorId: string | null;
}

type AuditClient = Pick<PrismaClient, 'credentialRecoveryAuditEvent'>;

function assertBoundedString(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new RecoveryAuditSanitizationError(`Invalid recovery audit field: ${field}`);
  }
  if (FORBIDDEN_VALUE.test(trimmed)) {
    throw new RecoveryAuditSanitizationError(`Forbidden value shape in recovery audit field: ${field}`);
  }
  return trimmed;
}

function assertEnum<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new RecoveryAuditSanitizationError(`Invalid recovery audit enum: ${field}`);
  }
  return value as T;
}

function hasProvidedActorId(actorId: string | null | undefined): boolean {
  return typeof actorId === 'string' && actorId.trim().length > 0;
}

/**
 * Canonical recovery-audit actor contract.
 * actorType and actorId are validated together; anonymous always forces actorId null
 * and rejects any supplied actorId (fail closed — never silently drop or invent types).
 */
export function normalizeRecoveryAuditActor(input: RecoveryAuditActorInput): RecoveryAuditActor {
  if (input.actorId != null && typeof input.actorId !== 'string') {
    throw new RecoveryAuditSanitizationError('actorId must be string or null', ['actorId']);
  }

  const actorType =
    input.actorType == null
      ? assertEnum(String(input.defaultActorType), RECOVERY_AUDIT_ACTOR_TYPES, 'defaultActorType')
      : assertEnum(String(input.actorType), RECOVERY_AUDIT_ACTOR_TYPES, 'actorType');

  if (actorType === 'anonymous') {
    if (hasProvidedActorId(input.actorId)) {
      throw new RecoveryAuditSanitizationError(
        'anonymous recovery audit actors must not include actorId',
        ['actorId'],
      );
    }
    return { actorType: 'anonymous', actorId: null };
  }

  return {
    actorType,
    actorId: hasProvidedActorId(input.actorId)
      ? assertBoundedString(String(input.actorId), 'actorId', 80)
      : null,
  };
}

/**
 * Reject unknown fields and known sensitive key names recursively.
 * Prefer fixed typed columns — callers must not pass arbitrary dumps.
 */
export function sanitizeRecoveryAuditEvent(
  raw: Record<string, unknown>,
): RecoveryAuditEventInput {
  const allowedKeys = new Set([
    'eventType',
    'actorType',
    'actorId',
    'subjectId',
    'subjectDomain',
    'companyId',
    'result',
    'reasonCode',
    'recoveryRequestId',
    'requestId',
    'sourceBucketHash',
    'referenceId',
    'timestamp',
  ]);

  const rejected: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key) || FORBIDDEN_KEY.test(key)) {
      rejected.push(key);
    }
  }
  if (rejected.length > 0) {
    throw new RecoveryAuditSanitizationError(
      `Recovery audit rejected unknown or sensitive fields: ${rejected.join(',')}`,
      rejected,
    );
  }

  rejectSensitiveNested(raw, 0, rejected);
  if (rejected.length > 0) {
    throw new RecoveryAuditSanitizationError(
      `Recovery audit rejected nested sensitive material`,
      rejected,
    );
  }

  const eventType = assertEnum(String(raw.eventType), RECOVERY_AUDIT_EVENT_TYPES, 'eventType');
  if (raw.actorType == null) {
    throw new RecoveryAuditSanitizationError('actorType is required');
  }
  const actor = normalizeRecoveryAuditActor({
    actorType: String(raw.actorType) as RecoveryAuditActorType,
    actorId: raw.actorId as string | null | undefined,
    defaultActorType: 'anonymous',
  });
  const subjectDomain = assertEnum(String(raw.subjectDomain), RECOVERY_AUDIT_SUBJECT_DOMAINS, 'subjectDomain');
  const result = assertEnum(String(raw.result), RECOVERY_AUDIT_RESULTS, 'result');
  const reasonCode = assertBoundedString(String(raw.reasonCode ?? ''), 'reasonCode', 64);
  if (!ALLOWED_REASON_CODES.has(reasonCode)) {
    throw new RecoveryAuditSanitizationError(`Unknown recovery audit reasonCode: ${reasonCode}`);
  }
  const requestId = assertBoundedString(String(raw.requestId ?? ''), 'requestId', 80);

  if (raw.subjectId != null && typeof raw.subjectId !== 'string') {
    throw new RecoveryAuditSanitizationError('subjectId must be string or null');
  }
  if (raw.companyId != null && typeof raw.companyId !== 'string') {
    throw new RecoveryAuditSanitizationError('companyId must be string or null');
  }
  if (raw.recoveryRequestId != null && typeof raw.recoveryRequestId !== 'string') {
    throw new RecoveryAuditSanitizationError('recoveryRequestId must be string or null');
  }
  if (raw.sourceBucketHash != null && typeof raw.sourceBucketHash !== 'string') {
    throw new RecoveryAuditSanitizationError('sourceBucketHash must be string or null');
  }
  if (raw.timestamp != null && !(raw.timestamp instanceof Date)) {
    throw new RecoveryAuditSanitizationError('timestamp must be a Date when provided');
  }

  const optionalId = (value: unknown, field: string): string | null => {
    if (value == null) return null;
    return assertBoundedString(String(value), field, 80);
  };

  return {
    eventType,
    actorType: actor.actorType,
    actorId: actor.actorId,
    subjectId: optionalId(raw.subjectId, 'subjectId'),
    subjectDomain,
    companyId: optionalId(raw.companyId, 'companyId'),
    result,
    reasonCode,
    recoveryRequestId: optionalId(raw.recoveryRequestId, 'recoveryRequestId'),
    requestId,
    sourceBucketHash: optionalId(raw.sourceBucketHash, 'sourceBucketHash'),
    referenceId: raw.referenceId != null
      ? assertBoundedString(String(raw.referenceId), 'referenceId', 80)
      : `ref_evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    timestamp: raw.timestamp instanceof Date ? raw.timestamp : undefined,
  };
}

function rejectSensitiveNested(
  value: unknown,
  depth: number,
  rejected: string[],
): void {
  if (depth > 4 || value == null) return;
  if (typeof value === 'string') {
    if (FORBIDDEN_VALUE.test(value) || value.length > 200) {
      rejected.push('value');
    }
    return;
  }
  if (typeof value !== 'object') return;
  if (value instanceof Error) {
    rejected.push('Error');
    return;
  }
  if (value instanceof Date) {
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) rejected.push(key);
    rejectSensitiveNested(nested, depth + 1, rejected);
  }
}

export async function writeRecoveryAuditRequired(
  prisma: AuditClient,
  input: RecoveryAuditEventInput | Record<string, unknown>,
): Promise<{ id: string; referenceId: string }> {
  const sanitized = sanitizeRecoveryAuditEvent(input as Record<string, unknown>);
  const id = randomUUID();
  await prisma.credentialRecoveryAuditEvent.create({
    data: {
      id,
      eventType: sanitized.eventType,
      timestamp: sanitized.timestamp ?? new Date(),
      actorType: sanitized.actorType,
      actorId: sanitized.actorId ?? null,
      subjectId: sanitized.subjectId ?? null,
      subjectDomain: sanitized.subjectDomain,
      companyId: sanitized.companyId ?? null,
      result: sanitized.result,
      reasonCode: sanitized.reasonCode,
      recoveryRequestId: sanitized.recoveryRequestId ?? null,
      requestId: sanitized.requestId,
      sourceBucketHash: sanitized.sourceBucketHash ?? null,
      referenceId: sanitized.referenceId!,
    },
  });
  return { id, referenceId: sanitized.referenceId! };
}

export function subjectDomainFromPrincipal(
  domain: RecoveryPrincipalDomain | 'unresolved',
): RecoveryAuditSubjectDomain {
  return domain;
}

export function reasonFromInternal(reason: RecoveryInternalReasonCode): string {
  switch (reason) {
    case 'token_invalid':
    case 'token_expired':
    case 'token_invalidated':
      return 'invalid_or_expired_token';
    case 'token_consumed':
    case 'token_superseded':
      return 'token_already_used';
    default:
      return reason;
  }
}
