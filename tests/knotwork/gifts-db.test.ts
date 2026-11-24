import { beforeEach, describe, expect, it } from 'vitest';
import * as giftActions from '@/app/o/[org]/wedding/gifts/actions';
import * as guestActions from '@/app/o/[org]/wedding/guests/actions';
import { exportSkipped, exportTables } from '@/app/export-hooks';
import { POST as claimRoute } from '@/app/r/[token]/gifts/claim/route';
import { POST as contributeRoute } from '@/app/r/[token]/gifts/contribute/route';
import { POST as respondRoute } from '@/app/r/[token]/respond/route';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { parseAction } from '@/lib/knotwork/changelog-diff';
import { addDays, dayOfDb, todayIn } from '@/lib/knotwork/days';
import { loadRegistry, loadThankYous } from '@/lib/knotwork/gifts/couple';
import { claimGift, contributeGift, readGifts } from '@/lib/knotwork/gifts/public';
import { FORBIDDEN_KEYS } from '@/lib/knotwork/guests/projection';
import { readRsvp } from '@/lib/knotwork/guests/public';
import { as, db, goToDay, log, makeWedding, ok, outcome, refused, snapshot, type Couple } from './db';

const { importGuests, releaseWave, saveGuestPlan, showRsvpLink } = guestActions;
const { acknowledgeThankYou, addRegistryItem, addRegistryLink, closeRegistry, updateRegistryItem } = giftActions;

// Group gifting (PRD P0-5) through the real actions and the real guest link. Same world as guests-db.test.ts:
// cap 8; the A list (Lindqvists, Sterns, Vales, Priya Rao) is invited, the B list (Okoros, Trans, Sam Webb) waits.
const today = () => todayIn('America/Chicago', now());
let c: Couple;
let date: string;

