import crypto from 'node:crypto';
import {
  RECOVERY_ENVIRONMENT_CLASSES,
  RECOVERY_TOKEN_HASH_ALGORITHM,
  RECOVERY_TOKEN_MIN_ENTROPY_BITS,
  RECOVERY_TOKEN_VERSION,
  type RecoveryEnvironmentClass,
  type RecoveryPrincipalDomain,
  type RecoveryPurpose,
  type RecoveryTokenHashAlgorithm,
} from './contracts';

/** Dedicated recovery hashing secret — never reuse JWT/MFA secrets. */
export const RECOVERY_TOKEN_PEPPER_ENV = 'CREDENTIAL_RECOVERY_TOKEN_PEPPER';
export const RECOVERY_RATE_LIMIT_PEPPER_ENV = 'CREDENTIAL_RECOVERY_RATE_LIMIT_PEPPER';
export const RECOVERY_ENVIRONMENT_BINDING_ENV = 'CREDENTIAL_RECOVERY_ENVIRONMENT_BINDING';

const SECRET_INSPECT = '[CredentialRecoverySecret]';
const SOURCE_BUCKET_HASH_RE = /^recovery-src-v1:[a-f0-9]{64}$/;
const FORBIDDEN_SOURCE_SHAPE =
  /(?:@|https?:\/\/|postgres(?:ql)?:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f:]{2,}:[0-9a-f:]{2,}\b|hmac-sha256-v1:|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.|^\+?\d{7,}$)/i;

const SECRET_INSPECT_SOURCE = '[RecoverySourceBucketHash]';

/**
 * Transient secret wrapper that resists accidental JSON/log serialization.
 * Raw material exists only in process memory until delivery/consume.
 */
export class CredentialRecoverySecret {
  readonly #value: string;

  constructor(value: string) {
    if (!value || typeof value !== 'string') {
      throw new Error('CredentialRecoverySecret requires a non-empty string');
    }
    this.#value = value;
  }

  /** Explicit reveal for delivery/consume call sites only. */
  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return SECRET_INSPECT;
  }

  toString(): string {
    return SECRET_INSPECT;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return SECRET_INSPECT;
  }
}

/**
 * Runtime-validated keyed source/network risk hash.
 * Never accept raw email/IP/phone/URL/token as this value.
 */
export class RecoverySourceBucketHash {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static fromValidated(value: string): RecoverySourceBucketHash {
    return new RecoverySourceBucketHash(value);
  }

  toString(): string {
    return this.#value;
  }

  valueOf(): string {
    return this.#value;
  }

  toJSON(): string {
    return SECRET_INSPECT_SOURCE;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return SECRET_INSPECT_SOURCE;
  }
}

export interface RecoveryTokenMaterial {
  rawToken: CredentialRecoverySecret;
  tokenHash: string;
  tokenHashAlgorithm: RecoveryTokenHashAlgorithm;
  entropyBits: number;
}

export interface RecoveryHashContext {
  principalDomain: RecoveryPrincipalDomain;
  purpose: RecoveryPurpose;
  environmentBinding: string;
}

/**
 * E1 V1-only crypto config.
 * Changing CREDENTIAL_RECOVERY_TOKEN_PEPPER intentionally invalidates outstanding
 * recovery digests. Online multi-version key rotation is not supported in E1.
 */
export interface RecoveryCryptoConfig {
  tokenPepper: string;
}

export function assertRecoveryCryptoConfig(config: RecoveryCryptoConfig | null | undefined): RecoveryCryptoConfig {
  if (!config?.tokenPepper || typeof config.tokenPepper !== 'string') {
    throw new RecoveryCryptoConfigurationError(
      `${RECOVERY_TOKEN_PEPPER_ENV} is required to instantiate credential recovery crypto`,
    );
  }
  const pepper = config.tokenPepper.trim();
  if (pepper.length < 32) {
    throw new RecoveryCryptoConfigurationError(
      `${RECOVERY_TOKEN_PEPPER_ENV} must be at least 32 characters`,
    );
  }
  return { tokenPepper: pepper };
}

export class RecoveryCryptoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryCryptoConfigurationError';
  }
}

export class RecoverySourceHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoverySourceHashError';
  }
}

/** Opaque CSPRNG token: 32 bytes = 256 bits entropy, base64url transport. */
export function generateRecoveryToken(): { rawToken: CredentialRecoverySecret; entropyBits: number } {
  const bytes = crypto.randomBytes(RECOVERY_TOKEN_MIN_ENTROPY_BITS / 8);
  return {
    rawToken: new CredentialRecoverySecret(bytes.toString('base64url')),
    entropyBits: bytes.length * 8,
  };
}

