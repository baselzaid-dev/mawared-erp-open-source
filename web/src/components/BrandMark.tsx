export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3" aria-label="Mawared">
      <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-700 text-xl font-extrabold text-white shadow-lg shadow-brand-700/20">
        م
      </div>
      {!compact && (
        <div>
          <div className="text-lg font-extrabold tracking-tight text-slate-950 dark:text-white">
            Mawared
          </div>
          <div className="text-xs font-semibold text-brand-700 dark:text-brand-300">
            موارد
          </div>
        </div>
      )}
    </div>
  );
}
