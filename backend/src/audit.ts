import type { PrismaClient } from '@prisma/client';

type AuditClient = Pick<PrismaClient, 'auditLog'>;

interface AuditEntry {
  companyId: string;
  userId: string;
  action: string;
  details?: Record<string, unknown>;
}

const FORBIDDEN_AUDIT_KEY = /(?:password|temporarypassword|passwordhash|hash|token|accesstoken|refreshtoken|sessiontoken|authorization|cookie|secret|mfasecret|totpsecret|totpcode|backupcode|backupcodes|mfachallenge|challenge|invitationtoken|resettoken|recoverytoken|encryptionkey|privatekey|signingmaterial|clientsecret|databaseurl|apikey|salary|gross|netpay|message|body|description|justification|reviewnote|completionnote|cancellationreason|receiptnote|resourceurl|contact|email|taxnumber|score|progress)/i;
const FORBIDDEN_AUDIT_VALUE = /(?:bearer\s+|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/|postgres(?:ql)?:\/\/|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)/i;

/** E2 bounded administrative reset reasons — safe enum values, never free text. */
const ALLOWED_CREDENTIAL_RESET_REASONS = new Set([
  'forgotten_password',
  'suspected_compromise',
  'administrative_rotation',
  'access_recovery',
]);

/** E3/E4 bounded recovery initiation types — safe enum values only. */
const ALLOWED_RECOVERY_INITIATION_TYPES = new Set([
  'self',
  'platform_operator',
]);

/** E5 bounded CLI recovery modes / reason categories / environment classes. */
const ALLOWED_PLATFORM_RECOVERY_MODES = new Set([
  'mfa-recovery',
  'full-break-glass',
]);
const ALLOWED_PLATFORM_RECOVERY_REASON_CATEGORIES = new Set([
  'lost_mfa_device',
  'suspected_compromise',
  'total_lockout',
  'administrative_security_event',
]);
const ALLOWED_PLATFORM_RECOVERY_ENVIRONMENT_CLASSES = new Set([
  'local',
  'test',
  'staging',
  'production',
  'development',
]);

function safeAuditKey(key: string): boolean {
  // Message content stays forbidden, but its numeric length is safe operational metadata.
  if (key === 'bodyLength') return true;
  if (FORBIDDEN_AUDIT_KEY.test(key)) return false;
  if (['__proto__', 'prototype', 'constructor'].includes(key)) return false;
  return /(?:Id|Ids|Count|Version)$/.test(key) ||
    [
      'action',
      'status',
      'scope',
      'reportType',
      'rulesVersion',
      'filters',
      'filterKeys',
      'fieldNames',
      'changedFields',
      'redacted',
      'protectedRowsHidden',
      'idempotent',
      'resetReason',
      'archiveReason',
      'revokedReason',
      'amountCents',
      'currencyCode',
      'format',
      'previousStatus',
      'newStatus',
      'entityType',
      'requestCount',
      'orderCount',
      'initiationType',
      // E5 Platform MFA / break-glass CLI bounded metadata (never secrets).
      'mode',
      'reasonCategory',
      'environmentClass',
      'fingerprintReference',
      'dryRun',
      'mfaInvalidated',
      'recoveryPackageIssued',
      'offlineVerifierReference',
      'ceremonyReference',
      // Commercial W1A payroll/finance bounded metadata (never free-text reasons).
      'rateBps',
      'calcMethod',
      'componentType',
      'lineCount',
      'debitCents',
      'creditCents',
      'confirmationProvided',
      'percentageBasis',
      'recalculationReasonProvided',
      'reopenReasonProvided',
      'sourceType',
      'reasonProvided',
      'direction',
      // Commercial W2 purchasing expansion — bounded quantity/state metadata.
      // Never quotation text, supplier bank data or unbounded line payloads.
      'overrideApplied',
      'reasonCode',
      'receiptKind',
      'fullyReceived',
      'orderedMilli',
      'receivedMilli',
      'returnedMilli',
      'remainingMilli',
    ].includes(key);
}