export function hashRecoveryToken(
  rawToken: string | CredentialRecoverySecret,
  context: RecoveryHashContext,
  config: RecoveryCryptoConfig,
): { tokenHash: string; tokenHashAlgorithm: RecoveryTokenHashAlgorithm } {
  const safe = assertRecoveryCryptoConfig(config);
  const token = typeof rawToken === 'string' ? rawToken : rawToken.reveal();
  const material = [
    RECOVERY_TOKEN_VERSION,
    context.principalDomain,
    context.purpose,
    context.environmentBinding,
    token,
  ].join('\u0000');
  const digest = crypto
    .createHmac('sha256', safe.tokenPepper)
    .update(material, 'utf8')
    .digest('hex');
  return {
    tokenHash: `${RECOVERY_TOKEN_HASH_ALGORITHM}:${digest}`,
    tokenHashAlgorithm: RECOVERY_TOKEN_HASH_ALGORITHM,
  };
}

export function mintRecoveryTokenMaterial(
  context: RecoveryHashContext,
  config: RecoveryCryptoConfig,
): RecoveryTokenMaterial {
  const { rawToken, entropyBits } = generateRecoveryToken();
  const hashed = hashRecoveryToken(rawToken, context, config);
  return {
    rawToken,
    tokenHash: hashed.tokenHash,
    tokenHashAlgorithm: hashed.tokenHashAlgorithm,
    entropyBits,
  };
}

export function parseEnvironmentBinding(raw: string): {
  environmentClass: RecoveryEnvironmentClass;
  fingerprint: string;
  binding: string;
} {
  const trimmed = raw.trim();
  const match = /^([a-z]+):([A-Za-z0-9_-]{8,128})$/.exec(trimmed);
  if (!match) {
    throw new RecoveryCryptoConfigurationError(
      `${RECOVERY_ENVIRONMENT_BINDING_ENV} must be <class>:<fingerprint> with an approved class`,
    );
  }
  const environmentClass = match[1] as RecoveryEnvironmentClass;
  if (!(RECOVERY_ENVIRONMENT_CLASSES as readonly string[]).includes(environmentClass)) {
    throw new RecoveryCryptoConfigurationError(
      `${RECOVERY_ENVIRONMENT_BINDING_ENV} class must be one of ${RECOVERY_ENVIRONMENT_CLASSES.join(',')}`,
    );
  }
  return {
    environmentClass,
    fingerprint: match[2],
    binding: `${environmentClass}:${match[2]}`,
  };
}

export function resolveEnvironmentBinding(injected?: string): string {
  const raw = injected ?? process.env[RECOVERY_ENVIRONMENT_BINDING_ENV];
  if (!raw) {
    throw new RecoveryCryptoConfigurationError(
      `${RECOVERY_ENVIRONMENT_BINDING_ENV} is required when using credential recovery`,
    );
  }
  return parseEnvironmentBinding(raw).binding;
}

export function hashIdentifierForRateLimit(
  value: string,
  pepper: string,
  surface: string,
  dimension: string,
): string {
  if (!pepper || pepper.length < 32) {
    throw new RecoveryCryptoConfigurationError(
      `${RECOVERY_RATE_LIMIT_PEPPER_ENV} must be at least 32 characters`,
    );
  }
  return crypto
    .createHmac('sha256', pepper)
    .update(`recovery-rl-v1\u0000${surface}\u0000${dimension}\u0000${value}`, 'utf8')
    .digest('hex');
}

/** Create a keyed source-bucket hash from a raw risk identifier. */
export function createSourceBucketHash(rawIdentifier: string, pepper: string): RecoverySourceBucketHash {
  if (!rawIdentifier || typeof rawIdentifier !== 'string') {
    throw new RecoverySourceHashError('source identifier is required');
  }
  if (!pepper || pepper.length < 32) {
    throw new RecoveryCryptoConfigurationError(
      `${RECOVERY_RATE_LIMIT_PEPPER_ENV} must be at least 32 characters`,
    );
  }
  const digest = crypto
    .createHmac('sha256', pepper)
    .update(`recovery-src-v1\u0000${rawIdentifier}`, 'utf8')
    .digest('hex');
  return RecoverySourceBucketHash.fromValidated(`recovery-src-v1:${digest}`);
}

/**
 * Accept only a previously keyed source-bucket hash.
 * Rejects raw email/IP/phone/URL/token/arbitrary text.
 */
export function parseSourceBucketHash(value: unknown): RecoverySourceBucketHash {
  if (typeof value !== 'string') {
    throw new RecoverySourceHashError('sourceBucketHash must be a keyed recovery-src-v1 hash');
  }
  const trimmed = value.trim();
  if (!SOURCE_BUCKET_HASH_RE.test(trimmed) || FORBIDDEN_SOURCE_SHAPE.test(trimmed)) {
    throw new RecoverySourceHashError('sourceBucketHash must be a keyed recovery-src-v1 hash');
  }
  return RecoverySourceBucketHash.fromValidated(trimmed);
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
