import { z } from 'zod';
import type express from 'express';

/**
 * Systematic request-body validation (zod).
 * Error responses follow the documented API error format:
 * { error: "ValidationError", message, details: [{field, message}], code: 400 }
 */

export const loginSchema = z.strictObject({
  // Legacy field name is retained for RC1 clients, but resolution now uses the
  // shared email-or-Employee-number identity lookup.
  email: z.string().trim().min(1, 'معرّف الدخول مطلوب').max(320),
  password: z.string().min(1, 'كلمة المرور مطلوبة').max(256),
});

export const companyLoginSchema = z.strictObject({
  companyCode: z.string().min(1).max(64),
  identifier: z.string().min(1).max(320),
  password: z.string().min(1, 'كلمة المرور مطلوبة').max(256),
  deviceLabel: z.string().trim().min(1).max(120).optional(),
  platform: z.string().trim().min(1).max(32).regex(/^[a-z0-9_-]+$/).optional(),
});

export const refreshSchema = z.strictObject({
  refreshToken: z.string().min(20, 'رمز التحديث غير صالح').max(512),
});

export const logoutSchema = z.strictObject({
  refreshToken: z.string().min(20).max(512).optional(),
});

export const createEmployeeSchema = z.strictObject({
  email: z.string().trim().email('البريد الإلكتروني غير صالح').max(320),
  password: z.string().min(8, 'كلمة المرور يجب أن تكون 8 أحرف على الأقل').max(256),
  name: z.string().trim().min(1, 'الاسم مطلوب').max(200),
  roleId: z.string().min(1, 'الدور الوظيفي مطلوب'),
  employeeNum: z.string().trim().min(1, 'الرقم الوظيفي مطلوب').max(100),
  jobTitle: z.string().trim().min(1, 'المسمى الوظيفي مطلوب').max(200),
  joiningDate: z
    .string()
    .min(1, 'تاريخ الالتحاق مطلوب')
    .refine((v) => !Number.isNaN(Date.parse(v)), 'صيغة التاريخ غير صحيحة'),
  departmentId: z.string().min(1).nullish(),
});

const isoEmployeeDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ يجب أن تكون yyyy-MM-dd')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day;
  }, 'التاريخ غير صالح');

export const updateEmployeeSchema = z.strictObject({
  name: z.string().trim().min(1, 'اسم الموظف مطلوب').max(200),
  email: z.string().trim().email('البريد الإلكتروني غير صالح').max(320),
  employeeNum: z.string().trim().min(1, 'الرقم الوظيفي مطلوب').max(100),
  jobTitle: z.string().trim().min(1, 'المسمى الوظيفي مطلوب').max(200),
  joiningDate: isoEmployeeDate,
  departmentId: z.string().trim().min(1, 'معرّف القسم غير صالح').max(100).nullable(),
  roleId: z.string().trim().min(1, 'الدور الوظيفي مطلوب').max(100),
});

const salaryAmount = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/, 'الراتب يجب أن يكون رقماً موجباً وبحد أقصى منزلتين عشريتين')
  .refine((value) => Number(value) <= 10_000_000, 'الراتب يتجاوز الحد المسموح');

export const createSalaryRecordSchema = z.strictObject({
  baseSalary: salaryAmount,
  currency: z.string().refine((value) => value === 'SAR', 'العملة المدعومة هي SAR فقط'),
  effectiveFrom: isoEmployeeDate,
});

export const createDepartmentSchema = z.strictObject({
  name: z.string().trim().min(1, 'اسم القسم مطلوب').max(200),
  managerId: z.string().trim().min(1, 'معرّف مدير القسم غير صالح').max(100).nullable().optional(),
});

export const updateDepartmentSchema = z.strictObject({
  name: z.string().trim().min(1, 'اسم القسم مطلوب').max(200).optional(),
  managerId: z.string().trim().min(1, 'معرّف مدير القسم غير صالح').max(100).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'يجب إرسال حقل واحد على الأقل للتحديث',
});

