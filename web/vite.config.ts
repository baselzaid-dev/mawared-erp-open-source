import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Unit tests live beside the code they cover. Scoping this explicitly
    // matters now that e2e/ exists: Vitest's default glob also matches
    // `*.spec.ts`, so it would otherwise try to execute the Playwright suites
    // in a Node environment, where `@playwright/test` throws at import.
    // `.tsx` is included so component behaviour (the global error boundary)
    // can be covered. Those files opt into a DOM via a per-file
    // `@vitest-environment jsdom` docblock, so the pure-logic suites below keep
    // running in the faster Node environment.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
  },
});
