/**
 * Canonical server-side recovery-link builder (E6).
 * Audience-specific, environment-specific, HTTPS-only outside local development.
 * Built from the opaque recovery token only — never accepts client redirect URLs.
 */

export type RecoveryLinkAudience = 'platform_password_reset' | 'company_owner_password_reset';

export interface RecoveryLinkBuilderConfig {
  platformConsoleBaseUrl: string;
  companyOwnerRecoveryBaseUrl: string;
  /** When true, allow http://localhost / http://127.0.0.1 only for local development. */
  allowLocalHttp?: boolean;
  /** Extra allowlisted hostnames (lowercase). */
  allowedHosts?: readonly string[];
}

export class RecoveryLinkBuilderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RecoveryLinkBuilderError';
    this.code = code;
  }
}

const DEFAULT_PLATFORM_PATH = '/reset-password';
const DEFAULT_COMPANY_OWNER_PATH = '/owner-recovery/reset';

/** Opaque token shape aligned with E3/E4 confirm validators. */
const RESET_TOKEN_MIN = 40;
const RESET_TOKEN_MAX = 256;
const RESET_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function assertOpaqueToken(token: string): string {
  if (typeof token !== 'string' || !RESET_TOKEN_RE.test(token)) {
    throw new RecoveryLinkBuilderError('token_invalid', 'Recovery token format is invalid');
  }
  if (token.length < RESET_TOKEN_MIN || token.length > RESET_TOKEN_MAX) {
    throw new RecoveryLinkBuilderError('token_invalid', 'Recovery token length is invalid');
  }
  return token;
}

function parseAndValidateBaseUrl(
  raw: string,
  label: string,
  options: { allowLocalHttp: boolean; allowedHosts: ReadonlySet<string> },
): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new RecoveryLinkBuilderError('base_url_invalid', `${label} is not a valid URL`);
  }

  const host = url.hostname.toLowerCase();
  const isLocal = LOCAL_HOSTS.has(host);

  if (url.protocol === 'https:') {
    // ok
  } else if (url.protocol === 'http:' && options.allowLocalHttp && isLocal) {
    // local development only
  } else {
    throw new RecoveryLinkBuilderError(
      'https_required',
      `${label} must use HTTPS outside local development`,
    );
  }

  if (url.username || url.password) {
    throw new RecoveryLinkBuilderError('credentials_forbidden', `${label} must not embed credentials`);
  }

  if (options.allowedHosts.size > 0 && !options.allowedHosts.has(host) && !(options.allowLocalHttp && isLocal)) {
    throw new RecoveryLinkBuilderError('host_not_allowlisted', `${label} host is not allowlisted`);
  }

  // Strip query/hash from base — links are purpose-bound server-side.
  url.search = '';
  url.hash = '';
  return url;
}

export function createRecoveryLinkBuilder(
  config: RecoveryLinkBuilderConfig,
): {
  build(audience: RecoveryLinkAudience, rawToken: string): string;
  platformBase: URL;
  companyOwnerBase: URL;
} {
  const allowLocalHttp = Boolean(config.allowLocalHttp);
  const allowedHosts = new Set(
    (config.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean),
  );

  const platformBase = parseAndValidateBaseUrl(
    config.platformConsoleBaseUrl,
    'platformConsoleBaseUrl',
    { allowLocalHttp, allowedHosts },
  );
  const companyOwnerBase = parseAndValidateBaseUrl(
    config.companyOwnerRecoveryBaseUrl,
    'companyOwnerRecoveryBaseUrl',
    { allowLocalHttp, allowedHosts },
  );

  // Seed allowlist from configured bases when none provided.
  if (allowedHosts.size === 0) {
    allowedHosts.add(platformBase.hostname.toLowerCase());
    allowedHosts.add(companyOwnerBase.hostname.toLowerCase());
  }

  return {
    platformBase,
    companyOwnerBase,
    build(audience: RecoveryLinkAudience, rawToken: string): string {
      const token = assertOpaqueToken(rawToken);
      const base = audience === 'platform_password_reset' ? platformBase : companyOwnerBase;
      const path = audience === 'platform_password_reset'
        ? DEFAULT_PLATFORM_PATH
        : DEFAULT_COMPANY_OWNER_PATH;

      const link = new URL(path, base);
      // Fragment preferred for web so intermediate proxies/logs see less of the token;
      // Android deep-link handlers also accept the same fragment form.
      link.hash = `token=${encodeURIComponent(token)}`;
      link.search = '';
      return link.toString();
    },
  };
}

/**
 * Reject any client-supplied redirect / return URL. Recovery handlers must never
 * forward such values into link generation.
 */
export function rejectClientSuppliedRedirect(value: unknown): void {
  if (value === undefined || value === null) return;
  throw new RecoveryLinkBuilderError(
    'client_redirect_rejected',
    'Client-supplied redirect URLs are forbidden',
  );
}
