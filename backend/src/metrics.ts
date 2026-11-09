/**
 * Provider-neutral application metrics boundary.
 *
 * Stores bounded counters and duration aggregates only. Labels are categorical —
 * never request IDs, emails, tokens, company names, resource IDs, or free text.
 * An external exporter may later snapshot {@link snapshotMetrics} without changing
 * this contract. No public metrics HTTP endpoint is exposed by this module.
 */

export type AuthRealm = 'company' | 'platform';
export type RateLimitCategory = 'auth' | 'mfa' | 'export' | 'sensitive' | 'ai' | 'chat' | 'other';

export type RouteCategory =
  | 'health'
  | 'ready'
  | 'auth_company'
  | 'auth_platform'
  | 'mfa'
  | 'sessions'
  | 'authorization'
  | 'api'
  | 'other';

const ROUTE_CATEGORIES: readonly RouteCategory[] = [
  'health',
  'ready',
  'auth_company',
  'auth_platform',
  'mfa',
  'sessions',
  'authorization',
  'api',
  'other',
];

interface CounterMap {
  [key: string]: number;
}

interface DurationBucket {
  count: number;
  totalMs: number;
}

export interface MetricsSnapshot {
  httpRequests: CounterMap;
  httpDurationMs: Record<string, DurationBucket>;
  http4xx: CounterMap;
  http5xx: CounterMap;
  authFailures: Record<AuthRealm, number>;
  mfaFailures: Record<AuthRealm, number>;
  rateLimitEvents: Record<RateLimitCategory, number>;
  authorizationDenials: number;
  crossTenantDenials: number;
}

function emptyAuthRealms(): Record<AuthRealm, number> {
  return { company: 0, platform: 0 };
}

function emptyRateLimits(): Record<RateLimitCategory, number> {
  return {
    auth: 0,
    mfa: 0,
    export: 0,
    sensitive: 0,
    ai: 0,
    chat: 0,
    other: 0,
  };
}

function createState(): MetricsSnapshot {
  return {
    httpRequests: {},
    httpDurationMs: {},
    http4xx: {},
    http5xx: {},
    authFailures: emptyAuthRealms(),
    mfaFailures: emptyAuthRealms(),
    rateLimitEvents: emptyRateLimits(),
    authorizationDenials: 0,
    crossTenantDenials: 0,
  };
}

let state = createState();

/** Maps a request path to a bounded route category (no raw paths as metric labels). */
export function normalizeRouteCategory(path: string | undefined): RouteCategory {
  const raw = (path || '/').split('?')[0].toLowerCase();
  if (raw === '/healthz' || raw.endsWith('/healthz')) return 'health';
  if (raw === '/readyz' || raw.endsWith('/readyz')) return 'ready';
  if (raw.includes('/platform')) return 'auth_platform';
  if (raw.includes('/mfa')) return 'mfa';
  if (raw.includes('/session')) return 'sessions';
  if (raw.includes('/authorization') || raw.includes('/delegat') || raw.includes('/ownership')) {
    return 'authorization';
  }
  if (raw.includes('/auth')) return 'auth_company';
  if (raw.startsWith('/api')) return 'api';
  return 'other';
}

function bump(map: CounterMap, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function assertRouteCategory(category: string): RouteCategory {
  return (ROUTE_CATEGORIES as readonly string[]).includes(category)
    ? (category as RouteCategory)
    : 'other';
}

export function recordHttpRequest(input: {
  routeCategory: RouteCategory | string;
  status: number;
  durationMs?: number;
}): void {
  const category = assertRouteCategory(String(input.routeCategory));
  bump(state.httpRequests, category);
  if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0) {
    const bucket = state.httpDurationMs[category] ?? { count: 0, totalMs: 0 };
    bucket.count += 1;
    bucket.totalMs += Math.min(input.durationMs, 60_000);
    state.httpDurationMs[category] = bucket;
  }
  if (input.status >= 500) bump(state.http5xx, category);
  else if (input.status >= 400) bump(state.http4xx, category);
}

export function recordAuthFailure(realm: AuthRealm): void {
  state.authFailures[realm] += 1;
}

export function recordMfaFailure(realm: AuthRealm): void {
  state.mfaFailures[realm] += 1;
}

export function recordRateLimit(category: RateLimitCategory): void {
  state.rateLimitEvents[category] += 1;
}

export function recordAuthorizationDenial(): void {
  state.authorizationDenials += 1;
}

export function recordCrossTenantDenial(): void {
  state.crossTenantDenials += 1;
}

/**
 * Classifies a finished HTTP response into security counters without reading
 * identity or resource fields. Uses only status, route category, and optional
 * opaque-privacy flag.
 */
export function classifyFinishedRequest(input: {
  routeCategory: RouteCategory | string;
  status: number;
  durationMs?: number;
  opaquePrivacy?: boolean;
  errorCode?: string;
}): void {
  const category = assertRouteCategory(String(input.routeCategory));
  recordHttpRequest({
    routeCategory: category,
    status: input.status,
    durationMs: input.durationMs,
  });

  if (input.status === 429) {
    if (category === 'mfa') recordRateLimit('mfa');
    else if (category === 'auth_company' || category === 'auth_platform') recordRateLimit('auth');
    else recordRateLimit('other');
  }
  if (input.status === 403) recordAuthorizationDenial();
  if (input.status === 401) {
    if (category === 'mfa' || /mfa/i.test(input.errorCode ?? '')) {
      recordMfaFailure(category === 'auth_platform' ? 'platform' : 'company');
    } else if (category === 'auth_platform') {
      recordAuthFailure('platform');
    } else if (category === 'auth_company' || category === 'sessions') {
      recordAuthFailure('company');
    }
  }
  if (input.opaquePrivacy && (input.status === 404 || input.status === 403)) {
    recordCrossTenantDenial();
  }
}

export function snapshotMetrics(): MetricsSnapshot {
  return {
    httpRequests: { ...state.httpRequests },
    httpDurationMs: Object.fromEntries(
      Object.entries(state.httpDurationMs).map(([key, value]) => [
        key,
        { count: value.count, totalMs: value.totalMs },
      ]),
    ),
    http4xx: { ...state.http4xx },
    http5xx: { ...state.http5xx },
    authFailures: { ...state.authFailures },
    mfaFailures: { ...state.mfaFailures },
    rateLimitEvents: { ...state.rateLimitEvents },
    authorizationDenials: state.authorizationDenials,
    crossTenantDenials: state.crossTenantDenials,
  };
}

export function resetMetrics(): void {
  state = createState();
}

/** Returns true when a candidate label string is forbidden for metrics. */
export function isForbiddenMetricLabel(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.length > 64) return true;
  if (/[/@]/.test(trimmed)) return true; // emails / paths
  if (/\bbearer\b/i.test(trimmed)) return true;
  if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(trimmed)) return true; // JWT-like
  if (/(?:password|token|secret|cookie|authorization)/i.test(trimmed)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return true; // UUID resource/request IDs
  }
  return false;
}
