import { execSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';

// Phase 5, slice E, in real browsers (docs/knotwork/PHASE-5-PLAN.md):
//   1. Before moving the date, Juniper follows the preview's link to the insurance information page: labelled general
//      information, the couple's own signed contract and payments, and what the move would leave late.
//   2. A household stops its reminders from the link every reminder carries: the page shows the wedding's title and
//      nothing about the household; opening it changes nothing; one press stops reminders, and the couple sees it.
//   3. The photo classifier's local stub (seeded on the Reception wall) shows its suggestion and reason to the
//      moderator, and advice only.
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
async function linkFor(household: string): Promise<string> {
  await juniper.goto(`${ORG}/wedding/guests`);
  await juniper.getByRole('link', { name: household, exact: true }).click();
  await juniper.getByRole('button', { name: 'Show the RSVP link' }).click();
  return new URL((await juniper.getByRole('status').filter({ hasText: '/r/' }).textContent())!.trim()).pathname;
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

test('the date-move preview links to the insurance information page, with the couple\'s own facts', async () => {
  const { rows } = await db.query<{ d: string }>(`SELECT to_char(w.date - 60, 'YYYY-MM-DD') AS d FROM "Wedding" w JOIN "Org" o ON o.id = w."orgId" WHERE o.slug = 'juniper-rowan'`);
  const earlier = rows[0]!.d;
  await juniper.goto(`${ORG}/wedding/date`);
  await juniper.getByLabel('New date').fill(earlier);
  await juniper.getByRole('button', { name: 'Preview' }).click();
  await juniper.getByRole('link', { name: /Before you decide: contracts, payments and insurance questions/ }).click();
  await expect(juniper).toHaveURL(new RegExp(`/wedding/date/insurance\\?to=${earlier}$`));
  await expect(juniper.getByRole('heading', { name: 'Moving the date: insurance and contracts', level: 1 })).toBeVisible();
  await expect(juniper.getByRole('note')).toContainText('General information, not insurance or legal advice.');
  const facts = juniper.getByRole('region', { name: 'Your facts' });
  await expect(facts).toContainText('60 days earlier');
  await expect(facts.getByRole('list', { name: 'Signed contracts' })).toContainText('Cedar Hollow Barn');
  await expect(facts.getByRole('list', { name: 'Payments made' })).toContainText('Cedar Hollow Barn');
  await expect(juniper.getByRole('region', { name: 'Questions' })).toContainText('Is our reason for moving the date covered under the policy wording?');
  // Nothing on it but the couple's own money: no percentage, no insurer, no price list.
  expect(await juniper.locator('main').textContent()).not.toMatch(/%|per ?cent|\baverage\b/i);
  await juniper.getByRole('link', { name: 'Back to the date move' }).click();
  await expect(juniper).toHaveURL(new RegExp(`/wedding/date\\?to=${earlier}$`));
});

test('a household stops its reminders from its own link: opening the page changes nothing; one press does', async ({ browser, request }) => {
  const path = await linkFor('The Lindqvists');
  const other = await linkFor('The Vales');
  // The stop page is the same for every household: the wedding's title and fixed sentences.
  const pages = await Promise.all([`${path}/stop`, `${other}/stop`].map((p) => request.get(p)));
  for (const r of pages) {
    expect(r.status()).toBe(200);
    expect(r.headers()['referrer-policy']).toBe('no-referrer');
    expect(r.headers()['cache-control']).toContain('no-store');
  }
  const strip = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replaceAll(/\/r\/[\w-]{43}/g, '/r/TOKEN');
  const [a, b] = await Promise.all(pages.map((r) => r.text()));
  expect(strip(b)).toBe(strip(a));
  for (const leak of ['Lindqvist', 'Vale', 'wave', 'B list']) expect(a).not.toContain(leak);
  expect((await request.get(`/r/${'x'.repeat(43)}/stop`)).status()).toBe(404);

  await juniper.goto(`${ORG}/wedding/guests`);
  await juniper.getByRole('link', { name: 'The Lindqvists', exact: true }).click();
  await expect(juniper.getByRole('region', { name: 'Reminders' })).toContainText('Reminders go by email');

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`${path}/stop`);
  await expect(guest.getByRole('heading', { level: 1 })).toHaveText('Juniper & Rowan');
  await guest.getByRole('button', { name: 'Stop reminders' }).click();
  await expect(guest.getByRole('status')).toContainText('Reminders are stopped.');
  await guest.context().close();

  await juniper.reload();
  await expect(juniper.getByRole('region', { name: 'Reminders' })).toContainText('They stopped reminders from their own link');
  await expect(juniper.getByRole('button', { name: 'Save reminder settings' })).toHaveCount(0);
  await juniper.goto(`${ORG}/wedding/guests/chase`);
  await expect(juniper.getByRole('table', { name: 'Not answered' })).toBeVisible();
  await juniper.goto(`${ORG}/wedding/guests`);
  await juniper.getByRole('link', { name: 'Ruth Stern', exact: true }).click();
  await expect(juniper.getByRole('region', { name: 'Reminders' })).toContainText('Reminders go by text message (they agreed on');
});

test('the classifier stub advises the moderator, with its reason, and decides nothing', async () => {
  await juniper.goto(`${ORG}/wedding/photos`);
  await juniper.getByRole('row', { name: 'Photo event Reception' }).getByRole('link', { name: 'Reception' }).click();
  await expect(juniper.getByLabel('Event status')).toContainText('Suggestions for moderators: Local check');
  await juniper.getByRole('navigation', { name: 'Photos' }).getByRole('link', { name: 'Moderate' }).click();
  await expect(juniper.locator('main')).toContainText('A suggestion is advice');
  // The seeded pictures are flat colours: the stub flags each as worth a look, and the moderator still decides.
  const waiting = juniper.getByRole('region', { name: 'Waiting' });
  await expect(waiting).toContainText('Suggestion: Worth a look. Nearly one flat colour');
  await expect(waiting.getByRole('button', { name: /^Approve/ })).toHaveCount(1);
});
