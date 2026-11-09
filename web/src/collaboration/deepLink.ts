import { hasAnyPermission } from '@/permissions';
import {
  ATTENDANCE_VIEW_PERMISSIONS,
  CHAT_VIEW_PERMISSIONS,
  EMPLOYEE_VIEW_PERMISSIONS,
  LEAVE_VIEW_PERMISSIONS,
  PURCHASING_VIEW_PERMISSIONS,
  TASK_VIEW_PERMISSIONS,
  TRAINING_VIEW_PERMISSIONS,
} from '@/permissions';
import type { AppRoute } from '@/route';
import type { NotificationDescriptor } from './types';

/**
 * Notification deep links.
 *
 * The backend already refuses to emit a descriptor whose `routeKey` is not on
 * its allowlist, so anything arriving here is a key the server vouched for.
 * This table is the *client half*: it maps a vouched key onto a route this
 * particular web app actually has, and to the permissions needed to open it.
 *
 * Two deliberate properties:
 *
 *  - An unknown key resolves to `null` rather than throwing or guessing. The web
 *    app does not implement every surface Android does (an attendance-correction
 *    deep link, for example), and a notification for a surface this client lacks
 *    must degrade to "not navigable", never to a wrong destination.
 *  - Resolution is permission-aware, but that is purely so the UI does not offer
 *    a link that would 403. It is not the protection: every target screen
 *    re-fetches from the backend, which independently rejects the same account.
 *
 * `auth.change_password` is intentionally absent: Company Web has no voluntary
 * change-password destination; the forced credential gate handles resets.
 * `leaves.detail` is retained as a read-compat alias if a non-canonical payload
 * ever reaches the client; the backend DTO normally rewrites it to `leave.detail`.
 */
const ROUTE_BY_KEY: Record<
  string,
  { route: AppRoute; permissions: readonly string[] } | undefined
> = {
  'task.detail': { route: 'tasks', permissions: TASK_VIEW_PERMISSIONS },
  'training.assignment.detail': { route: 'training', permissions: TRAINING_VIEW_PERMISSIONS },
  'chat.conversation': { route: 'chat', permissions: CHAT_VIEW_PERMISSIONS },
  'leave.detail': { route: 'leaves', permissions: LEAVE_VIEW_PERMISSIONS },
  'leaves.detail': { route: 'leaves', permissions: LEAVE_VIEW_PERMISSIONS },
  'attendance.today': { route: 'attendance', permissions: ATTENDANCE_VIEW_PERMISSIONS },
  'employees.list': { route: 'employees', permissions: EMPLOYEE_VIEW_PERMISSIONS },
  'employees.profile': { route: 'employees', permissions: EMPLOYEE_VIEW_PERMISSIONS },
  'purchasing.requests.detail': { route: 'purchasing', permissions: PURCHASING_VIEW_PERMISSIONS },
  'auth.sessions': { route: 'sessions', permissions: [] },
};

export interface ResolvedDeepLink {
  route: AppRoute;
  /** Server-supplied identifier of the record to focus once the route loads. */
  resourceId: string | null;
}

export function resolveNotificationTarget(
  descriptor: NotificationDescriptor | undefined,
  permissions: readonly string[],
): ResolvedDeepLink | null {
  if (!descriptor) return null;
  const entry = ROUTE_BY_KEY[descriptor.routeKey];
  if (!entry) return null;
  if (!hasAnyPermission(permissions, entry.permissions)) return null;
  return { route: entry.route, resourceId: descriptor.resourceId ?? null };
}

/**
 * Whether a notification should render as a clickable link at all. Kept separate
 * from resolution so the inbox can render a plain, non-interactive row instead
 * of a dead-looking button when the target is unreachable.
 */
export function isNavigable(
  descriptor: NotificationDescriptor | undefined,
  permissions: readonly string[],
): boolean {
  return resolveNotificationTarget(descriptor, permissions) !== null;
}
