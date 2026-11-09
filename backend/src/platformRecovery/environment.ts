/**
 * E5 environment resolution and fingerprint assertion.
 * --expected-environment is never a database selector.
 */

import {
  RECOVERY_ENVIRONMENT_BINDING_ENV,
  parseEnvironmentBinding,
} from '../credentialRecovery/tokenCrypto';
import {
  RECOVERY_ENVIRONMENT_CLASSES,
  type RecoveryEnvironmentClass,
} from '../credentialRecovery/contracts';

export const PLATFORM_RECOVERY_CLI_ENVIRONMENTS = [
  'development',
  'staging',
  'production',
] as const;
export type PlatformRecoveryCliEnvironment =
  (typeof PLATFORM_RECOVERY_CLI_ENVIRONMENTS)[number];

export interface ResolvedPlatformRecoveryEnvironment {
  /** CLI assertion class (development|staging|production). */
  assertedClass: PlatformRecoveryCliEnvironment;
  /** Server-resolved binding class (local|test|staging|production). */
  resolvedClass: RecoveryEnvironmentClass;
  /** Non-secret fingerprint reference (never a URL). */
  fingerprintReference: string;
  /** Full binding string class:fingerprint for recovery rows. */
  environmentBinding: string;
  /** Whether resolved class is Production. */
  isProduction: boolean;
}

export class PlatformRecoveryEnvironmentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlatformRecoveryEnvironmentError';
    this.code = code;
  }
}

/** Map CLI assertion labels onto E1 binding classes. */
export function cliEnvironmentMatchesResolved(
  asserted: PlatformRecoveryCliEnvironment,
  resolved: RecoveryEnvironmentClass,
): boolean {
  if (asserted === 'production') return resolved === 'production';
  if (asserted === 'staging') return resolved === 'staging';
  // development assertion accepts local or test fixtures only.
  return resolved === 'local' || resolved === 'test';
}

export function isPlatformRecoveryCliEnvironment(
  value: unknown,
): value is PlatformRecoveryCliEnvironment {
  return typeof value === 'string'
    && (PLATFORM_RECOVERY_CLI_ENVIRONMENTS as readonly string[]).includes(value);
}

export interface PlatformRecoveryEnvironmentResolverDeps {
  /** Injected binding override for tests. */
  environmentBinding?: string | null;
  /** Optional process env reader (tests). Never used to select a database. */
  readEnv?: (key: string) => string | undefined;
}

/**
 * Derive environment class + fingerprint from the process's configured binding.
 * Fail closed when missing, malformed, or mismatched with CLI assertion.
 */
export function resolvePlatformRecoveryEnvironment(
  asserted: PlatformRecoveryCliEnvironment,
  deps: PlatformRecoveryEnvironmentResolverDeps = {},
): ResolvedPlatformRecoveryEnvironment {
  const readEnv = deps.readEnv ?? ((key: string) => process.env[key]);
  const raw = deps.environmentBinding ?? readEnv(RECOVERY_ENVIRONMENT_BINDING_ENV);
  if (!raw || !raw.trim()) {
    throw new PlatformRecoveryEnvironmentError(
      'environment_binding_missing',
      'Recovery environment binding is not configured',
    );
  }

  let parsed: ReturnType<typeof parseEnvironmentBinding>;
  try {
    parsed = parseEnvironmentBinding(raw);
  } catch {
    throw new PlatformRecoveryEnvironmentError(
      'environment_binding_invalid',
      'Recovery environment binding is invalid',
    );
  }

  if (!(RECOVERY_ENVIRONMENT_CLASSES as readonly string[]).includes(parsed.environmentClass)) {
    throw new PlatformRecoveryEnvironmentError(
      'environment_unrecognized',
      'Resolved recovery environment class is unrecognized',
    );
  }

  // Production cannot be downgraded by CLI argument.
  if (parsed.environmentClass === 'production' && asserted !== 'production') {
    throw new PlatformRecoveryEnvironmentError(
      'environment_production_downgrade_refused',
      'Production environment cannot be asserted as non-production',
    );
  }

  if (!cliEnvironmentMatchesResolved(asserted, parsed.environmentClass)) {
    throw new PlatformRecoveryEnvironmentError(
      'environment_assertion_mismatch',
      'Expected environment does not match resolved environment fingerprint',
    );
  }

  return {
    assertedClass: asserted,
    resolvedClass: parsed.environmentClass,
    fingerprintReference: `fp:${parsed.fingerprint.slice(0, 8)}`,
    environmentBinding: parsed.binding,
    isProduction: parsed.environmentClass === 'production',
  };
}

/**
 * Local-database safety for CLI when an explicit local guard is required.
 * Never prints the URL. Rejects hosted-provider hostnames.
 */
export function assertLoopbackDatabaseUrl(raw: string | null | undefined): void {
  if (!raw) {
    throw new PlatformRecoveryEnvironmentError(
      'database_url_missing',
      'Database URL is not configured for this process',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PlatformRecoveryEnvironmentError(
      'database_url_invalid',
      'Database URL is invalid',
    );
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new PlatformRecoveryEnvironmentError(
      'database_url_invalid',
      'Database URL must be PostgreSQL',
    );
  }
  const host = url.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new PlatformRecoveryEnvironmentError(
      'database_not_loopback',
      'Platform recovery CLI refuses non-loopback database hosts in this build path',
    );
  }
  const lower = raw.toLowerCase();
  for (const indicator of [
    'supabase.co',
    'render.com',
    'neon.tech',
    'amazonaws.com',
    'azure.com',
    'digitalocean.com',
  ]) {
    if (lower.includes(indicator)) {
      throw new PlatformRecoveryEnvironmentError(
        'database_hosted_refused',
        'Platform recovery CLI refuses hosted-provider database URLs',
      );
    }
  }
}
