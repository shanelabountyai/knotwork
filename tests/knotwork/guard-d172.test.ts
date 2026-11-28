import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { destroyOrg } from '@/app/o/[org]/settings/danger/actions';
import { addCategory, addExpense, addVendor, approveRequest, createWedding, proposeBooking, proposeContract, proposeDateMove, proposeSettings } from '@/app/o/[org]/wedding/actions';
import { proposeMode } from '@/app/o/[org]/wedding/life/actions';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { addDays, dayOfDb, todayIn } from '@/lib/knotwork/days';
import { previewDateMove } from '@/lib/knotwork/schedule/store';
import { resetAuthTables } from '../helpers/auth';
import { addMember, makeOrg } from '../helpers/org';
import { as, db, goToDay, makeWedding, ok, outcome, type Couple } from './db';

// D-190 to D-197: the five findings D-172 recorded from the independent review of PR #8, attacked with raw SQL as the
// owner role, past all application code, and each beside the legitimate path it must not refuse (two keys, solo mode,
// a reversal, a fresh proposal, a date move, the mode switch, the vendor and expense flows, deleting the workspace).
// Migration: prisma/migrations/20261128000010_knotwork_guard_d172. Each attack below goes through when its trigger is
// switched off (the PR body lists which test fails with which trigger disabled).
const MIGRATION = 'prisma/migrations/20261128000010_knotwork_guard_d172/migration.sql';
const USED = /that request has already been used/;
const today = () => todayIn('America/Chicago', now());
const sql = (q: string) => db.$executeRawUnsafe(q);
let c: Couple;
let date: string;
let vendorId: string;
let categoryId: string;

const wedding = (orgId = c.orgId) => db.wedding.findUniqueOrThrow({ where: { orgId } });
const vendor = (id = vendorId) => db.vendor.findUniqueOrThrow({ where: { id } });
const pending = (kind: string, orgId = c.orgId) => db.consentRequest.findFirstOrThrow({ where: { orgId, kind: kind as never, status: 'pending' }, orderBy: { proposedAt: 'desc' } });
const latestApproved = (kind: string, orgId = c.orgId) => db.consentRequest.findFirstOrThrow({ where: { orgId, kind: kind as never, status: 'approved' }, orderBy: [{ executedAt: 'desc' }, { proposedAt: 'desc' }] });
const fingerprintFor = async (to: string) => (await withOrg({ orgId: c.orgId }, async (tx) => previewDateMove(tx, { orgId: c.orgId }, await wedding(), to))).preview.fingerprint;

/** Rowan holds the second key: approves Juniper's newest pending request of this kind through the real action. */
async function approve(kind: string, extra: Record<string, string> = {}) {
  const r = await pending(kind);
  await as(c.b);
  await ok(approveRequest(c.slug, { id: r.id, ...extra }));
  await as(c.a);
  return r.id;
}
async function book() {
  await as(c.a);
  await ok(proposeBooking(c.slug, { id: vendorId }));
  return approve('book_vendor');
}
async function sign(total = '8,400.00') {
  await as(c.a);
  await ok(proposeContract(c.slug, { id: vendorId, total }));
  return approve('sign_contract');
}
async function spend(amount: string) {
  await as(c.a);
  await ok(addExpense(c.slug, { categoryId, vendorId: '', description: 'Flowers', amount, paidOn: '' }));
  return approve('spend');
}
/** A request written and approved by raw SQL with the other partner named as decider: finding 1's remaining gap (D-190), used here only to build an approved request the app never executed. */
async function forged(kind: string, payload: object, orgId = c.orgId, proposerId = c.a, deciderId = c.b) {
  const r = await db.consentRequest.create({ data: { orgId, kind: kind as never, payload, summary: 'raw', proposerId, expiresAt: new Date(now().getTime() + 86_400_000) } });
  await sql(`UPDATE "ConsentRequest" SET status = 'approved', "deciderId" = '${deciderId}', "decidedAt" = now(), "executedAt" = now() WHERE id = '${r.id}'`);
  return r.id;
}

