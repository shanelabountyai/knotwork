import { beforeEach, describe, expect, it } from 'vitest';
import * as actions from '@/app/o/[org]/wedding/actions';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { parseAction } from '@/lib/knotwork/changelog-diff';
import { ENTITIES } from '@/lib/knotwork/changelog';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { previewDateMove } from '@/lib/knotwork/schedule/store';
import { as, db, log, makeCouple, ok, type Couple } from './db';

// PRD P0-2 success metric: "change log complete against a scripted edit session". The script below calls EVERY
// exported action at least once (the test fails if an action is added and not scripted) and states, for each call,
// the log entries it must leave: who, what, and the before/after of what changed.
type Step = { action: keyof typeof actions; by: 'a' | 'b'; input: () => Record<string, unknown> | Promise<Record<string, unknown>>; expect: { action: string; before?: object | null; after?: object | null; label?: RegExp }[] };

const today = () => todayIn('America/Chicago', now());
let c: Couple;
const row = {
  task: (title: string) => db.task.findFirstOrThrow({ where: { orgId: c.orgId, title } }),
  vendor: () => db.vendor.findFirstOrThrow({ where: { orgId: c.orgId } }),
  category: () => db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId } }),
  pending: (kind: string) => db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: kind as never, status: 'pending' } }),
};
const fp = async (to: string) => (await withOrg({ orgId: c.orgId }, async (tx) => previewDateMove(tx, { orgId: c.orgId }, await db.wedding.findUniqueOrThrow({ where: { orgId: c.orgId } }), to))).preview.fingerprint;
const vendorForm = async (over: Record<string, unknown>) => ({ id: (await row.vendor()).id, name: 'Fennel & Fig Catering', category: 'caterer', contactName: 'Sam Example', email: '', phone: '', notes: '', deliverables: 'Plated dinner', arrive: '15:00', depart: '22:00', countEstimate: '120', countDueDaysBefore: '14', contractTotal: '', ...over });

beforeEach(async () => {
  c = await makeCouple();
});

