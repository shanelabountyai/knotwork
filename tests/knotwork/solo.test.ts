import { beforeEach, describe, expect, it } from 'vitest';
import { addCategory, addExpense, addVendor, approveRequest, createWedding, proposeBooking, proposeContract, proposeDateMove, proposeSettings } from '@/app/o/[org]/wedding/actions';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { soloAllowed } from '@/lib/knotwork/consent/machine';
import { syncPairing } from '@/lib/knotwork/context';
import { addDays, dayOfDb, todayIn } from '@/lib/knotwork/days';
import { previewDateMove } from '@/lib/knotwork/schedule/store';
import { resetAuthTables } from '../helpers/auth';
import { addMember, makeOrg } from '../helpers/org';
import { as, db, log, ok, refused, snapshot } from './db';

// D-33 (owner decision, 2026-11-24): until a second partner has ever been in the workspace, the only partner's
// designated actions execute at once, single-signed and marked solo. Once two partners have been seen, two keys, for
// good. This narrows PRD P0-2's "never execute single-signed" to paired workspaces, on the owner's say-so.
const today = () => todayIn('America/Chicago', now());
let slug: string;
let orgId: string;
let a: string;
let helper: string;
let date: string;
let vendorId: string;
let categoryId: string;

const wedding = () => db.wedding.findUniqueOrThrow({ where: { orgId } });
const requests = () => db.consentRequest.findMany({ where: { orgId }, orderBy: { proposedAt: 'asc' } });
const fp = async (to: string) => (await withOrg({ orgId }, async (tx) => previewDateMove(tx, { orgId }, await wedding(), to))).preview.fingerprint;
const joinPartner = async () => (await addMember(orgId, 'owner', 'rowan@example.test')).id;

beforeEach(async () => {
  await resetAuthTables();
  const org = await makeOrg('solo-juniper');
  [slug, orgId] = [org.slug, org.id];
  a = (await addMember(org.id, 'owner', 'juniper@example.test')).id;
  helper = (await addMember(org.id, 'member', 'maple@example.test')).id;
  date = addDays(today(), 330);
  await as(a);
  await ok(createWedding(slug, { title: 'Juniper', date, timeZone: '' }));
  await ok(addVendor(slug, { name: 'Cedar Hollow Barn', category: 'venue', contactName: '', email: '', phone: '' }));
  vendorId = (await db.vendor.findFirstOrThrow({ where: { orgId } })).id;
  await ok(addCategory(slug, { name: 'Venue', estimate: '9500' }));
  categoryId = (await db.budgetCategory.findFirstOrThrow({ where: { orgId } })).id;
});

describe('soloAllowed (pure)', () => {
  it('one partner, never paired, and the actor is that partner', () => {
    const partner = { userId: 'a', isPartner: true };
    expect(soloAllowed({ partnerCount: 1, everPaired: false }, partner)).toBe(true);
    expect(soloAllowed({ partnerCount: 2, everPaired: false }, partner)).toBe(false);
    expect(soloAllowed({ partnerCount: 1, everPaired: true }, partner)).toBe(false);
    expect(soloAllowed({ partnerCount: 1, everPaired: false }, { userId: 'h', isPartner: false })).toBe(false);
    expect(soloAllowed({ partnerCount: 0, everPaired: false }, partner)).toBe(false);
  });
});

describe('the only partner of a never-paired workspace', () => {
  it('books, signs, spends over the threshold, moves the date and changes the rules alone; each is marked solo', async () => {
    await ok(proposeBooking(slug, { id: vendorId }));
    await ok(proposeContract(slug, { id: vendorId, total: '9,000' }));
    expect(await ok(addExpense(slug, { categoryId, vendorId, description: 'Venue deposit', amount: '2,000', paidOn: '' }))).toMatch(/budget$/); // recorded, not parked
    const to = addDays(date, 42);
    await ok(proposeDateMove(slug, { to, fingerprint: await fp(to) }));
    await ok(proposeSettings(slug, { spendThreshold: '750', consentExpiryDays: '10', chaseBufferDays: '14' }));

    expect(await db.vendor.findUniqueOrThrow({ where: { id: vendorId } })).toMatchObject({ status: 'booked', contractTotalCents: 900_000 });
    expect(await db.expense.findMany({ where: { orgId } })).toMatchObject([{ amountCents: 200_000 }]);
    const w = await wedding();
    expect(dayOfDb(w.date)).toBe(to);
    expect(w).toMatchObject({ spendThresholdCents: 75_000, consentExpiryDays: 10, pairedAt: null });

    const rs = await requests();
    expect(rs.map((r) => r.kind)).toEqual(['book_vendor', 'sign_contract', 'spend', 'change_date', 'change_settings']);
    for (const r of rs) {
      expect(r).toMatchObject({ status: 'approved', solo: true, proposerId: a, deciderId: null });
      expect(r.executedAt).toEqual(r.decidedAt);
    }
    // The feed says so: each approval entry carries solo.
    const approvals = (await log(orgId)).filter((e) => e.action === 'knotwork.request.approved');
    expect(approvals).toHaveLength(5);
    for (const e of approvals) expect(e.data).toMatchObject({ solo: true, after: { status: 'approved', solo: true } });
    // The date move still raised its flag on the (solo-)booked vendor.
    expect(await db.vendorFlag.count({ where: { orgId, reason: 'date_moved' } })).toBe(1);
  });

  it('a solo date move still needs the preview the proposer saw', async () => {
    await refused(proposeDateMove(slug, { to: addDays(date, 42), fingerprint: 'stale' }), /plan changed since this preview/);
    expect(dayOfDb((await wedding()).date)).toBe(date);
    expect(await requests()).toEqual([]);
  });

  it('if the action cannot go ahead, no approved request is left behind', async () => {
    await ok(proposeBooking(slug, { id: vendorId }));
    const before = await snapshot();
    await refused(proposeBooking(slug, { id: vendorId }), /already booked/);
    expect(await snapshot()).toBe(before);
  });

  it('a helper gets nothing from solo mode', async () => {
    await db.helperGrant.createMany({ data: (['budget_edit', 'vendors_edit'] as const).map((scope) => ({ orgId, userId: helper, scope })) });
    await as(helper);
    await refused(proposeBooking(slug, { id: vendorId }), /do not have access/);
    await refused(addExpense(slug, { categoryId, vendorId: '', description: 'Band', amount: '3000', paidOn: '' }), /one of the partners has to propose it/);
    expect(await requests()).toEqual([]);
  });
});

