/**
 * Canonical internal recovery contracts for E1 foundation.
 * Callers must never trust client-supplied domain/purpose/company/environment.
 */

export const RECOVERY_PRINCIPAL_DOMAINS = [
  'platform_principal',
  'company_primary_owner',
  'company_employee',
] as const;
export type RecoveryPrincipalDomain = (typeof RECOVERY_PRINCIPAL_DOMAINS)[number];

export const RECOVERY_PURPOSES = [
  'password_reset',
  'account_discovery',
  'mfa_recovery',
  'break_glass_recovery',
  'employee_admin_reset',
] as const;
export type RecoveryPurpose = (typeof RECOVERY_PURPOSES)[number];

export const RECOVERY_INITIATORS = [
  'self',
  'platform_operator',
  'company_admin',
  'system',
] as const;
export type RecoveryInitiator = (typeof RECOVERY_INITIATORS)[number];

export const RECOVERY_DELIVERY_CHANNELS = ['email', 'sms', 'push', 'none'] as const;
export type RecoveryDeliveryChannel = (typeof RECOVERY_DELIVERY_CHANNELS)[number];

export const RECOVERY_DELIVERY_STATUSES = ['pending', 'dispatched', 'failed'] as const;
export type RecoveryDeliveryStatus = (typeof RECOVERY_DELIVERY_STATUSES)[number];

export const RECOVERY_INVALIDATION_REASONS = [
  'superseded',
  'credential_version_mismatch',
  'expired',
  'consumed',
  'admin_cancelled',
  'security_event',
] as const;
export type RecoveryInvalidationReason = (typeof RECOVERY_INVALIDATION_REASONS)[number];

export const RECOVERY_TOKEN_HASH_ALGORITHM = 'hmac-sha256-v1' as const;
export type RecoveryTokenHashAlgorithm = typeof RECOVERY_TOKEN_HASH_ALGORITHM;

export const RECOVERY_TOKEN_VERSION = 'recovery-token-v1' as const;

/** Minimum raw entropy for bearer recovery tokens (bits). */
export const RECOVERY_TOKEN_MIN_ENTROPY_BITS = 256;

/** Server-owned TTL bounds (seconds). Not request-selectable. */
export const RECOVERY_TTL_MIN_SECONDS = 60;
export const RECOVERY_TTL_MAX_SECONDS = 24 * 60 * 60;

export const RECOVERY_ENVIRONMENT_CLASSES = [
  'local',
  'test',
  'staging',
  'production',
] as const;
export type RecoveryEnvironmentClass = (typeof RECOVERY_ENVIRONMENT_CLASSES)[number];

export interface RecoveryPurposePolicy {
  purpose: RecoveryPurpose;
  allowedDomains: readonly RecoveryPrincipalDomain[];
  mintsBearerToken: boolean;
  requiresCompanyId: boolean | 'domain_dependent';
  defaultTtlSeconds: number;
  /**
   * When true, E1 owns a single credentialVersion increment on successful consume.
   * Future E2–E5 effects must not increment again.
   */
  affectsCredentialVersionOnConsume: boolean;
  /** When true, password-shaped consumption must preserve MFA enrollment. */
  preservesMfaOnConsume: boolean;
  /** When true, successful MFA-recovery consumption requires separate MFA clear/re-enroll. */
  requiresSeparateMfaRecovery: boolean;
}

/**
 * Server-owned policy matrix. Invalid domain/purpose/company combinations
 * must be rejected before any database write.
 */
export const RECOVERY_PURPOSE_POLICY: Readonly<Record<RecoveryPurpose, RecoveryPurposePolicy>> = {
  password_reset: {
    purpose: 'password_reset',
    allowedDomains: ['platform_principal', 'company_primary_owner'],
    mintsBearerToken: true,
    requiresCompanyId: 'domain_dependent',
    defaultTtlSeconds: 15 * 60,
    affectsCredentialVersionOnConsume: true,
    preservesMfaOnConsume: true,
    requiresSeparateMfaRecovery: true,
  },
  account_discovery: {
    purpose: 'account_discovery',
    allowedDomains: ['platform_principal'],
    mintsBearerToken: false,
    requiresCompanyId: false,
    defaultTtlSeconds: 15 * 60,
    affectsCredentialVersionOnConsume: false,
    preservesMfaOnConsume: true,
    requiresSeparateMfaRecovery: false,
  },
  mfa_recovery: {
    purpose: 'mfa_recovery',
    allowedDomains: ['platform_principal', 'company_primary_owner', 'company_employee'],
    mintsBearerToken: true,
    requiresCompanyId: 'domain_dependent',
    defaultTtlSeconds: 15 * 60,
    affectsCredentialVersionOnConsume: true,
    preservesMfaOnConsume: false,
    requiresSeparateMfaRecovery: false,
  },
  break_glass_recovery: {
    purpose: 'break_glass_recovery',
    allowedDomains: ['platform_principal'],
    /**
     * E5: mints one-time package material for CLI emission (not email delivery).
     * Hash-only persistence; raw package never stored.
     */
    mintsBearerToken: true,
    requiresCompanyId: false,
    defaultTtlSeconds: 30 * 60,
    /**
     * E5 CLI execute owns the single credentialVersion increment.
     * Package completion only establishes a permanent password.
     */
    affectsCredentialVersionOnConsume: false,
    preservesMfaOnConsume: false,
    requiresSeparateMfaRecovery: false,
  },
  employee_admin_reset: {
    purpose: 'employee_admin_reset',
    allowedDomains: ['company_employee'],
    mintsBearerToken: false,
    requiresCompanyId: true,
    defaultTtlSeconds: 24 * 60 * 60,
    affectsCredentialVersionOnConsume: true,
    preservesMfaOnConsume: true,
    requiresSeparateMfaRecovery: true,
  },
};

