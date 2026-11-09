import { randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { writeAuditRequired } from './audit';
import { createDomainNotifications } from './notifications';
import { PERMISSIONS } from './permissions';
import { loadManagedDepartmentIds, loadPrimaryOwnerUserId } from './authorization';

export interface TrainingUser {
  id: string;
  companyId: string;
  employeeId: string | null;
  permissions: string[];
}

interface TrainingRequest extends Request {
  user?: TrainingUser;
}

interface TrainingRouteDeps {
  app: Express;
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  checkAnyPermission: (...permissions: string[]) => RequestHandler;
}

type TrainingScope = 'own' | 'department' | 'company';

interface ScopeContext {
  kind: TrainingScope;
  employeeId: string | null;
  departmentIds: string[];
}

class TrainingError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

const courseStatuses = ['draft', 'published', 'completed', 'cancelled', 'archived'] as const;
const assignmentStatuses = ['assigned', 'in_progress', 'submitted', 'completed', 'returned', 'cancelled'] as const;
const deliveryModes = ['onsite', 'online', 'hybrid', 'self_paced'] as const;
const resourceTypes = ['link', 'video', 'document'] as const;
const mutableAssignmentStatuses = ['assigned', 'in_progress', 'submitted', 'returned'];

const dateOnlyText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'يجب إدخال التاريخ بصيغة yyyy-MM-dd');
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const safeResourceUrl = z.string().trim().url().max(2048).superRefine((value, ctx) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'رابط المورد غير صالح' });
    return;
  }
  if (parsed.username || parsed.password) {
    ctx.addIssue({ code: 'custom', message: 'لا يسمح ببيانات دخول داخل رابط المورد' });
  }
  const localhost = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && localhost)) {
    ctx.addIssue({ code: 'custom', message: 'يجب أن يستخدم رابط المورد اتصال HTTPS آمناً' });
  }
});

const resourceSchema = z.object({
  title: z.string().trim().min(1).max(200),
  type: z.enum(resourceTypes).default('link'),
  url: safeResourceUrl,
  sortOrder: z.number().int().min(0).max(1000).optional(),
}).strict();

const courseBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: optionalText(4000),
  category: optionalText(120),
  instructorName: optionalText(160),
  deliveryMode: z.enum(deliveryModes),
  location: optionalText(300),
  startDate: dateOnlyText.nullable().optional(),
  endDate: dateOnlyText.nullable().optional(),
  durationHours: z.number().int().min(1).max(10_000).nullable().optional(),
  capacity: z.number().int().min(1).max(10_000).nullable().optional(),
  resources: z.array(resourceSchema).max(20).default([]),
}).strict();

const courseListSchema = z.object({
  scope: z.enum(['own', 'department', 'company']).optional(),
  status: z.enum(courseStatuses).optional(),
  category: z.string().trim().max(120).optional(),
  from: dateOnlyText.optional(),
  to: dateOnlyText.optional(),
  query: z.string().trim().max(160).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const assignmentListSchema = z.object({
  scope: z.enum(['own', 'department', 'company']).optional(),
  status: z.enum(assignmentStatuses).optional(),
  courseId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  from: dateOnlyText.optional(),
  to: dateOnlyText.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const eligibleEmployeesSchema = z.object({
  query: z.string().trim().max(160).optional(),
  departmentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const assignmentCreateSchema = z.object({
  employeeIds: z.array(z.string().uuid()).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.employeeIds).size !== value.employeeIds.length) {
    ctx.addIssue({ code: 'custom', path: ['employeeIds'], message: 'لا يمكن تكرار الموظف في طلب الإسناد' });
  }
});

const progressSchema = z.object({
  progressPercent: z.number().int().min(1).max(99),
}).strict();

const submitSchema = z.object({ completionNote: optionalText(2000) }).strict();

const reviewSchema = z.object({
  action: z.enum(['accept', 'return']),
  score: z.number().int().min(0).max(100).nullable().optional(),
  reviewNote: optionalText(2000),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'return' && !value.reviewNote?.trim()) {
    ctx.addIssue({ code: 'custom', path: ['reviewNote'], message: 'ملاحظة الإعادة مطلوبة' });
  }
  if (value.action === 'return' && value.score != null) {
    ctx.addIssue({ code: 'custom', path: ['score'], message: 'لا تسجل الدرجة عند إعادة الإكمال' });
  }
});

const cancellationSchema = z.object({
  cancellationReason: z.string().trim().min(1).max(1000),
}).strict();

const evaluationScore = z.number().int().min(1).max(5);

/**
 * P4 evaluation input. Scores are bounded 1..5 and mirrored by CHECK constraints
 * in the migration, so a direct SQL writer cannot store an out-of-range value
 * either. `.strict()` blocks overposting of employeeId/companyId/assignmentId —
 * all three are derived server-side from the assignment being evaluated.
 */
const evaluationCreateSchema = z.object({
  effectivenessScore: evaluationScore,
  knowledgeScore: evaluationScore,
  applicationScore: evaluationScore,
  recommendation: z.enum(['recommended', 'recommended_with_follow_up', 'repeat_required']),
  comment: z.string().trim().min(1).max(2000).nullable().optional(),
}).strict();

const reportSchema = z.object({
  scope: z.enum(['own', 'department', 'company']).optional(),
  from: dateOnlyText.optional(),
  to: dateOnlyText.optional(),
  courseStatus: z.enum(courseStatuses).optional(),
  assignmentStatus: z.enum(assignmentStatuses).optional(),
  category: z.string().trim().max(120).optional(),
  departmentId: z.string().uuid().optional(),
}).strict();

export type TrainingReportFilters = z.infer<typeof reportSchema>;

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new TrainingError(
      400,
      'TRAINING_VALIDATION_ERROR',
      'بيانات التدريب المدخلة غير صالحة',
      result.error.flatten()
    );
  }
  return result.data;
};

const sendError = (res: Response, error: unknown): Response => {
  if (error instanceof TrainingError) {
    return res.status(error.status).json({
      error: error.errorCode,
      message: error.message,
      code: error.status,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return res.status(409).json({
      error: 'TRAINING_DUPLICATE',
      message: 'يوجد سجل تدريب مماثل بالفعل',
      code: 409,
    });
  }
  return res.status(500).json({
    error: 'TRAINING_OPERATION_FAILED',
    message: 'تعذر إكمال عملية التدريب حالياً',
    code: 500,
  });
};

const parsePermissions = (value: string | null | undefined): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((permission): permission is string => typeof permission === 'string')
      : [];
  } catch {
    return [];
  }
};

const isAdmin = (user: TrainingUser): boolean => user.permissions.includes(PERMISSIONS.ADMIN_FULL);
const has = (user: TrainingUser, permission: string): boolean =>
  isAdmin(user) || user.permissions.includes(permission);
const canViewOwner = (user: TrainingUser): boolean =>
  isAdmin(user) || user.permissions.includes(PERMISSIONS.HR_VIEW);
const isOwnerAssignment = (assignment: any, primaryOwnerUserId: string | null): boolean =>
  assignment.employee?.user?.id === primaryOwnerUserId ||
  parsePermissions(assignment.employee?.user?.role?.permissions).includes(PERMISSIONS.ADMIN_FULL);

const timestamp = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();
const dateOnly = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString().slice(0, 10);

const parseDateOnly = (value: string): Date => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TrainingError(400, 'TRAINING_DATE_INVALID', 'تاريخ التدريب غير صالح');
  }
  return parsed;
};

