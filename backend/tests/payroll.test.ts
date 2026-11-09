import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeApp, makeFakePrisma, tokenFor } from './helpers';

const payrollToken = (
  permissions: string[] = ['payroll.view', 'payroll.manage'],
  companyId = 'c1',
  id = 'u1'
) => tokenFor({ id, companyId, permissions });

const period = (overrides: Record<string, unknown> = {}) => ({
  id: 'period-1',
  companyId: 'c1',
  month: 7,
  year: 2026,
  status: 'draft',
  createdByUserId: 'creator-1',
  calculatedByUserId: null,
  approvedByUserId: null,
  paidByUserId: null,
  calculatedAt: null,
  approvedAt: null,
  paidAt: null,
  calculationVersion: 0,
  calculationFingerprint: null,
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  ...overrides,
});

const employee = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  companyId: 'c1',
  employeeNum: `EMP-${id}`,
  jobTitle: 'Specialist',
  joiningDate: new Date('2025-01-01T00:00:00.000Z'),
  status: 'active',
  departmentId: 'dept-1',
  department: { name: 'Operations' },
  user: { id: `user-${id}`, name: `Employee ${id}`, role: { permissions: '[]' } },
  ...overrides,
});

const ownerEmployee = (id = 'owner-1') => employee(id, {
  employeeNum: 'OWNER-1',
  user: { name: 'Company Owner', role: { permissions: JSON.stringify(['admin.full']) } },
});

const salary = (
  employeeId: string,
  baseSalary = '1234.56',
  overrides: Record<string, unknown> = {}
) => ({
  id: `salary-${employeeId}`,
  companyId: 'c1',
  employeeId,
  baseSalary,
  currency: 'SAR',
  effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
  effectiveTo: null,
  createdByUserId: 'hr-1',
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-01-01T00:00:00.000Z'),
  ...overrides,
});

const calculate = (prisma: any, body: Record<string, unknown> = {}, permissions?: string[]) =>
  request(makeApp(prisma))
    .post('/api/payroll/periods/period-1/calculate')
    .set('Authorization', `Bearer ${payrollToken(permissions)}`)
    .send(body);

const approve = (prisma: any, id = 'approver-1', permissions = ['payroll.approve']) =>
  request(makeApp(prisma))
    .post('/api/payroll/periods/period-1/approve')
    .set('Authorization', `Bearer ${payrollToken(permissions, 'c1', id)}`)
    .send({});

const markPaid = (prisma: any, id = 'payer-1', permissions = ['payroll.pay']) =>
  request(makeApp(prisma))
    .post('/api/payroll/periods/period-1/mark-paid')
    .set('Authorization', `Bearer ${payrollToken(permissions, 'c1', id)}`)
    .send({});

