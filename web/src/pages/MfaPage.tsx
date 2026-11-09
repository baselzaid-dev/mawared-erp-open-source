import { useState, type FormEvent } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { sanitizeOtpauthUri } from '@/auth/otpauth';
import type { MfaChallenge, MfaEnrollment } from '@/auth/types';
import type { Messages } from '@/i18n';

export function MfaPage({
  messages,
  challenge,
  enrollment,
  busy,
  error,
  onStartEnrollment,
  onVerify,
  onCancel,
}: {
  messages: Messages;
  challenge: MfaChallenge;
  enrollment: MfaEnrollment | null;
  busy: boolean;
  error: 'network' | 'mfa' | 'invalidCredentials' | 'session' | null;
  onStartEnrollment: () => void;
  onVerify: (code: string) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  const safeOtpauthUri = enrollment ? sanitizeOtpauthUri(enrollment.otpauthUri) : null;
  const needsEnrollmentStart = challenge.enrollmentRequired && !enrollment;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || busy) return;
    onVerify(code.trim());
  };

  return (
    <div>
      <div className="mb-7 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
        <ShieldCheck className="h-7 w-7" aria-hidden="true" />
      </div>
      <h2 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white">
        {challenge.enrollmentRequired ? messages.mfaEnrollmentTitle : messages.mfaTitle}
      </h2>
      <p className="mt-2 text-sm leading-7 text-slate-500 dark:text-slate-400">
        {challenge.enrollmentRequired ? messages.mfaEnrollmentIntro : messages.mfaSubtitle}
      </p>

      {error && (
        <div role="alert" className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200">
          {error === 'network' ? messages.networkError : messages.mfaError}
        </div>
      )}

      {needsEnrollmentStart ? (
        <button
          type="button"
          onClick={onStartEnrollment}
          disabled={busy}
          className="mt-7 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 px-5 py-3.5 text-sm font-extrabold text-white transition hover:bg-brand-700 focus:outline-none focus:ring-4 focus:ring-brand-500/25 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          {messages.startEnrollment}
        </button>
      ) : (
        <form onSubmit={submit} className="mt-7 space-y-5">
          {enrollment && (
            <div className="rounded-2xl border border-brand-200 bg-brand-50/70 p-4 dark:border-brand-500/20 dark:bg-brand-500/10">
              <div className="text-xs font-bold uppercase tracking-wider text-brand-700 dark:text-brand-300">
                {messages.manualSecret}
              </div>
              <code className="mt-2 block break-all rounded-xl bg-white px-3 py-2 text-sm font-bold tracking-wider text-slate-800 dark:bg-black/20 dark:text-white">
                {enrollment.manualSecret}
              </code>
              {safeOtpauthUri && (
                <a
                  href={safeOtpauthUri}
                  className="mt-3 inline-flex text-sm font-extrabold text-brand-700 underline decoration-brand-300 underline-offset-4 dark:text-brand-300"
                >
                  {messages.openAuthenticator}
                </a>
              )}
            </div>
          )}

          <label className="block">
            <span className="mb-2 block text-sm font-bold text-slate-700 dark:text-slate-200">
              {messages.verificationCode}
            </span>
            <span className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-500/10 dark:border-white/10 dark:bg-white/5">
              <KeyRound className="h-5 w-5 text-slate-400" aria-hidden="true" />
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={32}
                required
                autoFocus
                disabled={busy}
                className="min-w-0 flex-1 border-0 bg-transparent py-3.5 text-center text-lg font-extrabold tracking-[0.3em] text-slate-950 outline-none dark:text-white"
              />
            </span>
          </label>
          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 px-5 py-3.5 text-sm font-extrabold text-white transition hover:bg-brand-700 focus:outline-none focus:ring-4 focus:ring-brand-500/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? messages.verifying : messages.verify}
          </button>
        </form>
      )}

      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="mt-4 w-full rounded-xl px-4 py-2 text-sm font-bold text-slate-500 transition hover:text-slate-900 disabled:opacity-50 dark:text-slate-400 dark:hover:text-white"
      >
        {messages.cancel}
      </button>
    </div>
  );
}
