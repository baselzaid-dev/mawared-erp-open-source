import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  RECOVERY_RATE_LIMIT_PEPPER_ENV,
  hashIdentifierForRateLimit,
} from './tokenCrypto';

export const RECOVERY_RATE_LIMIT_SURFACES = [
  'platform_password_reset_initiate',
  'platform_password_reset_confirm',
  'platform_account_discovery',
  'platform_mfa_recovery',
  'company_owner_recovery_initiate',
  'company_owner_recovery_confirm',
  'employee_admin_reset',
  'break_glass_attempt',
] as const;
export type RecoveryRateLimitSurface = (typeof RECOVERY_RATE_LIMIT_SURFACES)[number];

export const RECOVERY_RATE_LIMIT_DIMENSIONS = [
  'source',
  'target',
  'token',
  'actor',
  'company',
  'global',
] as const;
export type RecoveryRateLimitDimension = (typeof RECOVERY_RATE_LIMIT_DIMENSIONS)[number];

export interface RecoveryRateLimitWindowPolicy {
  windowMs: number;
  blockLimit: number;
  alertLimit: number;
}

export interface RecoveryRateLimitSurfacePolicy {
  source?: RecoveryRateLimitWindowPolicy;
  target?: RecoveryRateLimitWindowPolicy;
  token?: RecoveryRateLimitWindowPolicy;
  actor?: RecoveryRateLimitWindowPolicy;
  company?: RecoveryRateLimitWindowPolicy;
  global?: RecoveryRateLimitWindowPolicy;
}

/** Documented initial defaults — configuration-backed, not immutable product law. */
export const DEFAULT_RECOVERY_RATE_LIMIT_POLICY: Readonly<
  Record<RecoveryRateLimitSurface, RecoveryRateLimitSurfacePolicy>
> = {
  platform_password_reset_initiate: {
    source: { windowMs: 15 * 60_000, blockLimit: 10, alertLimit: 5 },
    target: { windowMs: 15 * 60_000, blockLimit: 3, alertLimit: 2 },
    global: { windowMs: 60_000, blockLimit: 200, alertLimit: 100 },
  },
  platform_password_reset_confirm: {
    source: { windowMs: 15 * 60_000, blockLimit: 20, alertLimit: 10 },
    token: { windowMs: 15 * 60_000, blockLimit: 5, alertLimit: 3 },
    global: { windowMs: 60_000, blockLimit: 200, alertLimit: 100 },
  },
  platform_account_discovery: {
    source: { windowMs: 15 * 60_000, blockLimit: 10, alertLimit: 5 },
    target: { windowMs: 15 * 60_000, blockLimit: 3, alertLimit: 2 },
    global: { windowMs: 60_000, blockLimit: 200, alertLimit: 100 },
  },
  platform_mfa_recovery: {
    source: { windowMs: 60 * 60_000, blockLimit: 5, alertLimit: 1 },
    target: { windowMs: 24 * 60 * 60_000, blockLimit: 1, alertLimit: 1 },
    actor: { windowMs: 24 * 60 * 60_000, blockLimit: 3, alertLimit: 1 },
  },
  company_owner_recovery_initiate: {
    source: { windowMs: 15 * 60_000, blockLimit: 10, alertLimit: 5 },
    target: { windowMs: 15 * 60_000, blockLimit: 3, alertLimit: 2 },
    company: { windowMs: 15 * 60_000, blockLimit: 8, alertLimit: 4 },
    // Platform-assisted actor throttle (hashed principal id — never raw).
    actor: { windowMs: 24 * 60 * 60_000, blockLimit: 10, alertLimit: 5 },
    // Surge protection shared by self-service and assisted initiate.
    global: { windowMs: 60_000, blockLimit: 200, alertLimit: 100 },
  },
  company_owner_recovery_confirm: {
    source: { windowMs: 15 * 60_000, blockLimit: 20, alertLimit: 10 },
    token: { windowMs: 15 * 60_000, blockLimit: 5, alertLimit: 3 },
    global: { windowMs: 60_000, blockLimit: 200, alertLimit: 100 },
  },
  employee_admin_reset: {
    actor: { windowMs: 60 * 60_000, blockLimit: 20, alertLimit: 10 },
    target: { windowMs: 60 * 60_000, blockLimit: 3, alertLimit: 2 },
    company: { windowMs: 10 * 60_000, blockLimit: 50, alertLimit: 25 },
    // Surge/global bucket — keyed hashed; never stores raw identifiers.
    global: { windowMs: 60_000, blockLimit: 200, alertLimit: 100 },
  },
  break_glass_attempt: {
    // Procedural E5 surface — metadata counters only; never a public HTTP throttle substitute.
    actor: { windowMs: 24 * 60 * 60_000, blockLimit: 5, alertLimit: 1 },
    global: { windowMs: 24 * 60 * 60_000, blockLimit: 20, alertLimit: 5 },
  },
};

