import { describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import {
  decryptMfaSecret,
  encryptMfaSecret,
  generateBackupCodes,
  hashBackupCodes,
  matchingBackupCodeIndex,
  MfaConfigurationError,
  verifyTotp,
} from '../src/mfa';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('MFA cryptographic helpers', () => {
  it('encrypts TOTP secrets with authenticated encryption', () => {
    const encrypted = encryptMfaSecret('JBSWY3DPEHPK3PXP', KEY);
    expect(encrypted).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptMfaSecret(encrypted, KEY)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decryptMfaSecret(encrypted, Buffer.alloc(32, 8).toString('base64')))
      .toThrow(MfaConfigurationError);
  });

  it('validates a standards-based six-digit TOTP within the bounded window', () => {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const timestamp = Date.UTC(2026, 6, 21, 1, 0, 0);
    const token = new OTPAuth.TOTP({
      issuer: 'Mawared',
      label: 'test',
      secret: OTPAuth.Secret.fromBase32(secret),
      digits: 6,
      period: 30,
    }).generate({ timestamp });

    const result = verifyTotp(secret, token, timestamp);
    expect(result.valid).toBe(true);
    expect(result.timeStep).toBe(BigInt(Math.floor(timestamp / 30_000)));
    expect(verifyTotp(secret, '000000', timestamp).valid).toBe(false);
  });

  it('hashes ten backup codes and identifies only the matching code', async () => {
    const codes = generateBackupCodes();
    const hashes = await hashBackupCodes(codes);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(hashes.join(' ')).not.toContain(codes[0]);
    expect(await matchingBackupCodeIndex(codes[3], hashes)).toBe(3);
    expect(await matchingBackupCodeIndex('FFFFF-FFFFF', hashes)).toBe(-1);
  });
});
