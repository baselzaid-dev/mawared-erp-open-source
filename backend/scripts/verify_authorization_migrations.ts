import { PrismaClient } from '@prisma/client';

function localVerificationUrl(raw: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(raw ?? '');
  } catch {
    throw new Error('A disposable PostgreSQL verification database is required');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port
    || !/^\/dm_[a-z0-9_]+$/.test(url.pathname)
    || [...url.searchParams].some(([name, value]) => name !== 'schema' || value !== 'public')
  ) {
    throw new Error('Verification requires a disposable dm_ database on loopback');
  }
  return url;
}

const database = localVerificationUrl(process.env.DATABASE_URL);
const direct = localVerificationUrl(process.env.DIRECT_URL);
if (database.host !== direct.host || database.pathname !== direct.pathname) {
  throw new Error('Verification database URLs must target the same database');
}
const prisma = new PrismaClient();

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const expectRejected = async (
  label: string,
  expectedMessages: string | readonly string[],
  action: () => Promise<unknown>,
): Promise<void> => {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const acceptedMessages = typeof expectedMessages === 'string'
      ? [expectedMessages]
      : expectedMessages;
    assert(
      acceptedMessages.some((expectedMessage) => message.includes(expectedMessage)),
      `${label}: rejected for an unexpected reason: ${message}`,
    );
    process.stdout.write(`${label}: PASS\n`);
    return;
  }
  throw new Error(`${label}: expected the database to reject the transaction`);
};

async function main(): Promise<void> {
  const companies = await prisma.company.findMany({ select: { id: true } });
  assert(companies.length > 0, 'migration verification requires the disposable seed');

  const ownerCounts = await prisma.companyOwnership.groupBy({
    by: ['companyId'],
    where: { isPrimary: true, status: 'active' },
    _count: { _all: true },
  });
  const ownerCountByCompany = new Map(ownerCounts.map((row) => [row.companyId, row._count._all]));
  for (const company of companies) {
    assert(ownerCountByCompany.get(company.id) === 1, `company ${company.id} does not have exactly one active Primary Owner`);
  }
  process.stdout.write('one active Primary Owner per company: PASS\n');

  const legacyManagers = await prisma.department.findMany({
    where: { managerId: { not: null } },
    select: { id: true, companyId: true, managerId: true },
  });
  for (const manager of legacyManagers) {
    const membership = await prisma.departmentManager.count({
      where: {
        companyId: manager.companyId,
        departmentId: manager.id,
        userId: manager.managerId!,
        status: 'active',
      },
    });
    assert(membership === 1, `legacy manager backfill mismatch for department ${manager.id}`);
  }
  process.stdout.write('legacy/new Department Manager compatibility: PASS\n');

  const invalidVersions = await prisma.user.count({ where: { authorizationVersion: { lt: 1 } } });
  assert(invalidVersions === 0, 'authorizationVersion invariant failed');
  process.stdout.write('authorizationVersion invariant: PASS\n');

  const seededCompany = companies[0];
  const activeOwner = await prisma.companyOwnership.findFirstOrThrow({
    where: { companyId: seededCompany.id, isPrimary: true, status: 'active' },
  });
  const alternateUser = await prisma.user.findFirstOrThrow({
    where: { companyId: seededCompany.id, id: { not: activeOwner.userId } },
    select: { id: true },
  });

  await expectRejected('new Company without owner', 'must create exactly one active Primary Owner', () => prisma.$transaction(async (tx) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2).toUpperCase()}`;
    await tx.company.create({
      data: { id: `constraint-${suffix}`, code: `T${suffix}`.slice(0, 30), name: 'Constraint verification' },
    });
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  }));

  await expectRejected('second active Primary Owner', [
    'activePrimaryCompanyId',
    'must have exactly one active Primary Owner',
  ], () => prisma.$transaction(async (tx) => {
    await tx.companyOwnership.create({
      data: {
        companyId: seededCompany.id,
        userId: alternateUser.id,
        isPrimary: true,
        status: 'active',
        createdByUserId: activeOwner.userId,
      },
    });
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  }));

  await expectRejected('zero active Primary Owners', 'cannot remove its final active Primary Owner', () => prisma.$transaction(async (tx) => {
    await tx.companyOwnership.update({
      where: { id: activeOwner.id },
      data: {
        status: 'ended',
        endedAt: new Date(),
        endedByUserId: activeOwner.userId,
      },
    });
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  }));

  await expectRejected('ownership row reparenting', 'cannot change companyId or userId', () =>
    prisma.companyOwnership.update({
      where: { id: activeOwner.id },
      data: { userId: alternateUser.id },
    }),
  );

  const activeOwnersAfterRejectedWrites = await prisma.companyOwnership.count({
    where: { companyId: seededCompany.id, isPrimary: true, status: 'active' },
  });
  assert(activeOwnersAfterRejectedWrites === 1, 'rejected owner writes were not rolled back');

  const rlsTables = [
    'CompanyOwnership',
    'OwnershipTransfer',
    'DepartmentManager',
    'AccessGrant',
    'TemporaryDelegation',
    'DelegationCapability',
    'PermissionChangeBatch',
    'PermissionChangeHistory',
  ];
  const rlsRows = await prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
    SELECT c.relname, c.relrowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = ANY(${rlsTables})
  `;
  const rlsByTable = new Map(rlsRows.map((row) => [row.relname, row.relrowsecurity]));
  for (const table of rlsTables) {
    assert(rlsByTable.get(table) === true, `RLS is not enabled for ${table}`);
  }
  process.stdout.write('authorization-table RLS: PASS\n');
  process.stdout.write('Sprint 12C migration verification: PASS\n');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Authorization verification failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
