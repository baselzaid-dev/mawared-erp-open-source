import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeApp, tokenFor } from './helpers';
import { addTrainingIdentity, makeTrainingPrisma, UUIDS } from './training_test_helpers';

/**
 * Commercial P4 — training certificates and evaluations.
 *
 * The two artifacts deliberately have DIFFERENT retry semantics, and these
 * tests pin that difference down:
 *  - a certificate is a statement of an existing fact, so an exact retry
 *    replays the same row;
 *  - an evaluation is a judgment, so a second one is a conflict, never an
 *    overwrite and never a silent replay.
 */

const hrPermissions = [
  'hr.view',
  'training.view_company',
  'training.manage',
  'training.assign',
  'training.review',
  'training.certificate.issue',
  'training.evaluation.create',
  'training.evaluation.view',
];

const token = (
  permissions: string[],
  employeeId: string | null = null,
  id = 'hr-1',
  companyId = 'c1',
) => tokenFor({ id, companyId, employeeId, permissions });

const courseBody = () => ({
  title: 'Security fundamentals',
  description: null,
  category: 'security',
  instructorName: 'Internal trainer',
  deliveryMode: 'online',
  location: null,
  startDate: '2026-07-15',
  endDate: '2026-07-20',
  durationHours: 6,
  capacity: 10,
  resources: [],
});

/** Drives one employee all the way to a completed assignment. */
const completedAssignment = async (prisma: any) => {
  const app = makeApp(prisma);
  const auth = token(hrPermissions);

  const created = await request(app)
    .post('/api/training/courses')
    .set('Authorization', `Bearer ${auth}`)
    .send(courseBody());
  expect(created.status).toBe(201);
  await request(app)
    .post(`/api/training/courses/${created.body.id}/publish`)
    .set('Authorization', `Bearer ${auth}`)
    .send({});

  const assigned = await request(app)
    .post(`/api/training/courses/${created.body.id}/assignments`)
    .set('Authorization', `Bearer ${auth}`)
    .send({ employeeIds: [UUIDS.employee1] });
  expect(assigned.status).toBe(201);
  const assignmentId = prisma._training.assignments[0].id as string;

  const submitted = await request(app)
    .post(`/api/training/assignments/${assignmentId}/submit`)
    .set('Authorization', `Bearer ${token(['training.view_own'], UUIDS.employee1, 'employee-1')}`)
    .send({ completionNote: 'Finished all modules' });
  expect(submitted.status).toBe(200);

  const reviewed = await request(app)
    .post(`/api/training/assignments/${assignmentId}/review`)
    .set('Authorization', `Bearer ${auth}`)
    .send({ action: 'accept', score: 90 });
  expect(reviewed.status).toBe(200);

  return assignmentId;
};

const seedIdentities = (prisma: any) => {
  addTrainingIdentity(prisma, {
    userId: 'employee-1',
    employeeId: UUIDS.employee1,
    departmentId: UUIDS.department1,
    permissions: ['training.view_own'],
    name: 'Active employee',
  });
  addTrainingIdentity(prisma, {
    userId: 'employee-2',
    employeeId: UUIDS.employee2,
    departmentId: UUIDS.department2,
    permissions: ['training.view_own'],
    name: 'Other department employee',
  });
};

