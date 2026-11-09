import { useMemo, useState, type ReactNode } from 'react';
import {
  BarChart3,
  Bell,
  Building2,
  CalendarDays,
  ClipboardCheck,
  Clock3,
  Gauge,
  GraduationCap,
  Landmark,
  Laptop2,
  ListChecks,
  LogOut,
  Menu,
  MessagesSquare,
  Moon,
  ShoppingCart,
  Sun,
  Truck,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import type { AuthenticatedSession } from '@/auth/types';
import type { Locale, Messages } from '@/i18n';
import {
  APPROVAL_INBOX_PERMISSIONS,
  ATTENDANCE_VIEW_PERMISSIONS,
  CHAT_VIEW_PERMISSIONS,
  DEPARTMENT_VIEW_PERMISSIONS,
  EMPLOYEE_VIEW_PERMISSIONS,
  FINANCE_VIEW_PERMISSIONS,
  LEAVE_VIEW_PERMISSIONS,
  NOTIFICATION_VIEW_PERMISSIONS,
  PAYROLL_VIEW_PERMISSIONS,
  PURCHASING_VIEW_PERMISSIONS,
  REPORTS_VIEW_PERMISSIONS,
  SUPPLIER_VIEW_PERMISSIONS,
  TASK_VIEW_PERMISSIONS,
  TRAINING_VIEW_PERMISSIONS,
  visibleNavigationItems,
  type NavigationItem,
} from '@/permissions';
import type { AppRoute } from '@/route';
import { BrandMark } from './BrandMark';

const navigation: readonly NavigationItem[] = [
  { id: 'overview', requiredPermissions: [], available: true },
  { id: 'sessions', requiredPermissions: [], available: true },
  { id: 'employees', requiredPermissions: EMPLOYEE_VIEW_PERMISSIONS, available: true },
  { id: 'departments', requiredPermissions: DEPARTMENT_VIEW_PERMISSIONS, available: true },
  { id: 'attendance', requiredPermissions: ATTENDANCE_VIEW_PERMISSIONS, available: true },
  { id: 'leaves', requiredPermissions: LEAVE_VIEW_PERMISSIONS, available: true },
  { id: 'approvals', requiredPermissions: APPROVAL_INBOX_PERMISSIONS, available: true },
  { id: 'payroll', requiredPermissions: PAYROLL_VIEW_PERMISSIONS, available: true },
  { id: 'finance', requiredPermissions: FINANCE_VIEW_PERMISSIONS, available: true },
  { id: 'purchasing', requiredPermissions: PURCHASING_VIEW_PERMISSIONS, available: true },
  { id: 'suppliers', requiredPermissions: SUPPLIER_VIEW_PERMISSIONS, available: true },
  { id: 'reports', requiredPermissions: REPORTS_VIEW_PERMISSIONS, available: true },
  // Commercial P4. Navigation visibility is UX only — every one of these screens
  // is independently re-authorized by the backend on each request.
  { id: 'tasks', requiredPermissions: TASK_VIEW_PERMISSIONS, available: true },
  { id: 'training', requiredPermissions: TRAINING_VIEW_PERMISSIONS, available: true },
  { id: 'chat', requiredPermissions: CHAT_VIEW_PERMISSIONS, available: true },
  { id: 'notifications', requiredPermissions: NOTIFICATION_VIEW_PERMISSIONS, available: true },
];

export function AppShell({
  locale,
  theme,
  messages,
  session,
  route,
  onNavigate,
  onLocaleChange,
  onThemeChange,
  onLogout,
  children,
}: {
  locale: Locale;
  theme: 'light' | 'dark';
  messages: Messages;
  session: AuthenticatedSession;
  route: AppRoute;
  onNavigate: (route: AppRoute) => void;
  onLocaleChange: (locale: Locale) => void;
  onThemeChange: (theme: 'light' | 'dark') => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const items = useMemo(
    () => visibleNavigationItems(navigation, session.user.permissions),
    [session.user.permissions],
  );

  const iconFor = (id: string) => {
    if (id === 'sessions') return <Laptop2 className="h-5 w-5" aria-hidden="true" />;
    if (id === 'employees') return <Users className="h-5 w-5" aria-hidden="true" />;
    if (id === 'departments') return <Building2 className="h-5 w-5" aria-hidden="true" />;
    if (id === 'attendance') return <Clock3 className="h-5 w-5" aria-hidden="true" />;
    if (id === 'leaves') return <CalendarDays className="h-5 w-5" aria-hidden="true" />;
    if (id === 'approvals') return <ClipboardCheck className="h-5 w-5" aria-hidden="true" />;
    if (id === 'payroll') return <Wallet className="h-5 w-5" aria-hidden="true" />;
    if (id === 'finance') return <Landmark className="h-5 w-5" aria-hidden="true" />;
    if (id === 'purchasing') return <ShoppingCart className="h-5 w-5" aria-hidden="true" />;
    if (id === 'suppliers') return <Truck className="h-5 w-5" aria-hidden="true" />;
    if (id === 'reports') return <BarChart3 className="h-5 w-5" aria-hidden="true" />;
    if (id === 'tasks') return <ListChecks className="h-5 w-5" aria-hidden="true" />;
    if (id === 'training') return <GraduationCap className="h-5 w-5" aria-hidden="true" />;
    if (id === 'chat') return <MessagesSquare className="h-5 w-5" aria-hidden="true" />;
    if (id === 'notifications') return <Bell className="h-5 w-5" aria-hidden="true" />;
    return <Gauge className="h-5 w-5" aria-hidden="true" />;
  };

  const labelFor = (id: string) => {
    if (id === 'sessions') return messages.sessions;
    if (id === 'employees') return messages.employees;
    if (id === 'departments') return messages.departments;
    if (id === 'attendance') return messages.attendance;
    if (id === 'leaves') return messages.leaves;
    if (id === 'approvals') return messages.approvals;
    if (id === 'payroll') return messages.payroll;
    if (id === 'finance') return messages.finance;
    if (id === 'purchasing') return messages.purchasing;
    if (id === 'suppliers') return messages.suppliers;
    if (id === 'reports') return messages.reports;
    if (id === 'tasks') return messages.tasks;
    if (id === 'training') return messages.training;
    if (id === 'chat') return messages.chat;
    if (id === 'notifications') return messages.notifications;
    return messages.overview;
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200/80 px-5 py-5 dark:border-white/10">
        <BrandMark />
        <div className="mt-5 rounded-2xl bg-slate-100 px-4 py-3 dark:bg-white/5">
          <div className="truncate text-sm font-extrabold text-slate-900 dark:text-white">
            {session.company.name}
          </div>
          <div className="mt-1 text-xs font-bold text-slate-500 dark:text-slate-400" dir="ltr">
            {session.company.code}
          </div>
        </div>
      </div>

      {/*
        min-h-0 is required alongside flex-1: a flex item defaults to
        min-height:auto and so refuses to shrink below its content, which made
        the whole sidebar overflow its fixed height instead of scrolling. With
        16 navigation entries that pushed the account block and Sign out below
        the fold on any viewport under ~1100px tall, with no way to reach them.
        Scrolling the menu keeps the header and account footer pinned.
      */}
      <nav
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-5"
        aria-label={messages.menu}
      >
        {items.map((item) => {
          const id = item.id as AppRoute;
          const active = route === id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onNavigate(id);
                setMobileOpen(false);
              }}
              className={`flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-sm font-extrabold transition ${
                active
                  ? 'bg-brand-600 text-white shadow-lg shadow-brand-700/20'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-white/5 dark:hover:text-white'
              }`}
            >
              {iconFor(item.id)}
              {labelFor(item.id)}
            </button>
          );
        })}
      </nav>

      <div className="border-t border-slate-200/80 p-3 dark:border-white/10">
        <div className="mb-2 px-3 py-2">
          <div className="truncate text-sm font-extrabold text-slate-900 dark:text-white">
            {session.user.name}
          </div>
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">
            {session.user.email}
          </div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-sm font-extrabold text-red-600 transition hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-500/10"
        >
          <LogOut className="h-5 w-5" aria-hidden="true" />
          {messages.logout}
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950 dark:bg-[#061225] dark:text-white">
      <aside className="fixed inset-y-0 z-30 hidden w-72 border-e border-slate-200 bg-white dark:border-white/10 dark:bg-[#09172b] lg:block">
        {sidebar}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/55 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
            aria-label={messages.closeMenu}
          />
          <aside className="absolute inset-y-0 start-0 w-[min(19rem,88vw)] border-e border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#09172b]">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute end-4 top-4 grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-200"
              aria-label={messages.closeMenu}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="lg:ps-72">
        <header className="sticky top-0 z-20 flex h-[4.25rem] items-center justify-between border-b border-slate-200/80 bg-white/85 px-4 backdrop-blur-xl dark:border-white/10 dark:bg-[#061225]/85 sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 bg-white text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200 lg:hidden"
            aria-label={messages.menu}
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="hidden lg:block">
            <div className="text-sm font-extrabold text-slate-900 dark:text-white">
              {labelFor(route)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onLocaleChange(locale === 'ar' ? 'en' : 'ar')}
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-extrabold text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
            >
              {locale === 'ar' ? messages.switchEnglish : messages.switchArabic}
            </button>
            <button
              type="button"
              onClick={() => onThemeChange(theme === 'light' ? 'dark' : 'light')}
              className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 bg-white text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
              aria-label={theme === 'light' ? messages.dark : messages.light}
            >
              {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </button>
          </div>
        </header>
        <main className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
