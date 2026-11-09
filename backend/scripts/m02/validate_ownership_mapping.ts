import { PrismaClient } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertLocalDatabaseUrl,
  readOwnershipInventorySnapshot,
  resolveProtectedLocalPath,
} from './discover_ownership_candidates.ts';
import {
  buildOwnershipPlan,
  OwnershipMappingValidationError,
} from './ownership_mapping.ts';

const mappingPathFromArgs = (args: string[]): string => {
  const equalsArgument = args.find((argument) => argument.startsWith('--mapping='));
  const positionalIndex = args.indexOf('--mapping');
  const value = equalsArgument?.slice('--mapping='.length)
    ?? (positionalIndex >= 0 ? args[positionalIndex + 1] : undefined);
  if (!value || value.startsWith('--')) {
    throw new Error('An absolute local mapping file is required: --mapping <path>');
  }
  return resolveProtectedLocalPath(value, '--mapping');
};

export const runOwnershipMappingValidatorCli = async (
  args = process.argv.slice(2),
): Promise<void> => {
  assertLocalDatabaseUrl();
  const mappingPath = mappingPathFromArgs(args);
  const mappingCsv = await readFile(mappingPath, 'utf8');
  const prisma = new PrismaClient();
  try {
    const discovery = await readOwnershipInventorySnapshot(prisma);
    const plan = buildOwnershipPlan(mappingCsv, discovery.companies);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
};

const isDirectExecution = Boolean(process.argv[1])
  && resolve(process.argv[1]).toLocaleLowerCase('en-US')
    === resolve(fileURLToPath(import.meta.url)).toLocaleLowerCase('en-US');

if (isDirectExecution) {
  runOwnershipMappingValidatorCli().catch((error) => {
    if (error instanceof OwnershipMappingValidationError) {
      process.stderr.write(`${JSON.stringify({
        error: error.name,
        issues: error.issues,
      }, null, 2)}\n`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`M02 owner mapping validation failed: ${message}\n`);
    }
    process.exitCode = 1;
  });
}
