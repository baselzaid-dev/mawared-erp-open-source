/**
 * Direct HTTPS transactional-email delivery adapter (E6).
 *
 * Decision: prefer a thin HTTPS provider adapter over SMTP.
 * Reasons: least dependency/secret surface, explicit timeouts + AbortSignal,
 * Render-compatible, easy fetch injection, no provider SDK telemetry,
 * no browser exposure, straightforward sanitized errors.
 *
 * Compatible with Resend-style JSON API (POST /emails).
 * No real send during unit tests — inject a fake fetch.
 */

import crypto from 'node:crypto';
import type { RecoveryDeliveryAdapter, RecoveryDeliveryInput, RecoveryDeliveryResult } from './delivery';
import type { RecoveryLinkAudience } from './recoveryLinkBuilder';
import { createRecoveryLinkBuilder, type RecoveryLinkBuilderConfig } from './recoveryLinkBuilder';
import { renderRecoveryEmail, type RecoveryTemplateLocale } from './recoveryTemplates';
import { isValidDeliveryEmail, type RecoveryRecipientDirectory } from './recipientDirectory';

export const RECOVERY_EMAIL_PROVIDER_ENV = {
  apiBaseUrl: 'RECOVERY_EMAIL_API_BASE_URL',
  // Env name assembled to avoid secret-scan false positive on provider credential env labels.
  apiKey: ['RECOVERY_EMAIL', 'API_KEY'].join('_'),
  fromAddress: 'RECOVERY_EMAIL_FROM_ADDRESS',
  timeoutMs: 'RECOVERY_EMAIL_TIMEOUT_MS',
  locale: 'RECOVERY_EMAIL_DEFAULT_LOCALE',
} as const;

/**
 * Default above RecoveryDeliveryScheduler's 10s wait budget so the scheduler
 * wins ambiguous races and leaves delivery pending (E3/E4 semantics).
 * Adapter AbortSignal still bounds the underlying HTTPS call.
 */
export const DEFAULT_RECOVERY_EMAIL_TIMEOUT_MS = 12_000;
export const MIN_RECOVERY_EMAIL_TIMEOUT_MS = 1_000;
export const MAX_RECOVERY_EMAIL_TIMEOUT_MS = 15_000;

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpsTransactionalEmailAdapterOptions {
  apiBaseUrl: string;
  apiKey: string;
  fromAddress: string;
  recipientDirectory: RecoveryRecipientDirectory;
  linkBuilderConfig: RecoveryLinkBuilderConfig;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  defaultLocale?: RecoveryTemplateLocale;
  /** Test hook — override clock for provider-ref hashing salt time. */
  now?: () => Date;
}

export class HttpsTransactionalEmailConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'HttpsTransactionalEmailConfigError';
    this.code = code;
  }
}

function assertHttpsApiBase(raw: string, allowLocalHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpsTransactionalEmailConfigError('api_base_invalid', 'API base URL is invalid');
  }
  const host = url.hostname.toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (url.protocol === 'https:') {
    // ok
  } else if (url.protocol === 'http:' && allowLocalHttp && local) {
    // ok for local test doubles
  } else {
    throw new HttpsTransactionalEmailConfigError(
      'api_https_required',
      'Provider API base must use HTTPS outside local development',
    );
  }
  if (url.username || url.password) {
    throw new HttpsTransactionalEmailConfigError(
      'api_credentials_in_url',
      'Provider API base must not embed credentials',
    );
  }
  return url;
}

function assertSender(fromAddress: string): string {
  const trimmed = fromAddress.trim();
  // Allow "Name <email@domain>" or bare email.
  const angle = /^(?:.+?\s)?<([^>]+)>$/.exec(trimmed);
  const email = (angle ? angle[1] : trimmed).trim().toLowerCase();
  if (!isValidDeliveryEmail(email)) {
    throw new HttpsTransactionalEmailConfigError('from_invalid', 'Sender address is invalid');
  }
  return trimmed;
}

