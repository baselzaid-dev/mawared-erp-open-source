import { Building2, CheckCircle2, Contact, UserRound } from 'lucide-react';
import type { AuthenticatedSession } from '@/auth/types';
import type { Messages } from '@/i18n';

export function OverviewPage({
  messages,
  session,
}: {
  messages: Messages;
  session: AuthenticatedSession;
}) {
  const cards = [
    {
      label: messages.company,
      value: session.company.name,
      detail: `${messages.companyCodeShort}: ${session.company.code}`,
      icon: Building2,
    },
    {
      label: messages.account,
      value: session.user.name,
      detail: session.user.email,
      icon: UserRound,
    },
    {
      label: messages.role,
      value: session.user.roleName,
      detail: session.user.employeeId ?? session.user.id,
      icon: Contact,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <section className="overflow-hidden rounded-[2rem] bg-gradient-to-br from-[#0f294b] via-brand-800 to-brand-600 p-6 text-white shadow-panel sm:p-8 lg:p-10">
        <div className="max-w-2xl">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-extrabold text-brand-100 ring-1 ring-white/15">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            {messages.companyWorkspace}
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
            {messages.welcome}، {session.user.name}
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-7 text-brand-100 sm:text-base">
            {messages.connectedSecurely}
          </p>
        </div>
      </section>

      <section className="mt-6 grid gap-4 md:grid-cols-3">
        {cards.map(({ label, value, detail, icon: Icon }) => (
          <article key={label} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-panel dark:border-white/10 dark:bg-white/5">
            <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="text-xs font-extrabold uppercase tracking-wider text-slate-400">
              {label}
            </div>
            <div className="mt-2 truncate text-lg font-extrabold text-slate-950 dark:text-white">
              {value}
            </div>
            <div className="mt-1 truncate text-xs font-semibold text-slate-500 dark:text-slate-400" dir="auto">
              {detail}
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
