import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react';
import { translations, type Messages } from '@/i18n';

/**
 * Global boundary for render-time React failures.
 *
 * Without it a single throw inside any page unmounts the whole tree and leaves
 * the user staring at a blank white document with no way forward. It is mounted
 * around <App/> rather than inside it on purpose: a boundary nested under App
 * cannot catch a failure in App, AppShell, or the auth controller, and those are
 * exactly the failures that blank the screen.
 *
 * Sitting outside App also means React state — including the chosen locale and
 * theme — is unreachable here, so the fallback reads what it needs from the DOM.
 */

/**
 * Opaque, non-identifying id a user can quote to support. It is derived from
 * randomness only: it encodes nothing about the account, company, or failure.
 */
function newReference(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.slice(0, 8).toUpperCase();
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

/**
 * App mirrors its locale onto <html lang>, and index.html ships lang="ar", so
 * even a failure on the very first render is labelled in the default locale
 * rather than silently falling back to English.
 */
function fallbackMessages(): Messages {
  const lang = typeof document === 'undefined' ? 'ar' : document.documentElement.lang;
  return lang.toLowerCase().startsWith('en') ? translations.en : translations.ar;
}

/**
 * A caught failure must not vanish, but production logs carry no exception text.
 * A thrown value can embed whatever was being rendered — a salary, an employee
 * record, an API response body — and the browser console is reachable from a
 * support screenshot or an installed extension. Development keeps full detail;
 * production keeps only the reference.
 */
function report(reference: string, error: unknown, info: ErrorInfo): void {
  if (import.meta.env.DEV) {
    console.error(`[Mawared] render failure ${reference}`, error, info.componentStack);
    return;
  }
  console.error(`[Mawared] render failure ${reference}`);
}

type Props = {
  children: ReactNode;
  /**
   * Provider-neutral hook for a future client error reporter. It receives only
   * the opaque reference — never the error — so wiring up a reporter later
   * cannot turn into a data-exfiltration path by accident.
   */
  onError?: (reference: string) => void;
};

type State = {
  failed: boolean;
  reference: string;
  /** Bumped on retry to force a clean remount of the failed subtree. */
  attempt: number;
};

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, reference: '', attempt: 0 };

  /**
   * Deliberately discards the error. Nothing that could carry a stack trace,
   * a component name, employee data, or a token ever reaches component state,
   * so the fallback below cannot render it even by mistake.
   */
  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const reference = newReference();
    this.setState({ reference });
    report(reference, error, info);
    this.props.onError?.(reference);
  }

  private handleRetry = (): void => {
    // Remounting matters: a component that threw part-way through mounting
    // would otherwise be resumed from its half-built state.
    this.setState((previous) => ({
      failed: false,
      reference: '',
      attempt: previous.attempt + 1,
    }));
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.failed) {
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }

    const messages = fallbackMessages();

    return (
      // The background is pinned to the same values as index.css because App's
      // theme effect may never have run, so `html.dark` cannot be relied on.
      <div className="grid min-h-screen place-items-center bg-[#f4f8fc] px-4 py-10 dark:bg-[#061225]">
        <div
          role="alert"
          aria-live="assertive"
          className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-panel dark:border-white/10 dark:bg-white/5"
        >
          <AlertTriangle
            className="mx-auto h-10 w-10 text-amber-500 dark:text-amber-300"
            aria-hidden="true"
          />
          <h1 className="mt-4 text-lg font-extrabold text-slate-900 dark:text-white">
            {messages.unexpectedErrorTitle}
          </h1>
          <p className="mt-3 text-sm font-bold leading-relaxed text-slate-600 dark:text-slate-300">
            {messages.unexpectedErrorBody}
          </p>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={this.handleRetry}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white transition hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {messages.unexpectedErrorRetry}
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-extrabold text-slate-700 transition hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 dark:border-white/10 dark:bg-transparent dark:text-slate-200 dark:hover:bg-white/10"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {messages.unexpectedErrorReload}
            </button>
          </div>

          {/* Session tokens live in memory only, so a reload really does sign the
              user out. Saying so is kinder than letting them discover it. */}
          <p className="mt-4 text-xs font-bold text-slate-500 dark:text-slate-400">
            {messages.unexpectedErrorReloadHint}
          </p>

          {this.state.reference ? (
            <p className="mt-4 text-xs font-bold text-slate-400 dark:text-slate-500">
              {messages.unexpectedErrorReference}:{' '}
              <span className="font-mono tracking-wider">{this.state.reference}</span>
            </p>
          ) : null}
        </div>
      </div>
    );
  }
}
