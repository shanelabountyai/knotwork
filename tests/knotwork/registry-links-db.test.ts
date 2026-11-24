import { beforeEach, describe, expect, it } from 'vitest';
import * as giftActions from '@/app/o/[org]/wedding/gifts/actions';
import * as guestActions from '@/app/o/[org]/wedding/guests/actions';
import { POST as claimRoute } from '@/app/r/[token]/gifts/claim/route';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { addDays, dayOfDb, todayIn } from '@/lib/knotwork/days';
import { claimGift, readGifts } from '@/lib/knotwork/gifts/public';
import { loadLinks } from '@/lib/knotwork/registry/store';
import { loadObligations } from '@/lib/knotwork/thanks/store';
import { as, db, log, makeWedding, ok, outcome, refused, snapshot, type Couple } from './db';
import { PAGES, render } from './render';

const { importGuests, releaseWave, saveGuestPlan, showRsvpLink } = guestActions;
const { acknowledgeClaim, addRegistryLink, removeRegistryLink, updateRegistryLink } = giftActions;

// P1-8, link-out registry items, through the real actions, the real guest link and the real route. Same world as
// gifts-db.test.ts: the A list (Lindqvists, Sterns, Vales, Priya Rao) is invited, the B list waits.
const today = () => todayIn('America/Chicago', now());
let c: Couple;

const CSV = `household,name,email,list,priority,age_group,partner_status
The Lindqvists,Linda Lindqvist,linda@lindqvist.example,A,1,adult,married
The Sterns,Ruth Stern,ruth@stern.example,A,2,adult,none
The Vales,Ben Vale,,A,3,adult,married
Priya Rao,Priya Rao,priya@rao.example,A,4,adult,engaged
The Okoros,Chidi Okoro,chidi@okoro.example,B,10,adult,married
`;
const PLAN = { cap: '8', venueMin: '4', venueMax: '10', perHead: '87.00', kidsMeal: '35.00', vendorMeal: '40.00', lockoutDays: '42', minBatchSeats: '3', mealOptions: 'Chicken, Fish, Vegetarian' };
const IP = '203.0.113.19';
const A_LIST = ['The Lindqvists', 'The Sterns', 'The Vales', 'Priya Rao'];
const SKILLET = { title: 'Cast-iron skillet', store: 'Example Kitchen Co.', url: 'https://www.example.com/skillet', price: '45.00', wanted: '2' };
const household = (name: string) => db.household.findFirstOrThrow({ where: { orgId: c.orgId, name } });
const link = (title: string) => db.registryLink.findFirstOrThrow({ where: { orgId: c.orgId, title } });
const links = () => withOrg({ orgId: c.orgId }, (tx) => loadLinks(tx, { orgId: c.orgId }));
const tokens = new Map<string, string>();
const tokenOf = async (name: string) => {
  const o = await outcome(showRsvpLink(c.slug, { id: (await household(name)).id }));
  return String((o.result as { notice: string }).notice).split('/r/')[1]!;
};
const claim = async (name: string, title: string, quantity = '1') => claimGift(tokens.get(name)!, IP, { linkId: (await link(title)).id, op: 'claim', quantity });
const takeBack = async (name: string, title: string) => claimGift(tokens.get(name)!, IP, { linkId: (await link(title)).id, op: 'withdraw', quantity: '' });
const code = (r: Awaited<ReturnType<typeof claimGift>>) => (r && r !== 'limited' ? (r.ok ? r.done : r.code) : r);
const claimedSum = async (title: string) => (await db.registryClaim.aggregate({ where: { linkId: (await link(title)).id }, _sum: { quantity: true } }))._sum.quantity ?? 0;

beforeEach(async () => {
  c = await makeWedding(addDays(today(), 330));
  await ok(saveGuestPlan(c.slug, PLAN));
  await ok(importGuests(c.slug, { csv: CSV, confirm: 'on' }));
  await ok(releaseWave(c.slug, { list: 'A' }));
  await ok(addRegistryLink(c.slug, SKILLET));
  tokens.clear();
  for (const name of A_LIST) tokens.set(name, await tokenOf(name));
});

