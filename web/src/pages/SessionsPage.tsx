import { useCallback, useEffect, useState } from 'react';
import { Laptop2, RefreshCw, ShieldOff, Smartphone } from 'lucide-react';
import { authApi } from '@/auth/api';
import type { SessionSummary } from '@/auth/types';
import type { Locale, Messages } from '@/i18n';

function formatDate(value: string | null, locale: Locale, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

export function SessionsPage({
  locale,
  messages,
}: {
  locale: Locale;
  messages: Messages;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busySession, setBusySession] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      setSessions(await authApi.listSessions());
      setPhase('ready');
    } catch {
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (sessionId: string) => {
    setBusySession(sessionId);
    try {
      await authApi.revokeSession(sessionId);
      await load();
    } catch {
      setPhase('error');
    } finally {
      setBusySession(null);
    }
  };

  const revokeOthers = async () => {
    setBusySession('all');
    try {
      await authApi.revokeOtherSessions();
      await load();
    } catch {
      setPhase('error');
    } finally {
      setBusySession(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.sessionTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.sessionSubtitle}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={phase === 'loading' || busySession !== null}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-extrabold text-slate-700 transition hover:border-brand-300 hover:text-brand-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {messages.refresh}
          </button>
          <button
            type="button"
            onClick={() => void revokeOthers()}
            disabled={busySession !== null || sessions.every((session) => session.isCurrent || session.revokedAt)}
            className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-extrabold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ShieldOff className="h-4 w-4" aria-hidden="true" />
            {messages.revokeOthers}
          </button>
        </div>
      </div>

      {phase === 'loading' && (
        <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-8 text-center text-sm font-bold text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-400">
          {messages.loading}
        </div>
      )}

      {phase === 'error' && (
        <div role="alert" className="mt-6 rounded-3xl border border-red-200 bg-red-50 p-6 text-center text-sm font-bold text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200">
          {messages.sessionsError}
        </div>
      )}

      {phase === 'ready' && sessions.length === 0 && (
        <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-8 text-center text-sm font-bold text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-400">
          {messages.noSessions}
        </div>
      )}

      {phase === 'ready' && sessions.length > 0 && (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {sessions.map((session) => {
            const DeviceIcon = session.platform === 'android' ? Smartphone : Laptop2;
            return (
              <article key={session.sessionId} className={`rounded-3xl border bg-white p-5 shadow-panel dark:bg-white/5 ${
                session.isCurrent
                  ? 'border-brand-300 ring-4 ring-brand-500/5 dark:border-brand-500/40'
                  : 'border-slate-200 dark:border-white/10'
              }`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-200">
                      <DeviceIcon className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-extrabold text-slate-950 dark:text-white">
                        {session.deviceLabel ?? messages.legacyDevice}
                      </div>
                      <div className="mt-1 text-xs font-bold uppercase tracking-wider text-slate-400">
                        {session.platform ?? '—'}
                      </div>
                    </div>
                  </div>
                  {session.isCurrent ? (
                    <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-extrabold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                      {messages.currentSession}
                    </span>
                  ) : session.revokedAt ? (
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-extrabold text-slate-500 dark:bg-white/10 dark:text-slate-300">
                      {messages.revokedSession}
                    </span>
                  ) : null}
                </div>

                <dl className="mt-5 grid gap-3 border-t border-slate-100 pt-4 text-sm dark:border-white/10 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.createdAt}</dt>
                    <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200">
                      {formatDate(session.createdAt, locale, messages.never)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.lastUsedAt}</dt>
                    <dd className="mt-1 font-semibold text-slate-700 dark:text-slate-200">
                      {formatDate(session.lastUsedAt, locale, messages.never)}
                    </dd>
                  </div>
                </dl>

                {!session.isCurrent && !session.revokedAt && (
                  <button
                    type="button"
                    onClick={() => void revoke(session.sessionId)}
                    disabled={busySession !== null}
                    className="mt-5 w-full rounded-xl border border-red-200 px-4 py-2.5 text-sm font-extrabold text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:border-red-500/20 dark:text-red-300 dark:hover:bg-red-500/10"
                  >
                    {messages.revoke}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
