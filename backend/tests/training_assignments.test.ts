import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeApp, tokenFor } from './helpers';
import { addTrainingIdentity, makeTrainingPrisma, UUIDS } from './training_test_helpers';

const hrPermissions = [
  'hr.view',
  'training.view_company',
  'training.manage',
  'training.assign',
  'training.review',
  'training.report',
];

const token = (permissions: string[], employeeId: string | null = null, id = 'hr-1', companyId = 'c1') =>
  tokenFor({ id, companyId, employeeId, permissions });

const courseBody = (capacity = 10) => ({
  title: 'Security fundamentals',
  description: null,
  category: 'security',
  instructorName: 'Internal trainer',
  deliveryMode: 'online',
  location: null,
  startDate: '2026-07-15',
  endDate: '2026-07-20',
  durationHours: 6,
  capacity,
  resources: [{ title: 'Guide', type: 'link', url: 'https://example.com/guide' }],
});

const createPublishedCourse = async (prisma: any, capacity = 10) => {
  const app = makeApp(prisma);
  const auth = token(hrPermissions);
  const created = await request(app)
    .post('/api/training/courses')
    .set('Authorization', `Bearer ${auth}`)
    .send(courseBody(capacity));
  const published = await request(app)
    .post(`/api/training/courses/${created.body.id}/publish`)
    .set('Authorization', `Bearer ${auth}`)
    .send({});
  expect(published.status).toBe(200);
  return created.body.id as string;
};

const assign = (prisma: any, courseId: string, employeeIds: string[], auth = token(hrPermissions)) =>
  request(makeApp(prisma))
    .post(`/api/training/courses/${courseId}/assignments`)
    .set('Authorization', `Bearer ${auth}`)
    .send({ employeeIds });

