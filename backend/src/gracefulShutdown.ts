/**
 * Graceful shutdown for the HTTP process.
 *
 * Hosting platforms (Render included) send SIGTERM before replacing or
 * stopping an instance and SIGKILL some seconds later. Without a handler the
 * default action terminates the process immediately: in-flight requests are
 * severed mid-response and pooled database connections are never released.
 *
 * The sequence here is: stop accepting new connections, let in-flight work
 * finish inside a bounded grace period, release pooled resources, exit.
 */

import type { AppLogger } from './appLogger';

/** Grace period for in-flight requests. Kept below typical platform SIGKILL delays. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;

/**
 * The subset of `http.Server` used here. `closeIdleConnections` and
 * `closeAllConnections` exist on Node 18+; both are optional so the contract
 * stays satisfiable by a test double.
 */
export interface ClosableServer {
  close(callback?: (error?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

export interface GracefulShutdownOptions {
  server: ClosableServer;
  /** Release pooled resources, e.g. `() => prisma.$disconnect()`. */
  disconnect?: () => Promise<unknown>;
  logger: AppLogger;
  /** Bound on waiting for in-flight requests. Default: 15000ms. */
  graceMs?: number;
  signals?: NodeJS.Signals[];
  /** Injected in tests so no real process listener or exit is involved. */
  exit?: (code: number) => void;
  register?: (signal: NodeJS.Signals, handler: () => void) => void;
}

export interface GracefulShutdownHandle {
  /** Exposed for tests and for programmatic shutdown; signal handlers call this. */
  shutdown(signal: string): Promise<void>;
}

function errorClassOf(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  return error.constructor?.name?.replace(/[^A-Za-z0-9_]/g, '').slice(0, 80) || 'Error';
}

/**
 * Wait for the server to stop serving, or for the grace period to expire.
 *
 * `server.close()` only invokes its callback once every socket is gone. Behind
 * a proxy that holds keep-alive connections open that can be effectively
 * never, so idle sockets are dropped immediately and the remainder are dropped
 * when the grace period expires.
 */
function closeServer(
  server: ClosableServer,
  graceMs: number,
): Promise<{ timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ timedOut });
    };

    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      settle(true);
    }, graceMs);
    timer.unref?.();

    server.close(() => {
      clearTimeout(timer);
      settle(false);
    });

    // Safe to drop right away: idle keep-alive sockets have no in-flight request.
    server.closeIdleConnections?.();
  });
}

/**
 * Attach shutdown handlers for SIGTERM/SIGINT.
 *
 * Exit code is 0 even when the grace period expires: a signal-initiated
 * shutdown is intentional, and a non-zero code would be recorded as a crash by
 * most platforms and raise false alerts. An overrun is reported at error level
 * in the logs instead. A *second* signal is treated as an explicit operator
 * override and aborts immediately with code 1.
 */
export function installGracefulShutdown(
  options: GracefulShutdownOptions,
): GracefulShutdownHandle {
  const graceMs = options.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const register = options.register ?? ((signal, handler) => {
    process.on(signal, handler);
  });
  const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[]);

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      options.logger.warn('process.shutdown_aborted_by_second_signal', { signal });
      exit(1);
      return;
    }
    shuttingDown = true;
    options.logger.info('process.shutdown_started', { signal, graceMs });

    const { timedOut } = await closeServer(options.server, graceMs);

    try {
      await options.disconnect?.();
    } catch (error) {
      // Only the error class is logged: a driver error message can carry the
      // connection string.
      options.logger.error('process.shutdown_disconnect_failed', {
        signal,
        errorClass: errorClassOf(error),
      });
    }

    if (timedOut) {
      options.logger.error('process.shutdown_grace_period_exceeded', { signal, graceMs });
    } else {
      options.logger.info('process.shutdown_complete', { signal });
    }
    exit(0);
  };

  for (const signal of signals) {
    register(signal, () => {
      void shutdown(signal);
    });
  }

  return { shutdown };
}
