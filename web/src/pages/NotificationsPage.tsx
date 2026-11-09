import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, CheckCheck, ExternalLink, RefreshCw } from 'lucide-react';
import { ApiError } from '@/api/client';
import { notificationsApi } from '@/collaboration/api';
import { resolveNotificationTarget } from '@/collaboration/deepLink';
import type {
  NotificationCategory,
  NotificationRecord,
} from '@/collaboration/types';
import { ResourceState, type ResourcePhase } from '@/components/ResourceState';
import type { Locale, Messages } from '@/i18n';
import { canViewNotifications } from '@/permissions';
import type { AppRoute } from '@/route';
import { createLatestRequestGuard } from './latestRequestGuard';

const panel =
  'rounded-3xl border border-slate-200 bg-white p-5 shadow-panel dark:border-white/10 dark:bg-white/5';
const ghostButton =
  'inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-extrabold text-slate-700 transition hover:border-brand-300 hover:text-brand-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200';

const CATEGORIES: readonly NotificationCategory[] = [
  'general',
  'security',
  'workflow',
  'leave',
  'task',
  'attendance',
  'payroll',
  'chat',
  'purchasing',
  'training',
];

function categoryLabel(messages: Messages, category: NotificationCategory): string {
  if (category === 'security') return messages.categorySecurity;
  if (category === 'workflow') return messages.categoryWorkflow;
  if (category === 'leave') return messages.categoryLeave;
  if (category === 'task') return messages.categoryTask;
  if (category === 'attendance') return messages.categoryAttendance;
  if (category === 'payroll') return messages.categoryPayroll;
  if (category === 'chat') return messages.categoryChat;
  if (category === 'purchasing') return messages.categoryPurchasing;
  if (category === 'training') return messages.categoryTraining;
  return messages.categoryGeneral;
}

