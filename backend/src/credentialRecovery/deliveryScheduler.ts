import type { RecoveryDeliveryAdapter } from './delivery';
import type { RecoveryResult } from './errors';
import type { CredentialRecoverySecret } from './tokenCrypto';

/**
 * Bounded fire-and-forget scheduler for public owner-recovery delivery.
 * Delivery latency must never participate in the enumeration-safe HTTP
 * response-latency path. All adapter errors are contained.
 *
 * Timeout does NOT cancel the adapter (no AbortSignal in the delivery contract)
 * and does NOT mark delivery failed — the durable row stays pending.
 *
 * Callers must treat RecoveryResult.ok === false as status_persistence_failed
 * (never claim dispatched/failed from a resolved failure).
 */

export type ScheduledDeliveryOutcome =
  | 'dispatched'
  | 'failed'
  | 'pending_timeout'
  | 'status_persistence_failed';

export interface ScheduledDeliveryTask {
  adapter: RecoveryDeliveryAdapter;
  service: {
    recordDeliveryStatus(input: {
      recoveryRequestId: string;
      deliveryStatus: 'dispatched' | 'failed';
      requestId: string;
      actorType?: 'anonymous' | 'platform_owner' | 'system';
      actorId?: string | null;
    }): Promise<RecoveryResult<{ recoveryRequestId: string; deliveryStatus: string }>>;
  };
  issued: {
    recoveryRequestId: string;
    deliverySecret: CredentialRecoverySecret | null;
    expiresAt: Date;
  };
  recipientRef: string;
  template:
    | 'company_owner_password_reset'
    | 'company_owner_recovery_platform_initiated'
    | 'platform_password_reset'
    | 'platform_account_discovery';
  requestId: string;
}

export interface RecoveryDeliverySchedulerOptions {
  /** Server-owned max concurrent deliveries. Default 4. */
  maxConcurrent?: number;
  /**
   * Server-owned per-task wait budget.
   * Timeout leaves deliveryStatus=pending (does not claim cancellation). Default 10s.
   */
  taskTimeoutMs?: number;
  /** Test hook to await queue drain deterministically. */
  onIdleChange?: (idle: boolean) => void;
}

export const DEFAULT_RECOVERY_DELIVERY_MAX_CONCURRENT = 4;
export const DEFAULT_RECOVERY_DELIVERY_TASK_TIMEOUT_MS = 10_000;

/** Bounded internal evidence — never includes secrets, emails, tokens, or raw results. */
export type ContainedSchedulerEvidence = {
  kind: 'status_persistence_failed' | 'unexpected';
  recoveryRequestId: string;
  requestId: string;
  adapterOutcome?: 'dispatched' | 'failed';
  reasonCode?: string;
};

export class RecoveryDeliveryScheduler {
  readonly #maxConcurrent: number;
  readonly #taskTimeoutMs: number;
  readonly #onIdleChange?: (idle: boolean) => void;
  #active = 0;
  #pending: Array<() => void> = [];
  #errors: Error[] = [];
  #evidence: ContainedSchedulerEvidence[] = [];
  #lastOutcomes: ScheduledDeliveryOutcome[] = [];

  constructor(options: RecoveryDeliverySchedulerOptions = {}) {
    this.#maxConcurrent = options.maxConcurrent ?? DEFAULT_RECOVERY_DELIVERY_MAX_CONCURRENT;
    this.#taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_RECOVERY_DELIVERY_TASK_TIMEOUT_MS;
    this.#onIdleChange = options.onIdleChange;
  }

