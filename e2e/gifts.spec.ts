import { execSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';

// Group gifting on the served pages (PRD P0-5; docs/knotwork/PHASE-3-PLAN.md section 2). A household gives through the
// link on its own invitation, with no account; the couple sees the gift's progress and who gave, never what one
// household gave; an offer over what remains completes the gift exactly and the rest comes back; a thank-you is owed.
const ORG = '/o/juniper-rowan';
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
  const url = (await juniper.getByRole('status').filter({ hasText: '/r/' }).textContent())!.trim();
  return new URL(url).pathname;
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  execSync('npm run seed:couple:test');
  juniper = await signIn(browser, 'juniper@knotwork.demo.test');
});

test('the couple sees each gift\'s progress and who gave, and no household\'s amount', async () => {
  await juniper.goto(`${ORG}/wedding/gifts`);
  const canoe = juniper.getByRole('row', { name: 'Gift Honeymoon canoe trip' });
  await expect(canoe).toContainText('$600.00');
  await expect(canoe).toContainText('$250.00 (41%), $350.00 to go');
  await expect(canoe).toContainText('The Ashbys, The Lindqvists');
  const player = juniper.getByRole('row', { name: 'Gift Record player' });
  await expect(player).toContainText('$200.00 (100%)');
  await expect(player).toContainText('Priya Rao, The Vales');
  // The seeded amounts (150.00, 100.00, 120.00, 20.00 back) are on no page the couple has.
  const page = (await juniper.locator('main').innerText()).replaceAll('$250.00', '').replaceAll('$200.00', '');
  for (const amount of ['$150.00', '$100.00', '$120.00', '$20.00', '$80.00']) expect(page).not.toContain(amount);
  await juniper.goto(`${ORG}/wedding/activity`);
  const feed = await juniper.getByRole('list', { name: 'Activity' }).innerText();
  expect(feed).toContain('The Lindqvists gave toward Honeymoon canoe trip');
  // Every line of the feed about a gift: who and what, and not one figure.
  const giftLines = feed.split('\n').filter((l) => /canoe trip|Record player/.test(l)).map((l) => l.replace(/^.*? UTC · /, ''));
  expect(giftLines.length).toBeGreaterThanOrEqual(8); // two gifts added, four contributions, one funded, two thank-yous
  for (const line of giftLines) expect(line).not.toMatch(/\d|\$/);
});

