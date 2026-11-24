import { execSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';

// The Phase 2 demo story (docs/knotwork/PHASE-2-PLAN.md §5; PRD "Capstone demo", second story):
//   a decline through a guest's own RSVP link → the headcount and cost drop, with the delta named → seats are free →
//   the B-list batch is released, never past the cap. And rule 3 on the served pages: an A-list household's RSVP page
//   and a B-list household's are the same page.
const ORG = '/o/juniper-rowan';
let juniper: Page;
const links: Record<string, string> = {};

async function signIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/demo');
  await page.getByRole('button', { name: email }).click();
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
  return page;
}
/** The couple's side: open a household and read its RSVP link (shown on request, never listed). */
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

test('the seeded list fills the cap exactly, so the B list waits', async () => {
  await juniper.goto(`${ORG}/wedding/guests`);
  const summary = juniper.getByRole('list', { name: 'Headcount summary' });
  await expect(summary).toContainText('5 attending (4 adults, 1 children, 0 infants), 0 declined, 5 not answered');
  await expect(summary).toContainText('12 of 12 seats held, 0 free');
  await expect(summary).toContainText('Cost so far: $423.00 (6 meals: 4 adult, 1 kids, 1 vendor)'); // 4 × $87 + $35 + $40
  await expect(juniper.getByRole('table', { name: 'Households' }).locator('tbody tr')).toHaveCount(9);
  await juniper.goto(`${ORG}/wedding/guests/waves`);
  await expect(juniper.getByRole('region', { name: 'B list' })).toContainText('No seats are free for anyone who is waiting.');
  await expect(juniper.getByRole('button', { name: 'Release the B list batch' })).toHaveCount(0);
});

test('a guest declines through their own link; the cost delta is named and seats come free', async ({ browser }) => {
  links.ashbys = await linkFor('The Ashbys');
  const guest = await (await browser.newContext()).newPage(); // no account, no cookies: the link is all they have
  await guest.goto(links.ashbys);
  await expect(guest.getByRole('heading', { name: 'Juniper & Rowan' })).toBeVisible();
  await expect(guest.getByText('Dear The Ashbys, please reply by')).toBeVisible();
  for (const name of ['Hal Ashby', 'Io Ashby']) await guest.getByRole('group', { name }).getByLabel('Cannot attend').check();
  await guest.getByRole('button', { name: 'Send reply' }).click();
  await expect(guest.getByRole('status')).toContainText('Thank you. Your reply is saved');
  await guest.context().close();

  await juniper.goto(`${ORG}/wedding/guests`);
  const changes = juniper.getByRole('list', { name: 'Headcount changes' });
  await expect(changes).toContainText('Hal declined: −$87.00');
  await expect(changes).toContainText('Io declined: −$87.00');
  await expect(changes.getByRole('listitem').first()).toContainText('declined: −$87.00 (3 attending, $249.00)'); // newest first: after both
  const summary = juniper.getByRole('list', { name: 'Headcount summary' });
  await expect(summary).toContainText('3 attending (2 adults, 1 children, 0 infants), 2 declined, 5 not answered');
  await expect(summary).toContainText('10 of 12 seats held, 2 free');
  await expect(summary).toContainText('Cost so far: $249.00');
  await expect(summary).toContainText('below the venue minimum (minimum 8)');
  await juniper.goto(ORG);
  await expect(juniper.getByRole('list', { name: 'At a glance' })).toContainText('3 guests attending');
});

test('the freed seats release a B-list batch, exactly to the cap and no further', async () => {
  await juniper.goto(`${ORG}/wedding/guests/waves`);
  const b = juniper.getByRole('region', { name: 'B list' });
  await expect(b).toContainText('Ready: 1 households, 2 seats.');
  await expect(b.getByRole('list', { name: 'Next B release' })).toContainText('The Okoros');
  await b.getByRole('button', { name: 'Release the B list batch' }).click();
  await expect(juniper.getByRole('list', { name: 'Cap' })).toContainText('Cap: 12 seats. Held: 12 (3 attending, 9 waiting on an answer). Free: 0.');
  await expect(juniper.getByRole('table', { name: 'Waves' }).locator('tbody tr')).toHaveCount(2);
  await expect(juniper.getByRole('region', { name: 'B list' })).toContainText('No seats are free');
  await juniper.goto(`${ORG}/wedding/guests`);
  await expect(juniper.getByRole('row', { name: 'Household The Okoros' })).toContainText('invited');
  await expect(juniper.getByRole('row', { name: 'Household The Trans' })).toContainText('waiting');
});