const CSV = `household,name,email,list,priority,age_group,partner_status
The Lindqvists,Linda Lindqvist,linda@lindqvist.example,A,1,adult,married
The Lindqvists,Omar Lindqvist,,A,1,adult,married
The Sterns,Ruth Stern,ruth@stern.example,A,2,adult,none
The Sterns,Ada Stern,,A,2,child,
The Vales,Ben Vale,,A,3,adult,married
The Vales,Cy Vale,,A,3,adult,married
Priya Rao,Priya Rao,priya@rao.example,A,4,adult,engaged
The Okoros,Chidi Okoro,chidi@okoro.example,B,10,adult,married
The Okoros,Ngozi Okoro,,B,10,adult,married
The Trans,Mai Tran,mai@tran.example,B,11,adult,married
The Trans,Huy Tran,,B,11,adult,married
Sam Webb,Sam Webb,sam@webb.example,B,12,adult,none
`;
const PLAN = { cap: '8', venueMin: '4', venueMax: '10', perHead: '87.00', kidsMeal: '35.00', vendorMeal: '40.00', lockoutDays: '42', minBatchSeats: '3', mealOptions: 'Chicken, Fish, Vegetarian' };
const IP = '203.0.113.9';
const A_LIST = ['The Lindqvists', 'The Sterns', 'The Vales', 'Priya Rao'];
const household = (name: string) => db.household.findFirstOrThrow({ where: { orgId: c.orgId, name }, include: { guests: { orderBy: { createdAt: 'asc' } } } });
const item = (title: string) => db.registryItem.findFirstOrThrow({ where: { orgId: c.orgId, title } });
const entries = async (title: string) => (await db.giftEntry.findMany({ where: { itemId: (await item(title)).id }, include: { household: { select: { name: true } } }, orderBy: [{ createdAt: 'asc' }, { kind: 'asc' }, { household: { name: 'asc' } }] })).map((e) => [e.household.name, e.kind, e.amountCents]);
const pot = async (title: string) => (await db.giftEntry.aggregate({ where: { itemId: (await item(title)).id }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
const registry = () => withOrg({ orgId: c.orgId }, (tx) => loadRegistry(tx, { orgId: c.orgId }));
const thankYous = () => withOrg({ orgId: c.orgId }, (tx) => loadThankYous(tx, { orgId: c.orgId }, (at) => todayIn('America/Chicago', at)));
const tokenOf = async (name: string) => {
  const o = await outcome(showRsvpLink(c.slug, { id: (await household(name)).id }));
  return String((o.result as { notice: string }).notice).split('/r/')[1]!;
};
const tokens = new Map<string, string>();
const give = async (name: string, title: string, amount: string) => contributeGift(tokens.get(name)!, IP, { itemId: (await item(title)).id, amount });
const viewOf = async (name: string) => {
  const v = await readGifts(tokens.get(name)!, IP);
  if (!v || v === 'limited') throw new Error(`no gift page for ${name}`);
  return v;
};
/** Every number and every string anywhere inside a value, so "no amount in here" is one exact check. */
const leaves = (o: unknown): (string | number)[] => (typeof o === 'number' || typeof o === 'string' ? [o] : o instanceof Date ? [o.toISOString()] : o && typeof o === 'object' ? Object.values(o).flatMap(leaves) : []);
const holdsAmount = (o: unknown, cents: number) => leaves(o).some((v) => (typeof v === 'number' ? v === cents : v.includes(`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`) || v.includes(String(cents))));

beforeEach(async () => {
  date = addDays(today(), 330);
  c = await makeWedding(date);
  await ok(saveGuestPlan(c.slug, PLAN));
  await ok(importGuests(c.slug, { csv: CSV, confirm: 'on' }));
  await ok(releaseWave(c.slug, { list: 'A' }));
  await ok(addRegistryItem(c.slug, { title: 'Canoe trip', note: 'Two days on the Buffalo River', target: '500.00' }));
  await ok(addRegistryItem(c.slug, { title: 'Record player', note: '', target: '200' }));
  tokens.clear();
  for (const name of A_LIST) tokens.set(name, await tokenOf(name));
});

describe('partial contributions toward a target, and the fully-funded trigger (PRD P0-5)', () => {
  it('households give in parts; the pot is the sum of the ledger; reaching the target funds the gift', async () => {
    expect(await give('The Lindqvists', 'Canoe trip', '200')).toEqual({ ok: true, done: 'thanks' });
    expect(await give('The Sterns', 'Canoe trip', '$150.50')).toEqual({ ok: true, done: 'thanks' });
    expect((await registry()).find((i) => i.title === 'Canoe trip')).toMatchObject({ targetCents: 50_000, raisedCents: 35_050, remainingCents: 14_950, percent: 70, state: 'open', fundedOn: null, contributors: ['The Lindqvists', 'The Sterns'] });
    expect(await thankYous()).toEqual([]); // nothing is owed until a gift funds
    expect(await give('The Lindqvists', 'Canoe trip', '149.50')).toEqual({ ok: true, done: 'thanks' });
    expect(await entries('Canoe trip')).toEqual([['The Lindqvists', 'contribution', 20_000], ['The Sterns', 'contribution', 15_050], ['The Lindqvists', 'contribution', 14_950]]);
    expect(await pot('Canoe trip')).toBe(50_000);
    const funded = await item('Canoe trip');
    expect([funded.state, dayOfDb(funded.fundedOn!), funded.closedOn]).toEqual(['funded', today(), null]);
    expect((await registry()).find((i) => i.title === 'Record player')).toMatchObject({ raisedCents: 0, state: 'open', contributors: [] });
  });

  it('an offer over what remains is entered whole and the excess goes straight back: the pot is the target exactly', async () => {
    await give('The Vales', 'Record player', '120.00');
    expect(await give('Priya Rao', 'Record player', '100.01')).toEqual({ ok: true, done: 'part' });
    expect(await entries('Record player')).toEqual([['The Vales', 'contribution', 12_000], ['Priya Rao', 'contribution', 10_001], ['Priya Rao', 'excess_return', -2_001]]);
    expect(await pot('Record player')).toBe(20_000);
    expect((await item('Record player')).state).toBe('funded');
    // Nothing remains: the next offer is refused and writes nothing.
    const before = await snapshot();
    expect(await give('The Sterns', 'Record player', '5')).toEqual({ ok: false, code: 'funded' });
    expect(await snapshot()).toBe(before);
  });

  it('an amount that is not money, a gift that is not on this registry, and a gift in another workspace are refused, writing nothing', async () => {
    const before = await snapshot();
    for (const bad of ['', 'ten', '0', '0.99', '12.345', '-5', '1e3', '100000.01', '1 000']) expect(await give('The Sterns', 'Canoe trip', bad), bad).toEqual({ ok: false, code: 'amount' });
    const token = tokens.get('The Sterns')!;
    for (const bad of ['', 'nope', '00000000-0000-4000-8000-000000000000', (await household('The Sterns')).id]) expect(await contributeGift(token, IP, { itemId: bad, amount: '5' }), bad).toEqual({ ok: false, code: 'not-here' });
    expect(await snapshot()).toBe(before);
  });

  it('the couple can re-price an open gift, never below what is in the pot; pricing it at the pot funds it', async () => {
    await give('The Vales', 'Canoe trip', '300');
    const id = (await item('Canoe trip')).id;
    await refused(updateRegistryItem(c.slug, { id, title: 'Canoe trip', note: '', target: '299.99' }), /cannot go below what is in the pot/);
    await refused(updateRegistryItem(c.slug, { id, title: 'Record player', note: '', target: '500' }), /already a gift called Record player/);
    await refused(addRegistryItem(c.slug, { title: 'Canoe trip', note: '', target: '10' }), /already a gift called Canoe trip/);
    await refused(addRegistryItem(c.slug, { title: 'Tent', note: '', target: '0.50' }), /Target: an amount from \$1\.00/);
    await ok(updateRegistryItem(c.slug, { id, title: 'Canoe weekend', note: 'One night', target: '300.00' }));
    expect(await item('Canoe weekend')).toMatchObject({ state: 'funded', targetCents: 30_000, note: 'One night' });
    expect((await thankYous()).map((t) => [t.household, t.item])).toEqual([['The Vales', 'Canoe weekend']]);
    await refused(updateRegistryItem(c.slug, { id, title: 'Canoe weekend', note: '', target: '400' }), /funded; it can no longer change/);
  });
});

describe('the race (PRD P0-5: "two givers completing the pot simultaneously resolves to exactly-funded + clean excess")', () => {
  it('four households each offer more than what remains, at the same moment: the pot ends exactly on the target', async () => {
    await give('The Lindqvists', 'Canoe trip', '300'); // 200.00 to go
    const results = await Promise.all(['The Sterns', 'The Vales', 'Priya Rao', 'The Lindqvists'].map((name) => give(name, 'Canoe trip', '150')));
    // 150 + 150 would be 300 against 200 remaining: the first lands whole, the second gets 100 back, the rest are refused.
    expect(results.map((r) => (r && r !== 'limited' ? (r.ok ? r.done : r.code) : r)).sort()).toEqual(['funded', 'funded', 'part', 'thanks']);
    expect(await pot('Canoe trip')).toBe(50_000);
    expect((await item('Canoe trip')).state).toBe('funded');
    const ledger = await entries('Canoe trip');
    expect(ledger.map((e) => [e[1], e[2]])).toEqual([['contribution', 30_000], ['contribution', 15_000], ['contribution', 15_000], ['excess_return', -10_000]]);
    expect(ledger[2]![0]).toBe(ledger[3]![0]); // the excess went back to the household whose offer overshot
    // One thank-you per household with something in the pot, and no more.
    const net = new Map<string, number>();
    for (const [name, , cents] of ledger) net.set(name as string, (net.get(name as string) ?? 0) + (cents as number));
    expect([...net.values()].every((n) => n > 0)).toBe(true);
    expect((await thankYous()).map((t) => t.household).sort()).toEqual([...net.keys()].sort());
  });

  it('ten rounds of two households completing a pot at once: exactly funded every time, and nobody is returned more than they gave', async () => {
    for (let round = 0; round < 10; round++) {
      const title = `Round ${round}`;
      await ok(addRegistryItem(c.slug, { title, note: '', target: '100.00' }));
      await give('The Lindqvists', title, '40'); // 60.00 to go
      const [a, b] = await Promise.all([give('The Sterns', title, '60'), give('The Vales', title, '75.25')]);
      const outcomes = [a, b].map((r) => (r && r !== 'limited' ? (r.ok ? r.done : r.code) : r));
      // Whoever was served first completed it: the Sterns exactly, or the Vales with 15.25 back. The other was refused.
      expect([['thanks', 'funded'], ['funded', 'part']], title).toContainEqual(outcomes);
      expect(await pot(title), title).toBe(10_000);
      expect((await item(title)).state, title).toBe('funded');
      expect(await db.thankYou.count({ where: { itemId: (await item(title)).id } }), title).toBe(2);
      const byHousehold = await db.giftEntry.groupBy({ by: ['householdId'], where: { itemId: (await item(title)).id }, _sum: { amountCents: true } });
      expect(byHousehold.map((h) => h._sum.amountCents).sort(), title).toEqual([4_000, 6_000]);
    }
  });

  it('a contribution and the close at the same moment: either order ends with the gift closed and nobody out of pocket', async () => {
    await give('The Lindqvists', 'Canoe trip', '100');
    const [gave, closed] = await Promise.all([give('The Sterns', 'Canoe trip', '50'), outcome(closeRegistry(c.slug, { confirm: 'on' }))]);
    expect(closed).toMatchObject({ nav: 'redirect' });
    expect([{ ok: true, done: 'thanks' }, { ok: false, code: 'closed' }]).toContainEqual(gave);
    expect(await pot('Canoe trip')).toBe(0);
    expect((await item('Canoe trip')).state).toBe('closed_unfunded');
    const byHousehold = await db.giftEntry.groupBy({ by: ['householdId'], where: { orgId: c.orgId }, _sum: { amountCents: true } });
    expect(byHousehold.every((h) => h._sum.amountCents === 0)).toBe(true);
  });
});

describe('privacy (PRD P0-5): the couple sees progress and names, never an amount; a contributor sees only their own', () => {
  const [LIND, STERN] = [12_345, 23_456];
  beforeEach(async () => {
    await give('The Lindqvists', 'Canoe trip', '123.45');
    await give('The Sterns', 'Canoe trip', '234.56');
  });

  it('nothing the couple can load, read in the change log or export holds what one household gave', async () => {
    const items = await registry();
    expect(items.find((i) => i.title === 'Canoe trip')).toMatchObject({ raisedCents: LIND + STERN, contributors: ['The Lindqvists', 'The Sterns'] });
    const feed = (await log(c.orgId)).map((e) => ({ action: e.action, targetId: e.targetId, data: e.data }));
    const exported = await withOrg({ orgId: c.orgId }, async (tx) => Promise.all(exportTables.map(async (t) => ({ name: t.name, rows: await t.rows(tx, c.orgId) }))));
    for (const [what, value] of [['the registry', items], ['the thank-you list', await thankYous()], ['the change log', feed], ['the data export', exported]] as const) {
      for (const cents of [LIND, STERN]) expect(holdsAmount(value, cents), `${what} holds ${cents}`).toBe(false);
    }
    // The checker is not blind: the ledger itself holds both, and the registry holds the total.
    const ledger = await db.giftEntry.findMany({ where: { orgId: c.orgId } });
    expect([holdsAmount(ledger, LIND), holdsAmount(ledger, STERN), holdsAmount(items, LIND + STERN)]).toEqual([true, true, true]);
    // The export carries per-gift totals and names, and not the ledger.
    expect(exported.map((t) => t.name)).toEqual(expect.arrayContaining(['RegistryItem', 'ThankYou']));
    expect(exported.map((t) => t.name)).not.toContain('GiftEntry');
    expect(exportSkipped.GiftEntry).toMatch(/never sees/);
    expect(exported.find((t) => t.name === 'RegistryItem')!.rows.find((r) => (r as { title: string }).title === 'Canoe trip')).toMatchObject({ targetCents: 50_000, raisedCents: LIND + STERN, contributors: ['The Lindqvists', 'The Sterns'] });
    // No id in the feed points at a ledger entry either.
    const entryIds = new Set(ledger.map((e) => e.id));
    expect(feed.filter((e) => e.targetId && entryIds.has(e.targetId))).toEqual([]);
  });

  it('the change-log line for a contribution says who gave toward what, with no user and no amount', async () => {
    const lines = (await log(c.orgId)).filter((e) => e.action === 'knotwork.gift.contributed');
    expect(lines.map((e) => [e.actorUserId, e.targetType, e.targetId === (lines[0]!.targetId), e.data])).toEqual([
      [null, 'gift', true, { label: 'The Lindqvists gave toward Canoe trip', before: null, after: { household: 'The Lindqvists', item: 'Canoe trip' }, via: 'gift-link' }],
      [null, 'gift', true, { label: 'The Sterns gave toward Canoe trip', before: null, after: { household: 'The Sterns', item: 'Canoe trip' }, via: 'gift-link' }],
    ]);
    expect(lines[0]!.targetId).toBe((await item('Canoe trip')).id);
  });

  it('each household sees the gift\'s progress and its own entries, and nothing of the other\'s', async () => {
    const [lind, stern, vale] = [await viewOf('The Lindqvists'), await viewOf('The Sterns'), await viewOf('The Vales')];
    expect(lind.items[0]).toMatchObject({ title: 'Canoe trip', raisedText: '$358.01', remainingText: '$141.99', percent: 71, yoursText: '$123.45', yours: [{ text: 'You gave', amountText: '$123.45' }] });
    expect(stern.items[0]).toMatchObject({ raisedText: '$358.01', yoursText: '$234.56', yours: [{ text: 'You gave', amountText: '$234.56' }] });
    expect(vale.items[0]).toMatchObject({ raisedText: '$358.01', yoursText: null, yours: [] });
    expect(JSON.stringify(lind)).not.toMatch(/234\.56|23456|Stern/);
    expect(JSON.stringify(stern)).not.toMatch(/123\.45|12345|Lindqvist/);
    expect(JSON.stringify(vale)).not.toMatch(/123\.45|234\.56|Lindqvist|Stern/);
    // A link reaches its own household's entries only, whatever item id is posted with it.
    expect((await db.giftEntry.findMany({ where: { orgId: c.orgId }, select: { householdId: true } })).map((e) => e.householdId).sort()).toEqual([(await household('The Lindqvists')).id, (await household('The Sterns')).id].sort());
  });

  it('a helper, with every grant there is, can neither see nor touch the registry', async () => {
    for (const scope of ['schedule_edit', 'budget_view', 'budget_edit', 'vendors_view', 'vendors_edit', 'guests_edit'] as const) await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope } });
    await as(c.helper);
    const before = await snapshot();
    await refused(addRegistryItem(c.slug, { title: 'Tent', note: '', target: '50' }), /do not have access/);
    await refused(updateRegistryItem(c.slug, { id: (await item('Canoe trip')).id, title: 'Canoe trip', note: '', target: '900' }), /do not have access/);
    await refused(closeRegistry(c.slug, { confirm: 'on' }), /do not have access/);
    expect(await snapshot()).toBe(before);
  });
});

