import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeApp, tokenFor } from './helpers';
import { addTrainingIdentity, makeTrainingPrisma, UUIDS } from './training_test_helpers';

const token = (permissions: string[], employeeId: string | null = null, id = 'hr-1', companyId = 'c1') =>
  tokenFor({ id, companyId, employeeId, permissions });

const course = (id: string, status: string, departmentSuffix: string) => ({
  id,
  companyId: 'c1',
  courseCode: `TR-202607-${departmentSuffix}`,
  title: `Course ${departmentSuffix}`,
  description: 'Private course description',
  category: 'leadership',
  instructorName: 'Private trainer',
  deliveryMode: 'online',
  location: null,
  startDate: new Date('2026-07-01T00:00:00.000Z'),
  endDate: new Date('2026-07-10T00:00:00.000Z'),
  durationHours: 4,
  capacity: 10,
  status,
  createdByUserId: 'hr-1',
  createdAt: new Date('2026-07-01T08:00:00.000Z'),
  updatedAt: new Date('2026-07-01T08:00:00.000Z'),
});

const assignment = (input: {
  id: string;
  courseId: string;
  employeeId: string;
  departmentId: string;
  status: string;
  progress: number;
  score?: number | null;
}) => ({
  id: input.id,
  companyId: 'c1',
  courseId: input.courseId,
  employeeId: input.employeeId,
  employeeNameSnapshot: `Employee ${input.employeeId.slice(-1)}`,
  employeeNumSnapshot: `EMP-${input.employeeId.slice(-4)}`,
  departmentIdSnapshot: input.departmentId,
  departmentNameSnapshot: `Department ${input.departmentId.slice(-1)}`,
  status: input.status,
  progressPercent: input.progress,
  score: input.score ?? null,
  assignedByUserId: 'hr-1',
  assignedAt: new Date('2026-07-02T08:00:00.000Z'),
  startedAt: null,
  submittedAt: null,
  completedAt: input.status === 'completed' ? new Date('2026-07-09T08:00:00.000Z') : null,
  reviewedByUserId: input.status === 'completed' ? 'reviewer-1' : null,
  reviewedAt: input.status === 'completed' ? new Date('2026-07-09T08:00:00.000Z') : null,
  reviewNote: input.status === 'completed' ? 'Private review note' : null,
  createdAt: new Date('2026-07-02T08:00:00.000Z'),
  updatedAt: new Date('2026-07-02T08:00:00.000Z'),
});

const fixture = () => {
  const prisma = makeTrainingPrisma();
  addTrainingIdentity(prisma, {
    userId: 'manager-1', employeeId: UUIDS.employee3, departmentId: UUIDS.department1,
    managerId: 'manager-1', permissions: ['training.view_own', 'training.view_department', 'training.report'],
  });
  addTrainingIdentity(prisma, {
    userId: 'employee-1', employeeId: UUIDS.employee1, departmentId: UUIDS.department1,
    permissions: ['training.view_own'],
  });
  addTrainingIdentity(prisma, {
    userId: 'owner-1', employeeId: UUIDS.employee2, departmentId: UUIDS.department1,
    permissions: [], roleName: 'Former Admin',
  });
  prisma.companyOwnership.findFirst.mockResolvedValue({ userId: 'owner-1' });
  const outsideEmployee = '40000000-0000-4000-8000-000000000004';
  addTrainingIdentity(prisma, {
    userId: 'employee-4', employeeId: outsideEmployee, departmentId: UUIDS.department2,
    permissions: ['training.view_own'],
  });
  prisma._training.courses.push(
    course(UUIDS.course1, 'published', 'DPT10001'),
    course(UUIDS.course2, 'completed', 'DPT20002')
  );
  prisma._training.assignments.push(
    assignment({
      id: '30000000-0000-4000-8000-000000000001', courseId: UUIDS.course1,
      employeeId: UUIDS.employee1, departmentId: UUIDS.department1,
      status: 'completed', progress: 100, score: 80,
    }),
    assignment({
      id: '30000000-0000-4000-8000-000000000002', courseId: UUIDS.course1,
      employeeId: UUIDS.employee2, departmentId: UUIDS.department1,
      status: 'in_progress', progress: 50,
    }),
    assignment({
      id: '30000000-0000-4000-8000-000000000003', courseId: UUIDS.course2,
      employeeId: outsideEmployee, departmentId: UUIDS.department2,
      status: 'submitted', progress: 100,
    })
  );
  return prisma;
};

