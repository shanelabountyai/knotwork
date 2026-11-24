import { beforeEach, describe, expect, it } from 'vitest';
import * as giftActions from '@/app/o/[org]/wedding/gifts/actions';
import * as guestActions from '@/app/o/[org]/wedding/guests/actions';
import { exportTables } from '@/app/export-hooks';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { claimGift, contributeGift } from '@/lib/knotwork/gifts/public';
import { ledger } from '@/lib/knotwork/thanks/aging';
import { loadObligations } from '@/lib/knotwork/thanks/store';
import { as, db, goToDay, log, makeWedding, ok, outcome, refused, snapshot, type Couple } from './db';
import { NOT_FOUND, PAGES, render } from './render';

const { importGuests, releaseWave, saveGuestPlan, showRsvpLink } = guestActions;
const { acknowledgeReceivedGift, acknowledgeThankYou, addRegistryItem, addRegistryLink, logReceivedGift, removeReceivedGift } = giftActions;

// P1-3, the thank-you obligation ledger, through the real actions and pages: gift → giver → acknowledged, from three
// sources (a funded pooled gift, a store item a household bought, a gift logged by hand), with aging computed on read
// from received-on ("N unthanked > 3 weeks"). Nothing about aging is stored, and no amount is ever on the ledger.
const today = () => todayIn('America/Chicago', now());
let c: Couple;

const CSV = `household,name,email,list,priority,age_group,partner_status
The Lindqvists,Linda Lindqvist,linda@lindqvist.example,A,1,adult,married
The Sterns,Ruth Stern,ruth@stern.example,A,2,adult,none
The Vales,Ben Vale,,A,3,adult,married
The Okoros,Chidi Okoro,chidi@okoro.example,B,10,adult,married
`;
const PLAN = { cap: '8', venueMin: '4', venueMax: '10', perHead: '87.00', kidsMeal: '35.00', vendorMeal: '40.00', lockoutDays: '42', minBatchSeats: '3', mealOptions: 'Chicken, Fish, Vegetarian' };
const IP = '203.0.113.29';
const household = (name: string) => db.household.findFirstOrThrow({ where: { orgId: c.orgId, name } });
const obligations = () => withOrg({ orgId: c.orgId }, (tx) => loadObligations(tx, { orgId: c.orgId }));
const book = async () => ledger(await obligations(), today());
const page = async () => render(await PAGES['src/app/o/[org]/wedding/gifts/thank-yous/page.tsx']!(), { org: c.slug });
const tokenOf = async (name: string) => {
  const o = await outcome(showRsvpLink(c.slug, { id: (await household(name)).id }));
  return String((o.result as { notice: string }).notice).split('/r/')[1]!;
};

beforeEach(async () => {
  c = await makeWedding(addDays(today(), 330));
  await ok(saveGuestPlan(c.slug, PLAN));
  await ok(importGuests(c.slug, { csv: CSV, confirm: 'on' }));
  await ok(releaseWave(c.slug, { list: 'A' }));
});