beforeEach(async () => {
  date = addDays(today(), 330);
  c = await makeWedding(date);
  await ok(addVendor(c.slug, { name: 'Fennel & Fig Catering', category: 'caterer', contactName: 'Sam Example', email: '', phone: '' }));
  vendorId = (await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId } })).id;
  await ok(addCategory(c.slug, { name: 'Catering', estimate: '12,000' }));
  categoryId = (await db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId } })).id;
});

describe('finding 3 (D-191): a request books a vendor, or signs its contract, once', () => {
  it('booked with A; un-booked by raw SQL, A does not book it again; a fresh request B does; then neither A nor B', async () => {
    const a = await book();
    expect(await vendor()).toMatchObject({ status: 'booked', bookedRequestId: a, usedRequestIds: [a] });
    // Un-booking is not what the guard stops (nothing in the app does it); booking again with the same request is.
    await expect(sql(`UPDATE "Vendor" SET status = 'considering' WHERE id = '${vendorId}'`)).resolves.toBe(1);
    await expect(sql(`UPDATE "Vendor" SET status = 'booked' WHERE id = '${vendorId}'`)).rejects.toThrow(USED);
    await expect(sql(`UPDATE "Vendor" SET status = 'booked', "bookedRequestId" = '${a}' WHERE id = '${vendorId}'`)).rejects.toThrow(USED);
    // Clearing the id first does not make the request new.
    await expect(sql(`UPDATE "Vendor" SET "bookedRequestId" = NULL WHERE id = '${vendorId}'`)).resolves.toBe(1);
    await expect(sql(`UPDATE "Vendor" SET status = 'booked', "bookedRequestId" = '${a}' WHERE id = '${vendorId}'`)).rejects.toThrow(USED);
    expect((await vendor()).status).toBe('considering');
    // Proposing it again is a new request, so it goes through.
    const b = await book();
    expect(await vendor()).toMatchObject({ status: 'booked', bookedRequestId: b, usedRequestIds: [a, b] });
    // A -> B -> A: the older request is not new again either (the gap PR #8 closed for the date, rules and mode).
    await sql(`UPDATE "Vendor" SET status = 'dropped' WHERE id = '${vendorId}'`);
    await expect(sql(`UPDATE "Vendor" SET status = 'booked', "bookedRequestId" = '${a}' WHERE id = '${vendorId}'`)).rejects.toThrow(USED);
    await expect(sql(`UPDATE "Vendor" SET status = 'booked' WHERE id = '${vendorId}'`)).rejects.toThrow(USED);
  });

  it('signed with A; the signing day cleared or moved by raw SQL, A does not sign again; a fresh request does', async () => {
    const a = await sign();
    expect(await vendor()).toMatchObject({ contractRequestId: a, contractTotalCents: 840_000, usedRequestIds: [a] });
    // Moving the signing day keeps asking for a request: the same one is refused.
    await expect(sql(`UPDATE "Vendor" SET "contractSignedOn" = "contractSignedOn" - 30 WHERE id = '${vendorId}'`)).rejects.toThrow(USED);
    await expect(sql(`UPDATE "Vendor" SET "contractSignedOn" = NULL WHERE id = '${vendorId}'`)).resolves.toBe(1);
    await expect(sql(`UPDATE "Vendor" SET "contractSignedOn" = '2026-01-01', "contractTotalCents" = 1 WHERE id = '${vendorId}'`)).rejects.toThrow(USED);
    await expect(sql(`UPDATE "Vendor" SET "contractSignedOn" = '2026-01-01', "contractRequestId" = '${a}' WHERE id = '${vendorId}'`)).rejects.toThrow(USED);
    await expect(sql(`UPDATE "Vendor" SET "contractRequestId" = NULL WHERE id = '${vendorId}'`)).resolves.toBe(1);
    await expect(sql(`UPDATE "Vendor" SET "contractSignedOn" = '2026-01-01', "contractRequestId" = '${a}' WHERE id = '${vendorId}'`)).rejects.toThrow(USED);
    expect((await vendor()).contractSignedOn).toBeNull();
    const b = await sign('9,000.00');
    expect(await vendor()).toMatchObject({ contractRequestId: b, contractTotalCents: 900_000, usedRequestIds: [a, b] });
    expect(dayOfDb((await vendor()).contractSignedOn!)).toBe(today());
  });

  it('booking and signing the same vendor, each with its own request, both go through; everything else on the vendor still changes freely', async () => {
    const a = await book();
    const s = await sign();
    expect(await vendor()).toMatchObject({ status: 'booked', bookedRequestId: a, contractRequestId: s, usedRequestIds: [a, s] });
    await expect(sql(`UPDATE "Vendor" SET notes = 'tasting on Friday', "countEstimate" = 120 WHERE id = '${vendorId}'`)).resolves.toBe(1);
    expect((await vendor()).usedRequestIds).toEqual([a, s]);
  });

  it('no writer may set the list, and a vendor re-created under the same id starts with its requests already used', async () => {
    const a = await book();
    await expect(sql(`UPDATE "Vendor" SET "usedRequestIds" = '{}' WHERE id = '${vendorId}'`)).rejects.toThrow(/kept by the database/);
    await expect(db.vendor.update({ where: { id: vendorId }, data: { usedRequestIds: [] } })).rejects.toThrow(/kept by the database/);
    expect((await vendor()).usedRequestIds).toEqual([a]);
    // Delete the row and insert it again: the request that named this id is still an approved one.
    await expect(sql(`DELETE FROM "Vendor" WHERE id = '${vendorId}'`)).resolves.toBe(1);
    await expect(sql(`INSERT INTO "Vendor" (id, "orgId", name, category, status, "bookedRequestId") VALUES ('${vendorId}', '${c.orgId}', 'Again', 'caterer', 'booked', '${a}')`)).rejects.toThrow(USED);
    const again = await db.vendor.create({ data: { id: vendorId, orgId: c.orgId, name: 'Again', category: 'caterer', usedRequestIds: [] } });
    expect(again.usedRequestIds).toEqual([a]);
    await expect(sql(`UPDATE "Vendor" SET status = 'booked', "bookedRequestId" = '${a}' WHERE id = '${vendorId}'`)).rejects.toThrow(USED);
    // Nor by giving another vendor that id.
    await sql(`DELETE FROM "Vendor" WHERE id = '${vendorId}'`);
    const other = await db.vendor.create({ data: { orgId: c.orgId, name: 'Other', category: 'dj' } });
    expect(other.usedRequestIds).toEqual([]);
    await expect(sql(`UPDATE "Vendor" SET id = '${vendorId}', status = 'booked', "bookedRequestId" = '${a}' WHERE id = '${other.id}'`)).rejects.toThrow(USED);
  });

  it('in solo mode (D-33) the only partner books and signs at once; the same requests do not work a second time', async () => {
    await resetAuthTables();
    const org = await makeOrg('solo-d172');
    const a = (await addMember(org.id, 'owner', 'juniper@example.test')).id;
    await as(a);
    await ok(createWedding(org.slug, { title: 'Juniper', date: addDays(today(), 200), timeZone: 'America/Chicago' }));
    await ok(addVendor(org.slug, { name: 'Solo Strings', category: 'dj', contactName: '', email: '', phone: '' }));
    const v = await db.vendor.findFirstOrThrow({ where: { orgId: org.id } });
    await ok(proposeBooking(org.slug, { id: v.id }));
    await ok(proposeContract(org.slug, { id: v.id, total: '1,200.00' }));
    const booked = await latestApproved('book_vendor', org.id);
    const signed = await latestApproved('sign_contract', org.id);
    expect(booked.solo && signed.solo).toBe(true);
    expect(await vendor(v.id)).toMatchObject({ status: 'booked', usedRequestIds: [booked.id, signed.id] });
    await sql(`UPDATE "Vendor" SET status = 'considering', "contractSignedOn" = NULL WHERE id = '${v.id}'`);
    await expect(sql(`UPDATE "Vendor" SET status = 'booked' WHERE id = '${v.id}'`)).rejects.toThrow(USED);
    await expect(sql(`UPDATE "Vendor" SET "contractSignedOn" = '2026-01-01' WHERE id = '${v.id}'`)).rejects.toThrow(USED);
    // The solo partner asks again: a new request, executed at once.
    await ok(proposeBooking(org.slug, { id: v.id }));
    expect((await vendor(v.id)).status).toBe('booked');
  });
});

