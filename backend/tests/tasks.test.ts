import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

const futureDate = (days = 7): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const employee = (
  id: string,
  departmentId = 'd1',
  options: { companyId?: string; owner?: boolean; active?: boolean; linkedUser?: boolean } = {}
) => ({
  id,
  companyId: options.companyId ?? 'c1',
  employeeNum: `EMP-${id}`,
  status: options.active === false ? 'inactive' : 'active',
  departmentId,
  user: options.linkedUser === false ? null : {
    id: `user-${id}`,
    name: `Employee ${id}`,
    role: { permissions: JSON.stringify(options.owner ? ['admin.full'] : ['tasks.view_own']) },
  },
  department: { id: departmentId, name: `Department ${departmentId}`, managerId: 'manager-1' },
});

const token = (
  permissions: string[],
  employeeId: string | null = 'e1',
  id = 'u1',
  companyId = 'c1'
) => tokenFor({ id, companyId, employeeId, permissions });

const companyManagerPermissions = [
  'tasks.view_company',
  'tasks.create',
  'tasks.assign_company',
  'tasks.review',
];

const createTask = async (prisma: any, employeeIds = ['e1'], authToken?: string) =>
  request(makeApp(prisma))
    .post('/api/tasks')
    .set('Authorization', `Bearer ${authToken ?? token(companyManagerPermissions, 'creator-employee', 'creator-1')}`)
    .send({
      title: 'Prepare monthly summary',
      description: 'Complete the reviewed figures',
      priority: 'high',
      dueDate: futureDate(),
      employeeIds,
    });

