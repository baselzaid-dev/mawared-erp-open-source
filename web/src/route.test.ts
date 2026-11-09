import { describe, expect, it } from 'vitest';
import { isAuthenticatedPath, pathForRoute, routeFromPath } from './route';

describe('company web routes', () => {
  it('keeps only implemented protected routes addressable', () => {
    expect(routeFromPath('/sessions')).toBe('sessions');
    expect(routeFromPath('/employees')).toBe('employees');
    expect(routeFromPath('/departments')).toBe('departments');
    expect(routeFromPath('/attendance')).toBe('attendance');
    expect(routeFromPath('/leaves')).toBe('leaves');
    expect(routeFromPath('/approvals')).toBe('approvals');
    expect(routeFromPath('/payroll')).toBe('payroll');
    expect(routeFromPath('/finance')).toBe('finance');
    expect(routeFromPath('/overview')).toBe('overview');
    expect(routeFromPath('/not-built')).toBe('overview');
    expect(pathForRoute('sessions')).toBe('/sessions');
    expect(pathForRoute('employees')).toBe('/employees');
    expect(pathForRoute('departments')).toBe('/departments');
    expect(pathForRoute('attendance')).toBe('/attendance');
    expect(pathForRoute('leaves')).toBe('/leaves');
    expect(pathForRoute('approvals')).toBe('/approvals');
    expect(pathForRoute('payroll')).toBe('/payroll');
    expect(pathForRoute('finance')).toBe('/finance');
    expect(isAuthenticatedPath('/employees')).toBe(true);
    expect(isAuthenticatedPath('/attendance')).toBe(true);
    expect(isAuthenticatedPath('/leaves')).toBe(true);
    expect(isAuthenticatedPath('/approvals')).toBe(true);
    expect(isAuthenticatedPath('/payroll')).toBe(true);
    expect(isAuthenticatedPath('/finance')).toBe(true);
    expect(isAuthenticatedPath('/login')).toBe(false);
  });

  it('addresses the Commercial Wave 2 purchasing, suppliers and reports routes', () => {
    expect(routeFromPath('/purchasing')).toBe('purchasing');
    expect(routeFromPath('/suppliers')).toBe('suppliers');
    expect(routeFromPath('/reports')).toBe('reports');
    expect(pathForRoute('purchasing')).toBe('/purchasing');
    expect(pathForRoute('suppliers')).toBe('/suppliers');
    expect(pathForRoute('reports')).toBe('/reports');
    expect(isAuthenticatedPath('/purchasing')).toBe(true);
    expect(isAuthenticatedPath('/suppliers')).toBe(true);
    expect(isAuthenticatedPath('/reports')).toBe(true);
    // Nothing was added for a screen that does not exist yet.
    expect(isAuthenticatedPath('/inventory')).toBe(false);
    expect(isAuthenticatedPath('/custody')).toBe(false);
  });

  it('addresses the Commercial P4 tasks, training, chat and notification routes', () => {
    expect(routeFromPath('/tasks')).toBe('tasks');
    expect(routeFromPath('/training')).toBe('training');
    expect(routeFromPath('/chat')).toBe('chat');
    expect(routeFromPath('/notifications')).toBe('notifications');
    expect(pathForRoute('tasks')).toBe('/tasks');
    expect(pathForRoute('training')).toBe('/training');
    expect(pathForRoute('chat')).toBe('/chat');
    expect(pathForRoute('notifications')).toBe('/notifications');
    expect(isAuthenticatedPath('/tasks')).toBe(true);
    expect(isAuthenticatedPath('/training')).toBe(true);
    expect(isAuthenticatedPath('/chat')).toBe(true);
    expect(isAuthenticatedPath('/notifications')).toBe(true);
    // Still nothing for unbuilt P4-adjacent screens.
    expect(isAuthenticatedPath('/announcements')).toBe(false);
  });
});
