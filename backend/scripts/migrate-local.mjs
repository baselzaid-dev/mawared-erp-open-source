import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { assertLocalDatabaseEnvironment } from './local-database.mjs';

try {
  dotenv.config({ quiet: true });
  assertLocalDatabaseEnvironment();
  const prisma = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));
  const result = spawnSync(process.execPath, [prisma, 'migrate', 'deploy'], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