export const createLeaveSchema = z.strictObject({
  leaveType: z.string().trim().min(1, 'نوع الإجازة مطلوب').max(50),
  startDate: z
    .string()
    .min(1, 'تاريخ البداية مطلوب')
    .refine((v) => !Number.isNaN(Date.parse(v)), 'صيغة التاريخ غير صحيحة'),
  endDate: z
    .string()
    .min(1, 'تاريخ النهاية مطلوب')
    .refine((v) => !Number.isNaN(Date.parse(v)), 'صيغة التاريخ غير صحيحة'),
  reason: z.string().max(2000).nullish(),
  exitReentryRequested: z.boolean().optional().default(false),
  visaFeePaid: z.boolean().optional().default(false),
});

export const rejectReasonSchema = z.strictObject({
  reason: z.string().trim().min(1, 'سبب الرفض مطلوب').max(2000),
});

const isoLeaveDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ يجب أن تكون yyyy-MM-dd')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day;
  }, 'التاريخ غير صالح');

const leaveStatusFilter = z.enum(
  ['pending_hr', 'pending_admin', 'approved', 'rejected', 'cancelled'],
  { error: 'حالة الإجازة غير صالحة' }
);

const leaveTypeFilter = z.enum(
  ['annual', 'سنوية', 'sick', 'مرضية', 'special', 'طارئة', 'unpaid', 'بدون راتب', 'study', 'دراسية'],
  { error: 'نوع الإجازة غير صالح' }
);

const validateLeaveDateRange = (
  value: { from?: string; to?: string; employeeId?: string },
  ctx: z.RefinementCtx,
  required: boolean
) => {
  if (value.employeeId !== undefined && !required) {
    ctx.addIssue({
      code: 'custom',
      path: ['employeeId'],
      message: 'لا يمكن تصفية طلباتك بمعرّف موظف آخر',
    });
  }
  if (!value.from && !value.to && !required) return;
  if (!value.from || !value.to) {
    ctx.addIssue({
      code: 'custom',
      path: [value.from ? 'to' : 'from'],
      message: 'يجب تحديد تاريخي البداية والنهاية معاً',
    });
    return;
  }
  const fromMs = Date.parse(`${value.from}T00:00:00.000Z`);
  const toMs = Date.parse(`${value.to}T00:00:00.000Z`);
  if (fromMs > toMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['from'],
      message: 'تاريخ البداية يجب ألا يكون بعد تاريخ النهاية',
    });
    return;
  }
  const inclusiveDays = Math.floor((toMs - fromMs) / 86_400_000) + 1;
  if (inclusiveDays > 366) {
    ctx.addIssue({
      code: 'custom',
      path: ['to'],
      message: 'نطاق التاريخ يجب ألا يتجاوز 366 يوماً',
    });
  }
};

export const myLeaveFiltersSchema = z.strictObject({
  from: isoLeaveDate.optional(),
  to: isoLeaveDate.optional(),
  status: leaveStatusFilter.optional(),
  leaveType: leaveTypeFilter.optional(),
  employeeId: z.string().optional(),
}).superRefine((value, ctx) => validateLeaveDateRange(value, ctx, false));

export const leaveReportFiltersSchema = z.strictObject({
  from: isoLeaveDate,
  to: isoLeaveDate,
  status: leaveStatusFilter.optional(),
  leaveType: leaveTypeFilter.optional(),
  employeeId: z.string().trim().min(1, 'معرّف الموظف غير صالح').max(100).optional(),
}).superRefine((value, ctx) => validateLeaveDateRange(value, ctx, true));

export const aiChatSchema = z.strictObject({
  message: z.string().trim().min(1, 'الرسالة مطلوبة').max(8000, 'الرسالة طويلة جداً'),
});

/**
 * Parses req.body with the given schema. On failure it writes the standard
 * 400 ValidationError response and returns null — callers just `return` then.
 */
export function validateBody<S extends z.ZodType>(
  schema: S,
  req: express.Request,
  res: express.Response
): z.output<S> | null {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const messageFor = (issue: { code: string; message: string }) =>
      issue.code === 'unrecognized_keys'
        ? 'يتضمن الطلب حقولاً غير مسموح بتعديلها'
        : issue.message;
    res.status(400).json({
      error: 'ValidationError',
      message: parsed.error.issues[0] ? messageFor(parsed.error.issues[0]) : 'بيانات الطلب غير صحيحة',
      details: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: messageFor(i),
      })),
      code: 400,
    });
    return null;
  }
  return parsed.data;
}

