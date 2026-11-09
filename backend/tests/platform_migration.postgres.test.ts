import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { bootstrapPlatformPrincipal } from '../scripts/bootstrap_platform_principal';

function command(name: string): string | null {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null
    : null;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

const initdb = command('initdb');
const pgCtl = command('pg_ctl');
const createdb = command('createdb');
const psql = command('psql');
const available = Boolean(initdb && pgCtl && createdb && psql);
const suite = available ? describe : describe.skip;

suite('MFA and Platform migrations on disposable PostgreSQL without M02', () => {
  let dataDir = '';
  let port = 0;
  let url = '';
  let prisma: PrismaClient;

  const run = (executable: string, args: string[]) => {
    const result = spawnSync(executable, args, { stdio: 'ignore', windowsHide: true });
    if (result.status !== 0) throw new Error(`${executable} exited ${result.status}`);
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mawared-platform-pg-'));
    port = await freePort();
    run(initdb!, ['-D', dataDir, '--auth=trust', '--username=postgres', '--no-locale', '--encoding=UTF8']);
    run(pgCtl!, ['-D', dataDir, '-o', `-h 127.0.0.1 -p ${port} -c unix_socket_directories=`, '-w', 'start']);
    run(createdb!, ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', 'mawared_platform']);
    url = `postgresql${'://'}postgres@127.0.0.1:${port}/mawared_platform`;
    const baseSql = `
      CREATE TABLE "Company" ("id" TEXT PRIMARY KEY);
      CREATE TABLE "User" (
        "id" TEXT NOT NULL,
        "companyId" TEXT NOT NULL,
        PRIMARY KEY ("id"),
        UNIQUE ("id", "companyId")
      );
      CREATE TABLE "CompanyOwnership" (
        "id" TEXT PRIMARY KEY,
        "companyId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "createdByUserId" TEXT NOT NULL
      );
      CREATE TABLE "AttendanceExemption" (
        "id" TEXT PRIMARY KEY,
        "companyId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "createdByUserId" TEXT NOT NULL
      );
    `;
    run(psql!, ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'mawared_platform', '-v', 'ON_ERROR_STOP=1', '-c', baseSql]);
    run(psql!, ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'mawared_platform', '-v', 'ON_ERROR_STOP=1', '-f', resolve('prisma/migrations/20260721000100_rc2_mfa/migration.sql')]);
    run(psql!, ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'mawared_platform', '-v', 'ON_ERROR_STOP=1', '-f', resolve('prisma/migrations/20260721000200_rc2_platform_control_plane/migration.sql')]);
    prisma = new PrismaClient({ datasources: { db: { url } } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (pgCtl && dataDir) {
      spawnSync(pgCtl, ['-D', dataDir, '-m', 'fast', '-w', 'stop'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('enforces RLS, truthful creators, and serialized bootstrap', async () => {
    const second = new PrismaClient({ datasources: { db: { url } } });
    const attempts = await Promise.allSettled([
      bootstrapPlatformPrincipal(prisma, {
        email: 'platform@example.test',
        name: 'Platform Owner',
        password: 'Platform-password-123!',
      }),
      bootstrapPlatformPrincipal(second, {
        email: 'other@example.test',
        name: 'Other Platform Owner',
        password: 'Platform-password-456!',
      }),
    ]);
    await second.$disconnect();
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.platformPrincipal.count()).toBe(1);
    const platform = await prisma.platformPrincipal.findFirstOrThrow();

    await prisma.$executeRawUnsafe(`INSERT INTO "Company" ("id") VALUES ('c1')`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "User" ("id","companyId") VALUES ('u1','c1')`,
    );
    await prisma.$executeRaw`
      INSERT INTO "CompanyOwnership"
        ("id","companyId","userId","createdByUserId","createdByPlatformPrincipalId")
      VALUES ('o1','c1','u1',NULL,${platform.id})
    `;
    await prisma.$executeRaw`
      INSERT INTO "AttendanceExemption"
        ("id","companyId","userId","createdByUserId","createdByPlatformPrincipalId")
      VALUES ('e1','c1','u1',NULL,${platform.id})
    `;
    await expect(prisma.$executeRaw`
      INSERT INTO "CompanyOwnership"
        ("id","companyId","userId","createdByUserId","createdByPlatformPrincipalId")
      VALUES ('o2','c1','u1','u1',${platform.id})
    `).rejects.toThrow();

    const rls = await prisma.$queryRawUnsafe<Array<{ relname: string; relrowsecurity: boolean }>>(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relname IN ('UserMfaCredential','PlatformPrincipal','PlatformMfaCredential')`,
    );
    expect(rls).toHaveLength(3);
    expect(rls.every((row) => row.relrowsecurity)).toBe(true);
  }, 60_000);
});