describe('refund-on-unfunded at close (PRD P0-5: mock money, ledgered)', () => {
  it('closing refunds every open gift, one entry per household netting it to zero, and leaves funded gifts alone', async () => {
    await give('The Vales', 'Record player', '200'); // funded
    await give('The Lindqvists', 'Canoe trip', '100');
    await give('The Sterns', 'Canoe trip', '150');
    await give('The Lindqvists', 'Canoe trip', '50');
    await ok(addRegistryItem(c.slug, { title: 'Tent', note: '', target: '80' })); // nobody gives toward it
    await refused(closeRegistry(c.slug, {}), /Tick the box/);
    expect((await item('Canoe trip')).state).toBe('open');
    await ok(closeRegistry(c.slug, { confirm: 'on' }));

    expect(await entries('Canoe trip')).toEqual([
      ['The Lindqvists', 'contribution', 10_000], ['The Sterns', 'contribution', 15_000], ['The Lindqvists', 'contribution', 5_000],
      ['The Lindqvists', 'refund', -15_000], ['The Sterns', 'refund', -15_000],
    ]);
    expect(await pot('Canoe trip')).toBe(0);
    const closed = await item('Canoe trip');
    expect([closed.state, dayOfDb(closed.closedOn!), closed.fundedOn]).toEqual(['closed_unfunded', today(), null]);
    expect([(await item('Tent')).state, await entries('Tent')]).toEqual(['closed_unfunded', []]);
    expect([(await item('Record player')).state, await pot('Record player')]).toEqual(['funded', 20_000]); // untouched
    expect((await registry()).map((i) => [i.title, i.state, i.raisedCents, i.contributors])).toEqual([
      ['Canoe trip', 'closed_unfunded', 0, ['The Lindqvists', 'The Sterns']], ['Record player', 'funded', 20_000, ['The Vales']], ['Tent', 'closed_unfunded', 0, []],
    ]);
    // No thank-you is owed for a gift that did not fund.
    expect((await thankYous()).map((t) => [t.household, t.item])).toEqual([['The Vales', 'Record player']]);

    // Each household sees its own refund; a later offer is refused; closing again finds nothing open.
    const lind = (await viewOf('The Lindqvists')).items[0]!;
    expect([lind.status, lind.yoursText, lind.yours.map((l) => `${l.text}: ${l.amountText}`)]).toEqual(['closed', '$0.00', ['You gave: $100.00', 'You gave: $50.00', 'Refunded to you (the gift was closed before it was funded): $150.00']]);
    expect((await viewOf('The Lindqvists')).anyOpen).toBe(false);
    expect(await give('The Sterns', 'Canoe trip', '5')).toEqual({ ok: false, code: 'closed' });
    await refused(closeRegistry(c.slug, { confirm: 'on' }), /no gift is open/);
    await refused(updateRegistryItem(c.slug, { id: closed.id, title: 'Canoe trip', note: '', target: '10' }), /closed; it can no longer change/);
    const closedLines = (await log(c.orgId)).filter((e) => e.action === 'knotwork.registry.closed');
    expect(closedLines.map((e) => [(e.data as { label: string }).label, (e.data as { householdsRefunded: number }).householdsRefunded, e.actorUserId])).toEqual([['Canoe trip', 2, c.a], ['Tent', 0, c.a]]);
  });
});

