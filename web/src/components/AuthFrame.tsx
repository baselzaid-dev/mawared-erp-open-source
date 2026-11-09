import type { ReactNode } from 'react';
import { Building2, LockKeyhole, ShieldCheck } from 'lucide-react';
import type { Messages } from '@/i18n';
import { BrandMark } from './BrandMark';

export function AuthFrame({
  messages,
  controls,
  children,
}: {
  messages: Messages;
  controls: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-slate-50 px-4 py-5 text-slate-950 dark:bg-[#061225] dark:text-white sm:px-6 lg:px-10">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -right-40 -top-52 h-[34rem] w-[34rem] rounded-full bg-brand-300/25 blur-3xl dark:bg-brand-700/20" />
        <div className="absolute -bottom-56 -left-32 h-[34rem] w-[34rem] rounded-full bg-cyan-200/30 blur-3xl dark:bg-cyan-700/10" />
      </div>

      <div className="relative mx-auto flex min-h-[calc(100vh-2.5rem)] max-w-7xl flex-col">
        <header className="flex items-center justify-between gap-4">
          <BrandMark />
          {controls}
        </header>

        <div className="grid flex-1 items-center gap-10 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:py-16">
          <section className="hidden max-w-xl lg:block">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-4 py-2 text-sm font-bold text-brand-800 dark:border-brand-500/20 dark:bg-brand-500/10 dark:text-brand-200">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              {messages.companyWorkspace}
            </div>
            <h1 className="text-5xl font-extrabold leading-[1.2] tracking-tight text-slate-950 dark:text-white">
              {messages.secureWorkspace}
            </h1>
            <div className="mt-9 grid grid-cols-2 gap-4">
              <div className="rounded-3xl border border-white/70 bg-white/65 p-5 shadow-panel backdrop-blur dark:border-white/10 dark:bg-white/5">
                <Building2 className="mb-4 h-6 w-6 text-brand-600 dark:text-brand-300" aria-hidden="true" />
                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">
                  {messages.companyCode}
                </p>
              </div>
              <div className="rounded-3xl border border-white/70 bg-white/65 p-5 shadow-panel backdrop-blur dark:border-white/10 dark:bg-white/5">
                <LockKeyhole className="mb-4 h-6 w-6 text-brand-600 dark:text-brand-300" aria-hidden="true" />
                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">
                  {messages.mfaTitle}
                </p>
              </div>
            </div>
          </section>

          <section className="mx-auto w-full max-w-lg rounded-[2rem] border border-white/80 bg-white/90 p-6 shadow-panel backdrop-blur-xl dark:border-white/10 dark:bg-[#0a1930]/95 sm:p-9">
            {children}
          </section>
        </div>
      </div>
    </main>
  );
}