describe('the couple adds store items; the URL is hostile input', () => {
  it('an ordinary https link is stored in canonical form, with store, price and how many are wanted', async () => {
    await ok(addRegistryLink(c.slug, { title: 'Napkins', store: 'Example Linens', url: '  HTTPS://Shop.Example.com/napkins?set=8  ', price: '', wanted: '1' }));
    expect(await link('Napkins')).toMatchObject({ store: 'Example Linens', url: 'https://shop.example.com/napkins?set=8', priceCents: null, quantityWanted: 1 });
    expect(await link('Cast-iron skillet')).toMatchObject({ url: 'https://www.example.com/skillet', priceCents: 4_500, quantityWanted: 2 });
    expect((await links()).map((l) => [l.title, l.link?.host, l.claimed, l.remaining, l.claimants])).toEqual([['Cast-iron skillet', 'www.example.com', 0, 2, []], ['Napkins', 'shop.example.com', 0, 1, []]]);
  });

  it('javascript:, data:, http:, credentials, a bare host, an address in numbers, invisible text and a very long link are refused, writing nothing', async () => {
    const before = await snapshot();
    const tries: [string, RegExp][] = [
      ['javascript:alert(document.cookie)', /must start with https/], ['data:text/html,<script>alert(1)</script>', /must start with https/], ['http://www.example.com/skillet', /must start with https/],
      ['//www.example.com/skillet', /must start with https/], ['https://user:pass@www.example.com/', /user name or password/], ['https://www.example.com@evil.example/', /user name or password/],
      ['https://localhost/x', /store's web address/], ['https://127.0.0.1/x', /store's web address/], ['https://example.com/\u202ecod.exe', /does not look like a web address/],
      [`https://www.example.com/${'a'.repeat(2000)}`, /too long/], [`https://www.example.com/r?t=${'0123456789abcdef'.repeat(4)}`, /token/], ['', /Paste the link/],
    ];
    for (const [url, re] of tries) await refused(addRegistryLink(c.slug, { ...SKILLET, title: 'Bad', url }), re);
    await refused(addRegistryLink(c.slug, { ...SKILLET, title: 'Bad', url: `https://www.example.com/${'a'.repeat(5000)}` }), /too long/); // over the form's cap: refused before any work
    for (const [price, re] of [['0', /Price/], ['100000.01', /Price/], ['lots', /Price/]] as const) await refused(addRegistryLink(c.slug, { ...SKILLET, title: 'Bad', price }), re);
    for (const wanted of ['0', '100', 'two', '1.5']) await refused(addRegistryLink(c.slug, { ...SKILLET, title: 'Bad', wanted }), /How many/);
    await refused(addRegistryLink(c.slug, SKILLET), /already a store item called Cast-iron skillet/);
    expect(await snapshot()).toBe(before);
  });

  it('the database holds its half: no plain http, no script, no user in front of the host, nothing past what is wanted', async () => {
    const before = await snapshot();
    const base = { orgId: c.orgId, title: 'Raw', store: 'S', quantityWanted: 1 };
    for (const url of ['javascript:alert(1)', 'http://example.com/', 'https://user@example.com/', 'https://example.com/a b', 'https://EXAMPLE.com/', `https://example.com/${'a'.repeat(2000)}`, 'https://example.com\\@evil/']) {
      await expect(db.registryLink.create({ data: { ...base, url } }), url).rejects.toThrow(/RegistryLink_url_check/);
    }
    await expect(db.registryLink.create({ data: { ...base, url: 'https://example.com/', quantityWanted: 0 } })).rejects.toThrow(/RegistryLink_quantity_check/);
    const skillet = await link('Cast-iron skillet');
    const [lind, stern] = [await household('The Lindqvists'), await household('The Sterns')];
    await expect(db.$transaction([db.registryClaim.create({ data: { orgId: c.orgId, linkId: skillet.id, householdId: lind.id, quantity: 2, claimedOn: new Date() } }), db.registryClaim.create({ data: { orgId: c.orgId, linkId: skillet.id, householdId: stern.id, quantity: 1, claimedOn: new Date() } })])).rejects.toThrow(/cannot claim more than the couple wants/);
    const other = await db.org.create({ data: { slug: 'other-couple', name: 'Other' } });
    const stranger = await db.household.create({ data: { orgId: other.id, name: 'Strangers' } });
    await expect(db.registryClaim.create({ data: { orgId: c.orgId, linkId: skillet.id, householdId: stranger.id, quantity: 1, claimedOn: new Date() } })).rejects.toThrow(/same workspace/);
    await db.$executeRaw`DELETE FROM "Org" WHERE id = ${other.id}::uuid`;
    expect(await snapshot()).toBe(before);
  });

  it('an item can change but never below what is claimed; one somebody bought cannot be removed; another workspace\'s is not found', async () => {
    const id = (await link('Cast-iron skillet')).id;
    expect(code(await claim('The Vales', 'Cast-iron skillet', '2'))).toBe('claimed');
    await refused(updateRegistryLink(c.slug, { id, ...SKILLET, wanted: '1' }), /already marked 2 of these as bought/);
    await refused(removeRegistryLink(c.slug, { id }), /stays on the registry/);
    await ok(updateRegistryLink(c.slug, { id, ...SKILLET, title: 'Skillet', wanted: '3', price: '' }));
    expect(await link('Skillet')).toMatchObject({ quantityWanted: 3, priceCents: null });
    await ok(addRegistryLink(c.slug, { ...SKILLET, title: 'Unwanted' }));
    await ok(removeRegistryLink(c.slug, { id: (await link('Unwanted')).id }));
    expect(await db.registryLink.count({ where: { orgId: c.orgId } })).toBe(1);
    // Another workspace's item: not found, before any rule is looked at.
    const other = await db.org.create({ data: { slug: 'other-couple', name: 'Other' } });
    const theirs = (await db.registryLink.create({ data: { orgId: other.id, title: 'Theirs', store: 'S', url: 'https://www.example.com/theirs', quantityWanted: 1 } })).id;
    for (const p of [updateRegistryLink(c.slug, { id: theirs, ...SKILLET, url: 'javascript:x' }), removeRegistryLink(c.slug, { id: theirs })]) expect((await outcome(p)).nav).toBe('notFound');
  });

  it('a helper, with every grant there is, can neither see nor touch store items', async () => {
    for (const scope of ['schedule_edit', 'budget_view', 'budget_edit', 'vendors_view', 'vendors_edit', 'guests_edit', 'photos_moderate'] as const) await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope } });
    await as(c.helper);
    const before = await snapshot();
    await refused(addRegistryLink(c.slug, { ...SKILLET, title: 'Tent' }), /do not have access/);
    await refused(removeRegistryLink(c.slug, { id: (await link('Cast-iron skillet')).id }), /do not have access/);
    expect(await snapshot()).toBe(before);
    expect(await render(await PAGES['src/app/o/[org]/wedding/gifts/links/[id]/page.tsx']!(), { org: c.slug, id: (await link('Cast-iron skillet')).id })).toBe('[[NOT FOUND]]');
  });

  it('the couple\'s pages render the link with rel="noopener noreferrer nofollow" and target="_blank"', async () => {
    await as(c.a);
    const html = await render(await PAGES['src/app/o/[org]/wedding/gifts/page.tsx']!(), { org: c.slug });
    expect(html).toContain('<a href="https://www.example.com/skillet" target="_blank" rel="noopener noreferrer nofollow">Example Kitchen Co.</a>');
    const edit = await render(await PAGES['src/app/o/[org]/wedding/gifts/links/[id]/page.tsx']!(), { org: c.slug, id: (await link('Cast-iron skillet')).id });
    expect(edit).toContain('target="_blank" rel="noopener noreferrer nofollow"');
    // Every anchor that leaves the site, on either page, carries both.
    for (const page of [html, edit]) for (const a of page.match(/<a [^>]*href="https:[^>]*>/g) ?? []) expect(a).toMatch(/target="_blank" rel="noopener noreferrer nofollow"/);
  });
});

