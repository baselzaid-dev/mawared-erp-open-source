/**
 * Fail-closed recovery delivery construction (E6).
 *
 * Production: concrete HTTPS adapter only when complete validated config is present.
 * Otherwise: UnavailableRecoveryDeliveryAdapter (explicit fail-closed delivery —
 * never silently mock-dispatch). Incomplete Production config with
 * RECOVERY_EMAIL_REQUIRE_PROVIDER=true refuses process construction.
 */

import type { PrismaClient } from '@prisma/client';
import {
  UnavailableRecoveryDeliveryAdapter,
  type RecoveryDeliveryAdapter,
} from './delivery';
import {
  HttpsTransactionalEmailDeliveryAdapter,
  RECOVERY_EMAIL_PROVIDER_ENV,
  validateHttpsTransactionalEmailConfig,
  type FetchLike,
} from './httpsTransactionalEmailAdapter';
import { createPrismaRecoveryRecipientDirectory } from './recipientDirectory';

export const RECOVERY_PLATFORM_CONSOLE_BASE_URL_ENV = 'RECOVERY_PLATFORM_CONSOLE_BASE_URL';
export const RECOVERY_COMPANY_OWNER_LINK_BASE_URL_ENV = 'RECOVERY_COMPANY_OWNER_LINK_BASE_URL';
export const RECOVERY_EMAIL_REQUIRE_PROVIDER_ENV = 'RECOVERY_EMAIL_REQUIRE_PROVIDER';
export const RECOVERY_EMAIL_ALLOWED_HOSTS_ENV = 'RECOVERY_EMAIL_ALLOWED_HOSTS';

export interface CreateRecoveryDeliveryAdapterInput {
  prisma?: PrismaClient | null;
  isProduction?: boolean;
  allowLocalHttp?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** Injected adapter for tests — bypasses env construction. */
  overrideAdapter?: RecoveryDeliveryAdapter | null;
}

export type RecoveryDeliveryConstruction =
  | {
    adapter: RecoveryDeliveryAdapter;
    mode: 'https_transactional_email' | 'unavailable';
    reason?: string;
  };

/**
 * Construct the production-capable delivery adapter or an explicit unavailable adapter.
 * Never returns a mock/capturing adapter from this path.
 */
export function createRecoveryDeliveryAdapterFromEnv(
  input: CreateRecoveryDeliveryAdapterInput = {},
): RecoveryDeliveryConstruction {
  if (input.overrideAdapter) {
    return { adapter: input.overrideAdapter, mode: 'https_transactional_email' };
  }

  const env = input.env ?? process.env;
  const isProduction = Boolean(input.isProduction);
  const allowLocalHttp = input.allowLocalHttp ?? !isProduction;
  const requireProvider = (env[RECOVERY_EMAIL_REQUIRE_PROVIDER_ENV] ?? '')
    .trim()
    .toLowerCase() === 'true';

  const validated = validateHttpsTransactionalEmailConfig({
    apiBaseUrl: env[RECOVERY_EMAIL_PROVIDER_ENV.apiBaseUrl],
    apiKey: env[RECOVERY_EMAIL_PROVIDER_ENV.apiKey],
    fromAddress: env[RECOVERY_EMAIL_PROVIDER_ENV.fromAddress],
    timeoutMs: env[RECOVERY_EMAIL_PROVIDER_ENV.timeoutMs]
      ? Number(env[RECOVERY_EMAIL_PROVIDER_ENV.timeoutMs])
      : undefined,
    platformConsoleBaseUrl: env[RECOVERY_PLATFORM_CONSOLE_BASE_URL_ENV],
    companyOwnerRecoveryBaseUrl: env[RECOVERY_COMPANY_OWNER_LINK_BASE_URL_ENV],
    allowLocalHttp,
  });

  if (validated.ok === false) {
    const reason = validated.reason;
    if (isProduction && requireProvider) {
      throw new Error(
        `recovery_email_provider_required:${reason}`,
      );
    }
    return {
      adapter: new UnavailableRecoveryDeliveryAdapter(),
      mode: 'unavailable',
      reason,
    };
  }

  if (!input.prisma) {
    if (isProduction && requireProvider) {
      throw new Error('recovery_email_provider_required:recipient_directory_unavailable');
    }
    return {
      adapter: new UnavailableRecoveryDeliveryAdapter(),
      mode: 'unavailable',
      reason: 'recipient_directory_unavailable',
    };
  }

  const allowedHostsRaw = env[RECOVERY_EMAIL_ALLOWED_HOSTS_ENV];
  const allowedHosts = allowedHostsRaw
    ? allowedHostsRaw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
    : undefined;

  const localeRaw = (env[RECOVERY_EMAIL_PROVIDER_ENV.locale] ?? 'en').trim().toLowerCase();
  const defaultLocale = localeRaw.startsWith('ar') ? 'ar' as const : 'en' as const;

  const adapter = new HttpsTransactionalEmailDeliveryAdapter({
    apiBaseUrl: validated.value.apiBaseUrl,
    apiKey: validated.value.apiKey,
    fromAddress: validated.value.fromAddress,
    timeoutMs: validated.value.timeoutMs,
    recipientDirectory: createPrismaRecoveryRecipientDirectory(input.prisma),
    linkBuilderConfig: {
      ...validated.value.linkBuilderConfig,
      allowLocalHttp,
      allowedHosts,
    },
    fetchImpl: input.fetchImpl,
    defaultLocale,
  });

  return { adapter, mode: 'https_transactional_email' };
}