describe('a scripted edit session', () => {
  it('leaves a complete change log: every action, every entity, who and before/after', async () => {
    const date = addDays(today(), 330);
    const to = addDays(date, 42);
    const script: Step[] = [
      { action: 'createWedding', by: 'a', input: () => ({ title: 'Juniper & Rowan', date, timeZone: 'America/Chicago' }), expect: [{ action: 'knotwork.wedding.created', before: null, after: { title: 'Juniper & Rowan', date } }, { action: 'knotwork.baseline.created' }] },
      { action: 'addTask', by: 'a', input: () => ({ title: 'Book the string quartet', leadDays: '14', bufferDays: '120', assigneeId: '', dependsOn: [] }), expect: [{ action: 'knotwork.task.created', before: null, after: { title: 'Book the string quartet', leadDays: 14, bufferDays: 120 } }] },
      { action: 'updateTask', by: 'b', input: async () => ({ id: (await row.task('Book the string quartet')).id, title: 'Book the string quartet', leadDays: '21', bufferDays: '120', assigneeId: c.b, dependsOn: [(await row.task('Book the venue')).id] }), expect: [{ action: 'knotwork.task.updated', before: { leadDays: 14, assigneeId: null, dependsOn: [] }, after: { leadDays: 21, assigneeId: c.b } }] },
      { action: 'setTaskStatus', by: 'b', input: async () => ({ id: (await row.task('Book the string quartet')).id, status: 'in_progress' }), expect: [{ action: 'knotwork.task.updated', before: { status: 'todo' }, after: { status: 'in_progress' } }] },
      { action: 'removeTask', by: 'a', input: async () => ({ id: (await row.task('Write vows')).id }), expect: [{ action: 'knotwork.task.deleted', before: { title: 'Write vows' }, after: null }] },
      { action: 'addCategory', by: 'a', input: () => ({ name: 'Catering', estimate: '12,000' }), expect: [{ action: 'knotwork.category.created', after: { name: 'Catering', estimateCents: 1_200_000 } }] },
      { action: 'updateCategory', by: 'b', input: async () => ({ id: (await row.category()).id, name: 'Catering', estimate: '12,500' }), expect: [{ action: 'knotwork.category.updated', before: { estimateCents: 1_200_000 }, after: { estimateCents: 1_250_000 } }] },
      { action: 'addExpense', by: 'a', input: async () => ({ categoryId: (await row.category()).id, vendorId: '', description: 'Tasting fee', amount: '150', paidOn: '' }), expect: [{ action: 'knotwork.expense.created', before: null, after: { amountCents: 15_000, category: 'Catering', twoKey: false } }] },
      { action: 'takeBudgetSnapshot', by: 'a', input: () => ({ note: 'First look' }), expect: [{ action: 'knotwork.snapshot.taken', after: { estimateCents: 1_250_000, actualCents: 15_000 } }] },
      { action: 'addVendor', by: 'a', input: () => ({ name: 'Fennel & Fig Catering', category: 'caterer', contactName: 'Sam Example', email: '', phone: '' }), expect: [{ action: 'knotwork.vendor.created', after: { name: 'Fennel & Fig Catering', status: 'considering' } }] },
      { action: 'updateVendor', by: 'a', input: () => vendorForm({}), expect: [{ action: 'knotwork.vendor.updated', before: { deliverables: '', arriveMin: null, countEstimate: null }, after: { deliverables: 'Plated dinner', arriveMin: 900, countEstimate: 120 } }] },
      { action: 'proposeBooking', by: 'a', input: async () => ({ id: (await row.vendor()).id }), expect: [{ action: 'knotwork.request.proposed', after: { kind: 'book_vendor', status: 'pending' }, label: /^Book Fennel & Fig Catering/ }] },
      { action: 'approveRequest', by: 'b', input: async () => ({ id: (await row.pending('book_vendor')).id }), expect: [{ action: 'knotwork.request.approved', before: { status: 'pending' }, after: { status: 'approved' } }, { action: 'knotwork.vendor.updated', before: { status: 'considering' }, after: { status: 'booked' } }, { action: 'knotwork.task.created', after: { kind: 'rsvp', bufferDays: 28 } }] },
      { action: 'proposeContract', by: 'b', input: async () => ({ id: (await row.vendor()).id, total: '8,400' }), expect: [{ action: 'knotwork.request.proposed', after: { kind: 'sign_contract' } }] },
      { action: 'declineRequest', by: 'a', input: async () => ({ id: (await row.pending('sign_contract')).id, reason: 'The quote is missing the servers' }), expect: [{ action: 'knotwork.request.declined', before: { status: 'pending' }, after: { status: 'declined', reason: 'The quote is missing the servers' } }] },
      { action: 'proposeSettings', by: 'a', input: () => ({ spendThreshold: '750', consentExpiryDays: '10', chaseBufferDays: '14' }), expect: [{ action: 'knotwork.request.proposed', after: { kind: 'change_settings' } }] },
      { action: 'withdrawRequest', by: 'a', input: async () => ({ id: (await row.pending('change_settings')).id }), expect: [{ action: 'knotwork.request.withdrawn', before: { status: 'pending' }, after: { status: 'withdrawn' } }] },
      { action: 'addVendorPayment', by: 'a', input: async () => ({ vendorId: (await row.vendor()).id, label: 'Deposit', amount: '400', dueDaysBefore: '300' }), expect: [{ action: 'knotwork.payment.created', after: { amountCents: 40_000, dueDaysBefore: 300 } }, { action: 'knotwork.task.created', after: { kind: 'payment', bufferDays: 300 } }] },
      { action: 'payVendorPayment', by: 'b', input: async () => ({ id: (await db.vendorPayment.findFirstOrThrow({ where: { orgId: c.orgId } })).id, categoryId: (await row.category()).id, paidOn: '' }), expect: [{ action: 'knotwork.expense.created', after: { amountCents: 40_000 } }, { action: 'knotwork.payment.paid', before: { paidOn: null }, after: { amountCents: 40_000 } }] },
      { action: 'proposeDateMove', by: 'a', input: async () => ({ to, fingerprint: await fp(to) }), expect: [{ action: 'knotwork.request.proposed', after: { kind: 'change_date' } }] },
      { action: 'approveRequest', by: 'b', input: async () => ({ id: (await row.pending('change_date')).id, fingerprint: await fp(to) }), expect: [{ action: 'knotwork.request.approved' }, { action: 'knotwork.wedding.moved', before: { date }, after: { date: to } }, { action: 'knotwork.baseline.created', after: { from: date, to } }, { action: 'knotwork.flag.raised', after: { reason: 'date_moved', from: date, to } }] },
      { action: 'acknowledgeFlag', by: 'a', input: async () => ({ id: (await db.vendorFlag.findFirstOrThrow({ where: { orgId: c.orgId } })).id, note: 'Sam confirmed the new date' }), expect: [{ action: 'knotwork.flag.acknowledged', before: { acknowledged: false }, after: { acknowledged: true, note: 'Sam confirmed the new date' } }] },
      { action: 'updateVendor', by: 'b', input: () => vendorForm({ countEstimate: '132' }), expect: [{ action: 'knotwork.vendor.updated', before: { countEstimate: 120 }, after: { countEstimate: 132 } }, { action: 'knotwork.flag.raised', after: { reason: 'scope_changed', fields: ['countEstimate'] } }] },
      { action: 'regenerateBrief', by: 'a', input: async () => ({ id: (await row.vendor()).id }), expect: [{ action: 'knotwork.brief.generated', after: { version: 1 } }] },
      { action: 'grantHelper', by: 'a', input: () => ({ userId: c.helper, scope: 'budget_view' }), expect: [{ action: 'knotwork.grant.granted', after: { userId: c.helper, scope: 'budget_view' }, label: /maple@example\.test: See the budget/ }] },
      { action: 'revokeHelper', by: 'b', input: async () => ({ id: (await db.helperGrant.findFirstOrThrow({ where: { orgId: c.orgId } })).id }), expect: [{ action: 'knotwork.grant.revoked', before: { userId: c.helper, scope: 'budget_view' }, after: null }] },
    ];

    // The script covers every exported action.
    expect([...new Set(script.map((s) => s.action))].sort()).toEqual(Object.keys(actions).sort());

    let seen = 0;
    for (const [n, step] of script.entries()) {
      const who = step.by === 'a' ? c.a : c.b;
      await as(who);
      await ok((actions[step.action] as (slug: string, input: unknown) => Promise<unknown>)(c.slug, await step.input()));
      const all = await log(c.orgId);
      const fresh = all.slice(seen);
      seen = all.length;
      const at = `step ${n + 1} ${step.action}`;
      expect(fresh.map((e) => e.action), at).toEqual(step.expect.map((e) => e.action)); // exactly these entries, in order: nothing unlogged, nothing extra
      fresh.forEach((e, i) => {
        const want = step.expect[i]!;
        expect(e.actorUserId, at).toBe(who); // who
        expect(e.targetType, at).toBe(parseAction(e.action)!.entity); // what
        expect(e.targetId, at).toMatch(/^[0-9a-f-]{36}$/);
        const data = e.data as { label: string; before: object | null; after: object | null };
        expect(typeof data.label === 'string' && data.label.length > 0, at).toBe(true);
        if (want.label) expect(data.label, at).toMatch(want.label);
        if (want.before === null) expect(data.before, at).toBeNull();
        else if (want.before) expect(data.before, at).toMatchObject(want.before);
        if (want.after === null) expect(data.after, at).toBeNull();
        else if (want.after) expect(data.after, at).toMatchObject(want.after);
      });
    }

    const all = await log(c.orgId);
    // Every entity type the log knows was touched by the session, and every entry has a time.
    expect([...new Set(all.map((e) => parseAction(e.action)!.entity))].sort()).toEqual([...ENTITIES].sort());
    expect(all.every((e) => e.at instanceof Date)).toBe(true);
    // An update logs only what changed: the vendor's name was posted every time and never appears as a change.
    for (const e of all.filter((x) => x.action === 'knotwork.vendor.updated')) expect(Object.keys((e.data as { after: object }).after)).not.toContain('name');
    // Nothing token-shaped went into the log (the data export scans for 64-hex strings, INV-34).
    expect(JSON.stringify(all.map((e) => e.data))).not.toMatch(/\b[0-9a-f]{64}\b/);
  });

  it('an edit that changes nothing writes no entry', async () => {
    await as(c.a);
    await ok(actions.createWedding(c.slug, { title: 'Juniper & Rowan', date: addDays(today(), 330), timeZone: '' }));
    await ok(actions.addCategory(c.slug, { name: 'Flowers', estimate: '3000' }));
    const before = (await log(c.orgId)).length;
    await ok(actions.updateCategory(c.slug, { id: (await row.category()).id, name: 'Flowers', estimate: '3,000.00' }));
    expect((await log(c.orgId)).length).toBe(before);
  });

  it('the log cannot be edited or deleted (the template\'s append-only trigger, INV-19)', async () => {
    await as(c.a);
    await ok(actions.createWedding(c.slug, { title: 'Juniper & Rowan', date: addDays(today(), 330), timeZone: '' }));
    await expect(db.$executeRawUnsafe(`UPDATE "AuditEvent" SET action = 'x' WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow();
    await expect(db.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow();
  });
});