describe('Payroll periods and calculation', () => {
  it('requires canonical permissions for listing and creation', async () => {
    const app = makeApp(makeFakePrisma());
    const list = await request(app)
      .get('/api/payroll/periods')
      .set('Authorization', `Bearer ${payrollToken(['employees.view'])}`);
    const create = await request(app)
      .post('/api/payroll/periods')
      .set('Authorization', `Bearer ${payrollToken(['payroll.view'])}`)
      .send({ month: 7, year: 2026 });
    expect(list.status).toBe(403);
    expect(create.status).toBe(403);
  });

  it('creates a tenant-scoped draft with creator metadata and audits atomically', async () => {
    const prisma = makeFakePrisma();
    const response = await request(makeApp(prisma))
      .post('/api/payroll/periods')
      .set('Authorization', `Bearer ${payrollToken(['payroll.manage'], 'c1', 'creator-7')}`)
      .send({ month: 8, year: 2026, companyId: 'other-company' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('ValidationError');

    const valid = await request(makeApp(prisma))
      .post('/api/payroll/periods')
      .set('Authorization', `Bearer ${payrollToken(['payroll.manage'], 'c1', 'creator-7')}`)
      .send({ month: 8, year: 2026 });
    expect(valid.status).toBe(201);
    expect(valid.body).toMatchObject({ companyId: 'c1', month: 8, year: 2026, status: 'draft' });
    expect(prisma._store.payrollPeriods[0].createdByUserId).toBe('creator-7');
    expect(prisma._store.auditLogs.some((entry: any) => entry.action === 'payroll.period.create')).toBe(true);
  });

  it('returns a stable conflict for a duplicate period', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    const response = await request(makeApp(prisma))
      .post('/api/payroll/periods')
      .set('Authorization', `Bearer ${payrollToken(['payroll.manage'])}`)
      .send({ month: 7, year: 2026 });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PAYROLL_PERIOD_EXISTS');
  });

  it('lists only tenant periods and labels itemless approved periods as legacy metadata', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(
      period({ status: 'approved' }),
      period({ id: 'other-period', companyId: 'c2' })
    );
    const response = await request(makeApp(prisma))
      .get('/api/payroll/periods')
      .set('Authorization', `Bearer ${payrollToken(['payroll.view'])}`);
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      id: 'period-1', legacyWithoutItems: true, visibleSummary: null, itemCount: 0,
    });
  });

  it('calculates exact base-salary snapshots without floating-point money', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    prisma._store.employees.push(employee('employee-1'));
    prisma._store.salaryRecords.push(salary('employee-1', '1234.56'));

    const response = await calculate(prisma);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ idempotent: false, recalculated: false });
    expect(response.body.period).toMatchObject({ status: 'calculated', calculationVersion: 1 });
    expect(response.body.items[0]).toMatchObject({
      employeeId: 'employee-1',
      baseSalary: '1234.56',
      grossPay: '1234.56',
      totalDeductions: '0.00',
      netPay: '1234.56',
      currency: 'SAR',
      status: 'calculated',
    });
    expect(response.body.visibleSummary.visibleNet).toBe('1234.56');
    expect(prisma._store.payrollItems).toHaveLength(1);
    expect(prisma._store.payrollItems[0].salaryRecordId).toBe('salary-employee-1');
    const audit = prisma._store.auditLogs.find((entry: any) => entry.action === 'payroll.period.calculate');
    expect(audit).toBeDefined();
    expect(audit.details).not.toContain('1234.56');
    expect(audit.details).not.toContain(prisma._store.payrollPeriods[0].calculationFingerprint);
  });

  it('fails atomically when a salary is missing and creates no partial items', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    prisma._store.employees.push(employee('employee-1'), employee('employee-2'));
    prisma._store.salaryRecords.push(salary('employee-1'));

    const response = await calculate(prisma);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PAYROLL_ELIGIBILITY_BLOCKED');
    expect(response.body.details.issues[0].code).toBe('MISSING_SALARY');
    expect(prisma._store.payrollItems).toHaveLength(0);
    expect(prisma._store.payrollPeriods[0].status).toBe('draft');
  });

  it('redacts owner salary blockers without the exact owner-salary permission', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    prisma._store.employees.push(ownerEmployee());

    const response = await calculate(prisma, {}, ['admin.full']);
    expect(response.status).toBe(409);
    expect(response.body.details.issues).toEqual([]);
    expect(response.body.details.protectedEmployeeIssues).toBe(1);
    expect(JSON.stringify(response.body)).not.toContain('Company Owner');
    expect(JSON.stringify(response.body)).not.toContain('OWNER-1');
  });

  it('blocks partial-month hires, mid-month salary boundaries, overlaps, and non-SAR salaries', async () => {
    const cases = [
      {
        employee: employee('partial', { joiningDate: new Date('2026-07-15T00:00:00.000Z') }),
        salaries: [],
        code: 'PARTIAL_MONTH_EMPLOYEE',
      },
      {
        employee: employee('midmonth'),
        salaries: [salary('midmonth', '1000.00', { effectiveFrom: new Date('2026-07-15T00:00:00.000Z') })],
        code: 'MID_MONTH_SALARY_CHANGE',
      },
      {
        employee: employee('overlap'),
        salaries: [
          salary('overlap', '1000.00', { id: 'salary-overlap-1' }),
          salary('overlap', '1100.00', { id: 'salary-overlap-2', effectiveFrom: new Date('2026-06-01T00:00:00.000Z') }),
        ],
        code: 'OVERLAPPING_SALARY_RECORDS',
      },
      {
        employee: employee('currency'),
        salaries: [salary('currency', '1000.00', { currency: 'USD' })],
        code: 'UNSUPPORTED_CURRENCY',
      },
      {
        employee: employee('invalid-amount'),
        salaries: [salary('invalid-amount', '10000000.01')],
        code: 'INVALID_SALARY_AMOUNT',
      },
    ];

    for (const testCase of cases) {
      const prisma = makeFakePrisma();
      prisma._store.payrollPeriods.push(period());
      prisma._store.employees.push(testCase.employee);
      prisma._store.salaryRecords.push(...testCase.salaries);
      const response = await calculate(prisma);
      expect(response.status).toBe(409);
      expect(response.body.details.issues[0].code).toBe(testCase.code);
      expect(prisma._store.payrollItems).toHaveLength(0);
    }
  });

  it('is idempotent for an unchanged fingerprint and does not rewrite or increment', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    prisma._store.employees.push(employee('employee-1'));
    prisma._store.salaryRecords.push(salary('employee-1'));

    const first = await calculate(prisma);
    const firstItemId = prisma._store.payrollItems[0].id;
    const fingerprint = prisma._store.payrollPeriods[0].calculationFingerprint;
    const second = await calculate(prisma);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.period.calculationVersion).toBe(1);
    expect(prisma._store.payrollItems[0].id).toBe(firstItemId);
    expect(prisma._store.payrollPeriods[0].calculationFingerprint).toBe(fingerprint);
    expect(prisma.payrollItem.createMany).toHaveBeenCalledTimes(1);
  });

  it('requires a reason for changed inputs and increments the controlled recalculation version', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    prisma._store.employees.push(employee('employee-1'));
    prisma._store.salaryRecords.push(salary('employee-1', '1000.00'));
    await calculate(prisma);
    const firstItemId = prisma._store.payrollItems[0].id;
    prisma._store.salaryRecords[0].baseSalary = '1100.00';

    const withoutReason = await calculate(prisma);
    expect(withoutReason.status).toBe(409);
    expect(withoutReason.body.code).toBe('PAYROLL_RECALCULATION_REASON_REQUIRED');
    expect(prisma._store.payrollItems[0].id).toBe(firstItemId);

    const recalculated = await calculate(prisma, { recalculationReason: 'Salary history corrected' });
    expect(recalculated.status).toBe(200);
    expect(recalculated.body.recalculated).toBe(true);
    expect(recalculated.body.period.calculationVersion).toBe(2);
    expect(recalculated.body.items[0].netPay).toBe('1100.00');
    expect(prisma._store.auditLogs.some((entry: any) => entry.action === 'payroll.period.recalculate')).toBe(true);
  });

  it('never recalculates approved or paid periods', async () => {
    for (const status of ['approved', 'paid']) {
      const prisma = makeFakePrisma();
      prisma._store.payrollPeriods.push(period({ status }));
      const response = await calculate(prisma);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('PAYROLL_PERIOD_IMMUTABLE');
      expect(prisma.payrollItem.createMany).not.toHaveBeenCalled();
    }
  });
});

