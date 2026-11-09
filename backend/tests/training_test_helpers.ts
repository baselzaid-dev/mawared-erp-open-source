import { vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { makeFakePrisma } from './helpers';

const matches = (value: unknown, condition: any): boolean => {
  if (condition === undefined) return true;
  if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
    if (condition.in && !condition.in.includes(value)) return false;
    if (condition.not !== undefined && value === condition.not) return false;
    if (condition.gte && new Date(value as any) < condition.gte) return false;
    if (condition.lte && new Date(value as any) > condition.lte) return false;
    return true;
  }
  return value === condition;
};

export function makeTrainingPrisma() {
  const prisma = makeFakePrisma() as any;
  const departments: any[] = [];
  const users: any[] = [];
  const employees: any[] = prisma._store.employees;
  const courses: any[] = [];
  const resources: any[] = [];
  const assignments: any[] = [];

  const hydrateUser = (user: any) => user ? {
    ...user,
    role: {
      name: user.roleName ?? 'Employee',
      permissions: JSON.stringify(user.permissions ?? []),
    },
  } : null;
  const hydrateEmployee = (employee: any) => employee ? {
    ...employee,
    user: hydrateUser(users.find((user) => user.employeeId === employee.id)),
    department: departments.find((department) => department.id === employee.departmentId) ?? null,
  } : null;
  const shallowCourse = (course: any) => course ? {
    ...course,
    resources: resources
      .filter((resource) => resource.courseId === course.id)
      .sort((left, right) => left.sortOrder - right.sortOrder),
  } : null;
  const hydrateAssignment = (assignment: any) => assignment ? {
    ...assignment,
    course: shallowCourse(courses.find((course) => course.id === assignment.courseId)),
    employee: hydrateEmployee(employees.find((employee: any) => employee.id === assignment.employeeId)),
  } : null;
  const hydrateCourse = (course: any) => course ? {
    ...shallowCourse(course),
    assignments: assignments
      .filter((assignment) => assignment.courseId === course.id)
      .map((assignment) => ({
        ...assignment,
        employee: hydrateEmployee(employees.find((employee: any) => employee.id === assignment.employeeId)),
      })),
  } : null;

  const courseMatches = (row: any, where: any = {}) =>
    matches(row.id, where.id)
    && matches(row.companyId, where.companyId)
    && matches(row.status, where.status)
    && matches(row.category, where.category)
    && matches(row.startDate, where.startDate);
  const assignmentMatches = (row: any, where: any = {}) =>
    matches(row.id, where.id)
    && matches(row.companyId, where.companyId)
    && matches(row.courseId, where.courseId)
    && matches(row.employeeId, where.employeeId)
    && matches(row.departmentIdSnapshot, where.departmentIdSnapshot)
    && matches(row.status, where.status)
    && matches(row.assignedAt, where.assignedAt);

  prisma.department.findMany = vi.fn(async ({ where }: any) => departments.filter((row) =>
    matches(row.companyId, where.companyId) && matches(row.managerId, where.managerId)
  ));
  prisma.user.findMany = vi.fn(async ({ where }: any) => users
    .filter((row) => matches(row.companyId, where.companyId))
    .map(hydrateUser));
  prisma.employee.findMany = vi.fn(async ({ where }: any = {}) => employees
    .filter((row: any) =>
      matches(row.id, where?.id)
      && matches(row.companyId, where?.companyId)
      && matches(row.status, where?.status)
      && matches(row.departmentId, where?.departmentId)
    )
    .map(hydrateEmployee));

  prisma.trainingCourse = {
    create: vi.fn(async ({ data }: any) => {
      const now = new Date('2026-07-11T08:00:00.000Z');
      const nested = data.resources?.create ?? [];
      const { resources: _nestedResources, ...courseData } = data;
      const row = {
        id: `10000000-0000-4000-8000-${String(courses.length + 1).padStart(12, '0')}`,
        publishedByUserId: null,
        publishedAt: null,
        completedByUserId: null,
        completedAt: null,
        cancelledByUserId: null,
        cancelledAt: null,
        cancellationReason: null,
        archivedByUserId: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        ...courseData,
      };
      courses.push(row);
      for (const item of nested) {
        resources.push({
          id: `20000000-0000-4000-8000-${String(resources.length + 1).padStart(12, '0')}`,
          courseId: row.id,
          createdAt: now,
          updatedAt: now,
          ...item,
        });
      }
      return hydrateCourse(row);
    }),
    findFirst: vi.fn(async ({ where }: any) => hydrateCourse(courses.find((row) => courseMatches(row, where)))),
    findMany: vi.fn(async ({ where }: any = {}) => courses.filter((row) => courseMatches(row, where)).map(hydrateCourse)),
    update: vi.fn(async ({ where, data }: any) => {
      const row = courses.find((course) => course.id === where.id);
      if (!row) return null;
      Object.assign(row, data, { updatedAt: new Date('2026-07-11T09:00:00.000Z') });
      return hydrateCourse(row);
    }),
  };

  prisma.trainingResource = {
    deleteMany: vi.fn(async ({ where }: any) => {
      let count = 0;
      for (let index = resources.length - 1; index >= 0; index -= 1) {
        if (matches(resources[index].companyId, where.companyId) && matches(resources[index].courseId, where.courseId)) {
          resources.splice(index, 1);
          count += 1;
        }
      }
      return { count };
    }),
    createMany: vi.fn(async ({ data }: any) => {
      const now = new Date('2026-07-11T09:00:00.000Z');
      for (const item of data) {
        resources.push({
          id: `20000000-0000-4000-8000-${String(resources.length + 1).padStart(12, '0')}`,
          createdAt: now,
          updatedAt: now,
          ...item,
        });
      }
      return { count: data.length };
    }),
  };

  prisma.trainingAssignment = {
    createMany: vi.fn(async ({ data }: any) => {
      const now = new Date('2026-07-11T10:00:00.000Z');
      for (const item of data) {
        assignments.push({
          id: `30000000-0000-4000-8000-${String(assignments.length + 1).padStart(12, '0')}`,
          assignedAt: now,
          startedAt: null,
          submittedAt: null,
          completionNote: null,
          completedAt: null,
          reviewedByUserId: null,
          reviewedAt: null,
          reviewNote: null,
          score: null,
          cancelledByUserId: null,
          cancelledAt: null,
          cancellationReason: null,
          createdAt: now,
          updatedAt: now,
          ...item,
        });
      }
      return { count: data.length };
    }),
    findFirst: vi.fn(async ({ where }: any) => hydrateAssignment(assignments.find((row) => assignmentMatches(row, where)))),
    findMany: vi.fn(async ({ where }: any = {}) => assignments.filter((row) => assignmentMatches(row, where)).map(hydrateAssignment)),
    count: vi.fn(async ({ where }: any = {}) => assignments.filter((row) => assignmentMatches(row, where)).length),
    update: vi.fn(async ({ where, data }: any) => {
      const row = assignments.find((assignment) => assignment.id === where.id);
      if (!row) return null;
      Object.assign(row, data, { updatedAt: new Date('2026-07-11T11:00:00.000Z') });
      return hydrateAssignment(row);
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const row of assignments) {
        if (assignmentMatches(row, where)) {
          Object.assign(row, data, { updatedAt: new Date('2026-07-11T11:00:00.000Z') });
          count += 1;
        }
      }
      return { count };
    }),
  };

  /**
   * P4 completion artifacts. Both enforce one row per assignment the same way
   * the migration's unique index does, and both raise a Prisma-shaped P2002 so
   * the routes' real unique-violation handling is exercised rather than mocked
   * away — that is the difference between testing replay/conflict semantics and
   * assuming them.
   */
  const uniqueViolation = () =>
    Object.assign(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    }));

  const artifactDelegate = (rows: any[], prefix: string, actorField: string) => ({
    create: vi.fn(async ({ data }: any) => {
      if (rows.some((row) => row.assignmentId === data.assignmentId && row.companyId === data.companyId)) {
        throw uniqueViolation();
      }
      const row = {
        id: `${prefix}-${rows.length + 1}`,
        createdAt: new Date('2026-08-09T12:00:00.000Z'),
        updatedAt: new Date('2026-08-09T12:00:00.000Z'),
        ...data,
        [actorField]: { id: data[`${actorField}UserId`], name: `User ${data[`${actorField}UserId`]}` },
      };
      rows.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: any = {}) =>
      rows.find(
        (row) =>
          (where?.id === undefined || row.id === where.id) &&
          (where?.companyId === undefined || row.companyId === where.companyId) &&
          (where?.assignmentId === undefined || row.assignmentId === where.assignmentId),
      ) ?? null,
    ),
    findMany: vi.fn(async ({ where }: any = {}) =>
      rows.filter(
        (row) =>
          (where?.companyId === undefined || row.companyId === where.companyId) &&
          (where?.assignmentId === undefined || row.assignmentId === where.assignmentId),
      ),
    ),
  });

  const certificates: any[] = [];
  const evaluations: any[] = [];
  prisma.trainingCertificate = artifactDelegate(certificates, 'certificate', 'issuedBy');
  prisma.trainingEvaluation = artifactDelegate(evaluations, 'evaluation', 'evaluatedBy');

  prisma.$transaction = vi.fn(async (operation: any) => {
    const snapshots = {
      courses: courses.map((row) => ({ ...row })),
      resources: resources.map((row) => ({ ...row })),
      assignments: assignments.map((row) => ({ ...row })),
      certificates: certificates.map((row) => ({ ...row })),
      evaluations: evaluations.map((row) => ({ ...row })),
      notifications: prisma._store.notifications.map((row: any) => ({ ...row })),
      auditLogs: prisma._store.auditLogs.map((row: any) => ({ ...row })),
    };
    try {
      return await operation(prisma);
    } catch (error) {
      courses.splice(0, courses.length, ...snapshots.courses);
      resources.splice(0, resources.length, ...snapshots.resources);
      assignments.splice(0, assignments.length, ...snapshots.assignments);
      certificates.splice(0, certificates.length, ...snapshots.certificates);
      evaluations.splice(0, evaluations.length, ...snapshots.evaluations);
      prisma._store.notifications.splice(0, prisma._store.notifications.length, ...snapshots.notifications);
      prisma._store.auditLogs.splice(0, prisma._store.auditLogs.length, ...snapshots.auditLogs);
      throw error;
    }
  });

  prisma._training = {
    departments,
    users,
    employees,
    courses,
    resources,
    assignments,
    certificates,
    evaluations,
    hydrateCourse,
    hydrateAssignment,
  };
  return prisma;
}

