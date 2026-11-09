import { authenticatedRequest } from '@/api/client';
import type {
  AttendanceListFilters,
  AttendanceRecord,
  CreateDepartmentInput,
  CreateEmployeeInput,
  CreateLeaveInput,
  DepartmentRecord,
  EmployeeRecord,
  LeaveListFilters,
  LeaveRecord,
  LeaveReportResponse,
  LeaveTimelineResponse,
  RoleOption,
} from './types';

function toQuery(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const hrApi = {
  listEmployees(): Promise<EmployeeRecord[]> {
    return authenticatedRequest('/api/employees');
  },

  createEmployee(input: CreateEmployeeInput): Promise<{ id?: string } | EmployeeRecord> {
    return authenticatedRequest('/api/employees', {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        departmentId: input.departmentId || null,
      }),
    });
  },

  listDepartments(): Promise<DepartmentRecord[]> {
    return authenticatedRequest('/api/departments');
  },

  createDepartment(input: CreateDepartmentInput): Promise<DepartmentRecord> {
    return authenticatedRequest('/api/departments', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        managerId: input.managerId ?? null,
      }),
    });
  },

  listRoles(): Promise<RoleOption[]> {
    return authenticatedRequest('/api/roles');
  },

  listAttendance(filters: AttendanceListFilters = {}): Promise<AttendanceRecord[]> {
    return authenticatedRequest(
      `/api/attendance/all${toQuery({
        from: filters.from,
        to: filters.to,
        departmentId: filters.departmentId,
        employeeId: filters.employeeId,
        status: filters.status,
      })}`,
    );
  },

  listMyLeaves(filters: LeaveListFilters = {}): Promise<LeaveRecord[]> {
    return authenticatedRequest(
      `/api/leaves/my${toQuery({
        from: filters.from,
        to: filters.to,
        status: filters.status,
        leaveType: filters.leaveType,
      })}`,
    );
  },

  listLeaveReport(filters: LeaveListFilters): Promise<LeaveReportResponse> {
    return authenticatedRequest(
      `/api/leaves/report${toQuery({
        from: filters.from,
        to: filters.to,
        status: filters.status,
        leaveType: filters.leaveType,
        employeeId: filters.employeeId,
      })}`,
    );
  },

  listPendingLeaves(): Promise<LeaveRecord[]> {
    return authenticatedRequest('/api/leaves/pending');
  },

  getLeave(id: string): Promise<LeaveRecord> {
    return authenticatedRequest(`/api/leaves/${encodeURIComponent(id)}`);
  },

  createLeave(input: CreateLeaveInput): Promise<LeaveRecord> {
    return authenticatedRequest('/api/leaves', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  hrApproveLeave(id: string): Promise<{ message?: string }> {
    return authenticatedRequest(`/api/leaves/${encodeURIComponent(id)}/hr-approve`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  hrRejectLeave(id: string, reason: string): Promise<{ message?: string }> {
    return authenticatedRequest(`/api/leaves/${encodeURIComponent(id)}/hr-reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  adminApproveLeave(id: string): Promise<{ message?: string }> {
    return authenticatedRequest(`/api/leaves/${encodeURIComponent(id)}/admin-approve`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  adminRejectLeave(id: string, reason: string): Promise<{ message?: string }> {
    return authenticatedRequest(`/api/leaves/${encodeURIComponent(id)}/admin-reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  getLeaveTimeline(id: string): Promise<LeaveTimelineResponse> {
    return authenticatedRequest(`/api/v2/leaves/${encodeURIComponent(id)}/timeline`);
  },
};