describe('P4 training certificates', () => {
  it('issues a certificate with frozen snapshots and an audited, score-free payload', async () => {
    const prisma = makeTrainingPrisma();
    seedIdentities(prisma);
    const assignmentId = await completedAssignment(prisma);

    const response = await request(makeApp(prisma))
      .post(`/api/training/assignments/${assignmentId}/certificate`)
      .set('Authorization', `Bearer ${token(hrPermissions)}`)
      .send({});

    expect(response.status).toBe(201);
    expect(response.body.serialNumber).toMatch(/^CERT-\d{6}-[0-9A-F]{10}$/);
    expect(response.body.courseTitle).toBe('Security fundamentals');
    expect(response.body.employeeName).toBe('Active employee');

    const audit = prisma._store.auditLogs.find(
      (row: any) => row.action === 'training.certificate.issue',
    );
    expect(audit).toBeTruthy();
    // The audit sanitizer forbids a `score` key outright; assert nothing slipped past.
    expect(audit.details).not.toMatch(/score/i);
  });

  it('replays the same certificate on an exact retry rather than minting a second one', async () => {
    const prisma = makeTrainingPrisma();
    seedIdentities(prisma);
    const assignmentId = await completedAssignment(prisma);
    const app = makeApp(prisma);
    const auth = token(hrPermissions);

    const first = await request(app)
      .post(`/api/training/assignments/${assignmentId}/certificate`)
      .set('Authorization', `Bearer ${auth}`)
      .send({});
    const second = await request(app)
      .post(`/api/training/assignments/${assignmentId}/certificate`)
      .set('Authorization', `Bearer ${auth}`)
      .send({});

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.serialNumber).toBe(first.body.serialNumber);
    expect(prisma._training.certificates).toHaveLength(1);
    // The replay must not duplicate the side effects of the original issue.
    expect(
      prisma._store.auditLogs.filter((row: any) => row.action === 'training.certificate.issue'),
    ).toHaveLength(1);
  });

  it('refuses to issue for an assignment that is not completed', async () => {
    const prisma = makeTrainingPrisma();
    seedIdentities(prisma);
    const app = makeApp(prisma);
    const auth = token(hrPermissions);
    const created = await request(app)
      .post('/api/training/courses')
      .set('Authorization', `Bearer ${auth}`)
      .send(courseBody());
    await request(app)
      .post(`/api/training/courses/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${auth}`)
      .send({});
    await request(app)
      .post(`/api/training/courses/${created.body.id}/assignments`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ employeeIds: [UUIDS.employee1] });
    const assignmentId = prisma._training.assignments[0].id;

    const response = await request(app)
      .post(`/api/training/assignments/${assignmentId}/certificate`)
      .set('Authorization', `Bearer ${auth}`)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('TRAINING_ASSIGNMENT_NOT_COMPLETED');
    expect(prisma._training.certificates).toHaveLength(0);
  });

  it('needs the issue permission, which training.manage alone does not grant', async () => {
    const prisma = makeTrainingPrisma();
    seedIdentities(prisma);
    const assignmentId = await completedAssignment(prisma);

    const response = await request(makeApp(prisma))
      .post(`/api/training/assignments/${assignmentId}/certificate`)
      .set(
        'Authorization',
        `Bearer ${token(['training.view_company', 'training.manage'], null, 'manager-1')}`,
      )
      .send({});

    expect(response.status).toBe(403);
  });

  it('lets the subject employee read their own certificate', async () => {
    const prisma = makeTrainingPrisma();
    seedIdentities(prisma);
    const assignmentId = await completedAssignment(prisma);
    await request(makeApp(prisma))
      .post(`/api/training/assignments/${assignmentId}/certificate`)
      .set('Authorization', `Bearer ${token(hrPermissions)}`)
      .send({});

    const response = await request(makeApp(prisma))
      .get(`/api/training/assignments/${assignmentId}/certificate`)
      .set('Authorization', `Bearer ${token(['training.view_own'], UUIDS.employee1, 'employee-1')}`);

    expect(response.status).toBe(200);
    expect(response.body.employeeName).toBe('Active employee');
  });

  it('hides a certificate from an employee in another department', async () => {
    const prisma = makeTrainingPrisma();
    seedIdentities(prisma);
    const assignmentId = await completedAssignment(prisma);
    await request(makeApp(prisma))
      .post(`/api/training/assignments/${assignmentId}/certificate`)
      .set('Authorization', `Bearer ${token(hrPermissions)}`)
      .send({});

    const response = await request(makeApp(prisma))
      .get(`/api/training/assignments/${assignmentId}/certificate`)
      .set('Authorization', `Bearer ${token(['training.view_own'], UUIDS.employee2, 'employee-2')}`);

    expect(response.status).toBe(404);
  });

  it('is unreachable across companies', async () => {
    const prisma = makeTrainingPrisma();
    seedIdentities(prisma);
    const assignmentId = await completedAssignment(prisma);

    const response = await request(makeApp(prisma))
      .post(`/api/training/assignments/${assignmentId}/certificate`)
      .set('Authorization', `Bearer ${token(hrPermissions, null, 'intruder-1', 'c2')}`)
      .send({});

    expect(response.status).toBe(404);
    expect(prisma._training.certificates).toHaveLength(0);
  });
});

