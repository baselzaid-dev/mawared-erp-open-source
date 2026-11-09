import express from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSearchRoutes, searchSecurityMetrics } from '../src/search';
import { PERMISSIONS } from '../src/permissions';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

const contains = (value: unknown, needle: string): boolean =>
  typeof value === 'string' && value.toLowerCase().includes(needle.toLowerCase());

const matchClause = (row: any, clause: any): boolean =>
  Object.entries(clause).every(([key, condition]: [string, any]) => {
    if (key === 'user') {
      return matchClause(row.user ?? {}, condition.is ?? condition);
    }
    if (condition && typeof condition === 'object' && 'contains' in condition) {
      return contains(row[key], condition.contains);
    }
    return row[key] === condition;
  });

const matchWhere = (row: any, where: any): boolean => {
  for (const [key, condition] of Object.entries<any>(where)) {
    if (key === 'OR') {
      if (!condition.some((clause: any) => matchWhere(row, clause))) return false;
      continue;
    }
    if (key === 'participants') {
      const wanted = condition.some;
      const participants = row.participants ?? [];
      if (!participants.some((p: any) =>
        p.userId === wanted.userId && p.active === wanted.active)) return false;
      continue;
    }
    if (key === 'assignments') {
      const wanted = condition.some;
      const assignments = row.assignments ?? [];
      const matches = assignments.some((assignment: any) => {
        if (wanted.employeeId !== undefined) return assignment.employeeId === wanted.employeeId;
        if (wanted.departmentIdSnapshot?.in) {
          return wanted.departmentIdSnapshot.in.includes(assignment.departmentIdSnapshot);
        }
        if (wanted.employee?.is?.departmentId?.in) {
          return wanted.employee.is.departmentId.in.includes(assignment.employee?.departmentId);
        }
        return false;
      });
      if (!matches) return false;
      continue;
    }
    if (condition === null) {
      if (row[key] != null) return false;
      continue;
    }
    if (condition && typeof condition === 'object') {
      if ('not' in condition) {
        if (row[key] === condition.not) return false;
        continue;
      }
      if ('in' in condition) {
        if (!condition.in.includes(row[key])) return false;
        continue;
      }
      if ('contains' in condition) {
        if (!contains(row[key], condition.contains)) return false;
        continue;
      }
      if ('is' in condition) {
        if (!matchClause(row[key] ?? {}, condition.is)) return false;
        continue;
      }
    }
    if (row[key] !== condition) return false;
  }
  return true;
};

const listFake = (rows: any[]) =>
  vi.fn(async ({ where, take }: any = {}) => {
    const matched = rows.filter((row) => matchWhere(row, where ?? {}));
    return take === undefined ? matched : matched.slice(0, take);
  });