export function NotificationsPage({
  locale,
  messages,
  permissions,
  onNavigate,
}: {
  locale: Locale;
  messages: Messages;
  permissions: readonly string[];
  /** `focusResourceId` carries the notification's target record to the destination screen. */
  onNavigate: (route: AppRoute, focusResourceId?: string | null) => void;
}) {
  const canView = canViewNotifications(permissions);

  const [phase, setPhase] = useState<ResourcePhase>(canView ? 'loading' : 'forbidden');
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [category, setCategory] = useState<NotificationCategory | ''>('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const guard = useRef(createLatestRequestGuard());

  const load = useCallback(async () => {
    if (!canView) {
      setPhase('forbidden');
      return;
    }
    const requestId = guard.current.begin();
    setPhase('loading');
    setActionError(null);
    try {
      const [page, counter] = await Promise.all([
        notificationsApi.list({
          ...(category ? { category } : {}),
          ...(unreadOnly ? { read: 'false' as const } : {}),
          limit: 50,
        }),
        notificationsApi.unreadCount(),
      ]);
      if (!guard.current.isCurrent(requestId)) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setUnreadCount(counter.unreadCount);
      setPhase(page.items.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (!guard.current.isCurrent(requestId)) return;
      setPhase(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error');
    }
  }, [canView, category, unreadOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadOlder = async () => {
    if (!nextCursor || busy) return;
    setBusy(true);
    try {
      const page = await notificationsApi.list({
        ...(category ? { category } : {}),
        ...(unreadOnly ? { read: 'false' as const } : {}),
        cursor: nextCursor,
        limit: 50,
      });
      // Append: the inbox is newest-first and the cursor walks backwards.
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch {
      setActionError(messages.notificationsError);
    } finally {
      setBusy(false);
    }
  };

  const markRead = async (notification: NotificationRecord) => {
    if (busy || notification.isRead) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await notificationsApi.markRead(notification.id);
      setItems((current) =>
        current.map((row) => (row.id === updated.id ? { ...row, ...updated } : row)),
      );
      setUnreadCount((current) => Math.max(0, current - 1));
    } catch {
      setActionError(messages.notificationsError);
    } finally {
      setBusy(false);
    }
  };

  const markAllRead = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await notificationsApi.markAllRead(category || undefined);
      await load();
    } catch {
      setActionError(messages.notificationsError);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Following a deep link marks the notification read first, so the badge cannot
   * keep counting an alert the user has demonstrably acted on.
   *
   * The resolved `resourceId` travels with the route: a notification about one
   * specific task, assignment or conversation must open THAT record, not just
   * the module list, otherwise the deep link only half works and the user still
   * has to hunt for the row.
   */
  const openResource = async (notification: NotificationRecord) => {
    const target = resolveNotificationTarget(notification.descriptor, permissions);
    if (!target) return;
    await markRead(notification);
    onNavigate(target.route, target.resourceId);
  };

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [locale],
  );

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.notificationsTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.notificationsSubtitle}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-xl bg-brand-50 px-3 py-2 text-sm font-extrabold text-brand-700 dark:bg-brand-500/10 dark:text-brand-200">
            <BellRing className="h-4 w-4" aria-hidden="true" />
            {unreadCount}
          </span>
          <button
            type="button"
            onClick={() => void markAllRead()}
            disabled={!canView || busy || unreadCount === 0}
            className={ghostButton}
          >
            <CheckCheck className="h-4 w-4" aria-hidden="true" />
            {messages.markAllRead}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={phase === 'loading' || !canView}
            className={ghostButton}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {messages.refresh}
          </button>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-bold text-slate-600 dark:text-slate-300">
          <span>{messages.allCategories}</span>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as NotificationCategory | '')}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold dark:border-white/10 dark:bg-white/5"
          >
            <option value="">{messages.allCategories}</option>
            {CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {categoryLabel(messages, value)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm font-bold text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(event) => setUnreadOnly(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          {messages.unreadOnly}
        </label>
      </div>

      {actionError ? (
        <p role="alert" className="mt-4 text-sm font-bold text-red-600 dark:text-red-300">
          {actionError}
        </p>
      ) : null}

      {phase !== 'ready' ? (
        <ResourceState
          phase={phase}
          messages={messages}
          emptyMessage={messages.notificationsEmpty}
          errorMessage={messages.notificationsError}
          forbiddenMessage={messages.notificationsForbidden}
          onRetry={() => void load()}
        />
      ) : (
        <>
          <ul className="mt-6 space-y-3">
            {items.map((notification) => {
              const target = resolveNotificationTarget(notification.descriptor, permissions);
              return (
                <li
                  key={notification.id}
                  className={`${panel} ${notification.isRead ? '' : 'border-brand-300 dark:border-brand-500/40'}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-extrabold text-slate-600 dark:bg-white/10 dark:text-slate-300">
                          {categoryLabel(messages, notification.category)}
                        </span>
                        {!notification.isRead ? (
                          <span className="h-2 w-2 rounded-full bg-brand-500" aria-hidden="true" />
                        ) : null}
                      </div>
                      <h2 className="mt-2 text-sm font-extrabold text-slate-950 dark:text-white">
                        {notification.title}
                      </h2>
                      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                        {notification.message}
                      </p>
                      <p className="mt-2 text-xs font-bold text-slate-400">
                        {dateFormatter.format(new Date(notification.createdAt))}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {notification.descriptor ? (
                        target ? (
                          <button
                            type="button"
                            onClick={() => void openResource(notification)}
                            disabled={busy}
                            className={ghostButton}
                          >
                            <ExternalLink className="h-4 w-4" aria-hidden="true" />
                            {messages.openResource}
                          </button>
                        ) : (
                          // The backend vouched for the descriptor, but this
                          // client either lacks the screen or the account lacks
                          // the permission. Say so instead of offering a link
                          // that would dead-end or 403.
                          <span className="inline-flex items-center rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-500 dark:bg-white/10 dark:text-slate-400">
                            {messages.notificationUnavailable}
                          </span>
                        )
                      ) : null}
                      {!notification.isRead ? (
                        <button
                          type="button"
                          onClick={() => void markRead(notification)}
                          disabled={busy}
                          className={ghostButton}
                        >
                          {messages.markRead}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {nextCursor ? (
            <button
              type="button"
              onClick={() => void loadOlder()}
              disabled={busy}
              className={`${ghostButton} mt-5`}
            >
              {messages.loadOlder}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
