import { useCallback, useEffect, useState } from 'react';
import type { AuthenticatedSession } from '@/auth/types';
import { useAuthController } from '@/auth/useAuthController';
import { AppShell } from '@/components/AppShell';
import { AuthFrame } from '@/components/AuthFrame';
import { DisplayControls } from '@/components/DisplayControls';
import { translations, type Locale, type Messages } from '@/i18n';
import { isAuthenticatedPath, pathForRoute, routeFromPath, type AppRoute } from '@/route';
import { ApprovalsPage } from '@/pages/ApprovalsPage';
import { AttendancePage } from '@/pages/AttendancePage';
import { BackupCodesPage } from '@/pages/BackupCodesPage';
import { DepartmentsPage } from '@/pages/DepartmentsPage';
import { EmployeesPage } from '@/pages/EmployeesPage';
import { FinancePage } from '@/pages/FinancePage';
import { LeavesPage } from '@/pages/LeavesPage';
import { LoginPage } from '@/pages/LoginPage';
import { MfaPage } from '@/pages/MfaPage';
import { OverviewPage } from '@/pages/OverviewPage';
import { PayrollPage } from '@/pages/PayrollPage';
import { PurchasingPage } from '@/pages/PurchasingPage';
import { ReportsPage } from '@/pages/ReportsPage';
import { SessionsPage } from '@/pages/SessionsPage';
import { SuppliersPage } from '@/pages/SuppliersPage';
import { ChatPage } from '@/pages/ChatPage';
import { NotificationsPage } from '@/pages/NotificationsPage';
import { TasksPage } from '@/pages/TasksPage';
import { TrainingPage } from '@/pages/TrainingPage';

function replacePath(path: string): void {
  if (window.location.pathname !== path) window.history.replaceState({}, '', path);
}

function AuthenticatedContent({
  route,
  locale,
  messages,
  session,
  focusResourceId,
  onNavigate,
}: {
  route: AppRoute;
  locale: Locale;
  messages: Messages;
  session: AuthenticatedSession;
  /** Record a notification deep link asked the destination screen to open. */
  focusResourceId: string | null;
  onNavigate: (route: AppRoute, focusResourceId?: string | null) => void;
}) {
  if (route === 'sessions') {
    return <SessionsPage locale={locale} messages={messages} />;
  }
  if (route === 'employees') {
    return (
      <EmployeesPage
        locale={locale}
        messages={messages}
        permissions={session.user.permissions}
      />
    );
  }
  if (route === 'departments') {
    return (
      <DepartmentsPage
        locale={locale}
        messages={messages}
        permissions={session.user.permissions}
      />
    );
  }
  if (route === 'attendance') {
    return (
      <AttendancePage
        locale={locale}
        messages={messages}
        permissions={session.user.permissions}
      />
    );
  }
  if (route === 'leaves') {
    return (
      <LeavesPage
        locale={locale}
        messages={messages}
        permissions={session.user.permissions}
        focusResourceId={focusResourceId}
      />
    );
  }
  if (route === 'approvals') {
    return (
      <ApprovalsPage
        locale={locale}
        messages={messages}
        permissions={session.user.permissions}
        actorEmployeeId={session.user.employeeId}
      />
    );
  }
  if (route === 'payroll') {
    return (
      <PayrollPage
        locale={locale}
        messages={messages}
        permissions={session.user.permissions}
      />
    );
  }
  if (route === 'finance') {
    return (
      <FinancePage
        locale={locale}
        messages={messages}
        permissions={session.user.permissions}
      />
    );
  }
  if (route === 'purchasing') {
    return (
      <PurchasingPage
        locale={locale}
        messages={messages}
        permissions={session.user.permissions}
        focusResourceId={focusResourceId}
      />
    );
  }
  if (route === 'suppliers') {
    return (
      <SuppliersPage
        locale={locale}
        messages={messages}
        permissions={session.user.permissions}
      />
    );
  }
  if (route === 'reports') {
    return (
      <ReportsPage
        locale={locale}
        messages={messages}
        permissions={session.user.permissions}
      />
    );
  }
  if (route === 'tasks') {
    return (
      <TasksPage
        locale={locale}
        messages={messages}
        permissions={session.user.permissions}
        actorEmployeeId={session.user.employeeId}
        focusResourceId={focusResourceId}
      />
    );
  }
  if (route === 'training') {
    return (
      <TrainingPage
        locale={locale}
        messages={messages}
        permissions={session.user.permissions}
        focusResourceId={focusResourceId}
      />
    );
  }
  if (route === 'chat') {
    return (
      <ChatPage
        locale={locale}
        messages={messages}
        permissions={session.user.permissions}
        focusResourceId={focusResourceId}
      />
    );
  }
  if (route === 'notifications') {
    return (
      <NotificationsPage
        locale={locale}
        messages={messages}
        permissions={session.user.permissions}
        onNavigate={onNavigate}
      />
    );
  }
  return <OverviewPage messages={messages} session={session} />;
}