export type RecoveryRateLimitDecision =
  | { allowed: true; alert: boolean; reason?: undefined }
  | { allowed: false; alert: boolean; reason: 'rate_limited' };

export interface RecoveryRateLimitCheckInput {
  surface: RecoveryRateLimitSurface;
  dimension: RecoveryRateLimitDimension;
  /** Raw identifier — hashed before storage. Never used as a metric label. */
  rawKey: string;
  now?: Date;
}

export interface RecoveryRateLimitStore {
  incrementAndEvaluate(input: {
    surface: RecoveryRateLimitSurface;
    dimension: RecoveryRateLimitDimension;
    bucketKeyHash: string;
    windowStartedAt: Date;
    windowEndsAt: Date;
    blockLimit: number;
    alertLimit: number;
    now: Date;
  }): Promise<{ count: number; blocked: boolean; alert: boolean }>;
}

/**
 * Test-only in-memory store. Not production-safe for multi-instance deployments.
 */
export class InMemoryRecoveryRateLimitStore implements RecoveryRateLimitStore {
  readonly #buckets = new Map<string, { count: number; windowEndsAt: number }>();

  async incrementAndEvaluate(input: {
    surface: RecoveryRateLimitSurface;
    dimension: RecoveryRateLimitDimension;
    bucketKeyHash: string;
    windowStartedAt: Date;
    windowEndsAt: Date;
    blockLimit: number;
    alertLimit: number;
    now: Date;
  }): Promise<{ count: number; blocked: boolean; alert: boolean }> {
    const key = [
      input.surface,
      input.dimension,
      input.bucketKeyHash,
      input.windowStartedAt.toISOString(),
    ].join('|');
    const existing = this.#buckets.get(key);
    if (!existing || existing.windowEndsAt <= input.now.getTime()) {
      this.#buckets.set(key, { count: 1, windowEndsAt: input.windowEndsAt.getTime() });
      return { count: 1, blocked: false, alert: 1 >= input.alertLimit };
    }
    existing.count += 1;
    return {
      count: existing.count,
      blocked: existing.count > input.blockLimit,
      alert: existing.count >= input.alertLimit,
    };
  }

  /** Test helper — clears all buckets. */
  clear(): void {
    this.#buckets.clear();
  }
}

type RateLimitDb = Pick<PrismaClient, '$queryRaw'>;

/**
 * PostgreSQL-backed durable rate-limit store.
 * Uses one atomic INSERT ... ON CONFLICT DO UPDATE — never findFirst+create.
 */
export class PostgresRecoveryRateLimitStore implements RecoveryRateLimitStore {
  constructor(private readonly prisma: RateLimitDb) {}

