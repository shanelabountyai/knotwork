import { beforeEach, describe, expect, it } from 'vitest';
import {
  addCategory, addExpense, addVendor, addVendorPayment, approveRequest, declineRequest, payVendorPayment, proposeBooking, proposeContract, proposeDateMove,
  proposeSettings, updateVendor, withdrawRequest,
} from '@/app/o/[org]/wedding/actions';
import { advanceClock, now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { addDays, dayOfDb, todayIn } from '@/lib/knotwork/days';
import { previewDateMove } from '@/lib/knotwork/schedule/store';
import { as, db, log, makeWedding, ok, outcome, refused, snapshot, type Couple } from './db';

// PRD P0-2 success metric: "designated actions never execute single-signed (API-level test)".
// Three layers are attacked here: the actions (as one partner alone), the state machine through the database (expiry,
// replays), and the database itself (raw SQL as the owner role, past all application code).
const today = () => todayIn('America/Chicago', now());
let c: Couple;
let vendorId: string;
let categoryId: string;
let date: string;

const pending = (kind: string) => db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: kind as never, status: 'pending' }, orderBy: { proposedAt: 'desc' } });
const vendor = () => db.vendor.findUniqueOrThrow({ where: { id: vendorId } });
const wedding = () => db.wedding.findUniqueOrThrow({ where: { orgId: c.orgId } });
const fingerprintFor = async (to: string) => (await withOrg({ orgId: c.orgId }, async (tx) => previewDateMove(tx, { orgId: c.orgId }, await wedding(), to))).preview.fingerprint;

beforeEach(async () => {
  date = addDays(today(), 330);
  c = await makeWedding(date);
  await ok(addVendor(c.slug, { name: 'Fennel & Fig Catering', category: 'caterer', contactName: 'Sam Example', email: '', phone: '' }));
  vendorId = (await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId } })).id;
  await ok(addCategory(c.slug, { name: 'Catering', estimate: '12,000' }));
  categoryId = (await db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId } })).id;
});

// One proposal of every designated kind, by partner A. Returns the request and a check that the action has NOT happened.
const DESIGNATED: Record<string, { propose: () => Promise<unknown>; notDone: () => Promise<void>; done: () => Promise<void>; approveWith?: () => Promise<Record<string, string>> }> = {
  book_vendor: {
    propose: () => proposeBooking(c.slug, { id: vendorId }),
    notDone: async () => expect((await vendor()).status).toBe('considering'),
    done: async () => expect(await vendor()).toMatchObject({ status: 'booked', bookedRequestId: expect.any(String) }),
  },
  sign_contract: {
    propose: () => proposeContract(c.slug, { id: vendorId, total: '8,400.00' }),
    notDone: async () => expect((await vendor()).contractSignedOn).toBeNull(),
    done: async () => {
      const v = await vendor();
      expect(dayOfDb(v.contractSignedOn!)).toBe(today());
      expect(v.contractTotalCents).toBe(840_000); // the total that was proposed is the total that is signed
    },
  },
  spend: {
    propose: () => addExpense(c.slug, { categoryId, vendorId, description: 'Catering deposit', amount: '2,500.00', paidOn: '' }),
    notDone: async () => expect(await db.expense.count({ where: { orgId: c.orgId } })).toBe(0),
    done: async () => expect(await db.expense.findMany({ where: { orgId: c.orgId } })).toMatchObject([{ amountCents: 250_000, requestId: expect.any(String), categoryId }]),
  },
  change_date: {
    propose: async () => proposeDateMove(c.slug, { to: addDays(date, 42), fingerprint: await fingerprintFor(addDays(date, 42)) }),
    notDone: async () => expect(dayOfDb((await wedding()).date)).toBe(date),
    done: async () => expect(dayOfDb((await wedding()).date)).toBe(addDays(date, 42)),
    approveWith: async () => ({ fingerprint: await fingerprintFor(addDays(date, 42)) }),
  },
  change_settings: {
    propose: () => proposeSettings(c.slug, { spendThreshold: '100,000', consentExpiryDays: '14', chaseBufferDays: '21' }),
    notDone: async () => expect(await wedding()).toMatchObject({ spendThresholdCents: 50_000, consentExpiryDays: 7, chaseBufferDays: 14 }),
    done: async () => expect(await wedding()).toMatchObject({ spendThresholdCents: 10_000_000, consentExpiryDays: 14, chaseBufferDays: 21, settingsRequestId: expect.any(String) }),
  },
};
const kinds = Object.keys(DESIGNATED);