const validateRange = (from?: string, to?: string): { from?: Date; to?: Date } => {
  if (!!from !== !!to) {
    throw new TrainingError(400, 'TRAINING_DATE_RANGE_REQUIRED', 'يجب إدخال تاريخ البداية والنهاية معاً');
  }
  if (!from || !to) return {};
  const start = parseDateOnly(from);
  const end = parseDateOnly(to);
  if (start > end) {
    throw new TrainingError(400, 'TRAINING_DATE_RANGE_INVALID', 'تاريخ البداية يجب ألا يتجاوز تاريخ النهاية');
  }
  if ((end.getTime() - start.getTime()) / 86_400_000 > 366) {
    throw new TrainingError(400, 'TRAINING_DATE_RANGE_TOO_LONG', 'الفترة المطلوبة يجب ألا تتجاوز 366 يوماً');
  }
  return { from: start, to: end };
};

const validateCourseDates = (body: z.infer<typeof courseBodySchema>): void => {
  const start = body.startDate ? parseDateOnly(body.startDate) : null;
  const end = body.endDate ? parseDateOnly(body.endDate) : null;
  if (start && end && end < start) {
    throw new TrainingError(400, 'TRAINING_COURSE_DATES_INVALID', 'تاريخ نهاية الدورة يجب ألا يسبق تاريخ بدايتها');
  }
};

const managedDepartmentIds = async (client: any, user: TrainingUser): Promise<string[]> => {
  return loadManagedDepartmentIds(client, { companyId: user.companyId, userId: user.id });
};

const resolveViewScope = async (
  client: any,
  user: TrainingUser,
  requested?: TrainingScope
): Promise<ScopeContext> => {
  const selected: TrainingScope = requested ?? (
    has(user, PERMISSIONS.TRAINING_VIEW_COMPANY)
      ? 'company'
      : has(user, PERMISSIONS.TRAINING_VIEW_DEPARTMENT)
        ? 'department'
        : 'own'
  );
  if (selected === 'company') {
    if (!has(user, PERMISSIONS.TRAINING_VIEW_COMPANY)) {
      throw new TrainingError(403, 'TRAINING_SCOPE_FORBIDDEN', 'لا تملك صلاحية عرض تدريب الشركة');
    }
    return { kind: selected, employeeId: user.employeeId, departmentIds: [] };
  }
  if (selected === 'department') {
    if (!has(user, PERMISSIONS.TRAINING_VIEW_DEPARTMENT)) {
      throw new TrainingError(403, 'TRAINING_SCOPE_FORBIDDEN', 'لا تملك صلاحية عرض تدريب القسم');
    }
    return {
      kind: selected,
      employeeId: user.employeeId,
      departmentIds: await managedDepartmentIds(client, user),
    };
  }
  if (!user.employeeId || !has(user, PERMISSIONS.TRAINING_VIEW_OWN)) {
    throw new TrainingError(403, 'TRAINING_SCOPE_FORBIDDEN', 'لا تملك صلاحية عرض دوراتك');
  }
  return { kind: selected, employeeId: user.employeeId, departmentIds: [] };
};

const assignmentInternalInclude = {
  course: { include: { resources: { orderBy: { sortOrder: 'asc' as const } } } },
  employee: {
    select: {
      id: true,
      departmentId: true,
      user: {
        select: {
          id: true,
          name: true,
          role: { select: { name: true, permissions: true } },
        },
      },
    },
  },
} as const;

const courseInternalInclude = {
  resources: { orderBy: { sortOrder: 'asc' as const } },
  assignments: {
    include: {
      employee: {
        select: {
          id: true,
          departmentId: true,
          user: { select: { id: true, role: { select: { permissions: true } } } },
        },
      },
    },
    orderBy: { assignedAt: 'asc' as const },
  },
} as const;

const resourceShape = (resource: any) => ({
  id: resource.id,
  title: resource.title,
  type: resource.resourceType,
  url: resource.url,
  sortOrder: resource.sortOrder,
});

const courseSummaryShape = (course: any) => ({
  id: course.id,
  courseCode: course.courseCode,
  title: course.title,
  category: course.category ?? null,
  instructorName: course.instructorName ?? null,
  deliveryMode: course.deliveryMode,
  location: course.location ?? null,
  startDate: dateOnly(course.startDate),
  endDate: dateOnly(course.endDate),
  durationHours: course.durationHours ?? null,
  status: course.status,
});

const assignmentShape = (assignment: any) => ({
  id: assignment.id,
  companyId: assignment.companyId,
  courseId: assignment.courseId,
  course: assignment.course ? courseSummaryShape(assignment.course) : null,
  employee: {
    employeeId: assignment.employeeId,
    employeeNum: assignment.employeeNumSnapshot,
    displayName: assignment.employeeNameSnapshot,
    departmentId: assignment.departmentIdSnapshot ?? null,
    departmentName: assignment.departmentNameSnapshot ?? null,
  },
  status: assignment.status,
  progressPercent: assignment.progressPercent,
  assignedAt: timestamp(assignment.assignedAt),
  startedAt: timestamp(assignment.startedAt),
  submittedAt: timestamp(assignment.submittedAt),
  completedAt: timestamp(assignment.completedAt),
  reviewedAt: timestamp(assignment.reviewedAt),
  reviewNote: assignment.reviewNote ?? null,
  score: assignment.score ?? null,
  cancellation: assignment.cancelledAt ? {
    cancelledAt: timestamp(assignment.cancelledAt),
    reason: assignment.cancellationReason ?? null,
  } : null,
  createdAt: timestamp(assignment.createdAt),
  updatedAt: timestamp(assignment.updatedAt),
});

const assignmentSummary = (assignments: any[]) => {
  const summary: Record<string, number> = {
    total: assignments.length,
    assigned: 0,
    in_progress: 0,
    submitted: 0,
    completed: 0,
    returned: 0,
    cancelled: 0,
  };
  for (const assignment of assignments) {
    if (Object.prototype.hasOwnProperty.call(summary, assignment.status)) summary[assignment.status] += 1;
  }
  return summary;
};

const courseShape = (course: any, visibleAssignments: any[], ownEmployeeId?: string | null) => ({
  id: course.id,
  companyId: course.companyId,
  courseCode: course.courseCode,
  title: course.title,
  description: course.description ?? null,
  category: course.category ?? null,
  instructorName: course.instructorName ?? null,
  deliveryMode: course.deliveryMode,
  location: course.location ?? null,
  startDate: dateOnly(course.startDate),
  endDate: dateOnly(course.endDate),
  durationHours: course.durationHours ?? null,
  capacity: course.capacity ?? null,
  status: course.status,
  resources: (course.resources ?? []).map(resourceShape),
  assignmentSummary: assignmentSummary(visibleAssignments),
  ownAssignment: ownEmployeeId
    ? (visibleAssignments.find((assignment) => assignment.employeeId === ownEmployeeId)
      ? assignmentShape(visibleAssignments.find((assignment) => assignment.employeeId === ownEmployeeId))
      : null)
    : null,
  createdAt: timestamp(course.createdAt),
  publishedAt: timestamp(course.publishedAt),
  completedAt: timestamp(course.completedAt),
  cancelledAt: timestamp(course.cancelledAt),
  archivedAt: timestamp(course.archivedAt),
  updatedAt: timestamp(course.updatedAt),
});

const assignmentVisible = (
  assignment: any,
  scope: ScopeContext,
  user: TrainingUser,
  primaryOwnerUserId: string | null,
): boolean => {
  const own = assignment.employeeId === scope.employeeId;
  if (own) return true;
  if (isOwnerAssignment(assignment, primaryOwnerUserId) && !canViewOwner(user)) return false;
  if (scope.kind === 'company') return true;
  if (scope.kind === 'department') {
    return !!assignment.departmentIdSnapshot && scope.departmentIds.includes(assignment.departmentIdSnapshot);
  }
  return false;
};

