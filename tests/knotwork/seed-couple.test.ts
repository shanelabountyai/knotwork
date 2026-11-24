import { beforeAll, describe, expect, it } from 'vitest';
import { demoSignIn } from '@/core/auth/demo';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system';
import { loadBudget } from '@/lib/knotwork/budget-store';
import { loadRegistry, loadThankYous } from '@/lib/knotwork/gifts/couple';
import { loadGuestState } from '@/lib/knotwork/guests/store';
import { wallFeed } from '@/lib/knotwork/photos/store';
import { inspect } from '@/lib/knotwork/uploads/inspect';
import { addDays, dayOfDb, todayIn } from '@/lib/knotwork/days';
import { loadSchedule } from '@/lib/knotwork/schedule/store';
import { loadLinks } from '@/lib/knotwork/registry/store';
import { ledger } from '@/lib/knotwork/thanks/aging';
import { loadObligations } from '@/lib/knotwork/thanks/store';
import { COUPLE, seedCouple } from '../../scripts/knotwork/seed-couple';
import { resetAuthTables } from '../helpers/auth';

// The demo seed (PRD Phase 1 gate): one synthetic couple, built through the same stores the actions use.
let orgId: string;
const today = () => todayIn(COUPLE.timeZone, now());

beforeAll(async () => {
  await resetAuthTables();
  await seedCouple();
  await seedCouple(); // idempotent: the second run replaces the first
  orgId = (await db.org.findUniqueOrThrow({ where: { slug: COUPLE.slug } })).id;
});

