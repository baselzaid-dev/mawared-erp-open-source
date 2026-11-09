import { expect, test } from '@playwright/test';
import { ACCOUNTS, FIXTURE_PASSWORD, signIn } from './support';

test.describe('company web authentication', () => {
  test('requires a company code, identifier, and password', async ({ page }) => {
    await page.goto('/login');
    // All three are required by the form itself; submitting empty must not
    // reach the API or navigate anywhere.
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('rejects wrong credentials without leaving the login screen', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="companyCode"]', ACCOUNTS.full.companyCode);
    await page.fill('input[name="username"]', ACCOUNTS.full.identifier);
    await page.fill('input[name="password"]', 'not-the-fixture-password');
    await page.click('button[type="submit"]');

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('rejects a valid password against the wrong company code', async ({ page }) => {
    // Company binding is part of identity here: the same password must not
    // authenticate against a company the account does not belong to.
    await page.goto('/login');
    await page.fill('input[name="companyCode"]', 'CMP-DOES-NOT-EXIST');
    await page.fill('input[name="username"]', ACCOUNTS.full.identifier);
    await page.fill('input[name="password"]', FIXTURE_PASSWORD);
    await page.click('button[type="submit"]');

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('signs in with a company code and lands on the overview', async ({ page }) => {
    await signIn(page, ACCOUNTS.full);
    await expect(page.locator('nav').first()).toBeVisible();
  });

  test('never persists the session outside memory', async ({ page }) => {
    await signIn(page, ACCOUNTS.full);

    const stored = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
      cookie: document.cookie,
    }));

    // Tokens live in JS memory only. A page reload is therefore expected to
    // end the session — that is the deliberate design, and this asserts it
    // stays deliberate rather than drifting into browser storage.
    expect(stored.local).toBe('{}');
    expect(stored.session).toBe('{}');
    expect(stored.cookie).toBe('');

    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('logging out returns to the login screen', async ({ page }) => {
    await signIn(page, ACCOUNTS.full);
    // Arabic is the default locale, so the control carries its Arabic label.
    await page.getByRole('button', { name: 'تسجيل الخروج' }).first().click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('input[name="companyCode"]')).toBeVisible();
  });

  test('sends no browser fingerprint with the login request', async ({ page }) => {
    const bodies: string[] = [];
    await page.route('**/api/v2/auth/login', async (route) => {
      bodies.push(route.request().postData() ?? '');
      await route.continue();
    });

    await signIn(page, ACCOUNTS.full);

    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]);
    expect(body).toMatchObject({ deviceLabel: 'Mawared Web', platform: 'web' });
    expect(Object.keys(body).sort()).toEqual(
      ['companyCode', 'deviceLabel', 'identifier', 'password', 'platform'].sort(),
    );
  });
});