describe('guests mark items as bought through their own link (claims count; the couple sees names)', () => {
  it('a claim is bounded by how many are wanted, one per household; the couple sees who; a household takes back its own only', async () => {
    expect(code(await claim('The Lindqvists', 'Cast-iron skillet'))).toBe('claimed');
    expect(code(await claim('The Lindqvists', 'Cast-iron skillet'))).toBe('already');
    expect(code(await claim('The Sterns', 'Cast-iron skillet', '2'))).toBe('too-many');
    expect(code(await claim('The Sterns', 'Cast-iron skillet', '1'))).toBe('claimed');
    expect(code(await claim('The Vales', 'Cast-iron skillet'))).toBe('taken');
    for (const bad of ['0', '-1', 'x', '1.5', '100']) expect(code(await claim('The Vales', 'Cast-iron skillet', bad)), bad).toBe('quantity');
    expect(code(await claimGift(tokens.get('The Vales')!, IP, { linkId: 'nope', op: 'claim', quantity: '1' }))).toBe('not-here');
    expect(code(await claimGift(tokens.get('The Vales')!, IP, { linkId: (await household('The Vales')).id, op: 'claim', quantity: '1' }))).toBe('not-here');
    expect((await links())[0]).toMatchObject({ claimed: 2, remaining: 0, claimants: ['The Lindqvists', 'The Sterns'] });
    // The Vales cannot take back what the Sterns bought: they have no claim of their own.
    expect(code(await takeBack('The Vales', 'Cast-iron skillet'))).toBe('not-claimed');
    expect(code(await takeBack('The Sterns', 'Cast-iron skillet'))).toBe('withdrawn');
    expect((await links())[0]).toMatchObject({ claimed: 1, remaining: 1, claimants: ['The Lindqvists'] });
    expect(code(await claim('The Vales', 'Cast-iron skillet'))).toBe('claimed');
    // The guest page: how many are still wanted, and the household's own claim; never who else.
    const lind = await readGifts(tokens.get('The Lindqvists')!, IP);
    const priya = await readGifts(tokens.get('Priya Rao')!, IP);
    if (!lind || lind === 'limited' || !priya || priya === 'limited') throw new Error('no page');
    expect(lind.links[0]).toMatchObject({ remaining: 0, wanted: 2, yours: { quantity: 1 }, href: 'https://www.example.com/skillet', host: 'www.example.com', priceText: '$45.00' });
    expect(priya.links[0]).toMatchObject({ remaining: 0, wanted: 2, yours: null });
    for (const v of [lind, priya]) expect(JSON.stringify(v)).not.toMatch(/Vale|Stern|claimant/);
  });

  it('the change log says who bought what and who took it back, with no user', async () => {
    await claim('The Lindqvists', 'Cast-iron skillet', '2');
    await takeBack('The Lindqvists', 'Cast-iron skillet');
    const lines = (await log(c.orgId)).filter((e) => e.targetType === 'claim').map((e) => [e.action, (e.data as { label: string }).label, e.actorUserId, (e.data as { via?: string }).via]);
    expect(lines).toEqual([['knotwork.claim.claimed', 'The Lindqvists bought Cast-iron skillet', null, 'gift-link'], ['knotwork.claim.withdrawn', 'The Lindqvists took back Cast-iron skillet', null, 'gift-link']]);
  });

  it('a claim is a gift on the thank-you ledger, owed from the day it was made; a partner marks it sent; taking it back takes it off', async () => {
    await claim('Priya Rao', 'Cast-iron skillet');
    const ledger = async () => (await withOrg({ orgId: c.orgId }, (tx) => loadObligations(tx, { orgId: c.orgId }))).filter((o) => o.source === 'claimed');
    expect(await ledger()).toEqual([{ source: 'claimed', id: expect.any(String), giver: 'Priya Rao', what: 'Cast-iron skillet', receivedOn: today(), acknowledgedOn: null }]);
    await as(c.b);
    const id = (await ledger())[0]!.id;
    await ok(acknowledgeClaim(c.slug, { id }));
    await refused(acknowledgeClaim(c.slug, { id }), /already marked as sent/);
    expect(await db.registryClaim.findUniqueOrThrow({ where: { id } })).toMatchObject({ acknowledgedById: c.b });
    expect((await ledger())[0]!.acknowledgedOn).toBe(today());
    await takeBack('Priya Rao', 'Cast-iron skillet');
    expect(await ledger()).toEqual([]);
  });
});

