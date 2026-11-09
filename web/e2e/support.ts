import { expect, type Page } from '@playwright/test';

/** Mirrors the fixture accounts in `e2e/fixtures/server.mjs`. */
export const FIXTURE_PASSWORD = 'e2e-fixture-password';

export const ACCOUNTS = {
  /** admin.full — the documented single frontend bypass. */
  full: { companyCode: 'CMP-FULL', identifier: 'full@example.invalid' },
  /** employees.view only — everything else must be hidden and forbidden. */
  limited: { companyCode: 'CMP-LIMITED', identifier: 'limited@example.invalid' },
} as const;

export async function signIn(
  page: Page,
  account: { companyCode: string; identifier: string },
): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="companyCode"]', account.companyCode);
  await page.fill('input[name="username"]', account.identifier);
  await page.fill('input[name="password"]', FIXTURE_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/overview$/);
}

/**
 * Navigate the way the app itself does: push history and let the `popstate`
 * listener re-route client side.
 *
 * `page.goto()` cannot be used after signing in. Tokens are held in JS memory
 * only, so a full document load ends the session and bounces to /login — which
 * is the deliberate design, asserted in auth.spec.ts.
 */
export async function goToInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/**
 * Count entries in the primary navigation.
 *
 * The shell renders the sidebar twice (desktop rail and mobile drawer), so
 * scoping to the first landmark keeps the count meaningful.
 */
export function navButtons(page: Page) {
  return page.locator('nav').first().locator('button');
}
