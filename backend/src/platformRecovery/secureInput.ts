/**
 * Secure offline authorization input for E5 CLI.
 * Never accepts secrets via argv, environment variables, or ordinary config.
 */

import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';

export class SecureOfflineInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SecureOfflineInputError';
    this.code = code;
  }
}

export interface SecureOfflineAuthorizationReader {
  /**
   * Read a secret with echo disabled on a true interactive TTY.
   * Implementations must never log or echo the value.
   */
  readSecret(prompt: string, options?: { timeoutMs?: number }): Promise<string>;

  /** Whether this reader can operate in the current process/TTY. */
  isAvailable(): boolean;
}

export interface TtySecureOfflineAuthorizationReaderOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Default timeout for interactive reads. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Node TTY reader using setRawMode + manual character collection.
 * Supported when stdin is a TTY and setRawMode is available (Windows + POSIX Node).
 * Non-TTY and missing setRawMode fail closed — no visible readline fallback.
 */
export class TtySecureOfflineAuthorizationReader
  implements SecureOfflineAuthorizationReader
{
  readonly #stdin: NodeJS.ReadStream;
  readonly #stdout: NodeJS.WriteStream;
  readonly #timeoutMs: number;

  constructor(options: TtySecureOfflineAuthorizationReaderOptions = {}) {
    this.#stdin = options.stdin ?? defaultStdin;
    this.#stdout = options.stdout ?? defaultStdout;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  isAvailable(): boolean {
    return Boolean(
      this.#stdin.isTTY
      && typeof this.#stdin.setRawMode === 'function'
      && this.#stdout.isTTY,
    );
  }

  async readSecret(prompt: string, options?: { timeoutMs?: number }): Promise<string> {
    if (!this.isAvailable()) {
      throw new SecureOfflineInputError(
        'secure_input_unavailable',
        'Secure offline authorization requires an interactive TTY with echo disabled',
      );
    }

    const timeoutMs = options?.timeoutMs ?? this.#timeoutMs;
    this.#stdout.write(prompt);

    const previousRaw = this.#stdin.isRaw === true;
    this.#stdin.setRawMode(true);
    this.#stdin.resume();
    this.#stdin.setEncoding('utf8');

    const chars: string[] = [];
    let settled = false;

    try {
      const value = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new SecureOfflineInputError(
            'secure_input_timeout',
            'Secure offline authorization input timed out',
          ));
        }, timeoutMs);

        const onData = (chunk: string | Buffer) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          for (const ch of text) {
            const code = ch.charCodeAt(0);
            // Ctrl+C
            if (code === 3) {
              cleanup();
              reject(new SecureOfflineInputError(
                'secure_input_interrupted',
                'Secure offline authorization input interrupted',
              ));
              return;
            }
            // Ctrl+D / EOT with empty buffer
            if (code === 4 && chars.length === 0) {
              cleanup();
              reject(new SecureOfflineInputError(
                'secure_input_eof',
                'Secure offline authorization input ended unexpectedly',
              ));
              return;
            }
            // Enter
            if (ch === '\r' || ch === '\n') {
              cleanup();
              resolve(chars.join(''));
              return;
            }
            // Backspace
            if (code === 127 || code === 8) {
              chars.pop();
              continue;
            }
            // Ignore other controls
            if (code < 32) continue;
            chars.push(ch);
          }
        };

        const cleanup = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.#stdin.off('data', onData);
        };

        this.#stdin.on('data', onData);
      });

      this.#stdout.write('\n');
      if (!value) {
        throw new SecureOfflineInputError(
          'secure_input_empty',
          'Secure offline authorization input was empty',
        );
      }
      return value;
    } finally {
      try {
        this.#stdin.setRawMode(previousRaw);
      } catch {
        // ignore restore failures
      }
      // Best-effort clear of collected characters from the local array.
      for (let i = 0; i < chars.length; i += 1) chars[i] = '\0';
      chars.length = 0;
    }
  }
}

/** Test-only reader that never touches a real TTY. */
export class InjectedSecureOfflineAuthorizationReader
  implements SecureOfflineAuthorizationReader
{
  readonly #values: string[];
  #index = 0;

  constructor(values: string[]) {
    this.#values = [...values];
  }

  isAvailable(): boolean {
    return true;
  }

  async readSecret(_prompt: string): Promise<string> {
    if (this.#index >= this.#values.length) {
      throw new SecureOfflineInputError(
        'secure_input_exhausted',
        'Injected secure input has no remaining values',
      );
    }
    const value = this.#values[this.#index];
    this.#index += 1;
    // Overwrite slot after read for test hygiene.
    this.#values[this.#index - 1] = '';
    if (!value) {
      throw new SecureOfflineInputError(
        'secure_input_empty',
        'Secure offline authorization input was empty',
      );
    }
    return value;
  }
}

/** Always-unavailable reader used to prove non-TTY fail-closed behavior. */
export class UnavailableSecureOfflineAuthorizationReader
  implements SecureOfflineAuthorizationReader
{
  isAvailable(): boolean {
    return false;
  }

  async readSecret(_prompt?: string): Promise<string> {
    throw new SecureOfflineInputError(
      'secure_input_unavailable',
      'Secure offline authorization requires an interactive TTY with echo disabled',
    );
  }
}