describe('finding 3 (D-192): an approved expense is never deleted, so its spend request is never new again', () => {
  const insert = (cents: number, req: string | null) =>
    sql(`INSERT INTO "Expense" (id, "orgId", "categoryId", description, "amountCents", "paidOn", "requestId") VALUES (gen_random_uuid(), '${c.orgId}', '${categoryId}', 'raw', ${cents}, '2026-11-23', ${req ? `'${req}'` : 'NULL'})`);

  it('the expense cannot be deleted, alone or with its category; the request is not spent twice; an expense with no request still can be', async () => {
    const r = await spend('900');
    expect(await db.expense.findMany({ where: { orgId: c.orgId } })).toMatchObject([{ amountCents: 90_000, requestId: r }]);
    await expect(sql(`DELETE FROM "Expense" WHERE "requestId" = '${r}'`)).rejects.toThrow(/an approved expense is never deleted/);
    await expect(sql(`DELETE FROM "BudgetCategory" WHERE id = '${categoryId}'`)).rejects.toThrow(/an approved expense is never deleted/);
    await expect(insert(90_000, r)).rejects.toThrow(/already been spent/);
    expect(await db.expense.count({ where: { orgId: c.orgId } })).toBe(1);
    // Under the threshold there is no request to protect: the row behaves as before.
    await ok(addExpense(c.slug, { categoryId, vendorId: '', description: 'Tasting fee', amount: '150', paidOn: '' }));
    await expect(sql(`DELETE FROM "Expense" WHERE "requestId" IS NULL AND "orgId" = '${c.orgId}'`)).resolves.toBe(1);
    // And a second spend, asked for again, is a new request.
    const again = await spend('900');
    expect(again).not.toBe(r);
    expect(await db.expense.count({ where: { orgId: c.orgId, requestId: { not: null } } })).toBe(2);
  });
});