describe('Sprint 7 task workflow', () => {
  it('requires task creation and assignment permissions and rejects duplicate assignees', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const employeeCreate = await createTask(
      prisma,
      ['e1'],
      token(['tasks.view_own'], 'e1', 'employee-user')
    );
    expect(employeeCreate.status).toBe(403);

    const duplicate = await createTask(prisma, ['e1', 'e1']);
    expect(duplicate.status).toBe(400);
    expect(prisma._store.tasks).toHaveLength(0);
  });

  it('returns only active in-scope eligible employees and always hides owner accounts', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(
      employee('e1', 'd1'),
      employee('e2', 'd2'),
      employee('owner', 'd1'),
      employee('inactive', 'd1', { active: false })
    );
    prisma.companyOwnership.findFirst.mockResolvedValue({ userId: 'user-owner' });
    prisma.department.findMany.mockResolvedValue([{ id: 'd1' }]);

    const response = await request(makeApp(prisma))
      .get('/api/tasks/eligible-employees')
      .set('Authorization', `Bearer ${token(['tasks.assign_department'], 'manager-employee', 'manager-1')}`);

    expect(response.status).toBe(200);
    expect(response.body.map((row: any) => row.employeeId)).toEqual(['e1']);
    expect(JSON.stringify(response.body)).not.toMatch(/password|permissions|email/i);
  });

  it('creates all assignments, notifications, and a safe audit atomically', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'), employee('e2'));

    const response = await createTask(prisma, ['e1', 'e2']);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('active');
    expect(response.body.assignments).toHaveLength(2);
    expect(prisma._store.taskAssignments).toHaveLength(2);
    expect(prisma._store.notifications).toHaveLength(2);
    expect(prisma._store.auditLogs).toHaveLength(1);
    expect(prisma._store.auditLogs[0].action).toBe('task.create');
    expect(prisma._store.auditLogs[0].details).toContain('assignmentCount');
    expect(JSON.stringify(response.body)).not.toMatch(/password|permissions|email/i);
  });

  it('rolls back task creation when a required notification fails', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    prisma.notification.create.mockRejectedValueOnce(new Error('notification unavailable'));

    const response = await createTask(prisma);

    expect(response.status).toBe(500);
    expect(prisma._store.tasks).toHaveLength(0);
    expect(prisma._store.taskAssignments).toHaveLength(0);
    expect(prisma._store.notifications).toHaveLength(0);
    expect(prisma._store.auditLogs).toHaveLength(0);
  });

  it('enforces department assignment scope and blocks owner targets', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1', 'd1'), employee('e2', 'd2'));
    prisma.department.findMany.mockResolvedValue([{ id: 'd1' }]);
    const managerToken = token(
      ['tasks.view_department', 'tasks.create', 'tasks.assign_department', 'tasks.review'],
      'manager-employee',
      'manager-1'
    );

    const outOfScope = await createTask(prisma, ['e2'], managerToken);
    expect(outOfScope.status).toBe(403);
    expect(prisma._store.tasks).toHaveLength(0);

    prisma._store.employees.push(employee('owner', 'd1'));
    prisma.companyOwnership.findFirst.mockResolvedValue({ userId: 'user-owner' });
    const ownerTarget = await createTask(prisma, ['owner'], managerToken);
    expect(ownerTarget.status).toBe(403);
    expect(prisma._store.tasks).toHaveLength(0);
  });

  it('returns only the employee own assignment while company viewers see all assignees', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'), employee('e2'));
    const created = await createTask(prisma, ['e1', 'e2']);
    expect(created.status).toBe(201);

    const own = await request(makeApp(prisma))
      .get('/api/tasks?scope=own')
      .set('Authorization', `Bearer ${token(['tasks.view_own'], 'e1', 'user-e1')}`);
    const company = await request(makeApp(prisma))
      .get('/api/tasks?scope=company')
      .set('Authorization', `Bearer ${token(['tasks.view_company'], null, 'hr-1')}`);

    expect(own.status).toBe(200);
    expect(own.body).toHaveLength(1);
    expect(own.body[0].assignments.map((row: any) => row.employee.id)).toEqual(['e1']);
    expect(company.status).toBe(200);
    expect(company.body[0].assignments).toHaveLength(2);
  });

  it('limits manager list and review actions to managed departments', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1', 'd1'), employee('e2', 'd2'));
    const created = await createTask(prisma, ['e1', 'e2']);
    prisma.department.findMany.mockResolvedValue([{ id: 'd1' }]);
    const managerToken = token(
      ['tasks.view_department', 'tasks.review'],
      'manager-employee',
      'manager-1'
    );
    const app = makeApp(prisma);

    const list = await request(app)
      .get('/api/tasks?scope=department')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(list.status).toBe(200);
    expect(list.body[0].assignments.map((row: any) => row.employee.id)).toEqual(['e1']);

    prisma._store.taskAssignments.forEach((row: any) => { row.status = 'submitted'; row.completionDetails = 'done'; });
    const e2Assignment = created.body.assignments.find((row: any) => row.employee.id === 'e2');
    const denied = await request(app)
      .post(`/api/task-assignments/${e2Assignment.id}/review`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ action: 'accept' });
    expect(denied.status).toBe(404);

    const e1Assignment = created.body.assignments.find((row: any) => row.employee.id === 'e1');
    const accepted = await request(app)
      .post(`/api/task-assignments/${e1Assignment.id}/review`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ action: 'accept' });
    expect(accepted.status).toBe(200);
  });

  it('validates priority and bounded paired task dates', async () => {
    const prisma = makeFakePrisma();
    const auth = token(['tasks.view_company'], null, 'hr-1');
    const app = makeApp(prisma);

    const invalidPriority = await request(app)
      .get('/api/tasks?scope=company&priority=critical')
      .set('Authorization', `Bearer ${auth}`);
    expect(invalidPriority.status).toBe(400);

    const missingEnd = await request(app)
      .get('/api/tasks?scope=company&from=2026-01-01')
      .set('Authorization', `Bearer ${auth}`);
    expect(missingEnd.status).toBe(400);

    const tooLong = await request(app)
      .get('/api/tasks?scope=company&from=2025-01-01&to=2026-12-31')
      .set('Authorization', `Bearer ${auth}`);
    expect(tooLong.status).toBe(400);
  });

  it('allows only assignment owners to start and submit with completion details', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const created = await createTask(prisma);
    const assignmentId = created.body.assignments[0].id;
    const app = makeApp(prisma);

    const missingDetails = await request(app)
      .patch(`/api/task-assignments/${assignmentId}/progress`)
      .set('Authorization', `Bearer ${token(['tasks.view_own'], 'e1', 'user-e1')}`)
      .send({ status: 'submitted' });
    expect(missingDetails.status).toBe(400);

    const wrongEmployee = await request(app)
      .patch(`/api/task-assignments/${assignmentId}/progress`)
      .set('Authorization', `Bearer ${token(['tasks.view_own'], 'e2', 'user-e2')}`)
      .send({ status: 'in_progress' });
    expect(wrongEmployee.status).toBe(404);

    const started = await request(app)
      .patch(`/api/task-assignments/${assignmentId}/progress`)
      .set('Authorization', `Bearer ${token(['tasks.view_own'], 'e1', 'user-e1')}`)
      .send({ status: 'in_progress' });
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('in_progress');

    const details = 'Completed with reviewed evidence';
    const submitted = await request(app)
      .patch(`/api/task-assignments/${assignmentId}/progress`)
      .set('Authorization', `Bearer ${token(['tasks.view_own'], 'e1', 'user-e1')}`)
      .send({ status: 'submitted', completionDetails: details });
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('submitted');
    expect(submitted.body.completionDetails).toBe(details);
    expect(prisma._store.auditLogs.at(-1).details).not.toContain(details);
  });

  it('requires submitted state, reviewer scope, a return note, and blocks self-review', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const created = await createTask(prisma);
    const assignmentId = created.body.assignments[0].id;
    prisma._store.taskAssignments[0].status = 'submitted';
    prisma._store.taskAssignments[0].completionDetails = 'done';
    const app = makeApp(prisma);

    const selfReview = await request(app)
      .post(`/api/task-assignments/${assignmentId}/review`)
      .set('Authorization', `Bearer ${token(['tasks.review', 'tasks.view_company'], 'e1', 'reviewer-user')}`)
      .send({ action: 'accept' });
    expect(selfReview.status).toBe(403);

    const missingNote = await request(app)
      .post(`/api/task-assignments/${assignmentId}/review`)
      .set('Authorization', `Bearer ${token(['tasks.review', 'tasks.view_company'], 'reviewer-employee', 'reviewer-user')}`)
      .send({ action: 'return' });
    expect(missingNote.status).toBe(400);

    const returned = await request(app)
      .post(`/api/task-assignments/${assignmentId}/review`)
      .set('Authorization', `Bearer ${token(['tasks.review', 'tasks.view_company'], 'reviewer-employee', 'reviewer-user')}`)
      .send({ action: 'return', reviewNote: 'Please add the final evidence' });
    expect(returned.status).toBe(200);
    expect(returned.body.assignment.status).toBe('returned');
    expect(returned.body.taskStatus).toBe('active');
  });

  it('completes the task only when every assignment is accepted and keeps accepted work immutable', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'), employee('e2'));
    const created = await createTask(prisma, ['e1', 'e2']);
    const [firstId, secondId] = created.body.assignments.map((row: any) => row.id);
    prisma._store.taskAssignments.forEach((row: any) => { row.status = 'submitted'; row.completionDetails = 'done'; });
    const reviewerToken = token(['tasks.review', 'tasks.view_company'], 'reviewer-employee', 'reviewer-user');
    const app = makeApp(prisma);

    const first = await request(app)
      .post(`/api/task-assignments/${firstId}/review`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ action: 'accept' });
    expect(first.status).toBe(200);
    expect(first.body.taskStatus).toBe('active');

    const second = await request(app)
      .post(`/api/task-assignments/${secondId}/review`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ action: 'accept' });
    expect(second.status).toBe(200);
    expect(second.body.taskStatus).toBe('completed');
    expect(prisma._store.tasks[0].status).toBe('completed');

    const immutable = await request(app)
      .patch(`/api/task-assignments/${firstId}/progress`)
      .set('Authorization', `Bearer ${token(['tasks.view_own'], 'e1', 'user-e1')}`)
      .send({ status: 'in_progress' });
    expect(immutable.status).toBe(409);
  });

  it('cancels without deleting assignments and exposes no cross-company detail', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const creatorToken = token(companyManagerPermissions, 'creator-employee', 'creator-1');
    const created = await createTask(prisma, ['e1'], creatorToken);
    const taskId = created.body.id;
    const app = makeApp(prisma);

    const cancelled = await request(app)
      .post(`/api/tasks/${taskId}/cancel`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(prisma._store.tasks).toHaveLength(1);
    expect(prisma._store.taskAssignments).toHaveLength(1);

    const hardDelete = await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${creatorToken}`);
    expect(hardDelete.status).toBe(405);
    expect(prisma._store.tasks).toHaveLength(1);

    const otherTenant = await request(app)
      .get(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${token(['tasks.view_company'], null, 'other-user', 'c2')}`);
    expect(otherTenant.status).toBe(404);
  });
});
