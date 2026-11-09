/**
 * One-time recovery package emission boundary.
 * Raw package must never appear in logs, audit, errors, or JSON reports.
 */

import util from 'node:util';
import { stdout as defaultStdout } from 'node:process';
import {
  CredentialRecoverySecret,
} from '../credentialRecovery/tokenCrypto';

const PACKAGE_REDACTED = '[RecoveryPackage]';

export class RecoveryPackageSecret {
  readonly #inner: CredentialRecoverySecret;

  constructor(value: string) {
    this.#inner = new CredentialRecoverySecret(value);
  }

  reveal(): string {
    return this.#inner.reveal();
  }

  toJSON(): string {
    return PACKAGE_REDACTED;
  }

  toString(): string {
    return PACKAGE_REDACTED;
  }

  [util.inspect.custom](): string {
    return PACKAGE_REDACTED;
  }
}

export interface RecoveryPackageEmitter {
  /**
   * Emit the package exactly once after a successful database commit.
   * Must not write to ordinary logs.
   */
  emit(packageSecret: RecoveryPackageSecret): Promise<void>;
}

/**
 * Production emitter: interactive stdout only, once.
 */
export class TtyRecoveryPackageEmitter implements RecoveryPackageEmitter {
  readonly #stdout: NodeJS.WriteStream;
  #emitted = false;

  constructor(stdout: NodeJS.WriteStream = defaultStdout) {
    this.#stdout = stdout;
  }

  async emit(packageSecret: RecoveryPackageSecret): Promise<void> {
    if (this.#emitted) {
      throw new Error('Recovery package already emitted');
    }
    if (!this.#stdout.isTTY) {
      throw new Error('Recovery package emission requires an interactive terminal');
    }
    this.#emitted = true;
    const raw = packageSecret.reveal();
    this.#stdout.write(
      [
        '',
        '=== ONE-TIME PLATFORM RECOVERY PACKAGE (display once) ===',
        raw,
        '=== END PACKAGE — store offline; not retrievable from server ===',
        '',
      ].join('\n'),
    );
  }
}

/**
 * Test-only capturing emitter. inspect/toJSON redact contents.
 */
export class CapturingRecoveryPackageEmitter implements RecoveryPackageEmitter {
  #captured: RecoveryPackageSecret | null = null;
  #emitCount = 0;

  async emit(packageSecret: RecoveryPackageSecret): Promise<void> {
    this.#emitCount += 1;
    this.#captured = packageSecret;
  }

  get emitCount(): number {
    return this.#emitCount;
  }

  /** Explicit test unwrap — never used by production paths. */
  revealForTest(): string | null {
    return this.#captured?.reveal() ?? null;
  }

  toJSON(): { emitCount: number; package: string } {
    return { emitCount: this.#emitCount, package: PACKAGE_REDACTED };
  }

  [util.inspect.custom](): string {
    return `CapturingRecoveryPackageEmitter(emitCount=${this.#emitCount}, package=${PACKAGE_REDACTED})`;
  }
}

/** Emitter that fails after commit — used to prove residual operational risk handling. */
export class FailingRecoveryPackageEmitter implements RecoveryPackageEmitter {
  async emit(): Promise<void> {
    throw new Error('Recovery package emitter failed after commit');
  }
}
