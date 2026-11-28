import { execSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';

// The design pass (docs/DESIGN_SYSTEM.md, docs/design/HANDOFF.md): the current tab is marked, the skip link reaches the
// page, nothing scrolls sideways at 390 px in either scheme, and the two-key state reads in words on Approvals.
const ORG = '/o/juniper-rowan';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL_SYSTEM ?? process.env.DATABASE_URL, max: 1 });

async function signIn(browser: Browser, email: string, opts: Parameters<Browser['newContext']>[0] = {}): Promise<Page> {
  const page = await (await browser.newContext(opts)).newPage();
  await page.goto('/demo');
  await page.getByRole('button', { name: email }).click();
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
  return page;
}
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  await db.query('DELETE FROM "RateLimit"'); // the server sees every local run as one IP
  execSync('npm run seed:couple:test');
});
test.afterAll(() => db.end());

test('the current tab is marked, and the skip link lands on the page', async ({ browser }) => {
  const juniper = await signIn(browser, 'juniper@knotwork.demo.test');
  await juniper.goto(`${ORG}/wedding/schedule`);
  const wedding = juniper.getByRole('navigation', { name: 'Wedding' });
  await expect(wedding.getByRole('link', { name: 'Schedule' })).toHaveAttribute('aria-current', 'page');
  await expect(wedding.getByRole('link', { name: 'Budget' })).not.toHaveAttribute('aria-current', 'page');
  await juniper.keyboard.press('Tab');
  await expect(juniper.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await juniper.keyboard.press('Enter');
  await expect(juniper.locator('#content')).toBeFocused();
});

test('at 390 px nothing scrolls sideways, in light and in dark', async ({ browser }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const page = await signIn(browser, 'juniper@knotwork.demo.test', { viewport: { width: 390, height: 844 }, colorScheme });
    for (const path of ['', '/wedding/dashboard', '/wedding/schedule', '/wedding/budget', '/wedding/vendors', '/wedding/guests', '/wedding/guests/chase', '/wedding/guests/seating', '/wedding/approvals', '/wedding/gifts', '/wedding/photos']) {
      await page.goto(`${ORG}${path}`);
      expect(await sideways(page), `${colorScheme} ${path || '/'}`).toBe(0);
    }
  }
});

test('Approvals shows the keys: one turned by the proposer, the second waiting', async ({ browser }) => {
  const juniper = await signIn(browser, 'juniper@knotwork.demo.test');
  await juniper.goto(`${ORG}/wedding/date?to=2027-12-03`);
  await juniper.getByRole('button', { name: 'Propose this move' }).click();
  await expect(juniper).toHaveURL(new RegExp(`${ORG}/wedding/approvals$`)); // the proposal redirects here once it is stored
  await expect(juniper.getByRole('article', { name: /^Your request: Move the wedding/ })).toContainText("Your key is turned; your partner's is the second");
  const rowan = await signIn(browser, 'rowan@knotwork.demo.test', { viewport: { width: 390, height: 844 } });
  await rowan.goto(`${ORG}/wedding/approvals`);
  const request = rowan.getByRole('article', { name: /^Request: Move the wedding/ });
  await expect(request).toContainText("Juniper Vale's key is turned; yours is the second");
  await expect(request.getByRole('button', { name: 'Approve' })).toBeVisible();
  expect(await sideways(rowan)).toBe(0);
  await juniper.getByRole('article', { name: /^Your request: Move the wedding/ }).getByRole('button', { name: 'Withdraw' }).click();
  await expect(juniper.getByRole('article', { name: /^Your request: Move the wedding/ })).toHaveCount(0);
});

test('review fixes: the current tab is in view on a phone, the wall pauses, and a dead link says so without data', async ({ browser }) => {
  const phone = await signIn(browser, 'juniper@knotwork.demo.test', { viewport: { width: 390, height: 844 } });
  await phone.goto(`${ORG}/wedding/approvals`);
  const tab = phone.getByRole('navigation', { name: 'Wedding' }).getByRole('link', { name: 'Approvals' });
  await expect(tab).toHaveAttribute('aria-current', 'page');
  await expect(tab).toBeInViewport();

  await phone.goto(`${ORG}/wedding/photos`);
  await phone.getByRole('link', { name: 'Reception' }).first().click();
  await phone.getByRole('navigation', { name: 'Photos' }).getByRole('link', { name: 'Wall' }).click();
  await phone.getByRole('button', { name: 'Pause' }).click();
  await expect(phone.getByRole('button', { name: 'Play' })).toBeVisible();

  const stranger = await (await browser.newContext()).newPage();
  const res = await stranger.goto(`/r/${'x'.repeat(43)}`);
  expect(res!.status()).toBe(404);
  await expect(stranger.getByRole('heading', { level: 1 })).toHaveText('This page isn’t here');
  expect(await stranger.locator('main').innerText()).not.toContain('Juniper');
});