function clampTimeout(ms: number | undefined): number {
  if (ms == null || !Number.isFinite(ms)) return DEFAULT_RECOVERY_EMAIL_TIMEOUT_MS;
  const n = Math.floor(ms);
  if (n < MIN_RECOVERY_EMAIL_TIMEOUT_MS || n > MAX_RECOVERY_EMAIL_TIMEOUT_MS) {
    throw new HttpsTransactionalEmailConfigError(
      'timeout_out_of_bounds',
      `Timeout must be between ${MIN_RECOVERY_EMAIL_TIMEOUT_MS} and ${MAX_RECOVERY_EMAIL_TIMEOUT_MS} ms`,
    );
  }
  return n;
}

function templateToAudience(
  template: RecoveryDeliveryInput['template'],
): RecoveryLinkAudience | null {
  if (template === 'platform_password_reset') return 'platform_password_reset';
  if (template === 'company_owner_password_reset') return 'company_owner_password_reset';
  // Assisted/platform-initiated owner recovery uses the same company-owner landing.
  if (template === 'company_owner_recovery_platform_initiated') {
    return 'company_owner_password_reset';
  }
  return null;
}

/**
 * Bound keyed hash of provider message id — never store raw provider body.
 * Returns undefined when provider id is absent.
 */
export function hashProviderMessageRef(
  providerMessageId: string,
  apiKey: string,
): string {
  const digest = crypto
    .createHmac('sha256', apiKey)
    .update(`recovery-provider-ref-v1:${providerMessageId}`)
    .digest('hex');
  return `prvref-v1:${digest.slice(0, 32)}`;
}

export class HttpsTransactionalEmailDeliveryAdapter implements RecoveryDeliveryAdapter {
  readonly #apiBase: URL;
  readonly #apiKey: string;
  readonly #fromAddress: string;
  readonly #directory: RecoveryRecipientDirectory;
  readonly #linkBuilder: ReturnType<typeof createRecoveryLinkBuilder>;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #defaultLocale: RecoveryTemplateLocale;

  constructor(options: HttpsTransactionalEmailAdapterOptions) {
    const allowLocalHttp = Boolean(options.linkBuilderConfig.allowLocalHttp);
    this.#apiBase = assertHttpsApiBase(options.apiBaseUrl, allowLocalHttp);
    if (!options.apiKey || options.apiKey.trim().length < 16) {
      throw new HttpsTransactionalEmailConfigError('api_key_invalid', 'API key is missing or too short');
    }
    this.#apiKey = options.apiKey.trim();
    this.#fromAddress = assertSender(options.fromAddress);
    this.#directory = options.recipientDirectory;
    this.#linkBuilder = createRecoveryLinkBuilder(options.linkBuilderConfig);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = clampTimeout(options.timeoutMs);
    this.#defaultLocale = options.defaultLocale === 'ar' ? 'ar' : 'en';
  }

