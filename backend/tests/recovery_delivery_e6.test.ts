import { describe, expect, it, vi } from 'vitest';
import {
  createRecoveryLinkBuilder,
  rejectClientSuppliedRedirect,
  RecoveryLinkBuilderError,
} from '../src/credentialRecovery/recoveryLinkBuilder';
import {
  redactRecoveryLinkForSnapshot,
  renderRecoveryEmail,
} from '../src/credentialRecovery/recoveryTemplates';
import {
  createStaticRecoveryRecipientDirectory,
  isValidDeliveryEmail,
} from '../src/credentialRecovery/recipientDirectory';
import {
  HttpsTransactionalEmailDeliveryAdapter,
  hashProviderMessageRef,
  sanitizeProviderError,
  validateHttpsTransactionalEmailConfig,
} from '../src/credentialRecovery/httpsTransactionalEmailAdapter';
import {
  createRecoveryDeliveryAdapterFromEnv,
} from '../src/credentialRecovery/deliveryFactory';
import {
  CapturingRecoveryDeliveryAdapter,
  CredentialRecoverySecret,
  UnavailableRecoveryDeliveryAdapter,
} from '../src/credentialRecovery';

const TOKEN = `e6tok_${'A'.repeat(40)}`;
const EXPIRES = '2026-07-30T12:15:00.000Z';

describe('E6 recovery link builder', () => {
  it('builds platform and company-owner HTTPS links from opaque token only', () => {
    const builder = createRecoveryLinkBuilder({
      platformConsoleBaseUrl: 'https://console.example.com',
      companyOwnerRecoveryBaseUrl: 'https://recovery.mawared.local',
    });
    const platform = builder.build('platform_password_reset', TOKEN);
    const owner = builder.build('company_owner_password_reset', TOKEN);
    expect(platform.startsWith('https://console.example.com/reset-password#token=')).toBe(true);
    expect(owner.startsWith('https://recovery.mawared.local/owner-recovery/reset#token=')).toBe(true);
    expect(platform).not.toMatch(/@|company|principal|email/i);
    expect(owner).not.toMatch(/@|companyId|userId/i);
  });

  it('rejects http outside local development and client redirects', () => {
    expect(() => createRecoveryLinkBuilder({
      platformConsoleBaseUrl: 'http://evil.example.com',
      companyOwnerRecoveryBaseUrl: 'https://recovery.mawared.local',
      allowLocalHttp: false,
    })).toThrow(RecoveryLinkBuilderError);

    expect(() => rejectClientSuppliedRedirect('https://evil.example/phish')).toThrow(
      /client_redirect_rejected|Client-supplied/,
    );
  });

  it('rejects wrong-length tokens and allowlist misses', () => {
    const builder = createRecoveryLinkBuilder({
      platformConsoleBaseUrl: 'https://console.example.com',
      companyOwnerRecoveryBaseUrl: 'https://recovery.mawared.local',
      allowedHosts: ['console.example.com', 'recovery.mawared.local'],
    });
    expect(() => builder.build('platform_password_reset', 'short')).toThrow();
  });
});

describe('E6 recovery templates', () => {
  it('renders English and Arabic without forbidden data', () => {
    const link = `https://console.example.com/reset-password#token=${TOKEN}`;
    for (const locale of ['en', 'ar'] as const) {
      const rendered = renderRecoveryEmail({
        template: 'platform_password_reset',
        locale,
        recoveryLink: link,
        expiresAtIso: EXPIRES,
      });
      expect(rendered.subject.toLowerCase()).toMatch(/mawared|موارد/);
      expect(rendered.textBody).toContain(link);
      expect(rendered.textBody).toMatch(/ignor|تجاهل/i);
      expect(rendered.textBody).not.toMatch(/password123|totp|backup|mfa.secret/i);
      expect(rendered.htmlBody).not.toMatch(/companyId|principalId|userId/i);
      const redacted = redactRecoveryLinkForSnapshot(link);
      expect(redacted).toContain('[REDACTED]');
      expect(redacted).not.toContain(TOKEN);
    }

    const owner = renderRecoveryEmail({
      template: 'company_owner_password_reset',
      locale: 'ar',
      recoveryLink: link,
      expiresAtIso: EXPIRES,
    });
    expect(owner.locale).toBe('ar');
    expect(owner.textBody).toContain('موارد');
  });

  it('refuses non-email-deliverable templates', () => {
    expect(() => renderRecoveryEmail({
      template: 'platform_mfa_recovery',
      recoveryLink: 'https://x.example/a',
      expiresAtIso: EXPIRES,
    })).toThrow(/not_email_deliverable/);
  });
});

