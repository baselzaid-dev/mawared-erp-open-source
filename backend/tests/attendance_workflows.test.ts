import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXEMPTION_REASON_CATEGORIES,
  isUserAttendanceExempt,
  registerAttendanceWorkflowRoutes,
} from '../src/attendanceWorkflows';
import { PERMISSIONS } from '../src/permissions';
import { makeFakePrisma, TEST_SECRET, tokenFor } from './helpers';

type StoreRow = Record<string, unknown>;

function makeAttendancePrisma() {
  const attendances: StoreRow[] = [];
  const corrections: StoreRow[] = [];
  const correctionHistory: StoreRow[] = [];
  const exemptions: StoreRow[] = [];
  const employees: StoreRow[] = [
    {
      id: 'e1',
      companyId: 'c1',
      departmentId: 'd1',
      status: 'active',
      user: { id: 'u1' },
      department: { id: 'd1' },
    },
    {
      id: 'e2',
      companyId: 'c1',
      departmentId: 'd1',
      status: 'active',
      user: { id: 'u2' },
      department: { id: 'd1' },
    },
  ];
  const users: StoreRow[] = [
    { id: 'u1', companyId: 'c1', employeeId: 'e1', role: { permissions: '[]' } },
    { id: 'u2', companyId: 'c1', employeeId: 'e2', role: { permissions: '[]' } },
    { id: 'u-hr', companyId: 'c1', employeeId: 'e-hr', role: { permissions: '[]' } },
  ];

  const prisma = makeFakePrisma();

  prisma.employee.findFirst = vi.fn(async ({ where, include }: any = {}) => {
    const row = employees.find((employee) =>
      employee.companyId === where.companyId && employee.id === where.id,
    );
    if (!row) return null;
    if (include?.user || include?.department) {
      return {
        ...row,
        user: row.user ?? { id: 'unknown' },
        department: row.department ?? { id: row.departmentId },
      };
    }
    return row;
  });

  prisma.user.findFirst = vi.fn(async ({ where }: any = {}) => {
    const row = users.find((user) =>
      user.id === where.id && user.companyId === where.companyId,
    );
    if (!row) return null;
    const employee = employees.find((item) => item.id === row.employeeId);
    return {
      ...row,
      employee: employee
        ? { id: employee.id, departmentId: employee.departmentId, status: employee.status }
        : null,
    };
  });

  prisma.user.findMany = vi.fn(async ({ where }: any = {}) =>
    users.filter((user) => user.companyId === where.companyId),
  );

  prisma.companyOwnership.findFirst = vi.fn(async () => null);

  prisma.departmentManager.findMany = vi.fn(async ({ where }: any = {}) =>
    where.userId === 'u-hr' ? [{ departmentId: 'd1' }] : [],
  );

  prisma.attendance.findFirst = vi.fn(async ({ where }: any = {}) =>
    attendances.find((row) =>
      row.companyId === where.companyId
      && (where.id === undefined || row.id === where.id),
    ) ?? null,
  );

  prisma.attendance.update = vi.fn(async ({ where, data }: any) => {
    const row = attendances.find((item) => item.id === where.id);
    if (!row) return null;
    if (data.version?.increment) row.version = Number(row.version) + data.version.increment;
    if ('clockIn' in data) row.clockIn = data.clockIn;
    if ('clockOut' in data) row.clockOut = data.clockOut;
    row.updatedAt = new Date();
    return { ...row };
  });

  prisma.attendanceCorrection = {
    findFirst: vi.fn(async ({ where }: any = {}) =>
      corrections.find((row) => {
        if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
        if (where.id !== undefined && row.id !== where.id) return false;
        if (where.attendanceId !== undefined && row.attendanceId !== where.attendanceId) return false;
        if (where.status !== undefined && row.status !== where.status) return false;
        if (where.requestedByUserId !== undefined && row.requestedByUserId !== where.requestedByUserId) return false;
        if (where.version !== undefined && row.version !== where.version) return false;
        return true;
      }) ?? null,
    ),
    findMany: vi.fn(async ({ where, orderBy, take }: any = {}) => {
      let rows = corrections.filter((row) => {
        if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
        if (where.status !== undefined && row.status !== where.status) return false;
        if (where.employeeId !== undefined && row.employeeId !== where.employeeId) return false;
        if (where.requestedByUserId !== undefined && row.requestedByUserId !== where.requestedByUserId) return false;
        return true;
      });
      rows = rows.sort((left, right) =>
        new Date(String(right.createdAt)).getTime() - new Date(String(left.createdAt)).getTime(),
      );
      return take === undefined ? rows : rows.slice(0, take);
    }),
    create: vi.fn(async ({ data }: any) => {
      const now = new Date();
      const row = {
        version: 1,
        reviewedAt: null,
        decisionReason: null,
        reviewedByUserId: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      corrections.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = corrections.find((item) => item.id === where.id);
      if (!row) return null;
      Object.assign(row, data);
      if (data.version?.increment) row.version = Number(row.version) + data.version.increment;
      row.updatedAt = new Date();
      return { ...row };
    }),
  };

  prisma.attendanceCorrectionHistory = {
    create: vi.fn(async ({ data }: any) => {
      correctionHistory.push(data);
      return data;
    }),
  };

  prisma.attendanceExemption = {
    findFirst: vi.fn(async ({ where, orderBy }: any = {}) => {
      let rows = exemptions.filter((row) => {
        if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
        if (where.userId !== undefined && row.userId !== where.userId) return false;
        if (where.id !== undefined && row.id !== where.id) return false;
        if (where.status !== undefined && row.status !== where.status) return false;
        if (where.validFrom?.lte && new Date(String(row.validFrom)) > where.validFrom.lte) return false;
        if (where.OR) {
          const activeNow = where.OR.some((clause: any) => {
            if (clause.validUntil === null && row.validUntil != null) return false;
            if (clause.validUntil?.gt && row.validUntil && new Date(String(row.validUntil)) <= clause.validUntil.gt) {
              return false;
            }
            return true;
          });
          if (!activeNow) return false;
        }
        return true;
      });
      if (orderBy) {
        rows = rows.sort((left, right) =>
          new Date(String(right.validFrom)).getTime() - new Date(String(left.validFrom)).getTime(),
        );
      }
      return rows[0] ?? null;
    }),
    findMany: vi.fn(async ({ where }: any = {}) =>
      exemptions.filter((row) => {
        if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
        if (where.userId !== undefined && row.userId !== where.userId) return false;
        if (where.status !== undefined && row.status !== where.status) return false;
        return true;
      }),
    ),
    create: vi.fn(async ({ data }: any) => {
      const row = {
        version: 1,
        revokedAt: null,
        revokedByUserId: null,
        createdAt: new Date(),
        ...data,
      };
      exemptions.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = exemptions.find((item) => item.id === where.id);
      if (!row) return null;
      Object.assign(row, data);
      if (data.version?.increment) row.version = Number(row.version) + data.version.increment;
      return { ...row };
    }),
  };

  return {
    prisma,
    stores: { attendances, corrections, correctionHistory, exemptions, employees, users },
  };
}

function makeAttendanceApp(prisma: ReturnType<typeof makeFakePrisma>) {
  const app = express();
  app.use(express.json());

  const requireAuth = (req: express.Request & { user?: Record<string, unknown> }, res: express.Response, next: express.NextFunction) => {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? header.match(/^Bearer\s+(\S+)$/i) : null;
    if (!match) return res.status(401).json({ error: 'Unauthorized' });
    try {
      req.user = jwt.verify(match[1], TEST_SECRET) as {
        id: string;
        companyId: string;
        employeeId: string | null;
        permissions: string[];
      };
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };

  const checkAnyPermission = (...required: string[]) => (
    req: express.Request & { user?: { permissions?: string[] } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const permissions: string[] = req.user?.permissions ?? [];
    if (
      permissions.includes(PERMISSIONS.ADMIN_FULL)
      || required.some((permission) => permissions.includes(permission))
    ) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden', code: 403 });
  };

  registerAttendanceWorkflowRoutes({
    app,
    prisma: prisma as any,
    requireAuth,
    checkAnyPermission,
  });

  return app;
}

function seedAttendance(store: StoreRow[], overrides: Partial<StoreRow> = {}) {
  const row = {
    id: 'att-1',
    companyId: 'c1',
    employeeId: 'e1',
    date: new Date('2026-07-19T00:00:00.000Z'),
    clockIn: new Date('2026-07-19T08:00:00.000Z'),
    clockOut: null,
    status: 'present',
    version: 1,
    ...overrides,
  };
  store.push(row);
  return row;
}

describe('attendance workflows v2', () => {
  let prisma: ReturnType<typeof makeAttendancePrisma>['prisma'];
  let stores: ReturnType<typeof makeAttendancePrisma>['stores'];
  let app: express.Express;

  beforeEach(() => {
    const built = makeAttendancePrisma();
    prisma = built.prisma;
    stores = built.stores;
    app = makeAttendanceApp(prisma);
  });

  it('creates a correction for own attendance and blocks a second pending request', async () => {
    seedAttendance(stores.attendances);
    const token = tokenFor({
      id: 'u1',
      employeeId: 'e1',
      permissions: [PERMISSIONS.ATTENDANCE_VIEW_OWN],
    });

    const createRes = await request(app)
      .post('/api/v2/attendance/att-1/corrections')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clockIn: '2026-07-19T08:30:00.000Z',
        reason: 'Forgot to clock correctly',
        expectedAttendanceVersion: 1,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.status).toBe('pending');
    expect(stores.correctionHistory).toHaveLength(1);

    const duplicateRes = await request(app)
      .post('/api/v2/attendance/att-1/corrections')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clockOut: '2026-07-19T17:00:00.000Z',
        reason: 'Another pending attempt',
        expectedAttendanceVersion: 1,
      });

    expect(duplicateRes.status).toBe(409);
    expect(duplicateRes.body.messageKey).toBe('attendance.pending_correction_exists');
  });

  it('accepts a correction and applies clock times with version bump', async () => {
    seedAttendance(stores.attendances);
    stores.corrections.push({
      id: 'corr-1',
      companyId: 'c1',
      attendanceId: 'att-1',
      employeeId: 'e1',
      requestedByUserId: 'u1',
      requestedClockIn: new Date('2026-07-19T09:00:00.000Z'),
      requestedClockOut: new Date('2026-07-19T17:00:00.000Z'),
      reason: 'Fix times',
      status: 'pending',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      reviewedAt: null,
      decisionReason: null,
      reviewedByUserId: null,
    });

    const res = await request(app)
      .post('/api/v2/attendance/corrections/corr-1/decision')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-hr',
        employeeId: 'e-hr',
        permissions: [
          PERMISSIONS.ATTENDANCE_REVIEW_CORRECTION,
          PERMISSIONS.ATTENDANCE_VIEW,
        ],
      })}`)
      .set('Idempotency-Key', 'decision-key-001')
      .send({
        decision: 'accept',
        reason: 'Approved by HR',
        expectedVersion: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body.correction.status).toBe('approved');
    expect(res.body.attendance.version).toBe(2);
    expect(stores.attendances[0].clockIn).toEqual(new Date('2026-07-19T09:00:00.000Z'));
  });

  it('rejects self-review on correction decisions', async () => {
    stores.corrections.push({
      id: 'corr-self',
      companyId: 'c1',
      attendanceId: 'att-1',
      employeeId: 'e1',
      requestedByUserId: 'u1',
      requestedClockIn: new Date('2026-07-19T09:00:00.000Z'),
      requestedClockOut: null,
      reason: 'Self review attempt',
      status: 'pending',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      reviewedAt: null,
      decisionReason: null,
      reviewedByUserId: null,
    });

    const res = await request(app)
      .post('/api/v2/attendance/corrections/corr-self/decision')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u1',
        employeeId: 'e1',
        permissions: [PERMISSIONS.ATTENDANCE_REVIEW_CORRECTION, PERMISSIONS.ATTENDANCE_VIEW],
      })}`)
      .set('Idempotency-Key', 'decision-key-self')
      .send({
        decision: 'reject',
        reason: 'Cannot review own request',
        expectedVersion: 1,
      });

    expect(res.status).toBe(403);
    expect(res.body.messageKey).toBe('attendance.self_review_forbidden');
  });

  it('creates and revokes an exemption without self-grant', async () => {
    const managerToken = tokenFor({
      id: 'u-hr',
      employeeId: 'e-hr',
      permissions: [
        PERMISSIONS.EMPLOYEES_ATTENDANCE_EXEMPTION_MANAGE,
        PERMISSIONS.ATTENDANCE_VIEW,
      ],
    });

    const selfRes = await request(app)
      .post('/api/v2/attendance/exemptions')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', 'exemption-self-key')
      .send({
        targetUserId: 'u-hr',
        validFrom: '2026-07-19T00:00:00.000Z',
        reasonCategory: EXEMPTION_REASON_CATEGORIES[0],
      });
    expect(selfRes.status).toBe(403);
    expect(selfRes.body.messageKey).toBe('attendance.exemption_self_forbidden');

    const createRes = await request(app)
      .post('/api/v2/attendance/exemptions')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', 'exemption-create-key')
      .send({
        targetUserId: 'u2',
        validFrom: '2026-07-19T00:00:00.000Z',
        reasonCategory: 'admin_account',
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.status).toBe('active');

    const revokeRes = await request(app)
      .post(`/api/v2/attendance/exemptions/${createRes.body.id}/revoke`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Idempotency-Key', 'exemption-revoke-key')
      .send({
        reason: 'No longer needed',
        expectedVersion: 1,
      });
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.status).toBe('revoked');
    expect(revokeRes.body.revokedAt).toBeTruthy();
  });

  it('rejects unknown exemption categories', async () => {
    const res = await request(app)
      .post('/api/v2/attendance/exemptions')
      .set('Authorization', `Bearer ${tokenFor({
        id: 'u-hr',
        permissions: [
          PERMISSIONS.EMPLOYEES_ATTENDANCE_EXEMPTION_MANAGE,
          PERMISSIONS.ATTENDANCE_VIEW,
        ],
      })}`)
      .set('Idempotency-Key', 'exemption-bad-category')
      .send({
        targetUserId: 'u2',
        validFrom: '2026-07-19T00:00:00.000Z',
        reasonCategory: 'free_text_category',
      });

    expect(res.status).toBe(400);
    expect(res.body.messageKey).toBe('attendance.invalid_request');
  });

  it('reports active exemption through isUserAttendanceExempt helper', async () => {
    stores.exemptions.push({
      id: 'ex-1',
      companyId: 'c1',
      userId: 'u2',
      employeeId: 'e2',
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validUntil: null,
      reasonCategory: 'admin_account',
      status: 'active',
    });

    const result = await isUserAttendanceExempt(prisma as any, 'c1', 'u2', new Date('2026-07-19T12:00:00.000Z'));
    expect(result).toEqual({ exempt: true, reasonCategory: 'admin_account' });

    const inactive = await isUserAttendanceExempt(prisma as any, 'c1', 'u1');
    expect(inactive).toEqual({ exempt: false });
  });
});
