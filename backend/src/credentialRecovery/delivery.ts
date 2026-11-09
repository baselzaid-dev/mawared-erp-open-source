import util from 'node:util';
import { CredentialRecoverySecret } from './tokenCrypto';
import type { RecoveryDeliveryChannel, RecoveryDeliveryStatus } from './contracts';

export const RECOVERY_DELIVERY_TEMPLATES = [
  'platform_password_reset',
  'platform_account_discovery',
  'platform_mfa_recovery',
  'company_owner_password_reset',
  'company_owner_recovery_platform_initiated',
  'employee_credentials_reset',
] as const;
export type RecoveryDeliveryTemplate = (typeof RECOVERY_DELIVERY_TEMPLATES)[number];

export interface RecoveryDeliveryInput {
  channel: RecoveryDeliveryChannel;
  /** Opaque recipient reference resolved inside the adapter — never log raw contact. */
  recipientRef: string;
  template: RecoveryDeliveryTemplate;
  /** Non-secret display parameters only (e.g. expiresAt ISO). */
  templateParams: Record<string, string | number | boolean>;
  /** Secret payload through the explicit secret boundary, or null. */
  secretPayload: CredentialRecoverySecret | null;
}

export interface RecoveryDeliveryResult {
  deliveryStatus: Extract<RecoveryDeliveryStatus, 'dispatched' | 'failed'>;
  /** Provider-internal transient reference — never persist beyond delivery-status tracking. */
  providerRef?: string;
}

/**
 * Provider-neutral delivery interface.
 * E1 ships the contract only — no production SMTP/SMS/push adapter.
 */
export interface RecoveryDeliveryAdapter {
  send(input: RecoveryDeliveryInput): Promise<RecoveryDeliveryResult>;
}

/**
 * Default production adapter when no provider is configured.
 * Always returns normalized failure — never performs network I/O.
 */
export class UnavailableRecoveryDeliveryAdapter implements RecoveryDeliveryAdapter {
  async send(_input: RecoveryDeliveryInput): Promise<RecoveryDeliveryResult> {
    return { deliveryStatus: 'failed' };
  }
}

const CAPTURE_INSPECT = '[CapturingRecoveryDeliveryAdapter]';

/**
 * Test-only capturing adapter. Do not use in production paths.
 * Secrets are never printed; consume only through consumeLastSecret().
 */
export class CapturingRecoveryDeliveryAdapter implements RecoveryDeliveryAdapter {
  readonly sent: Array<{
    channel: RecoveryDeliveryChannel;
    recipientRef: string;
    template: RecoveryDeliveryTemplate;
    templateParams: Record<string, string | number | boolean>;
    hadSecret: boolean;
  }> = [];

  #secrets: CredentialRecoverySecret[] = [];
  #nextStatus: Extract<RecoveryDeliveryStatus, 'dispatched' | 'failed'> = 'dispatched';
  #throwOnSend: Error | null = null;

  setNextStatus(status: Extract<RecoveryDeliveryStatus, 'dispatched' | 'failed'>): void {
    this.#nextStatus = status;
  }

  throwOnNextSend(error: Error): void {
    this.#throwOnSend = error;
  }

  async send(input: RecoveryDeliveryInput): Promise<RecoveryDeliveryResult> {
    if (this.#throwOnSend) {
      const error = this.#throwOnSend;
      this.#throwOnSend = null;
      throw error;
    }
    this.sent.push({
      channel: input.channel,
      recipientRef: input.recipientRef,
      template: input.template,
      templateParams: { ...input.templateParams },
      hadSecret: input.secretPayload != null,
    });
    if (input.secretPayload) {
      this.#secrets.push(input.secretPayload);
    }
    return { deliveryStatus: this.#nextStatus };
  }

  /** Explicit test-only secret unwrap. Never log the returned value. */
  consumeLastSecret(): string | null {
    const secret = this.#secrets.pop() ?? null;
    return secret ? secret.reveal() : null;
  }

  consumeAllSecrets(): string[] {
    const values = this.#secrets.map((secret) => secret.reveal());
    this.#secrets = [];
    return values;
  }

  get deliveryCount(): number {
    return this.sent.length;
  }

  toJSON(): string {
    return CAPTURE_INSPECT;
  }

  toString(): string {
    return CAPTURE_INSPECT;
  }

  [util.inspect.custom](): string {
    return CAPTURE_INSPECT;
  }
}

/**
 * @deprecated Prefer CapturingRecoveryDeliveryAdapter for secret-safe tests.
 * Kept for existing E1 unit fixtures.
 */
export class RecordingRecoveryDeliveryAdapter implements RecoveryDeliveryAdapter {
  readonly sent: Array<{
    channel: RecoveryDeliveryChannel;
    recipientRef: string;
    template: RecoveryDeliveryTemplate;
    templateParams: Record<string, string | number | boolean>;
    hadSecret: boolean;
  }> = [];

  async send(input: RecoveryDeliveryInput): Promise<RecoveryDeliveryResult> {
    this.sent.push({
      channel: input.channel,
      recipientRef: input.recipientRef,
      template: input.template,
      templateParams: { ...input.templateParams },
      hadSecret: input.secretPayload != null,
    });
    return { deliveryStatus: 'dispatched', providerRef: 'test-recording' };
  }
}
