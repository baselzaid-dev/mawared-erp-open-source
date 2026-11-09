import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

/**
 * Commercial P4 — task attachments.
 *
 * The whole point of routing these through `loadVisibleTask` is that holding
 * `tasks.attachment.manage` grants the ABILITY to attach, never access to a
 * particular task. These tests attack exactly that seam: same permission,
 * different scope, must fail.
 */

const pdfBase64 = Buffer.from('%PDF-1.4 mawared-task-attachment').toString('base64');

const futureDate = (days = 7): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const employee = (id: string, departmentId = 'd1') => ({
  id,
  companyId: 'c1',
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
  'tasks.attachment.manage',
];
const managerToken = token(managerPermissions, 'creator-employee', 'creator-1');

const seedTask = async (prisma: any, employeeIds = ['e1']) => {
  const response = await request(makeApp(prisma))
    .post('/api/tasks')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({
      title: 'Prepare monthly summary',
      priority: 'high',
      dueDate: futureDate(),
      employeeIds,
    });
  expect(response.status).toBe(201);
  return response.body;
};

const upload = (prisma: any, taskId: string, auth: string) =>
  request(makeApp(prisma))
    .post('/api/attachments')
    .set('Authorization', `Bearer ${auth}`)
    .send({
      purpose: 'task',
      taskId,
      originalFilename: 'evidence.pdf',
      contentType: 'application/pdf',
      contentBase64: pdfBase64,
    });

describe('P4 task attachments', () => {
  it('uploads against a visible task and links it without exposing the bytes', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);

    const response = await upload(prisma, task.id, managerToken);

    expect(response.status).toBe(201);
    expect(response.body.purpose).toBe('task');
    expect(response.body.taskId).toBe(task.id);
    expect(response.body.storageBytes).toBeUndefined();
    expect(prisma._store.auditLogs.some((row: any) => row.action === 'attachment.upload')).toBe(true);
  });

  it('requires the task attachment permission, not merely task visibility', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);

    const response = await upload(
      prisma,
      task.id,
      token(['tasks.view_company'], 'viewer-employee', 'viewer-1'),
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('AttachmentForbidden');
  });

  it('refuses an upload against a task outside the caller scope even with the permission', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1', 'd1'), employee('e2', 'd2'));
    const task = await seedTask(prisma, ['e1']);

    // Holds tasks.attachment.manage, but only own-scope visibility on a
    // different task. The permission must not imply reach.
    const response = await upload(
      prisma,
      task.id,
      token(['tasks.view_own', 'tasks.attachment.manage'], 'e2', 'user-e2'),
    );

    expect(response.status).toBe(404);
    expect(prisma.__memoryAttachments?.rows ?? []).toHaveLength(0);
  });

  it('rejects an upload that names no task at all', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    await seedTask(prisma);

    const response = await request(makeApp(prisma))
      .post('/api/attachments')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        purpose: 'task',
        originalFilename: 'evidence.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('AttachmentLinkRequired');
  });

  it('is unreachable from another company', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);

    const response = await upload(
      prisma,
      task.id,
      token(managerPermissions, 'intruder-employee', 'intruder-1', 'c2'),
    );

    expect(response.status).toBe(404);
  });

  it('lets an assignee read the attachment without holding the upload permission', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);
    const uploaded = await upload(prisma, task.id, managerToken);

    const response = await request(makeApp(prisma))
      .get(`/api/attachments/${uploaded.body.id}`)
      .set('Authorization', `Bearer ${token(['tasks.view_own'], 'e1', 'user-e1')}`);

    expect(response.status).toBe(200);
    expect(response.body.taskId).toBe(task.id);
  });

  it('reports an attachment on an out-of-scope task as missing, not forbidden', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1', 'd1'), employee('e2', 'd2'));
    const task = await seedTask(prisma, ['e1']);
    const uploaded = await upload(prisma, task.id, managerToken);

    const response = await request(makeApp(prisma))
      .get(`/api/attachments/${uploaded.body.id}`)
      .set('Authorization', `Bearer ${token(['tasks.view_own'], 'e2', 'user-e2')}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('AttachmentNotFound');
    expect(JSON.stringify(response.body)).not.toContain('evidence.pdf');
  });

  it('never streams the content of an out-of-scope task attachment', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1', 'd1'), employee('e2', 'd2'));
    const task = await seedTask(prisma, ['e1']);
    const uploaded = await upload(prisma, task.id, managerToken);

    const response = await request(makeApp(prisma))
      .get(`/api/attachments/${uploaded.body.id}/content`)
      .set('Authorization', `Bearer ${token(['tasks.view_own'], 'e2', 'user-e2')}`);

    expect(response.status).toBe(404);
  });

  it('lists task attachments by taskId for someone who can see the task', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);
    await upload(prisma, task.id, managerToken);

    const response = await request(makeApp(prisma))
      .get(`/api/attachments?taskId=${task.id}`)
      .set('Authorization', `Bearer ${managerToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].taskId).toBe(task.id);
  });

  it('still rejects an unknown attachment purpose', async () => {
    const prisma = makeFakePrisma();
    prisma._store.employees.push(employee('e1'));
    const task = await seedTask(prisma);

    const response = await request(makeApp(prisma))
      .post('/api/attachments')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        purpose: 'payroll',
        taskId: task.id,
        originalFilename: 'evidence.pdf',
        contentType: 'application/pdf',
        contentBase64: pdfBase64,
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('AttachmentPurposeInvalid');
  });
});
