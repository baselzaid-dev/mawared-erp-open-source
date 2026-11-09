import { describe, expect, it } from 'vitest';
import {
  RECOVERY_PURPOSE_POLICY,
  RECOVERY_TTL_MAX_SECONDS,
  RECOVERY_TTL_MIN_SECONDS,
  assertRecoveryPolicyCombination,
  assertRecoveryTtlOverrides,
  assertRecoveryTtlSeconds,
  companyIdRequiredFor,
  resolveRecoveryTtlSeconds,
  RecoveryPolicyError,
} from '../src/credentialRecovery/contracts';

describe('credential recovery policy matrix', () => {
  it('documents legal domain/purpose combinations', () => {
    expect(RECOVERY_PURPOSE_POLICY.password_reset.allowedDomains).toEqual([
      'platform_principal',
      'company_primary_owner',
    ]);
    expect(RECOVERY_PURPOSE_POLICY.account_discovery.mintsBearerToken).toBe(false);
    expect(RECOVERY_PURPOSE_POLICY.password_reset.mintsBearerToken).toBe(true);
    expect(RECOVERY_PURPOSE_POLICY.password_reset.preservesMfaOnConsume).toBe(true);
    expect(RECOVERY_PURPOSE_POLICY.mfa_recovery.preservesMfaOnConsume).toBe(false);
    expect(RECOVERY_PURPOSE_POLICY.password_reset.defaultTtlSeconds).toBe(15 * 60);
    expect(RECOVERY_PURPOSE_POLICY.password_reset.affectsCredentialVersionOnConsume).toBe(true);
    expect(RECOVERY_PURPOSE_POLICY.break_glass_recovery.mintsBearerToken).toBe(true);
    expect(RECOVERY_PURPOSE_POLICY.break_glass_recovery.affectsCredentialVersionOnConsume).toBe(false);
  });

  it('uses server-owned TTL defaults and validates configuration bounds', () => {
    expect(resolveRecoveryTtlSeconds('password_reset')).toBe(15 * 60);
    expect(resolveRecoveryTtlSeconds('password_reset', { password_reset: 120 })).toBe(120);
    expect(assertRecoveryTtlSeconds(RECOVERY_TTL_MIN_SECONDS, 'min')).toBe(RECOVERY_TTL_MIN_SECONDS);
    expect(assertRecoveryTtlSeconds(RECOVERY_TTL_MAX_SECONDS, 'max')).toBe(RECOVERY_TTL_MAX_SECONDS);
    expect(() => assertRecoveryTtlSeconds(0, 'zero')).toThrow(RecoveryPolicyError);
    expect(() => assertRecoveryTtlSeconds(-1, 'neg')).toThrow(RecoveryPolicyError);
    expect(() => assertRecoveryTtlSeconds(Number.NaN, 'nan')).toThrow(RecoveryPolicyError);
    expect(() => assertRecoveryTtlSeconds(Number.POSITIVE_INFINITY, 'inf')).toThrow(RecoveryPolicyError);
    expect(() => assertRecoveryTtlSeconds(90.5, 'float')).toThrow(RecoveryPolicyError);
    expect(() => assertRecoveryTtlSeconds(RECOVERY_TTL_MAX_SECONDS + 1, 'long')).toThrow(RecoveryPolicyError);
    expect(() => assertRecoveryTtlOverrides({ password_reset: 0 })).toThrow(RecoveryPolicyError);
  });

  it('requires companyId for company domains and forbids it for platform', () => {
    expect(companyIdRequiredFor('platform_principal', 'password_reset')).toBe(false);
    expect(companyIdRequiredFor('company_primary_owner', 'password_reset')).toBe(true);
    expect(companyIdRequiredFor('company_employee', 'employee_admin_reset')).toBe(true);
  });

  it('rejects illegal purpose/domain combinations before writes', () => {
    expect(() =>
      assertRecoveryPolicyCombination({
        principalDomain: 'platform_principal',
        purpose: 'employee_admin_reset',
        companyId: null,
      }),
    ).toThrow(RecoveryPolicyError);

    expect(() =>
      assertRecoveryPolicyCombination({
        principalDomain: 'platform_principal',
        purpose: 'password_reset',
        companyId: 'c1',
      }),
    ).toThrow(/forbidden/i);

    expect(() =>
      assertRecoveryPolicyCombination({
        principalDomain: 'company_employee',
        purpose: 'employee_admin_reset',
        companyId: null,
      }),
    ).toThrow(/required/i);
  });

  it('accepts legal combinations', () => {
    expect(
      assertRecoveryPolicyCombination({
        principalDomain: 'platform_principal',
        purpose: 'password_reset',
        companyId: null,
      }).mintsBearerToken,
    ).toBe(true);
  });
});
