import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeApp, tokenFor } from './helpers';
import { addTrainingIdentity, makeTrainingPrisma, UUIDS } from './training_test_helpers';

const token = (permissions: string[], employeeId: string | null = null, id = 'hr-1', companyId = 'c1') =>
  tokenFor({ id, companyId, employeeId, permissions });

const course = (overrides: Record<string, unknown> = {}) => ({
  id: UUIDS.course1,
  companyId: 'c1',
  courseCode: 'TR-202607-DPT10001',
  title: 'Leadership basics',
  description: 'Private course description',
  category: 'leadership',
  instructorName: 'Private trainer',
  deliveryMode: 'online',
  location: null,
  startDate: new Date('2026-07-01T00:00:00.000Z'),
  endDate: new Date('2026-07-10T00:00:00.000Z'),
  durationHours: 4,
  capacity: 10,
  status: 'published',
  createdByUserId: 'hr-1',
  createdAt: new Date('2026-07-01T08:00:00.000Z'),
  publishedAt: new Date('2026-07-01T09:00:00.000Z'),
  completedAt: null,
  cancelledAt: null,
  archivedAt: null,
  updatedAt: new Date('2026-07-01T09:00:00.000Z'),
  ...overrides,
});

const assignment = (overrides: Record<string, unknown> = {}) => ({
  id: '30000000-0000-4000-8000-000000000001',
  companyId: 'c1',
  courseId: UUIDS.course1,
  employeeId: UUIDS.employee1,
  employeeNameSnapshot: 'Employee One',
  employeeNumSnapshot: 'EMP-0001',
  departmentIdSnapshot: UUIDS.department1,
  departmentNameSnapshot: 'Department One',
  status: 'completed',
  progressPercent: 100,
  score: 90,
  assignedByUserId: 'hr-1',
  assignedAt: new Date('2026-07-02T08:00:00.000Z'),
  startedAt: new Date('2026-07-03T08:00:00.000Z'),
  submittedAt: new Date('2026-07-08T08:00:00.000Z'),
  completedAt: new Date('2026-07-09T08:00:00.000Z'),
  reviewedByUserId: 'reviewer-1',
  reviewedAt: new Date('2026-07-09T09:00:00.000Z'),
  reviewNote: 'Private review note',
  createdAt: new Date('2026-07-02T08:00:00.000Z'),
  updatedAt: new Date('2026-07-09T09:00:00.000Z'),
  ...overrides,
});

const fixture = () => {
  const prisma = makeTrainingPrisma();
  addTrainingIdentity(prisma, {
    userId: 'manager-1',
    employeeId: UUIDS.employee3,
    departmentId: UUIDS.department1,
    managerId: 'manager-1',
    permissions: ['training.view_own', 'training.view_department', 'training.view_company', 'hr.view'],
  });
  addTrainingIdentity(prisma, {
    userId: 'employee-1',
    employeeId: UUIDS.employee1,
    departmentId: UUIDS.department1,
    permissions: ['training.view_own'],
  });
  addTrainingIdentity(prisma, {
    userId: 'employee-4',
    employeeId: '40000000-0000-4000-8000-000000000004',
    departmentId: UUIDS.department2,
    permissions: ['training.view_own'],
  });
  prisma.companyOwnership.findFirst.mockResolvedValue(null);
  prisma._training.courses.push(course());
  prisma._training.assignments.push(
    assignment(),
    assignment({
      id: '30000000-0000-4000-8000-000000000002',
      employeeId: '40000000-0000-4000-8000-000000000004',
      departmentIdSnapshot: UUIDS.department2,
      departmentNameSnapshot: 'Department Two',
      status: 'assigned',
      progressPercent: 0,
      score: null,
      submittedAt: null,
      completedAt: null,
      reviewedAt: null,
      reviewNote: null,
    }),
  );
  return prisma;
};

describe('GET /api/training/courses/:id/timeline', () => {
  it('returns chronological course and assignment events within scope', async () => {
    const prisma = fixture();
    const response = await request(makeApp(prisma))
      .get(`/api/training/courses/${UUIDS.course1}/timeline?scope=company`)
      .set('Authorization', `Bearer ${token(['training.view_company', 'hr.view'])}`);

    expect(response.status).toBe(200);
    expect(response.body.courseId).toBe(UUIDS.course1);
    expect(response.body.events.map((event: any) => event.type)).toEqual([
      'course.created',
      'course.published',
      'assignment.assigned',
      'assignment.assigned',
      'assignment.submitted',
      'assignment.reviewed',
    ]);
    expect(response.body.events[0].at).toBe('2026-07-01T08:00:00.000Z');
    expect(response.body.events.at(-1).at).toBe('2026-07-09T09:00:00.000Z');
    expect(JSON.stringify(response.body)).not.toMatch(/Employee One|Private review note|Private course description/i);
  });

  it('returns 404 for an unknown course id', async () => {
    const prisma = fixture();
    const response = await request(makeApp(prisma))
      .get(`/api/training/courses/${UUIDS.course2}/timeline?scope=company`)
      .set('Authorization', `Bearer ${token(['training.view_company', 'hr.view'])}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('TRAINING_COURSE_NOT_FOUND');
  });

  it('returns opaque 404 when the course is outside the caller scope', async () => {
    const prisma = fixture();
    prisma._training.courses.push(course({
      id: UUIDS.course2,
      courseCode: 'TR-202607-DPT20002',
      title: 'Other department course',
    }));
    prisma._training.assignments.push(assignment({
      id: '30000000-0000-4000-8000-000000000003',
      courseId: UUIDS.course2,
      employeeId: UUIDS.employee1,
      departmentIdSnapshot: UUIDS.department1,
      departmentNameSnapshot: 'Department One',
    }));
    const response = await request(makeApp(prisma))
      .get(`/api/training/courses/${UUIDS.course2}/timeline?scope=own`)
      .set('Authorization', `Bearer ${token(['training.view_own'], '40000000-0000-4000-8000-000000000004', 'employee-4')}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('TRAINING_COURSE_NOT_FOUND');
  });

  it('limits department scope to managed assignments only', async () => {
    const prisma = fixture();
    const response = await request(makeApp(prisma))
      .get(`/api/training/courses/${UUIDS.course1}/timeline?scope=department`)
      .set('Authorization', `Bearer ${token(
        ['training.view_own', 'training.view_department'],
        UUIDS.employee3,
        'manager-1',
      )}`);

    expect(response.status).toBe(200);
    expect(response.body.events.filter((event: any) => event.type.startsWith('assignment.'))).toHaveLength(3);
    expect(JSON.stringify(response.body)).not.toContain('40000000-0000-4000-8000-000000000004');
  });
});
