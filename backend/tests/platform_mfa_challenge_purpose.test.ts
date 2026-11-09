import { describe, expect, it } from 'vitest';
import {
  mintVersionBoundPlatformMfaChallenge,
  parseVersionBoundPlatformMfaChallengeToken,
} from '../src/platformAuth';
import { hashMfaChallenge } from '../src/mfa';

describe('Platform MFA challenge version binding', () => {
  it('mints hash-bound tokens that embed credentialVersion', () => {
    const minted = mintVersionBoundPlatformMfaChallenge('login', 3);
    expect(minted.purpose).toBe('login');
    expect(minted.credentialVersion).toBe(3);
    expect(minted.tokenHash).toBe(hashMfaChallenge(minted.token));
    expect(parseVersionBoundPlatformMfaChallengeToken(minted.token)).toEqual({
      kind: 'login',
      credentialVersion: 3,
    });

    const enroll = mintVersionBoundPlatformMfaChallenge('enroll', 1);
    expect(enroll.purpose).toBe('enroll');
    expect(parseVersionBoundPlatformMfaChallengeToken(enroll.token)).toEqual({
      kind: 'enroll',
      credentialVersion: 1,
    });
  });

  it('rejects non-positive credentialVersion at mint time', () => {
    expect(() => mintVersionBoundPlatformMfaChallenge('login', 0)).toThrow();
    expect(() => mintVersionBoundPlatformMfaChallenge('login', -1)).toThrow();
    expect(() => mintVersionBoundPlatformMfaChallenge('login', 1.5)).toThrow();
  });

  it('fails closed for legacy and malformed challenge tokens', () => {
    expect(parseVersionBoundPlatformMfaChallengeToken('login')).toBeNull();
    expect(parseVersionBoundPlatformMfaChallengeToken('enroll')).toBeNull();
    expect(parseVersionBoundPlatformMfaChallengeToken('v1:login:3')).toBeNull();
    expect(parseVersionBoundPlatformMfaChallengeToken('pcv1.login.0.abcdefghijabcdefghijabcdefghijabcdefghij')).toBeNull();
    expect(parseVersionBoundPlatformMfaChallengeToken('pcv1.login.01.abcdefghijabcdefghijabcdefghijabcdefghij')).toBeNull();
    expect(parseVersionBoundPlatformMfaChallengeToken('pcv1.reset.1.abcdefghijabcdefghijabcdefghijabcdefghij')).toBeNull();
    expect(parseVersionBoundPlatformMfaChallengeToken('pcv1.login.1.short')).toBeNull();
    expect(parseVersionBoundPlatformMfaChallengeToken(null)).toBeNull();
    expect(parseVersionBoundPlatformMfaChallengeToken(undefined)).toBeNull();

    // Tampering with the embedded version changes the hash lookup key.
    const minted = mintVersionBoundPlatformMfaChallenge('login', 3);
    const tampered = minted.token.replace('.3.', '.4.');
    expect(parseVersionBoundPlatformMfaChallengeToken(tampered)?.credentialVersion).toBe(4);
    expect(hashMfaChallenge(tampered)).not.toBe(minted.tokenHash);
  });
});
