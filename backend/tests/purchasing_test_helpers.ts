import { vi } from 'vitest';
import { makeFakePrisma } from './helpers';

const matchesScalar = (value: unknown, condition: any): boolean => {
  if (condition === undefined) return true;
  if (condition && typeof condition === 'object') {
    if (condition.in && !condition.in.includes(value)) return false;
    if (condition.not !== undefined && value === condition.not) return false;
    if (condition.gte && new Date(value as any) < condition.gte) return false;
    if (condition.lte && new Date(value as any) > condition.lte) return false;
    return true;
  }
  return value === condition;
};

export function makePurchasingPrisma() {
  const prisma = makeFakePrisma() as any;
  const departments: any[] = [];
  const users: any[] = [];
  const employees: any[] = [];
  const requests: any[] = [];
  const requestLines: any[] = [];
  const orders: any[] = [];
  const orderLines: any[] = [];

  const hydrateUser = (user: any) => user ? {
    ...user,
    employee: employees.find((employee) => employee.id === user.employeeId) ?? null,
    role: { permissions: JSON.stringify(user.permissions ?? []) },
  } : null;
  const hydrateEmployee = (employee: any) => employee ? {
    ...employee,
    user: hydrateUser(users.find((user) => user.employeeId === employee.id)),
    department: departments.find((department) => department.id === employee.departmentId) ?? null,
  } : null;
  const hydrateRequest = (row: any): any => ({
    ...row,
    lines: requestLines.filter((line) => line.purchaseRequestId === row.id),
    department: departments.find((department) => department.id === row.departmentId) ?? null,
    requester: hydrateEmployee(employees.find((employee) => employee.id === row.requestedByEmployeeId)),
    departmentReviewer: hydrateUser(users.find((user) => user.id === row.departmentReviewedByUserId)),
    purchasingReviewer: hydrateUser(users.find((user) => user.id === row.purchasingReviewedByUserId)),
    cancelledBy: hydrateUser(users.find((user) => user.id === row.cancelledByUserId)),
    orders: orders.filter((order) => order.purchaseRequestId === row.id),
  });
  const hydrateOrder = (row: any): any => ({
    ...row,
    lines: orderLines.filter((line) => line.purchaseOrderId === row.id),
    purchaseRequest: hydrateRequest(requests.find((request) => request.id === row.purchaseRequestId)),
    createdBy: hydrateUser(users.find((user) => user.id === row.createdByUserId)),
    issuedBy: hydrateUser(users.find((user) => user.id === row.issuedByUserId)),
    receivedBy: hydrateUser(users.find((user) => user.id === row.receivedByUserId)),
    cancelledBy: hydrateUser(users.find((user) => user.id === row.cancelledByUserId)),
  });
  const requestMatches = (row: any, where: any = {}) => {
    if (!matchesScalar(row.id, where.id)) return false;
    if (!matchesScalar(row.companyId, where.companyId)) return false;
    if (!matchesScalar(row.status, where.status)) return false;
    if (!matchesScalar(row.departmentId, where.departmentId)) return false;
    if (!matchesScalar(row.requestedByEmployeeId, where.requestedByEmployeeId)) return false;
    if (!matchesScalar(row.createdAt, where.createdAt)) return false;
    return true;
  };
  const orderMatches = (row: any, where: any = {}) => {
    if (!matchesScalar(row.id, where.id)) return false;
    if (!matchesScalar(row.companyId, where.companyId)) return false;
    if (!matchesScalar(row.status, where.status)) return false;
    if (!matchesScalar(row.vendorId, where.vendorId)) return false;
    if (!matchesScalar(row.purchaseRequestId, where.purchaseRequestId)) return false;
    if (!matchesScalar(row.createdAt, where.createdAt)) return false;
    if (where.purchaseRequest && !requestMatches(requests.find((request) => request.id === row.purchaseRequestId), where.purchaseRequest)) return false;
    return true;
  };

  prisma.department.findMany = vi.fn(async ({ where }: any) => departments.filter((row) =>
    matchesScalar(row.companyId, where.companyId) && matchesScalar(row.managerId, where.managerId)
  ));
  prisma.user.findFirst = vi.fn(async ({ where }: any) => {
    const row = users.find((user) => matchesScalar(user.id, where.id) && matchesScalar(user.companyId, where.companyId));
    if (!row) return null;
    if (where.employee?.status) {
      const employee = employees.find((item) => item.id === row.employeeId);
      if (!employee || employee.status !== where.employee.status) return null;
    }
    return hydrateUser(row);
  });
  prisma.user.findMany = vi.fn(async ({ where }: any) => users.filter((row) => matchesScalar(row.companyId, where.companyId)).map(hydrateUser));
  prisma.employee.findFirst = vi.fn(async ({ where }: any) => {
    const row = employees.find((employee) =>
      matchesScalar(employee.id, where.id) && matchesScalar(employee.companyId, where.companyId) && matchesScalar(employee.status, where.status)
    );
    return hydrateEmployee(row);
  });

  prisma.purchaseRequest = {
    create: vi.fn(async ({ data }: any) => {
      const now = new Date('2026-07-10T10:00:00.000Z');
      const { lines: nestedLines, ...requestData } = data;
      const row = { id: `10000000-0000-4000-8000-${String(requests.length + 1).padStart(12, '0')}`, createdAt: now, updatedAt: now, ...requestData };
      requests.push(row);
      for (const line of nestedLines?.create ?? []) {
        requestLines.push({ id: `20000000-0000-4000-8000-${String(requestLines.length + 1).padStart(12, '0')}`, purchaseRequestId: row.id, createdAt: now, updatedAt: now, ...line });
      }
      return hydrateRequest(row);
    }),
    findFirst: vi.fn(async ({ where }: any) => {
      const row = requests.find((request) => requestMatches(request, where));
      return row ? hydrateRequest(row) : null;
    }),
    findMany: vi.fn(async ({ where, skip = 0, take = 1000 }: any) => requests.filter((row) => requestMatches(row, where)).slice(skip, skip + take).map(hydrateRequest)),
    update: vi.fn(async ({ where, data }: any) => {
      const row = requests.find((request) => request.id === where.id);
      if (!row) return null;
      Object.assign(row, data, { updatedAt: new Date('2026-07-10T11:00:00.000Z') });
      return hydrateRequest(row);
    }),
  };

  prisma.purchaseOrder = {
    create: vi.fn(async ({ data }: any) => {
      const now = new Date('2026-07-10T10:30:00.000Z');
      const { lines: nestedLines, ...orderData } = data;
      const row = { id: `30000000-0000-4000-8000-${String(orders.length + 1).padStart(12, '0')}`, createdAt: now, updatedAt: now, ...orderData };
      orders.push(row);
      for (const line of nestedLines?.create ?? []) {
        orderLines.push({ id: `40000000-0000-4000-8000-${String(orderLines.length + 1).padStart(12, '0')}`, purchaseOrderId: row.id, createdAt: now, updatedAt: now, ...line });
      }
      return hydrateOrder(row);
    }),
    findFirst: vi.fn(async ({ where }: any) => {
      const row = orders.find((order) => orderMatches(order, where));
      return row ? hydrateOrder(row) : null;
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      const row = orders.find((order) => order.id === where.id);
      return row ? hydrateOrder(row) : null;
    }),
    findMany: vi.fn(async ({ where, skip = 0, take = 1000 }: any) => orders.filter((row) => orderMatches(row, where)).slice(skip, skip + take).map(hydrateOrder)),
    update: vi.fn(async ({ where, data }: any) => {
      const row = orders.find((order) => order.id === where.id);
      if (!row) return null;
      Object.assign(row, data, { updatedAt: new Date('2026-07-10T11:00:00.000Z') });
      return hydrateOrder(row);
    }),
  };
  prisma.purchaseOrderLine = {
    update: vi.fn(async ({ where, data }: any) => {
      const row = orderLines.find((line) => line.id === where.id);
      Object.assign(row, data);
      return row;
    }),
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `40000000-0000-4000-8000-${String(orderLines.length + 1).padStart(12, '0')}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      orderLines.push(row);
      return row;
    }),
  };

  // ---------------------------------------------------------------------
  // Commercial Wave 2 — Operations Slice E1 in-memory models.
  // ---------------------------------------------------------------------
  const workflowEvents: any[] = [];
  const quotations: any[] = [];
  const quotationLines: any[] = [];
  const receipts: any[] = [];
  const receiptLines: any[] = [];
  const returns: any[] = [];
  const returnLines: any[] = [];

  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}${String(++sequence).padStart(12, '0')}`;
  const decimalString = (value: any) => (value == null ? null : String(value));

  const hydrateQuotation = (row: any): any => row ? {
    ...row,
    lines: quotationLines.filter((line) => line.supplierQuotationId === row.id),
    vendor: prisma._store.vendors.find((vendor: any) => vendor.id === row.vendorId) ?? null,
    createdBy: hydrateUser(users.find((user) => user.id === row.createdByUserId)),
    selectedBy: hydrateUser(users.find((user) => user.id === row.selectedByUserId)),
    rejectedBy: hydrateUser(users.find((user) => user.id === row.rejectedByUserId)),
    purchaseRequest: hydrateRequest(requests.find((request) => request.id === row.purchaseRequestId)),
  } : null;

  const hydrateReceipt = (row: any): any => row ? {
    ...row,
    lines: receiptLines.filter((line) => line.purchaseReceiptId === row.id),
    receivedBy: hydrateUser(users.find((user) => user.id === row.receivedByUserId)),
  } : null;

  const hydrateReturn = (row: any): any => row ? {
    ...row,
    lines: returnLines.filter((line) => line.purchaseReturnId === row.id),
    createdBy: hydrateUser(users.find((user) => user.id === row.createdByUserId)),
    reviewedBy: hydrateUser(users.find((user) => user.id === row.reviewedByUserId)),
    purchaseOrder: orders.some((order) => order.id === row.purchaseOrderId)
      ? hydrateOrder(orders.find((order) => order.id === row.purchaseOrderId))
      : null,
  } : null;

  const quotationMatches = (row: any, where: any = {}) => {
    if (!matchesScalar(row.id, where.id)) return false;
    if (!matchesScalar(row.companyId, where.companyId)) return false;
    if (!matchesScalar(row.status, where.status)) return false;
    if (!matchesScalar(row.vendorId, where.vendorId)) return false;
    if (!matchesScalar(row.purchaseRequestId, where.purchaseRequestId)) return false;
    if (!matchesScalar(row.createdAt, where.createdAt)) return false;
    return true;
  };

  prisma.purchaseWorkflowEvent = {
    create: vi.fn(async ({ data }: any) => {
      if (data.idempotencyKey != null && workflowEvents.some(
        (event) => event.companyId === data.companyId && event.idempotencyKey === data.idempotencyKey,
      )) {
        const error: any = new Error('Unique constraint failed');
        error.code = 'P2002';
        error.meta = { target: ['companyId', 'idempotencyKey'] };
        throw error;
      }
      const row = { id: nextId('90000000-0000-4000-8000-'), createdAt: new Date(), ...data };
      workflowEvents.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: any) => workflowEvents.find((event) =>
      matchesScalar(event.companyId, where.companyId)
      && matchesScalar(event.idempotencyKey, where.idempotencyKey)
      && matchesScalar(event.entityType, where.entityType)
      && matchesScalar(event.entityId, where.entityId),
    ) ?? null),
    findMany: vi.fn(async ({ where = {} }: any) => workflowEvents.filter((event) =>
      matchesScalar(event.companyId, where.companyId)
      && matchesScalar(event.entityType, where.entityType)
      && matchesScalar(event.entityId, where.entityId),
    )),
  };

  prisma.supplierQuotation = {
    create: vi.fn(async ({ data }: any) => {
      const { lines: nested, ...rest } = data;
      const now = new Date();
      const row = { id: nextId('a0000000-0000-4000-8000-'), createdAt: now, updatedAt: now, version: 1, ...rest };
      quotations.push(row);
      for (const line of nested?.create ?? []) {
        quotationLines.push({
          id: nextId('b0000000-0000-4000-8000-'),
          companyId: row.companyId,
          supplierQuotationId: row.id,
          createdAt: now,
          updatedAt: now,
          ...line,
          quantity: decimalString(line.quantity),
          unitPrice: decimalString(line.unitPrice),
          lineTotal: decimalString(line.lineTotal),
        });
      }
      return hydrateQuotation(row);
    }),
    findFirst: vi.fn(async ({ where }: any) => {
      const row = quotations.find((item) => quotationMatches(item, where));
      return row ? hydrateQuotation(row) : null;
    }),
    findMany: vi.fn(async ({ where, skip = 0, take = 1000 }: any) =>
      quotations.filter((row) => quotationMatches(row, where)).slice(skip, skip + take).map(hydrateQuotation)),
    update: vi.fn(async ({ where, data }: any) => {
      const row = quotations.find((item) => item.id === where.id);
      if (!row) return null;
      const { lines: nested, version, ...rest } = data;
      Object.assign(row, rest, { updatedAt: new Date() });
      if (version?.increment) row.version = (row.version ?? 1) + version.increment;
      const now = new Date();
      for (const line of nested?.create ?? []) {
        quotationLines.push({
          id: nextId('b0000000-0000-4000-8000-'),
          companyId: row.companyId,
          supplierQuotationId: row.id,
          createdAt: now,
          updatedAt: now,
          ...line,
          quantity: decimalString(line.quantity),
          unitPrice: decimalString(line.unitPrice),
          lineTotal: decimalString(line.lineTotal),
        });
      }
      return hydrateQuotation(row);
    }),
  };

  prisma.supplierQuotationLine = {
    deleteMany: vi.fn(async ({ where }: any) => {
      let removed = 0;
      for (let index = quotationLines.length - 1; index >= 0; index -= 1) {
        const line = quotationLines[index];
        if (matchesScalar(line.companyId, where.companyId)
          && matchesScalar(line.supplierQuotationId, where.supplierQuotationId)) {
          quotationLines.splice(index, 1);
          removed += 1;
        }
      }
      return { count: removed };
    }),
    findMany: vi.fn(async ({ where = {} }: any) => quotationLines.filter((line) =>
      matchesScalar(line.companyId, where.companyId)
      && matchesScalar(line.supplierQuotationId, where.supplierQuotationId))),
  };

  prisma.purchaseReceipt = {
    create: vi.fn(async ({ data }: any) => {
      if (receipts.some((row) => row.companyId === data.companyId && row.idempotencyKey === data.idempotencyKey)) {
        const error: any = new Error('Unique constraint failed');
        error.code = 'P2002';
        error.meta = { target: ['companyId', 'idempotencyKey'] };
        throw error;
      }
      const { lines: nested, ...rest } = data;
      const now = new Date();
      const row = { id: nextId('c0000000-0000-4000-8000-'), createdAt: now, receivedAt: now, ...rest };
      receipts.push(row);
      for (const line of nested?.create ?? []) {
        receiptLines.push({
          id: nextId('d0000000-0000-4000-8000-'),
          companyId: row.companyId,
          purchaseReceiptId: row.id,
          createdAt: now,
          ...line,
          quantity: decimalString(line.quantity),
        });
      }
      return hydrateReceipt(row);
    }),
    findFirst: vi.fn(async ({ where }: any) => {
      const row = receipts.find((item) =>
        matchesScalar(item.id, where.id)
        && matchesScalar(item.companyId, where.companyId)
        && matchesScalar(item.idempotencyKey, where.idempotencyKey)
        && matchesScalar(item.purchaseOrderId, where.purchaseOrderId));
      return row ? hydrateReceipt(row) : null;
    }),
    findMany: vi.fn(async ({ where = {}, skip = 0, take = 1000 }: any) => receipts.filter((row) =>
      matchesScalar(row.companyId, where.companyId)
      && matchesScalar(row.purchaseOrderId, where.purchaseOrderId))
      .slice(skip, skip + take).map(hydrateReceipt)),
    count: vi.fn(async ({ where = {} }: any) => receipts.filter((row) =>
      matchesScalar(row.companyId, where.companyId)
      && matchesScalar(row.purchaseOrderId, where.purchaseOrderId)).length),
  };

  prisma.purchaseReceiptLine = {
    findMany: vi.fn(async ({ where = {} }: any) => receiptLines
      .filter((line) => matchesScalar(line.companyId, where.companyId)
        && matchesScalar(line.purchaseOrderLineId, where.purchaseOrderLineId))
      .map((line) => ({
        ...line,
        receipt: receipts.find((row) => row.id === line.purchaseReceiptId) ?? null,
      }))),
  };

  prisma.purchaseReturn = {
    create: vi.fn(async ({ data }: any) => {
      if (returns.some((row) => row.companyId === data.companyId && row.idempotencyKey === data.idempotencyKey)) {
        const error: any = new Error('Unique constraint failed');
        error.code = 'P2002';
        error.meta = { target: ['companyId', 'idempotencyKey'] };
        throw error;
      }
      const { lines: nested, ...rest } = data;
      const now = new Date();
      const row = { id: nextId('e0000000-0000-4000-8000-'), createdAt: now, updatedAt: now, ...rest };
      returns.push(row);
      for (const line of nested?.create ?? []) {
        returnLines.push({
          id: nextId('f0000000-0000-4000-8000-'),
          companyId: row.companyId,
          purchaseReturnId: row.id,
          createdAt: now,
          ...line,
          quantity: decimalString(line.quantity),
        });
      }
      return hydrateReturn(row);
    }),
    findFirst: vi.fn(async ({ where }: any) => {
      const row = returns.find((item) =>
        matchesScalar(item.id, where.id)
        && matchesScalar(item.companyId, where.companyId)
        && matchesScalar(item.idempotencyKey, where.idempotencyKey)
        && matchesScalar(item.status, where.status)
        && matchesScalar(item.purchaseOrderId, where.purchaseOrderId));
      return row ? hydrateReturn(row) : null;
    }),
    findMany: vi.fn(async ({ where = {}, skip = 0, take = 1000 }: any) => returns.filter((row) =>
      matchesScalar(row.companyId, where.companyId)
      && matchesScalar(row.status, where.status)
      && matchesScalar(row.purchaseOrderId, where.purchaseOrderId)
      && matchesScalar(row.createdAt, where.createdAt))
      .slice(skip, skip + take).map(hydrateReturn)),
    update: vi.fn(async ({ where, data }: any) => {
      const row = returns.find((item) => item.id === where.id);
      if (!row) return null;
      Object.assign(row, data, { updatedAt: new Date() });
      return hydrateReturn(row);
    }),
  };

  prisma.purchaseReturnLine = {
    findMany: vi.fn(async ({ where = {} }: any) => returnLines.filter((line) => {
      if (!matchesScalar(line.companyId, where.companyId)) return false;
      if (!matchesScalar(line.purchaseOrderLineId, where.purchaseOrderLineId)) return false;
      const statusFilter = where.purchaseReturn?.status;
      if (statusFilter) {
        const parent = returns.find((row) => row.id === line.purchaseReturnId);
        if (!parent || !matchesScalar(parent.status, statusFilter)) return false;
      }
      return true;
    })),
  };

  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  prisma._purchasing = {
    departments, users, employees, requests, requestLines, orders, orderLines,
    workflowEvents, quotations, quotationLines, receipts, receiptLines, returns, returnLines,
    hydrateRequest, hydrateOrder, hydrateQuotation, hydrateReceipt, hydrateReturn,
  };
  return prisma;
}

export function addPurchasingIdentity(prisma: any, input: {
  userId: string;
  employeeId: string;
  companyId?: string;
  departmentId?: string | null;
  managerId?: string | null;
  permissions?: string[];
  name?: string;
}) {
  const companyId = input.companyId ?? 'c1';
  if (input.departmentId && !prisma._purchasing.departments.some((row: any) => row.id === input.departmentId)) {
    prisma._purchasing.departments.push({ id: input.departmentId, companyId, name: 'القسم', managerId: input.managerId ?? null });
  }
  prisma._purchasing.employees.push({
    id: input.employeeId, companyId, employeeNum: `EMP-${input.employeeId.slice(-4)}`,
    status: 'active', departmentId: input.departmentId ?? null,
  });
  prisma._purchasing.users.push({
    id: input.userId, companyId, employeeId: input.employeeId,
    name: input.name ?? 'مستخدم', permissions: input.permissions ?? [],
  });
}