describe('pairing ends solo mode for good', () => {
  it('with a second partner, the same action waits for them', async () => {
    const b = await joinPartner();
    await ok(proposeBooking(slug, { id: vendorId }));
    expect(await requests()).toMatchObject([{ status: 'pending', solo: false }]);
    expect((await db.vendor.findUniqueOrThrow({ where: { id: vendorId } })).status).toBe('considering');
    expect((await wedding()).pairedAt).not.toBeNull(); // latched by the proposal
    await as(b);
    await ok(approveRequest(slug, { id: (await requests())[0]!.id }));
    expect(await requests()).toMatchObject([{ status: 'approved', solo: false, deciderId: b }]);
  });

  it('removing your partner does not bring solo back', async () => {
    const b = await joinPartner();
    await withOrg({ orgId }, async (tx) => syncPairing(tx, { orgId }, await wedding())); // what any page load by either of them does
    await db.membership.delete({ where: { orgId_userId: { orgId, userId: b } } });
    await as(a);
    await ok(proposeBooking(slug, { id: vendorId }));
    expect(await requests()).toMatchObject([{ status: 'pending', solo: false }]); // waits for a partner who is not there
    expect((await db.vendor.findUniqueOrThrow({ where: { id: vendorId } })).status).toBe('considering');
  });

  it('the latch is set once and its time never moves', async () => {
    await joinPartner();
    const first = (await withOrg({ orgId }, async (tx) => syncPairing(tx, { orgId }, await wedding()))).wedding.pairedAt!;
    const again = (await withOrg({ orgId }, async (tx) => syncPairing(tx, { orgId }, await wedding()))).wedding.pairedAt!;
    expect(again).toEqual(first);
  });
});

describe('the database checks the solo mark (raw SQL as the owner role)', () => {
  const sql = (q: string) => db.$executeRawUnsafe(q);
  const pendingRow = () => db.consentRequest.create({ data: { orgId, kind: 'book_vendor', payload: { vendorId }, summary: 'raw', proposerId: a, expiresAt: new Date(now().getTime() + 86_400_000) } });
  const goSolo = (id: string) => sql(`UPDATE "ConsentRequest" SET status = 'approved', solo = true, "decidedAt" = now(), "executedAt" = now() WHERE id = '${id}'`);

  it('accepts it only for one partner, the proposer, in a never-paired workspace', async () => {
    await expect(goSolo((await pendingRow()).id)).resolves.toBe(1);
    // Two partners: refused.
    const b = await joinPartner();
    await expect(goSolo((await pendingRow()).id)).rejects.toThrow(/solo is only for a workspace with one partner/);
    // One partner again, but the wedding was paired: refused.
    await sql(`UPDATE "Wedding" SET "pairedAt" = now() WHERE "orgId" = '${orgId}'`);
    await db.membership.delete({ where: { orgId_userId: { orgId, userId: b } } });
    await expect(goSolo((await pendingRow()).id)).rejects.toThrow(/solo is only for a workspace with one partner/);
    await expect(sql(`UPDATE "Wedding" SET "pairedAt" = NULL WHERE "orgId" = '${orgId}'`)).rejects.toThrow(/a paired wedding stays paired/);
  });

  it('refuses solo for a request someone else proposed, a solo request with a decider, and a request born decided', async () => {
    const other = await db.consentRequest.create({ data: { orgId, kind: 'book_vendor', payload: { vendorId }, summary: 'raw', proposerId: helper, expiresAt: new Date(now().getTime() + 86_400_000) } });
    await expect(goSolo(other.id)).rejects.toThrow(/solo is only for a workspace with one partner/);
    const mine = await pendingRow();
    await expect(sql(`UPDATE "ConsentRequest" SET status = 'approved', solo = true, "deciderId" = '${helper}', "decidedAt" = now(), "executedAt" = now() WHERE id = '${mine.id}'`)).rejects.toThrow(/ConsentRequest_solo_check/);
    await expect(sql(`UPDATE "ConsentRequest" SET solo = true WHERE id = '${mine.id}'`)).rejects.toThrow(/ConsentRequest_solo_check/);
    await expect(sql(`INSERT INTO "ConsentRequest" (id, "orgId", kind, status, solo, payload, summary, "proposerId", "expiresAt", "decidedAt", "executedAt") VALUES (gen_random_uuid(), '${orgId}', 'spend', 'approved', true, '{}', 'x', '${a}', now(), now(), now())`)).rejects.toThrow(/a request starts pending/);
  });
});