describe.each(kinds)('%s', (kind) => {
  const d = () => DESIGNATED[kind]!;

  it('proposing does not do it', async () => {
    await as(c.a);
    await ok(d().propose());
    await d().notDone();
    expect(await pending(kind)).toMatchObject({ proposerId: c.a, deciderId: null, executedAt: null });
  });

  it('the proposer cannot approve their own request: nothing changes', async () => {
    await as(c.a);
    await ok(d().propose());
    const r = await pending(kind);
    const before = await snapshot();
    await refused(approveRequest(c.slug, { id: r.id, ...((await d().approveWith?.()) ?? {}) }), /your partner has to decide/);
    expect(await snapshot()).toBe(before);
    await d().notDone();
  });

  it('a helper cannot approve it, even with every grant: nothing changes', async () => {
    await as(c.a);
    await ok(d().propose());
    const r = await pending(kind);
    await db.helperGrant.createMany({ data: (['schedule_edit', 'budget_edit', 'vendors_edit', 'guests_edit'] as const).map((scope) => ({ orgId: c.orgId, userId: c.helper, scope })) });
    await as(c.helper);
    const before = await snapshot();
    await refused(approveRequest(c.slug, { id: r.id, ...((await d().approveWith?.()) ?? {}) }), /Only the two partners/);
    expect(await snapshot()).toBe(before);
    await d().notDone();
  });

  it('the other partner approves: it happens, once, with both names on it', async () => {
    await as(c.a);
    await ok(d().propose());
    const r = await pending(kind);
    await as(c.b);
    await ok(approveRequest(c.slug, { id: r.id, ...((await d().approveWith?.()) ?? {}) }));
    await d().done();
    const after = await db.consentRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(after).toMatchObject({ status: 'approved', proposerId: c.a, deciderId: c.b });
    expect(after.executedAt).toEqual(after.decidedAt);
    // A second approval, by anyone, is refused: a request executes once.
    const before = await snapshot();
    await refused(approveRequest(c.slug, { id: r.id, ...((await d().approveWith?.()) ?? {}) }), /already been decided/);
    await as(c.a);
    await refused(approveRequest(c.slug, { id: r.id }), /already been decided/);
    expect(await snapshot()).toBe(before);
  });

  it('declined, withdrawn and expired requests never execute', async () => {
    await as(c.a);
    await ok(d().propose());
    const r1 = await pending(kind);
    await as(c.b);
    await ok(declineRequest(c.slug, { id: r1.id, reason: 'Not yet' }));
    await refused(approveRequest(c.slug, { id: r1.id }), /already been decided/);
    await d().notDone();

    await as(c.a);
    await ok(d().propose());
    const r2 = await pending(kind);
    await as(c.b);
    await refused(withdrawRequest(c.slug, { id: r2.id }), /Only the partner who proposed/);
    await as(c.a);
    await ok(withdrawRequest(c.slug, { id: r2.id }));
    await as(c.b);
    await refused(approveRequest(c.slug, { id: r2.id }), /already been decided/);
    await d().notDone();

    await as(c.a);
    await ok(d().propose());
    const r3 = await pending(kind);
    advanceClock(7 * 86_400_000); // exactly at expiry: expired from this instant
    await as(c.b);
    await refused(approveRequest(c.slug, { id: r3.id, ...((await d().approveWith?.()) ?? {}) }), /has expired/);
    expect((await db.consentRequest.findUniqueOrThrow({ where: { id: r3.id } })).status).toBe('expired'); // the refusal still records the expiry
    await d().notDone();
    expect((await db.consentRequest.findMany({ where: { orgId: c.orgId } })).map((r) => r.status).sort()).toEqual(['declined', 'expired', 'withdrawn']);
  });
});

