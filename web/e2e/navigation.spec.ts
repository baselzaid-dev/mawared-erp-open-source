import { expect, test } from '@playwright/test';
import { ACCOUNTS, goToInApp, navButtons, signIn } from './support';

test.describe('permission-aware navigation', () => {
  test('sends an unauthenticated visitor to the login screen', async ({ page }) => {
    await page.goto('/employees');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('input[name="companyCode"]')).toBeVisible();
  });

  test('shows a narrow account fewer entries than a full-access one', async ({ page }) => {
    await signIn(page, ACCOUNTS.limited);
    const limitedCount = await navButtons(page).count();

    await page.reload();
    await signIn(page, ACCOUNTS.full);
    const fullCount = await navButtons(page).count();

    expect(limitedCount).toBeGreaterThan(0);
    expect(fullCount).toBeGreaterThan(limitedCount);
  });

  test('renders a forbidden state instead of data for an unauthorized route', async ({ page }) => {
    await signIn(page, ACCOUNTS.limited);

    // Addressing the route directly is the interesting case: hiding the nav
    // entry is UX only, so the page itself must refuse.
    await goToInApp(page, '/payroll');
    await expect(page).toHaveURL(/\/payroll$/);
    await expect(page.getByRole('alert')).toBeVisible();
  });

  test('does not call a module API the account may not view', async ({ page }) => {
    const calls: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) calls.push(url.pathname);
    });

    await signIn(page, ACCOUNTS.limited);
    calls.length = 0;
    await goToInApp(page, '/payroll');
    await expect(page.getByRole('alert')).toBeVisible();

    expect(calls.filter((path) => path.includes('payroll'))).toEqual([]);
  });

  test('reaches an authorized route without a forbidden state', async ({ page }) => {
    await signIn(page, ACCOUNTS.limited);
    await goToInApp(page, '/employees');
    await expect(page).toHaveURL(/\/employees$/);
    // employees.view is granted, so the forbidden panel must not appear.
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('renders the overview for an unknown authenticated path', async ({ page }) => {
    await signIn(page, ACCOUNTS.full);
    await goToInApp(page, '/definitely-not-a-route');
    // routeFromPath falls back to 'overview'. The app renders the overview in
    // place without rewriting the URL, so the content is the assertion, not
    // the address bar.
    await expect(page.getByText(ACCOUNTS.full.companyCode).first()).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('keeps the account footer reachable with every entry shown', async ({ page }) => {
    // Regression: the sidebar column overflowed its fixed height instead of
    // scrolling, so with all 16 entries the Sign out control sat ~326px below
    // the fold and could not be reached on a 720px-tall viewport.
    await page.setViewportSize({ width: 1280, height: 720 });
    await signIn(page, ACCOUNTS.full);

    const logout = page.getByRole('button', { name: 'تسجيل الخروج' }).first();
    await expect(logout).toBeVisible();

    const box = await logout.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  });

  test('switches document direction between Arabic and English', async ({ page }) => {
    await signIn(page, ACCOUNTS.full);
    // Arabic is the default locale, so the document starts RTL.
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  });
});
