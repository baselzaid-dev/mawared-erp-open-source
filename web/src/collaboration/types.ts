/**
 * Commercial P4 — Tasks, Training, Chat and Notifications DTOs.
 *
 * These mirror the backend response shapes exactly. Nothing here is computed
 * client side: statuses, scopes and visibility all arrive already filtered by
 * the server, and the UI never reconstructs an authorization decision from them.
 */

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskStatus = 'active' | 'completed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskScope = 'own' | 'department' | 'company';

export type TaskAssignmentStatus =
  | 'assigned'
  | 'in_progress'
  | 'submitted'
  | 'accepted'
  | 'returned';

export interface TaskAssignmentRecord {
  id: string;
  taskId: string;
  employee: {
    id: string;
    employeeNum: string;
    name: string;
    departmentId: string | null;
    departmentName: string | null;
  };
  status: TaskAssignmentStatus;
  completionDetails: string | null;
  submittedAt: string | null;
  reviewer: { id: string; name: string } | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TaskRecord {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  priority: TaskPriority;
  dueDate: string | null;
  status: TaskStatus;
  creator: { id: string; name: string };
  assignments: TaskAssignmentRecord[];
  createdAt: string | null;
  /** Optimistic-concurrency token echoed back on edit. */
  updatedAt: string | null;
}

export interface TaskCommentRecord {
  id: string;
  taskId: string;
  body: string;
  author: { id: string; name: string };
  createdAt: string | null;
}

export interface TaskCommentPage {
  items: TaskCommentRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface TaskEligibleEmployee {
  employeeId: string;
  employeeNum: string;
  name: string;
  departmentId: string | null;
  departmentName: string | null;
}

export interface TimelineEventRecord {
  at: string;
  type: string;
  summary: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorName: string | null;
  actorRole: string | null;
  reason: string | null;
  override: boolean;
}

export interface TimelineResponse {
  entityType: string;
  entityId: string;
  events: TimelineEventRecord[];
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

export type TrainingAssignmentStatus =
  | 'assigned'
  | 'in_progress'
  | 'submitted'
  | 'completed'
  | 'returned'
  | 'cancelled';

export interface TrainingCourseSummary {
  id: string;
  courseCode: string;
  title: string;
  category: string | null;
  deliveryMode: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
}

export interface TrainingAssignmentRecord {
  id: string;
  companyId: string;
  courseId: string;
  course: TrainingCourseSummary | null;
  employee: {
    employeeId: string;
    employeeNum: string;
    displayName: string;
    departmentId: string | null;
    departmentName: string | null;
  };
  status: TrainingAssignmentStatus;
  progressPercent: number;
  score: number | null;
  completedAt: string | null;
  assignedAt: string | null;
}

export interface TrainingAssignmentPage {
  items: TrainingAssignmentRecord[];
  total: number;
}

export interface TrainingCertificateRecord {
  id: string;
  assignmentId: string;
  courseId: string;
  employeeId: string;
  serialNumber: string;
  courseTitle: string;
  employeeName: string;
  employeeNum: string;
  completedAt: string | null;
  issuedBy: { id: string; name: string } | null;
  issuedAt: string | null;
}

export type TrainingRecommendation =
  | 'recommended'
  | 'recommended_with_follow_up'
  | 'repeat_required';

export interface TrainingEvaluationRecord {
  id: string;
  assignmentId: string;
  courseId: string;
  employeeId: string;
  effectivenessScore: number;
  knowledgeScore: number;
  applicationScore: number;
  recommendation: TrainingRecommendation;
  comment: string | null;
  evaluatedBy: { id: string; name: string } | null;
  evaluatedAt: string | null;
}

export interface TrainingEvaluationInput {
  effectivenessScore: number;
  knowledgeScore: number;
  applicationScore: number;
  recommendation: TrainingRecommendation;
  comment?: string | null;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ChatConversationType = 'direct' | 'department' | 'announcement';

export interface ChatConversationRecord {
  id: string;
  type: ChatConversationType;
  title: string;
  peer: { userId: string; displayName: string; departmentName: string | null } | null;
  department: { id: string; name: string } | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  lastSender: { userId: string; displayName: string } | null;
  unreadCount: number;
  readState: { active: boolean; lastReadAt: string | null };
  createdAt: string | null;
  repliesEnabled: boolean;
}

export interface ChatAttachmentMeta {
  id: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
}

export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  sender: { userId: string; displayName: string; roleName: string; departmentName: string | null };
  body: string;
  replyToMessageId: string | null;
  createdAt: string | null;
  isOwn: boolean;
  attachments: ChatAttachmentMeta[];
}

export interface ChatMessagePage {
  /** Always chronological (oldest → newest) within the page. */
  items: ChatMessageRecord[];
  /** Cursor for the page of OLDER messages. */
  nextCursor: string | null;
  order: 'chronological';
}

export interface ChatConversationPage {
  items: ChatConversationRecord[];
  nextOffset: number | null;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type NotificationCategory =
  | 'general'
  | 'security'
  | 'workflow'
  | 'leave'
  | 'task'
  | 'attendance'
  | 'payroll'
  | 'chat'
  | 'purchasing'
  | 'training';

/**
 * Only present when the backend recognised the route key as allowlisted. An
 * unrecognised descriptor is dropped server side, so the client never has to
 * guess whether a deep link is safe to follow.
 */
export interface NotificationDescriptor {
  routeKey: string;
  resourceType: string;
  resourceId?: string;
  filterKey?: string;
  filterValue?: string;
}

export interface NotificationRecord {
  id: string;
  title: string;
  message: string;
  category: NotificationCategory;
  isRead: boolean;
  readAt: string | null;
  hiddenAt: string | null;
  createdAt: string;
  descriptor?: NotificationDescriptor;
}

export interface NotificationPage {
  items: NotificationRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}
