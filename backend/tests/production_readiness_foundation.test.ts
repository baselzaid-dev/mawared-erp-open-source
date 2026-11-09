import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { AppLogger } from '../src/appLogger';
import {
  DEFAULT_SHUTDOWN_GRACE_MS,
  installGracefulShutdown,
  type ClosableServer,
} from '../src/gracefulShutdown';
import {
  DEFAULT_READINESS_TIMEOUT_MS,
  ReadinessTimeoutError,
  createSingleFlightReadinessProbe,
  probeReadiness,
  withReadinessTimeout,
} from '../src/readiness';
import {
  RuntimeConfigError,
  assertRuntimeConfig,
  formatRuntimeConfigIssues,
  inspectRuntimeConfig,
  resolveDeploymentTier,
} from '../src/runtimeConfig';
import { makeApp, makeFakePrisma } from './helpers';

/** Recording logger so assertions can inspect emitted events and fields. */
function makeRecordingLogger() {
  const entries: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  const record = (level: string) => (event: string, fields: Record<string, unknown> = {}) => {
    entries.push({ level, event, fields });
  };
  const logger: AppLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
  return { logger, entries, events: () => entries.map((entry) => entry.event) };
}

/**
 * A base environment that satisfies every required variable, so each test can
 * remove exactly one thing and assert on that alone.
 */
const VALID_ENV = {
  DATABASE_URL: 'postgresql://user@example.invalid:5432/db',
  // security-scan-allow: fixed-length non-secret padding for a length assertion
  JWT_SECRET: 'a'.repeat(48),
  // security-scan-allow: fixed-length non-secret padding for a length assertion
  PLATFORM_JWT_SECRET: 'b'.repeat(48),
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  CORS_ORIGINS: 'https://app.example.invalid',
} as const;