test('rule 3: an A-list household and a B-list household are served the same RSVP page', async ({ request }) => {
  links.vales = await linkFor('The Vales'); // A list, two adults, not answered
  links.okoros = await linkFor('The Okoros'); // B list, two adults, not answered, invited in a later wave
  const fetched = await Promise.all([links.vales, links.okoros].map((path) => request.get(path)));
  for (const r of fetched) {
    expect(r.status()).toBe(200);
    expect(r.headers()['cache-control']).toContain('no-store');
    expect(r.headers()['referrer-policy']).toBe('no-referrer');
    expect(r.headers()['x-robots-tag']).toContain('noindex');
    expect(r.headers()['last-modified']).toBeUndefined();
  }
  const mask = (html: string) =>
    html
      .replace(/<script[\s\S]*?<\/script>/g, '') // framework payload: checked for leaks below, but its chunk order is not content
      .replaceAll(/The Vales|The Okoros|Ben Vale|Cy Vale|Chidi Okoro|Ngozi Okoro/g, 'NAME')
      .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID')
      .replaceAll(/\/r\/[\w-]{43}/g, '/r/TOKEN');
  const [a, b] = await Promise.all(fetched.map((r) => r.text()));
  expect(mask(b)).toBe(mask(a));
  // Nothing about lists, waves, order or invite dates anywhere in what was served, scripts included.
  const today = new Date().toISOString().slice(0, 10);
  for (const html of [a, b]) {
    for (const leak of ['waveId', 'waveNumber', 'invitedOn', 'priority', '"list"', 'B list', 'A list', 'regrets', 'queued', 'rsvpTokenHash', 'privateNote', today]) expect(html, leak).not.toContain(leak);
    expect(html).not.toMatch(/\bwave\b/i);
  }
  // The links carry no order: 43 url-safe random characters each.
  for (const path of Object.values(links)) expect(path).toMatch(/^\/r\/[\w-]{43}$/);
  // A household that was never invited has no page, and a made-up link is the same 404.
  expect((await request.get(`/r/${'x'.repeat(43)}`)).status()).toBe(404);
  await juniper.goto(`${ORG}/wedding/guests`);
  await juniper.getByRole('link', { name: 'Sam Webb', exact: true }).click();
  await expect(juniper.getByRole('button', { name: 'Show the RSVP link' })).toHaveCount(0);
});

test('a guest names their plus-one and picks a meal; a reply for someone else\'s household is not possible', async ({ browser, request }) => {
  links.priya = await linkFor('Priya Rao');
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(links.priya);
  const priya = guest.getByRole('group', { name: 'Priya Rao' });
  await priya.getByLabel('Will attend').check();
  await priya.getByLabel('Meal for Priya Rao').selectOption('Vegetarian');
  await priya.getByLabel('Vegetarian', { exact: true }).check();
  await priya.getByLabel('A song that gets you dancing').fill('Got to Be Real');
  await guest.getByLabel('You are welcome to bring a guest. Their name').fill('Robin Rao');
  await guest.getByRole('button', { name: 'Send reply' }).click();
  await expect(guest.getByRole('status')).toContainText('Thank you');
  await expect(guest.getByRole('group', { name: 'Robin Rao' })).toBeVisible(); // now on the invitation
  await guest.context().close();
  // A cross-site post is refused outright (no Origin match), like the template's login.
  const forged = await request.post(`${links.priya}/respond`, { form: { plusOneName: 'Mallory' }, headers: { origin: 'https://evil.example' }, maxRedirects: 0 });
  expect(forged.status()).toBe(404);

  await juniper.goto(`${ORG}/wedding/guests`);
  await expect(juniper.getByRole('row', { name: 'Household Priya Rao' })).toContainText('2 yes, 0 no, 0 waiting');
  await expect(juniper.getByRole('list', { name: 'Headcount summary' })).toContainText('12 of 12 seats held, 0 free'); // the plus-one seat was already held
  await juniper.goto(`${ORG}/wedding/guests/music`);
  await expect(juniper.getByRole('list', { name: 'Song requests' })).toContainText('Got to Be Real');
  await expect(juniper.getByRole('list', { name: 'Do not play' })).toContainText('Macarena');
});

test('the caterer\'s brief carries counts and dietary rollups, never a guest\'s name', async () => {
  await juniper.goto(`${ORG}/wedding/vendors`);
  await juniper.getByRole('link', { name: 'Fennel & Fig Catering' }).click();
  await juniper.getByRole('button', { name: 'Regenerate brief' }).click();
  const brief = juniper.getByLabel('Vendor brief');
  await expect(brief).toContainText('- Confirmed so far: 5 attending (4 adults, 1 children, 0 infants)');
  await expect(brief).toContainText('- Meals: 6 (4 adult, 1 kids, 1 vendor)');
  await expect(brief).toContainText('- Dietary: gluten free 1, nut allergy 1, vegetarian 1');
  const text = (await brief.textContent())!;
  for (const name of ['Linda', 'Lindqvist', 'Omar', 'Wren', 'Priya', 'Rao', 'Robin', 'Ashby', 'Okoro']) expect(text, name).not.toContain(name);
});

test('the chase page shows the derived deadline and who still owes an answer', async () => {
  await juniper.goto(`${ORG}/wedding/guests/chase`);
  const summary = juniper.getByRole('list', { name: 'Chase summary' });
  await expect(summary).toContainText('RSVPs are due');
  await expect(summary).toContainText('7 of 13 invited have answered (53%)');
  await expect(juniper.getByRole('table', { name: 'Not answered' }).locator('tbody tr')).toHaveCount(4); // Vales, Dana, Ruth, Okoros
  await expect(juniper.getByRole('region', { name: 'Reminders due' })).toContainText('None.'); // months before the deadline
});
