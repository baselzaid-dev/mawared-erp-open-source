/**
 * Bounded readiness probing.
 *
 * A readiness probe must answer within a predictable deadline. A dependency
 * that is *down* rejects quickly, but a dependency that is *hung* (saturated
 * connection pool, blackholed network path) can leave an unbounded `await`
 * pending forever. That turns a clean "not ready" into a platform-level
 * request timeout, which is ambiguous for both load balancers and operators.
 */

/** Default readiness deadline. Short enough to stay under platform probe timeouts. */
export const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

export class ReadinessTimeoutError extends Error {
  readonly errorCode = 'ReadinessTimeout';

  constructor() {
    super('Readiness probe exceeded its deadline');
  }
}

/**
 * Resolve `work`, or reject with {@link ReadinessTimeoutError} once `timeoutMs`
 * elapses — whichever happens first.
 *
 * The losing promise is deliberately given a no-op rejection handler: a probe
 * that times out must not surface a late unhandled rejection when the slow
 * dependency eventually fails. The timer is unref'd so a pending probe can
 * never by itself keep the process alive during shutdown.
 */
export async function withReadinessTimeout<T>(
  work: Promise<T>,
  timeoutMs: number = DEFAULT_READINESS_TIMEOUT_MS,
): Promise<T> {
  work.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ReadinessTimeoutError()), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Why a readiness probe failed. `timeout` and `unavailable` are different
 * incidents — a hung dependency and a refused dependency need different
 * operator responses — so they stay distinguishable in logs even though the
 * public HTTP response is identical for both.
 */
export type ReadinessFailureReason = 'unavailable' | 'timeout';

export type ReadinessOutcome =
  // `reason` is declared on both members so callers can read it without
  // depending on control-flow narrowing at the access site.
  | { ready: true; reason?: undefined }
  | { ready: false; reason: ReadinessFailureReason };

/**
 * Run a dependency check under a deadline.
 *
 * Takes a thunk rather than a client so the caller keeps ownership of the
 * query text, and so no dependency detail (driver, SQL, connection string)
 * can travel into this module or into anything it reports.
 */
export async function probeReadiness(
  runCheck: () => Promise<unknown>,
  timeoutMs: number = DEFAULT_READINESS_TIMEOUT_MS,
): Promise<ReadinessOutcome> {
  try {
    await withReadinessTimeout(Promise.resolve().then(runCheck), timeoutMs);
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      reason: error instanceof ReadinessTimeoutError ? 'timeout' : 'unavailable',
    };
  }
}

/**
 * Build a readiness probe that runs at most one dependency check at a time.
 *
 * Timing a probe out does not cancel the underlying query — no cancellation
 * API exists for it. A platform that probes every few seconds against a hung
 * database would therefore start a new query per probe, and each one holds a
 * pool connection until the driver gives up. The probe would keep answering
 * correctly while quietly exhausting the pool that healthy traffic needs.
 *
 * Sharing one in-flight check removes that: concurrent probes attach to the
 * same query and still time out promptly and independently. The slot is
 * released whenever the dependency finally answers, so a recovered database is
 * probed freshly on the next call.
 */
export function createSingleFlightReadinessProbe(
  runCheck: () => Promise<unknown>,
  timeoutMs: number = DEFAULT_READINESS_TIMEOUT_MS,
): () => Promise<ReadinessOutcome> {
  let inFlight: Promise<unknown> | null = null;

  return async () => {
    if (!inFlight) {
      const started = Promise.resolve().then(runCheck);
      inFlight = started;
      const release = () => {
        // Only clear the slot we set: a later probe may already own it.
        if (inFlight === started) inFlight = null;
      };
      started.then(release, release);
    }

    try {
      await withReadinessTimeout(inFlight, timeoutMs);
      return { ready: true };
    } catch (error) {
      return {
        ready: false,
        reason: error instanceof ReadinessTimeoutError ? 'timeout' : 'unavailable',
      };
    }
  };
}
