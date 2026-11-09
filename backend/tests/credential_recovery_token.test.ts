import { describe, expect, it } from 'vitest';
import {
  CredentialRecoverySecret,
  RECOVERY_TOKEN_PEPPER_ENV,
  createSourceBucketHash,
  generateRecoveryToken,
  hashRecoveryToken,
  mintRecoveryTokenMaterial,
  parseEnvironmentBinding,
  parseSourceBucketHash,
  assertRecoveryCryptoConfig,
} from '../src/credentialRecovery/tokenCrypto';
import { inspect } from 'node:util';

const TEST_PEPPER = 'test-recovery-token-pepper-32chars-min!!';
const CONTEXT = {
  principalDomain: 'platform_principal' as const,
  purpose: 'password_reset' as const,
  environmentBinding: 'test:fixture-fingerprint',
};

describe('credential recovery token crypto', () => {
  it('generates opaque base64url tokens with at least 256 bits entropy', () => {
    const a = generateRecoveryToken();
    const b = generateRecoveryToken();
    expect(a.entropyBits).toBeGreaterThanOrEqual(256);
    expect(a.rawToken.reveal()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.rawToken.reveal()).not.toEqual(b.rawToken.reveal());
    expect(a.rawToken.reveal()).not.toContain('.');
  });

  it('stores only keyed digest material and binds context (V1-only, no keyVersion selector)', () => {
    const minted = mintRecoveryTokenMaterial(CONTEXT, { tokenPepper: TEST_PEPPER });
    expect(minted.tokenHash.startsWith('hmac-sha256-v1:')).toBe(true);
    expect(minted.tokenHash).not.toContain(minted.rawToken.reveal());
    expect(minted).not.toHaveProperty('keyVersion');

    const wrongPurpose = hashRecoveryToken(minted.rawToken, {
      ...CONTEXT,
      purpose: 'mfa_recovery',
    }, { tokenPepper: TEST_PEPPER });
    expect(wrongPurpose.tokenHash).not.toEqual(minted.tokenHash);

    const wrongEnv = hashRecoveryToken(minted.rawToken, {
      ...CONTEXT,
      environmentBinding: 'staging:other-fingerprint',
    }, { tokenPepper: TEST_PEPPER });
    expect(wrongEnv.tokenHash).not.toEqual(minted.tokenHash);
  });

  it('fails closed without dedicated recovery pepper', () => {
    expect(() => assertRecoveryCryptoConfig({ tokenPepper: '' })).toThrow(RECOVERY_TOKEN_PEPPER_ENV);
    expect(() => assertRecoveryCryptoConfig({ tokenPepper: 'short' })).toThrow(/32/);
  });

  it('hides raw secret from JSON and inspect', () => {
    const secret = new CredentialRecoverySecret('super-secret-token-value');
    expect(JSON.stringify({ secret })).toContain('[CredentialRecoverySecret]');
    expect(JSON.stringify({ secret })).not.toContain('super-secret-token-value');
    expect(inspect(secret)).toContain('[CredentialRecoverySecret]');
    expect(String(secret)).toBe('[CredentialRecoverySecret]');
  });

  it('parses approved environment bindings only', () => {
    expect(parseEnvironmentBinding('local:abc12345').binding).toBe('local:abc12345');
    expect(() => parseEnvironmentBinding('prod:abc12345')).toThrow(/class must be one of/);
    expect(() => parseEnvironmentBinding('local:short')).toThrow();
  });

  it('accepts only keyed recovery-src-v1 source bucket hashes', () => {
    const valid = createSourceBucketHash('10.0.0.1', TEST_PEPPER);
    expect(parseSourceBucketHash(valid.toString()).toString()).toBe(valid.toString());
    expect(() => parseSourceBucketHash('10.0.0.1')).toThrow();
    expect(() => parseSourceBucketHash('2001:db8::1')).toThrow();
    expect(() => parseSourceBucketHash('owner@example.test')).toThrow();
    expect(() => parseSourceBucketHash('+15551234567')).toThrow();
    expect(() => parseSourceBucketHash('https://example.test/reset')).toThrow();
    expect(() => parseSourceBucketHash('hmac-sha256-v1:' + 'a'.repeat(64))).toThrow();
    expect(() => parseSourceBucketHash('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb')).toThrow();
    expect(() => parseSourceBucketHash('just-some-arbitrary-unbounded-text-value')).toThrow();
  });
});