describe('spend threshold', () => {
  it('at the threshold one partner records it; one cent over needs both', async () => {
    await ok(addExpense(c.slug, { categoryId, vendorId: '', description: 'Tasting fee', amount: '500.00', paidOn: '' }));
    expect(await db.expense.findMany({ where: { orgId: c.orgId } })).toMatchObject([{ amountCents: 50_000, requestId: null }]);
    expect(await ok(addExpense(c.slug, { categoryId, vendorId: '', description: 'Linens', amount: '500.01', paidOn: '' }))).toMatch(/approvals$/);
    expect(await db.expense.count({ where: { orgId: c.orgId } })).toBe(1);
    expect((await pending('spend')).payload).toMatchObject({ amountCents: 50_001, description: 'Linens' });
  });

  it('a helper with budget access records small spends and cannot propose a large one', async () => {
    await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope: 'budget_edit' } });
    await as(c.helper);
    await ok(addExpense(c.slug, { categoryId, vendorId: '', description: 'Stamps', amount: '40', paidOn: '' }));
    await refused(addExpense(c.slug, { categoryId, vendorId: '', description: 'Band', amount: '3000', paidOn: '' }), /one of the partners has to propose it/);
    expect(await db.consentRequest.count({ where: { orgId: c.orgId } })).toBe(0);
  });

  it('paying a scheduled vendor payment over the threshold is a spend like any other (D-24)', async () => {
    await ok(addVendorPayment(c.slug, { vendorId, label: 'Balance', amount: '6,000', dueDaysBefore: '30' }));
    const p = await db.vendorPayment.findFirstOrThrow({ where: { orgId: c.orgId } });
    expect(await ok(payVendorPayment(c.slug, { id: p.id, categoryId, paidOn: '' }))).toMatch(/approvals$/);
    expect((await db.vendorPayment.findUniqueOrThrow({ where: { id: p.id } })).paidOn).toBeNull();
    await as(c.b);
    await ok(approveRequest(c.slug, { id: (await pending('spend')).id }));
    const paid = await db.vendorPayment.findUniqueOrThrow({ where: { id: p.id }, include: { task: true, expense: true } });
    expect(dayOfDb(paid.paidOn!)).toBe(today());
    expect(paid.task).toMatchObject({ status: 'done' });
    expect(paid.expense).toMatchObject({ amountCents: 600_000, requestId: expect.any(String) });
    // The same payment cannot be paid twice, by request or directly.
    await refused(payVendorPayment(c.slug, { id: p.id, categoryId, paidOn: '' }), /already been paid/);
  });

  it('the threshold itself takes two keys, so one partner cannot raise it and then spend alone (D-12)', async () => {
    await ok(proposeSettings(c.slug, { spendThreshold: '1,000,000', consentExpiryDays: '7', chaseBufferDays: '14' }));
    // Still the old threshold: the large spend is proposed, not recorded.
    await ok(addExpense(c.slug, { categoryId, vendorId: '', description: 'Venue balance', amount: '9,000', paidOn: '' }));
    expect(await db.expense.count({ where: { orgId: c.orgId } })).toBe(0);
    expect((await wedding()).spendThresholdCents).toBe(50_000);
  });
});