describe('Sprint 10 training assignments and review', () => {
  it('returns only active eligible employees and protects owner records', async () => {
    const prisma = makeTrainingPrisma();
    addTrainingIdentity(prisma, {
      userId: 'employee-1', employeeId: UUIDS.employee1, departmentId: UUIDS.department1,
      permissions: ['training.view_own'], name: 'Active employee',
    });
    addTrainingIdentity(prisma, {
      userId: 'owner-1', employeeId: UUIDS.employee2, departmentId: UUIDS.department1,
      permissions: ['admin.full'], roleName: 'Admin', name: 'Protected owner',
    });
    addTrainingIdentity(prisma, {
      userId: 'inactive-1', employeeId: UUIDS.employee3, departmentId: UUIDS.department1,
      permissions: ['training.view_own'], status: 'inactive', name: 'Inactive employee',
    });
    const app = makeApp(prisma);

    const normalAssigner = await request(app)
      .get('/api/training/eligible-employees')
      .set('Authorization', `Bearer ${token(['training.assign'])}`);
    const hrAssigner = await request(app)
      .get('/api/training/eligible-employees')
      .set('Authorization', `Bearer ${token(['training.assign', 'hr.view'])}`);

    expect(normalAssigner.status).toBe(200);
    expect(normalAssigner.body.map((row: any) => row.employeeId)).toEqual([UUIDS.employee1]);
    expect(hrAssigner.body.map((row: any) => row.employeeId)).toEqual([UUIDS.employee1, UUIDS.employee2]);
    expect(JSON.stringify(hrAssigner.body)).not.toMatch(/password|permissions|email|salary/i);
  });

  it('creates a bulk assignment atomically with capacity, notifications, and safe audit metadata', async () => {
    const prisma = makeTrainingPrisma();
    addTrainingIdentity(prisma, { userId: 'employee-1', employeeId: UUIDS.employee1, departmentId: UUIDS.department1 });
    addTrainingIdentity(prisma, { userId: 'employee-2', employeeId: UUIDS.employee2, departmentId: UUIDS.department1 });
    const courseId = await createPublishedCourse(prisma, 2);

    const response = await assign(prisma, courseId, [UUIDS.employee1, UUIDS.employee2]);

    expect(response.status).toBe(201);
    expect(response.body).toHaveLength(2);
    expect(response.body.every((row: any) => row.status === 'assigned' && row.progressPercent === 0)).toBe(true);
    expect(prisma._training.assignments).toHaveLength(2);
    expect(prisma._store.notifications).toHaveLength(2);
    const audit = prisma._store.auditLogs.find((row: any) => row.action === 'training.assignment.bulk_create');
    expect(audit.details).toContain('assignmentCount');
    expect(audit.details).not.toMatch(/employeeName|progress|description|url/i);
    expect(JSON.stringify(response.body)).not.toMatch(/password|permissions|email/i);
  });

  it('rejects duplicate IDs, inactive/foreign employees, existing assignments, and capacity overflow without partial rows', async () => {
    const prisma = makeTrainingPrisma();
    addTrainingIdentity(prisma, { userId: 'employee-1', employeeId: UUIDS.employee1, departmentId: UUIDS.department1 });
    addTrainingIdentity(prisma, { userId: 'employee-2', employeeId: UUIDS.employee2, departmentId: UUIDS.department1 });
    addTrainingIdentity(prisma, {
      userId: 'inactive-1', employeeId: UUIDS.employee3, departmentId: UUIDS.department1, status: 'inactive',
    });
    const courseId = await createPublishedCourse(prisma, 1);

    const duplicateIds = await assign(prisma, courseId, [UUIDS.employee1, UUIDS.employee1]);
    const inactive = await assign(prisma, courseId, [UUIDS.employee3]);
    const foreign = await assign(prisma, courseId, ['40000000-0000-4000-8000-000000000099']);
    const capacity = await assign(prisma, courseId, [UUIDS.employee1, UUIDS.employee2]);

    expect(duplicateIds.status).toBe(400);
    expect(inactive.status).toBe(400);
    expect(foreign.status).toBe(400);
    expect(capacity.status).toBe(409);
    expect(prisma._training.assignments).toHaveLength(0);

    const first = await assign(prisma, courseId, [UUIDS.employee1]);
    const repeated = await assign(prisma, courseId, [UUIDS.employee1]);
    expect(first.status).toBe(201);
    expect(repeated.status).toBe(409);
    expect(prisma._training.assignments).toHaveLength(1);
  });

  it('allows only the assignment owner to update progress and submit for second-person review', async () => {
    const prisma = makeTrainingPrisma();
    addTrainingIdentity(prisma, {
      userId: 'employee-1', employeeId: UUIDS.employee1, departmentId: UUIDS.department1,
      permissions: ['training.view_own'],
    });
    addTrainingIdentity(prisma, {
      userId: 'reviewer-1', employeeId: UUIDS.employee2, departmentId: UUIDS.department1,
      permissions: ['training.review', 'training.view_company'], roleName: 'HR Manager',
    });
    const courseId = await createPublishedCourse(prisma);
    const assigned = await assign(prisma, courseId, [UUIDS.employee1]);
    const assignmentId = assigned.body[0].id;
    const app = makeApp(prisma);
    const employeeAuth = token(['training.view_own'], UUIDS.employee1, 'employee-1');

    const denied = await request(app)
      .patch(`/api/training/assignments/${assignmentId}/progress`)
      .set('Authorization', `Bearer ${token(['training.view_own'], UUIDS.employee2, 'employee-2')}`)
      .send({ progressPercent: 40 });
    const progress = await request(app)
      .patch(`/api/training/assignments/${assignmentId}/progress`)
      .set('Authorization', `Bearer ${employeeAuth}`)
      .send({ progressPercent: 40 });
    const submitted = await request(app)
      .post(`/api/training/assignments/${assignmentId}/submit`)
      .set('Authorization', `Bearer ${employeeAuth}`)
      .send({ completionNote: 'Private completion note' });
    const selfReview = await request(app)
      .post(`/api/training/assignments/${assignmentId}/review`)
      .set('Authorization', `Bearer ${token(['admin.full'], UUIDS.employee1, 'employee-1')}`)
      .send({ action: 'accept', score: 92 });
    const accepted = await request(app)
      .post(`/api/training/assignments/${assignmentId}/review`)
      .set('Authorization', `Bearer ${token(['training.review'], UUIDS.employee2, 'reviewer-1')}`)
      .send({ action: 'accept', score: 92, reviewNote: 'Private review note' });
    const terminalProgress = await request(app)
      .patch(`/api/training/assignments/${assignmentId}/progress`)
      .set('Authorization', `Bearer ${employeeAuth}`)
      .send({ progressPercent: 80 });

    expect(denied.status).toBe(404);
    expect(progress.status).toBe(200);
    expect(progress.body).toMatchObject({ status: 'in_progress', progressPercent: 40 });
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'submitted', progressPercent: 100 });
    expect(prisma._store.notifications.some((row: any) => row.userId === 'reviewer-1')).toBe(true);
    expect(selfReview.status).toBe(403);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'completed', score: 92 });
    expect(terminalProgress.status).toBe(409);
    const privateAudits = prisma._store.auditLogs.filter((row: any) => row.action.startsWith('training.assignment.'));
    const privateAuditDetails = privateAudits.map((row: any) =>
      typeof row.details === 'string' ? JSON.parse(row.details) : (row.details ?? {}),
    );
    expect(JSON.stringify(privateAuditDetails)).not.toMatch(
      /Private|progressPercent|completionNote|reviewNote|"score"/i,
    );
  });

  it('requires a return note, permits resubmission work, and retains cancelled assignment history', async () => {
    const prisma = makeTrainingPrisma();
    addTrainingIdentity(prisma, {
      userId: 'employee-1', employeeId: UUIDS.employee1, departmentId: UUIDS.department1,
      permissions: ['training.view_own'],
    });
    addTrainingIdentity(prisma, {
      userId: 'reviewer-1', employeeId: UUIDS.employee2, departmentId: UUIDS.department1,
      permissions: ['training.review', 'training.view_company'],
    });
    const courseId = await createPublishedCourse(prisma);
    const assigned = await assign(prisma, courseId, [UUIDS.employee1]);
    const assignmentId = assigned.body[0].id;
    const app = makeApp(prisma);
    const employeeAuth = token(['training.view_own'], UUIDS.employee1, 'employee-1');
    const reviewerAuth = token(['training.review'], UUIDS.employee2, 'reviewer-1');
    await request(app)
      .post(`/api/training/assignments/${assignmentId}/submit`)
      .set('Authorization', `Bearer ${employeeAuth}`)
      .send({});

    const missingNote = await request(app)
      .post(`/api/training/assignments/${assignmentId}/review`)
      .set('Authorization', `Bearer ${reviewerAuth}`)
      .send({ action: 'return' });
    const returned = await request(app)
      .post(`/api/training/assignments/${assignmentId}/review`)
      .set('Authorization', `Bearer ${reviewerAuth}`)
      .send({ action: 'return', reviewNote: 'Please verify the final section' });
    const resumed = await request(app)
      .patch(`/api/training/assignments/${assignmentId}/progress`)
      .set('Authorization', `Bearer ${employeeAuth}`)
      .send({ progressPercent: 75 });
    const cancelled = await request(app)
      .post(`/api/training/assignments/${assignmentId}/cancel`)
      .set('Authorization', `Bearer ${token(['training.manage'])}`)
      .send({ cancellationReason: 'Course replaced' });
    const hardDelete = await request(app)
      .delete(`/api/training/assignments/${assignmentId}`)
      .set('Authorization', `Bearer ${token(['training.manage'])}`);

    expect(missingNote.status).toBe(400);
    expect(returned.status).toBe(200);
    expect(returned.body.status).toBe('returned');
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('in_progress');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(hardDelete.status).toBe(405);
    expect(prisma._training.assignments).toHaveLength(1);
  });

  it('cancels nonterminal assignments with the course and completes only settled published courses', async () => {
    const prisma = makeTrainingPrisma();
    addTrainingIdentity(prisma, { userId: 'employee-1', employeeId: UUIDS.employee1, departmentId: UUIDS.department1 });
    const firstCourseId = await createPublishedCourse(prisma);
    const firstAssignment = await assign(prisma, firstCourseId, [UUIDS.employee1]);
    const auth = token(hrPermissions);
    const app = makeApp(prisma);

    const blockedComplete = await request(app)
      .post(`/api/training/courses/${firstCourseId}/complete`)
      .set('Authorization', `Bearer ${auth}`)
      .send({});
    const cancelledCourse = await request(app)
      .post(`/api/training/courses/${firstCourseId}/cancel`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ cancellationReason: 'Programme cancelled' });

    expect(blockedComplete.status).toBe(409);
    expect(cancelledCourse.status).toBe(200);
    expect(cancelledCourse.body.status).toBe('cancelled');
    expect(prisma._training.assignments.find((row: any) => row.id === firstAssignment.body[0].id).status).toBe('cancelled');

    const secondCourseId = await createPublishedCourse(prisma);
    const secondAssignment = await assign(prisma, secondCourseId, [UUIDS.employee1]);
    prisma._training.assignments.find((row: any) => row.id === secondAssignment.body[0].id).status = 'completed';
    const completedCourse = await request(app)
      .post(`/api/training/courses/${secondCourseId}/complete`)
      .set('Authorization', `Bearer ${auth}`)
      .send({});
    expect(completedCourse.status).toBe(200);
    expect(completedCourse.body.status).toBe('completed');
  });
});