test('a household gives through the link on its invitation, and sees only its own contribution', async ({ browser }) => {
  const link = await linkFor('Dana Kim');
  const guest = await (await browser.newContext()).newPage(); // no account, no cookies
  await guest.goto(link);
  await guest.getByRole('link', { name: 'Gift registry' }).click();
  await expect(guest).toHaveURL(new RegExp(`${link}/gifts$`));
  await expect(guest.getByRole('heading', { name: 'Juniper & Rowan: gifts' })).toBeVisible();
  const canoe = guest.getByRole('region', { name: 'Honeymoon canoe trip' });
  await expect(canoe).toContainText('$250.00 of $600.00 given so far (41%); $350.00 to go.');
  await expect(guest.getByRole('region', { name: 'Record player' })).toContainText('Fully funded: $200.00');
  await expect(guest.getByRole('region', { name: 'Record player' }).getByRole('button')).toHaveCount(0);
  const body = await guest.locator('main').innerText();
  for (const leak of ['Lindqvist', 'Ashby', 'Vale', 'Priya', '$150.00', '$120.00', 'B list', 'wave']) expect(body).not.toContain(leak);

  await canoe.getByLabel('Amount toward Honeymoon canoe trip, in dollars').fill('not money');
  await canoe.getByRole('button', { name: 'Give toward Honeymoon canoe trip' }).click();
  await expect(guest.locator('main').getByRole('alert')).toContainText('Enter an amount from $1.00 to $100,000.00');
  expect(new URL(guest.url()).search).toBe('?e=amount');

  await canoe.getByLabel('Amount toward Honeymoon canoe trip, in dollars').fill('75.50');
  await canoe.getByRole('button', { name: 'Give toward Honeymoon canoe trip' }).click();
  await expect(guest.getByRole('status')).toContainText('Thank you. Your contribution is recorded below.');
  expect(new URL(guest.url()).search).toBe('?done=thanks'); // a code, never the amount
  await expect(canoe).toContainText('$325.50 of $600.00 given so far (54%); $274.50 to go.');
  await expect(canoe.getByRole('list', { name: 'Your contributions to Honeymoon canoe trip' }).getByRole('listitem')).toHaveText([/^You gave: \$75\.50 \(/]);

  // More than what remains: the gift is exactly funded and the rest is returned.
  await canoe.getByLabel('Amount toward Honeymoon canoe trip, in dollars').fill('300');
  await canoe.getByRole('button', { name: 'Give toward Honeymoon canoe trip' }).click();
  await expect(guest.getByRole('status')).toContainText('the part that was more than needed was returned to you');
  await expect(canoe).toContainText('Fully funded: $600.00');
  await expect(canoe.getByRole('list', { name: 'Your contributions to Honeymoon canoe trip' }).getByRole('listitem')).toHaveText([/^You gave: \$75\.50/, /^You gave: \$300\.00/, /^Returned to you \(more than was still needed\): \$25\.50/]);
  await expect(canoe).toContainText('From you toward this gift in all: $350.00.');
  await expect(guest.getByRole('link', { name: 'Back to your RSVP' })).toBeVisible();
  await guest.context().close();

  // An unknown link is the same 404 for the gift page as for the RSVP page.
  const stranger = await (await browser.newContext()).newPage();
  expect((await stranger.goto(`/r/${'x'.repeat(43)}/gifts`))!.status()).toBe(404);
  await stranger.context().close();
});

test('the couple sees the gift funded and who gave; a thank-you is owed to each, and a partner marks one as sent', async () => {
  await juniper.goto(`${ORG}/wedding/gifts`);
  const canoe = juniper.getByRole('row', { name: 'Gift Honeymoon canoe trip' });
  await expect(canoe).toContainText('$600.00 (100%)');
  await expect(canoe).toContainText('funded');
  await expect(canoe).toContainText('Dana Kim, The Ashbys, The Lindqvists');
  const page = await juniper.locator('main').innerText();
  for (const amount of ['$75.50', '$300.00', '$25.50', '$350.00']) expect(page).not.toContain(amount);

  await juniper.getByRole('navigation', { name: 'Gifts' }).getByRole('link', { name: 'Thank-yous' }).click();
  await expect(juniper.getByText('5 of 5 still to send.')).toBeVisible();
  await juniper.getByRole('button', { name: 'Mark the thank-you to Dana Kim as sent' }).click();
  await expect(juniper.getByText('4 of 5 still to send.')).toBeVisible();
  await expect(juniper.getByRole('listitem', { name: 'Thank-you to Dana Kim for Honeymoon canoe trip' })).toContainText('sent');
});

test('closing the registry refunds an unfunded gift, and the helper never sees any of it', async ({ browser }) => {
  await juniper.goto(`${ORG}/wedding/gifts`);
  await juniper.getByLabel('Title').fill('Tent');
  await juniper.getByLabel('Target in dollars').fill('80');
  await juniper.getByRole('button', { name: 'Add gift' }).click();
  await expect(juniper.getByRole('row', { name: 'Gift Tent' })).toContainText('$0.00 (0%), $80.00 to go');
  await juniper.getByRole('button', { name: 'Close the registry' }).click();
  await expect(juniper.locator('main').getByRole('alert')).toContainText('Tick the box');
  await juniper.getByLabel('Close the registry and refund the unfunded gifts').check();
  await juniper.getByRole('button', { name: 'Close the registry' }).click();
  await expect(juniper.getByRole('row', { name: 'Gift Tent' })).toContainText('closed unfunded');
  await expect(juniper.getByText('No gift is open.')).toBeVisible();

  const maple = await signIn(browser, 'maple@knotwork.demo.test');
  expect((await maple.goto(`${ORG}/wedding/gifts`))!.status()).toBe(404);
  expect((await maple.goto(`${ORG}/wedding/gifts/thank-yous`))!.status()).toBe(404);
  await maple.context().close();
});