const visibleCourseAssignments = (
  course: any,
  scope: ScopeContext,
  user: TrainingUser,
  includeOwnInDepartment: boolean,
  primaryOwnerUserId: string | null,
): any[] => (course.assignments ?? []).filter((assignment: any) => {
  if (scope.kind === 'department' && includeOwnInDepartment && assignment.employeeId === scope.employeeId) {
    return true;
  }
  return assignmentVisible(assignment, scope, user, primaryOwnerUserId);
});

const ensureDepartmentFilter = (scope: ScopeContext, departmentId?: string): void => {
  if (!departmentId) return;
  if (scope.kind === 'own') {
    throw new TrainingError(403, 'TRAINING_DEPARTMENT_FORBIDDEN', 'لا يمكن تحديد قسم خارج نطاقك');
  }
  if (scope.kind === 'department' && !scope.departmentIds.includes(departmentId)) {
    throw new TrainingError(403, 'TRAINING_DEPARTMENT_FORBIDDEN', 'القسم المحدد خارج نطاق إدارتك');
  }
};

/**
 * P4: training notifications now carry the `training` category and, when the
 * event is about one assignment, the allowlisted `training.assignment.detail`
 * deep link. Previously they were written bare and arrived as uncategorised
 * "general" rows with nothing for a client to navigate to. Only the assignment
 * id travels — never the completion note, review note or score.
 */
const notify = async (
  client: any,
  companyId: string,
  actorId: string,
  recipients: Iterable<string>,
  title: string,
  message: string,
  assignmentId?: string | null
): Promise<void> => {
  await createDomainNotifications(client, {
    companyId,
    userIds: [...new Set(recipients)].filter((userId) => !!userId && userId !== actorId),
    title,
    message,
    category: 'training',
    ...(assignmentId
      ? {
          descriptor: {
            routeKey: 'training.assignment.detail' as const,
            resourceType: 'trainingAssignment',
            resourceId: assignmentId,
          },
        }
      : {}),
  });
};

const reviewerUserIds = async (
  client: any,
  assignment: any,
  actorId: string
): Promise<string[]> => {
  const users = await client.user.findMany({
    where: { companyId: assignment.companyId },
    select: { id: true, employeeId: true, role: { select: { permissions: true } } },
  });
  return users.filter((candidate: any) => {
    const permissions = parsePermissions(candidate.role?.permissions);
    const reviewer = permissions.includes(PERMISSIONS.ADMIN_FULL)
      || permissions.includes(PERMISSIONS.TRAINING_REVIEW);
    return reviewer && candidate.id !== actorId && candidate.employeeId !== assignment.employeeId;
  }).map((candidate: any) => candidate.id);
};

const findCourse = async (client: any, user: TrainingUser, id: string) => {
  const course = await client.trainingCourse.findFirst({
    where: { id, companyId: user.companyId },
    include: courseInternalInclude,
  });
  if (!course) {
    throw new TrainingError(404, 'TRAINING_COURSE_NOT_FOUND', 'الدورة التدريبية غير موجودة');
  }
  return course;
};

const findAssignment = async (client: any, user: TrainingUser, id: string) => {
  const assignment = await client.trainingAssignment.findFirst({
    where: { id, companyId: user.companyId },
    include: assignmentInternalInclude,
  });
  if (!assignment) {
    throw new TrainingError(404, 'TRAINING_ASSIGNMENT_NOT_FOUND', 'تكليف التدريب غير موجود');
  }
  return assignment;
};

const generateCourseCode = (): string => {
  const month = new Date().toISOString().slice(0, 7).replace('-', '');
  return `TR-${month}-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
};

const generateCertificateSerial = (): string => {
  const month = new Date().toISOString().slice(0, 7).replace('-', '');
  return `CERT-${month}-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
};

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const certificateShape = (certificate: any) => ({
  id: certificate.id,
  assignmentId: certificate.assignmentId,
  courseId: certificate.courseId,
  employeeId: certificate.employeeId,
  serialNumber: certificate.serialNumber,
  courseTitle: certificate.courseTitleSnapshot,
  employeeName: certificate.employeeNameSnapshot,
  employeeNum: certificate.employeeNumSnapshot,
  completedAt: timestamp(certificate.completedAtSnapshot),
  issuedBy: certificate.issuedBy
    ? { id: certificate.issuedBy.id, name: certificate.issuedBy.name }
    : null,
  issuedAt: timestamp(certificate.issuedAt),
});

const evaluationShape = (evaluation: any) => ({
  id: evaluation.id,
  assignmentId: evaluation.assignmentId,
  courseId: evaluation.courseId,
  employeeId: evaluation.employeeId,
  effectivenessScore: evaluation.effectivenessScore,
  knowledgeScore: evaluation.knowledgeScore,
  applicationScore: evaluation.applicationScore,
  recommendation: evaluation.recommendation,
  comment: evaluation.comment ?? null,
  evaluatedBy: evaluation.evaluatedBy
    ? { id: evaluation.evaluatedBy.id, name: evaluation.evaluatedBy.name }
    : null,
  evaluatedAt: timestamp(evaluation.evaluatedAt),
});

const certificateInclude = {
  issuedBy: { select: { id: true, name: true } },
} as const;

const evaluationInclude = {
  evaluatedBy: { select: { id: true, name: true } },
} as const;

/**
 * Shared gate for both completion artifacts: the assignment must exist in this
 * company, be visible under the caller's own training scope, and be completed.
 * An out-of-scope assignment is reported as 404 so its existence never leaks.
 */
const loadCompletedVisibleAssignment = async (
  client: any,
  user: TrainingUser,
  id: string
) => {
  const assignment = await findAssignment(client, user, id);
  const scope = await resolveViewScope(client, user);
  const primaryOwnerUserId = await loadPrimaryOwnerUserId(client, user.companyId);
  if (!assignmentVisible(assignment, scope, user, primaryOwnerUserId)) {
    throw new TrainingError(404, 'TRAINING_ASSIGNMENT_NOT_FOUND', 'تكليف التدريب غير موجود');
  }
  if (assignment.status !== 'completed') {
    throw new TrainingError(
      409,
      'TRAINING_ASSIGNMENT_NOT_COMPLETED',
      'يتطلب هذا الإجراء تكليفاً مكتملاً'
    );
  }
  return assignment;
};

const courseData = (body: z.infer<typeof courseBodySchema>) => ({
  title: body.title,
  description: body.description ?? null,
  category: body.category ?? null,
  instructorName: body.instructorName ?? null,
  deliveryMode: body.deliveryMode,
  location: body.location ?? null,
  startDate: body.startDate ? parseDateOnly(body.startDate) : null,
  endDate: body.endDate ? parseDateOnly(body.endDate) : null,
  durationHours: body.durationHours ?? null,
  capacity: body.capacity ?? null,
});

const nestedResourceData = (resources: z.infer<typeof resourceSchema>[]) =>
  resources.map((resource, index) => ({
    title: resource.title,
    resourceType: resource.type,
    url: resource.url,
    sortOrder: resource.sortOrder ?? index,
  }));

const resourceData = (companyId: string, resources: z.infer<typeof resourceSchema>[]) =>
  nestedResourceData(resources).map((resource) => ({ companyId, ...resource }));

const paginate = <T>(items: T[], page: number, pageSize: number) => ({
  items: items.slice((page - 1) * pageSize, page * pageSize),
  page,
  pageSize,
  total: items.length,
});

const deleteNotAllowed = (res: Response): Response => res.status(405).json({
  error: 'TRAINING_DELETE_NOT_ALLOWED',
  message: 'لا يمكن حذف سجلات التدريب؛ استخدم الإلغاء أو الأرشفة للحفاظ على السجل',
  code: 405,
});