describe('when execution cannot go ahead, the approval does not happen either', () => {
  it('two booking requests for one vendor cannot both pend; a booked vendor cannot be booked again', async () => {
    await ok(proposeBooking(c.slug, { id: vendorId }));
    await refused(proposeBooking(c.slug, { id: vendorId }), /already waiting/);
    const r = await pending('book_vendor');
    // A second pending request for the same vendor, forced past the action's duplicate check.
    const dup = await db.consentRequest.create({ data: { orgId: c.orgId, kind: 'book_vendor', payload: { vendorId }, summary: 'duplicate', proposerId: c.a, expiresAt: new Date(now().getTime() + 86_400_000) } });
    await as(c.b);
    await ok(approveRequest(c.slug, { id: r.id }));
    const before = await snapshot();
    await refused(approveRequest(c.slug, { id: dup.id }), /already booked/);
    expect(await snapshot()).toBe(before);
    expect((await db.consentRequest.findUniqueOrThrow({ where: { id: dup.id } })).status).toBe('pending'); // not approved-but-undone
    await as(c.a);
    await refused(proposeBooking(c.slug, { id: vendorId }), /already booked/);
  });
});

describe('the database refuses a single key, past all application code (raw SQL as the owner role)', () => {
  const sql = (q: string) => db.$executeRawUnsafe(q);
  const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re);

  it('a vendor cannot be booked or signed without an approved request that names it', async () => {
    await rejects(sql(`UPDATE "Vendor" SET status = 'booked' WHERE id = '${vendorId}'`), /two-key: booking a vendor needs an approved book_vendor request/);
    await ok(proposeBooking(c.slug, { id: vendorId }));
    const r = await pending('book_vendor');
    await rejects(sql(`UPDATE "Vendor" SET status = 'booked', "bookedRequestId" = '${r.id}' WHERE id = '${vendorId}'`), /two-key: booking a vendor/); // pending is not approved
    await rejects(sql(`UPDATE "Vendor" SET "contractSignedOn" = '2026-11-23' WHERE id = '${vendorId}'`), /two-key: signing a contract/);
    await rejects(sql(`INSERT INTO "Vendor" (id, "orgId", name, category, status) VALUES (gen_random_uuid(), '${c.orgId}', 'Walk-in', 'dj', 'booked')`), /two-key: booking a vendor/);
    // An approved request for ONE vendor does not book another.
    await as(c.b);
    await ok(approveRequest(c.slug, { id: r.id }));
    const other = await db.vendor.create({ data: { orgId: c.orgId, name: 'Other', category: 'dj' } });
    await rejects(sql(`UPDATE "Vendor" SET status = 'booked', "bookedRequestId" = '${r.id}' WHERE id = '${other.id}'`), /that request is for another vendor/);
    await rejects(sql(`UPDATE "Vendor" SET "contractSignedOn" = '2026-11-23', "contractRequestId" = '${r.id}' WHERE id = '${vendorId}'`), /two-key: signing a contract/); // wrong kind
  });

  it('the wedding date and the approval rules cannot change without their own approved request', async () => {
    await rejects(sql(`UPDATE "Wedding" SET date = date + 42 WHERE "orgId" = '${c.orgId}'`), /two-key: changing the date needs its own approved change_date request/);
    await rejects(sql(`UPDATE "Wedding" SET "spendThresholdCents" = 99999999 WHERE "orgId" = '${c.orgId}'`), /two-key: changing the approval rules/);
    await rejects(sql(`UPDATE "Wedding" SET "consentExpiryDays" = 365 WHERE "orgId" = '${c.orgId}'`), /two-key: changing the approval rules/);
    // Other columns are not designated.
    await expect(sql(`UPDATE "Wedding" SET title = 'Renamed' WHERE "orgId" = '${c.orgId}'`)).resolves.toBe(1);
    // A used date request cannot move the date a second time.
    const to = addDays(date, 42);
    await ok(proposeDateMove(c.slug, { to, fingerprint: await fingerprintFor(to) }));
    await as(c.b);
    await ok(approveRequest(c.slug, { id: (await pending('change_date')).id, fingerprint: await fingerprintFor(to) }));
    await rejects(sql(`UPDATE "Wedding" SET date = date + 7 WHERE "orgId" = '${c.orgId}'`), /two-key: changing the date needs its own approved change_date request/);
  });

  it('an expense over the threshold needs an approved spend request for that amount, used once; and amounts never change', async () => {
    const insert = (cents: number, req: string | null) =>
      sql(`INSERT INTO "Expense" (id, "orgId", "categoryId", description, "amountCents", "paidOn", "requestId") VALUES (gen_random_uuid(), '${c.orgId}', '${categoryId}', 'raw', ${cents}, '2026-11-23', ${req ? `'${req}'` : 'NULL'})`);
    await expect(insert(50_000, null)).resolves.toBe(1);
    await rejects(insert(50_001, null), /two-key: a spend over the threshold needs an approved spend request/);
    await ok(addExpense(c.slug, { categoryId, vendorId: '', description: 'Flowers', amount: '900', paidOn: '' }));
    const r = await pending('spend');
    await rejects(insert(90_000, r.id), /two-key: a spend over the threshold/); // still pending
    await as(c.b);
    await ok(approveRequest(c.slug, { id: r.id }));
    await rejects(insert(90_000, r.id), /already been spent/);
    await rejects(sql(`UPDATE "Expense" SET "amountCents" = 9000000 WHERE "orgId" = '${c.orgId}'`), /an expense amount cannot be edited/);
    const other = await db.consentRequest.create({ data: { orgId: c.orgId, kind: 'spend', payload: { amountCents: 60_000 }, summary: 'x', proposerId: c.a, expiresAt: new Date(now().getTime() + 86_400_000) } });
    await sql(`UPDATE "ConsentRequest" SET status = 'approved', "deciderId" = '${c.b}', "decidedAt" = now(), "executedAt" = now() WHERE id = '${other.id}'`);
    await rejects(insert(70_000, other.id), /approved a different amount/);
  });

  it('a request cannot be approved by its proposer, edited after it is proposed, or changed once decided', async () => {
    await ok(proposeBooking(c.slug, { id: vendorId }));
    const r = await pending('book_vendor');
    await rejects(sql(`UPDATE "ConsentRequest" SET status = 'approved', "deciderId" = '${c.a}', "decidedAt" = now(), "executedAt" = now() WHERE id = '${r.id}'`), /ConsentRequest_two_key_check/);
    await rejects(sql(`UPDATE "ConsentRequest" SET status = 'approved' WHERE id = '${r.id}'`), /ConsentRequest_(decided|executed)_check/);
    await rejects(sql(`UPDATE "ConsentRequest" SET payload = '{"vendorId":"00000000-0000-4000-8000-000000000001"}' WHERE id = '${r.id}'`), /what was proposed cannot be edited/);
    await rejects(sql(`UPDATE "ConsentRequest" SET kind = 'spend' WHERE id = '${r.id}'`), /what was proposed cannot be edited/);
    await as(c.b);
    await ok(declineRequest(c.slug, { id: r.id, reason: '' }));
    await rejects(sql(`UPDATE "ConsentRequest" SET status = 'approved', "deciderId" = '${c.b}', "executedAt" = now() WHERE id = '${r.id}'`), /a decided request cannot change/);
  });
});

describe('everything else is open to one partner, but audited (PRD: "everything else is open but audited")', () => {
  it('a non-designated vendor edit goes straight through and is logged', async () => {
    const o = await outcome(updateVendor(c.slug, { id: vendorId, name: 'Fennel & Fig Catering', category: 'caterer', contactName: 'Sam Example', email: 'sam@fennelfig.example', phone: '918-555-0142', notes: '', deliverables: '', arrive: '', depart: '', countEstimate: '', countDueDaysBefore: '', contractTotal: '' }));
    expect(o).toMatchObject({ nav: 'redirect' });
    expect(await db.consentRequest.count({ where: { orgId: c.orgId } })).toBe(0);
    const e = (await log(c.orgId)).filter((x) => x.action === 'knotwork.vendor.updated');
    expect(e).toHaveLength(1);
    expect(e[0]!.data).toMatchObject({ before: { email: '', phone: '' }, after: { email: 'sam@fennelfig.example', phone: '918-555-0142' } });
  });
});
