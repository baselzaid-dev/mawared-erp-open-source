export type AppRoute =
  | 'overview'
  | 'sessions'
  | 'employees'
  | 'departments'
  | 'attendance'
  | 'leaves'
  | 'approvals'
  | 'payroll'
  | 'finance'
  | 'purchasing'
  | 'suppliers'
  | 'reports'
  | 'tasks'
  | 'training'
  | 'chat'
  | 'notifications';

const routeByPath: Record<string, AppRoute> = {
  '/overview': 'overview',
  '/sessions': 'sessions',
  '/employees': 'employees',
  '/departments': 'departments',
  '/attendance': 'attendance',
  '/leaves': 'leaves',
  '/approvals': 'approvals',
  '/payroll': 'payroll',
  '/finance': 'finance',
  '/purchasing': 'purchasing',
  '/suppliers': 'suppliers',
  '/reports': 'reports',
  '/tasks': 'tasks',
  '/training': 'training',
  '/chat': 'chat',
  '/notifications': 'notifications',
};

const pathByRoute: Record<AppRoute, string> = {
  overview: '/overview',
  sessions: '/sessions',
  employees: '/employees',
  departments: '/departments',
  attendance: '/attendance',
  leaves: '/leaves',
  approvals: '/approvals',
  payroll: '/payroll',
  finance: '/finance',
  purchasing: '/purchasing',
  suppliers: '/suppliers',
  reports: '/reports',
  tasks: '/tasks',
  training: '/training',
  chat: '/chat',
  notifications: '/notifications',
};

export function routeFromPath(pathname: string): AppRoute {
  return routeByPath[pathname] ?? 'overview';
}

export function pathForRoute(route: AppRoute): string {
  return pathByRoute[route];
}

export function isAuthenticatedPath(pathname: string): boolean {
  return pathname in routeByPath;
}