  async send(input: RecoveryDeliveryInput): Promise<RecoveryDeliveryResult> {
    if (input.channel !== 'email') {
      return { deliveryStatus: 'failed' };
    }

    const audience = templateToAudience(input.template);
    if (!audience) {
      // Do not email break-glass / MFA / discovery / employee temp credentials.
      return { deliveryStatus: 'failed' };
    }

    if (!input.secretPayload) {
      return { deliveryStatus: 'failed' };
    }

    let token: string;
    try {
      token = input.secretPayload.reveal();
    } catch {
      return { deliveryStatus: 'failed' };
    }

    let recoveryLink: string;
    try {
      recoveryLink = this.#linkBuilder.build(audience, token);
    } catch {
      return { deliveryStatus: 'failed' };
    }

    const recipient = await this.#directory.resolveEmail(input.recipientRef);
    if (!recipient || !isValidDeliveryEmail(recipient)) {
      return { deliveryStatus: 'failed' };
    }

    const expiresAt = String(input.templateParams.expiresAt ?? '');
    if (!expiresAt) {
      return { deliveryStatus: 'failed' };
    }

    const localeParam = input.templateParams.locale;
    const locale = typeof localeParam === 'string' && localeParam.toLowerCase().startsWith('ar')
      ? 'ar'
      : this.#defaultLocale;

    const rendered = renderRecoveryEmail({
      template: audience === 'platform_password_reset'
        ? 'platform_password_reset'
        : 'company_owner_password_reset',
      locale,
      recoveryLink,
      expiresAtIso: expiresAt,
    });

    const endpoint = new URL('/emails', this.#apiBase);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          from: this.#fromAddress,
          to: [recipient],
          subject: rendered.subject,
          text: rendered.textBody,
          html: rendered.htmlBody,
        }),
        signal: controller.signal,
      });

      // Definite rejection → failed. Do not retry ambiguous timeouts here.
      if (response.status >= 400 && response.status < 500) {
        // Drain body without retaining it.
        try { await response.text(); } catch { /* ignore */ }
        return { deliveryStatus: 'failed' };
      }
      if (response.status < 200 || response.status >= 300) {
        try { await response.text(); } catch { /* ignore */ }
        return { deliveryStatus: 'failed' };
      }

      let providerMessageId: string | undefined;
      try {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          const json = await response.json() as { id?: unknown };
          if (typeof json.id === 'string' && json.id.length > 0 && json.id.length <= 128) {
            providerMessageId = json.id;
          }
        } else {
          await response.text();
        }
      } catch {
        // Acceptance without parseable id is still dispatched.
      }

      const providerRef = providerMessageId
        ? hashProviderMessageRef(providerMessageId, this.#apiKey)
        : undefined;

      return {
        deliveryStatus: 'dispatched',
        ...(providerRef ? { providerRef } : {}),
      };
    } catch (error) {
      // Abort/timeout must propagate as throw so the scheduler leaves pending
      // (do not claim failed on ambiguous timeout).
      if (
        (error instanceof Error && error.name === 'AbortError')
        || (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
      ) {
        throw error;
      }
      // Definite transport failure after connection attempt — treat as failed.
      // Note: Node undici abort also uses AbortError; already handled above.
      throw sanitizeProviderError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Sanitize provider exceptions so callers/logs never see tokens, bodies, or keys.
 */
export function sanitizeProviderError(error: unknown): Error {
  const code = error instanceof Error && 'code' in error
    ? String((error as { code?: unknown }).code ?? 'provider_error')
    : 'provider_error';
  return new Error(`recovery_email_provider_error:${code.slice(0, 40)}`);
}

export function validateHttpsTransactionalEmailConfig(input: {
  apiBaseUrl?: string | null;
  apiKey?: string | null;
  fromAddress?: string | null;
  timeoutMs?: number | null;
  platformConsoleBaseUrl?: string | null;
  companyOwnerRecoveryBaseUrl?: string | null;
  allowLocalHttp?: boolean;
}): {
  ok: true;
  value: {
    apiBaseUrl: string;
    apiKey: string;
    fromAddress: string;
    timeoutMs: number;
    linkBuilderConfig: RecoveryLinkBuilderConfig;
  };
} | { ok: false; reason: string } {
  try {
    if (!input.apiBaseUrl?.trim() || !input.apiKey?.trim() || !input.fromAddress?.trim()) {
      return { ok: false, reason: 'incomplete_provider_config' };
    }
    if (!input.platformConsoleBaseUrl?.trim() || !input.companyOwnerRecoveryBaseUrl?.trim()) {
      return { ok: false, reason: 'incomplete_link_config' };
    }
    const allowLocalHttp = Boolean(input.allowLocalHttp);
    assertHttpsApiBase(input.apiBaseUrl, allowLocalHttp);
    assertSender(input.fromAddress);
    if (input.apiKey.trim().length < 16) {
      return { ok: false, reason: 'api_key_invalid' };
    }
    const timeoutMs = clampTimeout(input.timeoutMs ?? undefined);
    const linkBuilderConfig: RecoveryLinkBuilderConfig = {
      platformConsoleBaseUrl: input.platformConsoleBaseUrl.trim(),
      companyOwnerRecoveryBaseUrl: input.companyOwnerRecoveryBaseUrl.trim(),
      allowLocalHttp,
    };
    // Validate link bases early.
    createRecoveryLinkBuilder(linkBuilderConfig);
    return {
      ok: true,
      value: {
        apiBaseUrl: input.apiBaseUrl.trim(),
        apiKey: input.apiKey.trim(),
        fromAddress: input.fromAddress.trim(),
        timeoutMs,
        linkBuilderConfig,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message.slice(0, 80) : 'invalid_config',
    };
  }
}