export function validateQuery<S extends z.ZodType>(
  schema: S,
  req: express.Request,
  res: express.Response
): z.output<S> | null {
  const parsed = schema.safeParse(req.query ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: 'ValidationError',
      message: parsed.error.issues[0]?.message ?? 'معايير البحث غير صحيحة',
      details: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
      code: 400,
    });
    return null;
  }
  return parsed.data;
}

export const vendorSchema = z.object({
  name: z.string().trim().min(1, 'اسم المورد مطلوب').max(200),
  contact: z.string().trim().max(500).nullish(),
});

export const payrollPeriodSchema = z.strictObject({
  month: z.number().int().min(1, 'الشهر بين 1 و12').max(12, 'الشهر بين 1 و12'),
  year: z.number().int().min(2020).max(2100),
});

export const payrollCalculationSchema = z.strictObject({
  recalculationReason: z.string().trim().min(1, 'سبب إعادة الاحتساب مطلوب').max(500).optional(),
});

export const payrollReportQuerySchema = z.strictObject({
  periodId: z.string().trim().min(1, 'معرّف فترة الرواتب مطلوب').max(100),
});

const isoTaskDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ يجب أن تكون yyyy-MM-dd')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day;
  }, 'التاريخ غير صالح');

const taskPriority = z.enum(['low', 'normal', 'high', 'urgent'], {
  error: 'أولوية المهمة غير صالحة',
});

export const createTaskSchema = z.strictObject({
  title: z.string().trim().min(1, 'عنوان المهمة مطلوب').max(200, 'عنوان المهمة طويل جداً'),
  description: z.string().trim().max(2000, 'وصف المهمة طويل جداً').nullable().optional(),
  priority: taskPriority.default('normal'),
  dueDate: isoTaskDate.nullable().optional(),
  employeeIds: z.array(
    z.string().trim().min(1, 'معرّف الموظف غير صالح').max(100)
  ).min(1, 'يجب اختيار موظف واحد على الأقل').max(100, 'عدد الموظفين يتجاوز الحد المسموح'),
}).superRefine((value, ctx) => {
  if (new Set(value.employeeIds).size !== value.employeeIds.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['employeeIds'],
      message: 'لا يمكن تكرار الموظف في المهمة نفسها',
    });
  }
  if (value.dueDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (value.dueDate < today) {
      ctx.addIssue({
        code: 'custom',
        path: ['dueDate'],
        message: 'تاريخ استحقاق المهمة لا يمكن أن يكون في الماضي',
      });
    }
  }
});

/**
 * P4 task edit. Every field is optional so a caller can change one attribute,
 * but `.strictObject` still rejects unknown keys, so a client cannot smuggle
 * `status`, `companyId` or `createdByUserId` through this route (overposting).
 * `expectedUpdatedAt` carries the optimistic-concurrency token.
 */
export const updateTaskSchema = z.strictObject({
  title: z.string().trim().min(1, 'عنوان المهمة مطلوب').max(200, 'عنوان المهمة طويل جداً').optional(),
  description: z.string().trim().max(2000, 'وصف المهمة طويل جداً').nullable().optional(),
  priority: taskPriority.optional(),
  dueDate: isoTaskDate.nullable().optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true, message: 'طابع التحديث غير صالح' }),
}).superRefine((value, ctx) => {
  const { expectedUpdatedAt: _token, ...changes } = value;
  if (Object.keys(changes).length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['title'],
      message: 'لم يتم تحديد أي حقل للتعديل',
    });
  }
  if (value.dueDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (value.dueDate < today) {
      ctx.addIssue({
        code: 'custom',
        path: ['dueDate'],
        message: 'تاريخ استحقاق المهمة لا يمكن أن يكون في الماضي',
      });
    }
  }
});

export const taskCommentCreateSchema = z.strictObject({
  body: z.string().trim().min(1, 'نص التعليق مطلوب').max(4000, 'نص التعليق طويل جداً'),
});

export const taskCommentListQuerySchema = z.strictObject({
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1, 'الحد الأدنى 1').max(100, 'الحد الأقصى 100').optional(),
});

