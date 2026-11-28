import { execSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';

// The Phase 1 demo story (docs/knotwork/PHASE-1-PLAN.md §6, PRD "Capstone demo", first story):
//   1. the date moves six weeks: preview → the partner approves → committed, booked vendors flagged
//   2. a spend over the threshold needs the partner's approval before it reaches the budget
//   3. a vendor-scope change raises a re-confirmation flag, which shows on the dashboard and clears when acknowledged
// Two real browser sessions: Juniper and Rowan, the two partners of the seeded synthetic couple.
const ORG = '/o/juniper-rowan';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL_SYSTEM ?? process.env.DATABASE_URL, max: 1 });

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => day(new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000));
const show = (d: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${d}T00:00:00Z`));
const weddingDate = async () => day((await db.query(`SELECT w.date FROM "Wedding" w JOIN "Org" o ON o.id = w."orgId" WHERE o.slug = 'juniper-rowan'`)).rows[0].date as Date);
const actualCents = async () => Number((await db.query(`SELECT coalesce(sum(e."amountCents"), 0) AS n FROM "Expense" e JOIN "Org" o ON o.id = e."orgId" WHERE o.slug = 'juniper-rowan'`)).rows[0].n);

let juniper: Page;
let rowan: Page;
let from: string;
let to: string;

async function signIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/demo');
  await page.getByRole('button', { name: email }).click();
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
  return page;
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  await db.query('DELETE FROM "RateLimit"'); // the server sees every local run as one IP
  execSync('npm run seed:couple:test'); // a child process, like e2e/demo.spec.ts (F-08)
  from = await weddingDate();
  to = addDays(from, 42);
  juniper = await signIn(browser, 'juniper@knotwork.demo.test');
  rowan = await signIn(browser, 'rowan@knotwork.demo.test');
});
test.afterAll(() => db.end());

test('the date moves six weeks: preview, propose, and it commits only when the partner approves', async () => {
  // Juniper previews the move.
  await juniper.goto(`${ORG}/wedding/date`);
  await juniper.getByLabel('New date').fill(to);
  await juniper.getByRole('button', { name: 'Preview' }).click();
  const summary = juniper.getByRole('list', { name: 'Preview summary' });
  // 24 tasks (20 from the template, 3 payments, the RSVP deadline); 4 are done in the seed (3 template tasks, the paid deposit).
  await expect(summary).toContainText('20 open tasks shift by 42 days');
  await expect(summary).toContainText('0 late after the move');
  await expect(summary).toContainText("0 that can't fit before the new date");
  await expect(juniper.getByRole('region', { name: 'Move preview' })).toContainText(`From ${show(from)} to ${show(to)}: 42 days later`);

  // She proposes it. Nothing has moved.
  await juniper.getByRole('button', { name: 'Propose this move' }).click();
  await expect(juniper).toHaveURL(new RegExp(`${ORG}/wedding/approvals$`));
  await expect(juniper.getByRole('region', { name: 'Waiting for your partner' })).toContainText(`Move the wedding from ${show(from)} to ${show(to)}`);
  await expect(juniper.getByRole('region', { name: 'Waiting for your partner' }).getByRole('button', { name: 'Approve' })).toHaveCount(0); // she cannot approve her own
  expect(await weddingDate()).toBe(from);
  await juniper.goto(ORG);
  await expect(juniper.getByLabel('Wedding date')).toContainText(show(from));

  // Rowan sees the same preview and approves: the commit.
  await rowan.goto(`${ORG}/wedding/approvals`);
  const request = rowan.getByRole('article', { name: /^Request: Move the wedding/ });
  await expect(request.getByRole('list', { name: 'Preview summary' })).toContainText('20 open tasks shift by 42 days');
  await request.getByRole('button', { name: 'Approve' }).click();
  await expect(rowan.getByRole('region', { name: 'Waiting for you', exact: true })).toContainText('Nothing is waiting for you.');
  expect(await weddingDate()).toBe(to);

  // The plan is re-baselined: the wedding date and a task's dates are the new ones (alterations are due 14 days before).
  await rowan.goto(ORG);
  await expect(rowan.getByLabel('Wedding date')).toContainText(show(to));
  await rowan.goto(`${ORG}/wedding/schedule`);
  await expect(rowan.getByRole('row', { name: 'Task Alterations' })).toContainText(show(addDays(to, -14)));
  await expect(rowan.getByRole('row', { name: 'Task Alterations' })).toContainText('on track');
  await expect(rowan.getByRole('table', { name: 'Schedule' }).locator('tbody tr')).toHaveCount(24); // zero orphans: every task is still on the schedule
  await expect(rowan.getByRole('region', { name: 'The longest chain' })).toContainText('Choose the attire');

  // Both booked vendors now need re-confirmation; the florist, only being considered, does not.
  await rowan.goto(`${ORG}/wedding/flags`);
  const open = rowan.getByRole('region', { name: 'Needs re-confirmation' });
  await expect(open.getByRole('listitem')).toHaveCount(2);
  await expect(open).toContainText(`Cedar Hollow Barn: The wedding date moved from ${show(from)} to ${show(to)}`);
  await expect(open).toContainText('Fennel & Fig Catering: The wedding date moved');
  await expect(open).not.toContainText('Wild Rye Flowers');
  // Rowan called both; they confirmed the new date.
  for (const vendor of ['Cedar Hollow Barn', 'Fennel & Fig Catering']) {
    await rowan.getByLabel(`Note for ${vendor}`).fill('Confirmed the new date by phone');
    await rowan.getByRole('button', { name: `Mark ${vendor} re-confirmed` }).click();
    await expect(open).not.toContainText(vendor);
  }
  await expect(open).toContainText('No vendor needs re-confirmation.');
});

test('a spend over the threshold needs the partner before it reaches the budget', async () => {
  const before = await actualCents();
  await juniper.goto(`${ORG}/wedding/budget`);
  await expect(juniper.getByRole('row', { name: 'Category Flowers' })).toContainText('$3,000.00$0.00$3,000.00');
  await juniper.getByLabel('Spend category').selectOption({ label: 'Flowers' });
  await juniper.getByLabel('Spend vendor').selectOption({ label: 'Wild Rye Flowers' });
  await juniper.getByLabel('What it was for').fill('Florist deposit');
  await juniper.getByLabel('Amount').fill('1,200.00');
  await juniper.getByRole('button', { name: 'Record spend' }).click();

  // Over $500.00: it became a request, not a spend.
  await expect(juniper).toHaveURL(new RegExp(`${ORG}/wedding/approvals$`));
  await expect(juniper.getByRole('region', { name: 'Waiting for your partner' })).toContainText('Spend $1,200.00: Florist deposit (Flowers)');
  expect(await actualCents()).toBe(before);
  await juniper.goto(`${ORG}/wedding/budget`);
  await expect(juniper.getByRole('row', { name: 'Category Flowers' })).toContainText('$3,000.00$0.00$3,000.00');
  await expect(juniper.getByRole('table', { name: 'Spends' })).not.toContainText('Florist deposit');

  // Rowan approves; the budget's actual goes up by exactly that amount.
  await rowan.goto(`${ORG}/wedding/approvals`);
  await rowan.getByRole('article', { name: 'Request: Spend $1,200.00: Florist deposit (Flowers)' }).getByRole('button', { name: 'Approve' }).click();
  await expect(rowan.getByRole('region', { name: 'Waiting for you', exact: true })).toContainText('Nothing is waiting for you.');
  expect(await actualCents()).toBe(before + 120_000);
  await rowan.goto(`${ORG}/wedding/budget`);
  await expect(rowan.getByRole('row', { name: 'Category Flowers' })).toContainText('$3,000.00$1,200.00$1,800.00');
  await expect(rowan.getByRole('table', { name: 'Spends' }).getByRole('row', { name: /Florist deposit/ })).toContainText('yes'); // approved by both

  // A small spend goes straight in, with one key.
  await rowan.getByLabel('Spend category').selectOption({ label: 'Flowers' });
  await rowan.getByLabel('What it was for').fill('Ribbon');
  await rowan.getByLabel('Amount').fill('12.50');
  await rowan.getByRole('button', { name: 'Record spend' }).click();
  await expect(rowan.getByRole('row', { name: 'Category Flowers' })).toContainText('$3,000.00$1,212.50$1,787.50');
  expect(await actualCents()).toBe(before + 121_250);
});

test('a vendor-scope change raises a re-confirmation flag, on the dashboard too, until acknowledged', async () => {
  await juniper.goto(`${ORG}/wedding/vendors`);
  await expect(juniper.getByRole('row', { name: 'Vendor Fennel & Fig Catering' })).not.toContainText('needs re-confirmation');
  await juniper.getByRole('link', { name: 'Fennel & Fig Catering' }).click();
  await expect(juniper.getByLabel('Vendor status')).toContainText('booked');

  // A contact edit is not scope: no flag.
  await juniper.getByLabel('Phone').fill('918-555-0143');
  await juniper.getByRole('button', { name: 'Save vendor' }).click();
  await expect(juniper.getByLabel('Phone')).toHaveValue('918-555-0143');
  await expect(juniper.getByRole('region', { name: 'Needs re-confirmation' })).toHaveCount(0);

  // The count is scope: flagged.
  await juniper.getByLabel('Count estimate').fill('132');
  await juniper.getByRole('button', { name: 'Save vendor' }).click();
  await expect(juniper.getByRole('region', { name: 'Needs re-confirmation' })).toContainText('Count estimate changed from 120 to 132');

  // It is on the dashboard and the vendor list, and on the vendor's brief once regenerated.
  await juniper.goto(ORG);
  await expect(juniper.getByRole('region', { name: 'Needs re-confirmation' })).toContainText('Fennel & Fig Catering: Count estimate changed from 120 to 132');
  await expect(juniper.getByRole('list', { name: 'At a glance' })).toContainText('1 vendors need re-confirmation');
  await juniper.goto(`${ORG}/wedding/vendors`);
  await expect(juniper.getByRole('row', { name: 'Vendor Fennel & Fig Catering' })).toContainText('needs re-confirmation');
  await juniper.getByRole('link', { name: 'Fennel & Fig Catering' }).click();
  await juniper.getByRole('button', { name: 'Regenerate brief' }).click();
  await expect(juniper.getByLabel('Vendor brief')).toContainText('NEEDS RE-CONFIRMATION');
  await expect(juniper.getByLabel('Vendor brief')).toContainText('- Estimate: 132');

  // Rowan sees it in the flags list and marks the caterer re-confirmed.
  await rowan.goto(`${ORG}/wedding/flags`);
  const open = rowan.getByRole('region', { name: 'Needs re-confirmation' });
  await expect(open.getByRole('listitem')).toHaveCount(1);
  await rowan.getByLabel('Note for Fennel & Fig Catering').fill('Sam confirmed 132 plates');
  await rowan.getByRole('button', { name: 'Mark Fennel & Fig Catering re-confirmed' }).click();
  await expect(open).toContainText('No vendor needs re-confirmation.');
  await expect(rowan.getByRole('region', { name: 'Re-confirmed', exact: true })).toContainText('Sam confirmed 132 plates');
  await rowan.goto(ORG);
  await expect(rowan.getByRole('list', { name: 'At a glance' })).toContainText('0 vendors need re-confirmation');
});

test('the activity feed has all of it, with who and before/after', async () => {
  await juniper.goto(`${ORG}/wedding/activity`);
  const feed = juniper.getByRole('list', { name: 'Activity' });
  await expect(feed).toContainText(`Rowan Ashby moved the wedding: Juniper & Rowan`);
  await expect(feed).toContainText(`date: ${from} → ${to}`);
  await expect(feed).toContainText('Juniper Vale proposed a request: Spend $1,200.00: Florist deposit (Flowers)');
  await expect(feed).toContainText('Rowan Ashby approved a request: Spend $1,200.00: Florist deposit (Flowers)');
  await expect(feed).toContainText('Juniper Vale changed a vendor: Fennel & Fig Catering');
  await expect(feed).toContainText('countEstimate: 120 → 132');
  await expect(feed).toContainText('Rowan Ashby acknowledged a re-confirmation flag: Fennel & Fig Catering');
});

test('a helper sees the schedule and the budget they were granted, and no approvals', async ({ browser }) => {
  const maple = await signIn(browser, 'maple@knotwork.demo.test');
  await maple.goto(`${ORG}/wedding/schedule`);
  await expect(maple.getByRole('table', { name: 'Schedule' })).toBeVisible();
  await expect(maple.getByRole('region', { name: 'Add a task' })).toHaveCount(0);
  await maple.goto(`${ORG}/wedding/budget`);
  await expect(maple.getByRole('table', { name: 'Budget' })).toBeVisible();
  await expect(maple.getByRole('button', { name: 'Record spend' })).toHaveCount(0);
  expect((await maple.goto(`${ORG}/wedding/approvals`))!.status()).toBe(404);
  expect((await maple.goto(`${ORG}/wedding/vendors`))!.status()).toBe(404);
  await maple.context().close();
});