export type RecoveryTtlOverrides = Partial<Record<RecoveryPurpose, number>>;

export function assertRecoveryTtlSeconds(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RecoveryPolicyError('ttl_invalid', `${label} must be a finite integer`);
  }
  if (value < RECOVERY_TTL_MIN_SECONDS || value > RECOVERY_TTL_MAX_SECONDS) {
    throw new RecoveryPolicyError(
      'ttl_out_of_bounds',
      `${label} must be between ${RECOVERY_TTL_MIN_SECONDS} and ${RECOVERY_TTL_MAX_SECONDS} seconds`,
    );
  }
  return value;
}

export function resolveRecoveryTtlSeconds(
  purpose: RecoveryPurpose,
  overrides?: RecoveryTtlOverrides,
): number {
  const configured = overrides?.[purpose];
  if (configured === undefined) {
    return assertRecoveryTtlSeconds(
      RECOVERY_PURPOSE_POLICY[purpose].defaultTtlSeconds,
      `default TTL for ${purpose}`,
    );
  }
  return assertRecoveryTtlSeconds(configured, `configured TTL for ${purpose}`);
}

export function assertRecoveryTtlOverrides(overrides?: RecoveryTtlOverrides): RecoveryTtlOverrides {
  if (!overrides) return {};
  const safe: RecoveryTtlOverrides = {};
  for (const [purpose, value] of Object.entries(overrides) as Array<[RecoveryPurpose, number]>) {
    if (!(purpose in RECOVERY_PURPOSE_POLICY)) {
      throw new RecoveryPolicyError('ttl_invalid', `Unknown purpose TTL override: ${purpose}`);
    }
    safe[purpose] = assertRecoveryTtlSeconds(value, `configured TTL for ${purpose}`);
  }
  return safe;
}

export function isRecoveryPrincipalDomain(value: unknown): value is RecoveryPrincipalDomain {
  return typeof value === 'string' && (RECOVERY_PRINCIPAL_DOMAINS as readonly string[]).includes(value);
}

export function isRecoveryPurpose(value: unknown): value is RecoveryPurpose {
  return typeof value === 'string' && (RECOVERY_PURPOSES as readonly string[]).includes(value);
}

export function companyIdRequiredFor(
  domain: RecoveryPrincipalDomain,
  purpose: RecoveryPurpose,
): boolean {
  const policy = RECOVERY_PURPOSE_POLICY[purpose];
  if (policy.requiresCompanyId === true) return true;
  if (policy.requiresCompanyId === false) return false;
  return domain !== 'platform_principal';
}

export function assertRecoveryPolicyCombination(input: {
  principalDomain: RecoveryPrincipalDomain;
  purpose: RecoveryPurpose;
  companyId: string | null | undefined;
}): RecoveryPurposePolicy {
  const policy = RECOVERY_PURPOSE_POLICY[input.purpose];
  if (!policy.allowedDomains.includes(input.principalDomain)) {
    throw new RecoveryPolicyError('purpose_domain_mismatch', 'Recovery purpose is not legal for this principal domain');
  }
  const companyId = input.companyId ?? null;
  const needsCompany = companyIdRequiredFor(input.principalDomain, input.purpose);
  if (needsCompany && !companyId) {
    throw new RecoveryPolicyError('company_id_required', 'Company scope is required for this recovery domain');
  }
  if (!needsCompany && companyId) {
    throw new RecoveryPolicyError('company_id_forbidden', 'Company scope is forbidden for this recovery domain');
  }
  return policy;
}

export class RecoveryPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RecoveryPolicyError';
    this.code = code;
  }
}