export default function App() {
  const auth = useAuthController();
  const [locale, setLocale] = useState<Locale>('ar');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [route, setRoute] = useState<AppRoute>(() => routeFromPath(window.location.pathname));
  const [focusResourceId, setFocusResourceId] = useState<string | null>(null);
  const messages = translations[locale];

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.title = locale === 'ar' ? 'موارد — مساحة الشركة' : 'Mawared — Company workspace';
  }, [locale, theme]);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (auth.state.status === 'anonymous' || auth.state.status === 'working') {
      replacePath('/login');
    } else if (auth.state.status === 'mfa') {
      replacePath('/mfa');
    } else if (auth.state.status === 'backupCodes') {
      replacePath('/backup-codes');
    } else if (!isAuthenticatedPath(window.location.pathname)) {
      replacePath('/overview');
      setRoute('overview');
    } else {
      setRoute(routeFromPath(window.location.pathname));
    }
  }, [auth.state.status]);

  const navigate = useCallback((next: AppRoute, focusId?: string | null) => {
    const path = pathForRoute(next);
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setRoute(next);
    // Deliberately kept out of the URL: a resource id in a query string would be
    // personal data in a shareable link. It lives in memory for this navigation
    // only, and is cleared on any ordinary sidebar navigation.
    setFocusResourceId(focusId ?? null);
  }, []);

  const controls = (
    <DisplayControls
      locale={locale}
      theme={theme}
      messages={messages}
      onLocaleChange={setLocale}
      onThemeChange={setTheme}
    />
  );

  if (auth.state.status === 'anonymous' || auth.state.status === 'working') {
    return (
      <AuthFrame messages={messages} controls={controls}>
        <LoginPage
          locale={locale}
          messages={messages}
          busy={auth.state.status === 'working'}
          error={auth.state.error}
          onSubmit={(input) => void auth.login(input)}
        />
      </AuthFrame>
    );
  }

  if (auth.state.status === 'mfa') {
    return (
      <AuthFrame messages={messages} controls={controls}>
        <MfaPage
          messages={messages}
          challenge={auth.state.challenge}
          enrollment={auth.state.enrollment}
          busy={auth.state.busy}
          error={auth.state.error}
          onStartEnrollment={() => void auth.startEnrollment()}
          onVerify={(code) => void auth.completeMfa(code)}
          onCancel={auth.cancelChallenge}
        />
      </AuthFrame>
    );
  }

  if (auth.state.status === 'backupCodes') {
    return (
      <AuthFrame messages={messages} controls={controls}>
        <BackupCodesPage
          messages={messages}
          codes={auth.state.backupCodes}
          onAcknowledge={auth.acknowledgeBackupCodes}
        />
      </AuthFrame>
    );
  }

  return (
    <AppShell
      locale={locale}
      theme={theme}
      messages={messages}
      session={auth.state.session}
      route={route}
      onNavigate={navigate}
      onLocaleChange={setLocale}
      onThemeChange={setTheme}
      onLogout={() => void auth.logout()}
    >
      <AuthenticatedContent
        route={route}
        locale={locale}
        messages={messages}
        session={auth.state.session}
        focusResourceId={focusResourceId}
        onNavigate={navigate}
      />
    </AppShell>
  );
}
