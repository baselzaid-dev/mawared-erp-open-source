/**
 * Internal recovery error/result contracts.
 * Public HTTP mappers (future E2–E5) must only expose { code, messageKey, requestId }.
 */

export const RECOVERY_EXTERNAL_ERROR_CODES = [
  'InvalidRequest',
  'RateLimited',
  'Unavailable',
] as const;
export type RecoveryExternalErrorCode = (typeof RECOVERY_EXTERNAL_ERROR_CODES)[number];

export const RECOVERY_INTERNAL_REASON_CODES = [
  'policy_rejected',
  'target_unresolved',
  'token_invalid',
  'token_expired',
  'token_consumed',
  'token_superseded',
  'token_invalidated',
  'credential_version_mismatch',
  'environment_mismatch',
  'purpose_mismatch',
  'domain_mismatch',
  'company_mismatch',
  'algorithm_mismatch',
  'rate_limited',
  'audit_rejected',
  'configuration_missing',
  'concurrent_conflict',
  'callback_failed',
] as const;
export type RecoveryInternalReasonCode = (typeof RECOVERY_INTERNAL_REASON_CODES)[number];

export interface RecoveryExternalError {
  code: RecoveryExternalErrorCode;
  messageKey: string;
  requestId: string;
}

export interface RecoveryInternalFailure {
  ok: false;
  reason: RecoveryInternalReasonCode;
  /** Bounded machine detail for sanitized audit only — never for public responses. */
  detailCode?: string;
}

export interface RecoverySuccess<T> {
  ok: true;
  value: T;
}

export type RecoveryResult<T> = RecoverySuccess<T> | RecoveryInternalFailure;

export function recoveryExternalError(
  code: RecoveryExternalErrorCode,
  messageKey: string,
  requestId: string,
): RecoveryExternalError {
  return { code, messageKey, requestId };
}

export function mapInternalReasonToExternal(
  reason: RecoveryInternalReasonCode,
  requestId: string,
): RecoveryExternalError {
  if (reason === 'rate_limited') {
    return recoveryExternalError('RateLimited', 'platform.recovery.rate_limited', requestId);
  }
  if (reason === 'configuration_missing') {
    return recoveryExternalError('Unavailable', 'platform.recovery.unavailable', requestId);
  }
  return recoveryExternalError('InvalidRequest', 'platform.recovery.invalid_or_expired', requestId);
}