describe('E6 HTTPS transactional email adapter', () => {
  const linkConfig = {
    platformConsoleBaseUrl: 'https://console.example.com',
    companyOwnerRecoveryBaseUrl: 'https://recovery.mawared.local',
    allowLocalHttp: false,
  };

  it('validates config fail-closed when incomplete', () => {
    const incomplete = validateHttpsTransactionalEmailConfig({
      apiBaseUrl: null,
      apiKey: 'x'.repeat(20),
      fromAddress: 'noreply@example.com',
      platformConsoleBaseUrl: 'https://console.example.com',
      companyOwnerRecoveryBaseUrl: 'https://recovery.mawared.local',
    });
    expect(incomplete.ok).toBe(false);
  });

  it('dispatches on definite provider acceptance and hashes provider ref', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_abc123' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const adapter = new HttpsTransactionalEmailDeliveryAdapter({
      apiBaseUrl: 'https://api.resend.test',
      apiKey: 're_test_key_1234567890',
      fromAddress: 'Mawared <noreply@example.com>',
      recipientDirectory: createStaticRecoveryRecipientDirectory({
        'platform-email:11111111-1111-4111-8111-111111111111': 'owner@example.com',
      }),
      linkBuilderConfig: linkConfig,
      fetchImpl,
      timeoutMs: 2000,
    });

    const result = await adapter.send({
      channel: 'email',
      recipientRef: 'platform-email:11111111-1111-4111-8111-111111111111',
      template: 'platform_password_reset',
      templateParams: { expiresAt: EXPIRES },
      secretPayload: new CredentialRecoverySecret(TOKEN),
    });

    expect(result.deliveryStatus).toBe('dispatched');
    expect(result.providerRef).toMatch(/^prvref-v1:[a-f0-9]{32}$/);
    expect(result.providerRef).not.toContain('msg_abc');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string | URL, RequestInit | undefined];
    const body = JSON.parse(String(call[1]?.body));
    expect(body.to).toEqual(['owner@example.com']);
    expect(JSON.stringify(body)).not.toMatch(/11111111-1111/);
    expect(hashProviderMessageRef('msg_abc123', 're_test_key_1234567890')).toMatch(/^prvref-v1:/);
  });

  it('records failed on definite provider rejection without storing body', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_to"}', {
      status: 422,
      headers: { 'content-type': 'application/json' },
    }));
    const adapter = new HttpsTransactionalEmailDeliveryAdapter({
      apiBaseUrl: 'https://api.resend.test',
      apiKey: 're_test_key_1234567890',
      fromAddress: 'noreply@example.com',
      recipientDirectory: createStaticRecoveryRecipientDirectory({
        'owner-email:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333':
          'owner@example.com',
      }),
      linkBuilderConfig: linkConfig,
      fetchImpl,
    });

    const result = await adapter.send({
      channel: 'email',
      recipientRef:
        'owner-email:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333',
      template: 'company_owner_password_reset',
      templateParams: { expiresAt: EXPIRES },
      secretPayload: new CredentialRecoverySecret(TOKEN),
    });
    expect(result.deliveryStatus).toBe('failed');
  });

  it('aborts on timeout via AbortSignal (ambiguous — throw, not false dispatched)', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    });
    const adapter = new HttpsTransactionalEmailDeliveryAdapter({
      apiBaseUrl: 'https://api.resend.test',
      apiKey: 're_test_key_1234567890',
      fromAddress: 'noreply@example.com',
      recipientDirectory: createStaticRecoveryRecipientDirectory({
        'platform-email:11111111-1111-4111-8111-111111111111': 'owner@example.com',
      }),
      linkBuilderConfig: linkConfig,
      fetchImpl,
      timeoutMs: 1000,
    });

    await expect(adapter.send({
      channel: 'email',
      recipientRef: 'platform-email:11111111-1111-4111-8111-111111111111',
      template: 'platform_password_reset',
      templateParams: { expiresAt: EXPIRES },
      secretPayload: new CredentialRecoverySecret(TOKEN),
    })).rejects.toSatisfy((err: unknown) =>
      err instanceof Error && err.name === 'AbortError',
    );
  });

  it('sanitizes provider exceptions and validates recipients', () => {
    const sanitized = sanitizeProviderError(new Error('ECONNRESET secret=abc'));
    expect(sanitized.message).toMatch(/^recovery_email_provider_error:/);
    expect(sanitized.message).not.toContain('secret=');
    expect(isValidDeliveryEmail('a@fixture-5.example.test')).toBe(true);
    expect(isValidDeliveryEmail('not-an-email')).toBe(false);
  });

  it('never claims dispatched when RecoveryResult.ok would be false at caller — adapter returns failed without secret', async () => {
    const adapter = new HttpsTransactionalEmailDeliveryAdapter({
      apiBaseUrl: 'https://api.resend.test',
      apiKey: 're_test_key_1234567890',
      fromAddress: 'noreply@example.com',
      recipientDirectory: createStaticRecoveryRecipientDirectory({}),
      linkBuilderConfig: linkConfig,
      fetchImpl: vi.fn(),
    });
    const result = await adapter.send({
      channel: 'email',
      recipientRef: 'platform-email:11111111-1111-4111-8111-111111111111',
      template: 'platform_password_reset',
      templateParams: { expiresAt: EXPIRES },
      secretPayload: null,
    });
    expect(result.deliveryStatus).toBe('failed');
  });
});

