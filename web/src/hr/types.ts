export type EmployeeRecord = {
  id: string;
  companyId: string;
  employeeNum: string;
  jobTitle: string | null;
  joiningDate: string | null;
  status: string | null;
  departmentId: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  archivedAt?: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    roleId: string | null;
    roleName: string | null;
    credentialVersion?: number;
    accountStatus?: string;
    mustChangePassword?: boolean;
  } | null;
  department: {
    id: string;
    name: string;
  } | null;
};

export type DepartmentRecord = {
  id: string;
  name: string;
  managerId: string | null;
  managerName: string | null;
  activeEmployeeCount: number;
};

export type RoleOption = {
  id: string;
  name: string;
};

export type CreateEmployeeInput = {
  email: string;
  password: string;
  name: string;
  roleId: string;
  employeeNum: string;
  jobTitle: string;
  joiningDate: string;
  departmentId?: string | null;
};

export type CreateDepartmentInput = {
  name: string;
  managerId?: string | null;
};

export type AttendanceRecord = {
  id: string;
  companyId: string;
  employeeId: string;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  status: string;
  version?: number;
  employee: {
    id: string;
    employeeNum: string;
    jobTitle?: string | null;
    departmentId: string | null;
    department: { id: string; name: string } | null;
    user: {
      id: string;
      name: string;
      email?: string;
      roleName?: string | null;
    } | null;
  } | null;
};

export type LeaveType =
  | 'annual'
  | 'sick'
  | 'special'
  | 'unpaid'
  | 'study'
  | 'سنوية'
  | 'مرضية'
  | 'طارئة'
  | 'بدون راتب'
  | 'دراسية'
  | string;

export type LeaveStatus =
  | 'pending_hr'
  | 'pending_admin'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | string;

export type LeaveRecord = {
  id: string;
  employeeId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason: string | null;
  status: LeaveStatus;
  exitReentryRequested: boolean;
  visaFeePaid: boolean;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  employee: {
    id: string;
    employeeNum: string;
    name: string;
    departmentId: string | null;
    department: { id: string; name: string } | null;
  } | null;
};

export type LeaveReportResponse = {
  summary: {
    total: number;
    pendingHr: number;
    pendingAdmin: number;
    approved: number;
    rejected: number;
    cancelled: number;
    totalDays: number;
  };
  requests: LeaveRecord[];
};

export type CreateLeaveInput = {
  leaveType: string;
  startDate: string;
  endDate: string;
  reason?: string | null;
  exitReentryRequested?: boolean;
  visaFeePaid?: boolean;
};

export type LeaveTimelineEvent = {
  at: string;
  type: string;
  summary: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorName: string | null;
  actorRole: string | null;
  reason: string | null;
  override: boolean;
};

export type LeaveTimelineResponse = {
  entityType: string;
  entityId: string;
  events: LeaveTimelineEvent[];
};

export type AttendanceListFilters = {
  from?: string;
  to?: string;
  departmentId?: string;
  employeeId?: string;
  status?: string;
};

export type LeaveListFilters = {
  from?: string;
  to?: string;
  status?: string;
  leaveType?: string;
  employeeId?: string;
};