describe('the thank-you feed (PRD P0-5: "funded items emit obligations")', () => {
  it('a funded gift owes one thank-you per household that gave; a partner marks each as sent, once', async () => {
    await give('The Lindqvists', 'Record player', '50');
    await give('The Lindqvists', 'Record player', '50');
    await give('The Sterns', 'Record player', '500'); // 100 kept, 400 back
    const owed = await thankYous();
    expect(owed.map((t) => [t.household, t.item, t.owedSince, t.acknowledgedOn])).toEqual([['The Lindqvists', 'Record player', today(), null], ['The Sterns', 'Record player', today(), null]]);
    expect(JSON.stringify(owed)).not.toMatch(/Cents|\$/); // an obligation, not a figure
    goToDay(addDays(today(), 3));
    await as(c.b);
    await ok(acknowledgeThankYou(c.slug, { id: owed[1]!.id }));
    await refused(acknowledgeThankYou(c.slug, { id: owed[1]!.id }), /already marked as sent/);
    expect((await thankYous()).map((t) => [t.household, t.acknowledgedOn])).toEqual([['The Lindqvists', null], ['The Sterns', today()]]); // still owed comes first
    expect(await db.thankYou.findUniqueOrThrow({ where: { id: owed[1]!.id } })).toMatchObject({ acknowledgedById: c.b });
    const lines = (await log(c.orgId)).filter((e) => e.targetType === 'thankyou').map((e) => [e.action, (e.data as { label: string }).label, e.actorUserId]);
    expect(lines).toEqual([
      ['knotwork.thankyou.created', 'The Lindqvists, for Record player', null], ['knotwork.thankyou.created', 'The Sterns, for Record player', null],
      ['knotwork.thankyou.acknowledged', 'The Sterns, for Record player', c.b],
    ]);
  });
});

