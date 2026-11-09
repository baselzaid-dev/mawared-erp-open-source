import crypto from 'node:crypto';
import util from 'node:util';
import bcrypt from 'bcrypt';

/** Temporary credential lifetime after create/reset (hours). */
export const TEMPORARY_PASSWORD_TTL_HOURS = 24;

/** Public one-time credential delivery DTO — never includes hash. */
export type OneTimeCredentialDto = {
  temporaryPassword: string;
  mustChangePassword: true;
  expiresAt: string;
  credentialVersion: number;
};

const SECRET_REDACTED = '[OneTimePasswordSecret]';

/**
 * Transient temporary-password wrapper that resists accidental JSON / inspect leaks.
 * Reveal only at the final HTTP response boundary.
 */
export class OneTimePasswordSecret {
  readonly #value: string;

  constructor(value: string) {
    if (!value || typeof value !== 'string') {
      throw new Error('OneTimePasswordSecret requires a non-empty string');
    }
    this.#value = value;
  }

  /** Explicit unwrap for the success-response boundary only. */
  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return SECRET_REDACTED;
  }

  toString(): string {
    return SECRET_REDACTED;
  }

  [util.inspect.custom](): string {
    return SECRET_REDACTED;
  }
}

/**
 * Generate a high-entropy one-time password for create/reset flows.
 * Returned wrapper must leave the process only once via the HTTP response DTO.
 */
export function generateTemporaryPassword(): OneTimePasswordSecret {
  // 18 bytes -> 24 base64url chars; mixed alphabet without ambiguous padding.
  return new OneTimePasswordSecret(crypto.randomBytes(18).toString('base64url'));
}

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, 10);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

export function temporaryPasswordExpiresAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + TEMPORARY_PASSWORD_TTL_HOURS * 60 * 60 * 1000);
}

/** New permanent passwords must meet this floor (no complexity invention beyond length). */
export const NEW_PASSWORD_MIN_LENGTH = 10;
export const NEW_PASSWORD_MAX_LENGTH = 128;

export function assertNewPasswordPolicy(password: string): string | null {
  const value = password ?? '';
  if (value.length < NEW_PASSWORD_MIN_LENGTH) {
    return 'password.too_short';
  }
  if (value.length > NEW_PASSWORD_MAX_LENGTH) {
    return 'password.too_long';
  }
  if (/\s/.test(value)) {
    return 'password.contains_whitespace';
  }
  return null;
}

export function shapeOneTimeCredentialDto(
  temporaryPassword: OneTimePasswordSecret | string,
  credentialVersion: number,
  expiresAt: Date,
): OneTimeCredentialDto {
  const value = typeof temporaryPassword === 'string'
    ? temporaryPassword
    : temporaryPassword.reveal();
  return {
    temporaryPassword: value,
    mustChangePassword: true,
    expiresAt: expiresAt.toISOString(),
    credentialVersion,
  };
}
