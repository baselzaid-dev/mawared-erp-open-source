import { RefreshCw, ShieldAlert } from 'lucide-react';
import type { Messages } from '@/i18n';

export type ResourcePhase = 'loading' | 'ready' | 'empty' | 'error' | 'forbidden';

export function ResourceState({
  phase,
  messages,
  emptyMessage,
  errorMessage,
  forbiddenMessage,
  onRetry,
}: {
  phase: Exclude<ResourcePhase, 'ready'>;
  messages: Messages;
  emptyMessage: string;
  errorMessage: string;
  forbiddenMessage: string;
  onRetry?: () => void;
}) {
  if (phase === 'loading') {
    return (
      <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-8 text-center text-sm font-bold text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-400">
        {messages.loading}
      </div>
    );
  }

  if (phase === 'forbidden') {
    return (
      <div
        role="alert"
        className="mt-6 rounded-3xl border border-amber-200 bg-amber-50 p-8 text-center dark:border-amber-500/20 dark:bg-amber-500/10"
      >
        <ShieldAlert className="mx-auto h-8 w-8 text-amber-600 dark:text-amber-300" aria-hidden="true" />
        <p className="mt-3 text-sm font-extrabold text-amber-800 dark:text-amber-100">
          {forbiddenMessage}
        </p>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div
        role="alert"
        className="mt-6 rounded-3xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-500/20 dark:bg-red-500/10"
      >
        <p className="text-sm font-bold text-red-700 dark:text-red-200">{errorMessage}</p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 inline-flex items-center gap-2 rounded-xl border border-red-200 bg-white px-4 py-2.5 text-sm font-extrabold text-red-700 transition hover:bg-red-100 dark:border-red-500/30 dark:bg-transparent dark:text-red-200 dark:hover:bg-red-500/10"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {messages.retry}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-8 text-center text-sm font-bold text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-400">
      {emptyMessage}
    </div>
  );
}
