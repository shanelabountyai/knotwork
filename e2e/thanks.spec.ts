import { execSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';

// The demo story for P1-8 (link-out registry items) and P1-3 (the thank-you ledger) on the served pages. The couple adds
// a store item (a hostile link is refused); a household follows the link on its own invitation, sees the store link
// open in a new tab with no referrer, marks the item as bought and takes the mark back; the couple sees which household
// bought it; the ledger reads "N unthanked > 3 weeks", ages every gift from the day it arrived, offers a note to copy,
// and a partner logs a gift and marks thank-yous as sent. A helper sees none of it.
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

test('the couple adds a store item; a link that is not https is refused', async () => {
  await juniper.goto(`${ORG}/wedding/gifts`);
  await expect(juniper.getByRole('row', { name: 'Store item Cast-iron skillet' })).toContainText('1 of 2');
  await expect(juniper.getByRole('row', { name: 'Store item Cast-iron skillet' })).toContainText('The Ashbys');
  await juniper.getByRole('textbox', { name: 'Item', exact: true }).fill('Dutch oven');
  await juniper.getByRole('textbox', { name: 'Store', exact: true }).fill('Example Kitchen Co.');
  // The browser's own url check is bypassed so the server's is what answers.
  await juniper.getByRole('textbox', { name: 'Link to the item' }).evaluate((el) => el.setAttribute('type', 'text'));
  await juniper.getByRole('textbox', { name: 'Link to the item' }).fill('javascript:alert(document.cookie)');
  await juniper.getByLabel('How many you want').fill('1');
  await juniper.getByRole('button', { name: 'Add store item' }).click();
  await expect(juniper.locator('main').getByRole('alert')).toContainText('must start with https://');
  expect(await juniper.getByRole('table', { name: 'Store items' }).innerText()).not.toContain('Dutch oven'); // nothing was written
  // The form is cleared after a refusal (React resets it), so it is filled again.
  await juniper.getByRole('textbox', { name: 'Item', exact: true }).fill('Dutch oven');
  await juniper.getByRole('textbox', { name: 'Store', exact: true }).fill('Example Kitchen Co.');
  await juniper.getByRole('textbox', { name: 'Link to the item' }).fill('https://www.example.com/dutch-oven');
  await juniper.getByLabel('How many you want').fill('1');
  await juniper.getByLabel('Price in dollars (optional)').fill('120');
  await juniper.getByRole('button', { name: 'Add store item' }).click();
  const row = juniper.getByRole('row', { name: 'Store item Dutch oven' });
  await expect(row).toContainText('$120.00');
  await expect(row).toContainText('0 of 1');
  const a = row.getByRole('link', { name: 'Example Kitchen Co.' });
  await expect(a).toHaveAttribute('href', 'https://www.example.com/dutch-oven');
  await expect(a).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  await expect(a).toHaveAttribute('target', '_blank');
});

test('a household marks a store item as bought through its own link, and can take the mark back', async ({ browser }) => {
  const link = await linkFor('Priya Rao');
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`${link}/gifts`);
  const store = guest.getByRole('region', { name: 'From a store' });
  const oven = store.getByRole('region', { name: 'Dutch oven' });
  await expect(oven).toContainText('1 of 1 still wanted.');
  const a = oven.getByRole('link', { name: 'Example Kitchen Co.' });
  await expect(a).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  await expect(a).toHaveAttribute('target', '_blank');
  // The skillet: one of two already bought by someone; who is never on this page.
  await expect(store.getByRole('region', { name: 'Cast-iron skillet' })).toContainText('1 of 2 still wanted.');
  expect(await guest.locator('main').innerText()).not.toContain('Ashby');

  await oven.getByLabel('How many Dutch oven you bought').fill('2');
  await oven.getByRole('button', { name: 'I bought Dutch oven' }).click();
  await expect(guest.locator('main').getByRole('alert')).toContainText('Fewer of those are still wanted than that.');
  expect(new URL(guest.url()).search).toBe('?e=too-many');
  await oven.getByLabel('How many Dutch oven you bought').fill('1');
  await oven.getByRole('button', { name: 'I bought Dutch oven' }).click();
  await expect(guest.getByRole('status')).toContainText('It is marked as bought');
  expect(new URL(guest.url()).search).toBe('?done=claimed');
  await expect(oven).toContainText('All bought. Thank you.');
  await expect(oven).toContainText('You marked 1 as bought');
  await oven.getByRole('button', { name: 'Take back my mark on Dutch oven' }).click();
  await expect(guest.getByRole('status')).toContainText('no longer marked as bought by you');
  await expect(oven).toContainText('1 of 1 still wanted.');
  await oven.getByRole('button', { name: 'I bought Dutch oven' }).click();
  await expect(oven).toContainText('All bought. Thank you.');
  await guest.context().close();

  await juniper.goto(`${ORG}/wedding/gifts`);
  await expect(juniper.getByRole('row', { name: 'Store item Dutch oven' })).toContainText('1 of 1, all bought');
  await expect(juniper.getByRole('row', { name: 'Store item Dutch oven' })).toContainText('Priya Rao');
});

test('the thank-you ledger: aged from the day each gift arrived, oldest first, a note to copy, and sent once', async ({ browser }) => {
  await juniper.goto(`${ORG}/wedding/gifts/thank-yous`);
  await expect(juniper.getByLabel('Overdue thank-yous')).toHaveText('2 unthanked > 3 weeks');
  const owed = juniper.getByRole('list', { name: 'Thank-yous', exact: true }).getByRole('listitem');
  await expect(owed.first()).toHaveAccessibleName('Thank-you to Great-aunt Odile for a hand-stitched quilt');
  await expect(owed.first()).toContainText('owed 35 days, more than 3 weeks');
  await expect(juniper.getByRole('listitem', { name: 'Thank-you to Priya Rao for Dutch oven' })).toContainText('bought from the registry');
  await owed.first().getByText('A note to start from').click();
  await expect(owed.first().locator('pre')).toContainText('Dear Great-aunt Odile,');
  await expect(owed.first().locator('pre')).toContainText('Thank you so much for a hand-stitched quilt.');
  await owed.first().getByRole('button', { name: 'Mark the thank-you to Great-aunt Odile as sent' }).click();
  await expect(juniper.getByLabel('Overdue thank-yous')).toHaveText('1 unthanked > 3 weeks');
  await expect(juniper.getByRole('list', { name: 'Thank-yous sent' })).toContainText('Great-aunt Odile');

  await juniper.getByLabel('Or from someone else').fill('The Wrens next door');
  await juniper.getByLabel('What it was').fill('a lemon tree');
  await juniper.getByRole('button', { name: 'Log the gift' }).click();
  await expect(juniper.getByRole('listitem', { name: 'Thank-you to The Wrens next door for a lemon tree' })).toContainText('owed today');
  // Nothing on the ledger is a figure of money.
  expect(await juniper.locator('main').innerText()).not.toMatch(/\$\d/);

  const maple = await signIn(browser, 'maple@knotwork.demo.test');
  expect((await maple.goto(`${ORG}/wedding/gifts/thank-yous`))!.status()).toBe(404);
  await maple.context().close();
});
