import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

/**
 * Commercial P4 — task edit, comments and timeline.
 *
 * The security bar these tests hold is the Wave 3 invariant: a collaboration
 * surface is never broader than the task it hangs off. Every read path is
 * therefore tested for the *department-scoped stranger* case, not just the
 * happy path, and out-of-scope always means 404 (never 403), so task existence
 * is not signalled across departments or companies.
 */

const futureDate = (days = 7): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const employee = (
  id: string,
  departmentId = 'd1',
  options: { companyId?: string } = {},
) => ({
  id,
  companyId: options.companyId ?? 'c1',
  employeeNum: `EMP-${id}`,
  status: 'active',
  departmentId,
  user: {
    id: `user-${id}`,
    name: `Employee ${id}`,
    role: { permissions: JSON.stringify(['tasks.view_own']) },
  },
  department: { id: departmentId, name: `Department ${departmentId}`, managerId: 'manager-1' },
});

const token = (
  permissions: string[],
  employeeId: string | null = 'e1',
  id = 'u1',
  companyId = 'c1',
) => tokenFor({ id, companyId, employeeId, permissions });

const managerPermissions = [
  'tasks.view_company',
  'tasks.create',
  'tasks.assign_company',
  'tasks.review',
  'tasks.edit',
  'tasks.comment.create',
];

const managerToken = token(managerPermissions, 'creator-employee', 'creator-1');

const seedTask = async (prisma: any, employeeIds = ['e1']) => {
  const response = await request(makeApp(prisma))
    .post('/api/tasks')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({
      title: 'Prepare monthly summary',
      description: 'Complete the reviewed figures',
      priority: 'high',
      dueDate: futureDate(),
      employeeIds,
    });
  expect(response.status).toBe(201);
  return response.body;
};

