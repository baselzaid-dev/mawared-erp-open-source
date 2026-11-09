/**
 * Server-owned response-time floor + bounded jitter for enumeration-sensitive
 * public recovery surfaces. Never request-selectable.
 */

export interface RecoveryTimingNormalizationOptions {
  /** Minimum wall time before response (ms). Default 180. */
  floorMs?: number;
  /** Inclusive upper bound for uniform jitter added to floor (ms). Default 80. */
  jitterMs?: number;
  clock?: () => number;
  delay?: (ms: number) => Promise<void>;
  /** Deterministic [0, 1) source for tests. */
  random?: () => number;
}

export const DEFAULT_OWNER_RECOVERY_TIMING_FLOOR_MS = 180;
export const DEFAULT_OWNER_RECOVERY_TIMING_JITTER_MS = 80;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function assertRecoveryTimingBounds(floorMs: number, jitterMs: number): void {
  if (!Number.isFinite(floorMs) || !Number.isInteger(floorMs) || floorMs < 0 || floorMs > 2_000) {
    throw new Error('recovery timing floorMs must be an integer between 0 and 2000');
  }
  if (!Number.isFinite(jitterMs) || !Number.isInteger(jitterMs) || jitterMs < 0 || jitterMs > 500) {
    throw new Error('recovery timing jitterMs must be an integer between 0 and 500');
  }
}

/**
 * Run work, then delay until floorMs + uniform(0..jitterMs) has elapsed
 * since start. Caps residual delay so a slow path is not delayed further.
 */
export async function withNormalizedResponseTime<T>(
  work: () => Promise<T>,
  options: RecoveryTimingNormalizationOptions = {},
): Promise<T> {
  const floorMs = options.floorMs ?? DEFAULT_OWNER_RECOVERY_TIMING_FLOOR_MS;
  const jitterMs = options.jitterMs ?? DEFAULT_OWNER_RECOVERY_TIMING_JITTER_MS;
  assertRecoveryTimingBounds(floorMs, jitterMs);

  const clock = options.clock ?? (() => Date.now());
  const delay = options.delay ?? sleep;
  const random = options.random ?? Math.random;

  const startedAt = clock();
  try {
    return await work();
  } finally {
    const target = floorMs + Math.floor(random() * (jitterMs + 1));
    const elapsed = Math.max(0, clock() - startedAt);
    const remaining = target - elapsed;
    if (remaining > 0) {
      await delay(remaining);
    }
  }
}