function makeSearchPrisma() {
  const prisma = makeFakePrisma();

  const employees = [
    {
      id: 'emp-1', companyId: 'c1', employeeNum: 'EMP-001', jobTitle: 'Accountant',
      departmentId: 'd1', department: { name: 'Finance' }, status: 'active', archivedAt: null,
      user: { id: 'u-acc', name: 'Amal Accountant', role: { permissions: '[]' } },
    },
    {
      id: 'emp-2', companyId: 'c1', employeeNum: 'EMP-002', jobTitle: 'Engineer',
      departmentId: 'd2', department: { name: 'Engineering' }, status: 'active', archivedAt: null,
      user: { id: 'u-eng', name: 'Amal Engineer', role: { permissions: '[]' } },
    },
    {
      id: 'emp-owner', companyId: 'c1', employeeNum: 'EMP-OWN', jobTitle: 'General Manager',
      departmentId: 'd1', department: { name: 'Finance' }, status: 'active', archivedAt: null,
      user: { id: 'u-owner', name: 'Amal Owner', role: { permissions: `["${PERMISSIONS.ADMIN_FULL}"]` } },
    },
    {
      id: 'emp-archived', companyId: 'c1', employeeNum: 'EMP-003', jobTitle: 'Analyst',
      departmentId: 'd1', department: { name: 'Finance' }, archivedAt: new Date('2026-01-01'),
      user: { id: 'u-old', name: 'Amal Archived', role: { permissions: '[]' } },
    },
    {
      id: 'emp-other-co', companyId: 'c2', employeeNum: 'EMP-900', jobTitle: 'Spy',
      departmentId: 'x1', department: { name: 'Other' }, archivedAt: null,
      user: { id: 'u-spy', name: 'Amal Foreign', role: { permissions: '[]' } },
    },
  ];

  const vendors = [
    { id: 'v-1', companyId: 'c1', name: 'Gulf Supplies', category: 'stationery', status: 'active' },
    { id: 'v-2', companyId: 'c1', name: 'Gulf Metals', category: 'metals', status: 'inactive' },
    { id: 'v-3', companyId: 'c1', name: 'Gulf Archived', category: 'legacy', status: 'archived' },
    { id: 'v-4', companyId: 'c2', name: 'Gulf Foreign', category: 'other', status: 'active' },
  ];

  const purchaseRequests = [
    {
      id: 'pr-1', companyId: 'c1', title: 'Printer paper', requestNumber: 'PR-100',
      status: 'pending_department', departmentId: 'd1', requestedByEmployeeId: 'emp-1',
      requester: { user: { id: 'u-acc', role: { permissions: '[]' } } },
    },
    {
      id: 'pr-2', companyId: 'c1', title: 'Printer toner', requestNumber: 'PR-101',
      status: 'approved', departmentId: 'd1', requestedByEmployeeId: 'emp-owner',
      requester: {
        user: { id: 'u-owner', role: { permissions: `["${PERMISSIONS.ADMIN_FULL}"]` } },
      },
    },
  ];

  const trainingCourses = [
    {
      id: 'tc-1', companyId: 'c1', title: 'Safety Basics', courseCode: 'TR-01', status: 'published',
      assignments: [
        {
          employeeId: 'emp-1',
          departmentIdSnapshot: 'd1',
          employee: { user: { id: 'u-acc', role: { permissions: '[]' } } },
        },
      ],
    },
    {
      id: 'tc-owner', companyId: 'c1', title: 'Safety Owner', courseCode: 'TR-03',
      status: 'published',
      assignments: [{
        employeeId: 'emp-owner',
        departmentIdSnapshot: 'd1',
        employee: {
          user: { id: 'u-owner', role: { permissions: `["${PERMISSIONS.ADMIN_FULL}"]` } },
        },
      }],
    },
    {
      id: 'tc-2', companyId: 'c1', title: 'Safety Advanced', courseCode: 'TR-02', status: 'archived',
      assignments: [],
    },
  ];

  const tasks = [
    {
      id: 't-1', companyId: 'c1', title: 'Quarterly filing', status: 'active', priority: 'high',
      assignments: [{
        employeeId: 'emp-1',
        employee: {
          departmentId: 'd1',
          user: { id: 'u-acc', role: { permissions: '[]' } },
        },
      }],
    },
    {
      id: 't-2', companyId: 'c1', title: 'Quarterly audit', status: 'active', priority: 'normal',
      assignments: [{
        employeeId: 'emp-2',
        employee: {
          departmentId: 'd2',
          user: { id: 'u-eng', role: { permissions: '[]' } },
        },
      }],
    },
    {
      id: 't-owner', companyId: 'c1', title: 'Quarterly owner review',
      status: 'active', priority: 'high',
      assignments: [{
        employeeId: 'emp-owner',
        employee: {
          departmentId: 'd1',
          user: { id: 'u-owner', role: { permissions: `["${PERMISSIONS.ADMIN_FULL}"]` } },
        },
      }],
    },
  ];

  const conversations = [
    {
      id: 'chat-1', companyId: 'c1', title: 'قناة الإعلانات العامة', type: 'announcement',
      participants: [{ userId: 'u-member', active: true }],
    },
    {
      id: 'chat-2', companyId: 'c1', title: 'قناة قسم المالية', type: 'department',
      departmentId: 'd1',
      participants: [{ userId: 'u-other', active: true, user: { name: 'Other User' } }],
    },
    {
      id: 'chat-direct', companyId: 'c1', title: null, type: 'direct',
      participants: [
        { userId: 'u-member', active: true, user: { name: 'Member User' } },
        { userId: 'u-peer', active: true, user: { name: 'Noura Peer' } },
      ],
    },
  ];

  prisma.employee.findMany = listFake(employees);
  prisma.employee.findFirst = vi.fn(async ({ where }: any) => {
    const row = employees.find((employee) =>
      employee.id === where.id &&
      employee.companyId === where.companyId &&
      employee.status === where.status &&
      employee.archivedAt === where.archivedAt);
    return row ? { departmentId: row.departmentId } : null;
  });
  prisma.vendor.findMany = listFake(vendors);
  (prisma as any).purchaseRequest = { findMany: listFake(purchaseRequests) };
  (prisma as any).trainingCourse = { findMany: listFake(trainingCourses) };
  prisma.task.findMany = listFake(tasks);
  (prisma as any).chatConversation = { findMany: listFake(conversations) };

  // Managed departments for the department-scope tests: u-manager manages d1.
  prisma.department.findMany = vi.fn(async ({ where }: any = {}) =>
    where?.managerId === 'u-manager' && where?.companyId === 'c1' ? [{ id: 'd1' }] : []);
  prisma.companyOwnership.findFirst = vi.fn(async ({ where }: any = {}) =>
    where?.companyId === 'c1' ? { userId: 'u-owner' } : null);

  return prisma;
}

