import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import * as OTPAuth from 'otpauth';

export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MFA_MAX_CHALLENGE_ATTEMPTS = 5;
export const MFA_LOCKOUT_MS = 15 * 60 * 1000;
export const MFA_BACKUP_CODE_COUNT = 10;
export const MFA_TOTP_PERIOD_SECONDS = 30;

export class MfaConfigurationError extends Error {
  constructor() {
    super('MFA encryption is unavailable');
  }
}

export class MfaRateLimitError extends Error {
  constructor() {
    super('MFA verification is temporarily locked');
  }
}

const encryptionKey = (encoded?: string): Buffer => {
  const raw = encoded?.trim();
  if (!raw) throw new MfaConfigurationError();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new MfaConfigurationError();
  return key;
};

export function assertMfaEncryptionKey(encodedKey?: string): void {
  encryptionKey(encodedKey);
}

export function encryptMfaSecret(secret: string, encodedKey?: string): string {
  const key = encryptionKey(encodedKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((value) => value.toString('base64url')).join('.');
}

export function decryptMfaSecret(ciphertext: string, encodedKey?: string): string {
  const key = encryptionKey(encodedKey);
  const parts = ciphertext.split('.');
  if (parts.length !== 3) throw new MfaConfigurationError();
  try {
    const [iv, tag, encrypted] = parts.map((value) => Buffer.from(value, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new MfaConfigurationError();
  }
}

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function totpUri(secret: string, label: string): string {
  return new OTPAuth.TOTP({
    issuer: 'Mawared',
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: MFA_TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).toString();
}

export function verifyTotp(
  secret: string,
  token: string,
  timestamp: number = Date.now(),
): { valid: boolean; timeStep: bigint | null } {
  const normalized = token.trim();
  if (!/^\d{6}$/.test(normalized)) return { valid: false, timeStep: null };
  const totp = new OTPAuth.TOTP({
    issuer: 'Mawared',
    label: 'Mawared',
    algorithm: 'SHA1',
    digits: 6,
    period: MFA_TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  const delta = totp.validate({ token: normalized, timestamp, window: 1 });
  if (delta == null) return { valid: false, timeStep: null };
  return {
    valid: true,
    timeStep: BigInt(totp.counter({ timestamp }) + delta),
  };
}

export function createMfaChallenge(): {
  token: string;
  tokenHash: string;
  expiresAt: Date;
} {
  const token = crypto.randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS),
  };
}

export function hashMfaChallenge(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateBackupCodes(): string[] {
  return Array.from({ length: MFA_BACKUP_CODE_COUNT }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export async function hashBackupCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => bcrypt.hash(normalizeBackupCode(code), 10)));
}

export async function matchingBackupCodeIndex(
  code: string,
  hashes: string[],
): Promise<number> {
  const normalized = normalizeBackupCode(code);
  if (!/^[A-F0-9]{10}$/.test(normalized)) return -1;
  for (let index = 0; index < hashes.length; index += 1) {
    if (await bcrypt.compare(normalized, hashes[index])) return index;
  }
  return -1;
}

export function normalizeBackupCode(value: string): string {
  return value.trim().replace(/[-\s]/g, '').toUpperCase();
}

export function parseBackupCodeHashes(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}