describe('Payroll item privacy', () => {
  it('hides owner rows and owner-inclusive totals without salary.view_owner', async () => {
    const prisma = makeFakePrisma();
    prisma.companyOwnership.findFirst.mockResolvedValue({ userId: 'owner-user' });
    prisma._store.payrollPeriods.push(period());
    const transferredOwner = ownerEmployee();
    transferredOwner.user = {
      id: 'owner-user',
      name: 'Company Owner',
      role: { permissions: '[]' },
    };
    prisma._store.employees.push(employee('employee-1'), transferredOwner);
    prisma._store.salaryRecords.push(
      salary('employee-1', '1000.00'),
      salary('owner-1', '5000.00')
    );
    const calculation = await calculate(prisma, {}, [
      'payroll.manage', 'payroll.view', 'salary.view_owner',
    ]);
    expect(calculation.status).toBe(200);

    const hidden = await request(makeApp(prisma))
      .get('/api/payroll/periods/period-1/items')
      .set('Authorization', `Bearer ${payrollToken(['payroll.view'])}`);
    expect(hidden.status).toBe(200);
    expect(hidden.body.items).toHaveLength(1);
    expect(hidden.body.items[0].employeeId).toBe('employee-1');
    expect(hidden.body.visibleSummary.visibleNet).toBe('1000.00');
    expect(hidden.body.protectedRowsHidden).toBe(true);
    expect(hidden.body.protectedRowCount).toBe(1);
    expect(hidden.body.fullSummary).toBeUndefined();
    expect(JSON.stringify(hidden.body)).not.toContain('5000.00');
    expect(JSON.stringify(hidden.body)).not.toContain('salary-owner-1');

    const visible = await request(makeApp(prisma))
      .get('/api/payroll/periods/period-1/items')
      .set('Authorization', `Bearer ${payrollToken(['payroll.view', 'salary.view_owner'])}`);
    expect(visible.status).toBe(200);
    expect(visible.body.items).toHaveLength(2);
    expect(visible.body.visibleSummary.visibleNet).toBe('6000.00');
    expect(visible.body.fullSummary.visibleNet).toBe('6000.00');
  });

  it('uses a safe 404 for a foreign-company item request', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period({ companyId: 'c2' }));
    const response = await request(makeApp(prisma))
      .get('/api/payroll/periods/period-1/items')
      .set('Authorization', `Bearer ${payrollToken(['payroll.view'], 'c1')}`);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('PAYROLL_PERIOD_NOT_FOUND');
  });
});

