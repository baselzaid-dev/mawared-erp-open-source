import { Languages, Moon, Sun } from 'lucide-react';
import type { Locale, Messages } from '@/i18n';

export function DisplayControls({
  locale,
  theme,
  messages,
  onLocaleChange,
  onThemeChange,
}: {
  locale: Locale;
  theme: 'light' | 'dark';
  messages: Messages;
  onLocaleChange: (locale: Locale) => void;
  onThemeChange: (theme: 'light' | 'dark') => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onLocaleChange(locale === 'ar' ? 'en' : 'ar')}
        className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white/80 px-3 text-sm font-bold text-slate-700 transition hover:border-brand-300 hover:text-brand-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200 dark:hover:border-brand-500/50"
      >
        <Languages className="h-4 w-4" aria-hidden="true" />
        {locale === 'ar' ? messages.switchEnglish : messages.switchArabic}
      </button>
      <button
        type="button"
        onClick={() => onThemeChange(theme === 'light' ? 'dark' : 'light')}
        className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 bg-white/80 text-slate-700 transition hover:border-brand-300 hover:text-brand-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200 dark:hover:border-brand-500/50"
        aria-label={theme === 'light' ? messages.dark : messages.light}
        title={theme === 'light' ? messages.dark : messages.light}
      >
        {theme === 'light' ? (
          <Moon className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Sun className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
