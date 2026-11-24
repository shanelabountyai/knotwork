import { beforeEach, describe, expect, it } from 'vitest';
import * as actions from '@/app/o/[org]/wedding/actions';
import * as guestActions from '@/app/o/[org]/wedding/guests/actions';
import { setVendorPrivacy } from '@/app/o/[org]/wedding/privacy/actions';
import * as vendorActions from '@/app/o/[org]/wedding/vendors/actions';
import { exportTables } from '@/app/export-hooks';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { hashToken } from '@/core/tokens';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { applyRsvp } from '@/lib/knotwork/guests/store';
import { VENDOR_LINK_DAYS_AFTER } from '@/lib/knotwork/vendors/projection';
import { readVendorLink } from '@/lib/knotwork/vendors/public';
import { as, db, goToDay, log, makeWedding, ok, outcome, refused, snapshot, type Couple } from './db';
import { PAGES, render } from './render';

// D-42, the vendor's read-only link, through the real actions and the public read: 32 random bytes in /v/[token],
// matched by sha256, a sealed copy to show again, replaceable (the old one stops at once), ended by hand, expired a set
// number of days after the wedding (derived, nothing stored), and the same nothing for every link that does not work.
// What it shows is the vendor's own role-filtered brief, through vendors/projection.ts: counts, never guests' names.
const today = () => todayIn('America/Chicago', now());
let c: Couple;
let wedding: string;
let ip = 0;
const IP = () => `198.51.100.${(ip++ % 200) + 1}`;
const CSV = `household,name,email,list,priority,age_group,partner_status
The Lindqvists,Linda Lindqvist,linda@lindqvist.example,A,1,adult,married
The Lindqvists,Omar Lindqvist,,A,1,adult,married
The Ashbys,Hal Ashby,hal@ashby.example,A,2,adult,married
`;
const vendor = (name: string) => db.vendor.findFirstOrThrow({ where: { orgId: c.orgId, name } });
/** Makes (or replaces) the link as the signed-in person; returns the token. */
async function link(name: string): Promise<string> {
  const o = await outcome(vendorActions.newVendorLink(c.slug, { id: (await vendor(name)).id }));
  expect(o.error).toBeUndefined();
  return /\/v\/([\w-]+) /.exec(String((o.result as { notice: string }).notice))![1]!;
}

beforeEach(async () => {
  wedding = addDays(today(), 330);
  c = await makeWedding(wedding);
  await ok(guestActions.saveGuestPlan(c.slug, { cap: '10', venueMin: '', venueMax: '', perHead: '87', kidsMeal: '0', vendorMeal: '0', lockoutDays: '42', minBatchSeats: '1', mealOptions: 'Chicken, Fish' }));
  await ok(guestActions.importGuests(c.slug, { csv: CSV, confirm: 'on' }));
  await ok(guestActions.releaseWave(c.slug, { list: 'A' }));
  await withOrg({ orgId: c.orgId }, async (tx) => {
    const h = await tx.household.findFirstOrThrow({ where: { orgId: c.orgId, name: 'The Lindqvists' }, include: { guests: true } });
    await applyRsvp(tx, { orgId: c.orgId, userId: null }, h.id, { ok: true, plusOneName: null, responses: h.guests.map((g) => ({ guestId: g.id, attending: true, meal: 'Fish', dietary: ['gluten_free'], accessibility: [], songRequest: g.name === 'Linda Lindqvist' ? 'September' : '' })) });
  });
  await ok(guestActions.addDoNotPlay(c.slug, { title: 'Macarena', artist: '' }));
  for (const [name, category] of [['Fennel & Fig', 'caterer'], ['Spin Cycle Sound', 'dj'], ['Wild Rye Flowers', 'florist']] as const) {
    await ok(actions.addVendor(c.slug, { name, category, contactName: '', email: '', phone: '' }));
  }
  const fennel = await vendor('Fennel & Fig');
  await ok(actions.updateVendor(c.slug, { id: fennel.id, name: 'Fennel & Fig', category: 'caterer', contactName: 'Sam', email: '', phone: '', notes: 'INTERNAL: haggle on the cake fee', deliverables: 'Plated dinner', arrive: '15:00', depart: '22:00', countEstimate: '120', countDueDaysBefore: '14', onSite: '', contractTotal: '' }));
});