function sanitizeAuditValue(value: unknown, depth: number, parentKey?: string): unknown {
  if (depth > 8 || value == null) return undefined;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 160 || FORBIDDEN_AUDIT_VALUE.test(trimmed)) return undefined;
    // Exact integer-cent strings for financial audit metadata (preserve beyond MAX_SAFE_INTEGER).
    if (
      (parentKey === 'debitCents' || parentKey === 'creditCents' || parentKey === 'amountCents')
      && /^\d{1,40}$/.test(trimmed)
    ) {
      return trimmed;
    }
    // W2 purchasing quantities are exact integer milli-units, kept as strings so
    // they survive beyond MAX_SAFE_INTEGER just like the cent fields above.
    if (
      (parentKey === 'orderedMilli' || parentKey === 'receivedMilli'
        || parentKey === 'returnedMilli' || parentKey === 'remainingMilli')
      && /^\d{1,40}$/.test(trimmed)
    ) {
      return trimmed;
    }
    if (parentKey === 'reasonCode' && /^[a-z][a-z0-9_]{2,40}$/.test(trimmed)) {
      return trimmed;
    }
    if (parentKey === 'receiptKind' && (trimmed === 'partial' || trimmed === 'full')) {
      return trimmed;
    }
    if (parentKey === 'resetReason' && ALLOWED_CREDENTIAL_RESET_REASONS.has(trimmed)) {
      return trimmed;
    }
    if (parentKey === 'initiationType' && ALLOWED_RECOVERY_INITIATION_TYPES.has(trimmed)) {
      return trimmed;
    }
    if (parentKey === 'mode' && ALLOWED_PLATFORM_RECOVERY_MODES.has(trimmed)) {
      return trimmed;
    }
    if (
      parentKey === 'reasonCategory'
      && ALLOWED_PLATFORM_RECOVERY_REASON_CATEGORIES.has(trimmed)
    ) {
      return trimmed;
    }
    if (
      parentKey === 'environmentClass'
      && ALLOWED_PLATFORM_RECOVERY_ENVIRONMENT_CLASSES.has(trimmed)
    ) {
      return trimmed;
    }
    if (parentKey === 'fingerprintReference' && /^fp:[A-Za-z0-9_-]{4,32}$/.test(trimmed)) {
      return trimmed;
    }
    if (
      (parentKey === 'offlineVerifierReference' || parentKey === 'ceremonyReference')
      && /^[A-Za-z0-9_.:-]{3,120}$/.test(trimmed)
    ) {
      return trimmed;
    }
    if (FORBIDDEN_AUDIT_KEY.test(trimmed)) return undefined;
    return trimmed;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) => sanitizeAuditValue(item, depth + 1, parentKey))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (!safeAuditKey(key)) continue;
    const clean = sanitizeAuditValue(nested, depth + 1, key);
    if (clean !== undefined) sanitized[key] = clean;
  }
  return sanitized;
}

/**
 * Treats every audit payload, including legacy JSON, as untrusted input.
 * Only identifiers, statuses, counts, versions, scopes and filter-key names survive.
 */
export function sanitizeAuditDetails(raw: unknown): Record<string, unknown> {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { redacted: true };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { redacted: true };
  }
  const sanitized = sanitizeAuditValue(parsed, 0);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return { redacted: true };
  }
  const object = sanitized as Record<string, unknown>;
  return Object.keys(object).length > 0 ? object : { redacted: true };
}

/**
 * Audit trail helper.
 *
 * Writes a row to AuditLog for sensitive state-changing actions.
 * SECURITY RULES:
 *  - NEVER pass passwords, tokens, refresh tokens, or secrets in `details`.
 *  - Audit failures must never break the main request — errors are swallowed
 *    (logged to stderr without the details payload).
 */
export async function writeAudit(
  prisma: AuditClient,
  entry: AuditEntry
): Promise<void> {
  try {
    await writeAuditRequired(prisma, entry);
  } catch (err) {
    // Never let auditing break the request; never print the details payload.
    console.error(`[audit] failed to write action=${entry.action}`);
  }
}

/** Salary/payroll writes use this inside their transaction so audit failure rolls back the write. */
export async function writeAuditRequired(
  prisma: AuditClient,
  entry: AuditEntry
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      companyId: entry.companyId,
      userId: entry.userId,
      action: entry.action,
      details: JSON.stringify(sanitizeAuditDetails(entry.details ?? {})),
    },
  });
}
