import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests receive only explicitly supplied process variables. They must never
  // auto-load the developer or deployment .env file.
  envDir: 'tests/.vitest-env-disabled',
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