describe('what the vendor sees', () => {
  it('the caterer gets counts, the DJ the songs and the do-not-play list; nobody gets a guest\'s name, a note or another vendor', async () => {
    const caterer = await readVendorLink(await link('Fennel & Fig'), IP());
    const dj = await readVendorLink(await link('Spin Cycle Sound'), IP());
    expect(caterer).toMatchObject({ weddingTitle: 'Juniper & Rowan', vendorName: 'Fennel & Fig' });
    expect(Object.keys(caterer!).sort()).toEqual(['brief', 'vendorName', 'weddingTitle']);
    const cb = (caterer as { brief: string }).brief;
    const db_ = (dj as { brief: string }).brief;
    expect(cb).toContain('Confirmed so far: 2 attending (2 adults, 0 children, 0 infants)');
    expect(cb).toContain('Dietary: gluten free 2');
    expect(cb).not.toContain('MUSIC');
    expect(db_).toContain('- September');
    expect(db_).toContain('- Macarena');
    expect(db_).not.toContain('COUNTS');
    for (const leak of ['Linda', 'Omar', 'Lindqvist', 'Hal Ashby', 'INTERNAL', 'haggle', 'Wild Rye']) {
      expect(cb, leak).not.toContain(leak);
      expect(db_, leak).not.toContain(leak);
    }
    expect(cb).not.toContain('Spin Cycle Sound'); // nothing about another vendor
    expect(db_).not.toContain('Fennel & Fig');
  });

  it('the brief is worked out on every read: a new answer reaches the vendor without anyone regenerating it', async () => {
    const token = await link('Fennel & Fig');
    expect((await readVendorLink(token, IP()) as { brief: string }).brief).toContain('2 attending');
    await withOrg({ orgId: c.orgId }, async (tx) => {
      const h = await tx.household.findFirstOrThrow({ where: { orgId: c.orgId, name: 'The Ashbys' }, include: { guests: true } });
      await applyRsvp(tx, { orgId: c.orgId, userId: null }, h.id, { ok: true, plusOneName: null, responses: h.guests.map((g) => ({ guestId: g.id, attending: true, meal: 'Chicken', dietary: [], accessibility: [], songRequest: '' })) });
    });
    expect((await readVendorLink(token, IP()) as { brief: string }).brief).toContain('3 attending');
  });
});

