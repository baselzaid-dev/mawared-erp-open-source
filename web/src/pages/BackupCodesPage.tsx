import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { Messages } from '@/i18n';

export function BackupCodesPage({
  messages,
  codes,
  onAcknowledge,
}: {
  messages: Messages;
  codes: string[];
  onAcknowledge: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <div>
      <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
        <ShieldCheck className="h-7 w-7" aria-hidden="true" />
      </div>
      <h2 className="text-2xl font-extrabold text-slate-950 dark:text-white">
        {messages.backupTitle}
      </h2>
      <p className="mt-2 text-sm leading-7 text-slate-500 dark:text-slate-400">
        {messages.backupSubtitle}
      </p>

      <div className="mt-6 grid grid-cols-2 gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-black/15">
        {codes.map((code) => (
          <code key={code} className="rounded-lg bg-white px-2 py-2 text-center text-xs font-extrabold tracking-wider text-slate-800 dark:bg-white/5 dark:text-slate-100">
            {code}
          </code>
        ))}
      </div>

      <label className="mt-6 flex cursor-pointer items-start gap-3 text-sm font-bold text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-1 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        />
        <span>{messages.backupAck}</span>
      </label>
      <button
        type="button"
        disabled={!acknowledged}
        onClick={onAcknowledge}
        className="mt-6 w-full rounded-2xl bg-brand-600 px-5 py-3.5 text-sm font-extrabold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {messages.continue}
      </button>
    </div>
  );
}