describe('finding 2 (D-193): a pending request cannot be burned by naming it', () => {
  it('the date: naming a pending change_date request without moving the date is refused, and its approval still goes through', async () => {
    const to = addDays(date, 42);
    await as(c.a);
    await ok(proposeDateMove(c.slug, { to, fingerprint: await fingerprintFor(to) }));
    const r = await pending('change_date');
    await expect(sql(`UPDATE "Wedding" SET "dateRequestId" = '${r.id}' WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(/named only when it changes the date/);
    expect(await wedding()).toMatchObject({ dateRequestId: null, usedRequestIds: [] });
    await approve('change_date', { fingerprint: await fingerprintFor(to) });
    expect(await wedding()).toMatchObject({ dateRequestId: r.id, usedRequestIds: [r.id] });
    expect(dayOfDb((await wedding()).date)).toBe(to);
    // Clearing the id is still allowed (PR #8's test relies on it); naming any request without a move is not.
    await expect(sql(`UPDATE "Wedding" SET "dateRequestId" = NULL WHERE "orgId" = '${c.orgId}'`)).resolves.toBe(1);
  });

  it('the approval rules: naming a pending change_settings request without changing them is refused, and its approval still goes through', async () => {
    await as(c.a);
    await ok(proposeSettings(c.slug, { spendThreshold: '600', consentExpiryDays: '7', chaseBufferDays: '14' }));
    const r = await pending('change_settings');
    await expect(sql(`UPDATE "Wedding" SET "settingsRequestId" = '${r.id}' WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(/named only when it changes the approval rules/);
    expect(await wedding()).toMatchObject({ settingsRequestId: null, usedRequestIds: [] });
    await approve('change_settings', { fingerprint: '' });
    expect(await wedding()).toMatchObject({ spendThresholdCents: 60_000, settingsRequestId: r.id, usedRequestIds: [r.id] });
  });

  it('a wedding is born naming no request', async () => {
    const org = await makeOrg('unborn');
    const a = (await addMember(org.id, 'owner', 'a@example.test')).id;
    const r = await db.consentRequest.create({ data: { orgId: org.id, kind: 'change_date', payload: { from: '2027-01-01', to: '2027-02-01' }, summary: 'raw', proposerId: a, expiresAt: new Date(now().getTime() + 86_400_000) } });
    const born = (col: string) => sql(`INSERT INTO "Wedding" (id, "orgId", title, date, "${col}", "updatedAt") VALUES (gen_random_uuid(), '${org.id}', 'x', '2027-02-01', '${r.id}', now())`);
    await expect(born('dateRequestId')).rejects.toThrow(/a wedding starts with no request/);
    await expect(born('settingsRequestId')).rejects.toThrow(/a wedding starts with no request/);
    await expect(db.wedding.create({ data: { orgId: org.id, title: 'x', date: new Date('2027-02-01T00:00:00Z') } })).resolves.toMatchObject({ dateRequestId: null, usedRequestIds: [] });
  });

  it('a spend: a small expense cannot name a pending spend request, and the approval then still spends it', async () => {
    await as(c.a);
    await ok(addExpense(c.slug, { categoryId, vendorId: '', description: 'Flowers', amount: '900', paidOn: '' }));
    const r = await pending('spend');
    const small = (cents: number) => sql(`INSERT INTO "Expense" (id, "orgId", "categoryId", description, "amountCents", "paidOn", "requestId") VALUES (gen_random_uuid(), '${c.orgId}', '${categoryId}', 'raw', ${cents}, '2026-11-23', '${r.id}')`);
    await expect(small(100)).rejects.toThrow(/an expense that names a request needs an approved spend request/);
    await approve('spend');
    expect(await db.expense.findMany({ where: { orgId: c.orgId } })).toMatchObject([{ amountCents: 90_000, requestId: r.id }]);
    await expect(small(100)).rejects.toThrow(/already been spent/);
  });

  it('a spend approved after the threshold was raised past it is still recorded with its request', async () => {
    // The legitimate expense at or under the threshold that names a request: asked for at 900 when the threshold was
    // 500, approved after the rules moved the threshold to 1,000.
    await as(c.a);
    await ok(addExpense(c.slug, { categoryId, vendorId: '', description: 'Flowers', amount: '900', paidOn: '' }));
    const r = await pending('spend');
    await ok(proposeSettings(c.slug, { spendThreshold: '1000', consentExpiryDays: '7', chaseBufferDays: '14' }));
    await approve('change_settings', { fingerprint: '' });
    await as(c.b);
    await ok(approveRequest(c.slug, { id: r.id }));
    expect(await db.expense.findMany({ where: { orgId: c.orgId } })).toMatchObject([{ amountCents: 90_000, requestId: r.id }]);
  });

  it('a vendor: naming a pending booking request early burns nothing (the list only takes a request when it is used)', async () => {
    await as(c.a);
    await ok(proposeBooking(c.slug, { id: vendorId }));
    const r = await pending('book_vendor');
    await expect(sql(`UPDATE "Vendor" SET "bookedRequestId" = '${r.id}' WHERE id = '${vendorId}'`)).resolves.toBe(1);
    expect((await vendor()).usedRequestIds).toEqual([]);
    await approve('book_vendor');
    expect(await vendor()).toMatchObject({ status: 'booked', bookedRequestId: r.id, usedRequestIds: [r.id] });
  });
});

describe('finding 5 (D-194): the date and the approval rules are the ones the request approved', () => {
  it('an approved change_date request moves the wedding to its own date and to no other', async () => {
    const to = addDays(date, 42);
    const r = await forged('change_date', { from: date, to });
    await expect(sql(`UPDATE "Wedding" SET date = '${addDays(date, 100)}', "dateRequestId" = '${r}' WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(/that request approved a different date/);
    await expect(sql(`UPDATE "Wedding" SET date = date - 1, "dateRequestId" = '${r}' WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(/that request approved a different date/);
    expect(await wedding()).toMatchObject({ dateRequestId: null, usedRequestIds: [] });
    await expect(sql(`UPDATE "Wedding" SET date = '${to}', "dateRequestId" = '${r}' WHERE "orgId" = '${c.orgId}'`)).resolves.toBe(1);
    expect(dayOfDb((await wedding()).date)).toBe(to);
    // A request with no date in it approves none.
    const empty = await forged('change_date', {});
    await expect(sql(`UPDATE "Wedding" SET date = date + 7, "dateRequestId" = '${empty}' WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(/that request approved a different date/);
  });

  it('an approved change_settings request sets its own three rules and no others', async () => {
    const r = await forged('change_settings', { spendThresholdCents: 60_000, consentExpiryDays: 7, chaseBufferDays: 14 });
    const set = (rules: string) => sql(`UPDATE "Wedding" SET ${rules}, "settingsRequestId" = '${r}' WHERE "orgId" = '${c.orgId}'`);
    await expect(set(`"spendThresholdCents" = 99999999`)).rejects.toThrow(/that request approved different approval rules/);
    await expect(set(`"spendThresholdCents" = 60000, "consentExpiryDays" = 365`)).rejects.toThrow(/that request approved different approval rules/);
    await expect(set(`"chaseBufferDays" = 0`)).rejects.toThrow(/that request approved different approval rules/);
    expect(await wedding()).toMatchObject({ spendThresholdCents: 50_000, settingsRequestId: null, usedRequestIds: [] });
    await expect(set(`"spendThresholdCents" = 60000`)).resolves.toBe(1);
    expect(await wedding()).toMatchObject({ spendThresholdCents: 60_000, consentExpiryDays: 7, chaseBufferDays: 14, settingsRequestId: r });
  });

  it('through the app nothing changes: two moves of the date, the rules changed twice, the mode there and back', async () => {
    const move = async (to: string) => {
      await as(c.a);
      await ok(proposeDateMove(c.slug, { to, fingerprint: await fingerprintFor(to) }));
      return approve('change_date', { fingerprint: await fingerprintFor(to) });
    };
    const rules = async (spendThreshold: string) => {
      await as(c.a);
      await ok(proposeSettings(c.slug, { spendThreshold, consentExpiryDays: '10', chaseBufferDays: '21' }));
      return approve('change_settings', { fingerprint: '' });
    };
    const d1 = await move(addDays(date, 42));
    const d2 = await move(addDays(date, -300)); // back, to a day near today
    const s1 = await rules('600');
    const s2 = await rules('500');
    expect(await wedding()).toMatchObject({ spendThresholdCents: 50_000, consentExpiryDays: 10, chaseBufferDays: 21, dateRequestId: d2, settingsRequestId: s2 });
    expect(dayOfDb((await wedding()).date)).toBe(addDays(date, -300));
    goToDay(addDays(date, -299));
    const mode = async (to: 'life' | 'planning') => {
      await as(c.a);
      await ok(proposeMode(c.slug, { to }));
      return approve('set_mode', { fingerprint: '' });
    };
    const m1 = await mode('life');
    const m2 = await mode('planning');
    expect(await wedding()).toMatchObject({ mode: 'planning', modeRequestId: m2, usedRequestIds: [d1, d2, s1, s2, m1, m2] });
  });
});

describe('finding 4 (D-195): a wedding is never deleted on its own', () => {
  it('raw SQL and Prisma are both refused; nothing was removed', async () => {
    await expect(sql(`DELETE FROM "Wedding" WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(/a wedding is never deleted on its own/);
    await expect(db.wedding.delete({ where: { orgId: c.orgId } })).rejects.toThrow(/a wedding is never deleted on its own/);
    expect(await db.wedding.count({ where: { orgId: c.orgId } })).toBe(1);
  });

  it('deleting the workspace (the export-and-delete page) still takes the wedding, a booked vendor and an approved expense with it', async () => {
    await book();
    await sign();
    await spend('900');
    await as(c.a);
    expect(await outcome(destroyOrg(c.slug, { confirm: c.slug }))).toMatchObject({ nav: 'redirect', to: '/onboarding' });
    expect(await db.org.count({ where: { id: c.orgId } })).toBe(0);
    for (const n of [await db.wedding.count(), await db.vendor.count(), await db.expense.count(), await db.consentRequest.count()]) expect(n).toBe(0);
    // And by raw SQL, as the tests of the other guards do it.
    const other = await makeOrg('goes-too');
    await db.wedding.create({ data: { orgId: other.id, title: 'x', date: new Date('2027-02-01T00:00:00Z') } });
    await expect(sql(`DELETE FROM "Org" WHERE id = '${other.id}'`)).resolves.toBe(1);
    expect(await db.wedding.count()).toBe(0);
  });
});

describe('finding 1 (D-190), partly: the decider of an approval is a partner of the workspace', () => {
  const approveAs = (id: string, deciderId: string) => sql(`UPDATE "ConsentRequest" SET status = 'approved', "deciderId" = '${deciderId}', "decidedAt" = now(), "executedAt" = now() WHERE id = '${id}'`);

  it('a helper, a partner of another workspace and a made-up id are refused as deciders', async () => {
    await as(c.a);
    await ok(proposeBooking(c.slug, { id: vendorId }));
    const r = await pending('book_vendor');
    const elsewhere = await makeOrg('elsewhere');
    const stranger = (await addMember(elsewhere.id, 'owner', 'stranger@example.test')).id;
    for (const who of [c.helper, stranger, '00000000-0000-4000-8000-000000000001']) await expect(approveAs(r.id, who)).rejects.toThrow(/only a partner of this workspace can approve a request/);
    expect((await db.consentRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('pending');
    // Declining and withdrawing are not approvals and are left as they were; the real second key still approves.
    await approve('book_vendor');
    expect(await vendor()).toMatchObject({ status: 'booked', bookedRequestId: r.id });
  });

  it('NOT closed, recorded in D-190: raw SQL naming the real other partner still passes (the database cannot know who is asking)', async () => {
    await as(c.a);
    await ok(proposeBooking(c.slug, { id: vendorId }));
    const r = await pending('book_vendor');
    await expect(approveAs(r.id, c.b)).resolves.toBe(1);
  });
});

describe('the migration on existing data', () => {
  const backfill = () => {
    const text = readFileSync(MIGRATION, 'utf8');
    const start = text.indexOf('-- BACKFILL.');
    const end = text.indexOf('-- END BACKFILL');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return sql(text.slice(start, end));
  };
  afterEach(async () => {
    await sql('ALTER TABLE "Vendor" ENABLE TRIGGER "Vendor_request_once"');
  });

  it('marks every approved booking and contract request that names a vendor as used on that vendor, and no other', async () => {
    const a = await book();
    const s = await sign();
    await ok(addVendor(c.slug, { name: 'Second Vendor', category: 'dj', contactName: '', email: '', phone: '' }));
    const second = await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Second Vendor' } });
    // The state before the migration: no list on any vendor.
    await sql('ALTER TABLE "Vendor" DISABLE TRIGGER "Vendor_request_once"');
    await sql(`UPDATE "Vendor" SET "usedRequestIds" = NULL WHERE "orgId" = '${c.orgId}'`);
    await backfill();
    await sql('ALTER TABLE "Vendor" ENABLE TRIGGER "Vendor_request_once"');
    expect([...(await vendor()).usedRequestIds].sort()).toEqual([a, s].sort());
    expect((await vendor(second.id)).usedRequestIds).toEqual([]);
    await sql(`UPDATE "Vendor" SET status = 'considering', "contractSignedOn" = NULL WHERE id = '${vendorId}'`);
    await expect(sql(`UPDATE "Vendor" SET status = 'booked' WHERE id = '${vendorId}'`)).rejects.toThrow(USED);
    await expect(sql(`UPDATE "Vendor" SET "contractSignedOn" = '2026-01-01' WHERE id = '${vendorId}'`)).rejects.toThrow(USED);
    // The next legitimate booking, of this vendor again and of the other one, still goes through.
    const fresh = await book();
    expect(await vendor()).toMatchObject({ status: 'booked', bookedRequestId: fresh });
    vendorId = second.id;
    const other = await book();
    expect(await vendor(second.id)).toMatchObject({ status: 'booked', usedRequestIds: [other] });
  });
});