describe('the race (bounded by quantity wanted, under the wedding lock)', () => {
  it('four households claim the last one at the same moment: exactly one gets it, the rest are told it is taken', async () => {
    await ok(addRegistryLink(c.slug, { ...SKILLET, title: 'Stand mixer', wanted: '1' }));
    const results = await Promise.all(A_LIST.map((name) => claim(name, 'Stand mixer')));
    expect(results.map(code).sort()).toEqual(['claimed', 'taken', 'taken', 'taken']);
    expect(await claimedSum('Stand mixer')).toBe(1);
  });

  it('ten rounds of three households each claiming two of three at once: never more than three claimed', async () => {
    for (let round = 0; round < 10; round++) {
      const title = `Round ${round}`;
      await ok(addRegistryLink(c.slug, { ...SKILLET, title, wanted: '3' }));
      const results = await Promise.all(['The Sterns', 'The Vales', 'Priya Rao'].map((name) => claim(name, title, '2')));
      expect(results.map(code).sort(), title).toEqual(['claimed', 'too-many', 'too-many']);
      expect(await claimedSum(title), title).toBe(2);
      // And the last one, claimed by two at once: one of them.
      const last = await Promise.all(['The Lindqvists', ...['The Sterns', 'The Vales', 'Priya Rao'].filter((_, i) => results[i] && results[i] !== 'limited' && !results[i]!.ok).slice(0, 1)].map((name) => claim(name, title, '1')));
      expect(last.map(code).sort(), title).toEqual(['claimed', 'taken']);
      expect(await claimedSum(title), title).toBe(3);
    }
  });
});