describe('P4 task edit', () => {
  it('updates allowed fields, audits the field names, and never records the new values', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);

    const response = await request(makeApp(prisma))
      .patch(`/api/tasks/${task.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        expectedUpdatedAt: task.updatedAt,
        title: 'Prepare quarterly summary',
        priority: 'urgent',
      });

    expect(response.status).toBe(200);
    expect(response.body.title).toBe('Prepare quarterly summary');
    expect(response.body.priority).toBe('urgent');

    const audit = prisma._store.auditLogs.find((row: any) => row.action === 'task.edit');
    expect(audit).toBeTruthy();
    const details = JSON.parse(audit.details);
    expect(details.changedFields.sort()).toEqual(['priority', 'title']);
    // The audit sanitizer must not carry the new title into the log.
    expect(audit.details).not.toContain('quarterly');
  });

  it('rejects a stale optimistic-concurrency token so a slow editor cannot clobber a fast one', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);
    const staleToken = task.updatedAt;

    const first = await request(makeApp(prisma))
      .patch(`/api/tasks/${task.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ expectedUpdatedAt: staleToken, title: 'First writer wins' });
    expect(first.status).toBe(200);

    const second = await request(makeApp(prisma))
      .patch(`/api/tasks/${task.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ expectedUpdatedAt: staleToken, title: 'Second writer loses' });

    expect(second.status).toBe(409);
    expect(second.body.error).toBe('TASK_EDIT_CONFLICT');
    // The losing write left no trace at all.
    expect(prisma._store.tasks[0].title).toBe('First writer wins');
    expect(
      prisma._store.auditLogs.filter((row: any) => row.action === 'task.edit'),
    ).toHaveLength(1);
  });

  it('refuses to change status or assignments through the edit route', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);

    const response = await request(makeApp(prisma))
      .patch(`/api/tasks/${task.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ expectedUpdatedAt: task.updatedAt, status: 'completed', employeeIds: ['e2'] });

    expect(response.status).toBe(400);
    expect(prisma._store.tasks[0].status).toBe('active');
  });

  it('needs tasks.edit, not merely the ability to see or create the task', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);

    const response = await request(makeApp(prisma))
      .patch(`/api/tasks/${task.id}`)
      .set(
        'Authorization',
        `Bearer ${token(['tasks.view_company', 'tasks.create'], 'other-employee', 'other-1')}`,
      )
      .send({ expectedUpdatedAt: task.updatedAt, title: 'Not allowed' });

    expect(response.status).toBe(403);
  });

  it('grants no reach to someone holding tasks.edit with no view scope at all', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);

    // Passes the permission gate, but has no company/department/own scope over
    // this task, so the resource must stay invisible rather than editable.
    const response = await request(makeApp(prisma))
      .patch(`/api/tasks/${task.id}`)
      .set('Authorization', `Bearer ${token(['tasks.edit'], 'stranger-employee', 'stranger-1')}`)
      .send({ expectedUpdatedAt: task.updatedAt, title: 'Escalated' });

    expect(response.status).toBe(404);
    expect(prisma._store.tasks[0].title).toBe('Prepare monthly summary');
  });

  it('grants a department manager no edit reach over another department\'s task', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1', 'd1'), employee('e2', 'd2'));
    const task = await seedTask(prisma, ['e1']);
    // The actor manages d2 only; the task's assignees are all in d1.
    prisma.department.findMany.mockResolvedValue([{ id: 'd2' }]);

    const response = await request(makeApp(prisma))
      .patch(`/api/tasks/${task.id}`)
      .set(
        'Authorization',
        `Bearer ${token(
          ['tasks.view_department', 'tasks.review', 'tasks.edit'],
          'manager-d2-employee',
          'manager-d2',
        )}`,
      )
      .send({ expectedUpdatedAt: task.updatedAt, title: 'Cross-department edit' });

    expect(response.status).toBe(404);
    expect(prisma._store.tasks[0].title).toBe('Prepare monthly summary');
  });

  it('is closed once the task reaches a terminal state', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);
    await request(makeApp(prisma))
      .post(`/api/tasks/${task.id}/cancel`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({});

    const response = await request(makeApp(prisma))
      .patch(`/api/tasks/${task.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ expectedUpdatedAt: prisma._store.tasks[0].updatedAt, title: 'Too late' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('TASK_EDIT_INVALID');
  });

  it('reports a cross-company task as missing rather than forbidden', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);

    const response = await request(makeApp(prisma))
      .patch(`/api/tasks/${task.id}`)
      .set(
        'Authorization',
        `Bearer ${token(managerPermissions, 'intruder-employee', 'intruder-1', 'c2')}`,
      )
      .send({ expectedUpdatedAt: task.updatedAt, title: 'Cross tenant' });

    expect(response.status).toBe(404);
    expect(prisma._store.tasks[0].title).toBe('Prepare monthly summary');
  });

  it('notifies assignees about a due-date move but stays silent on a wording fix', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);
    const before = prisma._store.notifications.length;

    await request(makeApp(prisma))
      .patch(`/api/tasks/${task.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ expectedUpdatedAt: task.updatedAt, description: 'Slightly reworded' });
    expect(prisma._store.notifications.length).toBe(before);

    await request(makeApp(prisma))
      .patch(`/api/tasks/${task.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ expectedUpdatedAt: prisma._store.tasks[0].updatedAt, dueDate: futureDate(21) });
    expect(prisma._store.notifications.length).toBe(before + 1);
  });
});

describe('P4 task comments', () => {
  it('creates a comment, records only its length in audit, and notifies the other participants', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);
    const before = prisma._store.notifications.length;

    const response = await request(makeApp(prisma))
      .post(`/api/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ body: 'Please attach the signed copy before Thursday.' });

    expect(response.status).toBe(201);
    expect(response.body.body).toBe('Please attach the signed copy before Thursday.');

    const audit = prisma._store.auditLogs.find((row: any) => row.action === 'task.comment.create');
    const details = JSON.parse(audit.details);
    expect(details.bodyLength).toBe('Please attach the signed copy before Thursday.'.length);
    // The comment text must never reach the audit log.
    expect(audit.details).not.toContain('signed copy');

    // The assignee is told; the author is not notified about their own comment.
    expect(prisma._store.notifications.length).toBe(before + 1);
    expect(prisma._store.notifications.at(-1).userId).toBe('user-e1');
  });

  it('carries the task category and an allowlisted deep link on every task notification', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);

    const created = prisma._store.notifications.at(-1);
    expect(created.category).toBe('task');
    expect(created.routeKey).toBe('task.detail');
    expect(created.resourceType).toBe('task');
    expect(created.resourceId).toBe(task.id);
    // No task title or description leaks into the notification payload.
    expect(created.message).not.toContain('monthly summary');
  });

  it('respects a recipient who disabled the task category', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    prisma._store.notificationPreferences.push({
      id: 'pref-1',
      companyId: 'c1',
      userId: 'user-e1',
      category: 'task',
      inAppEnabled: false,
    });

    await seedTask(prisma);

    expect(
      prisma._store.notifications.filter((row: any) => row.userId === 'user-e1'),
    ).toHaveLength(0);
  });

  it('requires tasks.comment.create to write but only the task view scope to read', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);
    await request(makeApp(prisma))
      .post(`/api/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ body: 'Manager note' });

    const assigneeToken = token(['tasks.view_own'], 'e1', 'user-e1');

    const write = await request(makeApp(prisma))
      .post(`/api/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${assigneeToken}`)
      .send({ body: 'Assignee reply' });
    expect(write.status).toBe(403);

    const read = await request(makeApp(prisma))
      .get(`/api/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${assigneeToken}`);
    expect(read.status).toBe(200);
    expect(read.body.items).toHaveLength(1);
  });

  it('hides the whole thread from someone outside the task scope', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1', 'd1'), employee('e2', 'd2'));
    const task = await seedTask(prisma, ['e1']);
    await request(makeApp(prisma))
      .post(`/api/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ body: 'Confidential coordination note' });

    // An employee assigned to a different task cannot read this one's comments.
    const stranger = await request(makeApp(prisma))
      .get(`/api/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${token(['tasks.view_own'], 'e2', 'user-e2')}`);

    expect(stranger.status).toBe(404);
    expect(JSON.stringify(stranger.body)).not.toContain('Confidential');
  });

  it('paginates newest-first with a keyset cursor that does not repeat or skip rows', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);
    for (let index = 0; index < 5; index += 1) {
      await request(makeApp(prisma))
        .post(`/api/tasks/${task.id}/comments`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ body: `Comment ${index}` });
    }

    const firstPage = await request(makeApp(prisma))
      .get(`/api/tasks/${task.id}/comments?limit=2`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.hasMore).toBe(true);
    expect(firstPage.body.items[0].body).toBe('Comment 4');

    const secondPage = await request(makeApp(prisma))
      .get(`/api/tasks/${task.id}/comments?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(secondPage.body.items.map((row: any) => row.body)).toEqual(['Comment 2', 'Comment 1']);

    const seen = [...firstPage.body.items, ...secondPage.body.items].map((row: any) => row.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a malformed cursor instead of silently returning page one', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);

    const response = await request(makeApp(prisma))
      .get(`/api/tasks/${task.id}/comments?cursor=not-a-valid-cursor`)
      .set('Authorization', `Bearer ${managerToken}`);

    expect(response.status).toBe(400);
  });

  it('closes the thread once the task is no longer active', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);
    await request(makeApp(prisma))
      .post(`/api/tasks/${task.id}/cancel`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({});

    const response = await request(makeApp(prisma))
      .post(`/api/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ body: 'Late note' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('TASK_COMMENT_INVALID');
  });

  it('rolls the comment back when the audit write fails', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);
    prisma.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await request(makeApp(prisma))
      .post(`/api/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ body: 'Should not survive' });

    expect(response.status).toBe(500);
    expect(prisma._store.taskComments).toHaveLength(0);
  });
});

describe('P4 task timeline', () => {
  it('renders the task history for someone who can see the task', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);
    await request(makeApp(prisma))
      .patch(`/api/tasks/${task.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ expectedUpdatedAt: task.updatedAt, priority: 'urgent' });

    const response = await request(makeApp(prisma))
      .get(`/api/v2/tasks/${task.id}/timeline`)
      .set('Authorization', `Bearer ${managerToken}`);

    expect(response.status).toBe(200);
    expect(response.body.entityType).toBe('task');
    const types = response.body.events.map((event: any) => event.type);
    expect(types).toContain('task.created');
    expect(types).toContain('task.edited');
    // Chronological order is part of the contract.
    const stamps = response.body.events.map((event: any) => event.at);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it('returns an opaque 404 for a task outside the caller scope', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1', 'd1'), employee('e2', 'd2'));
    const task = await seedTask(prisma, ['e1']);

    const response = await request(makeApp(prisma))
      .get(`/api/v2/tasks/${task.id}/timeline`)
      .set('Authorization', `Bearer ${token(['tasks.view_own'], 'e2', 'user-e2')}`);

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('monthly summary');
  });

  it('is unavailable across companies', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);

    const response = await request(makeApp(prisma))
      .get(`/api/v2/tasks/${task.id}/timeline`)
      .set(
        'Authorization',
        `Bearer ${token(['tasks.view_company'], 'intruder-employee', 'intruder-1', 'c2')}`,
      );

    expect(response.status).toBe(404);
  });
});
