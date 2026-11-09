import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';
import { assertLocalDatabaseEnvironment } from '../scripts/local-database.mjs';
import { Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import {
  normalizeEmail,
  normalizeEmployeeNumber,
  normalizeLoginIdentifier,
} from '../src/identity';

dotenv.config({ quiet: true });
assertLocalDatabaseEnvironment();
const seedPassword = process.env.MAWARED_DEV_SEED_PASSWORD ?? '';
if (Buffer.byteLength(seedPassword) < 20 || Buffer.byteLength(seedPassword) > 72 || !seedPassword.trim()) {
  throw new Error('MAWARED_DEV_SEED_PASSWORD must contain 20 to 72 bytes');
}
const prisma = new PrismaClient();

async function main() {

  await prisma.$transaction(async (tx) => {
  const company = await tx.company.upsert({
    where: { id: '1' },
    update: {},
    create: { id: '1', code: 'CMP-DEMO', name: 'Mawared Demo Company' }
  });

  const roles = [
    { name: 'Admin', permissions: ['admin.full', 'company.settings.manage', 'company.sessions.manage', 'permissions.manage_company', 'permissions.delegate_temporary', 'principals.manage_peers', 'employees.permissions.manage'] },
    { name: 'HR Manager', permissions: ['hr.view', 'hr.manage', 'employees.view', 'employees.create', 'employees.update', 'employees.credentials.create', 'employees.credentials.reset', 'employees.archive', 'attendance.view', 'attendance.manage', 'leaves.view', 'leaves.review', 'leaves.approve', 'leaves.reject', 'leaves.escalate', 'reports.view', 'reports.export', 'reports.composite.view', 'reports.templates.manage', 'notifications.view', 'salary.view_company', 'salary.manage', 'salary.view_owner', 'payroll.view', 'payroll.manage', 'payroll.item.adjust', 'payroll.report', 'tasks.view_company', 'tasks.create', 'tasks.assign_company', 'tasks.review', 'tasks.edit', 'tasks.comment.create', 'tasks.attachment.manage', 'training.view_company', 'training.manage', 'training.assign', 'training.review', 'training.report', 'training.certificate.issue', 'training.evaluation.create', 'training.evaluation.view', 'chat.view', 'chat.create_direct', 'chat.create_department', 'chat.create_company_announcement', 'chat.pin'] },
    { name: 'Department Manager', permissions: ['employees.view_department', 'employees.permissions.manage', 'permissions.manage_department', 'permissions.delegate_temporary', 'attendance.view_department', 'attendance.clock', 'leaves.create', 'leaves.view_own', 'reports.export', 'notifications.view', 'tasks.view_department', 'tasks.create', 'tasks.assign_department', 'tasks.review', 'tasks.edit', 'tasks.comment.create', 'tasks.attachment.manage', 'training.view_own', 'training.view_department', 'training.report', 'training.evaluation.create', 'training.evaluation.view', 'chat.view', 'chat.create_direct', 'chat.create_department', 'chat.pin', 'purchasing.view_own', 'purchasing.view_department', 'purchasing.create', 'purchasing.review_department'] },
    { name: 'Employee', permissions: ['dashboard.self', 'attendance.view_own', 'attendance.clock', 'leaves.create', 'leaves.view_own', 'notifications.view', 'tasks.view_own', 'tasks.comment.create', 'tasks.attachment.manage', 'training.view_own', 'chat.view', 'chat.create_direct', 'purchasing.view_own', 'purchasing.create'] },
    { name: 'Accountant', permissions: ['payroll.view', 'payroll.report', 'finance.view', 'reports.finance', 'reports.export', 'notifications.view', 'training.view_own', 'chat.view', 'chat.create_direct', 'purchasing.report'] },
    // W2 seed note: quotation capture/award and raising a return sit with
    // Purchasing; approving a return sits with Finance, so the same seeded role
    // never both raises and approves a supplier claim.
    { name: 'Finance Manager', permissions: ['finance.view', 'finance.create', 'finance.approve', 'finance.manage', 'payroll.view', 'payroll.manage', 'payroll.approve', 'payroll.report', 'payroll.pay', 'payroll.payments.view', 'payroll.payments.record', 'payroll.payments.void', 'payroll.item.adjust', 'payroll.period.reopen', 'reports.finance', 'reports.export', 'notifications.view', 'salary.view_company', 'training.view_own', 'chat.view', 'chat.create_direct', 'purchasing.view', 'purchasing.report', 'purchasing.quotation.compare', 'purchasing.return.approve', 'vendors.view'] },
    { name: 'Purchasing Officer', permissions: ['purchasing.view', 'purchasing.create', 'purchasing.approve', 'purchasing.manage', 'purchasing.receive', 'purchasing.report', 'purchasing.quotation.manage', 'purchasing.quotation.compare', 'purchasing.return.create', 'reports.export', 'vendors.view', 'vendors.manage', 'vendors.archive', 'notifications.view', 'training.view_own', 'chat.view', 'chat.create_direct'] }
  ];

  const managedPayrollPermissions = new Set([
    'payroll.view',
    'payroll.manage',
    'payroll.approve',
    'payroll.report',
    'payroll.pay',
    'payroll.payments.view',
    'payroll.payments.record',
    'payroll.payments.void',
    'payroll.item.adjust',
    'payroll.period.reopen',
  ]);

  const managedAuthorizationPermissions = new Set([
    'company.settings.manage',
    'company.sessions.manage',
    'permissions.manage_company',
    'permissions.manage_department',
    'permissions.delegate_temporary',
    'principals.manage_peers',
    'employees.permissions.manage',
  ]);

  const managedTaskPermissions = new Set([
    'tasks.view_own',
    'tasks.view_department',
    'tasks.view_company',
    'tasks.create',
    'tasks.assign_department',
    'tasks.assign_company',
    'tasks.review',
    'tasks.edit',
    'tasks.comment.create',
    'tasks.attachment.manage',
  ]);

  const managedChatPermissions = new Set([
    'chat.view',
    'chat.create_direct',
    'chat.create_department',
    'chat.create_company_announcement',
    'chat.pin',
  ]);

  const managedPurchasingPermissions = new Set([
    'purchasing.view',
    'purchasing.view_own',
    'purchasing.view_department',
    'purchasing.create',
    'purchasing.review_department',
    'purchasing.approve',
    'purchasing.manage',
    'purchasing.receive',
    'purchasing.report',
    'vendors.view',
    'vendors.manage',
  ]);

  const managedTrainingPermissions = new Set([
    'training.view_own',
    'training.view_department',
    'training.view_company',
    'training.manage',
    'training.assign',
    'training.review',
    'training.report',
    'training.certificate.issue',
    'training.evaluation.create',
    'training.evaluation.view',
  ]);

  const managedReportingPermissions = new Set([
    'reports.view',
    'reports.finance',
    'reports.export',
  ]);

  const createdRoles: Record<string, { id: string }> = {};
  for (const r of roles) {
    let role = await tx.role.findFirst({ where: { name: r.name, companyId: company.id } });
    if (role) {
      let currentPermissions = [];
      try {
        const parsed = JSON.parse(role.permissions);
        currentPermissions = Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
      } catch {
        currentPermissions = [];
      }
      const preservedPermissions = currentPermissions.filter(
        (permission) => !managedAuthorizationPermissions.has(permission) &&
          !managedPayrollPermissions.has(permission) &&
          !managedTaskPermissions.has(permission) &&
          !managedChatPermissions.has(permission) &&
          !managedPurchasingPermissions.has(permission) &&
          !managedTrainingPermissions.has(permission) &&
          !managedReportingPermissions.has(permission)
      );
      const nextPermissions = [...new Set([...preservedPermissions, ...r.permissions])];
      role = await tx.role.update({ where: { id: role.id }, data: { permissions: JSON.stringify(nextPermissions) } });
    } else {
      role = await tx.role.create({ data: { name: r.name, companyId: company.id, permissions: JSON.stringify(r.permissions) } });
    }
    createdRoles[r.name] = role;
  }

  let engDept = await tx.department.findFirst({ where: { name: 'Engineering', companyId: company.id } });
  if (!engDept) {
    engDept = await tx.department.create({ data: { name: 'Engineering', companyId: company.id } });
  }

  const users = [
    { email: 'admin@demo.example.test', name: 'Admin User', roleName: 'Admin', title: 'CEO' },
    { email: 'hr@demo.example.test', name: 'HR User', roleName: 'HR Manager', title: 'HR Director' },
    { email: 'manager@demo.example.test', name: 'Engineering Manager', roleName: 'Department Manager', title: 'Engineering Manager', deptId: engDept.id },
    { email: 'emp@demo.example.test', name: 'Basic Employee', roleName: 'Employee', title: 'Software Engineer', deptId: engDept.id },
    { email: 'accountant@demo.example.test', name: 'Accountant User', roleName: 'Accountant', title: 'Accountant' },
    { email: 'finance@demo.example.test', name: 'Finance Manager', roleName: 'Finance Manager', title: 'CFO' },
    { email: 'purchasing@demo.example.test', name: 'Purchasing Officer', roleName: 'Purchasing Officer', title: 'Procurement' }
  ];

  for (const u of users) {
    const role = createdRoles[u.roleName];
    if (!role) continue;

    const employeeNum = 'EMP-' + u.email;
    const normalizedEmail = normalizeEmail(u.email);
    const normalizedEmployeeNum = normalizeEmployeeNumber(employeeNum);

    let emp = await tx.employee.findFirst({
      where: { companyId: company.id, normalizedEmployeeNum },
    });
    if (!emp) {
      emp = await tx.employee.create({
        data: {
          companyId: company.id,
          employeeNum,
          normalizedEmployeeNum,
          jobTitle: u.title,
          joiningDate: new Date(),
          departmentId: u.deptId || null
        }
      });
    } else if (emp.normalizedEmployeeNum !== normalizedEmployeeNum) {
      emp = await tx.employee.update({
        where: { id: emp.id },
        data: { normalizedEmployeeNum },
      });
    }

    let user = await tx.user.findFirst({
      where: { companyId: company.id, normalizedEmail },
    });
    if (user) {
      user = await tx.user.update({
        where: { id: user.id },
        data: { roleId: role.id, employeeId: emp.id, normalizedEmail }
      });
    } else {
      const password = u.roleName === 'Admin' ? seedPassword : randomBytes(32).toString('base64url');
      user = await tx.user.create({
        data: {
          companyId: company.id,
          email: u.email,
          normalizedEmail,
          password: await bcrypt.hash(password, 12),
          name: u.name,
          roleId: role.id,
          employeeId: emp.id
        }
      });
    }

    await tx.loginIdentity.upsert({
      where: {
        companyId_userId_type: { companyId: company.id, userId: user.id, type: 'email' },
      },
      update: { normalizedIdentifier: normalizeLoginIdentifier(u.email) },
      create: {
        companyId: company.id,
        userId: user.id,
        type: 'email',
        normalizedIdentifier: normalizeLoginIdentifier(u.email),
      },
    });
    await tx.loginIdentity.upsert({
      where: {
        companyId_userId_type: {
          companyId: company.id,
          userId: user.id,
          type: 'employee_number',
        },
      },
      update: { normalizedIdentifier: normalizeLoginIdentifier(employeeNum) },
      create: {
        companyId: company.id,
        userId: user.id,
        type: 'employee_number',
        normalizedIdentifier: normalizeLoginIdentifier(employeeNum),
      },
    });
  }

  const owner = await tx.user.findFirst({
    where: { companyId: company.id, normalizedEmail: normalizeEmail('admin@demo.example.test') },
    select: { id: true },
  });
  if (!owner) {
    throw new Error('Seed could not resolve the active Primary Owner user.');
  }

  const activeOwnership = await tx.companyOwnership.findFirst({
    where: { companyId: company.id, isPrimary: true, status: 'active', endedAt: null },
    select: { id: true, userId: true },
  });
  if (!activeOwnership) {
    await tx.companyOwnership.create({
      data: {
        companyId: company.id,
        userId: owner.id,
        isPrimary: true,
        status: 'active',
        effectiveAt: new Date(),
        createdByUserId: owner.id,
      },
    });
  } else if (activeOwnership.userId !== owner.id) {
    throw new Error('Seed will not replace an existing active Primary Owner.');
  }

  const engineeringManager = await tx.user.findFirst({
    where: { companyId: company.id, normalizedEmail: normalizeEmail('manager@demo.example.test') },
    select: { id: true },
  });
  if (!engineeringManager) {
    throw new Error('Seed could not resolve the active Engineering manager.');
  }

  await tx.department.update({
    where: { id: engDept.id },
    data: { managerId: engineeringManager.id },
  });
  const managerMembership = await tx.departmentManager.findFirst({
    where: {
      companyId: company.id,
      departmentId: engDept.id,
      userId: engineeringManager.id,
      status: 'active',
      endedAt: null,
    },
    select: { id: true },
  });
  if (!managerMembership) {
    await tx.departmentManager.create({
      data: {
        companyId: company.id,
        departmentId: engDept.id,
        userId: engineeringManager.id,
        assignedByUserId: owner.id,
      },
    });
  }
  await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  }, { maxWait: 10_000, timeout: 120_000 });

  console.log('Seed completed successfully.');
}

main()
  .catch((e) => {
    const code = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : 'SEED_ERROR';
    console.error('Local seed failed (' + code + '). Check your local database and configuration.');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
