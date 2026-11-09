/**
 * Startup validation of the runtime configuration contract.
 *
 * Before this module the process warned on stderr about missing security
 * material and then started anyway. The individual subsystems do fail closed
 * at call time (MFA and Platform auth both refuse to operate without their
 * keys), so nothing became *insecure* — but the instance still reported itself
 * healthy and ready while whole subsystems were dead. That is a silent partial
 * outage, and it is exactly the class of failure a production readiness gate
 * is supposed to catch at boot.
 *
 * In production a missing or malformed required variable is an error and the
 * process refuses to start. Outside production every finding is a warning, so
 * local and test workflows are never blocked.
 *
 * Nothing here ever reports a configuration VALUE — only the variable name and
 * the nature of the problem. Startup diagnostics are routinely pasted into
 * tickets and chat.
 */

export interface RuntimeConfigIssue {
  /** Environment variable name. Never accompanied by its value. */
  variable: string;
  problem: string;
}

export interface RuntimeConfigReport {
  errors: RuntimeConfigIssue[];
  warnings: RuntimeConfigIssue[];
}

export type RuntimeEnv = Record<string, string | undefined>;

/**
 * Deployment tier, which is deliberately *not* the same thing as `NODE_ENV`.
 *
 * Staging runs with `NODE_ENV=production` (it is a production-mode build) but
 * declares `MAWARED_ENV=staging`. Enforcement that should only bite the real
 * production tier therefore keys on `MAWARED_ENV`, not on `NODE_ENV` — see
 * `render.yaml`, which sets exactly that pair.
 *
 * An unset `MAWARED_ENV` under `NODE_ENV=production` resolves to `production`:
 * the stricter reading is the safe default when the tier is unstated.
 */
export type DeploymentTier = 'development' | 'staging' | 'production';

export function resolveDeploymentTier(
  env: RuntimeEnv,
  isProduction: boolean,
): DeploymentTier {
  const declared = env.MAWARED_ENV?.trim().toLowerCase();
  if (declared === 'production') return 'production';
  if (declared === 'staging') return 'staging';
  return isProduction ? 'production' : 'development';
}

/** Minimum entropy for a signing secret, in bytes. */
const MIN_SECRET_BYTES = 32;
/** AES-256-GCM key length, in bytes. Mirrors `encryptionKey()` in `mfa.ts`. */
const MFA_KEY_BYTES = 32;