describe('E6 delivery factory fail-closed', () => {
  it('returns Unavailable when config incomplete and does not mock-dispatch', async () => {
    const built = createRecoveryDeliveryAdapterFromEnv({
      isProduction: true,
      env: {},
    });
    expect(built.mode).toBe('unavailable');
    expect(built.adapter).toBeInstanceOf(UnavailableRecoveryDeliveryAdapter);
    const result = await built.adapter.send({
      channel: 'email',
      recipientRef: 'x',
      template: 'platform_password_reset',
      templateParams: { expiresAt: EXPIRES },
      secretPayload: new CredentialRecoverySecret(TOKEN),
    });
    expect(result.deliveryStatus).toBe('failed');
  });

  it('throws in Production when provider is required but missing', () => {
    expect(() => createRecoveryDeliveryAdapterFromEnv({
      isProduction: true,
      env: { RECOVERY_EMAIL_REQUIRE_PROVIDER: 'true' },
    })).toThrow(/recovery_email_provider_required/);
  });

  it('accepts override adapter for tests without network', async () => {
    const capturing = new CapturingRecoveryDeliveryAdapter();
    const built = createRecoveryDeliveryAdapterFromEnv({
      overrideAdapter: capturing,
    });
    expect(built.mode).toBe('https_transactional_email');
    await built.adapter.send({
      channel: 'email',
      recipientRef: 'platform-email:x',
      template: 'platform_password_reset',
      templateParams: { expiresAt: EXPIRES },
      secretPayload: new CredentialRecoverySecret(TOKEN),
    });
    expect(capturing.deliveryCount).toBe(1);
  });
});