describe('Payroll approval and paid state', () => {
  it('requires calculated status, existing items, and a recorded calculator', async () => {
    const draftPrisma = makeFakePrisma();
    draftPrisma._store.payrollPeriods.push(period());
    const draft = await approve(draftPrisma);
    expect(draft.status).toBe(409);
    expect(draft.body.code).toBe('PAYROLL_PERIOD_NOT_CALCULATED');

    const emptyPrisma = makeFakePrisma();
    emptyPrisma._store.payrollPeriods.push(period({
      status: 'calculated', calculatedByUserId: 'calculator-1', calculationFingerprint: 'stored',
    }));
    const empty = await approve(emptyPrisma);
    expect(empty.status).toBe(409);
    expect(empty.body.code).toBe('PAYROLL_ITEMS_REQUIRED');
  });

  it('enforces second-person approval even for admin.full', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    prisma._store.employees.push(employee('employee-1'));
    prisma._store.salaryRecords.push(salary('employee-1'));
    await calculate(prisma, {}, ['admin.full']);

    const response = await approve(prisma, 'u1', ['admin.full']);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PAYROLL_SELF_APPROVAL_FORBIDDEN');
    expect(prisma._store.payrollPeriods[0].status).toBe('calculated');
  });

  it('blocks approval when current salary inputs no longer match the fingerprint', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    prisma._store.employees.push(employee('employee-1'));
    prisma._store.salaryRecords.push(salary('employee-1', '1000.00'));
    await calculate(prisma);
    prisma._store.salaryRecords[0].baseSalary = '1200.00';

    const response = await approve(prisma);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PAYROLL_CALCULATION_STALE');
    expect(prisma._store.payrollPeriods[0].status).toBe('calculated');
  });

  it('approves through a second user without mutating immutable payroll items', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    prisma._store.employees.push(employee('employee-1'));
    prisma._store.salaryRecords.push(salary('employee-1', '1000.00'));
    await calculate(prisma);
    const before = JSON.stringify(prisma._store.payrollItems);

    const response = await approve(prisma, 'approver-2');
    expect(response.status).toBe(200);
    expect(response.body.period.status).toBe('approved');
    expect(response.body.items).toBeUndefined();
    expect(prisma._store.payrollPeriods[0].approvedByUserId).toBe('approver-2');
    expect(JSON.stringify(prisma._store.payrollItems)).toBe(before);
    const audit = prisma._store.auditLogs.find((entry: any) => entry.action === 'payroll.period.approve');
    expect(audit).toBeDefined();
    expect(audit.details).not.toContain('1000.00');
  });

  it('requires payroll.pay and an approved period before administrative payment', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    prisma._store.employees.push(employee('employee-1'));
    prisma._store.salaryRecords.push(salary('employee-1'));
    await calculate(prisma);

    const forbidden = await markPaid(prisma, 'payer-1', ['payroll.view']);
    expect(forbidden.status).toBe(403);
    const notApproved = await markPaid(prisma);
    expect(notApproved.status).toBe(409);
    expect(notApproved.body.code).toBe('PAYROLL_PERIOD_NOT_APPROVED');
  });

  it('blocks legacy mark-paid for approved periods and stays idempotent for already-paid periods', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    prisma._store.employees.push(employee('employee-1'));
    prisma._store.salaryRecords.push(salary('employee-1', '1000.00'));
    await calculate(prisma);
    await approve(prisma);
    const before = JSON.stringify(prisma._store.payrollItems);

    const response = await markPaid(prisma, 'approver-1');
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PAYROLL_MARK_PAID_USE_V2_PAYMENTS');
    expect(prisma._store.payrollPeriods[0].status).toBe('approved');
    expect(JSON.stringify(prisma._store.payrollItems)).toBe(before);

    prisma._store.payrollPeriods[0].status = 'paid';
    prisma._store.payrollPeriods[0].paidByUserId = 'legacy-payer';
    prisma._store.payrollPeriods[0].paidAt = new Date('2026-07-01T00:00:00.000Z');

    const duplicate = await markPaid(prisma);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.period.status).toBe('paid');
    expect(duplicate.body.bankTransferProof).toBe(false);
    expect(prisma._store.payrollPeriods[0].paidByUserId).toBe('legacy-payer');
  });
});