describe('P4 training evaluations', () => {
  const evaluationBody = {
    effectivenessScore: 4,
    knowledgeScore: 5,
    applicationScore: 3,
    recommendation: 'recommended' as const,
    comment: 'Applied the material well in the follow-up exercise.',
  };

  it('records an evaluation and keeps its scores and comment out of the audit log', async () => {
    const prisma = makeTrainingPrisma();
    seedIdentities(prisma);
    const assignmentId = await completedAssignment(prisma);

    const response = await request(makeApp(prisma))
      .post(`/api/training/assignments/${assignmentId}/evaluation`)
      .set('Authorization', `Bearer ${token(hrPermissions)}`)
      .send(evaluationBody);

    expect(response.status).toBe(201);
    expect(response.body.effectivenessScore).toBe(4);
    expect(response.body.recommendation).toBe('recommended');

    const audit = prisma._store.auditLogs.find(
      (row: any) => row.action === 'training.evaluation.create',
    );
    expect(audit).toBeTruthy();
    expect(audit.details).not.toMatch(/score/i);
    expect(audit.details).not.toContain('follow-up exercise');
  });

  it('treats a second evaluation as a conflict, never an overwrite or a replay', async () => {
    const prisma = makeTrainingPrisma();
    seedIdentities(prisma);
    const assignmentId = await completedAssignment(prisma);
    const app = makeApp(prisma);
    const auth = token(hrPermissions);

    const first = await request(app)
      .post(`/api/training/assignments/${assignmentId}/evaluation`)
      .set('Authorization', `Bearer ${auth}`)
      .send(evaluationBody);
    const second = await request(app)
      .post(`/api/training/assignments/${assignmentId}/evaluation`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ ...evaluationBody, effectivenessScore: 1, recommendation: 'repeat_required' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('TRAINING_EVALUATION_EXISTS');
    expect(prisma._training.evaluations).toHaveLength(1);
    expect(prisma._training.evaluations[0].effectivenessScore).toBe(4);
  });

  it('rejects out-of-range scores and unknown recommendations', async () => {
    const prisma = makeTrainingPrisma();
    seedIdentities(prisma);
    const assignmentId = await completedAssignment(prisma);
    const app = makeApp(prisma);
    const auth = token(hrPermissions);

    const outOfRange = await request(app)
      .post(`/api/training/assignments/${assignmentId}/evaluation`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ ...evaluationBody, knowledgeScore: 9 });
    expect(outOfRange.status).toBe(400);

    const badRecommendation = await request(app)
      .post(`/api/training/assignments/${assignmentId}/evaluation`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ ...evaluationBody, recommendation: 'promote' });
    expect(badRecommendation.status).toBe(400);

    // Overposting the subject is refused too: employeeId is server-derived.
    const overposted = await request(app)
      .post(`/api/training/assignments/${assignmentId}/evaluation`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ ...evaluationBody, employeeId: UUIDS.employee2 });
    expect(overposted.status).toBe(400);

    expect(prisma._training.evaluations).toHaveLength(0);
  });

  it('blocks self-evaluation the same way self-review is blocked', async () => {
    const prisma = makeTrainingPrisma();
    seedIdentities(prisma);
    const assignmentId = await completedAssignment(prisma);

    const response = await request(makeApp(prisma))
      .post(`/api/training/assignments/${assignmentId}/evaluation`)
      .set(
        'Authorization',
        `Bearer ${token(
          ['training.view_own', 'training.evaluation.create'],
          UUIDS.employee1,
          'employee-1',
        )}`,
      )
      .send(evaluationBody);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('TRAINING_SELF_EVALUATION_FORBIDDEN');
  });

  it('does not notify the subject about a record they cannot read', async () => {
    const prisma = makeTrainingPrisma();
    seedIdentities(prisma);
    const assignmentId = await completedAssignment(prisma);
    const before = prisma._store.notifications.length;

    await request(makeApp(prisma))
      .post(`/api/training/assignments/${assignmentId}/evaluation`)
      .set('Authorization', `Bearer ${token(hrPermissions)}`)
      .send(evaluationBody);

    expect(prisma._store.notifications.length).toBe(before);
  });

  it('requires the dedicated view permission to read — training scope is not enough', async () => {
    const prisma = makeTrainingPrisma();
    seedIdentities(prisma);
    const assignmentId = await completedAssignment(prisma);
    await request(makeApp(prisma))
      .post(`/api/training/assignments/${assignmentId}/evaluation`)
      .set('Authorization', `Bearer ${token(hrPermissions)}`)
      .send(evaluationBody);

    // Full company training visibility, but no evaluation.view key.
    const withoutKey = await request(makeApp(prisma))
      .get(`/api/training/assignments/${assignmentId}/evaluation`)
      .set(
        'Authorization',
        `Bearer ${token(['training.view_company', 'training.manage'], null, 'manager-1')}`,
      );
    expect(withoutKey.status).toBe(403);

    // The subject employee cannot read their own evaluation either.
    const subject = await request(makeApp(prisma))
      .get(`/api/training/assignments/${assignmentId}/evaluation`)
      .set('Authorization', `Bearer ${token(['training.view_own'], UUIDS.employee1, 'employee-1')}`);
    expect(subject.status).toBe(403);

    const withKey = await request(makeApp(prisma))
      .get(`/api/training/assignments/${assignmentId}/evaluation`)
      .set('Authorization', `Bearer ${token(hrPermissions)}`);
    expect(withKey.status).toBe(200);
    expect(withKey.body.knowledgeScore).toBe(5);
  });

  it('is unreachable across companies', async () => {
    const prisma = makeTrainingPrisma();
    seedIdentities(prisma);
    const assignmentId = await completedAssignment(prisma);

    const response = await request(makeApp(prisma))
      .post(`/api/training/assignments/${assignmentId}/evaluation`)
      .set('Authorization', `Bearer ${token(hrPermissions, null, 'intruder-1', 'c2')}`)
      .send(evaluationBody);

    expect(response.status).toBe(404);
    expect(prisma._training.evaluations).toHaveLength(0);
  });
});