const buildCourseTimeline = (course: any, visibleAssignments: any[]) => {
  const events: Array<{ at: string; type: string; summary: string }> = [];
  const push = (at: Date | string | null | undefined, type: string, summary: string) => {
    if (at == null) return;
    events.push({ at: new Date(at).toISOString(), type, summary });
  };

  push(course.createdAt, 'course.created', 'Course created');
  push(course.publishedAt, 'course.published', 'Course published');
  push(course.completedAt, 'course.completed', 'Course completed');
  push(course.cancelledAt, 'course.cancelled', 'Course cancelled');
  push(course.archivedAt, 'course.archived', 'Course archived');

  for (const assignment of visibleAssignments) {
    push(assignment.assignedAt, 'assignment.assigned', 'Assignment created');
    push(assignment.submittedAt, 'assignment.submitted', 'Assignment submitted');
    push(assignment.reviewedAt, 'assignment.reviewed', 'Assignment reviewed');
  }

  events.sort((left, right) => left.at.localeCompare(right.at));
  return { courseId: course.id, events };
};

export async function buildTrainingReport(
  client: any,
  user: TrainingUser,
  rawFilters: unknown,
  maxCourses = 5001
): Promise<{ report: any; audit: { scope: TrainingScope; filters: string[] } }> {
  const query = parse(reportSchema, rawFilters);
  const range = validateRange(query.from, query.to);
  const scope = await resolveViewScope(client, user, query.scope);
  ensureDepartmentFilter(scope, query.departmentId);
  const courses = await client.trainingCourse.findMany({
    where: {
      companyId: user.companyId,
      ...(query.courseStatus ? { status: query.courseStatus } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(range.from && range.to ? { startDate: { gte: range.from, lte: range.to } } : {}),
    },
    include: courseInternalInclude,
    orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
    take: Math.max(1, Math.min(maxCourses, 5001)),
  });
  const primaryOwnerUserId = await loadPrimaryOwnerUserId(client, user.companyId);
  const visibleCourses: Array<{ course: any; assignments: any[] }> = [];
  for (const course of courses as any[]) {
    let assignments = visibleCourseAssignments(
      course,
      scope,
      user,
      false,
      primaryOwnerUserId,
    );
    if (query.assignmentStatus) {
      assignments = assignments.filter((row) => row.status === query.assignmentStatus);
    }
    if (query.departmentId) {
      assignments = assignments.filter(
        (row) => row.departmentIdSnapshot === query.departmentId
      );
    }
    if (scope.kind === 'company' || assignments.length > 0) {
      visibleCourses.push({ course, assignments });
    }
  }
  const assignments = visibleCourses.flatMap((item) => item.assignments);
  const countStatus = (status: string) => assignments.filter((row) => row.status === status).length;
  const countCourseStatus = (status: string) =>
    visibleCourses.filter((row) => row.course.status === status).length;
  const nonCancelled = assignments.filter((row) => row.status !== 'cancelled');
  const scores = assignments.filter((row) => row.score != null).map((row) => Number(row.score));
  const round2 = (value: number): number => Math.round(value * 100) / 100;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const overdueCount = assignments.filter((assignment) => {
    const course = visibleCourses.find((item) => item.course.id === assignment.courseId)?.course;
    return course?.endDate && new Date(course.endDate) < today
      && !['completed', 'cancelled'].includes(assignment.status);
  }).length;
  const departmentMap = new Map<string, any>();
  for (const assignment of assignments) {
    const key = assignment.departmentIdSnapshot ?? 'unassigned';
    const row = departmentMap.get(key) ?? {
      departmentId: assignment.departmentIdSnapshot ?? null,
      departmentName: assignment.departmentNameSnapshot ?? null,
      assignmentCount: 0,
      completedCount: 0,
    };
    row.assignmentCount += 1;
    if (assignment.status === 'completed') row.completedCount += 1;
    departmentMap.set(key, row);
  }
  const report = {
    summary: {
      courseCount: visibleCourses.length,
      draftCourseCount: countCourseStatus('draft'),
      publishedCourseCount: countCourseStatus('published'),
      completedCourseCount: countCourseStatus('completed'),
      cancelledCourseCount: countCourseStatus('cancelled'),
      assignmentCount: assignments.length,
      assignedCount: countStatus('assigned'),
      inProgressCount: countStatus('in_progress'),
      submittedCount: countStatus('submitted'),
      completedAssignmentCount: countStatus('completed'),
      returnedCount: countStatus('returned'),
      cancelledAssignmentCount: countStatus('cancelled'),
      overdueCount,
      completionRatePercent: nonCancelled.length === 0
        ? 0
        : round2(countStatus('completed') * 100 / nonCancelled.length),
      averageProgressPercent: assignments.length === 0
        ? 0
        : round2(assignments.reduce((sum, row) => sum + row.progressPercent, 0) / assignments.length),
      averageScore: scores.length === 0
        ? null
        : (scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(2),
    },
    courses: visibleCourses.map(({ course, assignments: rows }) => ({
      ...courseSummaryShape(course),
      assignmentSummary: assignmentSummary(rows),
    })),
    assignments: assignments.map((assignment) => ({
      id: assignment.id,
      courseId: assignment.courseId,
      employee: {
        employeeId: assignment.employeeId,
        employeeNum: assignment.employeeNumSnapshot,
        displayName: assignment.employeeNameSnapshot,
        departmentId: assignment.departmentIdSnapshot ?? null,
        departmentName: assignment.departmentNameSnapshot ?? null,
      },
      status: assignment.status,
    })),
    departments: Array.from(departmentMap.values()).map((row) => ({
      ...row,
      completionRatePercent: row.assignmentCount === 0
        ? 0
        : round2(row.completedCount * 100 / row.assignmentCount),
    })),
  };
  return {
    report,
    audit: {
      scope: scope.kind,
      filters: ['from', 'to', 'courseStatus', 'assignmentStatus', 'category', 'departmentId']
        .filter((key) => query[key as keyof typeof query] != null),
    },
  };
}

export function registerTrainingRoutes({
  app,
  prisma,
  requireAuth,
  checkAnyPermission,
}: TrainingRouteDeps): void {
  const viewPermissions = [
    PERMISSIONS.TRAINING_VIEW_OWN,
    PERMISSIONS.TRAINING_VIEW_DEPARTMENT,
    PERMISSIONS.TRAINING_VIEW_COMPANY,
  ];

  app.get(
    '/api/training/eligible-employees',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_ASSIGN),
    async (req: TrainingRequest, res) => {
      try {
        const query = parse(eligibleEmployeesSchema, req.query);
        const employees = await prisma.employee.findMany({
          where: {
            companyId: req.user!.companyId,
            status: 'active',
            ...(query.departmentId ? { departmentId: query.departmentId } : {}),
          },
          include: {
            user: { select: { id: true, name: true, role: { select: { name: true, permissions: true } } } },
            department: { select: { id: true, name: true } },
          },
          orderBy: [{ department: { name: 'asc' } }, { employeeNum: 'asc' }],
        });
        const normalizedQuery = query.query?.toLocaleLowerCase('ar');
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        const safeEmployees = employees.filter((employee: any) => {
          if (!employee.user) return false;
          const owner = employee.user.id === primaryOwnerUserId ||
            parsePermissions(employee.user.role?.permissions).includes(PERMISSIONS.ADMIN_FULL);
          if (owner && !canViewOwner(req.user!)) return false;
          if (!normalizedQuery) return true;
          return `${employee.user.name} ${employee.employeeNum}`.toLocaleLowerCase('ar').includes(normalizedQuery);
        }).slice(0, query.limit).map((employee: any) => ({
          employeeId: employee.id,
          employeeNum: employee.employeeNum,
          displayName: employee.user.name,
          departmentId: employee.departmentId ?? null,
          departmentName: employee.department?.name ?? null,
          roleName: employee.user.role?.name ?? null,
        }));
        return res.json(safeEmployees);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/training/courses',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_MANAGE),
    async (req: TrainingRequest, res) => {
      try {
        const body = parse(courseBodySchema, req.body);
        validateCourseDates(body);
        let created: any = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            created = await prisma.$transaction(async (tx) => {
              const course = await tx.trainingCourse.create({
                data: {
                  companyId: req.user!.companyId,
                  courseCode: generateCourseCode(),
                  ...courseData(body),
                  status: 'draft',
                  createdByUserId: req.user!.id,
                  resources: { create: nestedResourceData(body.resources) },
                },
                include: courseInternalInclude,
              });
              await writeAuditRequired(tx, {
                companyId: req.user!.companyId,
                userId: req.user!.id,
                action: 'training.course.create',
                details: { courseId: course.id, resourceCount: body.resources.length, status: 'draft' },
              });
              return course;
            });
            break;
          } catch (error) {
            const target = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
              ? String(error.meta?.target ?? '')
              : '';
            if (!target.includes('courseCode') || attempt === 2) throw error;
          }
        }
        if (!created) {
          throw new TrainingError(409, 'TRAINING_CODE_COLLISION', 'تعذر إنشاء رمز فريد للدورة');
        }
        return res.status(201).json(courseShape(created, [], req.user!.employeeId));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.get(
    '/api/training/courses',
    requireAuth,
    checkAnyPermission(...viewPermissions),
    async (req: TrainingRequest, res) => {
      try {
        const query = parse(courseListSchema, req.query);
        const range = validateRange(query.from, query.to);
        const scope = await resolveViewScope(prisma, req.user!, query.scope);
        const courses = await prisma.trainingCourse.findMany({
          where: {
            companyId: req.user!.companyId,
            ...(query.status ? { status: query.status } : {}),
            ...(query.category ? { category: query.category } : {}),
            ...(range.from && range.to ? { startDate: { gte: range.from, lte: range.to } } : {}),
          },
          include: courseInternalInclude,
          orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
        });
        const search = query.query?.toLocaleLowerCase('ar');
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        const scoped = courses.flatMap((course: any) => {
          if (search && !`${course.courseCode} ${course.title}`.toLocaleLowerCase('ar').includes(search)) return [];
          const visible = visibleCourseAssignments(
            course,
            scope,
            req.user!,
            true,
            primaryOwnerUserId,
          );
          if (scope.kind !== 'company' && visible.length === 0) return [];
          return [courseShape(course, visible, req.user!.employeeId)];
        });
        return res.json(paginate(scoped, query.page, query.pageSize));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.get(
    '/api/training/courses/:id',
    requireAuth,
    checkAnyPermission(...viewPermissions),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const scope = await resolveViewScope(prisma, req.user!, req.query.scope as TrainingScope | undefined);
        const course = await findCourse(prisma, req.user!, id);
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        const visible = visibleCourseAssignments(
          course,
          scope,
          req.user!,
          true,
          primaryOwnerUserId,
        );
        if (scope.kind !== 'company' && visible.length === 0) {
          throw new TrainingError(404, 'TRAINING_COURSE_NOT_FOUND', 'الدورة التدريبية غير موجودة');
        }
        return res.json(courseShape(course, visible, req.user!.employeeId));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.put(
    '/api/training/courses/:id',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_MANAGE),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const body = parse(courseBodySchema, req.body);
        validateCourseDates(body);
        const existing = await findCourse(prisma, req.user!, id);
        if (existing.status !== 'draft') {
          throw new TrainingError(409, 'TRAINING_COURSE_IMMUTABLE', 'لا يمكن تعديل الدورة بعد نشرها');
        }
        const fields = ['title', 'description', 'category', 'instructorName', 'deliveryMode', 'location', 'startDate', 'endDate', 'durationHours', 'capacity'];
        const nextData: any = courseData(body);
        const changedFields = fields.filter((field) => {
          const before = field === 'startDate' || field === 'endDate' ? dateOnly(existing[field]) : existing[field] ?? null;
          const after = field === 'startDate' || field === 'endDate'
            ? (body[field as 'startDate' | 'endDate'] ?? null)
            : nextData[field] ?? null;
          return before !== after;
        });
        if (JSON.stringify((existing.resources ?? []).map(resourceShape)) !== JSON.stringify(body.resources.map((resource, index) => ({
          id: undefined,
          title: resource.title,
          type: resource.type,
          url: resource.url,
          sortOrder: resource.sortOrder ?? index,
        })))) changedFields.push('resources');
        const updated = await prisma.$transaction(async (tx) => {
          await tx.trainingResource.deleteMany({ where: { companyId: req.user!.companyId, courseId: id } });
          await tx.trainingResource.createMany({
            data: resourceData(req.user!.companyId, body.resources).map((resource) => ({ ...resource, courseId: id })),
          });
          await tx.trainingCourse.update({ where: { id }, data: nextData });
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'training.course.update',
            details: { courseId: id, changedFields, resourceCount: body.resources.length },
          });
          return tx.trainingCourse.findFirst({ where: { id, companyId: req.user!.companyId }, include: courseInternalInclude });
        });
        return res.json(courseShape(updated, updated.assignments ?? [], req.user!.employeeId));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/training/courses/:id/publish',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_MANAGE),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const course = await findCourse(prisma, req.user!, id);
        if (course.status !== 'draft') {
          throw new TrainingError(409, 'TRAINING_COURSE_ALREADY_PUBLISHED', 'لا يمكن نشر هذه الدورة من حالتها الحالية');
        }
        if (course.deliveryMode === 'onsite' && !course.location?.trim()) {
          throw new TrainingError(400, 'TRAINING_LOCATION_REQUIRED', 'موقع الدورة الحضورية مطلوب قبل النشر');
        }
        if (
          ['online', 'self_paced'].includes(course.deliveryMode)
          && (course.resources ?? []).length === 0
          && !course.instructorName?.trim()
        ) {
          throw new TrainingError(400, 'TRAINING_PUBLISH_DETAILS_REQUIRED', 'أضف مورداً تدريبياً أو اسم المدرب قبل النشر');
        }
        const updated = await prisma.$transaction(async (tx) => {
          const row = await tx.trainingCourse.update({
            where: { id },
            data: { status: 'published', publishedByUserId: req.user!.id, publishedAt: new Date() },
            include: courseInternalInclude,
          });
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'training.course.publish',
            details: { courseId: id, status: 'published' },
          });
          return row;
        });
        return res.json(courseShape(updated, updated.assignments ?? [], req.user!.employeeId));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/training/courses/:id/assignments',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_ASSIGN),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const body = parse(assignmentCreateSchema, req.body);
        const course = await findCourse(prisma, req.user!, id);
        if (course.status !== 'published') {
          throw new TrainingError(409, 'TRAINING_COURSE_NOT_PUBLISHED', 'يجب نشر الدورة قبل إسنادها');
        }
        const employees = await prisma.employee.findMany({
          where: { id: { in: body.employeeIds }, companyId: req.user!.companyId, status: 'active' },
          include: {
            user: { select: { id: true, name: true, role: { select: { permissions: true } } } },
            department: { select: { id: true, name: true } },
          },
        });
        if (employees.length !== body.employeeIds.length || employees.some((employee: any) => !employee.user)) {
          throw new TrainingError(400, 'TRAINING_EMPLOYEE_INVALID', 'أحد الموظفين المحددين غير متاح للتدريب');
        }
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        if (employees.some((employee: any) => {
          const owner = employee.user?.id === primaryOwnerUserId ||
            parsePermissions(employee.user?.role?.permissions).includes(PERMISSIONS.ADMIN_FULL);
          return owner && !canViewOwner(req.user!);
        })) {
          throw new TrainingError(403, 'TRAINING_OWNER_ASSIGNMENT_FORBIDDEN', 'لا تملك صلاحية إسناد تدريب إلى حساب المدير العام');
        }
        const existing = await prisma.trainingAssignment.findMany({
          where: { companyId: req.user!.companyId, courseId: id, employeeId: { in: body.employeeIds } },
          select: { employeeId: true },
        });
        if (existing.length > 0) {
          throw new TrainingError(409, 'TRAINING_ASSIGNMENT_EXISTS', 'يوجد تكليف سابق لأحد الموظفين في هذه الدورة');
        }
        const activeCount = await prisma.trainingAssignment.count({
          where: { companyId: req.user!.companyId, courseId: id, status: { not: 'cancelled' } },
        });
        if (course.capacity != null && activeCount + employees.length > course.capacity) {
          throw new TrainingError(409, 'TRAINING_CAPACITY_EXCEEDED', 'عدد الموظفين يتجاوز سعة الدورة المتاحة');
        }
        const created = await prisma.$transaction(async (tx) => {
          await tx.trainingAssignment.createMany({
            data: employees.map((employee: any) => ({
              companyId: req.user!.companyId,
              courseId: id,
              employeeId: employee.id,
              employeeNameSnapshot: employee.user.name,
              employeeNumSnapshot: employee.employeeNum,
              departmentIdSnapshot: employee.departmentId ?? null,
              departmentNameSnapshot: employee.department?.name ?? null,
              status: 'assigned',
              progressPercent: 0,
              assignedByUserId: req.user!.id,
            })),
          });
          // One batched call rather than one per employee: `notify` now also reads
          // notification preferences, so a per-employee loop would issue two
          // queries per assignee instead of one for the whole fan-out.
          await notify(
            tx,
            req.user!.companyId,
            req.user!.id,
            (employees as any[]).map((employee) => employee.user.id),
            'دورة تدريبية جديدة',
            'تم إسناد دورة تدريبية جديدة إليك.'
          );
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'training.assignment.bulk_create',
            details: { courseId: id, assignmentCount: employees.length },
          });
          return tx.trainingAssignment.findMany({
            where: { companyId: req.user!.companyId, courseId: id, employeeId: { in: body.employeeIds } },
            include: assignmentInternalInclude,
            orderBy: { assignedAt: 'asc' },
          });
        });
        return res.status(201).json(created.map(assignmentShape));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.get(
    '/api/training/assignments',
    requireAuth,
    checkAnyPermission(...viewPermissions),
    async (req: TrainingRequest, res) => {
      try {
        const query = parse(assignmentListSchema, req.query);
        const range = validateRange(query.from, query.to);
        const scope = await resolveViewScope(prisma, req.user!, query.scope);
        ensureDepartmentFilter(scope, query.departmentId);
        if (query.employeeId && scope.kind === 'own' && query.employeeId !== scope.employeeId) {
          throw new TrainingError(403, 'TRAINING_EMPLOYEE_FORBIDDEN', 'الموظف المحدد خارج نطاقك');
        }
        const assignments = await prisma.trainingAssignment.findMany({
          where: {
            companyId: req.user!.companyId,
            ...(query.status ? { status: query.status } : {}),
            ...(query.courseId ? { courseId: query.courseId } : {}),
            ...(query.employeeId ? { employeeId: query.employeeId } : {}),
            ...(query.departmentId ? { departmentIdSnapshot: query.departmentId } : {}),
            ...(range.from && range.to ? { assignedAt: { gte: range.from, lte: new Date(range.to.getTime() + 86_399_999) } } : {}),
          },
          include: assignmentInternalInclude,
          orderBy: { assignedAt: 'desc' },
        });
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        const scoped = assignments.filter((assignment: any) =>
          assignmentVisible(assignment, scope, req.user!, primaryOwnerUserId)
        );
        return res.json(paginate(scoped.map(assignmentShape), query.page, query.pageSize));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.get(
    '/api/training/assignments/:id',
    requireAuth,
    checkAnyPermission(...viewPermissions),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const scope = await resolveViewScope(prisma, req.user!, req.query.scope as TrainingScope | undefined);
        const assignment = await findAssignment(prisma, req.user!, id);
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        if (!assignmentVisible(assignment, scope, req.user!, primaryOwnerUserId)) {
          throw new TrainingError(404, 'TRAINING_ASSIGNMENT_NOT_FOUND', 'تكليف التدريب غير موجود');
        }
        return res.json(assignmentShape(assignment));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.patch(
    '/api/training/assignments/:id/progress',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_VIEW_OWN),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const body = parse(progressSchema, req.body);
        const assignment = await findAssignment(prisma, req.user!, id);
        if (!req.user!.employeeId || assignment.employeeId !== req.user!.employeeId) {
          throw new TrainingError(404, 'TRAINING_ASSIGNMENT_NOT_FOUND', 'تكليف التدريب غير موجود');
        }
        if (!['assigned', 'in_progress', 'returned'].includes(assignment.status)) {
          throw new TrainingError(409, 'TRAINING_PROGRESS_IMMUTABLE', 'لا يمكن تعديل تقدم هذا التكليف من حالته الحالية');
        }
        const updated = await prisma.$transaction(async (tx) => {
          const row = await tx.trainingAssignment.update({
            where: { id },
            data: {
              progressPercent: body.progressPercent,
              status: 'in_progress',
              startedAt: assignment.startedAt ?? new Date(),
            },
            include: assignmentInternalInclude,
          });
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'training.assignment.progress',
            details: { assignmentId: id, courseId: assignment.courseId, status: 'in_progress' },
          });
          return row;
        });
        return res.json(assignmentShape(updated));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/training/assignments/:id/submit',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_VIEW_OWN),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const body = parse(submitSchema, req.body);
        const assignment = await findAssignment(prisma, req.user!, id);
        if (!req.user!.employeeId || assignment.employeeId !== req.user!.employeeId) {
          throw new TrainingError(404, 'TRAINING_ASSIGNMENT_NOT_FOUND', 'تكليف التدريب غير موجود');
        }
        if (!['assigned', 'in_progress', 'returned'].includes(assignment.status)) {
          throw new TrainingError(409, 'TRAINING_SUBMISSION_CONFLICT', 'لا يمكن تسليم هذا التكليف من حالته الحالية');
        }
        const updated = await prisma.$transaction(async (tx) => {
          const row = await tx.trainingAssignment.update({
            where: { id },
            data: {
              status: 'submitted',
              progressPercent: 100,
              startedAt: assignment.startedAt ?? new Date(),
              submittedAt: new Date(),
              completionNote: body.completionNote ?? null,
            },
            include: assignmentInternalInclude,
          });
          const reviewers = await reviewerUserIds(tx, row, req.user!.id);
          await notify(
            tx,
            req.user!.companyId,
            req.user!.id,
            reviewers,
            'إكمال تدريبي بانتظار المراجعة',
            'تم تسليم إكمال دورة تدريبية وأصبح جاهزاً للمراجعة.'
          );
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'training.assignment.submit',
            details: { assignmentId: id, courseId: assignment.courseId, status: 'submitted' },
          });
          return row;
        });
        return res.json(assignmentShape(updated));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/training/assignments/:id/review',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_REVIEW),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const body = parse(reviewSchema, req.body);
        const assignment = await findAssignment(prisma, req.user!, id);
        if (assignment.status !== 'submitted') {
          throw new TrainingError(409, 'TRAINING_REVIEW_CONFLICT', 'التكليف ليس بانتظار المراجعة');
        }
        if (req.user!.employeeId && assignment.employeeId === req.user!.employeeId) {
          throw new TrainingError(403, 'TRAINING_SELF_REVIEW_FORBIDDEN', 'لا يمكن للموظف مراجعة إكماله التدريبي بنفسه');
        }
        const accepted = body.action === 'accept';
        const updated = await prisma.$transaction(async (tx) => {
          const row = await tx.trainingAssignment.update({
            where: { id },
            data: {
              status: accepted ? 'completed' : 'returned',
              progressPercent: 100,
              completedAt: accepted ? new Date() : null,
              reviewedByUserId: req.user!.id,
              reviewedAt: new Date(),
              reviewNote: body.reviewNote ?? null,
              score: accepted ? (body.score ?? null) : null,
            },
            include: assignmentInternalInclude,
          });
          const employeeUserId = row.employee?.user?.id;
          await notify(
            tx,
            req.user!.companyId,
            req.user!.id,
            employeeUserId ? [employeeUserId] : [],
            accepted ? 'تم اعتماد إكمال التدريب' : 'تمت إعادة إكمال التدريب',
            accepted
              ? 'تم اعتماد إكمالك للدورة التدريبية.'
              : 'أعيد إكمال الدورة التدريبية إليك للمراجعة والتسليم مجدداً.'
          );
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: accepted ? 'training.assignment.accept' : 'training.assignment.return',
            details: {
              assignmentId: id,
              courseId: assignment.courseId,
              action: body.action,
              status: accepted ? 'completed' : 'returned',
            },
          });
          return row;
        });
        return res.json(assignmentShape(updated));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/training/assignments/:id/cancel',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_MANAGE),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const body = parse(cancellationSchema, req.body);
        const assignment = await findAssignment(prisma, req.user!, id);
        if (!mutableAssignmentStatuses.includes(assignment.status)) {
          throw new TrainingError(409, 'TRAINING_ASSIGNMENT_TERMINAL', 'لا يمكن إلغاء هذا التكليف من حالته الحالية');
        }
        const updated = await prisma.$transaction(async (tx) => {
          const row = await tx.trainingAssignment.update({
            where: { id },
            data: {
              status: 'cancelled',
              cancelledByUserId: req.user!.id,
              cancelledAt: new Date(),
              cancellationReason: body.cancellationReason,
            },
            include: assignmentInternalInclude,
          });
          const employeeUserId = row.employee?.user?.id;
          await notify(
            tx,
            req.user!.companyId,
            req.user!.id,
            employeeUserId ? [employeeUserId] : [],
            'تم إلغاء تكليف تدريبي',
            'تم إلغاء أحد تكليفاتك التدريبية.'
          );
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'training.assignment.cancel',
            details: { assignmentId: id, courseId: assignment.courseId, status: 'cancelled' },
          });
          return row;
        });
        return res.json(assignmentShape(updated));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/training/courses/:id/complete',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_MANAGE),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const course = await findCourse(prisma, req.user!, id);
        if (course.status !== 'published') {
          throw new TrainingError(409, 'TRAINING_COURSE_COMPLETE_CONFLICT', 'لا يمكن إكمال الدورة من حالتها الحالية');
        }
        if ((course.assignments ?? []).length === 0) {
          throw new TrainingError(409, 'TRAINING_COURSE_ASSIGNMENTS_REQUIRED', 'لا يمكن إكمال دورة بلا تكليفات');
        }
        if ((course.assignments ?? []).some((assignment: any) =>
          assignment.status !== 'completed' && assignment.status !== 'cancelled'
        )) {
          throw new TrainingError(409, 'TRAINING_COURSE_ASSIGNMENTS_PENDING', 'توجد تكليفات غير مكتملة في الدورة');
        }
        const updated = await prisma.$transaction(async (tx) => {
          const row = await tx.trainingCourse.update({
            where: { id },
            data: { status: 'completed', completedByUserId: req.user!.id, completedAt: new Date() },
            include: courseInternalInclude,
          });
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'training.course.complete',
            details: { courseId: id, status: 'completed' },
          });
          return row;
        });
        return res.json(courseShape(updated, updated.assignments ?? [], req.user!.employeeId));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/training/courses/:id/cancel',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_MANAGE),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const body = parse(cancellationSchema, req.body);
        const course = await findCourse(prisma, req.user!, id);
        if (!['draft', 'published'].includes(course.status)) {
          throw new TrainingError(409, 'TRAINING_COURSE_CANCEL_CONFLICT', 'لا يمكن إلغاء الدورة من حالتها الحالية');
        }
        const affected = (course.assignments ?? []).filter((assignment: any) =>
          mutableAssignmentStatuses.includes(assignment.status)
        );
        const updated = await prisma.$transaction(async (tx) => {
          await tx.trainingAssignment.updateMany({
            where: {
              companyId: req.user!.companyId,
              courseId: id,
              status: { in: mutableAssignmentStatuses },
            },
            data: {
              status: 'cancelled',
              cancelledByUserId: req.user!.id,
              cancelledAt: new Date(),
              cancellationReason: body.cancellationReason,
            },
          });
          const row = await tx.trainingCourse.update({
            where: { id },
            data: {
              status: 'cancelled',
              cancelledByUserId: req.user!.id,
              cancelledAt: new Date(),
              cancellationReason: body.cancellationReason,
            },
            include: courseInternalInclude,
          });
          await notify(
            tx,
            req.user!.companyId,
            req.user!.id,
            affected.map((assignment: any) => assignment.employee?.user?.id).filter(Boolean),
            'تم إلغاء دورة تدريبية',
            'تم إلغاء دورة تدريبية مسندة إليك.'
          );
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'training.course.cancel',
            details: { courseId: id, affectedAssignmentCount: affected.length, status: 'cancelled' },
          });
          return row;
        });
        return res.json(courseShape(updated, updated.assignments ?? [], req.user!.employeeId));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    '/api/training/courses/:id/archive',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_MANAGE),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const course = await findCourse(prisma, req.user!, id);
        if (!['completed', 'cancelled'].includes(course.status)) {
          throw new TrainingError(409, 'TRAINING_COURSE_ARCHIVE_CONFLICT', 'يمكن أرشفة الدورات المكتملة أو الملغاة فقط');
        }
        const updated = await prisma.$transaction(async (tx) => {
          const row = await tx.trainingCourse.update({
            where: { id },
            data: { status: 'archived', archivedByUserId: req.user!.id, archivedAt: new Date() },
            include: courseInternalInclude,
          });
          await writeAuditRequired(tx, {
            companyId: req.user!.companyId,
            userId: req.user!.id,
            action: 'training.course.archive',
            details: { courseId: id, status: 'archived' },
          });
          return row;
        });
        return res.json(courseShape(updated, updated.assignments ?? [], req.user!.employeeId));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.get(
    '/api/training/courses/:id/timeline',
    requireAuth,
    checkAnyPermission(...viewPermissions),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const scope = await resolveViewScope(prisma, req.user!, req.query.scope as TrainingScope | undefined);
        const course = await findCourse(prisma, req.user!, id);
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        const visible = visibleCourseAssignments(
          course,
          scope,
          req.user!,
          true,
          primaryOwnerUserId,
        );
        if (scope.kind !== 'company' && visible.length === 0) {
          throw new TrainingError(404, 'TRAINING_COURSE_NOT_FOUND', 'الدورة التدريبية غير موجودة');
        }
        return res.json(buildCourseTimeline(course, visible));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.get(
    '/api/training/report',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_REPORT),
    async (req: TrainingRequest, res) => {
      try {
        const result = await buildTrainingReport(prisma, req.user!, req.query);
        await writeAuditRequired(prisma, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          action: 'training.report.read',
          details: {
            scope: result.audit.scope,
            filters: result.audit.filters,
          },
        });
        return res.json(result.report);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  /**
   * P4 — issue the internal completion certificate for a completed assignment.
   *
   * Idempotent by construction: a unique index on (assignmentId, companyId) means
   * a duplicate issue can only ever produce one row. An exact retry replays the
   * existing certificate with 200 rather than erroring, and — critically — the
   * replay lookup runs on a FRESH connection after the failed transaction has
   * already aborted, never inside it (the PR #89 lesson: a query issued inside an
   * aborted PostgreSQL transaction fails with 25P02 instead of recovering).
   */
  app.post(
    '/api/training/assignments/:id/certificate',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_CERTIFICATE_ISSUE),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const assignment = await loadCompletedVisibleAssignment(prisma, req.user!, id);

        const existing = await prisma.trainingCertificate.findFirst({
          where: { assignmentId: id, companyId: req.user!.companyId },
          include: certificateInclude,
        });
        if (existing) return res.json(certificateShape(existing));

        let created;
        try {
          created = await prisma.$transaction(async (tx) => {
            const row = await tx.trainingCertificate.create({
              data: {
                companyId: req.user!.companyId,
                assignmentId: assignment.id,
                courseId: assignment.courseId,
                employeeId: assignment.employeeId,
                serialNumber: generateCertificateSerial(),
                // Frozen at issue time so a later rename cannot rewrite history.
                courseTitleSnapshot: assignment.course?.title ?? 'دورة تدريبية',
                employeeNameSnapshot: assignment.employeeNameSnapshot,
                employeeNumSnapshot: assignment.employeeNumSnapshot,
                completedAtSnapshot: assignment.completedAt ?? new Date(),
                issuedByUserId: req.user!.id,
              },
              include: certificateInclude,
            });
            await writeAuditRequired(tx, {
              companyId: req.user!.companyId,
              userId: req.user!.id,
              action: 'training.certificate.issue',
              details: {
                assignmentId: assignment.id,
                courseId: assignment.courseId,
                certificateId: row.id,
              },
            });
            await notify(
              tx,
              req.user!.companyId,
              req.user!.id,
              assignment.employee?.user?.id ? [assignment.employee.user.id] : [],
              'تم إصدار شهادة تدريب',
              'تم إصدار شهادة إكمال دورة تدريبية لك.',
              assignment.id
            );
            return row;
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            // Fresh context — the transaction above is already rolled back.
            const replay = await prisma.trainingCertificate.findFirst({
              where: { assignmentId: id, companyId: req.user!.companyId },
              include: certificateInclude,
            });
            if (replay) return res.json(certificateShape(replay));
          }
          throw error;
        }
        return res.status(201).json(certificateShape(created));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  /** Readable under the ordinary training view scope — an employee may read their own. */
  app.get(
    '/api/training/assignments/:id/certificate',
    requireAuth,
    checkAnyPermission(...viewPermissions),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const assignment = await findAssignment(prisma, req.user!, id);
        const scope = await resolveViewScope(prisma, req.user!);
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        if (!assignmentVisible(assignment, scope, req.user!, primaryOwnerUserId)) {
          throw new TrainingError(404, 'TRAINING_ASSIGNMENT_NOT_FOUND', 'تكليف التدريب غير موجود');
        }
        const certificate = await prisma.trainingCertificate.findFirst({
          where: { assignmentId: id, companyId: req.user!.companyId },
          include: certificateInclude,
        });
        if (!certificate) {
          throw new TrainingError(404, 'TRAINING_CERTIFICATE_NOT_FOUND', 'لا توجد شهادة لهذا التكليف');
        }
        return res.json(certificateShape(certificate));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  /**
   * P4 — reviewer evaluation of a completed assignment.
   *
   * Unlike the certificate this is NOT idempotent-replayable: a second, different
   * judgment on the same assignment is a genuine conflict, so it returns 409
   * rather than silently overwriting or replaying.
   */
  app.post(
    '/api/training/assignments/:id/evaluation',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_EVALUATION_CREATE),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const body = parse(evaluationCreateSchema, req.body);
        const assignment = await loadCompletedVisibleAssignment(prisma, req.user!, id);
        if (req.user!.employeeId && assignment.employeeId === req.user!.employeeId) {
          throw new TrainingError(
            403,
            'TRAINING_SELF_EVALUATION_FORBIDDEN',
            'لا يمكن للموظف تقييم إكماله التدريبي بنفسه'
          );
        }

        let created;
        try {
          created = await prisma.$transaction(async (tx) => {
            const row = await tx.trainingEvaluation.create({
              data: {
                companyId: req.user!.companyId,
                assignmentId: assignment.id,
                courseId: assignment.courseId,
                employeeId: assignment.employeeId,
                effectivenessScore: body.effectivenessScore,
                knowledgeScore: body.knowledgeScore,
                applicationScore: body.applicationScore,
                recommendation: body.recommendation,
                comment: body.comment ?? null,
                evaluatedByUserId: req.user!.id,
              },
              include: evaluationInclude,
            });
            await writeAuditRequired(tx, {
              companyId: req.user!.companyId,
              userId: req.user!.id,
              action: 'training.evaluation.create',
              // Scores and the comment are deliberately absent: `score` and
              // `comment` are forbidden audit keys, and an evaluation is a
              // performance judgment that must not be readable from the log.
              details: {
                assignmentId: assignment.id,
                courseId: assignment.courseId,
                evaluationId: row.id,
              },
            });
            return row;
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new TrainingError(
              409,
              'TRAINING_EVALUATION_EXISTS',
              'يوجد تقييم مسجل لهذا التكليف بالفعل'
            );
          }
          throw error;
        }
        // No notification: the subject cannot read this record, so telling them it
        // exists would be noise they can act on in no way.
        return res.status(201).json(evaluationShape(created));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  /**
   * Reading an evaluation needs `training.evaluation.view` — the ordinary
   * training view scope is deliberately not enough, because this is a
   * performance-adjacent judgment rather than course metadata.
   */
  app.get(
    '/api/training/assignments/:id/evaluation',
    requireAuth,
    checkAnyPermission(PERMISSIONS.TRAINING_EVALUATION_VIEW),
    async (req: TrainingRequest, res) => {
      try {
        const id = parse(z.string().uuid(), req.params.id);
        const assignment = await findAssignment(prisma, req.user!, id);
        const scope = await resolveViewScope(prisma, req.user!);
        const primaryOwnerUserId = await loadPrimaryOwnerUserId(prisma, req.user!.companyId);
        if (!assignmentVisible(assignment, scope, req.user!, primaryOwnerUserId)) {
          throw new TrainingError(404, 'TRAINING_ASSIGNMENT_NOT_FOUND', 'تكليف التدريب غير موجود');
        }
        const evaluation = await prisma.trainingEvaluation.findFirst({
          where: { assignmentId: id, companyId: req.user!.companyId },
          include: evaluationInclude,
        });
        if (!evaluation) {
          throw new TrainingError(404, 'TRAINING_EVALUATION_NOT_FOUND', 'لا يوجد تقييم لهذا التكليف');
        }
        return res.json(evaluationShape(evaluation));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.delete('/api/training/courses/:id', requireAuth, (_req, res) => deleteNotAllowed(res));
  app.delete('/api/training/resources/:id', requireAuth, (_req, res) => deleteNotAllowed(res));
  app.delete('/api/training/courses/:courseId/resources/:id', requireAuth, (_req, res) => deleteNotAllowed(res));
  app.delete('/api/training/assignments/:id', requireAuth, (_req, res) => deleteNotAllowed(res));
}