describe('seed:couple', () => {
  it('makes exactly one workspace with two partners and two helpers, all synthetic demo accounts', async () => {
    expect(await db.org.count()).toBe(1);
    const members = await db.membership.findMany({ where: { orgId }, include: { user: true }, orderBy: { user: { email: 'asc' } } });
    expect(members.map((m) => [m.user.email, m.role, m.user.isDemo])).toEqual([
      ['hazel@knotwork.demo.test', 'member', true], // Phase 4: a funder (P1-2)
      ['juniper@knotwork.demo.test', 'owner', true],
      ['maple@knotwork.demo.test', 'member', true],
      ['rowan@knotwork.demo.test', 'owner', true],
    ]);
    expect(await db.user.count()).toBe(4);
    for (const m of members) expect(m.user.email.endsWith('.demo.test')).toBe(true); // a reserved test domain, never a real address
    // The accounts sign in only while DEMO_MODE=1 (INV-27's rule, applied to these three).
    expect(await demoSignIn(members[0]!.userId, { DEMO_MODE: undefined })).toBeNull();
  });

  it('the wedding is 330 days out and the plan has nothing late or impossible', async () => {
    const wedding = await db.wedding.findUniqueOrThrow({ where: { orgId } });
    expect(dayOfDb(wedding.date)).toBe(addDays(today(), 330));
    const { schedule, rows } = await withOrg({ orgId }, (tx) => loadSchedule(tx, { orgId }, wedding));
    expect(rows).toHaveLength(24); // 20 from the template, 3 payments, the derived RSVP deadline
    expect(Object.values(schedule.tasks).filter((t) => t.state === 'late' || t.state === 'impossible')).toEqual([]);
    expect(rows.find((t) => t.key === 'rsvp-deadline')).toMatchObject({ bufferDays: 21 + 14 }); // the venue asks 21 days before; chase buffer 14
  });

  it('every booked or signed vendor, and the one large spend, carries a request approved by the OTHER partner', async () => {
    const vendors = await db.vendor.findMany({ where: { orgId }, include: { bookedRequest: true, contractRequest: true }, orderBy: { name: 'asc' } });
    expect(vendors.map((v) => [v.name, v.status])).toEqual([['Cedar Hollow Barn', 'booked'], ['Fennel & Fig Catering', 'booked'], ['Wild Rye Flowers', 'considering']]);
    const requests = await db.consentRequest.findMany({ where: { orgId } });
    expect(requests).toHaveLength(4);
    for (const r of requests) {
      expect(r.status).toBe('approved');
      expect(r.deciderId).not.toBeNull();
      expect(r.deciderId).not.toBe(r.proposerId);
    }
    for (const v of vendors.filter((x) => x.status === 'booked')) expect(v.bookedRequest).toMatchObject({ kind: 'book_vendor', status: 'approved' });
    expect(vendors[0]!.contractRequest).toMatchObject({ kind: 'sign_contract', status: 'approved' });
    const big = await db.expense.findMany({ where: { orgId, amountCents: { gt: 50_000 } }, include: { request: true } });
    expect(big).toHaveLength(1);
    expect(big[0]!.request).toMatchObject({ kind: 'spend', status: 'approved' });
  });

  it('the budget adds up: $31,000.00 estimated, $2,330.00 spent (one spend private to Juniper)', async () => {
    const b = await withOrg({ orgId }, (tx) => loadBudget(tx, { orgId }));
    expect(b.estimateCents).toBe(950_000 + 1_200_000 + 300_000 + 250_000 + 400_000);
    expect(b.actualCents).toBe(200_000 + 15_000 + 18_000); // Phase 4: the private cufflinks count in the total
    expect(b.lines.map((l) => l.name)).toEqual(['Attire', 'Catering', 'Flowers', 'Music', 'Venue']);
  });

  it('the guest list fills the cap exactly, with the B list waiting, and costs $423.00 so far', async () => {
    const s = await withOrg({ orgId }, (tx) => loadGuestState(tx, { orgId }));
    expect(s.cap).toEqual({ cap: 12, held: 12, attending: 5, pending: 7, declined: 0, available: 0 });
    expect(s.count).toMatchObject({ attending: 5, adults: 4, kids: 1, vendorMeals: 1, catererMeals: 6, invited: 10, responded: 5, responseRatePct: 50 });
    expect(s.costCents).toBe(4 * 8700 + 3500 + 4000);
    expect(s.rows.filter((h) => h.list === 'B').map((h) => h.state)).toEqual(['queued', 'queued', 'queued']);
    for (const h of s.rows.filter((x) => x.state === 'invited')) expect(h.rsvpTokenHash).toMatch(/^[0-9a-f]{64}$/);
    for (const h of s.rows) for (const g of h.guests) expect(g.name).not.toMatch(/@/);
  });

  it('the registry has one gift partly funded and one funded exactly, with two thank-yous owed', async () => {
    const items = await withOrg({ orgId }, (tx) => loadRegistry(tx, { orgId }));
    expect(items.map((i) => [i.title, i.state, i.targetCents, i.raisedCents, i.contributors])).toEqual([
      ['Honeymoon canoe trip', 'open', 60_000, 25_000, ['The Ashbys', 'The Lindqvists']],
      ['Record player', 'funded', 20_000, 20_000, ['Priya Rao', 'The Vales']],
    ]);
    const owed = await withOrg({ orgId }, (tx) => loadThankYous(tx, { orgId }, (at) => todayIn(COUPLE.timeZone, at)));
    expect(owed.map((t) => [t.household, t.item, t.acknowledgedOn])).toEqual([['Priya Rao', 'Record player', null], ['The Vales', 'Record player', null]]);
    // The last offer was 100.00 against 80.00 remaining: entered whole, 20.00 back. Mock money: a ledger, never a charge.
    expect((await db.giftEntry.findMany({ where: { orgId, kind: 'excess_return' } })).map((e) => e.amountCents)).toEqual([-2_000]);
    expect(await db.giftEntry.count({ where: { orgId } })).toBe(5);
  });

  it('P1-8 and P1-3: two store items, one skillet bought by the Ashbys, and a thank-you ledger reading "2 unthanked > 3 weeks"', async () => {
    const links = await withOrg({ orgId }, (tx) => loadLinks(tx, { orgId }));
    expect(links.map((l) => [l.title, l.link?.host, l.claimed, l.quantityWanted, l.claimants])).toEqual([['Cast-iron skillet', 'www.example.com', 1, 2, ['The Ashbys']], ['Linen napkins', 'shop.example.net', 0, 1, []]]);
    const book = ledger(await withOrg({ orgId }, (tx) => loadObligations(tx, { orgId })), today());
    expect(book.headline).toBe('2 unthanked > 3 weeks');
    expect(book.owed.map((o) => [o.source, o.giver, o.ageDays])).toEqual([
      ['logged', 'Great-aunt Odile', 35], ['logged', 'The Lindqvists', 24], ['pooled', 'Priya Rao', 0], ['claimed', 'The Ashbys', 0], ['pooled', 'The Vales', 0],
    ]);
    expect(book.thanked.map((o) => [o.giver, o.what])).toEqual([['Uncle Bram', 'a framed print of the river']]);
  });

  it('the photo wall has one pre-moderated event with three approved photos and one waiting, every stored byte clean', async () => {
    const event = await db.photoEvent.findFirstOrThrow({ where: { orgId } });
    expect(event).toMatchObject({ name: 'Reception', mode: 'pre', uploadsOpen: true, uploadDays: 7, retentionDays: 365 });
    expect(event.uploadTokenHash).toMatch(/^[0-9a-f]{64}$/);
    const photos = await db.photo.findMany({ where: { orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { blobs: { orderBy: { kind: 'asc' } } } });
    expect(photos.map((p) => [p.uploaderName, p.caption, p.status]).sort()).toEqual([['', '', 'live'], ['Ben', 'The cake, before', 'pending'], ['Hal', 'First dance', 'live'], ['Linda', 'The arch at golden hour', 'live']]);
    for (const p of photos) {
      expect(p.blobs.map((b) => [b.kind, b.width, b.height])).toEqual([['full', 1200, 800], ['display', 1200, 800], ['thumb', 400, 267]]);
      for (const b of p.blobs) expect(inspect(b.bytes)).toEqual([]);
    }
    expect((await withOrg({ orgId }, (tx) => wallFeed(tx, { orgId }, event.id))).map((p) => p.caption).sort()).toEqual(['', 'First dance', 'The arch at golden hour']);
    expect(await db.photoDevice.count({ where: { orgId } })).toBe(2);
    expect(await db.vendorAttachment.count({ where: { orgId } })).toBe(0);
  });

  it('no vendor needs re-confirmation at the start, each has a brief, and each helper has one grant', async () => {
    expect(await db.vendorFlag.count({ where: { orgId } })).toBe(0);
    expect(await db.vendorBrief.count({ where: { orgId } })).toBe(3);
    expect((await db.helperGrant.findMany({ where: { orgId }, orderBy: { scope: 'asc' } })).map((g) => g.scope)).toEqual(['budget_view', 'funder']); // Phase 4: Hazel's
  });

  it('Phase 4: one spend is private to Juniper until the wedding day; two funders, one linked to Hazel', async () => {
    const secret = await db.expense.findFirstOrThrow({ where: { orgId, privateToId: { not: null } }, include: { category: true } });
    expect(secret).toMatchObject({ description: 'Engraved cufflinks for Rowan', amountCents: 18_000, revealDays: 0 });
    expect(secret.privateToId).toBe((await db.user.findUniqueOrThrow({ where: { email: 'juniper@knotwork.demo.test' } })).id);
    expect(JSON.stringify((await db.auditEvent.findMany({ where: { orgId } })).map((e) => e.data))).not.toContain('cufflinks');
    const funders = await db.funder.findMany({ where: { orgId }, include: { pledges: { include: { receipts: true, allocations: true, category: true } } }, orderBy: { name: 'asc' } });
    expect(funders.map((f) => [f.name, f.pledges.map((p) => [p.category.name, p.amountCents, p.receipts.reduce((n, r) => n + r.amountCents, 0), p.allocations.reduce((n, a) => n + a.amountCents, 0)])])).toEqual([
      ['Aunt Wren Ashby', [['Catering', 150_000, 0, 0]]],
      ['Hazel & Oren Vale', [['Venue', 500_000, 300_000, 200_000]]],
    ]);
    expect(funders[1]!.userId).toBe((await db.user.findUniqueOrThrow({ where: { email: 'hazel@knotwork.demo.test' } })).id);
  });
});
