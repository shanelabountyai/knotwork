import { execSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';

// The Phase 5 slice F demo story (docs/knotwork/PHASE-5-PLAN.md, life-admin mode), in real browsers, on the second
// synthetic couple: Sage and Wren married 40 days ago (scripts/knotwork/seed-couple.ts `seedLifeCouple`), so no clock
// has to move. Juniper and Rowan, whose wedding is ahead, stay in planning mode for every other spec.
//   1. The switch takes two keys: Sage proposes it, nothing changes until Wren approves; then the home page is the
//      couple's dashboard (the next anniversary, the thank-you still owed, the venue's contract page, the album).
//   2. A household task: added every 3 months, due now; marked done, it is next due in three months (computed).
//   3. The archive: the plan's pages say they are read-only and offer no form to change them; Ivy, a helper who
//      moderates photos, sees the anniversary and the album and nothing of the couple's own.
//   4. And back: Wren proposes planning mode, Sage approves, and the planning overview returns.
const ORG = '/o/sage-wren';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL_SYSTEM ?? process.env.DATABASE_URL, max: 1 });
let sage: Page;
let wren: Page;

async function signIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/demo');
  await page.getByRole('button', { name: email }).click();
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
  return page;
}
const mode = async () => (await db.query<{ mode: string }>(`SELECT w."mode" FROM "Wedding" w JOIN "Org" o ON o."id" = w."orgId" WHERE o."slug" = 'sage-wren'`)).rows[0]!.mode;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  await db.query('DELETE FROM "RateLimit"');
  execSync('npm run seed:couple:test');
  sage = await signIn(browser, 'sage@knotwork.demo.test');
  wren = await signIn(browser, 'wren@knotwork.demo.test');
});
test.afterAll(async () => {
  await db.end();
});

test('the switch takes both keys; then the home page is the couple\'s dashboard', async () => {
  await sage.goto(ORG);
  const offer = sage.getByRole('region', { name: 'Life-admin mode' });
  await expect(offer).toContainText('The wedding day has passed.');
  await offer.getByRole('button', { name: 'Switch to life-admin mode' }).click();
  await expect(sage).toHaveURL(new RegExp(`${ORG}/wedding/approvals$`));
  await expect(sage.getByRole('region', { name: 'Waiting for your partner' })).toContainText('Switch to life-admin mode');
  expect(await mode()).toBe('planning');

  await wren.goto(`${ORG}/wedding/approvals`);
  const request = wren.getByRole('article', { name: /^Request: Switch to life-admin mode/ });
  await expect(request).toContainText('Switch between planning and life-admin mode');
  await request.getByRole('button', { name: 'Approve' }).click();
  await expect(wren.getByRole('region', { name: 'Waiting for you', exact: true })).toContainText('Nothing is waiting for you.');
  expect(await mode()).toBe('life');

  await sage.goto(ORG);
  await expect(sage.getByRole('region', { name: 'Next anniversary' })).toContainText('1st anniversary');
  await expect(sage.getByRole('region', { name: 'Thank-yous still owed' })).toContainText('Aunt Fern Calder (a cast-iron skillet)');
  await expect(sage.getByRole('region', { name: 'Documents' })).toContainText('Old Mill Hall contract, page 1 (Old Mill Hall)');
  await expect(sage.getByRole('region', { name: 'Photo albums' })).toContainText('Reception: 0 photos');
  await expect(sage.getByRole('list', { name: 'At a glance' })).toHaveCount(0); // the planning overview is in the archive
});

test('a household task recurs by its rule: due now, then three months after it was done', async () => {
  await sage.goto(ORG);
  await sage.getByRole('navigation', { name: 'Wedding' }).getByRole('link', { name: 'Household' }).click();
  const add = sage.getByRole('region', { name: 'Add a household task' });
  await add.getByLabel('Task').fill('Change the furnace filter');
  await add.getByLabel('Every').fill('3');
  await add.getByLabel('Unit').selectOption('month');
  await add.getByRole('button', { name: 'Add the task' }).click();
  const item = sage.getByRole('listitem', { name: 'Change the furnace filter' });
  await expect(item).toContainText('due today (never done)');
  await item.getByRole('button', { name: 'Mark Change the furnace filter done' }).click();
  await expect(sage.getByRole('listitem', { name: 'Change the furnace filter' })).toContainText('coming up');
  await expect(sage.getByRole('listitem', { name: 'Change the furnace filter' })).toContainText('every 3 months; last done');
  await sage.goto(ORG);
  await expect(sage.getByRole('region', { name: 'Household tasks' })).toContainText('Change the furnace filter: coming up');
});

test('the archive is read-only, and a helper keeps only the album', async ({ browser }) => {
  await sage.goto(`${ORG}/wedding/archive`);
  await expect(sage.getByRole('note')).toContainText('read-only');
  await sage.getByRole('list', { name: 'The wedding plan' }).getByRole('link', { name: 'Schedule' }).click();
  await expect(sage.getByRole('note', { name: 'Archive' })).toContainText('the wedding plan is read-only in life-admin mode');
  await expect(sage.getByRole('region', { name: 'Add a task' })).toHaveCount(0);
  await sage.goto(`${ORG}/wedding/vendors`);
  await sage.getByRole('link', { name: 'Old Mill Hall' }).click();
  await expect(sage.getByRole('region', { name: 'Contract attachments' })).toContainText('Old Mill Hall contract, page 1');
  await expect(sage.getByRole('button', { name: 'Attach' })).toHaveCount(0);

  const ivy = await signIn(browser, 'ivy@knotwork.demo.test');
  await ivy.goto(ORG);
  await expect(ivy.getByRole('region', { name: 'Next anniversary' })).toContainText('1st anniversary');
  await expect(ivy.getByRole('region', { name: 'Photo albums' })).toContainText('Reception');
  for (const name of ['Household tasks', 'Thank-yous still owed', 'Name change', 'Documents']) await expect(ivy.getByRole('region', { name })).toHaveCount(0);
  const res = await ivy.goto(`${ORG}/wedding/life`);
  expect(res?.status()).toBe(404);
});

test('and back to planning, with both keys', async () => {
  await wren.goto(`${ORG}/wedding/archive`);
  await wren.getByRole('button', { name: 'Switch back to planning mode' }).click();
  await expect(wren).toHaveURL(new RegExp(`${ORG}/wedding/approvals$`));
  expect(await mode()).toBe('life');
  await sage.goto(`${ORG}/wedding/approvals`);
  await sage.getByRole('article', { name: /^Request: Switch back to planning mode/ }).getByRole('button', { name: 'Approve' }).click();
  await expect(sage.getByRole('region', { name: 'Waiting for you', exact: true })).toContainText('Nothing is waiting for you.');
  expect(await mode()).toBe('planning');
  await sage.goto(ORG);
  await expect(sage.getByRole('list', { name: 'At a glance' })).toBeVisible();
});