function read(env: RuntimeEnv, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validate the shape of a signing secret that is present.
 *
 * Presence is checked by the caller, because *whether* a given secret is
 * required depends on the deployment tier — but a secret that has been
 * supplied must be strong at every tier.
 */
function checkSigningSecretShape(
  name: string,
  value: string | undefined,
  issues: RuntimeConfigIssue[],
): void {
  if (!value) return;
  if (Buffer.byteLength(value, 'utf8') < MIN_SECRET_BYTES) {
    issues.push({
      variable: name,
      problem: `must be at least ${MIN_SECRET_BYTES} bytes`,
    });
  }
}

/**
 * A CORS entry must be a bare scheme+host+port origin. Anything carrying a
 * path, query or fragment silently fails to match a browser `Origin` header,
 * which produces a confusing "CORS is configured but still blocked" incident.
 */
function checkCorsOrigin(entry: string, issues: RuntimeConfigIssue[], requireHttps: boolean): void {
  if (entry === '*') {
    issues.push({
      variable: 'CORS_ORIGINS',
      problem: 'must not contain the wildcard "*"',
    });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(entry);
  } catch {
    issues.push({
      variable: 'CORS_ORIGINS',
      problem: 'contains an entry that is not a valid absolute origin',
    });
    return;
  }
  if (parsed.origin !== entry.replace(/\/$/, '')) {
    issues.push({
      variable: 'CORS_ORIGINS',
      problem: 'entries must be bare origins with no path, query, or fragment',
    });
    return;
  }
  if (requireHttps && parsed.protocol !== 'https:') {
    issues.push({
      variable: 'CORS_ORIGINS',
      problem: 'entries should use https in production',
    });
  }
}

/**
 * Inspect the runtime environment against the configuration contract.
 *
 * Pure: takes an env bag, returns findings. Never reads `process.env`, never
 * throws, never logs.
 */
export function inspectRuntimeConfig(
  env: RuntimeEnv,
  options: { isProduction: boolean },
): RuntimeConfigReport {
  const tier = resolveDeploymentTier(env, options.isProduction);

  /** Required on every deployed tier — nothing works without these. */
  const core: RuntimeConfigIssue[] = [];
  /**
   * Required on the production tier only. Staging deliberately runs without
   * these today (`render.yaml` does not declare them), so demanding them there
   * would block a staging deploy without improving production safety. The
   * affected subsystems already fail closed at call time, so the risk they
   * carry is a silent partial outage rather than an insecure fallback.
   */
  const productionOnly: RuntimeConfigIssue[] = [];
  const warnings: RuntimeConfigIssue[] = [];

  if (!read(env, 'DATABASE_URL')) {
    core.push({ variable: 'DATABASE_URL', problem: 'is required but is missing or empty' });
  }

  const jwtSecret = read(env, 'JWT_SECRET');
  if (!jwtSecret) {
    core.push({ variable: 'JWT_SECRET', problem: 'is required but is missing or empty' });
  }
  checkSigningSecretShape('JWT_SECRET', jwtSecret, core);

  const platformSecret = read(env, 'PLATFORM_JWT_SECRET');
  if (!platformSecret) {
    productionOnly.push({
      variable: 'PLATFORM_JWT_SECRET',
      problem: 'is required in production but is missing or empty; '
        + 'Platform control-plane authentication will refuse to operate',
    });
  }
  // A supplied secret must be strong and distinct on every tier.
  checkSigningSecretShape('PLATFORM_JWT_SECRET', platformSecret, core);
  if (jwtSecret && platformSecret && jwtSecret === platformSecret) {
    core.push({
      variable: 'PLATFORM_JWT_SECRET',
      problem: 'must not be identical to JWT_SECRET',
    });
  }

  const mfaKey = read(env, 'MFA_ENCRYPTION_KEY');
  if (!mfaKey) {
    productionOnly.push({
      variable: 'MFA_ENCRYPTION_KEY',
      problem: 'is required in production but is missing or empty; '
        + 'protected-owner authentication will refuse to operate',
    });
  } else if (Buffer.from(mfaKey, 'base64').length !== MFA_KEY_BYTES) {
    core.push({
      variable: 'MFA_ENCRYPTION_KEY',
      problem: `must be base64 that decodes to exactly ${MFA_KEY_BYTES} bytes`,
    });
  }

  const corsRaw = read(env, 'CORS_ORIGINS');
  if (!corsRaw) {
    // Not an error: deny-by-default is the correct posture, and an
    // API-only deployment with no browser client is a legitimate setup.
    warnings.push({
      variable: 'CORS_ORIGINS',
      problem: 'is not set, so all cross-origin browser access is denied',
    });
  } else {
    const entries = corsRaw.split(',').map((entry) => entry.trim()).filter(Boolean);
    if (entries.length === 0) {
      warnings.push({
        variable: 'CORS_ORIGINS',
        problem: 'is set but contains no usable origin',
      });
    }
    for (const entry of entries) {
      checkCorsOrigin(entry, core, tier !== 'development');
    }
  }

  if (tier === 'development') {
    // Local and test workflows must never be blocked, so findings are demoted
    // rather than dropped — the operator still sees every one of them.
    return { errors: [], warnings: [...core, ...productionOnly, ...warnings] };
  }
  if (tier === 'staging') {
    return { errors: core, warnings: [...productionOnly, ...warnings] };
  }
  return { errors: [...core, ...productionOnly], warnings };
}

/** Render findings as stable, value-free log lines. */
export function formatRuntimeConfigIssues(issues: RuntimeConfigIssue[]): string[] {
  return issues.map((issue) => `${issue.variable} ${issue.problem}`);
}

export class RuntimeConfigError extends Error {
  constructor(readonly issues: RuntimeConfigIssue[]) {
    super(
      `Runtime configuration is invalid: ${formatRuntimeConfigIssues(issues).join('; ')}`,
    );
    this.name = 'RuntimeConfigError';
  }
}

/**
 * Validate and report. Throws {@link RuntimeConfigError} when production
 * configuration is invalid, so the instance never becomes routable.
 */
export function assertRuntimeConfig(
  env: RuntimeEnv,
  options: {
    isProduction: boolean;
    logger: { info(event: string, fields?: Record<string, unknown>): void;
      warn(event: string, fields?: Record<string, unknown>): void;
      error(event: string, fields?: Record<string, unknown>): void };
  },
): RuntimeConfigReport {
  const tier = resolveDeploymentTier(env, options.isProduction);
  const report = inspectRuntimeConfig(env, { isProduction: options.isProduction });

  if (report.warnings.length > 0) {
    options.logger.warn('startup.config_warnings', {
      deploymentTier: tier,
      issues: formatRuntimeConfigIssues(report.warnings),
    });
  }
  if (report.errors.length > 0) {
    options.logger.error('startup.config_invalid', {
      deploymentTier: tier,
      issues: formatRuntimeConfigIssues(report.errors),
    });
    throw new RuntimeConfigError(report.errors);
  }
  options.logger.info('startup.config_validated', {
    deploymentTier: tier,
    warningCount: report.warnings.length,
  });
  return report;
}
