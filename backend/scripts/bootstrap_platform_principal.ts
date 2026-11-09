import dotenv from 'dotenv';
import { assertLocalDatabaseEnvironment } from './local-database.mjs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { hashPassword } from '../src/credentialSecrets';
import { normalizeEmail } from '../src/identity';
import { PLATFORM_PERMISSIONS } from '../src/platformAuth';

export async function bootstrapPlatformPrincipal(
  prisma: PrismaClient,
  input: { email: string; name: string; password: string },
) {
  const parsed = z.object({
    email: z.string().trim().email().max(320),
    name: z.string().trim().min(2).max(200),
    password: z.string().min(12).max(512),
  }).strict().safeParse(input);
  if (!parsed.success) {
    throw new Error('Platform bootstrap input is invalid');
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtext('mawared-platform-bootstrap-v1'))",
    );
    const existingCount = await tx.platformPrincipal.count();
    if (existingCount !== 0) {
      throw new Error('Platform bootstrap is allowed only when no principal exists');
    }
    return tx.platformPrincipal.create({
      data: {
        email: parsed.data.email,
        normalizedEmail: normalizeEmail(parsed.data.email),
        password: await hashPassword(parsed.data.password),
        name: parsed.data.name,
        status: 'active',
        permissions: JSON.stringify(Object.values(PLATFORM_PERMISSIONS)),
      },
      select: { id: true, email: true, name: true, status: true },
    });
  });
}

async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  assertLocalDatabaseEnvironment();
  const email = process.env.PLATFORM_BOOTSTRAP_EMAIL?.trim();
  const name = process.env.PLATFORM_BOOTSTRAP_NAME?.trim();
  const password = process.env.PLATFORM_BOOTSTRAP_PASSWORD;
  if (!email || !name || !password) {
    throw new Error('Required bootstrap environment values are missing');
  }
  const prisma = new PrismaClient();
  try {
    const principal = await bootstrapPlatformPrincipal(prisma, { email, name, password });
    console.log(`Platform principal created: ${principal.id}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Platform bootstrap failed');
    process.exitCode = 1;
  });
}