  async incrementAndEvaluate(input: {
    surface: RecoveryRateLimitSurface;
    dimension: RecoveryRateLimitDimension;
    bucketKeyHash: string;
    windowStartedAt: Date;
    windowEndsAt: Date;
    blockLimit: number;
    alertLimit: number;
    now: Date;
  }): Promise<{ count: number; blocked: boolean; alert: boolean }> {
    const initialAlertedAt = 1 >= input.alertLimit ? input.now : null;
    const rows = await this.prisma.$queryRaw<Array<{ count: number; alertedAt: Date | null }>>`
      INSERT INTO "CredentialRecoveryRateLimitBucket" (
        "id",
        "surface",
        "dimension",
        "bucketKeyHash",
        "windowStartedAt",
        "windowEndsAt",
        "count",
        "alertedAt",
        "updatedAt"
      ) VALUES (
        ${randomUUID()},
        ${input.surface},
        ${input.dimension},
        ${input.bucketKeyHash},
        ${input.windowStartedAt},
        ${input.windowEndsAt},
        1,
        ${initialAlertedAt},
        ${input.now}
      )
      ON CONFLICT ("surface", "dimension", "bucketKeyHash", "windowStartedAt")
      DO UPDATE SET
        "count" = "CredentialRecoveryRateLimitBucket"."count" + 1,
        "updatedAt" = EXCLUDED."updatedAt",
        "alertedAt" = CASE
          WHEN "CredentialRecoveryRateLimitBucket"."alertedAt" IS NOT NULL
            THEN "CredentialRecoveryRateLimitBucket"."alertedAt"
          WHEN ("CredentialRecoveryRateLimitBucket"."count" + 1) >= ${input.alertLimit}
            THEN EXCLUDED."updatedAt"
          ELSE NULL
        END
      RETURNING "count", "alertedAt"
    `;

    const row = rows[0];
    if (!row) {
      throw new Error('rate-limit upsert returned no row');
    }
    return {
      count: row.count,
      blocked: row.count > input.blockLimit,
      alert: row.count >= input.alertLimit,
    };
  }
}

export class RecoveryRateLimiter {
  constructor(
    private readonly store: RecoveryRateLimitStore,
    private readonly pepper: string,
    private readonly policy: Readonly<
      Record<RecoveryRateLimitSurface, RecoveryRateLimitSurfacePolicy>
    > = DEFAULT_RECOVERY_RATE_LIMIT_POLICY,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!pepper || pepper.length < 32) {
      throw new Error(`${RECOVERY_RATE_LIMIT_PEPPER_ENV} must be at least 32 characters`);
    }
  }

  async check(input: RecoveryRateLimitCheckInput): Promise<RecoveryRateLimitDecision> {
    const surfacePolicy = this.policy[input.surface];
    const windowPolicy = surfacePolicy[input.dimension];
    if (!windowPolicy) {
      return { allowed: true, alert: false };
    }

    const now = input.now ?? this.clock();
    const windowStartedAt = new Date(
      Math.floor(now.getTime() / windowPolicy.windowMs) * windowPolicy.windowMs,
    );
    const windowEndsAt = new Date(windowStartedAt.getTime() + windowPolicy.windowMs);
    const bucketKeyHash = hashIdentifierForRateLimit(
      input.rawKey,
      this.pepper,
      input.surface,
      input.dimension,
    );

    const result = await this.store.incrementAndEvaluate({
      surface: input.surface,
      dimension: input.dimension,
      bucketKeyHash,
      windowStartedAt,
      windowEndsAt,
      blockLimit: windowPolicy.blockLimit,
      alertLimit: windowPolicy.alertLimit,
      now,
    });

    if (result.blocked) {
      return { allowed: false, alert: result.alert, reason: 'rate_limited' };
    }
    return { allowed: true, alert: result.alert };
  }
}

/** Metric-safe labels only — never include raw identifiers. */
export function recoveryRateLimitMetricLabels(input: {
  surface: RecoveryRateLimitSurface;
  dimension: RecoveryRateLimitDimension;
  result: 'allowed' | 'limited' | 'alert';
}): Record<string, string> {
  return {
    surface: input.surface,
    dimension: input.dimension,
    result: input.result,
  };
}