function makeSearchApp(prisma: any, searchLimiter?: any) {
  const app = express();
  app.use(express.json());
  const requireAuth = (
    req: express.Request & { user?: Record<string, unknown> },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? header.match(/^Bearer\s+(\S+)$/i) : null;
    if (!match) return res.status(401).json({ error: 'Unauthorized' });
    try {
      req.user = jwt.verify(match[1], TEST_SECRET) as Record<string, unknown>;
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
  registerSearchRoutes({ app, prisma, requireAuth, searchLimiter });
  return app;
}

describe('GET /api/v2/search (Sprint 12L global search)', () => {
  beforeEach(() => {
    searchSecurityMetrics.reset();
  });

  it('requires authentication', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app).get('/api/v2/search').query({ q: 'Amal' });
    expect(res.status).toBe(401);
  });

  it('rejects queries below the minimum length without touching any source', async () => {
    const prisma = makeSearchPrisma();
    const app = makeSearchApp(prisma);
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'a' })
      .set('Authorization', `Bearer ${tokenFor({ permissions: [PERMISSIONS.EMPLOYEES_VIEW] })}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('QueryTooShort');
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
    expect(searchSecurityMetrics.rejectedShortQuery).toBe(1);
  });

  it('rejects overlong queries and invalid types', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const token = tokenFor({ permissions: [PERMISSIONS.EMPLOYEES_VIEW] });
    const long = await request(app)
      .get('/api/v2/search')
      .query({ q: 'x'.repeat(101) })
      .set('Authorization', `Bearer ${token}`);
    expect(long.status).toBe(400);

    const badType = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Amal', types: 'employee,secrets' })
      .set('Authorization', `Bearer ${token}`);
    expect(badType.status).toBe(400);
    expect(badType.body.error).toBe('InvalidSearchType');
  });

  it('rejects out-of-bounds limit and cursor values', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const token = tokenFor({ permissions: [PERMISSIONS.EMPLOYEES_VIEW] });
    const badLimit = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Amal', limit: 100 })
      .set('Authorization', `Bearer ${token}`);
    expect(badLimit.status).toBe(400);

    const badCursor = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Amal', cursor: 5000 })
      .set('Authorization', `Bearer ${token}`);
    expect(badCursor.status).toBe(400);
  });

  it('returns an empty page (not 403) when the caller holds no source permission', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Amal' })
      .set('Authorization', `Bearer ${tokenFor({ id: 'u-nobody', permissions: [] })}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('scopes employees to the caller company and hides archived plus the owner record', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Amal', types: 'employee' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-viewer', companyId: 'c1', permissions: [PERMISSIONS.EMPLOYEES_VIEW],
      })}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((item: any) => item.id);
    expect(ids).toContain('emp-1');
    expect(ids).toContain('emp-2');
    expect(ids).not.toContain('emp-owner');
    expect(ids).not.toContain('emp-archived');
    expect(ids).not.toContain('emp-other-co');
    expect(JSON.stringify(res.body)).not.toContain('salary');
  });

  it('reveals the owner employee record only to owner-data viewers', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Amal Owner', types: 'employee' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-hr', companyId: 'c1',
        permissions: [PERMISSIONS.EMPLOYEES_VIEW, PERMISSIONS.HR_VIEW],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: any) => item.id)).toContain('emp-owner');
  });

  it('limits department-scoped employee search to managed departments', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Amal', types: 'employee' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-manager', companyId: 'c1',
        permissions: [PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT],
      })}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((item: any) => item.id);
    expect(ids).toContain('emp-1');
    expect(ids).not.toContain('emp-2');
  });

  it('never returns private chat conversations to a non-member admin', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Noura', types: 'chat_conversation' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-admin', companyId: 'c1', employeeId: 'emp-2',
        permissions: [PERMISSIONS.ADMIN_FULL],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('requires chat.view even for an active conversation member', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Noura', types: 'chat_conversation' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-member', companyId: 'c1', employeeId: 'emp-1', permissions: [],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('returns direct conversations by peer name to an active authorized member', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Noura', types: 'chat_conversation' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-member', companyId: 'c1', employeeId: 'emp-1',
        permissions: [PERMISSIONS.CHAT_VIEW],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.id).toBe('chat-direct');
    expect(item.title).toBe('Noura Peer');
    expect(item.routeKey).toBe('chat.conversation');
    expect(item.resourceType).toBe('conversation');
    expect(item).not.toHaveProperty('body');
    expect(item).not.toHaveProperty('messages');
  });

  it('uses derived Department access for Chat search without requiring a participant row', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'المالية', types: 'chat_conversation' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-member', companyId: 'c1', employeeId: 'emp-1',
        permissions: [PERMISSIONS.CHAT_VIEW],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: any) => item.id)).toEqual(['chat-2']);
  });

  it('excludes archived vendors and other-company vendors', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Gulf', types: 'vendor' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-buyer', companyId: 'c1', permissions: [PERMISSIONS.VENDORS_VIEW],
      })}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((item: any) => item.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('v-1');
    expect(ids).toContain('v-2');
    expect(ids).not.toContain('v-3');
    expect(ids).not.toContain('v-4');
  });

  it('scopes purchase requests for own-permission callers to their own requests', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Printer', types: 'purchase_request' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-emp1', companyId: 'c1', employeeId: 'emp-1',
        permissions: [PERMISSIONS.PURCHASING_VIEW_OWN],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: any) => item.id)).toEqual(['pr-1']);
  });

  it('hides protected-owner purchase requests from non-owner company viewers', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Printer', types: 'purchase_request' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-buyer', companyId: 'c1', permissions: [PERMISSIONS.PURCHASING_VIEW],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: any) => item.id)).toEqual(['pr-1']);
  });

  it('excludes archived training courses and applies own-assignment scope', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Safety', types: 'training_course' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-emp1', companyId: 'c1', employeeId: 'emp-1',
        permissions: [PERMISSIONS.TRAINING_VIEW_OWN],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: any) => item.id)).toEqual(['tc-1']);
  });

  it('hides owner-only Department Training courses from non-owner managers', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Safety', types: 'training_course' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-manager', companyId: 'c1',
        permissions: [PERMISSIONS.TRAINING_VIEW_DEPARTMENT],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: any) => item.id)).toEqual(['tc-1']);
  });

  it('scopes tasks to the caller own assignments with tasks.view_own', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Quarterly', types: 'task' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-emp1', companyId: 'c1', employeeId: 'emp-1',
        permissions: [PERMISSIONS.TASKS_VIEW_OWN],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: any) => item.id)).toEqual(['t-1']);
  });

  it('hides owner-only Tasks from non-owner company viewers', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Quarterly', types: 'task' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-tasks', companyId: 'c1',
        permissions: [PERMISSIONS.TASKS_VIEW_COMPANY],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: any) => item.id)).toEqual(['t-2', 't-1']);
  });

  it('deduplicates repeated requested types before querying and merging', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Amal', types: 'employee,employee' })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-viewer', companyId: 'c1', permissions: [PERMISSIONS.EMPLOYEES_VIEW],
      })}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((item: any) => item.id);
    expect(ids).toEqual(['emp-1', 'emp-2']);
  });

  it('keeps a later source reachable inside the bounded cursor window', async () => {
    const prisma = makeSearchPrisma();
    prisma.employee.findMany = vi.fn(async ({ take }: any) =>
      Array.from({ length: 201 }, (_, index) => ({
        id: `emp-match-${String(index).padStart(3, '0')}`,
        companyId: 'c1',
        employeeNum: `MATCH-${String(index).padStart(3, '0')}`,
        jobTitle: 'Match',
        departmentId: 'd1',
        department: { name: 'Finance' },
        status: 'active',
        archivedAt: null,
        user: {
          id: `u-match-${index}`,
          name: `Match Employee ${String(index).padStart(3, '0')}`,
          role: { permissions: '[]' },
        },
      })).slice(0, take));
    prisma.vendor.findMany = vi.fn(async () => [
      { id: 'vendor-match', companyId: 'c1', name: 'Match Vendor', category: null, status: 'active' },
    ]);
    const app = makeSearchApp(prisma);
    const res = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Match', types: 'employee,vendor', cursor: 100, limit: 1 })
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-viewer', companyId: 'c1',
        permissions: [PERMISSIONS.EMPLOYEES_VIEW, PERMISSIONS.VENDORS_VIEW],
      })}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: any) => item.id)).toEqual(['vendor-match']);
  });

  it('pages results deterministically with a stable nextCursor', async () => {
    const app = makeSearchApp(makeSearchPrisma());
    const token = tokenFor({
      id: 'u-buyer', companyId: 'c1', permissions: [PERMISSIONS.VENDORS_VIEW],
    });
    const first = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Gulf', types: 'vendor', limit: 1 })
      .set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toBe(1);

    const second = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Gulf', types: 'vendor', limit: 1, cursor: first.body.nextCursor })
      .set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    expect(second.body.nextCursor).toBeNull();
  });

  it('applies the search rate limiter when provided', async () => {
    const limiter = rateLimit({
      windowMs: 60_000,
      limit: 2,
      standardHeaders: false,
      legacyHeaders: false,
      keyGenerator: () => 'test-key',
      validate: false,
      message: { error: 'TooManySearchRequests', code: 429 },
    });
    const app = makeSearchApp(makeSearchPrisma(), limiter);
    const token = tokenFor({ permissions: [PERMISSIONS.VENDORS_VIEW] });
    for (let i = 0; i < 2; i += 1) {
      const ok = await request(app)
        .get('/api/v2/search')
        .query({ q: 'Gulf', types: 'vendor' })
        .set('Authorization', `Bearer ${token}`);
      expect(ok.status).toBe(200);
    }
    const limited = await request(app)
      .get('/api/v2/search')
      .query({ q: 'Gulf', types: 'vendor' })
      .set('Authorization', `Bearer ${token}`);
    expect(limited.status).toBe(429);
  });
});
