import { defineConfig, devices } from '@playwright/test';

/**
 * Company Web E2E configuration.
 *
 * The suite runs against the REAL production build (`dist/`) served together
 * with a deterministic fixture API from a single origin — see
 * `e2e/fixtures/server.mjs`. Consequences worth stating explicitly:
 *
 *  - No dev server, so what is tested is the artifact that would ship.
 *  - No CORS in the test setup, because everything is same-origin.
 *  - No dependency on remote Staging, real credentials, or a real database,
 *    so the suite is safe to run unattended in CI.
 *
 * Browser matrix: Chromium is the CI-enforced gate. Firefox and WebKit are
 * defined so a developer can run them locally with `--project=firefox` /
 * `--project=webkit`, but they are deliberately NOT part of the CI gate —
 * installing three browser engines on every pull request costs more minutes
 * than the additional signal is currently worth. This is recorded honestly in
 * docs/qa/web-e2e-matrix.md rather than claimed as three-browser coverage.
 */
const PORT = Number(process.env.E2E_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // The fixture API is fixed data, so a flaky run means a real defect.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'node e2e/fixtures/server.mjs',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
  },
});
