/**
 * Provider-neutral localized recovery email templates (E6).
 * Arabic + English. No IDs, passwords, MFA material, or account-existence disclosure.
 */

import type { RecoveryDeliveryTemplate } from './delivery';

export type RecoveryTemplateLocale = 'en' | 'ar';

export interface RenderedRecoveryEmail {
  subject: string;
  textBody: string;
  htmlBody: string;
  /** Locale actually used. */
  locale: RecoveryTemplateLocale;
}

export interface RecoveryTemplateRenderInput {
  template: RecoveryDeliveryTemplate;
  locale?: RecoveryTemplateLocale | string | null;
  recoveryLink: string;
  /** ISO-8601 expiry; displayed as short notice only. */
  expiresAtIso: string;
}

const SUPPORTED: ReadonlySet<string> = new Set(['en', 'ar']);

function normalizeLocale(raw: string | null | undefined): RecoveryTemplateLocale {
  if (!raw) return 'en';
  const base = raw.trim().toLowerCase().slice(0, 2);
  return SUPPORTED.has(base) ? (base as RecoveryTemplateLocale) : 'en';
}

function formatExpiryNotice(expiresAtIso: string, locale: RecoveryTemplateLocale): string {
  // Keep display bounded; never include token or principal data.
  const trimmed = expiresAtIso.trim().slice(0, 40);
  if (locale === 'ar') {
    return `تنتهي صلاحية هذا الرابط في ${trimmed} (توقيت UTC).`;
  }
  return `This link expires at ${trimmed} (UTC).`;
}

function assertAllowedTemplate(template: RecoveryDeliveryTemplate): asserts template is
  | 'platform_password_reset'
  | 'company_owner_password_reset' {
  if (template !== 'platform_password_reset' && template !== 'company_owner_password_reset') {
    throw new Error(`recovery_template_not_email_deliverable:${template}`);
  }
}

/**
 * Render a recovery email. Callers must supply a server-built recovery link that
 * contains only the opaque token (no email/principal/company data).
 */
export function renderRecoveryEmail(input: RecoveryTemplateRenderInput): RenderedRecoveryEmail {
  assertAllowedTemplate(input.template);
  const locale = normalizeLocale(input.locale ?? null);
  const expiry = formatExpiryNotice(input.expiresAtIso, locale);
  const link = input.recoveryLink;

  if (input.template === 'platform_password_reset') {
    return locale === 'ar'
      ? renderPlatformAr(link, expiry)
      : renderPlatformEn(link, expiry);
  }
  return locale === 'ar'
    ? renderOwnerAr(link, expiry)
    : renderOwnerEn(link, expiry);
}

function wrapHtml(title: string, paragraphs: string[], link: string, cta: string): string {
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
  <p><strong>Mawared</strong></p>
  ${body}
  <p><a href="${escapeHtml(link)}">${escapeHtml(cta)}</a></p>
  <p style="word-break:break-all;font-size:12px;color:#555">${escapeHtml(link)}</p>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPlatformEn(link: string, expiry: string): RenderedRecoveryEmail {
  const subject = 'Mawared — Platform password reset';
  const paragraphs = [
    'You requested a password reset for your Mawared Platform account.',
    expiry,
    'If you did not request this, ignore this message. Your password will not change.',
  ];
  const cta = 'Reset your password';
  return {
    locale: 'en',
    subject,
    textBody: [
      'Mawared',
      '',
      ...paragraphs,
      '',
      cta,
      link,
    ].join('\n'),
    htmlBody: wrapHtml(subject, paragraphs, link, cta),
  };
}

function renderPlatformAr(link: string, expiry: string): RenderedRecoveryEmail {
  const subject = 'موارد — إعادة تعيين كلمة مرور المنصة';
  const paragraphs = [
    'لقد طلبت إعادة تعيين كلمة المرور لحساب منصة موارد.',
    expiry,
    'إذا لم تطلب ذلك، تجاهل هذه الرسالة. لن تتغير كلمة مرورك.',
  ];
  const cta = 'إعادة تعيين كلمة المرور';
  return {
    locale: 'ar',
    subject,
    textBody: [
      'موارد',
      '',
      ...paragraphs,
      '',
      cta,
      link,
    ].join('\n'),
    htmlBody: wrapHtml(subject, paragraphs, link, cta),
  };
}

function renderOwnerEn(link: string, expiry: string): RenderedRecoveryEmail {
  const subject = 'Mawared — Company owner password reset';
  const paragraphs = [
    'You requested a password reset for your Mawared company Primary Owner account.',
    expiry,
    'If you did not request this, ignore this message. Your password will not change.',
  ];
  const cta = 'Reset your password';
  return {
    locale: 'en',
    subject,
    textBody: [
      'Mawared',
      '',
      ...paragraphs,
      '',
      cta,
      link,
    ].join('\n'),
    htmlBody: wrapHtml(subject, paragraphs, link, cta),
  };
}

function renderOwnerAr(link: string, expiry: string): RenderedRecoveryEmail {
  const subject = 'موارد — إعادة تعيين كلمة مرور مالك الشركة';
  const paragraphs = [
    'لقد طلبت إعادة تعيين كلمة المرور لحساب المالك الأساسي في موارد.',
    expiry,
    'إذا لم تطلب ذلك، تجاهل هذه الرسالة. لن تتغير كلمة مرورك.',
  ];
  const cta = 'إعادة تعيين كلمة المرور';
  return {
    locale: 'ar',
    subject,
    textBody: [
      'موارد',
      '',
      ...paragraphs,
      '',
      cta,
      link,
    ].join('\n'),
    htmlBody: wrapHtml(subject, paragraphs, link, cta),
  };
}

/** Security redaction helper for snapshot/tests — never log raw tokens. */
export function redactRecoveryLinkForSnapshot(link: string): string {
  try {
    const url = new URL(link);
    if (url.hash) {
      url.hash = '#token=[REDACTED]';
    }
    if (url.searchParams.has('token')) {
      url.searchParams.set('token', '[REDACTED]');
    }
    return url.toString();
  } catch {
    return '[REDACTED_INVALID_LINK]';
  }
}
