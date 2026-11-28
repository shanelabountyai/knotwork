import { execSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';

// The Phase 4 slice D demo story (docs/knotwork/PHASE-4-PLAN.md, P1-7, P1-5 and D-42), in real browsers:
//   1. The dashboard: Juniper follows the link on the home page and reads every figure in one place; Rowan sees
//      Juniper's private spend counted in the budget and never named; Maple (a budget helper) sees tasks and the budget
//      and nothing else.
//   2. The seating chart: the five guests who are coming sit at two tables. Seating those who have not answered too
//      is refused (ten guests, eight seats: nothing changes, the reason is given); a third table makes it work. A
//      move by hand locks the seat, and a regenerate keeps it.
//   3. The caterer's read-only link: opened with no account it shows the counts and no guest's name, with the
//      no-store, no-referrer headers; replaced, the old link is a 404 like any unknown one.
const ORG = '/o/juniper-rowan';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL_SYSTEM ?? process.env.DATABASE_URL, max: 1 });
let juniper: Page;

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
});
test.afterAll(async () => {
  await db.end();
});

test('the dashboard: every figure in one place, a private spend counted and never named, a helper\'s grants respected', async ({ browser }) => {
  await juniper.goto(ORG);
  await juniper.getByRole('link', { name: 'Progress', exact: true }).first().click();
  await expect(juniper.getByRole('heading', { name: 'Progress', level: 1 })).toBeVisible();
  const section = (p: Page, name: string) => p.getByRole('region', { name });
  await expect(section(juniper, 'Tasks')).toContainText('% on track');
  await expect(section(juniper, 'Tasks')).toContainText('Nothing is overdue.');
  await expect(section(juniper, 'Headcount')).toContainText('12 of 12 seats held (100%)');
  await expect(section(juniper, 'Headcount')).toContainText('Seating: 5 of 5 seated at 2 tables');
  await expect(section(juniper, 'Budget')).toContainText('spent of');
  await expect(section(juniper, 'Thank-you notes')).toContainText('2 unthanked > 3 weeks');
  await expect(section(juniper, 'Contingency plans')).toContainText('1 ready, 0 put into action');
  await expect(section(juniper, 'Approvals')).toContainText('0 waiting for you');

  const rowan = await signIn(browser, 'rowan@knotwork.demo.test');
  await rowan.goto(`${ORG}/wedding/dashboard`);
  await expect(section(rowan, 'Budget')).toContainText('The totals include 1 private line.');
  expect(await rowan.locator('main').innerText()).not.toContain('cufflinks');
  await expect(section(rowan, 'Budget').getByRole('heading')).toHaveText(await section(juniper, 'Budget').getByRole('heading').innerText()); // the same totals

  const maple = await signIn(browser, 'maple@knotwork.demo.test');
  await maple.goto(`${ORG}/wedding/dashboard`);
  await expect(section(maple, 'Tasks')).toBeVisible();
  await expect(section(maple, 'Budget')).toBeVisible();
  for (const name of ['Headcount', 'Approvals', 'Thank-you notes', 'Contingency plans', 'Re-confirmations']) await expect(section(maple, name)).toHaveCount(0);
});