describe('the claim route: a form post on the guest\'s own link', () => {
  const post = async (token: string, fields: Record<string, string>, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) => {
    const res = await claimRoute(new Request(`http://localhost:8400/r/${token}/gifts/claim`, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': IP, ...headers } }), { params: Promise.resolve({ token }) });
    return { status: res.status, location: res.headers.get('location'), cache: res.headers.get('cache-control') };
  };

  it('another site\'s post and a wrong token are a 404; this site\'s is answered with a code and nothing typed', async () => {
    const token = tokens.get('The Sterns')!;
    const id = (await link('Cast-iron skillet')).id;
    const before = await snapshot();
    for (const h of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://evil.example' }] as Record<string, string>[]) expect((await post(token, { link: id, op: 'claim', quantity: '1' }, h)).status).toBe(404);
    expect((await post('x'.repeat(43), { link: id, op: 'claim', quantity: '1' })).status).toBe(404);
    expect(await snapshot()).toBe(before);
    expect(await post(token, { link: id, op: 'claim', quantity: '1' })).toEqual({ status: 303, location: `/r/${token}/gifts?done=claimed`, cache: 'no-store' });
    expect((await post(token, { link: id, op: 'claim', quantity: '1' })).location).toBe(`/r/${token}/gifts?e=already`);
    expect((await post(token, { link: id, op: 'claim', quantity: '<b>9</b>' })).location).toBe(`/r/${token}/gifts?e=quantity`);
    expect((await post(token, { link: 'x', op: 'claim', quantity: '1' })).location).toBe(`/r/${token}/gifts?e=not-here`);
    expect((await post(token, { link: id, op: 'withdraw' })).location).toBe(`/r/${token}/gifts?done=withdrawn`);
    expect((await post(token, { link: id, op: 'withdraw' })).location).toBe(`/r/${token}/gifts?e=not-claimed`);
    expect((await post(token, { link: id })).location).toBe(`/r/${token}/gifts?done=claimed`); // no op and no quantity: one, claimed
    expect(dayOfDb((await db.registryClaim.findFirstOrThrow({ where: { linkId: id } })).claimedOn)).toBe(today());
  });

  it('shares the RSVP link\'s rate limit, per address', async () => {
    const token = tokens.get('The Lindqvists')!;
    for (let i = 0; i < 60; i++) await readGifts(token, '198.51.100.17');
    expect(await claimGift(token, '198.51.100.17', { linkId: (await link('Cast-iron skillet')).id, op: 'claim', quantity: '1' })).toBe('limited');
    expect((await post(token, { link: (await link('Cast-iron skillet')).id, op: 'claim' }, { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '198.51.100.17' })).status).toBe(429);
    expect(await db.registryClaim.count({ where: { orgId: c.orgId } })).toBe(0);
  });

  it('a household not yet invited has no link to claim with', async () => {
    await refused(showRsvpLink(c.slug, { id: (await household('The Okoros')).id }), /has not been invited yet/);
    expect(await claimGift('x'.repeat(43), IP, { linkId: (await link('Cast-iron skillet')).id, op: 'claim', quantity: '1' })).toBeNull();
  });
});