describe('Sprint 10 training report and scope', () => {
  it('calculates company KPIs and average score on the server with a safe response', async () => {
    const prisma = fixture();
    const response = await request(makeApp(prisma))
      .get('/api/training/report?scope=company&from=2026-07-01&to=2026-07-31')
      .set('Authorization', `Bearer ${token(['training.view_company', 'training.report', 'hr.view'])}`);

    expect(response.status).toBe(200);
    expect(response.body.summary).toMatchObject({
      courseCount: 2,
      publishedCourseCount: 1,
      completedCourseCount: 1,
      assignmentCount: 3,
      inProgressCount: 1,
      submittedCount: 1,
      completedAssignmentCount: 1,
      overdueCount: 2,
      completionRatePercent: 33.33,
      averageProgressPercent: 83.33,
      averageScore: '80.00',
    });
    expect(response.body.departments).toHaveLength(2);
    expect(JSON.stringify(response.body)).not.toMatch(/Private course description|Private review note|password|permissions|email|completionNote|reviewNote/i);
    const audit = prisma._store.auditLogs.find((row: any) => row.action === 'training.report.read');
    expect(audit.details).toContain('filters');
    expect(audit.details).not.toMatch(/80|83|Course|Employee|score|progress/i);
  });

  it('limits a Department Manager to currently managed departments and hides owner assignments', async () => {
    const prisma = fixture();
    const response = await request(makeApp(prisma))
      .get('/api/training/report?scope=department')
      .set('Authorization', `Bearer ${token(
        ['training.view_own', 'training.view_department', 'training.report'],
        UUIDS.employee3,
        'manager-1'
      )}`);

    expect(response.status).toBe(200);
    expect(response.body.summary).toMatchObject({
      courseCount: 1,
      assignmentCount: 1,
      completedAssignmentCount: 1,
      averageScore: '80.00',
    });
    expect(response.body.assignments.map((row: any) => row.employee.employeeId)).toEqual([UUIDS.employee1]);
    expect(JSON.stringify(response.body)).not.toContain(UUIDS.employee2);
    expect(JSON.stringify(response.body)).not.toContain('40000000-0000-4000-8000-000000000004');
  });

  it('rejects unauthorized department/company scope, invalid ranges, and foreign-company access', async () => {
    const prisma = fixture();
    const app = makeApp(prisma);

    const unauthorizedDepartment = await request(app)
      .get(`/api/training/report?scope=department&departmentId=${UUIDS.department2}`)
      .set('Authorization', `Bearer ${token(
        ['training.view_department', 'training.report'], UUIDS.employee3, 'manager-1'
      )}`);
    const companyEscalation = await request(app)
      .get('/api/training/report?scope=company')
      .set('Authorization', `Bearer ${token(
        ['training.view_department', 'training.report'], UUIDS.employee3, 'manager-1'
      )}`);
    const tooLong = await request(app)
      .get('/api/training/report?scope=company&from=2025-01-01&to=2026-07-31')
      .set('Authorization', `Bearer ${token(['training.view_company', 'training.report'])}`);
    const foreign = await request(app)
      .get('/api/training/report?scope=company')
      .set('Authorization', `Bearer ${token(['training.view_company', 'training.report'], null, 'foreign-hr', 'c2')}`);

    expect(unauthorizedDepartment.status).toBe(403);
    expect(companyEscalation.status).toBe(403);
    expect(tooLong.status).toBe(400);
    expect(foreign.status).toBe(200);
    expect(foreign.body.summary.courseCount).toBe(0);
    expect(foreign.body.summary.assignmentCount).toBe(0);
  });
});
