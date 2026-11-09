import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeApp, tokenFor } from './helpers';
import { addTrainingIdentity, makeTrainingPrisma, UUIDS } from './training_test_helpers';

const token = (permissions: string[], employeeId: string | null = null, id = 'hr-1', companyId = 'c1') =>
  tokenFor({ id, companyId, employeeId, permissions });

const validCourse = (overrides: Record<string, unknown> = {}) => ({
  title: 'Secure onboarding',
  description: 'Internal training description',
  category: 'onboarding',
  instructorName: 'Internal trainer',
  deliveryMode: 'online',
  location: null,
  startDate: '2026-07-15',
  endDate: '2026-07-16',
  durationHours: 8,
  capacity: 20,
  resources: [{ title: 'Training guide', type: 'document', url: 'https://example.com/training.pdf' }],
  ...overrides,
});

const createCourse = (prisma: any, body: Record<string, unknown> = validCourse()) =>
  request(makeApp(prisma))
    .post('/api/training/courses')
    .set('Authorization', `Bearer ${token(['training.view_company', 'training.manage', 'hr.view'])}`)
    .send(body);

describe('Sprint 10 training course lifecycle', () => {
  it('creates a safe draft with a server-generated code, resources, and private audit metadata', async () => {
    const prisma = makeTrainingPrisma();
    const response = await createCourse(prisma);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('draft');
    expect(response.body.courseCode).toMatch(/^TR-\d{6}-[A-F0-9]{8}$/);
    expect(response.body.resources).toEqual([
      expect.objectContaining({ title: 'Training guide', type: 'document' }),
    ]);
    expect(prisma._training.courses).toHaveLength(1);
    expect(prisma._training.resources).toHaveLength(1);
    expect(prisma._store.auditLogs).toHaveLength(1);
    expect(prisma._store.auditLogs[0].action).toBe('training.course.create');
    expect(prisma._store.auditLogs[0].details).toContain('resourceCount');
    expect(prisma._store.auditLogs[0].details).not.toMatch(/description|example\.com|trainer/i);
    expect(JSON.stringify(response.body)).not.toMatch(/password|permissions|email/i);
  });

  it('rejects unsafe resource URLs, invalid dates, and client-owned lifecycle fields', async () => {
    const prisma = makeTrainingPrisma();

    const unsafeUrl = await createCourse(prisma, validCourse({
      resources: [{ title: 'Guide', type: 'link', url: 'http://example.com/private' }],
    }));
    const reversedDates = await createCourse(prisma, validCourse({
      startDate: '2026-07-20',
      endDate: '2026-07-19',
    }));
    const clientStatus = await createCourse(prisma, { ...validCourse(), status: 'published' });

    expect(unsafeUrl.status).toBe(400);
    expect(reversedDates.status).toBe(400);
    expect(clientStatus.status).toBe(400);
    expect(prisma._training.courses).toHaveLength(0);
  });

  it('updates draft resources atomically, publishes once, and makes published content immutable', async () => {
    const prisma = makeTrainingPrisma();
    const created = await createCourse(prisma, validCourse({
      deliveryMode: 'onsite',
      location: 'Training room',
      resources: [],
    }));
    const courseId = created.body.id;
    const auth = token(['training.view_company', 'training.manage', 'hr.view']);
    const app = makeApp(prisma);

    const updated = await request(app)
      .put(`/api/training/courses/${courseId}`)
      .set('Authorization', `Bearer ${auth}`)
      .send(validCourse({
        title: 'Updated secure onboarding',
        deliveryMode: 'onsite',
        location: 'Main training room',
        resources: [{ title: 'Agenda', type: 'link', url: 'https://example.com/agenda' }],
      }));
    const published = await request(app)
      .post(`/api/training/courses/${courseId}/publish`)
      .set('Authorization', `Bearer ${auth}`)
      .send({});
    const repeatedPublish = await request(app)
      .post(`/api/training/courses/${courseId}/publish`)
      .set('Authorization', `Bearer ${auth}`)
      .send({});
    const immutable = await request(app)
      .put(`/api/training/courses/${courseId}`)
      .set('Authorization', `Bearer ${auth}`)
      .send(validCourse());

    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe('Updated secure onboarding');
    expect(updated.body.resources).toHaveLength(1);
    expect(published.status).toBe(200);
    expect(published.body.status).toBe('published');
    expect(repeatedPublish.status).toBe(409);
    expect(immutable.status).toBe(409);
  });

  it('requires publish details and preserves lifecycle history through cancel and archive', async () => {
    const prisma = makeTrainingPrisma();
    const created = await createCourse(prisma, validCourse({
      instructorName: null,
      resources: [],
    }));
    const auth = token(['training.view_company', 'training.manage', 'hr.view']);
    const app = makeApp(prisma);

    const publishBlocked = await request(app)
      .post(`/api/training/courses/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${auth}`)
      .send({});
    const cancelled = await request(app)
      .post(`/api/training/courses/${created.body.id}/cancel`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ cancellationReason: 'Schedule changed' });
    const archived = await request(app)
      .post(`/api/training/courses/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${auth}`)
      .send({});
    const hardDelete = await request(app)
      .delete(`/api/training/courses/${created.body.id}`)
      .set('Authorization', `Bearer ${auth}`);

    expect(publishBlocked.status).toBe(400);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('archived');
    expect(prisma._training.courses).toHaveLength(1);
    expect(hardDelete.status).toBe(405);
    expect(prisma._training.courses).toHaveLength(1);
  });

  it('scopes course history to company, managed department plus own, or own assignments', async () => {
    const prisma = makeTrainingPrisma();
    addTrainingIdentity(prisma, {
      userId: 'employee-1', employeeId: UUIDS.employee1, departmentId: UUIDS.department1,
      managerId: 'manager-1', permissions: ['training.view_own'],
    });
    addTrainingIdentity(prisma, {
      userId: 'employee-2', employeeId: UUIDS.employee2, departmentId: UUIDS.department2,
      permissions: ['training.view_own'],
    });
    const first = await createCourse(prisma);
    const second = await createCourse(prisma, validCourse({ title: 'Other department course' }));
    prisma._training.assignments.push(
      {
        id: '30000000-0000-4000-8000-000000000001', companyId: 'c1', courseId: first.body.id,
        employeeId: UUIDS.employee1, employeeNameSnapshot: 'Employee 1', employeeNumSnapshot: 'EMP-1',
        departmentIdSnapshot: UUIDS.department1, departmentNameSnapshot: 'Department 1', status: 'assigned',
        progressPercent: 0, assignedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
      },
      {
        id: '30000000-0000-4000-8000-000000000002', companyId: 'c1', courseId: second.body.id,
        employeeId: UUIDS.employee2, employeeNameSnapshot: 'Employee 2', employeeNumSnapshot: 'EMP-2',
        departmentIdSnapshot: UUIDS.department2, departmentNameSnapshot: 'Department 2', status: 'assigned',
        progressPercent: 0, assignedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
      }
    );
    const app = makeApp(prisma);

    const own = await request(app)
      .get('/api/training/courses?scope=own')
      .set('Authorization', `Bearer ${token(['training.view_own'], UUIDS.employee1, 'employee-1')}`);
    const department = await request(app)
      .get('/api/training/courses?scope=department')
      .set('Authorization', `Bearer ${token(['training.view_own', 'training.view_department'], UUIDS.employee1, 'manager-1')}`);
    const foreign = await request(app)
      .get(`/api/training/courses/${first.body.id}`)
      .set('Authorization', `Bearer ${token(['training.view_company'], null, 'foreign-hr', 'c2')}`);

    expect(own.status).toBe(200);
    expect(own.body.items.map((row: any) => row.id)).toEqual([first.body.id]);
    expect(department.status).toBe(200);
    expect(department.body.items.map((row: any) => row.id)).toEqual([first.body.id]);
    expect(foreign.status).toBe(404);
  });
});