describe('the gift log: a gift from a household or a named person, received on a day of fact', () => {
  it('logs either kind of giver; refuses both, neither, a day not yet come and a day that does not exist, writing nothing', async () => {
    const vales = (await household('The Vales')).id;
    await ok(logReceivedGift(c.slug, { householdId: vales, giverName: '', what: 'a picnic basket', receivedOn: addDays(today(), -10) }));
    await ok(logReceivedGift(c.slug, { householdId: '', giverName: 'Great-aunt Odile', what: 'linen napkins', receivedOn: '' }));
    expect((await obligations()).map((o) => [o.source, o.giver, o.what, o.receivedOn, o.acknowledgedOn])).toEqual([
      ['logged', 'The Vales', 'a picnic basket', addDays(today(), -10), null], ['logged', 'Great-aunt Odile', 'linen napkins', today(), null],
    ]);
    const before = await snapshot();
    await refused(logReceivedGift(c.slug, { householdId: vales, giverName: 'Odile', what: 'x', receivedOn: '' }), /not both/);
    await refused(logReceivedGift(c.slug, { householdId: '', giverName: '', what: 'x', receivedOn: '' }), /Say who it is from/);
    await refused(logReceivedGift(c.slug, { householdId: '', giverName: 'Odile', what: 'x', receivedOn: addDays(today(), 1) }), /today or a day before/);
    await refused(logReceivedGift(c.slug, { householdId: '', giverName: 'Odile', what: 'x', receivedOn: '2027-02-30' }), /real date/);
    await refused(logReceivedGift(c.slug, { householdId: '', giverName: 'Odile', what: '', receivedOn: '' }), /Say what the gift was/);
    expect(await snapshot()).toBe(before);
  });

  it('another workspace\'s household or logged gift is not found, before any rule', async () => {
    const other = await db.org.create({ data: { slug: 'other-couple', name: 'Other' } });
    const stranger = await db.household.create({ data: { orgId: other.id, name: 'Strangers' } });
    const theirs = await db.giftLog.create({ data: { orgId: other.id, giverName: 'Someone', what: 'a thing', receivedOn: new Date('2026-11-01T00:00:00Z') } });
    const before = await snapshot();
    expect((await outcome(logReceivedGift(c.slug, { householdId: stranger.id, giverName: 'both, to tempt a refusal', what: 'x', receivedOn: '' }))).nav).toBe('notFound');
    for (const p of [removeReceivedGift(c.slug, { id: theirs.id }), acknowledgeReceivedGift(c.slug, { id: theirs.id })]) expect((await outcome(p)).nav).toBe('notFound');
    expect(await snapshot()).toBe(before);
    // And the database refuses a logged gift naming another workspace's household, or no giver at all.
    await expect(db.giftLog.create({ data: { orgId: c.orgId, householdId: stranger.id, what: 'x', receivedOn: new Date() } })).rejects.toThrow(/same workspace/);
    await expect(db.giftLog.create({ data: { orgId: c.orgId, what: 'x', receivedOn: new Date() } })).rejects.toThrow(/GiftLog_giver_check/);
    await expect(db.giftLog.create({ data: { orgId: c.orgId, householdId: (await household('The Vales')).id, giverName: 'Also', what: 'x', receivedOn: new Date() } })).rejects.toThrow(/GiftLog_giver_check/);
  });

  it('a partner marks each as sent, once; a gift logged by mistake can be removed; the change log has who and what', async () => {
    await ok(logReceivedGift(c.slug, { householdId: '', giverName: 'Great-aunt Odile', what: 'linen napkins', receivedOn: '' }));
    await ok(logReceivedGift(c.slug, { householdId: '', giverName: 'Cousin Ferdie', what: 'a typo', receivedOn: '' }));
    const [odile, ferdie] = [await db.giftLog.findFirstOrThrow({ where: { giverName: 'Great-aunt Odile' } }), await db.giftLog.findFirstOrThrow({ where: { giverName: 'Cousin Ferdie' } })];
    await as(c.b);
    await ok(acknowledgeReceivedGift(c.slug, { id: odile.id }));
    await refused(acknowledgeReceivedGift(c.slug, { id: odile.id }), /already marked as sent/);
    await ok(removeReceivedGift(c.slug, { id: ferdie.id }));
    expect(await db.giftLog.findUniqueOrThrow({ where: { id: odile.id } })).toMatchObject({ acknowledgedById: c.b });
    expect((await obligations()).map((o) => [o.giver, o.acknowledgedOn])).toEqual([['Great-aunt Odile', today()]]);
    const lines = (await log(c.orgId)).filter((e) => e.targetType === 'giftlog').map((e) => [e.action, (e.data as { label: string }).label, e.actorUserId]);
    expect(lines).toEqual([
      ['knotwork.giftlog.created', 'Great-aunt Odile: linen napkins', c.a], ['knotwork.giftlog.created', 'Cousin Ferdie: a typo', c.a],
      ['knotwork.giftlog.acknowledged', 'Great-aunt Odile: linen napkins', c.b], ['knotwork.giftlog.deleted', 'Cousin Ferdie: a typo', c.b],
    ]);
  });
});