describe('Payroll reports', () => {
  it('requires payroll.report and blocks reports before approval', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    const forbidden = await request(makeApp(prisma))
      .get('/api/payroll/report?periodId=period-1')
      .set('Authorization', `Bearer ${payrollToken(['payroll.view'])}`);
    expect(forbidden.status).toBe(403);

    const draft = await request(makeApp(prisma))
      .get('/api/payroll/report?periodId=period-1')
      .set('Authorization', `Bearer ${payrollToken(['payroll.report'])}`);
    expect(draft.status).toBe(409);
    expect(draft.body.code).toBe('PAYROLL_REPORT_NOT_AVAILABLE');
  });

  it('returns privacy-filtered immutable rows and visible totals for approved periods', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    prisma._store.employees.push(employee('employee-1'), ownerEmployee());
    prisma._store.salaryRecords.push(
      salary('employee-1', '1000.00'),
      salary('owner-1', '5000.00')
    );
    await calculate(prisma, {}, ['payroll.manage', 'salary.view_owner']);
    await approve(prisma, 'approver-1', ['payroll.approve', 'salary.view_owner']);

    const response = await request(makeApp(prisma))
      .get('/api/payroll/report?periodId=period-1')
      .set('Authorization', `Bearer ${payrollToken(['payroll.report'])}`);
    expect(response.status).toBe(200);
    expect(response.body.period.status).toBe('approved');
    expect(response.body.rows).toHaveLength(1);
    expect(response.body.rows[0].employeeId).toBe('employee-1');
    expect(response.body.visibleSummary.visibleNet).toBe('1000.00');
    expect(response.body.protectedRowsHidden).toBe(true);
    expect(response.body.protectedRowCount).toBe(1);
    expect(response.body.fullSummary).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('5000.00');
    expect(JSON.stringify(response.body)).not.toContain('salaryRecordId');
    const audit = prisma._store.auditLogs.find((entry: any) => entry.action === 'payroll.report.read');
    expect(audit.details).not.toContain('1000.00');
  });

  it('allows a paid report and exposes full totals only with salary.view_owner', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period());
    prisma._store.employees.push(employee('employee-1'), ownerEmployee());
    prisma._store.salaryRecords.push(
      salary('employee-1', '1000.00'),
      salary('owner-1', '5000.00')
    );
    await calculate(prisma, {}, ['payroll.manage', 'salary.view_owner']);
    await approve(prisma, 'approver-1', ['payroll.approve', 'salary.view_owner']);
    prisma._store.payrollPeriods[0].status = 'paid';
    prisma._store.payrollPeriods[0].paidByUserId = 'payer-1';
    prisma._store.payrollPeriods[0].paidAt = new Date('2026-07-01T00:00:00.000Z');

    const response = await request(makeApp(prisma))
      .get('/api/payroll/report?periodId=period-1')
      .set('Authorization', `Bearer ${payrollToken(['payroll.report', 'salary.view_owner'])}`);
    expect(response.status).toBe(200);
    expect(response.body.period.status).toBe('paid');
    expect(response.body.rows).toHaveLength(2);
    expect(response.body.visibleSummary.visibleNet).toBe('6000.00');
    expect(response.body.fullSummary.visibleNet).toBe('6000.00');
  });

  it('keeps legacy approved metadata honest instead of reporting zero payroll', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period({ status: 'approved' }));
    const response = await request(makeApp(prisma))
      .get('/api/payroll/report?periodId=period-1')
      .set('Authorization', `Bearer ${payrollToken(['payroll.report'])}`);
    expect(response.status).toBe(200);
    expect(response.body.period.legacyWithoutItems).toBe(true);
    expect(response.body.visibleSummary).toBeNull();
    expect(response.body.rows).toEqual([]);
  });

  it('uses a safe 404 for another tenant report', async () => {
    const prisma = makeFakePrisma();
    prisma._store.payrollPeriods.push(period({ companyId: 'c2', status: 'approved' }));
    const response = await request(makeApp(prisma))
      .get('/api/payroll/report?periodId=period-1')
      .set('Authorization', `Bearer ${payrollToken(['payroll.report'], 'c1')}`);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('PAYROLL_PERIOD_NOT_FOUND');
  });
});
