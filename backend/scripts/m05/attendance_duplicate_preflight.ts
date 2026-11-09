import { Prisma, PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type AttendancePreflightRow = {
  id: string;
  companyId: string;
  employeeId: string;
  date: Date;
};

export type AttendanceDuplicateGroup = {
  companyId: string;
  employeeId: string;
  utcDay: string;
  rowCount: number;
  attendanceIds: string[];
};

export type UniqueEnforcementRecommendation = 'SAFE_ON_CLEAN_TEST_ONLY' | 'DEFER';

export type AttendanceDuplicatePreflightReport = {
  tool: 'm05-attendance-duplicate-preflight';
  mode: 'read_only';
  scannedRowCount: number;
  uniqueDayKeyCount: number;
  duplicateGroupCount: number;
  duplicateRowCount: number;
  extraRowCount: number;
  duplicateGroups: AttendanceDuplicateGroup[];
  uniqueEnforcementRecommendation: UniqueEnforcementRecommendation;
  uniqueConstraintStatus: 'DEFERRED_DO_NOT_ADD_IN_THIS_TASK';
  notes: string[];
};

type AttendancePreflightDatabase = {
  attendance: {
    findMany: (args: {
      select: {
        id: true;
        companyId: true;
        employeeId: true;
        date: true;
      };
      orderBy: Array<
        | { companyId: 'asc' }
        | { employeeId: 'asc' }
        | { date: 'asc' }
        | { id: 'asc' }
      >;
    }) => Promise<AttendancePreflightRow[]>;
  };
  $transaction: <T>(
    callback: (transaction: AttendancePreflightDatabase) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ) => Promise<T>;
  $executeRaw?: (query: Prisma.Sql) => Promise<number>;
};

const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const assertLocalDatabaseUrl = (databaseUrl: string | null | undefined): void => {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required and must point to a local PostgreSQL database');
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid local PostgreSQL URL');
  }
  const hostname = parsed.hostname.toLocaleLowerCase('en-US');
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !LOCAL_DATABASE_HOSTS.has(hostname)) {
    throw new Error('M05 attendance duplicate preflight refuses non-local DATABASE_URL hosts');
  }
};

export const normalizeUtcCalendarDay = (value: Date): string => {
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth() + 1;
  const day = value.getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

export const buildAttendanceDayKey = (
  companyId: string,
  employeeId: string,
  date: Date,
): string => `${companyId}\u0000${employeeId}\u0000${normalizeUtcCalendarDay(date)}`;

const compareDuplicateGroups = (
  left: AttendanceDuplicateGroup,
  right: AttendanceDuplicateGroup,
): number => left.companyId.localeCompare(right.companyId, 'en-US')
  || left.employeeId.localeCompare(right.employeeId, 'en-US')
  || left.utcDay.localeCompare(right.utcDay, 'en-US');

export const analyzeAttendanceDuplicates = (
  rows: AttendancePreflightRow[],
): AttendanceDuplicatePreflightReport => {
  const grouped = new Map<string, AttendancePreflightRow[]>();
  for (const row of rows) {
    const key = buildAttendanceDayKey(row.companyId, row.employeeId, row.date);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }

  const duplicateGroups: AttendanceDuplicateGroup[] = [];
  let duplicateRowCount = 0;
  let extraRowCount = 0;

  for (const bucket of grouped.values()) {
    if (bucket.length <= 1) continue;
    const sample = bucket[0];
    const attendanceIds = bucket.map((row) => row.id).sort((left, right) => left.localeCompare(right, 'en-US'));
    duplicateGroups.push({
      companyId: sample.companyId,
      employeeId: sample.employeeId,
      utcDay: normalizeUtcCalendarDay(sample.date),
      rowCount: bucket.length,
      attendanceIds,
    });
    duplicateRowCount += bucket.length;
    extraRowCount += bucket.length - 1;
  }

  duplicateGroups.sort(compareDuplicateGroups);

  const notes = [
    'This tool performs read-only duplicate detection for (companyId, employeeId, UTC calendar day).',
    'Do NOT add UNIQUE (companyId, employeeId, date) in this task; constraint enforcement remains deferred.',
    'Production and Staging inspection requires separate explicit approval; this CLI refuses non-local DATABASE_URL.',
    'SAFE_ON_CLEAN_TEST_ONLY means zero duplicates were found in the scanned dataset only; it is not production clearance.',
  ];

  return {
    tool: 'm05-attendance-duplicate-preflight',
    mode: 'read_only',
    scannedRowCount: rows.length,
    uniqueDayKeyCount: grouped.size,
    duplicateGroupCount: duplicateGroups.length,
    duplicateRowCount,
    extraRowCount,
    duplicateGroups,
    uniqueEnforcementRecommendation: duplicateGroups.length === 0
      ? 'SAFE_ON_CLEAN_TEST_ONLY'
      : 'DEFER',
    uniqueConstraintStatus: 'DEFERRED_DO_NOT_ADD_IN_THIS_TASK',
    notes,
  };
};

export const readAttendancePreflightRows = async (
  database: AttendancePreflightDatabase,
): Promise<AttendancePreflightRow[]> => database.$transaction(async (transaction) => {
  if (transaction.$executeRaw) {
    await transaction.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
  }
  return transaction.attendance.findMany({
    select: {
      id: true,
      companyId: true,
      employeeId: true,
      date: true,
    },
    orderBy: [
      { companyId: 'asc' },
      { employeeId: 'asc' },
      { date: 'asc' },
      { id: 'asc' },
    ],
  });
}, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

export const runAttendanceDuplicatePreflight = async (
  database: AttendancePreflightDatabase,
): Promise<AttendanceDuplicatePreflightReport> => {
  const rows = await readAttendancePreflightRows(database);
  return analyzeAttendanceDuplicates(rows);
};

export const runAttendanceDuplicatePreflightCli = async (
  args = process.argv.slice(2),
): Promise<AttendanceDuplicatePreflightReport> => {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write([
      'Usage: npm exec -- tsx scripts/m05/attendance_duplicate_preflight.ts',
      '',
      'Read-only duplicate scan for Attendance (companyId, employeeId, UTC calendar day).',
      'Refuses non-local DATABASE_URL. Does not mutate data or add unique constraints.',
      'Production/Staging inspection requires separate explicit approval.',
      '',
    ].join('\n'));
    process.exitCode = 0;
    return analyzeAttendanceDuplicates([]);
  }

  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prisma = new PrismaClient();
  try {
    const report = await runAttendanceDuplicatePreflight(
      prisma as unknown as AttendancePreflightDatabase,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.uniqueEnforcementRecommendation !== 'SAFE_ON_CLEAN_TEST_ONLY') {
      process.exitCode = 1;
    }
    return report;
  } finally {
    await prisma.$disconnect();
  }
};

const isDirectExecution = Boolean(process.argv[1])
  && resolve(process.argv[1]).toLocaleLowerCase('en-US')
    === resolve(fileURLToPath(import.meta.url)).toLocaleLowerCase('en-US');

if (isDirectExecution) {
  runAttendanceDuplicatePreflightCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`M05 attendance duplicate preflight failed: ${message}\n`);
    process.exitCode = 1;
  });
}
