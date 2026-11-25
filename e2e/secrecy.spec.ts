import { execSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';

// The Phase 4 slice A demo story (docs/knotwork/PHASE-4-PLAN.md, P1-1 and P1-2), in two real browsers and a third:
//   1. Juniper's surprise is a private spend: Rowan sees a "Private spend" line and the real total; Juniper sees it all.
//   2. Juniper adds a vendor private to her until the wedding day: Rowan's vendor book shows a masked line and its page is a 404.
//   3. Juniper proposes booking it: the proposal reveals it, and Rowan sees what he is asked to approve.
//   4. Hazel, linked to her family's pledge, sees what it paid for and nothing else of the budget.
const ORG = '/o/juniper-rowan';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL_SYSTEM ?? process.env.DATABASE_URL, max: 1 });

let juniper: Page;
let rowan: Page;

async function signIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/demo');
  await page.getByRole('button', { name: email }).click();
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
  return page;
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  await db.query('DELETE FROM "RateLimit"');
  execSync('npm run seed:couple:test');
  juniper = await signIn(browser, 'juniper@knotwork.demo.test');
  rowan = await signIn(browser, 'rowan@knotwork.demo.test');
});
test.afterAll(async () => {
  await db.end();
});

test('a private spend is a masked line for the other partner, and still counts in the total', async () => {
  await rowan.goto(`${ORG}/wedding/budget`);
  const spends = rowan.getByRole('table', { name: 'Spends' });
  await expect(spends).toContainText('Private spend');
  await expect(rowan.locator('main')).not.toContainText('cufflinks');
  await expect(rowan.getByRole('row', { name: 'Budget total' })).toContainText('$2,330.00');
  await expect(rowan.getByRole('note')).toContainText('The totals include 1 private line');
  await juniper.goto(`${ORG}/wedding/budget`);
  await expect(juniper.getByRole('table', { name: 'Spends' })).toContainText('Engraved cufflinks for Rowan');
  await expect(juniper.getByRole('table', { name: 'Spends' })).toContainText('private to you');
});

test('a vendor private until the wedding day: masked in the book, a 404 by its address, revealed by a proposal', async () => {
  await juniper.goto(`${ORG}/wedding/vendors`);
  const add = juniper.locator('form').filter({ has: juniper.getByRole('button', { name: 'Add vendor' }) });
  await add.getByLabel('Name').fill('Glasswing Engravers');
  await add.getByLabel('Who sees it').selectOption('0');
  await add.getByRole('button', { name: 'Add vendor' }).click();
  await expect(juniper.getByRole('heading', { name: 'Glasswing Engravers' })).toBeVisible();
  const url = juniper.url();
  await expect(juniper.getByRole('note')).toContainText('Private to you');

  await rowan.goto(`${ORG}/wedding/vendors`);
  await expect(rowan.getByRole('table', { name: 'Vendors' })).toContainText('Private vendor');
  await expect(rowan.locator('main')).not.toContainText('Glasswing');
  expect((await rowan.goto(url))!.status()).toBe(404);
  await rowan.goto(`${ORG}/wedding/activity`);
  await expect(rowan.locator('main')).not.toContainText('Glasswing');

  await juniper.getByRole('button', { name: 'Propose booking Glasswing Engravers' }).click();
  await expect(juniper.getByRole('heading', { name: 'Approvals' })).toBeVisible();
  await rowan.goto(`${ORG}/wedding/approvals`);
  await expect(rowan.getByRole('region', { name: 'Waiting for you', exact: true })).toContainText('Book Glasswing Engravers');
  await rowan.goto(`${ORG}/wedding/vendors`);
  await expect(rowan.getByRole('table', { name: 'Vendors' })).toContainText('Glasswing Engravers');
});

test('a helper linked to a funder sees that pledge and what it paid for, and nothing else of the budget', async ({ browser }) => {
  const hazel = await signIn(browser, 'hazel@knotwork.demo.test');
  await hazel.goto(`${ORG}/wedding/funding`);
  await expect(hazel.getByRole('heading', { name: 'What you are giving toward' })).toBeVisible();
  const mine = hazel.getByRole('region', { name: 'Funder Hazel & Oren Vale' });
  await expect(mine).toContainText('Pledged $5,000.00 · received $3,000.00 · spent $2,000.00');
  await expect(mine).toContainText('$2,000.00 of Cedar Hollow Barn: Deposit');
  await expect(hazel.locator('main')).not.toContainText('Aunt Wren');
  await expect(hazel.locator('main')).not.toContainText('Catering');
  expect((await hazel.goto(`${ORG}/wedding/budget`))!.status()).toBe(404);
  expect((await hazel.goto(`${ORG}/wedding/vendors`))!.status()).toBe(404);
  await hazel.context().close();

  await rowan.goto(`${ORG}/wedding/funding`);
  await expect(rowan.getByRole('region', { name: 'Funder Aunt Wren Ashby' })).toBeVisible();
  await expect(rowan.getByRole('region', { name: 'Funder Hazel & Oren Vale' })).toContainText('Linked to Hazel Vale');
});