describe('the link\'s life', () => {
  it('stored as a hash and a sealed copy; shown again; replaced (the old one stops at once); ended; never in the log or the export', async () => {
    const first = await link('Fennel & Fig');
    const row = await vendor('Fennel & Fig');
    expect(row.linkTokenHash).toBe(hashToken(first));
    expect(row.linkTokenSealed).not.toContain(first);
    const shown = await outcome(vendorActions.showVendorLink(c.slug, { id: row.id }));
    expect(String((shown.result as { notice: string }).notice)).toContain(`/v/${first} works until`);
    const second = await link('Fennel & Fig');
    expect(await readVendorLink(first, IP())).toBeNull();
    expect(await readVendorLink(second, IP())).not.toBeNull();
    await ok(vendorActions.endVendorReadLink(c.slug, { id: row.id }));
    expect(await readVendorLink(second, IP())).toBeNull();
    await refused(vendorActions.showVendorLink(c.slug, { id: row.id }), /no read-only link yet/);
    await refused(vendorActions.endVendorReadLink(c.slug, { id: row.id }), /no read-only link/);
    const entries = (await log(c.orgId)).filter((e) => /^knotwork\.vendor\.(linked|relinked|unlinked)$/.test(e.action));
    expect(entries.map((e) => e.action)).toEqual(['knotwork.vendor.linked', 'knotwork.vendor.relinked', 'knotwork.vendor.unlinked']);
    const logged = JSON.stringify(entries.map((e) => e.data));
    expect(logged).not.toContain(first);
    expect(logged).not.toContain(second);
    await link('Fennel & Fig');
    const exported = await withOrg({ orgId: c.orgId }, async (tx) => exportTables.find((t) => t.name === 'Vendor')!.rows(tx, c.orgId));
    expect(Object.keys(exported[0] as object)).not.toContain('linkTokenHash');
    expect(Object.keys(exported[0] as object)).not.toContain('linkTokenSealed');
  });

  it('unknown, malformed, replaced, ended, expired, dropped and private all get the same nothing', async () => {
    expect(await readVendorLink('x', IP())).toBeNull();
    expect(await readVendorLink('a'.repeat(43), IP())).toBeNull();
    expect(await readVendorLink('../../etc/passwd', IP())).toBeNull();
    // Expiry is derived from the wedding date: the last day it works is the wedding plus VENDOR_LINK_DAYS_AFTER.
    const token = await link('Fennel & Fig');
    goToDay(addDays(wedding, VENDOR_LINK_DAYS_AFTER));
    expect(await readVendorLink(token, IP())).not.toBeNull();
    goToDay(addDays(wedding, VENDOR_LINK_DAYS_AFTER + 1));
    expect(await readVendorLink(token, IP())).toBeNull();
    await as(c.a);
    await refused(vendorActions.newVendorLink(c.slug, { id: (await vendor('Fennel & Fig')).id }), /stop working 7 days after the wedding/);
  });

  it('a dropped vendor\'s link stops; a private vendor has no link (refused, and making a vendor private ends its link)', async () => {
    const florist = await vendor('Wild Rye Flowers');
    const t = await link('Wild Rye Flowers');
    await db.vendor.update({ where: { id: florist.id }, data: { status: 'dropped' } });
    expect(await readVendorLink(t, IP())).toBeNull();
    await refused(vendorActions.newVendorLink(c.slug, { id: florist.id }), /dropped vendor has no read-only link/);

    const dj = await vendor('Spin Cycle Sound');
    const d = await link('Spin Cycle Sound');
    await ok(setVendorPrivacy(c.slug, { id: dj.id, privacy: 'never' }));
    expect(await vendor('Spin Cycle Sound')).toMatchObject({ linkTokenHash: null, linkTokenSealed: null });
    expect(await readVendorLink(d, IP())).toBeNull();
    await refused(vendorActions.newVendorLink(c.slug, { id: dj.id }), /A private vendor has no read-only link/);
    // Even a link left on a private row (written past the store) answers nothing.
    const caterer = await vendor('Fennel & Fig');
    const k = await link('Fennel & Fig');
    await db.vendor.update({ where: { id: caterer.id }, data: { privateToId: c.a, revealDays: null } });
    expect(await readVendorLink(k, IP())).toBeNull();
    // The other partner cannot even reach the hidden vendor's link actions.
    await as(c.b);
    expect((await outcome(vendorActions.newVendorLink(c.slug, { id: dj.id }))).nav).toBe('notFound');
  });

  it('rate limited per address, before the token is even looked at', async () => {
    const token = await link('Fennel & Fig');
    const addr = '192.0.2.77';
    for (let i = 0; i < 60; i++) expect(await readVendorLink(i % 2 ? token : 'nope', addr)).not.toBe('limited');
    expect(await readVendorLink(token, addr)).toBe('limited');
  });
});

describe('who may make one', () => {
  it('vendors.edit only; another workspace\'s vendor is not found; the vendor page shows the controls to editors only', async () => {
    const fennel = await vendor('Fennel & Fig');
    const PAGE = 'src/app/o/[org]/wedding/vendors/[id]/page.tsx';
    expect(await render(await PAGES[PAGE]!(), { org: c.slug, id: fennel.id })).toContain('Make a vendor link');
    await ok(actions.grantHelper(c.slug, { userId: c.helper, scope: 'vendors_view' }));
    await as(c.helper);
    await refused(vendorActions.newVendorLink(c.slug, { id: fennel.id }), /do not have access/);
    expect(await render(await PAGES[PAGE]!(), { org: c.slug, id: fennel.id })).not.toContain('vendor link');
    await as(c.a);
    await ok(actions.grantHelper(c.slug, { userId: c.helper, scope: 'vendors_edit' }));
    await as(c.helper);
    expect(await link('Fennel & Fig')).toMatch(/^[\w-]{43}$/);

    await as(c.a);
    const other = await db.org.create({ data: { slug: 'other-couple', name: 'Other' } });
    const theirs = await db.vendor.create({ data: { orgId: other.id, name: 'Theirs', category: 'dj' } });
    const before = await snapshot();
    for (const call of [vendorActions.newVendorLink, vendorActions.showVendorLink, vendorActions.endVendorReadLink]) expect((await outcome(call(c.slug, { id: theirs.id }))).nav).toBe('notFound');
    expect(await snapshot()).toBe(before);
    await expect(db.vendor.update({ where: { id: theirs.id }, data: { linkTokenHash: 'not-a-hash', linkTokenSealed: 'x' } })).rejects.toThrow(/Vendor_link_check/);
  });
});