test('the seating chart: a chart that cannot work is refused with its reason; a third table fixes it; a move by hand is kept', async () => {
  await juniper.goto(`${ORG}/wedding/guests`);
  await juniper.getByRole('navigation', { name: 'Wedding' }).getByRole('link', { name: 'Seating' }).click(); // round 2: Seating is a Guests tab of its own
  await expect(juniper.getByLabel('Seating summary')).toContainText('5 of 5 guests seated at 2 tables (8 seats).');
  await juniper.getByRole('button', { name: 'Also seat guests who have not answered' }).click();
  await expect(juniper.getByLabel('Seating summary')).toContainText('5 of 10 guests seated');
  await juniper.getByRole('button', { name: 'Generate seating' }).click();
  await expect(juniper.locator('main').getByRole('alert')).toContainText('There are 10 guests to seat and 8 seats at the tables. Nothing was changed.');
  await expect(juniper.getByLabel('Seating summary')).toContainText('5 of 10 guests seated');

  await juniper.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Table 3');
  await juniper.getByRole('textbox', { name: 'Seats' }).last().fill('4');
  await juniper.getByRole('button', { name: 'Add table' }).click();
  await expect(juniper.getByRole('region', { name: 'Table Table 3' })).toBeVisible();
  await juniper.getByRole('button', { name: 'Generate seating' }).click();
  await expect(juniper.getByLabel('Seating summary')).toContainText('10 of 10 guests seated at 3 tables (12 seats).');

  // Ruth moves to Table 3 by hand (if it is full, someone there stands up first), and her seat is then locked.
  const t3 = juniper.getByRole('region', { name: 'Table Table 3' });
  const ruthAt = await juniper.getByRole('region', { name: /^Table / }).filter({ hasText: 'Ruth Stern' }).getAttribute('aria-label');
  if (ruthAt !== 'Table Table 3') {
    if (await t3.getByText('(4 of 4)').count()) {
      const someone = (await t3.locator('li').first().innerText()).split(' (')[0]!;
      await juniper.getByLabel(`Move ${someone} to`).selectOption({ label: 'No table' });
      await juniper.getByRole('button', { name: `Move ${someone}`, exact: true }).click();
      await expect(juniper.getByLabel('Seating summary')).toContainText('9 of 10 guests seated');
    }
    await juniper.getByLabel('Move Ruth Stern to').selectOption({ label: 'Table 3' });
    await juniper.getByRole('button', { name: 'Move Ruth Stern', exact: true }).click();
  } else {
    await juniper.getByRole('button', { name: 'Lock Ruth Stern' }).click();
  }
  await expect(t3).toContainText('Ruth Stern (Ruth Stern, not answered) locked');
  await juniper.getByRole('button', { name: 'Try another arrangement' }).click();
  await expect(juniper.getByRole('region', { name: 'Table Table 3' })).toContainText('Ruth Stern (Ruth Stern, not answered) locked');
  await expect(juniper.getByLabel('Seating summary')).toContainText('10 of 10 guests seated');
});

test('the caterer\'s read-only link: counts and no names, no-store and no-referrer; replaced, the old one is a 404', async ({ browser, request }) => {
  await juniper.goto(`${ORG}/wedding/vendors`);
  await juniper.getByRole('link', { name: 'Fennel & Fig Catering' }).click();
  await juniper.getByRole('button', { name: 'Show the vendor link' }).click();
  const first = new URL((await juniper.getByRole('status').filter({ hasText: '/v/' }).textContent())!.trim().split(' ')[0]!).pathname;

  const vendor = await (await browser.newContext()).newPage(); // no account, no cookie
  const res = await vendor.goto(first);
  expect(res!.status()).toBe(200);
  expect(res!.headers()['cache-control']).toContain('no-store');
  expect(res!.headers()['referrer-policy']).toBe('no-referrer');
  expect(res!.headers()['x-robots-tag']).toContain('noindex');
  await expect(vendor.getByRole('heading', { level: 1 })).toHaveText('Juniper & Rowan');
  const brief = vendor.getByLabel('Vendor brief');
  await expect(brief).toContainText('COUNTS');
  await expect(brief).toContainText('Confirmed so far: 5 attending');
  const text = await vendor.locator('main').innerText();
  for (const name of ['Linda', 'Lindqvist', 'Hal Ashby', 'Io Ashby', 'Cedar Hollow', 'Wild Rye']) expect(text, name).not.toContain(name);

  await juniper.getByRole('button', { name: 'Replace the vendor link' }).click();
  const second = new URL((await juniper.getByRole('status').filter({ hasText: 'is the new link' }).textContent())!.trim().split(' ')[0]!).pathname;
  expect(second).not.toBe(first);
  const unknown = await request.get(`/v/${'A'.repeat(43)}`);
  const malformed = await request.get('/v/x');
  const replaced = await request.get(first);
  expect([unknown.status(), malformed.status(), replaced.status()]).toEqual([404, 404, 404]);
  expect((await request.get(second)).status()).toBe(200);
});