describe('one ledger, three sources, aged on read (PRD P1-3)', () => {
  it('pooled, claimed and logged gifts age from the day each arrived; the headline moves with the clock and nothing is written', async () => {
    const start = today();
    const tokens = { lind: await tokenOf('The Lindqvists'), stern: await tokenOf('The Sterns') };
    await ok(addRegistryItem(c.slug, { title: 'Canoe trip', note: '', target: '100' }));
    await ok(addRegistryLink(c.slug, { title: 'Cast-iron skillet', store: 'Example Kitchen Co.', url: 'https://www.example.com/skillet', price: '45', wanted: '1' }));
    await ok(logReceivedGift(c.slug, { householdId: '', giverName: 'Great-aunt Odile', what: 'linen napkins', receivedOn: addDays(start, -30) }));
    expect(await contributeGift(tokens.lind, IP, { itemId: (await db.registryItem.findFirstOrThrow({ where: { orgId: c.orgId } })).id, amount: '61.17' })).toMatchObject({ ok: true });
    expect(await contributeGift(tokens.stern, IP, { itemId: (await db.registryItem.findFirstOrThrow({ where: { orgId: c.orgId } })).id, amount: '38.83' })).toMatchObject({ ok: true }); // funds it
    expect(await claimGift(tokens.stern, IP, { linkId: (await db.registryLink.findFirstOrThrow({ where: { orgId: c.orgId } })).id, op: 'claim', quantity: '1' })).toEqual({ ok: true, done: 'claimed' });

    let b = await book();
    expect(b.owed.map((o) => [o.source, o.giver, o.what, o.ageDays])).toEqual([
      ['logged', 'Great-aunt Odile', 'linen napkins', 30], ['pooled', 'The Lindqvists', 'Canoe trip', 0], ['pooled', 'The Sterns', 'Canoe trip', 0], ['claimed', 'The Sterns', 'Cast-iron skillet', 0],
    ]);
    expect([b.headline, b.buckets.map((x) => x.count)]).toEqual(['1 unthanked > 3 weeks', [3, 0, 1, 0]]);

    // Three weeks and a day later the rest are overdue too. Nothing was written to make that so.
    const before = await snapshot();
    goToDay(addDays(start, 22));
    b = await book();
    expect([b.headline, b.owed.map((o) => o.ageDays), b.buckets.map((x) => x.count)]).toEqual(['4 unthanked > 3 weeks', [52, 22, 22, 22], [0, 0, 3, 1]]);
    await as(c.a);
    const html = await page();
    expect(html).toContain('4 unthanked &gt; 3 weeks');
    expect(html).toContain('4 of 4 still to send.');
    expect(await snapshot()).toBe(before); // the page and the ledger only read
    // Oldest first on the page as well.
    const order = ['Great-aunt Odile for linen napkins', 'The Lindqvists for Canoe trip', 'The Sterns for Canoe trip', 'The Sterns for Cast-iron skillet'].map((s) => html.indexOf(`aria-label="Thank-you to ${s}"`));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true);

    // A partner sends the Lindqvists' note: it leaves the count and moves to Sent.
    await ok(acknowledgeThankYou(c.slug, { id: (await db.thankYou.findFirstOrThrow({ where: { orgId: c.orgId, household: { name: 'The Lindqvists' } } })).id }));
    b = await book();
    expect([b.headline, b.owed.length, b.thanked.map((o) => o.giver)]).toEqual(['3 unthanked > 3 weeks', 3, ['The Lindqvists']]);
    expect(await page()).toContain('3 of 4 still to send.');
  });

  it('the ledger names who gave and what, never what anyone gave toward a pooled gift; each has a note to start from', async () => {
    const lind = await tokenOf('The Lindqvists');
    await ok(addRegistryItem(c.slug, { title: 'Record player', note: '', target: '123.45' }));
    expect(await contributeGift(lind, IP, { itemId: (await db.registryItem.findFirstOrThrow({ where: { orgId: c.orgId } })).id, amount: '123.45' })).toMatchObject({ ok: true });
    const html = await page();
    expect(html).toContain('The Lindqvists</strong>, toward Record player (a group gift)');
    expect(html).toContain('Dear The Lindqvists,\n\nThank you so much for giving toward Record player.');
    expect(html).toContain('With love,\njuniper@example.test &amp; rowan@example.test');
    expect(html).not.toMatch(/123\.45|12345/);
    expect(JSON.stringify(await obligations())).not.toMatch(/123\.45|12345|Cents|amount/);
    // The export carries the gift log and the claims, and no amount either.
    const exported = await withOrg({ orgId: c.orgId }, async (tx) => Promise.all(exportTables.map(async (t) => ({ name: t.name, rows: await t.rows(tx, c.orgId) }))));
    expect(exported.map((t) => t.name)).toEqual(expect.arrayContaining(['GiftLog', 'RegistryLink', 'RegistryClaim']));
  });

  it('is the partners\' alone: a helper with every grant gets a 404 and can log nothing', async () => {
    for (const scope of ['schedule_edit', 'budget_view', 'budget_edit', 'vendors_view', 'vendors_edit', 'guests_edit', 'photos_moderate'] as const) await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope } });
    await as(c.helper);
    expect(await page()).toBe(NOT_FOUND);
    const before = await snapshot();
    await refused(logReceivedGift(c.slug, { householdId: '', giverName: 'Odile', what: 'x', receivedOn: '' }), /do not have access/);
    expect(await snapshot()).toBe(before);
  });
});
