import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionMemory } from '@/auth/sessionMemory';
import { hrApi } from './api';

describe('company web HR API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionMemory.clear();
  });

  it('lists employees through the authenticated company-scoped contract', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      {
        id: 'emp-1',
        companyId: 'co-1',
        employeeNum: 'E-1',
        jobTitle: 'Analyst',
        joiningDate: '2026-01-01',
        status: 'active',
        departmentId: null,
        user: { id: 'u-1', name: 'Sara', email: 'sara@example.test', roleId: 'r-1', roleName: 'HR' },
        department: null,
      },
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const employees = await hrApi.listEmployees();

    expect(employees).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/employees');
    expect(fetchMock.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer access-token');
  });

  it('creates an employee with the protected payload shape', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: 'Employee created successfully',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await hrApi.createEmployee({
      name: 'Nora',
      email: 'nora@example.test',
      password: 'test-only-password', // security-scan-allow: explicit test fixture
      roleId: 'role-1',
      employeeNum: 'E-22',
      jobTitle: 'Coordinator',
      joiningDate: '2026-08-01',
      departmentId: '',
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'Nora',
      email: 'nora@example.test',
      password: 'test-only-password', // security-scan-allow: explicit test fixture
      roleId: 'role-1',
      employeeNum: 'E-22',
      jobTitle: 'Coordinator',
      joiningDate: '2026-08-01',
      departmentId: null,
    });
  });

  it('surfaces forbidden department responses without inventing rows', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Forbidden',
      code: 403,
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(hrApi.listDepartments()).rejects.toMatchObject({
      status: 403,
      code: 'Forbidden',
    });
  });

  it('creates a department with null manager when omitted', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'dept-1',
      name: 'Operations',
      managerId: null,
      managerName: null,
      activeEmployeeCount: 0,
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const department = await hrApi.createDepartment({ name: 'Operations' });

    expect(department.name).toBe('Operations');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      name: 'Operations',
      managerId: null,
    });
  });

  it('lists attendance with company-scoped filters', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await hrApi.listAttendance({
      from: '2026-08-01',
      to: '2026-08-01',
      departmentId: 'd-1',
      status: 'present',
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/attendance/all?');
    expect(String(fetchMock.mock.calls[0][0])).toContain('from=2026-08-01');
    expect(String(fetchMock.mock.calls[0][0])).toContain('status=present');
  });

  it('creates a leave request with annual exit/re-entry fields', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'lv-1',
      status: 'pending_hr',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await hrApi.createLeave({
      leaveType: 'annual',
      startDate: '2026-09-01',
      endDate: '2026-09-05',
      reason: 'Family',
      exitReentryRequested: true,
      visaFeePaid: true,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      leaveType: 'annual',
      startDate: '2026-09-01',
      endDate: '2026-09-05',
      reason: 'Family',
      exitReentryRequested: true,
      visaFeePaid: true,
    });
  });

  it('rejects leave through pending and decision endpoints without inventing success', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'lv-1', status: 'pending_hr' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'LeaveStateConflict',
        message: 'تمت معالجة طلب الإجازة مسبقاً أو تغيرت حالته',
        code: 409,
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(hrApi.listPendingLeaves()).resolves.toHaveLength(1);
    await expect(hrApi.hrApproveLeave('lv-1')).rejects.toMatchObject({
      status: 409,
      code: 'LeaveStateConflict',
    });
  });

  it('loads leave detail and timeline for approval review', async () => {
    sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'lv-1', status: 'pending_hr' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        entityType: 'leave',
        entityId: 'lv-1',
        events: [{ at: '2026-08-01T00:00:00.000Z', type: 'leave.submitted', summary: 'submitted' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(hrApi.getLeave('lv-1')).resolves.toMatchObject({ id: 'lv-1' });
    await expect(hrApi.getLeaveTimeline('lv-1')).resolves.toMatchObject({
      entityId: 'lv-1',
      events: [expect.objectContaining({ type: 'leave.submitted' })],
    });
  });
});
