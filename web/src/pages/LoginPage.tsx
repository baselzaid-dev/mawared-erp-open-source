import { useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Building2, KeyRound, UserRound } from 'lucide-react';
import type { Locale, Messages } from '@/i18n';

function Field({
  label,
  icon,
  ...inputProps
}: {
  label: string;
  icon: ReactNode;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-bold text-slate-700 dark:text-slate-200">
        {label}
      </span>
      <span className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 transition focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-500/10 dark:border-white/10 dark:bg-white/5">
        <span className="text-slate-400">{icon}</span>
        <input
          {...inputProps}
          className="h-[3.25rem] min-w-0 flex-1 border-0 bg-transparent py-3.5 text-sm font-semibold text-slate-950 outline-none placeholder:text-slate-400 dark:text-white"
        />
      </span>
    </label>
  );
}

export function LoginPage({
  locale,
  messages,
  busy,
  error,
  onSubmit,
}: {
  locale: Locale;
  messages: Messages;
  busy: boolean;
  error: 'invalidCredentials' | 'network' | 'session' | 'mfa' | null;
  onSubmit: (input: { companyCode: string; identifier: string; password: string }) => void;
}) {
  const [companyCode, setCompanyCode] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    onSubmit({ companyCode, identifier, password });
  };

  const errorMessage = error === 'network'
    ? messages.networkError
    : error === 'session'
      ? messages.sessionError
      : error
        ? messages.invalidCredentials
        : null;

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="mb-7">
        <h2 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white">
          {messages.loginTitle}
        </h2>
        <p className="mt-2 text-sm leading-7 text-slate-500 dark:text-slate-400">
          {messages.loginSubtitle}
        </p>
      </div>

      {errorMessage && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200">
          {errorMessage}
        </div>
      )}

      <Field
        label={messages.companyCode}
        icon={<Building2 className="h-5 w-5" aria-hidden="true" />}
        name="companyCode"
        autoComplete="organization"
        value={companyCode}
        onChange={(event) => setCompanyCode(event.target.value)}
        required
        maxLength={64}
      />
      <Field
        label={messages.identifier}
        icon={<UserRound className="h-5 w-5" aria-hidden="true" />}
        name="username"
        autoComplete="username"
        value={identifier}
        onChange={(event) => setIdentifier(event.target.value)}
        required
        maxLength={320}
      />
      <Field
        label={messages.password}
        icon={<KeyRound className="h-5 w-5" aria-hidden="true" />}
        name="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
        maxLength={256}
      />

      <button
        type="submit"
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 px-5 py-3.5 text-sm font-extrabold text-white shadow-lg shadow-brand-700/20 transition hover:bg-brand-700 focus:outline-none focus:ring-4 focus:ring-brand-500/25 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? messages.signingIn : messages.continue}
        {!busy && (locale === 'ar' ? (
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        ) : (
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        ))}
      </button>
    </form>
  );
}