describe('the database half: an append-only ledger in integer cents that cannot pass its target', () => {
  it('refuses to change or delete an entry, a wrong sign, a zero, and a target of nothing', async () => {
    await give('The Lindqvists', 'Canoe trip', '100');
    const entry = await db.giftEntry.findFirstOrThrow({ where: { orgId: c.orgId } });
    const canoe = await item('Canoe trip');
    const base = { orgId: c.orgId, itemId: canoe.id, householdId: entry.householdId };
    const before = await snapshot();
    await expect(db.giftEntry.update({ where: { id: entry.id }, data: { amountCents: 1 } })).rejects.toThrow(/append-only/);
    await expect(db.giftEntry.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
    await expect(db.giftEntry.deleteMany({ where: { orgId: c.orgId } })).rejects.toThrow(/append-only/);
    await expect(db.registryItem.delete({ where: { id: canoe.id } })).rejects.toThrow(/append-only/); // an item with entries cannot go either
    for (const bad of [{ kind: 'contribution', amountCents: -100 }, { kind: 'contribution', amountCents: 0 }, { kind: 'refund', amountCents: 100 }, { kind: 'excess_return', amountCents: 0 }] as const) {
      await expect(db.giftEntry.create({ data: { ...base, ...bad } }), JSON.stringify(bad)).rejects.toThrow(/GiftEntry_sign_check/);
    }
    await expect(db.registryItem.create({ data: { orgId: c.orgId, title: 'Free', targetCents: 0 } })).rejects.toThrow(/RegistryItem_target_check/);
    await expect(db.$executeRaw`UPDATE "GiftEntry" SET "amountCents" = 1.5 WHERE id = ${entry.id}::uuid`).rejects.toThrow(); // integer column, and append-only
    expect(await snapshot()).toBe(before);
  });

  it('refuses, at commit, a pot over its target, a household below zero, a funded gift off its target and a closed gift with money in it', async () => {
    await give('The Lindqvists', 'Canoe trip', '100');
    const canoe = await item('Canoe trip');
    const lind = (await household('The Lindqvists')).id;
    const base = { orgId: c.orgId, itemId: canoe.id, householdId: lind };
    const before = await snapshot();
    await expect(db.giftEntry.create({ data: { ...base, kind: 'contribution', amountCents: 40_001 } })).rejects.toThrow(/between zero and its target/);
    await expect(db.giftEntry.create({ data: { ...base, kind: 'refund', amountCents: -10_001 } })).rejects.toThrow(/between zero and its target/);
    await expect(db.giftEntry.create({ data: { ...base, householdId: (await household('The Sterns')).id, kind: 'refund', amountCents: -100 } })).rejects.toThrow(/returned more than it gave/);
    await expect(db.registryItem.update({ where: { id: canoe.id }, data: { state: 'funded', fundedOn: new Date('2027-01-01T00:00:00Z') } })).rejects.toThrow(/funded item holds exactly its target/);
    await expect(db.registryItem.update({ where: { id: canoe.id }, data: { state: 'closed_unfunded', closedOn: new Date('2027-01-01T00:00:00Z') } })).rejects.toThrow(/closed item holds nothing/);
    await expect(db.registryItem.update({ where: { id: canoe.id }, data: { targetCents: 9_999 } })).rejects.toThrow(/between zero and its target/);
    await expect(db.registryItem.update({ where: { id: canoe.id }, data: { state: 'funded' } })).rejects.toThrow(/RegistryItem_funded_check/);
    // Another workspace's household or item cannot be named by an entry.
    const other = await db.org.create({ data: { slug: 'other-couple', name: 'Other' } });
    const stranger = await db.household.create({ data: { orgId: other.id, name: 'Strangers' } });
    await expect(db.giftEntry.create({ data: { ...base, householdId: stranger.id, kind: 'contribution', amountCents: 100 } })).rejects.toThrow(/same workspace/);
    await db.$executeRaw`DELETE FROM "Org" WHERE id = ${other.id}::uuid`;
    expect(await snapshot()).toBe(before);
  });

  it('a workspace that is deleted takes its ledger with it (the one way an entry ever goes)', async () => {
    await give('The Lindqvists', 'Canoe trip', '100');
    await give('The Sterns', 'Record player', '200');
    await db.$executeRaw`DELETE FROM "Org" WHERE id = ${c.orgId}::uuid`;
    expect([await db.giftEntry.count(), await db.registryItem.count(), await db.thankYou.count()]).toEqual([0, 0, 0]);
  });
});

describe('the gift page is on the RSVP link (D-63): the same credential, the same limit, the same nothing', () => {
  const post = async (token: string, fields: Record<string, string>, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) => {
    const res = await contributeRoute(new Request(`http://localhost:8400/r/${token}/gifts/contribute`, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': IP, ...headers } }), { params: Promise.resolve({ token }) });
    return { status: res.status, location: res.headers.get('location'), headers: Object.fromEntries(res.headers), text: await res.text() };
  };

  it('a wrong, malformed or not-yet-invited token is the same nothing on the page and on the post', async () => {
    const token = tokens.get('The Lindqvists')!;
    const canoe = (await item('Canoe trip')).id;
    const before = await snapshot();
    for (const bad of ['', 'short', 'x'.repeat(43), `${token}x`, '../../etc/passwd']) {
      expect(await readGifts(bad, IP), bad).toBeNull();
      expect(await readRsvp(bad, IP), bad).toBeNull();
      expect(await contributeGift(bad, IP, { itemId: canoe, amount: '5' }), bad).toBeNull();
    }
    // The Okoros are on the B list and not invited: they have no link, and a contribution cannot name them.
    await refused(showRsvpLink(c.slug, { id: (await household('The Okoros')).id }), /has not been invited yet/);
    const unknown = await post('x'.repeat(43), { item: canoe, amount: '5' });
    const rsvpUnknown = await respondRoute(new Request(`http://localhost:8400/r/${'x'.repeat(43)}/respond`, { method: 'POST', body: '', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': IP, 'sec-fetch-site': 'same-origin' } }), { params: Promise.resolve({ token: 'x'.repeat(43) }) });
    expect([unknown.status, unknown.text, unknown.headers]).toEqual([404, 'Not found', Object.fromEntries(rsvpUnknown.headers)]); // the same 404 as the RSVP route
    expect([rsvpUnknown.status, await rsvpUnknown.text()]).toEqual([404, 'Not found']);
    expect(await snapshot()).toBe(before);
  });

  it('a form post from this site is taken and answered with a redirect that carries only a code; another site\'s is a 404', async () => {
    const token = tokens.get('The Lindqvists')!;
    const canoe = (await item('Canoe trip')).id;
    const before = await snapshot();
    for (const h of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://evil.example' }] as Record<string, string>[]) expect((await post(token, { item: canoe, amount: '5' }, h)).status, JSON.stringify(h)).toBe(404);
    expect(await snapshot()).toBe(before);
    const taken = await post(token, { item: canoe, amount: '480.00' });
    expect([taken.status, taken.location, taken.headers['cache-control']]).toEqual([303, `/r/${token}/gifts?done=thanks`, 'no-store']);
    expect((await post(tokens.get('The Sterns')!, { item: canoe, amount: '75.00' })).location).toBe(`/r/${tokens.get('The Sterns')!}/gifts?done=part`);
    for (const [fields, code] of [[{ item: canoe, amount: '5' }, 'funded'], [{ item: (await item('Record player')).id, amount: 'lots' }, 'amount'], [{ item: 'x', amount: '5' }, 'not-here'], [{}, 'not-here']] as const) {
      const r = await post(token, fields);
      expect([r.status, r.location], code).toEqual([303, `/r/${token}/gifts?e=${code}`]);
    }
    // Nothing a guest typed, and no amount, ever rides in the URL.
    expect((await post(token, { item: (await item('Record player')).id, amount: '<b>12.34</b>' })).location).toBe(`/r/${token}/gifts?e=amount`);
  });

  it('shares the RSVP page\'s rate limit, per address', async () => {
    const token = tokens.get('The Lindqvists')!;
    for (let i = 0; i < 30; i++) await readGifts(token, '198.51.100.7');
    for (let i = 0; i < 30; i++) await readRsvp(token, '198.51.100.7');
    expect(await readGifts(token, '198.51.100.7')).toBe('limited');
    expect(await contributeGift(token, '198.51.100.7', { itemId: (await item('Canoe trip')).id, amount: '5' })).toBe('limited');
    expect((await post(token, { item: (await item('Canoe trip')).id, amount: '5' }, { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '198.51.100.7' })).status).toBe(429);
    expect(await readGifts(token, '198.51.100.8')).not.toBe('limited');
    expect(await db.giftEntry.count({ where: { orgId: c.orgId } })).toBe(0);
  });

  it('a household whose link was replaced gives through the new one only', async () => {
    const old = tokens.get('The Vales')!;
    const o = await outcome(guestActions.newRsvpLink(c.slug, { id: (await household('The Vales')).id }));
    const fresh = String((o.result as { notice: string }).notice).split('/r/')[1]!.split(' ')[0]!;
    expect(await readGifts(old, IP)).toBeNull();
    expect(await contributeGift(old, IP, { itemId: (await item('Canoe trip')).id, amount: '5' })).toBeNull();
    expect(await contributeGift(fresh, IP, { itemId: (await item('Canoe trip')).id, amount: '5' })).toEqual({ ok: true, done: 'thanks' });
  });
});

describe('rule 3: the undetectability sweep on the gift page (PRD P0-4)', () => {
  it('an A household and a B household get the same gift page and the same answers, with nothing about waves in either', async () => {
    const decline = async (name: string) => {
      const h = await household(name);
      const { submitRsvp } = await import('@/lib/knotwork/guests/public');
      expect(await submitRsvp(tokens.get(name)!, IP, { responses: h.guests.map((g) => ({ guestId: g.id, attending: false, meal: '', dietary: [], accessibility: [], songRequest: '' })), plusOneName: '' })).toEqual({ ok: true });
    };
    await decline('The Vales');
    await decline('The Sterns');
    await give('Priya Rao', 'Canoe trip', '40'); // someone else's money is in the pot before either looks
    goToDay(addDays(date, -300)); // the B wave goes out a month later
    await as(c.a);
    await ok(releaseWave(c.slug, { list: 'B' }));
    const [a, b] = [await household('The Lindqvists'), await household('The Okoros')];
    expect([a.list, b.list, a.state, b.state]).toEqual(['A', 'B', 'invited', 'invited']);
    expect(dayOfDb(a.invitedOn!)).not.toBe(dayOfDb(b.invitedOn!));
    tokens.set('The Okoros', await tokenOf('The Okoros'));

    const mask = (v: unknown) => JSON.stringify(v).replaceAll(/Lindqvists|Okoros|Lindqvist|Okoro|Linda|Omar|Chidi|Ngozi/g, 'N').replaceAll(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'ID');
    const keys = (o: unknown): string[] => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => [k, ...keys(v)]) : []);
    const compare = async () => {
      const [va, vb] = [await viewOf('The Lindqvists'), await viewOf('The Okoros')];
      expect(mask(vb)).toBe(mask(va));
      expect(keys(va).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
      const both = `${JSON.stringify(va)}${JSON.stringify(vb)}`;
      for (const leak of [dayOfDb(a.invitedOn!), dayOfDb(b.invitedOn!), a.createdAt.toISOString().slice(0, 10), a.waveId!, b.waveId!, a.id, b.id, c.orgId, 'Priya', 'Rao']) expect(both, leak).not.toContain(leak);
      expect(both).not.toMatch(/wave|priority|invited|"list"|"state"/i);
      return va;
    };
    await compare(); // before either gives
    // Both give the same amount on the same day: same answer, and still the same page.
    expect(await give('The Okoros', 'Record player', '25')).toEqual(await give('The Lindqvists', 'Record player', '25'));
    expect((await compare()).items[1]).toMatchObject({ raisedText: '$50.00', yoursText: '$25.00' });
    // Both are refused the same way, and both complete a gift the same way.
    expect(await give('The Okoros', 'Record player', 'x')).toEqual(await give('The Lindqvists', 'Record player', 'x'));
    await ok(addRegistryItem(c.slug, { title: 'Tent', note: '', target: '30' }));
    await ok(addRegistryItem(c.slug, { title: 'Lantern', note: '', target: '30' }));
    expect(await give('The Okoros', 'Tent', '45')).toEqual({ ok: true, done: 'part' });
    expect(await give('The Lindqvists', 'Lantern', '45')).toEqual({ ok: true, done: 'part' });
    const [ta, tb] = [await viewOf('The Lindqvists'), await viewOf('The Okoros')];
    expect(mask(tb.items.find((i) => i.title === 'Tent'))).toBe(mask(ta.items.find((i) => i.title === 'Lantern')).replace('Lantern', 'Tent'));
    // The tokens the two pages hang on carry no order or time either.
    for (const name of ['The Lindqvists', 'The Okoros']) expect(tokens.get(name)).toMatch(/^[\w-]{43}$/);
    // The couple's thank-you list names both households the same way: nothing there is shown to a guest, and nothing in it is a list.
    expect((await thankYous()).map((t) => [t.household, t.item])).toEqual([['The Lindqvists', 'Lantern'], ['The Okoros', 'Tent']]);

    // P1-8: store items on the same page. Someone else (Priya) has already bought one of each before either looks.
    const store = { store: 'Example Kitchen Co.', price: '45', url: 'https://www.example.com/item' };
    for (const [title, wanted] of [['Skillet', '3'], ['Lamp', '1'], ['Kettle', '1']] as const) await ok(addRegistryLink(c.slug, { ...store, title, wanted }));
    const linkId = async (title: string) => (await db.registryLink.findFirstOrThrow({ where: { orgId: c.orgId, title } })).id;
    const claimAs = async (name: string, title: string, op = 'claim', quantity = '1') => claimGift(tokens.get(name)!, IP, { linkId: await linkId(title), op, quantity });
    expect(await claimAs('Priya Rao', 'Skillet')).toEqual({ ok: true, done: 'claimed' });
    // The pooled gifts now differ on purpose (each household completed a different one), so the store items are
    // compared on their own, and the whole of each page is still swept for anything about waves.
    const compareLinks = async () => {
      const [va, vb] = [await viewOf('The Lindqvists'), await viewOf('The Okoros')];
      expect(mask(vb.links)).toBe(mask(va.links));
      expect(keys(va).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
      const both = `${JSON.stringify(va)}${JSON.stringify(vb)}`;
      for (const leak of [dayOfDb(a.invitedOn!), dayOfDb(b.invitedOn!), a.waveId!, b.waveId!, a.id, b.id, c.orgId, 'Priya', 'Rao']) expect(both, leak).not.toContain(leak);
      expect(both).not.toMatch(/wave|priority|invited|"list"|"state"/i);
      return va;
    };
    await compareLinks();
    // Both mark one bought, both are refused a second, both take it back: the same answers, and still the same page.
    expect(await claimAs('The Okoros', 'Skillet')).toEqual(await claimAs('The Lindqvists', 'Skillet'));
    expect((await compareLinks()).links[0]).toMatchObject({ title: 'Skillet', remaining: 0, wanted: 3, yours: { quantity: 1 } });
    expect(await claimAs('The Okoros', 'Skillet')).toEqual(await claimAs('The Lindqvists', 'Skillet'));
    expect(await claimAs('The Okoros', 'Skillet', 'claim', 'x')).toEqual(await claimAs('The Lindqvists', 'Skillet', 'claim', 'x'));
    expect(await claimAs('The Okoros', 'Skillet', 'withdraw')).toEqual(await claimAs('The Lindqvists', 'Skillet', 'withdraw'));
    await compareLinks();
    expect(await claimAs('The Okoros', 'Lamp')).toEqual({ ok: true, done: 'claimed' });
    expect(await claimAs('The Lindqvists', 'Kettle')).toEqual({ ok: true, done: 'claimed' });
    const [la, lb] = [await viewOf('The Lindqvists'), await viewOf('The Okoros')];
    expect(mask(lb.links.find((l) => l.title === 'Lamp'))).toBe(mask(la.links.find((l) => l.title === 'Kettle')).replace('Kettle', 'Lamp'));
    // The claim route answers both the same way, carrying only a code.
    const post = async (name: string, title: string) => (await claimRoute(new Request(`http://localhost:8400/r/x/gifts/claim`, { method: 'POST', body: new URLSearchParams({ link: await linkId(title), op: 'claim', quantity: '1' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': IP, 'sec-fetch-site': 'same-origin' } }), { params: Promise.resolve({ token: tokens.get(name)! }) })).headers.get('location')!.replace(tokens.get(name)!, 'T');
    expect(await post('The Okoros', 'Skillet')).toBe(await post('The Lindqvists', 'Skillet'));
    expect(await post('The Okoros', 'Kettle')).toBe(await post('The Lindqvists', 'Lamp')); // each the one the other bought: taken
    expect(await post('The Okoros', 'Lamp')).toBe(await post('The Lindqvists', 'Kettle')); // each its own: already
  });
});

describe('change log: a scripted gifting session covers every gift action', () => {
  it('every action leaves its entries, with who', async () => {
    await give('The Vales', 'Record player', '200'); // funded: a thank-you to acknowledge
    await give('The Sterns', 'Canoe trip', '20');
    await as(c.a);
    await ok(giftActions.addRegistryLink(c.slug, { title: 'Skillet', store: 'Example Kitchen Co.', url: 'https://www.example.com/skillet', price: '', wanted: '1' }));
    expect(await claimGift(tokens.get('The Vales')!, IP, { linkId: (await db.registryLink.findFirstOrThrow({ where: { orgId: c.orgId } })).id, op: 'claim', quantity: '1' })).toEqual({ ok: true, done: 'claimed' });
    const steps: [keyof typeof giftActions, () => Promise<Record<string, unknown>> | Record<string, unknown>, string[]][] = [
      ['addRegistryItem', () => ({ title: 'Tent', note: 'For the canoe trip', target: '80.00' }), ['knotwork.registry.created']],
      ['updateRegistryItem', async () => ({ id: (await item('Tent')).id, title: 'Tent', note: 'Three-person', target: '90' }), ['knotwork.registry.updated']],
      ['acknowledgeThankYou', async () => ({ id: (await db.thankYou.findFirstOrThrow({ where: { orgId: c.orgId } })).id }), ['knotwork.thankyou.acknowledged']],
      ['closeRegistry', () => ({ confirm: 'on' }), ['knotwork.registry.closed', 'knotwork.registry.closed']],
      // P1-8 store items and P1-3 the gift log (a household's claim comes in through its link, before the session).
      ['addRegistryLink', () => ({ title: 'Napkins', store: 'Example Linens', url: 'https://www.example.com/napkins', price: '30', wanted: '2' }), ['knotwork.registrylink.created']],
      ['updateRegistryLink', async () => ({ id: (await db.registryLink.findFirstOrThrow({ where: { orgId: c.orgId, title: 'Napkins' } })).id, title: 'Napkins', store: 'Example Linens', url: 'https://www.example.com/napkins', price: '', wanted: '3' }), ['knotwork.registrylink.updated']],
      ['removeRegistryLink', async () => ({ id: (await db.registryLink.findFirstOrThrow({ where: { orgId: c.orgId, title: 'Napkins' } })).id }), ['knotwork.registrylink.deleted']],
      ['acknowledgeClaim', async () => ({ id: (await db.registryClaim.findFirstOrThrow({ where: { orgId: c.orgId } })).id }), ['knotwork.claim.acknowledged']],
      ['logReceivedGift', () => ({ householdId: '', giverName: 'Great-aunt Odile', what: 'linen napkins', receivedOn: '' }), ['knotwork.giftlog.created']],
      ['acknowledgeReceivedGift', async () => ({ id: (await db.giftLog.findFirstOrThrow({ where: { orgId: c.orgId } })).id }), ['knotwork.giftlog.acknowledged']],
      ['removeReceivedGift', async () => ({ id: (await db.giftLog.findFirstOrThrow({ where: { orgId: c.orgId } })).id }), ['knotwork.giftlog.deleted']],
    ];
    expect(steps.map((s) => s[0]).sort()).toEqual(Object.keys(giftActions).sort());
    let seen = (await log(c.orgId)).length;
    for (const [name, input, want] of steps) {
      await as(c.a);
      const o = await outcome((giftActions[name] as (slug: string, i: unknown) => Promise<unknown>)(c.slug, await input()));
      expect(o.error, `${name}: ${o.error}`).toBeUndefined();
      const all = await log(c.orgId);
      expect(all.slice(seen).map((e) => e.action), name).toEqual(want);
      for (const e of all.slice(seen)) {
        expect(e.actorUserId, name).toBe(c.a);
        expect(e.targetType, name).toBe(parseAction(e.action)!.entity);
      }
      seen = all.length;
    }
    const all = await log(c.orgId);
    expect([...new Set(all.map((e) => parseAction(e.action)!.entity))]).toEqual(expect.arrayContaining(['registry', 'gift', 'thankyou', 'registrylink', 'claim', 'giftlog'])); // every gifting entity
    const updated = all.find((e) => e.action === 'knotwork.registry.updated')!;
    expect(updated.data).toMatchObject({ label: 'Tent', before: { note: 'For the canoe trip', targetCents: 8_000 }, after: { note: 'Three-person', targetCents: 9_000 } }); // a target is the couple's own figure
    expect(all.filter((e) => e.action === 'knotwork.registry.funded').map((e) => [(e.data as { label: string }).label, e.actorUserId])).toEqual([['Record player', null]]);
    expect(all.map((e) => JSON.stringify(e.data)).join('')).not.toMatch(/[0-9a-f]{64}/); // nothing token-shaped (INV-34)
  });
});