export function addTrainingIdentity(prisma: any, input: {
  userId: string;
  employeeId?: string | null;
  companyId?: string;
  departmentId?: string | null;
  managerId?: string | null;
  permissions?: string[];
  roleName?: string;
  name?: string;
  status?: string;
}) {
  const companyId = input.companyId ?? 'c1';
  const employeeId = input.employeeId === undefined ? `${input.userId}-employee` : input.employeeId;
  if (input.departmentId && !prisma._training.departments.some((row: any) => row.id === input.departmentId)) {
    prisma._training.departments.push({
      id: input.departmentId,
      companyId,
      name: `Department ${input.departmentId}`,
      managerId: input.managerId ?? null,
    });
  } else if (input.departmentId && input.managerId !== undefined) {
    const department = prisma._training.departments.find((row: any) => row.id === input.departmentId);
    if (department) department.managerId = input.managerId;
  }
  if (employeeId) {
    prisma._training.employees.push({
      id: employeeId,
      companyId,
      employeeNum: `EMP-${employeeId.slice(-4)}`,
      status: input.status ?? 'active',
      departmentId: input.departmentId ?? null,
    });
  }
  prisma._training.users.push({
    id: input.userId,
    companyId,
    employeeId,
    name: input.name ?? `User ${input.userId}`,
    permissions: input.permissions ?? [],
    roleName: input.roleName ?? 'Employee',
  });
}

export const UUIDS = {
  course1: '10000000-0000-4000-8000-000000000001',
  course2: '10000000-0000-4000-8000-000000000002',
  employee1: '40000000-0000-4000-8000-000000000001',
  employee2: '40000000-0000-4000-8000-000000000002',
  employee3: '40000000-0000-4000-8000-000000000003',
  department1: '50000000-0000-4000-8000-000000000001',
  department2: '50000000-0000-4000-8000-000000000002',
};