export const taskProgressSchema = z.strictObject({
  status: z.enum(['in_progress', 'submitted'], { error: 'حالة تقدم المهمة غير صالحة' }),
  completionDetails: z.string().trim().max(4000, 'تفاصيل الإنجاز طويلة جداً').optional(),
}).superRefine((value, ctx) => {
  if (value.status === 'submitted' && !value.completionDetails) {
    ctx.addIssue({
      code: 'custom',
      path: ['completionDetails'],
      message: 'تفاصيل الإنجاز مطلوبة عند تسليم المهمة',
    });
  }
});

export const taskReviewSchema = z.strictObject({
  action: z.enum(['accept', 'return'], { error: 'إجراء المراجعة غير صالح' }),
  reviewNote: z.string().trim().max(2000, 'ملاحظة المراجعة طويلة جداً').optional(),
}).superRefine((value, ctx) => {
  if (value.action === 'return' && !value.reviewNote) {
    ctx.addIssue({
      code: 'custom',
      path: ['reviewNote'],
      message: 'سبب إعادة المهمة مطلوب',
    });
  }
});

const taskFilterStatus = z.enum(
  ['active', 'completed', 'cancelled', 'assigned', 'in_progress', 'submitted', 'accepted', 'returned'],
  { error: 'حالة المهمة غير صالحة' }
);

export const taskListQuerySchema = z.strictObject({
  scope: z.enum(['own', 'department', 'company'], { error: 'نطاق المهام غير صالح' }).optional(),
  status: taskFilterStatus.optional(),
  priority: taskPriority.optional(),
  from: isoTaskDate.optional(),
  to: isoTaskDate.optional(),
  employeeId: z.string().trim().min(1, 'معرّف الموظف غير صالح').max(100).optional(),
}).superRefine((value, ctx) => {
  if ((value.from && !value.to) || (!value.from && value.to)) {
    ctx.addIssue({
      code: 'custom',
      path: [value.from ? 'to' : 'from'],
      message: 'يجب تحديد تاريخي البداية والنهاية معاً',
    });
    return;
  }
  if (!value.from || !value.to) return;
  if (value.from > value.to) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: 'تاريخ البداية يجب ألا يكون بعد تاريخ النهاية' });
    return;
  }
  const days = Math.floor(
    (Date.parse(`${value.to}T00:00:00.000Z`) - Date.parse(`${value.from}T00:00:00.000Z`)) / 86_400_000
  ) + 1;
  if (days > 366) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'نطاق التاريخ يجب ألا يتجاوز 366 يوماً' });
  }
});

const isoAttendanceDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ يجب أن تكون yyyy-MM-dd')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day;
  }, 'التاريخ غير صالح');

const attendanceTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'صيغة الوقت يجب أن تكون HH:mm');

export const manualAttendanceSchema = z.strictObject({
  employeeId: z.string().trim().min(1, 'الموظف مطلوب').max(100),
  date: isoAttendanceDate,
  status: z.enum(['present', 'late', 'absent'], {
    error: 'حالة الحضور غير صالحة',
  }),
  clockIn: attendanceTime.nullish(),
  clockOut: attendanceTime.nullish(),
});

const chatIdentifier = z.string().trim().min(1, 'المعرّف غير صالح').max(100, 'المعرّف طويل جداً');

export const chatDirectoryQuerySchema = z.strictObject({
  query: z.string().trim().max(100, 'نص البحث طويل جداً').optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

export const chatDirectSchema = z.strictObject({
  userId: chatIdentifier,
});

export const chatConversationListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  offset: z.coerce.number().int().min(0).max(1000).default(0),
});

export const chatMessageListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  before: z.string().trim().min(1, 'مؤشر الرسائل غير صالح').max(500).optional(),
});

export const chatMessageSendSchema = z.strictObject({
  body: z.string().trim().min(1, 'لا يمكن إرسال رسالة فارغة').max(4000, 'الرسالة طويلة جداً'),
  replyToMessageId: z.string().uuid('معرّف الرسالة المرجعية غير صالح').optional(),
});

export const chatAnnouncementSchema = z.strictObject({
  title: z.string().trim().min(1, 'عنوان الإعلان مطلوب').max(120, 'عنوان الإعلان طويل جداً'),
  body: z.string().trim().min(1, 'لا يمكن إرسال رسالة فارغة').max(4000, 'الرسالة طويلة جداً').optional(),
});

export const chatPinMessageSchema = z.strictObject({
  messageId: chatIdentifier,
});
