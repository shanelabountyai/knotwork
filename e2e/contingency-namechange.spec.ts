import { execSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';

// The Phase 4 slice C demo story (docs/knotwork/PHASE-4-PLAN.md, P1-6 and P1-4), in real browsers:
//   1. The rain plan: Juniper answers its two questions, sees exactly what the tent outcome would do (two tasks with
//      dates from the wedding date, the venue to tell, a $1,800.00 spend that only the two of them can approve), puts
//      it into action, and ticks off the checklist. The tasks are on the schedule; the spend waits for Rowan, who
//      approves it. The plan cannot run again.
//   2. The name change: Juniper's is private (Rowan sees none of it, Maple gets a 404); a step is refused until its
//      documents are held, then starts; once she shares it, Rowan can read it and change nothing.
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

test('the rain plan: answer, preview, put the tent into action; the spend waits for the other partner', async () => {
  await juniper.goto(`${ORG}/wedding/schedule`);
  await juniper.getByRole('link', { name: 'Contingency plans' }).click();
  await expect(juniper.getByRole('list', { name: 'Plans' })).toContainText('Rain plan: 4 outcomes. Not put into action.');
  await juniper.getByRole('link', { name: 'Rain plan' }).click();
  await expect(juniper.getByRole('heading', { name: 'Two days out, what does the forecast say for the ceremony?' })).toBeVisible();
  await juniper.getByRole('link', { name: 'Rain most of the afternoon' }).click();
  await juniper.getByRole('link', { name: 'No, put up a tent on the lawn' }).click();

  const preview = juniper.getByRole('region', { name: 'What this would do' });
  await expect(preview.getByRole('heading', { name: 'Rent a tent for the lawn' })).toBeVisible();
  await expect(preview.getByRole('list', { name: 'Vendors to tell' })).toContainText('Cedar Hollow Barn (918-555-0111): A tent rental company will set up on the lawn the day before.');
  await expect(preview.getByRole('table', { name: 'Tasks to add' })).toContainText('Book a tent for the lawn');
  await expect(preview.getByRole('table', { name: 'Tasks to add' })).toContainText('Check the tent is up, lit and dry');
  await expect(preview.getByRole('list', { name: 'Spends' })).toContainText('$1,800.00: over $500.00, so it is proposed for your partner to approve');
  await preview.getByRole('button', { name: 'Put this into action' }).click();

  await expect(juniper.locator('main')).toContainText('Put into action on');
  await expect(juniper.locator('main')).toContainText('2 tasks added to the schedule, 0 spends recorded on the budget, 1 spends waiting on the approvals page');
  const checklist = juniper.getByRole('list', { name: 'Checklist' });
  await expect(checklist).toContainText('Tell Cedar Hollow Barn: A tent rental company will set up on the lawn the day before.');
  await juniper.getByRole('button', { name: /^Done: Tell Cedar Hollow Barn/ }).click();
  await expect(juniper.getByRole('listitem', { name: 'Tell Cedar Hollow Barn: A tent rental company will set up on the lawn the day before.' })).toContainText('(done ');
  await expect(juniper.getByRole('button', { name: 'Put this into action' })).toHaveCount(0); // a plan runs once

  await juniper.goto(`${ORG}/wedding/schedule`);
  await expect(juniper.locator('main')).toContainText('Book a tent for the lawn');

  await rowan.goto(`${ORG}/wedding/approvals`);
  const waiting = rowan.getByRole('region', { name: 'Waiting for you', exact: true });
  await expect(waiting).toContainText('Spend $1,800.00: Tent rental for the lawn (Venue), from the plan "Rain plan"');
  await waiting.getByRole('button', { name: 'Approve' }).first().click();
  // Round 2: wait for the approval to land (its result card) before leaving the page; going straight to the budget raced
  // the server action here, the same race as design.spec.ts's proposal step (3e347cb).
  await expect(rowan.getByRole('status', { name: /^You approved: Spend \$1,800\.00: Tent rental/ })).toBeVisible();
  await rowan.goto(`${ORG}/wedding/budget`);
  await expect(rowan.getByRole('table', { name: 'Spends' })).toContainText('Tent rental for the lawn');
});

test('the name change: private to Juniper, gated by its documents, read-only for Rowan once shared', async ({ browser }) => {
  await rowan.goto(`${ORG}/wedding/name-change`);
  await expect(rowan.getByRole('button', { name: 'Start my name change' })).toBeVisible();
  await expect(rowan.locator('main')).not.toContainText('Juniper');
  const maple = await signIn(browser, 'maple@knotwork.demo.test');
  expect((await maple.goto(`${ORG}/wedding/name-change`))!.status()).toBe(404);

  await juniper.goto(`${ORG}/wedding/name-change`);
  const mine = juniper.getByRole('region', { name: 'Your name change' });
  await expect(mine).toContainText('Following: Any other place (generic fallback). 0 of 7 steps done. Private to you.');
  await expect(juniper.getByRole('note')).toContainText('Illustrative only, not legal advice.');
  await mine.getByRole('button', { name: 'Start: Update your name with the Social Security Administration' }).click();
  await expect(mine.getByRole('alert')).toContainText('Mark the documents it needs as held first: Certified copy of your marriage certificate.');
  await mine.getByRole('button', { name: 'I have: Certified copy of your marriage certificate' }).click();
  await expect(mine.getByRole('listitem', { name: 'Document Certified copy of your marriage certificate' })).toContainText('held');
  await mine.getByRole('button', { name: 'Start: Update your name with the Social Security Administration' }).click();
  await expect(mine.getByRole('listitem', { name: 'Step Update your name with the Social Security Administration' })).toContainText('in progress');
  await mine.getByRole('button', { name: 'Start: Update your driver\'s license or state ID' }).click();
  await expect(mine.getByRole('alert')).toContainText('Finish the steps it waits for first: Update your name with the Social Security Administration.');

  await mine.getByRole('button', { name: 'Share it with my partner' }).click();
  await expect(juniper.getByRole('region', { name: 'Your name change' })).toContainText('Shared with your partner');
  await rowan.reload();
  const hers = rowan.getByRole('region', { name: /Juniper Vale's name change/ });
  await expect(hers).toContainText('Update your name with the Social Security Administration: in progress');
  await expect(hers.getByRole('button')).toHaveCount(0);
});