  /** Schedule delivery without blocking the caller. Returns immediately. */
  schedule(task: ScheduledDeliveryTask): void {
    const run = async (): Promise<void> => {
      let secret = task.issued.deliverySecret;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      let outcome: ScheduledDeliveryOutcome = 'failed';

      try {
        const sendPromise = task.adapter.send({
          channel: 'email',
          recipientRef: task.recipientRef,
          template: task.template,
          templateParams: { expiresAt: task.issued.expiresAt.toISOString() },
          secretPayload: secret,
        }).then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        const raced = await Promise.race([
          sendPromise,
          new Promise<'timeout'>((resolve) => {
            timeoutHandle = setTimeout(() => resolve('timeout'), this.#taskTimeoutMs);
          }),
        ]);

        if (raced === 'timeout') {
          // Do not claim failed or cancel the adapter; it may still complete.
          // Contain late settlement; never write a second status later.
          void sendPromise.then(() => undefined, () => undefined);
          outcome = 'pending_timeout';
          this.#lastOutcomes.push(outcome);
          return;
        }

        if (raced.ok === false) {
          // Ambiguous AbortError/timeout from adapter must not claim failed —
          // leave durable status pending (same as scheduler wait-budget timeout).
          const err = raced.error;
          const isAbort = err instanceof Error && err.name === 'AbortError';
          if (isAbort) {
            outcome = 'pending_timeout';
            this.#lastOutcomes.push(outcome);
            return;
          }
        }

        const adapterOutcome: 'dispatched' | 'failed' = raced.ok === false
          ? 'failed'
          : raced.result.deliveryStatus === 'dispatched'
            ? 'dispatched'
            : 'failed';

        let persistResult: RecoveryResult<{ recoveryRequestId: string; deliveryStatus: string }>;
        try {
          persistResult = await task.service.recordDeliveryStatus({
            recoveryRequestId: task.issued.recoveryRequestId,
            deliveryStatus: adapterOutcome,
            requestId: task.requestId,
            actorType: 'system',
            actorId: null,
          });
        } catch {
          outcome = 'status_persistence_failed';
          this.#evidence.push({
            kind: 'status_persistence_failed',
            recoveryRequestId: task.issued.recoveryRequestId,
            requestId: task.requestId,
            adapterOutcome,
            reasonCode: 'persist_threw',
          });
          this.#lastOutcomes.push(outcome);
          return;
        }

        if (persistResult.ok === false) {
          outcome = 'status_persistence_failed';
          this.#evidence.push({
            kind: 'status_persistence_failed',
            recoveryRequestId: task.issued.recoveryRequestId,
            requestId: task.requestId,
            adapterOutcome,
            reasonCode: persistResult.reason,
          });
          this.#lastOutcomes.push(outcome);
          return;
        }

        outcome = adapterOutcome;
        this.#lastOutcomes.push(outcome);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        secret = null;
      }
    };

    const execute = async (): Promise<void> => {
      this.#active += 1;
      this.#emitIdle();
      try {
        await run();
      } catch (error) {
        // Contain every failure; never emit an unhandled rejection.
        this.#errors.push(error instanceof Error ? error : new Error(String(error)));
        this.#evidence.push({
          kind: 'unexpected',
          recoveryRequestId: task.issued.recoveryRequestId,
          requestId: task.requestId,
          reasonCode: 'unexpected_scheduler_error',
        });
      } finally {
        this.#active -= 1;
        this.#drain();
        this.#emitIdle();
      }
    };

    if (this.#active < this.#maxConcurrent) {
      void execute();
    } else {
      this.#pending.push(() => void execute());
    }
  }

  #drain(): void {
    if (this.#active >= this.#maxConcurrent) return;
    const next = this.#pending.shift();
    if (next) next();
  }

  #emitIdle(): void {
    this.#onIdleChange?.(this.#active === 0 && this.#pending.length === 0);
  }

  /** Test-only: wait until the queue is empty. */
  async waitForIdle(timeoutMs = 5_000): Promise<void> {
    const started = Date.now();
    while (this.#active > 0 || this.#pending.length > 0) {
      if (Date.now() - started > timeoutMs) {
        throw new Error('recovery delivery scheduler did not become idle');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Test-only: captured contained errors. */
  get containedErrors(): readonly Error[] {
    return this.#errors;
  }

  /** Test-only: bounded internal evidence (no secrets). */
  get containedEvidence(): readonly ContainedSchedulerEvidence[] {
    return this.#evidence;
  }

  /** Test-only: recorded task outcomes in order. */
  get lastOutcomes(): readonly ScheduledDeliveryOutcome[] {
    return this.#lastOutcomes;
  }
}
