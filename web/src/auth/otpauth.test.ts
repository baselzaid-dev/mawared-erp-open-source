import { describe, expect, it } from 'vitest';
import { sanitizeOtpauthUri } from './otpauth';

describe('authenticator link validation', () => {
  it('allows only a single-line TOTP otpauth URI', () => {
    const safe = 'otpauth://totp/Mawared:user%40example.test?secret=ABC234&issuer=Mawared';
    expect(sanitizeOtpauthUri(safe)).toBe(safe);
    expect(sanitizeOtpauthUri('https://example.test')).toBeNull();
    expect(sanitizeOtpauthUri('otpauth://hotp/user?secret=ABC')).toBeNull();
    expect(sanitizeOtpauthUri(`${safe}\nhttps://example.test`)).toBeNull();
  });
});
