import { authenticatedRequest } from '@/api/client';
import type {
  ChatConversationPage,
  ChatMessagePage,
  ChatMessageRecord,
  NotificationPage,
  NotificationRecord,
  TaskCommentPage,
  TaskCommentRecord,
  TaskEligibleEmployee,
  TaskPriority,
  TaskRecord,
  TaskScope,
  TimelineResponse,
  TrainingAssignmentPage,
  TrainingCertificateRecord,
  TrainingEvaluationInput,
  TrainingEvaluationRecord,
} from './types';

const query = (
  filters: Record<string, string | number | boolean | undefined | null>,
): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
};

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
});

export const tasksApi = {
  /**
   * `scope` is a request for a view, not a claim of entitlement: asking for a
   * scope the account does not hold returns 403 from the backend.
   */
  list(filters: {
    scope?: TaskScope;
    status?: string;
    priority?: TaskPriority;
    employeeId?: string;
    from?: string;
    to?: string;
  } = {}): Promise<TaskRecord[]> {
    return authenticatedRequest(`/api/tasks${query(filters)}`);
  },

  get(id: string): Promise<TaskRecord> {
    return authenticatedRequest(`/api/tasks/${encodeURIComponent(id)}`);
  },

  create(input: {
    title: string;
    description?: string | null;
    priority: TaskPriority;
    dueDate?: string | null;
    employeeIds: string[];
  }): Promise<TaskRecord> {
    return authenticatedRequest('/api/tasks', json(input));
  },

  /**
   * `expectedUpdatedAt` is the optimistic-concurrency token read from the task
   * being edited. A concurrent edit makes the backend answer 409 rather than
   * letting the later write silently win.
   */
  update(
    id: string,
    input: {
      expectedUpdatedAt: string;
      title?: string;
      description?: string | null;
      priority?: TaskPriority;
      dueDate?: string | null;
    },
  ): Promise<TaskRecord> {
    return authenticatedRequest(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  cancel(id: string): Promise<TaskRecord> {
    return authenticatedRequest(`/api/tasks/${encodeURIComponent(id)}/cancel`, json({}));
  },

  eligibleEmployees(): Promise<TaskEligibleEmployee[]> {
    return authenticatedRequest('/api/tasks/eligible-employees');
  },

  updateProgress(
    assignmentId: string,
    input: { status: 'in_progress' | 'submitted'; completionDetails?: string },
  ): Promise<unknown> {
    return authenticatedRequest(
      `/api/task-assignments/${encodeURIComponent(assignmentId)}/progress`,
      { method: 'PATCH', body: JSON.stringify(input) },
    );
  },

  review(
    assignmentId: string,
    input: { action: 'accept' | 'return'; reviewNote?: string },
  ): Promise<unknown> {
    return authenticatedRequest(
      `/api/task-assignments/${encodeURIComponent(assignmentId)}/review`,
      json(input),
    );
  },

  listComments(
    taskId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<TaskCommentPage> {
    return authenticatedRequest(
      `/api/tasks/${encodeURIComponent(taskId)}/comments${query(options)}`,
    );
  },

  addComment(taskId: string, body: string): Promise<TaskCommentRecord> {
    return authenticatedRequest(
      `/api/tasks/${encodeURIComponent(taskId)}/comments`,
      json({ body }),
    );
  },

  timeline(taskId: string): Promise<TimelineResponse> {
    return authenticatedRequest(`/api/v2/tasks/${encodeURIComponent(taskId)}/timeline`);
  },
};

export const trainingApi = {
  listAssignments(filters: {
    scope?: 'own' | 'department' | 'company';
    status?: string;
    courseId?: string;
    page?: number;
    pageSize?: number;
  } = {}): Promise<TrainingAssignmentPage> {
    return authenticatedRequest(`/api/training/assignments${query(filters)}`);
  },

  updateProgress(assignmentId: string, progressPercent: number): Promise<unknown> {
    return authenticatedRequest(
      `/api/training/assignments/${encodeURIComponent(assignmentId)}/progress`,
      { method: 'PATCH', body: JSON.stringify({ progressPercent }) },
    );
  },

  submit(assignmentId: string, completionNote?: string | null): Promise<unknown> {
    return authenticatedRequest(
      `/api/training/assignments/${encodeURIComponent(assignmentId)}/submit`,
      json({ completionNote: completionNote ?? null }),
    );
  },

  /**
   * Issuing is idempotent server side: an exact retry replays the existing
   * certificate rather than minting a second one.
   */
  issueCertificate(assignmentId: string): Promise<TrainingCertificateRecord> {
    return authenticatedRequest(
      `/api/training/assignments/${encodeURIComponent(assignmentId)}/certificate`,
      json({}),
    );
  },

  getCertificate(assignmentId: string): Promise<TrainingCertificateRecord> {
    return authenticatedRequest(
      `/api/training/assignments/${encodeURIComponent(assignmentId)}/certificate`,
    );
  },

  createEvaluation(
    assignmentId: string,
    input: TrainingEvaluationInput,
  ): Promise<TrainingEvaluationRecord> {
    return authenticatedRequest(
      `/api/training/assignments/${encodeURIComponent(assignmentId)}/evaluation`,
      json(input),
    );
  },

  getEvaluation(assignmentId: string): Promise<TrainingEvaluationRecord> {
    return authenticatedRequest(
      `/api/training/assignments/${encodeURIComponent(assignmentId)}/evaluation`,
    );
  },

  timeline(assignmentId: string): Promise<TimelineResponse> {
    return authenticatedRequest(
      `/api/v2/training/assignments/${encodeURIComponent(assignmentId)}/timeline`,
    );
  },
};

export const chatApi = {
  listConversations(options: { offset?: number; limit?: number } = {}): Promise<ChatConversationPage> {
    return authenticatedRequest(`/api/chat/conversations${query(options)}`);
  },

  /**
   * `before` is the keyset cursor for OLDER messages. The backend returns each
   * page already in chronological order, so the client prepends a fetched page
   * rather than re-sorting the whole thread.
   */
  listMessages(
    conversationId: string,
    options: { before?: string; limit?: number } = {},
  ): Promise<ChatMessagePage> {
    return authenticatedRequest(
      `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages${query(options)}`,
    );
  },

  sendMessage(
    conversationId: string,
    input: { body: string; replyToMessageId?: string | null },
  ): Promise<ChatMessageRecord> {
    return authenticatedRequest(
      `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
      json(input),
    );
  },

  markRead(conversationId: string): Promise<{ conversationId: string; unreadCount: number }> {
    return authenticatedRequest(
      `/api/chat/conversations/${encodeURIComponent(conversationId)}/read`,
      json({}),
    );
  },

  unreadCount(): Promise<{ unreadCount: number }> {
    return authenticatedRequest('/api/chat/unread-count');
  },
};

export const notificationsApi = {
  list(options: {
    category?: string;
    read?: 'true' | 'false';
    cursor?: string;
    limit?: number;
  } = {}): Promise<NotificationPage> {
    return authenticatedRequest(`/api/v2/notifications${query(options)}`);
  },

  unreadCount(category?: string): Promise<{ unreadCount: number }> {
    return authenticatedRequest(`/api/v2/notifications/unread-count${query({ category })}`);
  },

  markRead(id: string): Promise<NotificationRecord> {
    return authenticatedRequest(`/api/v2/notifications/${encodeURIComponent(id)}/read`, json({}));
  },

  markAllRead(category?: string): Promise<{ updatedCount: number }> {
    return authenticatedRequest(
      '/api/v2/notifications/read-all',
      json(category ? { category } : {}),
    );
  },
};
