import { vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { PrismaClient } from '@prisma/client';
import { createApp, type AiProvider, type AppConfig } from '../src/app';

/** Test-only signing secret — not a real credential. */
export const TEST_SECRET = 'unit-test-secret-not-real';

/**
 * In-memory fake of the Prisma surface used by the routes.
 * refreshToken / auditLog / notification / leaveApprovalHistory really store
 * rows (so flows like refresh-rotation are testable end-to-end); everything
 * else is a vi.fn() that individual tests configure.
 */
export function makeFakePrisma() {
  const refreshTokens: any[] = [];
  const auditLogs: any[] = [];
  const notifications: any[] = [];
  const notificationPreferences: any[] = [];
  const approvalHistory: any[] = [];
  const vendors: any[] = [];
  const employees: any[] = [];
  const payrollPeriods: any[] = [];
  const payrollItems: any[] = [];
  const salaryRecords: any[] = [];
  const chartOfAccounts: any[] = [];
  const costCenters: any[] = [];
  const journalEntries: any[] = [];
  const journalEntryLines: any[] = [];
  const payrollLedgerPostings: any[] = [];
  const payrollComponentDefinitions: any[] = [];
  const payrollItemComponentLines: any[] = [];
  const payrollItemAdjustments: any[] = [];
  const tasks: any[] = [];
  const taskAssignments: any[] = [];
  const taskComments: any[] = [];
  const loginIdentities: any[] = [];
  const userMfaCredentials: any[] = [];

  const hydratedAssignment = (assignment: any) => {
    const employee = assignment.employee ?? employees.find((row) => row.id === assignment.employeeId);
    const task = tasks.find((row) => row.id === assignment.taskId);
    return {
      ...assignment,
      employee,
      task: task ? {
        ...task,
        creator: task.creator ?? { id: task.createdByUserId, name: 'Creator' },
      } : null,
      reviewer: assignment.reviewedByUserId
        ? assignment.reviewer ?? { id: assignment.reviewedByUserId, name: 'Reviewer' }
        : null,
    };
  };

  const hydratedTask = (task: any) => ({
    ...task,
    creator: task.creator ?? { id: task.createdByUserId, name: 'Creator' },
    assignments: taskAssignments
      .filter((assignment) => assignment.taskId === task.id)
      .map(hydratedAssignment),
  });

  const hydratedComment = (comment: any) => ({
    ...comment,
    author: comment.author ?? { id: comment.authorUserId, name: 'Author' },
  });

  const prisma: any = {
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: any) => ({ id: 'user-new', ...data })),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn(async ({ where }: any = {}) =>
        where?.id !== undefined && where?.companyId !== undefined ? 1 : 0
      ),
    },
    role: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    department: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: any) => ({ id: 'dept-new', ...data })),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    companyOwnership: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: any) => ({ id: 'ownership-new', ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    ownershipTransfer: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: any) => ({ id: 'ownership-transfer-new', ...data })),
    },
    departmentManager: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: any) => ({ id: 'department-manager-new', assignedAt: new Date(), ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    accessGrant: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: any) => ({ id: 'access-grant-new', ...data })),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    temporaryDelegation: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(async ({ data }: any) => ({
        id: 'delegation-new',
        status: 'active',
        revokedAt: null,
        createdAt: new Date(),
        capabilities: data.capabilities?.create ?? [],
        ...data,
      })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    permissionChangeBatch: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: any) => ({ id: 'permission-batch-new', createdAt: new Date(), ...data })),
    },
    permissionChangeHistory: {
      create: vi.fn(async ({ data }: any) => ({ id: 'permission-history-new', ...data })),
    },
    employee: {
      findMany: vi.fn(async ({ where }: any = {}) =>
        employees.filter((employee) => {
          if (where?.companyId !== undefined && employee.companyId !== where.companyId) return false;
          if (where?.status !== undefined && employee.status !== where.status) return false;
          if (where?.joiningDate?.lte && new Date(employee.joiningDate) > where.joiningDate.lte) return false;
          if (typeof where?.id === 'string' && employee.id !== where.id) return false;
          if (where?.id?.in && !where.id.in.includes(employee.id)) return false;
          if (where?.departmentId?.in && !where.departmentId.in.includes(employee.departmentId)) return false;
          return true;
        })
      ),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: any) => ({ id: 'emp-new', ...data })),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      count: vi.fn().mockResolvedValue(0),
    },
    leaveRequest: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { totalDays: 0 } }),
      create: vi.fn(async ({ data }: any) => ({ id: 'LR-1', ...data })),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(0),
    },
    leaveApprovalHistory: {
      create: vi.fn(async ({ data }: any) => {
        approvalHistory.push(data);
        return data;
      }),
    },
    attendance: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: any) => ({ id: 'att-1', ...data })),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      count: vi.fn().mockResolvedValue(0),
    },
    notification: {
      create: vi.fn(async ({ data }: any) => {
        const now = new Date();
        const row = {
          id: `notif-${notifications.length + 1}`,
          isRead: false,
          readAt: null,
          hiddenAt: null,
          category: 'general',
          routeKey: null,
          resourceType: null,
          resourceId: null,
          filterJson: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        notifications.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where, orderBy, take }: any = {}) => {
        const matches = (row: any) => {
          if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where?.userId !== undefined && row.userId !== where.userId) return false;
          if (where?.category !== undefined && row.category !== where.category) return false;
          if (where?.isRead !== undefined && row.isRead !== where.isRead) return false;
          if (where?.hiddenAt === null && row.hiddenAt != null) return false;
          if (where?.hiddenAt?.not === null && row.hiddenAt == null) return false;
          if (where?.OR) {
            const cursorMatch = where.OR.some((clause: any) => {
              const createdAt = new Date(row.createdAt);
              if (clause.createdAt?.lt && createdAt >= clause.createdAt.lt) return false;
              if (clause.createdAt && clause.id?.lt) {
                const exact = new Date(clause.createdAt);
                if (createdAt.getTime() !== exact.getTime()) return false;
                if (!(row.id < clause.id.lt)) return false;
              }
              return true;
            });
            if (!cursorMatch) return false;
          }
          return true;
        };
        let rows = notifications.filter(matches);
        const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        const createdDirection = clauses.find((clause: any) => clause.createdAt)?.createdAt ?? 'desc';
        const idDirection = clauses.find((clause: any) => clause.id)?.id ?? 'desc';
        rows = rows.sort((left, right) => {
          const createdOrder = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
          if (createdOrder !== 0) return createdDirection === 'desc' ? -createdOrder : createdOrder;
          const idOrder = String(left.id).localeCompare(String(right.id));
          return idDirection === 'desc' ? -idOrder : idOrder;
        });
        return take === undefined ? rows : rows.slice(0, take);
      }),
      findFirst: vi.fn(async ({ where }: any) =>
        notifications.find((row) => {
          if (where.id !== undefined && row.id !== where.id) return false;
          if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where.userId !== undefined && row.userId !== where.userId) return false;
          return true;
        }) ?? null
      ),
      count: vi.fn(async ({ where }: any = {}) =>
        notifications.filter((row) => {
          if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where?.userId !== undefined && row.userId !== where.userId) return false;
          // The P4 unread-count endpoint filters by category; without this the
          // fake would silently over-count and hide a real regression.
          if (where?.category !== undefined && row.category !== where.category) return false;
          if (where?.isRead !== undefined && row.isRead !== where.isRead) return false;
          if (where?.hiddenAt === null && row.hiddenAt != null) return false;
          return true;
        }).length
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const row = notifications.find((item) => item.id === where.id);
        if (!row) return null;
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matching = notifications.filter((row) => {
          if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where.userId !== undefined && row.userId !== where.userId) return false;
          if (where.isRead !== undefined && row.isRead !== where.isRead) return false;
          if (where.hiddenAt === null && row.hiddenAt != null) return false;
          if (where.category !== undefined && row.category !== where.category) return false;
          return true;
        });
        matching.forEach((row) => Object.assign(row, data, { updatedAt: new Date() }));
        return { count: matching.length };
      }),
    },
    notificationPreference: {
      findMany: vi.fn(async ({ where }: any = {}) =>
        notificationPreferences.filter((row) => {
          if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
          // P4 producers query `userId: { in: [...] }` for a whole fan-out in one
          // round trip, so the fake has to understand `in` as well as equality.
          if (where?.userId !== undefined) {
            if (Array.isArray(where.userId?.in)) {
              if (!where.userId.in.includes(row.userId)) return false;
            } else if (row.userId !== where.userId) {
              return false;
            }
          }
          if (where?.category !== undefined && row.category !== where.category) return false;
          if (where?.inAppEnabled !== undefined && row.inAppEnabled !== where.inAppEnabled) {
            return false;
          }
          return true;
        })
      ),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.companyId_userId_category;
        const existing = notificationPreferences.find(
          (row) =>
            row.companyId === key.companyId &&
            row.userId === key.userId &&
            row.category === key.category,
        );
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const row = {
          id: `pref-${notificationPreferences.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        };
        notificationPreferences.push(row);
        return row;
      }),
    },
    refreshToken: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `rt-${refreshTokens.length + 1}`,
          revokedAt: null,
          createdAt: new Date(),
          ...data,
        };
        refreshTokens.push(row);
        return row;
      }),
      findUnique: vi.fn(
        async ({ where }: any) =>
          refreshTokens.find((r) => r.tokenHash === where.tokenHash) ?? null
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const row = refreshTokens.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matching = refreshTokens.filter((row) => {
          if (where.id !== undefined && row.id !== where.id) return false;
          if (where.userId !== undefined && row.userId !== where.userId) return false;
          if (where.revokedAt === null && row.revokedAt !== null) return false;
          if (where.expiresAt?.gt && row.expiresAt <= where.expiresAt.gt) return false;
          return true;
        });
        matching.forEach((row) => Object.assign(row, data));
        return { count: matching.length };
      }),
    },
    userMfaCredential: {
      findUnique: vi.fn(async ({ where }: any) =>
        userMfaCredentials.find((row) =>
          where.userId !== undefined
            ? row.userId === where.userId
            : row.challengeTokenHash === where.challengeTokenHash
        ) ?? null
      ),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = userMfaCredentials.find((row) => row.userId === where.userId);
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const row = {
          state: 'pending',
          pendingSecretCiphertext: null,
          secretCiphertext: null,
          challengeAttempts: 0,
          failedAttempts: 0,
          lockedUntil: null,
          backupCodeHashes: '[]',
          enrolledAt: null,
          lastVerifiedAt: null,
          lastUsedTimeStep: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        };
        userMfaCredentials.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = userMfaCredentials.find((item) => item.userId === where.userId);
        if (!row) throw new Error('UserMfaCredential not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `audit-${auditLogs.length + 1}`,
          createdAt: new Date(),
          user: { id: data.userId, name: 'Test User' },
          ...data,
        };
        auditLogs.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where, skip = 0, take }: any = {}) =>
        auditLogs
          .filter((row) => {
            if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
            if (where?.userId !== undefined && row.userId !== where.userId) return false;
            if (where?.action?.startsWith && !row.action.startsWith(where.action.startsWith)) return false;
            if (where?.createdAt?.gte && new Date(row.createdAt) < where.createdAt.gte) return false;
            if (where?.createdAt?.lt && new Date(row.createdAt) >= where.createdAt.lt) return false;
            return true;
          })
          .slice(skip, take === undefined ? undefined : skip + take)
      ),
      count: vi.fn(async ({ where }: any = {}) => auditLogs.filter((row) => {
        if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
        if (where?.userId !== undefined && row.userId !== where.userId) return false;
        if (where?.action?.startsWith && !row.action.startsWith(where.action.startsWith)) return false;
        if (where?.createdAt?.gte && new Date(row.createdAt) < where.createdAt.gte) return false;
        if (where?.createdAt?.lt && new Date(row.createdAt) >= where.createdAt.lt) return false;
        return true;
      }).length),
    },
    company: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    loginIdentity: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `identity-${loginIdentities.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        loginIdentities.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = loginIdentities.find((identity) => identity.id === where.id);
        if (row) Object.assign(row, data, { updatedAt: new Date() });
        return row ?? { id: where.id, ...data };
      }),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const key = where.companyId_userId_type;
        const row = loginIdentities.find((identity) =>
          identity.companyId === key.companyId &&
          identity.userId === key.userId &&
          identity.type === key.type
        );
        if (row) {
          Object.assign(row, update, { updatedAt: new Date() });
          return row;
        }
        const next = {
          id: `identity-${loginIdentities.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        };
        loginIdentities.push(next);
        return next;
      }),
    },
    vendor: {
      findMany: vi.fn(async ({ where, skip = 0, take }: any) =>
        vendors.filter((v) =>
          v.companyId === where.companyId &&
          (where.status === undefined || v.status === where.status)
        ).slice(skip, take === undefined ? undefined : skip + take)
      ),
      count: vi.fn(async ({ where }: any) => vendors.filter((v) =>
        v.companyId === where.companyId &&
        (where.status === undefined || v.status === where.status)
      ).length),
      findFirst: vi.fn(async ({ where }: any) => vendors.find((v) => {
        if (typeof where.id === 'string' && v.id !== where.id) return false;
        if (where.id && typeof where.id === 'object' && where.id.not !== undefined && v.id === where.id.not) return false;
        if (where.companyId !== undefined && v.companyId !== where.companyId) return false;
        if (where.status !== undefined && v.status !== where.status) return false;
        if (where.name?.equals !== undefined && v.name.trim().toLowerCase() !== where.name.equals.trim().toLowerCase()) return false;
        return true;
      }) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date();
        const row = { id: `v-${vendors.length + 1}`, status: 'active', createdAt: now, updatedAt: now, ...data };
        vendors.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = vendors.find((v) => v.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    payrollPeriod: {
      findMany: vi.fn(async ({ where }: any) =>
        payrollPeriods.filter((p) => p.companyId === where.companyId)
      ),
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.id !== undefined) {
          return (
            payrollPeriods.find((p) => p.id === where.id && p.companyId === where.companyId) ??
            null
          );
        }
        return (
          payrollPeriods.find(
            (p) =>
              p.companyId === where.companyId && p.month === where.month && p.year === where.year
          ) ?? null
        );
      }),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date();
        const row = {
          id: `pp-${payrollPeriods.length + 1}`,
          calculationVersion: 0,
          calculationFingerprint: null,
          calculatedByUserId: null,
          approvedByUserId: null,
          paidByUserId: null,
          calculatedAt: null,
          approvedAt: null,
          paidAt: null,
          reopenedByUserId: null,
          reopenedAt: null,
          reopenReason: null,
          ledgerPostedAt: null,
          ledgerPostingId: null,
          paymentVersion: 0,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        payrollPeriods.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = payrollPeriods.find((p) => p.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    payrollItem: {
      findMany: vi.fn(async ({ where }: any) =>
        payrollItems
          .filter((item) => {
            if (where.companyId !== undefined && item.companyId !== where.companyId) return false;
            if (where.payrollPeriodId !== undefined && item.payrollPeriodId !== where.payrollPeriodId) return false;
            if (where.payrollPeriodId?.in && !where.payrollPeriodId.in.includes(item.payrollPeriodId)) return false;
            return true;
          })
          .map((item) => ({
            ...item,
            employee: item.employee ?? employees.find((employee) => employee.id === item.employeeId) ?? null,
          }))
          .sort((left, right) =>
            String(left.employeeNameSnapshot).localeCompare(String(right.employeeNameSnapshot)) ||
            String(left.employeeNumSnapshot).localeCompare(String(right.employeeNumSnapshot))
          )
      ),
      createMany: vi.fn(async ({ data }: any) => {
        const rows = data.map((item: any, index: number) => ({
          id: `payroll-item-${payrollItems.length + index + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...item,
        }));
        payrollItems.push(...rows);
        return { count: rows.length };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        let count = 0;
        for (let index = payrollItems.length - 1; index >= 0; index -= 1) {
          const item = payrollItems[index];
          if (
            item.companyId === where.companyId &&
            item.payrollPeriodId === where.payrollPeriodId
          ) {
            payrollItems.splice(index, 1);
            count += 1;
          }
        }
        return { count };
      }),
      count: vi.fn(async ({ where }: any) =>
        payrollItems.filter((item) =>
          (where.companyId === undefined || item.companyId === where.companyId) &&
          (where.payrollPeriodId === undefined || item.payrollPeriodId === where.payrollPeriodId)
        ).length
      ),
      findFirst: vi.fn(async ({ where, include }: any = {}) => {
        const row = payrollItems.find((item) => {
          if (where.id !== undefined && item.id !== where.id) return false;
          if (where.companyId !== undefined && item.companyId !== where.companyId) return false;
          if (where.payrollPeriodId !== undefined && item.payrollPeriodId !== where.payrollPeriodId) {
            return false;
          }
          return true;
        });
        if (!row) return null;
        return {
          ...row,
          employee: include?.employee
            ? (row.employee ?? employees.find((employee) => employee.id === row.employeeId) ?? null)
            : row.employee,
        };
      }),
    },
    chartOfAccount: {
      findMany: vi.fn(async ({ where, orderBy }: any = {}) => {
        let rows = chartOfAccounts.filter((row) => {
          if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where?.status !== undefined && row.status !== where.status) return false;
          if (where?.parentId !== undefined && row.parentId !== where.parentId) return false;
          return true;
        });
        if (orderBy?.[0]?.code === 'asc' || orderBy?.code === 'asc') {
          rows = rows.slice().sort((a, b) => String(a.code).localeCompare(String(b.code)));
        }
        return rows;
      }),
      findFirst: vi.fn(async ({ where }: any) =>
        chartOfAccounts.find((row) => {
          if (where.id !== undefined && row.id !== where.id) return false;
          if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where.code !== undefined && row.code !== where.code) return false;
          if (where.status !== undefined && row.status !== where.status) return false;
          if (where.parentId !== undefined && row.parentId !== where.parentId) return false;
          return true;
        }) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date();
        const row = {
          id: data.id ?? `coa-${chartOfAccounts.length + 1}`,
          status: 'active',
          parentId: null,
          archivedAt: null,
          archivedByUserId: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        chartOfAccounts.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = chartOfAccounts.find((item) => item.id === where.id);
        if (!row) return null;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    },
    costCenter: {
      findMany: vi.fn(async ({ where, orderBy }: any = {}) => {
        let rows = costCenters.filter((row) =>
          where?.companyId === undefined || row.companyId === where.companyId
        );
        if (orderBy?.[0]?.code === 'asc' || orderBy?.code === 'asc') {
          rows = rows.slice().sort((a, b) => String(a.code).localeCompare(String(b.code)));
        }
        return rows;
      }),
      findFirst: vi.fn(async ({ where }: any) =>
        costCenters.find((row) => {
          if (where.id !== undefined && row.id !== where.id) return false;
          if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where.code !== undefined && row.code !== where.code) return false;
          if (where.status !== undefined && row.status !== where.status) return false;
          return true;
        }) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date();
        const row = {
          id: data.id ?? `cc-${costCenters.length + 1}`,
          status: 'active',
          description: null,
          archivedAt: null,
          archivedByUserId: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        costCenters.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = costCenters.find((item) => item.id === where.id);
        if (!row) return null;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    },
    journalEntry: {
      findMany: vi.fn(async ({ where, orderBy, take }: any = {}) => {
        let rows = journalEntries.filter((row) =>
          where?.companyId === undefined || row.companyId === where.companyId
        );
        if (orderBy) {
          rows = rows.slice().sort((a, b) =>
            new Date(b.entryDate).getTime() - new Date(a.entryDate).getTime()
          );
        }
        return take ? rows.slice(0, take) : rows;
      }),
      findFirst: vi.fn(async ({ where }: any) =>
        journalEntries.find((row) => {
          if (where.id !== undefined && row.id !== where.id) return false;
          if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where.idempotencyKey !== undefined && row.idempotencyKey !== where.idempotencyKey) {
            return false;
          }
          return true;
        }) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date();
        const row = {
          id: data.id ?? `je-${journalEntries.length + 1}`,
          status: 'draft',
          postedAt: null,
          postedByUserId: null,
          reversedAt: null,
          reversedByUserId: null,
          reversesJournalEntryId: null,
          idempotencyKey: null,
          sourceType: null,
          sourcePayrollPeriodId: null,
          sourceCalculationVersion: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        journalEntries.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = journalEntries.find((item) => item.id === where.id);
        if (!row) return null;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    },
    journalEntryLine: {
      findMany: vi.fn(async ({ where, orderBy }: any = {}) => {
        let rows = journalEntryLines.filter((row) => {
          if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where?.journalEntryId !== undefined && row.journalEntryId !== where.journalEntryId) {
            return false;
          }
          return true;
        });
        if (orderBy) {
          rows = rows.slice().sort((a, b) => a.lineNo - b.lineNo);
        }
        return rows;
      }),
      createMany: vi.fn(async ({ data }: any) => {
        const rows = data.map((item: any, index: number) => ({
          id: item.id ?? `jel-${journalEntryLines.length + index + 1}`,
          ...item,
        }));
        journalEntryLines.push(...rows);
        return { count: rows.length };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        let count = 0;
        for (let index = journalEntryLines.length - 1; index >= 0; index -= 1) {
          const row = journalEntryLines[index];
          if (
            (where.companyId === undefined || row.companyId === where.companyId)
            && (where.journalEntryId === undefined || row.journalEntryId === where.journalEntryId)
          ) {
            journalEntryLines.splice(index, 1);
            count += 1;
          }
        }
        return { count };
      }),
    },
    payrollLedgerPosting: {
      findFirst: vi.fn(async ({ where }: any) =>
        payrollLedgerPostings.find((row) => {
          if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where.idempotencyKey !== undefined && row.idempotencyKey !== where.idempotencyKey) {
            return false;
          }
          if (where.payrollPeriodId !== undefined && row.payrollPeriodId !== where.payrollPeriodId) {
            return false;
          }
          if (
            where.calculationVersion !== undefined
            && row.calculationVersion !== where.calculationVersion
          ) {
            return false;
          }
          return true;
        }) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: data.id ?? `plp-${payrollLedgerPostings.length + 1}`,
          postedAt: new Date(),
          ...data,
        };
        payrollLedgerPostings.push(row);
        return row;
      }),
    },
    payrollComponentDefinition: {
      findMany: vi.fn(async ({ where, orderBy }: any = {}) => {
        let rows = payrollComponentDefinitions.filter((row) => {
          if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where?.status !== undefined && row.status !== where.status) return false;
          return true;
        });
        if (orderBy) {
          rows = rows.slice().sort((a, b) => String(a.code).localeCompare(String(b.code)));
        }
        return rows;
      }),
      findFirst: vi.fn(async ({ where }: any) =>
        payrollComponentDefinitions.find((row) => {
          if (where.id !== undefined && row.id !== where.id) return false;
          if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where.code !== undefined && row.code !== where.code) return false;
          return true;
        }) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date();
        const row = {
          id: data.id ?? `pcd-${payrollComponentDefinitions.length + 1}`,
          version: 1,
          status: 'active',
          archivedAt: null,
          archivedByUserId: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        payrollComponentDefinitions.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = payrollComponentDefinitions.find((item) => item.id === where.id);
        if (!row) return null;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    },
    payrollItemComponentLine: {
      findMany: vi.fn(async ({ where }: any = {}) =>
        payrollItemComponentLines.filter((row) => {
          if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where?.payrollPeriodId !== undefined && row.payrollPeriodId !== where.payrollPeriodId) {
            return false;
          }
          if (where?.payrollItemId !== undefined && row.payrollItemId !== where.payrollItemId) {
            return false;
          }
          return true;
        })),
      createMany: vi.fn(async ({ data }: any) => {
        const rows = data.map((item: any, index: number) => ({
          id: item.id ?? `picl-${payrollItemComponentLines.length + index + 1}`,
          createdAt: new Date(),
          ...item,
        }));
        payrollItemComponentLines.push(...rows);
        return { count: rows.length };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        let count = 0;
        for (let index = payrollItemComponentLines.length - 1; index >= 0; index -= 1) {
          const row = payrollItemComponentLines[index];
          if (
            row.companyId === where.companyId
            && row.payrollPeriodId === where.payrollPeriodId
          ) {
            payrollItemComponentLines.splice(index, 1);
            count += 1;
          }
        }
        return { count };
      }),
    },
    payrollItemAdjustment: {
      findMany: vi.fn(async ({ where, orderBy }: any = {}) => {
        let rows = payrollItemAdjustments.filter((row) => {
          if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where?.payrollPeriodId !== undefined && row.payrollPeriodId !== where.payrollPeriodId) {
            return false;
          }
          if (where?.employeeId !== undefined && row.employeeId !== where.employeeId) return false;
          if (where?.status !== undefined && row.status !== where.status) return false;
          return true;
        });
        if (orderBy) {
          rows = rows.slice().sort((a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
        }
        return rows;
      }),
      findFirst: vi.fn(async ({ where }: any = {}) => {
        return payrollItemAdjustments.find((row) => {
          if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where?.idempotencyKey !== undefined && row.idempotencyKey !== where.idempotencyKey) {
            return false;
          }
          if (where?.id !== undefined && row.id !== where.id) return false;
          return true;
        }) ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        if (
          data.idempotencyKey
          && payrollItemAdjustments.some(
            (row) => row.companyId === data.companyId && row.idempotencyKey === data.idempotencyKey,
          )
        ) {
          const error: any = new Error('Unique constraint failed');
          error.code = 'P2002';
          throw error;
        }
        const row = {
          id: data.id ?? `pia-${payrollItemAdjustments.length + 1}`,
          status: 'applied',
          createdAt: new Date(),
          ...data,
        };
        payrollItemAdjustments.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of payrollItemAdjustments) {
          if (where?.companyId !== undefined && row.companyId !== where.companyId) continue;
          if (where?.payrollPeriodId !== undefined && row.payrollPeriodId !== where.payrollPeriodId) {
            continue;
          }
          if (where?.employeeId !== undefined && row.employeeId !== where.employeeId) continue;
          if (where?.status !== undefined && row.status !== where.status) continue;
          if (where?.payrollItemId?.not !== undefined) {
            if (row.payrollItemId == null) continue;
          } else if (where?.payrollItemId !== undefined && row.payrollItemId !== where.payrollItemId) {
            continue;
          }
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = payrollItemAdjustments.find((candidate) => candidate.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    salaryRecord: {
      findFirst: vi.fn(async ({ where }: any) => {
        const rows = salaryRecords
          .filter((row) => row.companyId === where.companyId && row.employeeId === where.employeeId)
          .filter((row) => {
            if (where.effectiveFrom?.lte && new Date(row.effectiveFrom) > where.effectiveFrom.lte) {
              return false;
            }
            if (where.OR) {
              const activeTo = row.effectiveTo == null ||
                new Date(row.effectiveTo) >= where.OR[1].effectiveTo.gte;
              if (!activeTo) return false;
            }
            return true;
          })
          .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime());
        return rows[0] ?? null;
      }),
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        const rows = salaryRecords
          .filter((row) => {
            if (row.companyId !== where.companyId) return false;
            if (typeof where.employeeId === 'string') return row.employeeId === where.employeeId;
            if (where.employeeId?.in) return where.employeeId.in.includes(row.employeeId);
            return true;
          });
        const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        const employeeDirection = clauses.find((clause: any) => clause.employeeId)?.employeeId;
        const effectiveDirection = clauses.find((clause: any) => clause.effectiveFrom)?.effectiveFrom;
        return rows.sort((a, b) => {
            if (employeeDirection) {
              const employeeOrder = String(a.employeeId).localeCompare(String(b.employeeId));
              if (employeeOrder !== 0) return employeeDirection === 'desc' ? -employeeOrder : employeeOrder;
            }
            const effectiveOrder = new Date(a.effectiveFrom).getTime() - new Date(b.effectiveFrom).getTime();
            if (effectiveOrder !== 0) return effectiveDirection === 'desc' ? -effectiveOrder : effectiveOrder;
            const employeeOrder = String(a.employeeId).localeCompare(String(b.employeeId));
            return employeeOrder;
          });
      }),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date();
        const row = {
          id: `salary-${salaryRecords.length + 1}`,
          effectiveTo: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        salaryRecords.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = salaryRecords.find((record) => record.id === where.id);
        if (row) Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    },
    task: {
      findMany: vi.fn(async ({ where }: any = {}) =>
        tasks
          .filter((task) => where?.companyId === undefined || task.companyId === where.companyId)
          .map(hydratedTask)
      ),
      findFirst: vi.fn(async ({ where }: any) => {
        const task = tasks.find((row) =>
          (where.id === undefined || row.id === where.id) &&
          (where.companyId === undefined || row.companyId === where.companyId)
        );
        return task ? hydratedTask(task) : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date();
        const row = {
          id: `task-${tasks.length + 1}`,
          description: null,
          dueDate: null,
          priority: 'normal',
          status: 'active',
          createdAt: now,
          updatedAt: now,
          ...data,
          creator: { id: data.createdByUserId, name: 'Creator' },
        };
        tasks.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data, include }: any) => {
        const row = tasks.find((task) => task.id === where.id);
        if (!row) return null;
        // A fresh updatedAt is what makes the optimistic-concurrency token move.
        Object.assign(row, data, { updatedAt: new Date(Date.now() + 1) });
        return include ? hydratedTask(row) : row;
      }),
    },
    taskAssignment: {
      createMany: vi.fn(async ({ data }: any) => {
        const rows = data.map((assignment: any, index: number) => ({
          id: `task-assignment-${taskAssignments.length + index + 1}`,
          completionDetails: null,
          submittedAt: null,
          reviewedByUserId: null,
          reviewedAt: null,
          reviewNote: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...assignment,
        }));
        taskAssignments.push(...rows);
        return { count: rows.length };
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const assignment = taskAssignments.find((row) =>
          (where.id === undefined || row.id === where.id) &&
          (where.companyId === undefined || row.companyId === where.companyId)
        );
        return assignment ? hydratedAssignment(assignment) : null;
      }),
      findMany: vi.fn(async ({ where }: any = {}) =>
        taskAssignments
          .filter((row) =>
            (where.companyId === undefined || row.companyId === where.companyId) &&
            (where.taskId === undefined || row.taskId === where.taskId) &&
            (where.employeeId === undefined || row.employeeId === where.employeeId)
          )
          .map(hydratedAssignment)
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const row = taskAssignments.find((assignment) => assignment.id === where.id);
        if (!row) return null;
        Object.assign(row, data, { updatedAt: new Date() });
        return hydratedAssignment(row);
      }),
      count: vi.fn(async ({ where }: any = {}) =>
        taskAssignments.filter((row) => {
          if (where.taskId !== undefined && row.taskId !== where.taskId) return false;
          if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
          if (where.status?.not !== undefined && row.status === where.status.not) return false;
          if (typeof where.status === 'string' && row.status !== where.status) return false;
          return true;
        }).length
      ),
    },
    /** P4 task discussion thread, including the (createdAt, id) keyset cursor. */
    taskComment: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `task-comment-${taskComments.length + 1}`,
          createdAt: new Date(Date.now() + taskComments.length),
          updatedAt: new Date(),
          ...data,
        };
        taskComments.push(row);
        return hydratedComment(row);
      }),
      findMany: vi.fn(async ({ where, take, orderBy }: any = {}) => {
        const descending = Array.isArray(orderBy)
          ? orderBy[0]?.createdAt === 'desc'
          : orderBy?.createdAt === 'desc';
        const rows = taskComments
          .filter((row) => {
            if (where?.companyId !== undefined && row.companyId !== where.companyId) return false;
            if (where?.taskId !== undefined && row.taskId !== where.taskId) return false;
            if (Array.isArray(where?.OR)) {
              // Mirrors the route's keyset predicate exactly so pagination is
              // exercised rather than assumed.
              return where.OR.some((clause: any) => {
                if (clause.createdAt?.lt !== undefined) {
                  return new Date(row.createdAt) < new Date(clause.createdAt.lt);
                }
                if (clause.createdAt !== undefined && clause.id?.lt !== undefined) {
                  return (
                    new Date(row.createdAt).getTime() === new Date(clause.createdAt).getTime() &&
                    row.id < clause.id.lt
                  );
                }
                return false;
              });
            }
            return true;
          })
          .sort((left, right) => {
            const delta = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
            const byTime = delta !== 0 ? delta : left.id.localeCompare(right.id);
            return descending ? -byTime : byTime;
          })
          .map(hydratedComment);
        return take === undefined ? rows : rows.slice(0, take);
      }),
      count: vi.fn(async ({ where }: any = {}) =>
        taskComments.filter(
          (row) =>
            (where?.companyId === undefined || row.companyId === where.companyId) &&
            (where?.taskId === undefined || row.taskId === where.taskId),
        ).length
      ),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn(async (fn: any) => {
      const snapshots = {
        refreshTokens: refreshTokens.map((row) => ({ ...row })),
        userMfaCredentials: userMfaCredentials.map((row) => ({ ...row })),
        vendors: vendors.map((row) => ({ ...row })),
        tasks: tasks.map((row) => ({ ...row })),
        taskAssignments: taskAssignments.map((row) => ({ ...row })),
        taskComments: taskComments.map((row) => ({ ...row })),
        notifications: notifications.map((row) => ({ ...row })),
        notificationPreferences: notificationPreferences.map((row) => ({ ...row })),
        auditLogs: auditLogs.map((row) => ({ ...row })),
        approvalHistory: approvalHistory.map((row) => ({ ...row })),
        loginIdentities: loginIdentities.map((row) => ({ ...row })),
        memoryAttachments: prisma.__memoryAttachments?.rows
          ? prisma.__memoryAttachments.rows.map((row: any) => ({ ...row }))
          : null,
        chatMessages: prisma._store?.chatMessages
          ? prisma._store.chatMessages.map((row: any) => ({ ...row }))
          : null,
        chatConversations: prisma._store?.chatConversations
          ? prisma._store.chatConversations.map((row: any) => ({ ...row }))
          : null,
        chatParticipants: prisma._store?.chatParticipants
          ? prisma._store.chatParticipants.map((row: any) => ({ ...row }))
          : null,
      };
      try {
        return await fn(prisma);
      } catch (error) {
        refreshTokens.splice(0, refreshTokens.length, ...snapshots.refreshTokens);
        userMfaCredentials.splice(0, userMfaCredentials.length, ...snapshots.userMfaCredentials);
        vendors.splice(0, vendors.length, ...snapshots.vendors);
        tasks.splice(0, tasks.length, ...snapshots.tasks);
        taskAssignments.splice(0, taskAssignments.length, ...snapshots.taskAssignments);
        taskComments.splice(0, taskComments.length, ...snapshots.taskComments);
        notifications.splice(0, notifications.length, ...snapshots.notifications);
        notificationPreferences.splice(0, notificationPreferences.length, ...snapshots.notificationPreferences);
        auditLogs.splice(0, auditLogs.length, ...snapshots.auditLogs);
        approvalHistory.splice(0, approvalHistory.length, ...snapshots.approvalHistory);
        loginIdentities.splice(0, loginIdentities.length, ...snapshots.loginIdentities);
        if (snapshots.memoryAttachments && prisma.__memoryAttachments?.rows) {
          prisma.__memoryAttachments.rows.splice(
            0,
            prisma.__memoryAttachments.rows.length,
            ...snapshots.memoryAttachments
          );
        } else if (snapshots.memoryAttachments === null && prisma.__memoryAttachments?.rows) {
          // Store was created inside the failed transaction — clear it.
          prisma.__memoryAttachments.rows.splice(0, prisma.__memoryAttachments.rows.length);
        }
        if (snapshots.chatMessages && prisma._store?.chatMessages) {
          prisma._store.chatMessages.splice(0, prisma._store.chatMessages.length, ...snapshots.chatMessages);
        }
        if (snapshots.chatConversations && prisma._store?.chatConversations) {
          prisma._store.chatConversations.splice(
            0,
            prisma._store.chatConversations.length,
            ...snapshots.chatConversations
          );
        }
        if (snapshots.chatParticipants && prisma._store?.chatParticipants) {
          prisma._store.chatParticipants.splice(
            0,
            prisma._store.chatParticipants.length,
            ...snapshots.chatParticipants
          );
        }
        throw error;
      }
    }),
    _store: {
      refreshTokens,
      userMfaCredentials,
      auditLogs,
      notifications,
      notificationPreferences,
      approvalHistory,
      vendors,
      employees,
      payrollPeriods,
      payrollItems,
      salaryRecords,
      chartOfAccounts,
      costCenters,
      journalEntries,
      journalEntryLines,
      payrollLedgerPostings,
      payrollComponentDefinitions,
      payrollItemComponentLines,
      payrollItemAdjustments,
      tasks,
      taskAssignments,
      taskComments,
      loginIdentities,
    },
  };
  prisma.loginIdentity.findMany.mockImplementation(async ({ where }: any = {}) => {
    if (typeof where?.normalizedIdentifier !== 'string') return [];
    const user = await prisma.user.findUnique({ where: { email: where.normalizedIdentifier } });
    return user ? [{ companyId: user.companyId, userId: user.id, user }] : [];
  });
  return prisma;
}

export function makeApp(
  prisma: any,
  configOverrides: Partial<AppConfig> = {},
  aiProvider: AiProvider | null = null
) {
  return createApp({
    prisma: prisma as PrismaClient,
    aiProvider,
    config: {
      jwtSecret: TEST_SECRET,
      accessTokenTtl: '15m',
      refreshTokenTtlDays: 7,
      // Generous default so unrelated tests never hit the limiter.
      authRateLimitWindowMs: 60_000,
      authRateLimitMax: 1000,
      isProduction: false,
      ...configOverrides,
    },
  });
}

export function tokenFor(
  user: Partial<{
    id: string;
    companyId: string;
    employeeId: string | null;
    permissions: string[];
    authorizationVersion: number;
    credentialVersion: number;
  }> = {},
  opts: { expiresIn?: string; secret?: string } = {}
): string {
  return jwt.sign(
    {
      id: 'u1',
      companyId: 'c1',
      employeeId: 'e1',
      permissions: [],
      authorizationVersion: 1,
      credentialVersion: 1,
      ...user,
    },
    opts.secret ?? TEST_SECRET,
    { expiresIn: (opts.expiresIn ?? '15m') as any }
  );
}