describe('bounded readiness probing', () => {
  it('resolves when the dependency answers inside the deadline', async () => {
    await expect(withReadinessTimeout(Promise.resolve('ok'), 1_000)).resolves.toBe('ok');
  });

  it('rejects with a timeout once the deadline passes', async () => {
    const never = new Promise<never>(() => {});
    await expect(withReadinessTimeout(never, 10)).rejects.toBeInstanceOf(ReadinessTimeoutError);
  });

  it('distinguishes a hung dependency from a refused one', async () => {
    const hung = await probeReadiness(() => new Promise<never>(() => {}), 10);
    const refused = await probeReadiness(() => Promise.reject(new Error('refused')), 1_000);
    expect(hung).toEqual({ ready: false, reason: 'timeout' });
    expect(refused).toEqual({ ready: false, reason: 'unavailable' });
  });

  it('reports readiness when the check succeeds', async () => {
    await expect(probeReadiness(() => Promise.resolve(1), 1_000)).resolves.toEqual({ ready: true });
  });

  it('treats a synchronous throw as unavailable rather than crashing the probe', async () => {
    const outcome = await probeReadiness(() => {
      throw new Error('driver exploded');
    }, 1_000);
    expect(outcome).toEqual({ ready: false, reason: 'unavailable' });
  });

  it('does not surface an unhandled rejection when a timed-out dependency later fails', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let fail: (error: Error) => void = () => {};
      const slow = new Promise<never>((_resolve, reject) => {
        fail = reject;
      });
      await expect(withReadinessTimeout(slow, 10)).rejects.toBeInstanceOf(ReadinessTimeoutError);
      fail(new Error('late failure'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('keeps a default deadline short enough for a platform probe', () => {
    expect(DEFAULT_READINESS_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe('single-flight readiness probing', () => {
  it('does not start a second dependency check while one is hung', async () => {
    // Timing out does not cancel the query. Without sharing, a platform
    // probing every few seconds against a hung database would start one
    // uncancellable query per probe, each holding a pool connection.
    const runCheck = vi.fn(() => new Promise<never>(() => {}));
    const probe = createSingleFlightReadinessProbe(runCheck, 10);

    const outcomes = await Promise.all([probe(), probe(), probe()]);

    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([
      { ready: false, reason: 'timeout' },
      { ready: false, reason: 'timeout' },
      { ready: false, reason: 'timeout' },
    ]);
  });

  it('probes freshly once the dependency answers again', async () => {
    let settle: (() => void) | undefined;
    const runCheck = vi.fn(() => {
      if (runCheck.mock.calls.length === 1) {
        return new Promise<void>((resolve) => { settle = resolve; });
      }
      return Promise.resolve();
    });
    const probe = createSingleFlightReadinessProbe(runCheck, 10);

    expect(await probe()).toEqual({ ready: false, reason: 'timeout' });
    // The dependency recovers and the slow query finally answers.
    settle?.();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await probe()).toEqual({ ready: true });
    expect(runCheck).toHaveBeenCalledTimes(2);
  });

  it('reports a refused dependency without sharing a stale failure', async () => {
    const runCheck = vi.fn(() => Promise.reject(new Error('refused')));
    const probe = createSingleFlightReadinessProbe(runCheck, 1_000);

    expect(await probe()).toEqual({ ready: false, reason: 'unavailable' });
    expect(await probe()).toEqual({ ready: false, reason: 'unavailable' });
    // Each call gets its own attempt once the previous one has settled.
    expect(runCheck).toHaveBeenCalledTimes(2);
  });
});

describe('readiness endpoint under a stalled database', () => {
  it('fails closed with 503 instead of hanging', async () => {
    const prisma = makeFakePrisma();
    prisma.$queryRaw.mockImplementation(() => new Promise<never>(() => {}));
    const response = await request(makeApp(prisma, { readinessTimeoutMs: 25 })).get('/readyz');
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('ServiceUnavailable');
  });

  it('leaks no dependency detail when the probe times out', async () => {
    const prisma = makeFakePrisma();
    prisma.$queryRaw.mockImplementation(() => new Promise<never>(() => {}));
    const response = await request(makeApp(prisma, { readinessTimeoutMs: 25 })).get('/readyz');
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/Prisma|SELECT|timeout|deadline|DATABASE_URL|postgres/i);
  });

  it('still reports ready when the dependency answers', async () => {
    const response = await request(makeApp(makeFakePrisma(), { readinessTimeoutMs: 500 }))
      .get('/readyz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
  });
});

describe('graceful shutdown', () => {
  function makeServer(): ClosableServer & {
    finishClose: () => void;
    closeIdleConnections: ReturnType<typeof vi.fn<() => void>>;
    closeAllConnections: ReturnType<typeof vi.fn<() => void>>;
  } {
    let pending: (() => void) | undefined;
    return {
      close(callback?: () => void) {
        pending = callback;
        return undefined;
      },
      finishClose: () => pending?.(),
      closeIdleConnections: vi.fn<() => void>(),
      closeAllConnections: vi.fn<() => void>(),
    };
  }

  it('stops the server, releases pooled resources, and exits cleanly', async () => {
    const server = makeServer();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const { logger, events } = makeRecordingLogger();

    const handle = installGracefulShutdown({
      server, disconnect, logger, exit, register: () => {}, graceMs: 1_000,
    });
    const done = handle.shutdown('SIGTERM');
    server.finishClose();
    await done;

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(events()).toEqual(['process.shutdown_started', 'process.shutdown_complete']);
  });

  it('drops idle keep-alive sockets so close is not held open indefinitely', async () => {
    const server = makeServer();
    const exit = vi.fn();
    const { logger } = makeRecordingLogger();

    const handle = installGracefulShutdown({
      server, logger, exit, register: () => {}, graceMs: 1_000,
    });
    const done = handle.shutdown('SIGTERM');
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
    server.finishClose();
    await done;
  });

  it('forces remaining connections closed when the grace period expires', async () => {
    const server = makeServer();
    const exit = vi.fn();
    const { logger, events } = makeRecordingLogger();

    const handle = installGracefulShutdown({
      server, logger, exit, register: () => {}, graceMs: 10,
    });
    // `finishClose` is deliberately never called: in-flight work never drains.
    await handle.shutdown('SIGTERM');

    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(events()).toContain('process.shutdown_grace_period_exceeded');
    // Still exit 0: a signal-initiated stop is intentional, and a non-zero
    // code would be recorded as a crash by the hosting platform.
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('still exits when releasing pooled resources fails', async () => {
    const server = makeServer();
    const exit = vi.fn();
    const { logger, events } = makeRecordingLogger();

    const handle = installGracefulShutdown({
      server,
      disconnect: () => Promise.reject(new Error('postgresql://user:pw@example.invalid/db down')),
      logger,
      exit,
      register: () => {},
      graceMs: 1_000,
    });
    const done = handle.shutdown('SIGTERM');
    server.finishClose();
    await done;

    expect(events()).toContain('process.shutdown_disconnect_failed');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('never logs a disconnect failure message that could carry a connection string', async () => {
    const server = makeServer();
    const { logger, entries } = makeRecordingLogger();

    const handle = installGracefulShutdown({
      server,
      disconnect: () => Promise.reject(new Error('postgresql://user:pw@example.invalid/db down')),
      logger,
      exit: () => {},
      register: () => {},
      graceMs: 1_000,
    });
    const done = handle.shutdown('SIGTERM');
    server.finishClose();
    await done;

    expect(JSON.stringify(entries)).not.toMatch(/postgresql:\/\/|user:pw|example\.invalid/i);
  });

  it('treats a second signal as an operator override and aborts immediately', async () => {
    const server = makeServer();
    const exit = vi.fn();
    const { logger, events } = makeRecordingLogger();

    const handle = installGracefulShutdown({
      server, logger, exit, register: () => {}, graceMs: 60_000,
    });
    void handle.shutdown('SIGTERM');
    await handle.shutdown('SIGINT');

    expect(events()).toContain('process.shutdown_aborted_by_second_signal');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('registers the signals a hosting platform actually sends', () => {
    const registered: string[] = [];
    installGracefulShutdown({
      server: makeServer(),
      logger: makeRecordingLogger().logger,
      exit: () => {},
      register: (signal) => { registered.push(signal); },
    });
    expect(registered).toEqual(['SIGTERM', 'SIGINT']);
  });

  it('keeps the default grace period under a typical platform SIGKILL delay', () => {
    expect(DEFAULT_SHUTDOWN_GRACE_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('runtime configuration contract', () => {
  it('resolves the deployment tier from MAWARED_ENV, not NODE_ENV alone', () => {
    // Staging runs a production-mode build but is not the production tier.
    expect(resolveDeploymentTier({ MAWARED_ENV: 'staging' }, true)).toBe('staging');
    expect(resolveDeploymentTier({ MAWARED_ENV: 'production' }, false)).toBe('production');
    // Unstated tier under a production build reads as production: fail closed.
    expect(resolveDeploymentTier({}, true)).toBe('production');
    expect(resolveDeploymentTier({}, false)).toBe('development');
  });

  it('accepts a fully configured production environment', () => {
    const report = inspectRuntimeConfig(VALID_ENV, { isProduction: true });
    expect(report.errors).toEqual([]);
  });

  it('refuses to start production without the required security material', () => {
    const report = inspectRuntimeConfig(
      { ...VALID_ENV, MFA_ENCRYPTION_KEY: undefined, PLATFORM_JWT_SECRET: undefined },
      { isProduction: true },
    );
    const names = report.errors.map((issue) => issue.variable);
    expect(names).toContain('MFA_ENCRYPTION_KEY');
    expect(names).toContain('PLATFORM_JWT_SECRET');
  });

  it('does not block a staging deploy over production-only material', () => {
    const report = inspectRuntimeConfig(
      {
        ...VALID_ENV,
        MAWARED_ENV: 'staging',
        MFA_ENCRYPTION_KEY: undefined,
        PLATFORM_JWT_SECRET: undefined,
      },
      { isProduction: true },
    );
    expect(report.errors).toEqual([]);
    const warned = report.warnings.map((issue) => issue.variable);
    expect(warned).toContain('MFA_ENCRYPTION_KEY');
    expect(warned).toContain('PLATFORM_JWT_SECRET');
  });

  it('still blocks any deployed tier when core material is missing', () => {
    const report = inspectRuntimeConfig(
      { ...VALID_ENV, MAWARED_ENV: 'staging', DATABASE_URL: undefined, JWT_SECRET: undefined },
      { isProduction: true },
    );
    const names = report.errors.map((issue) => issue.variable);
    expect(names).toContain('DATABASE_URL');
    expect(names).toContain('JWT_SECRET');
  });

  it('rejects a weak or reused signing secret on any deployed tier', () => {
    const shared = 'c'.repeat(48); // security-scan-allow: length fixture only
    const reused = inspectRuntimeConfig(
      { ...VALID_ENV, MAWARED_ENV: 'staging', JWT_SECRET: shared, PLATFORM_JWT_SECRET: shared },
      { isProduction: true },
    );
    expect(reused.errors.map((issue) => issue.problem).join(' '))
      .toMatch(/must not be identical/i);

    const weak = inspectRuntimeConfig(
      { ...VALID_ENV, JWT_SECRET: 'short' },
      { isProduction: true },
    );
    expect(weak.errors.map((issue) => issue.variable)).toContain('JWT_SECRET');
  });

  it('rejects an MFA key that is not exactly 32 bytes once decoded', () => {
    const report = inspectRuntimeConfig(
      { ...VALID_ENV, MFA_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') },
      { isProduction: true },
    );
    expect(report.errors.map((issue) => issue.variable)).toContain('MFA_ENCRYPTION_KEY');
  });

  it('rejects a wildcard or malformed CORS origin', () => {
    const wildcard = inspectRuntimeConfig(
      { ...VALID_ENV, CORS_ORIGINS: '*' },
      { isProduction: true },
    );
    expect(wildcard.errors.map((issue) => issue.problem).join(' ')).toMatch(/wildcard/i);

    const withPath = inspectRuntimeConfig(
      { ...VALID_ENV, CORS_ORIGINS: 'https://app.example.invalid/dashboard' },
      { isProduction: true },
    );
    expect(withPath.errors.map((issue) => issue.variable)).toContain('CORS_ORIGINS');
  });

  it('treats an unset CORS allow-list as deny-by-default, not an error', () => {
    const report = inspectRuntimeConfig(
      { ...VALID_ENV, CORS_ORIGINS: undefined },
      { isProduction: true },
    );
    expect(report.errors).toEqual([]);
    expect(report.warnings.map((issue) => issue.variable)).toContain('CORS_ORIGINS');
  });

  it('never blocks a development or test workflow', () => {
    const report = inspectRuntimeConfig({}, { isProduction: false });
    expect(report.errors).toEqual([]);
    // Demoted, not dropped: the operator still sees every finding.
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it('reports variable names and never their values', () => {
    const report = inspectRuntimeConfig(
      { ...VALID_ENV, JWT_SECRET: 'short', CORS_ORIGINS: '*' },
      { isProduction: true },
    );
    const rendered = formatRuntimeConfigIssues([...report.errors, ...report.warnings]).join(' ');
    expect(rendered).toContain('JWT_SECRET');
    expect(rendered).not.toContain('short');
    expect(rendered).not.toContain(VALID_ENV.DATABASE_URL);
    expect(rendered).not.toContain(VALID_ENV.MFA_ENCRYPTION_KEY);
  });

  it('throws on an invalid production environment so the instance never serves traffic', () => {
    const { logger, events } = makeRecordingLogger();
    expect(() => assertRuntimeConfig({}, { isProduction: true, logger }))
      .toThrow(RuntimeConfigError);
    expect(events()).toContain('startup.config_invalid');
  });

  it('records the resolved tier on the startup event', () => {
    const { logger, entries } = makeRecordingLogger();
    assertRuntimeConfig({ ...VALID_ENV, MAWARED_ENV: 'staging' }, { isProduction: true, logger });
    const validated = entries.find((entry) => entry.event === 'startup.config_validated');
    expect(validated?.fields.deploymentTier).toBe('staging');
  });

  it('carries no configuration value in the thrown error', () => {
    try {
      assertRuntimeConfig(
        { ...VALID_ENV, JWT_SECRET: 'weak-invalid-fixture' },
        { isProduction: true, logger: makeRecordingLogger().logger },
      );
      expect.unreachable('expected a RuntimeConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeConfigError);
      expect((error as Error).message).not.toContain('weak-invalid-fixture');
      expect((error as Error).message).toContain('JWT_SECRET');
    }
  });
});
