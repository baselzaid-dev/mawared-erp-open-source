import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionMemory } from '@/auth/sessionMemory';
import { chatApi, notificationsApi, tasksApi, trainingApi } from './api';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const jsonEachCall = (body: unknown, status = 200) => vi.fn(async () => json(body, status));

const authenticate = () =>
  sessionMemory.set({ accessToken: 'access-token', refreshToken: 'refresh-token' }); // security-scan-allow: memory-only test fixture

describe('company web P4 collaboration API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionMemory.clear();
  });

  it('never sends a client-supplied companyId on any P4 read', async () => {
    authenticate();
    const fetchMock = jsonEachCall({ items: [], total: 0 });
    vi.stubGlobal('fetch', fetchMock);

    await tasksApi.list({ scope: 'department' });
    await trainingApi.listAssignments({ pageSize: 25 });
    await chatApi.listConversations({ limit: 20 });
    await notificationsApi.list({ category: 'task' });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain('/api/tasks?scope=department');
    expect(urls[1]).toContain('/api/training/assignments?pageSize=25');
    expect(urls[2]).toContain('/api/chat/conversations?limit=20');
    expect(urls[3]).toContain('/api/v2/notifications?category=task');
    // Tenant scope is always derived server side from the session.
    for (const url of urls) expect(url).not.toContain('companyId');
  });

  it('sends the optimistic-concurrency token when editing a task', async () => {
    authenticate();
    const fetchMock = jsonEachCall({ id: 'task-1' });
    vi.stubGlobal('fetch', fetchMock);

    await tasksApi.update('task-1', {
      expectedUpdatedAt: '2026-08-09T10:00:00.000Z',
      title: 'Renamed',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/tasks/task-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({
      expectedUpdatedAt: '2026-08-09T10:00:00.000Z',
      title: 'Renamed',
    });
    // status is never sent through the edit route: it has its own audited transitions.
    expect(init.body).not.toContain('"status"');
  });

  it('surfaces the 409 a concurrent task edit produces instead of retrying', async () => {
    authenticate();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'TASK_EDIT_CONFLICT' }, 409)),
    );

    await expect(
      tasksApi.update('task-1', { expectedUpdatedAt: '2026-08-09T10:00:00.000Z', title: 'x' }),
    ).rejects.toMatchObject({ status: 409, code: 'TASK_EDIT_CONFLICT' });
  });

  it('walks task comments with an opaque keyset cursor', async () => {
    authenticate();
    const fetchMock = jsonEachCall({ items: [], nextCursor: null, hasMore: false });
    vi.stubGlobal('fetch', fetchMock);

    await tasksApi.listComments('task-1', { cursor: 'Y3Vyc29y', limit: 30 });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/tasks/task-1/comments?');
    expect(url).toContain('cursor=Y3Vyc29y');
    expect(url).toContain('limit=30');
  });

  it('requests older chat messages with the before cursor, not an offset', async () => {
    authenticate();
    const fetchMock = jsonEachCall({ items: [], nextCursor: null, order: 'chronological' });
    vi.stubGlobal('fetch', fetchMock);

    await chatApi.listMessages('conv-1', { before: 'Y3Vyc29y', limit: 40 });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/chat/conversations/conv-1/messages?');
    expect(url).toContain('before=Y3Vyc29y');
    expect(url).not.toContain('offset');
  });

  it('reads the v2 unread count, which excludes hidden rows', async () => {
    authenticate();
    const fetchMock = jsonEachCall({ unreadCount: 3 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await notificationsApi.unreadCount();

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v2/notifications/unread-count');
    expect(result.unreadCount).toBe(3);
  });

  it('issues a training certificate through a POST that is safe to retry', async () => {
    authenticate();
    const fetchMock = jsonEachCall({ id: 'cert-1', serialNumber: 'CERT-202608-ABC' }, 201);
    vi.stubGlobal('fetch', fetchMock);

    await trainingApi.issueCertificate('assignment-1');
    await trainingApi.issueCertificate('assignment-1');

    // Same URL both times: the server replays rather than minting a second row.
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/api/training/assignments/assignment-1/certificate',
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(String(fetchMock.mock.calls[0][0]));
  });

  it('reports the evaluation conflict when one already exists', async () => {
    authenticate();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'TRAINING_EVALUATION_EXISTS' }, 409)),
    );

    await expect(
      trainingApi.createEvaluation('assignment-1', {
        effectivenessScore: 4,
        knowledgeScore: 4,
        applicationScore: 4,
        recommendation: 'recommended',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'TRAINING_EVALUATION_EXISTS' });
  });

  it('encodes path identifiers so a crafted id cannot escape its route', async () => {
    authenticate();
    const fetchMock = jsonEachCall({});
    vi.stubGlobal('fetch', fetchMock);

    await tasksApi.get('../../admin');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/tasks/..%2F..%2Fadmin');
  });
});
