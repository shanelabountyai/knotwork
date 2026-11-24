import { beforeEach, describe, expect, it } from 'vitest';
import {
  acknowledgeFlag, addCategory, addExpense, addTask, addVendor, addVendorPayment, approveRequest, payVendorPayment, proposeBooking, proposeSettings, regenerateBrief,
  removeTask, setTaskStatus, takeBudgetSnapshot, updateCategory, updateTask, updateVendor,
} from '@/app/o/[org]/wedding/actions';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { loadBudget } from '@/lib/knotwork/budget-store';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { computeSchedule } from '@/lib/knotwork/schedule/engine';
import { loadTasks, toPlan } from '@/lib/knotwork/schedule/store';
import { flagText } from '@/lib/knotwork/vendors/store';
import { as, db, log, makeWedding, ok, refused, snapshot, type Couple } from './db';
import { readJson } from './fixtures';

// P0-7 budget + vendor book, the P0-2 re-confirmation flags through the real actions, and the P0-1 payment and RSVP tasks.
const today = () => todayIn('America/Chicago', now());
let c: Couple;
let date: string;
let vendorId: string;

const vendorForm = (over: Record<string, unknown> = {}) => ({
  id: vendorId, name: 'Fennel & Fig Catering', category: 'caterer', contactName: 'Sam Example', email: '', phone: '', notes: '',
  deliverables: 'Plated dinner, two servers', arrive: '15:00', depart: '22:00', countEstimate: '120', countDueDaysBefore: '14', contractTotal: '', ...over,
});
const book = async () => {
  await as(c.a);
  await ok(proposeBooking(c.slug, { id: vendorId }));
  await as(c.b);
  await ok(approveRequest(c.slug, { id: (await db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: 'book_vendor', status: 'pending' } })).id }));
  await as(c.a);
};
const flags = () => db.vendorFlag.findMany({ where: { orgId: c.orgId }, orderBy: { raisedAt: 'asc' } });
const schedule = async () => {
  const rows = await withOrg({ orgId: c.orgId }, (tx) => loadTasks(tx, { orgId: c.orgId }));
  return { rows, s: computeSchedule(toPlan(rows), date, today()) };
};

beforeEach(async () => {
  date = addDays(today(), 330);
  c = await makeWedding(date);
  await ok(addVendor(c.slug, { name: 'Fennel & Fig Catering', category: 'caterer', contactName: 'Sam Example', email: '', phone: '' }));
  vendorId = (await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId } })).id;
  await ok(updateVendor(c.slug, vendorForm()));
});

describe('vendor re-confirmation flags, through the actions', () => {
  type Scope = { deliverables: string; arriveMin: number | null; departMin: number | null; countEstimate: number | null };
  type Case = { name: string; status: string; before: Scope; after: Partial<Scope>; flag: string[] };
  const { cases } = readJson<{ cases: Case[] }>('fixtures/vendors/scope-changes.json');
  // The vendor form posts every field: the fixture's "before" scope, with the fields in "after" replaced.
  const toForm = (s: Scope) => ({ deliverables: s.deliverables, arrive: s.arriveMin ?? '', depart: s.departMin ?? '', countEstimate: s.countEstimate ?? '' });

  it.each(cases.filter((x) => x.status !== 'dropped').map((x) => [x.name, x] as const))('%s', async (_, fx) => {
    await db.vendor.update({ where: { id: vendorId }, data: fx.before });
    if (fx.status === 'booked') await book();
    await ok(updateVendor(c.slug, vendorForm(toForm({ ...fx.before, ...fx.after }))));
    const raised = await flags();
    if (!fx.flag.length) return expect(raised).toEqual([]);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ vendorId, reason: 'scope_changed', ackAt: null, raisedById: c.a });
    expect((raised[0]!.detail as { changes: { field: string }[] }).changes.map((x) => x.field)).toEqual(fx.flag);
  });

  it('a contact-only edit of a booked vendor raises nothing', async () => {
    await book();
    await ok(updateVendor(c.slug, vendorForm({ phone: '918-555-0142', notes: 'Prefers email', email: 'sam@fennelfig.example' })));
    expect(await flags()).toEqual([]);
  });

  it('stays open until acknowledged, then clears; acknowledging twice is refused', async () => {
    await book();
    await ok(updateVendor(c.slug, vendorForm({ countEstimate: '132' })));
    const [f] = await flags();
    expect(flagText(f!.reason, f!.detail)).toBe('Count estimate changed from 120 to 132');
    await ok(acknowledgeFlag(c.slug, { id: f!.id, note: 'Sam confirmed by phone' }));
    expect((await flags())[0]).toMatchObject({ ackById: c.a, ackNote: 'Sam confirmed by phone' });
    expect((await flags())[0]!.ackAt).not.toBeNull();
    await refused(acknowledgeFlag(c.slug, { id: f!.id, note: '' }), /already acknowledged/);
  });

  it('shows on the vendor brief while open, and the brief is regenerated only when its inputs change', async () => {
    await book();
    await ok(regenerateBrief(c.slug, { id: vendorId }));
    await ok(regenerateBrief(c.slug, { id: vendorId })); // nothing changed: no new version
    expect(await db.vendorBrief.count({ where: { vendorId } })).toBe(1);
    await ok(updateVendor(c.slug, vendorForm({ arrive: '14:30' })));
    await ok(regenerateBrief(c.slug, { id: vendorId }));
    const briefs = await db.vendorBrief.findMany({ where: { vendorId }, orderBy: { version: 'asc' } });
    expect(briefs.map((b) => b.version)).toEqual([1, 2]);
    expect(briefs[0]!.body).not.toContain('NEEDS RE-CONFIRMATION');
    expect(briefs[1]!.body).toContain('NEEDS RE-CONFIRMATION');
    expect(briefs[1]!.body).toContain('Arrival time changed from 15:00 to 14:30');
    expect(briefs[1]!.body).toContain('- Arrive: 14:30');
    expect(briefs[1]!.inputsHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('vendor payments are scheduled tasks (PRD P0-1)', () => {
  it('a payment becomes a zero-lead task due N days before the wedding, and paying it finishes the task', async () => {
    await ok(addCategory(c.slug, { name: 'Catering', estimate: '12000' }));
    const categoryId = (await db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId } })).id;
    await ok(addVendorPayment(c.slug, { vendorId, label: 'Deposit', amount: '400', dueDaysBefore: '300' }));
    const p = await db.vendorPayment.findFirstOrThrow({ where: { orgId: c.orgId }, include: { task: true } });
    expect(p.task).toMatchObject({ kind: 'payment', leadDays: 0, bufferDays: 300, vendorId, title: 'Pay Fennel & Fig Catering: Deposit' });
    expect((await schedule()).s.tasks![p.taskId]).toMatchObject({ due: addDays(date, -300), startBy: addDays(date, -300), state: 'ok' });
    await refused(setTaskStatus(c.slug, { id: p.taskId, status: 'done' }), /recording the payment/);
    await refused(removeTask(c.slug, { id: p.taskId }), /kept by the app/);
    await ok(payVendorPayment(c.slug, { id: p.id, categoryId, paidOn: '' }));
    expect((await schedule()).s.tasks![p.taskId]!.state).toBe('done');
    expect(await db.expense.findMany({ where: { orgId: c.orgId } })).toMatchObject([{ amountCents: 40_000, vendorId, categoryId, requestId: null, description: 'Fennel & Fig Catering: Deposit' }]);
  });
});

describe('the RSVP deadline derives from the earliest booked-vendor count deadline minus the chase buffer (PRD P0-1)', () => {
  const rsvp = () => db.task.findUnique({ where: { orgId_key: { orgId: c.orgId, key: 'rsvp-deadline' } } });

  it('does not exist until a vendor that asks for a count is booked', async () => {
    expect(await rsvp()).toBeNull(); // the caterer asks for a count 14 days before, but is not booked yet
    await book();
    expect(await rsvp()).toMatchObject({ kind: 'rsvp', leadDays: 0, bufferDays: 14 + 14 });
    expect((await schedule()).s.tasks![(await rsvp())!.id]!.due).toBe(addDays(date, -28));
  });

  it('moves when a booked vendor moves its count deadline, and when the chase buffer changes', async () => {
    await book();
    await ok(updateVendor(c.slug, vendorForm({ countDueDaysBefore: '21' })));
    expect((await rsvp())!.bufferDays).toBe(21 + 14);
    await ok(proposeSettings(c.slug, { spendThreshold: '500', consentExpiryDays: '7', chaseBufferDays: '10' }));
    await as(c.b);
    await ok(approveRequest(c.slug, { id: (await db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: 'change_settings' } })).id }));
    expect((await rsvp())!.bufferDays).toBe(21 + 10);
    await as(c.a);
    await ok(updateVendor(c.slug, vendorForm({ countDueDaysBefore: '' })));
    expect(await rsvp()).toBeNull(); // nobody asks for a count any more
  });

  it('cannot be retimed or removed by hand, but other tasks can depend on it', async () => {
    await book();
    const t = (await rsvp())!;
    await refused(updateTask(c.slug, { id: t.id, title: t.title, leadDays: 0, bufferDays: 99, assigneeId: '', dependsOn: [] }), /worked out from the vendors/);
    await refused(removeTask(c.slug, { id: t.id }), /kept by the app/);
    await ok(addTask(c.slug, { title: 'Give the caterer the final count', leadDays: '1', bufferDays: '14', assigneeId: c.b, dependsOn: [t.id] }));
    const { rows, s } = await schedule();
    const final = rows.find((r) => r.title === 'Give the caterer the final count')!;
    expect(final.assigneeId).toBe(c.b);
    expect(s.tasks![t.id]!.due <= s.tasks![final.id]!.startBy).toBe(true);
  });
});

describe('budget: estimates vs actuals in integer cents, with snapshots (PRD P0-7)', () => {
  it('rolls up to the hand-added fixture when the same rows are entered through the actions', async () => {
    const fx = readJson<{ categories: { id: string; name: string; estimateCents: number }[]; expenses: { categoryId: string; amountCents: number }[]; expect: { estimateCents: number; actualCents: number; remainingCents: number; lines: { name: string; actualCents: number; remainingCents: number; over: boolean }[] } }>('fixtures/budget/rollup.json');
    for (const cat of fx.categories) await ok(addCategory(c.slug, { name: cat.name, estimate: cat.estimateCents }));
    const ids = new Map((await db.budgetCategory.findMany({ where: { orgId: c.orgId } })).map((r) => [fx.categories.find((x) => x.name === r.name)!.id, r.id]));
    for (const e of fx.expenses) {
      await as(c.a);
      const to = await ok(addExpense(c.slug, { categoryId: ids.get(e.categoryId)!, vendorId: '', description: 'Fixture expense', amount: e.amountCents, paidOn: '2026-11-20' }));
      if (to.endsWith('/approvals')) {
        await as(c.b);
        await ok(approveRequest(c.slug, { id: (await db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: 'spend', status: 'pending' } })).id }));
      }
    }
    const r = await withOrg({ orgId: c.orgId }, (tx) => loadBudget(tx, { orgId: c.orgId }));
    expect({ estimateCents: r.estimateCents, actualCents: r.actualCents, remainingCents: r.remainingCents }).toEqual({ estimateCents: fx.expect.estimateCents, actualCents: fx.expect.actualCents, remainingCents: fx.expect.remainingCents });
    expect(r.lines.map(({ name, actualCents, remainingCents, over }) => ({ name, actualCents, remainingCents, over }))).toEqual(fx.expect.lines.map(({ name, actualCents, remainingCents, over }) => ({ name, actualCents, remainingCents, over })));

    await as(c.a);
    await ok(takeBudgetSnapshot(c.slug, { note: 'After the venue balance' }));
    const snap = await db.budgetSnapshot.findFirstOrThrow({ where: { orgId: c.orgId } });
    expect(snap.totals).toMatchObject({ estimateCents: 2_550_000, actualCents: 2_180_051 });
    // A snapshot is frozen: a later expense changes the live rollup, not the snapshot.
    await ok(addExpense(c.slug, { categoryId: ids.get('c-flowers')!, vendorId: '', description: 'Ribbon', amount: '12.50', paidOn: '' }));
    expect((await db.budgetSnapshot.findUniqueOrThrow({ where: { id: snap.id } })).totals).toMatchObject({ actualCents: 2_180_051 });
    expect((await withOrg({ orgId: c.orgId }, (tx) => loadBudget(tx, { orgId: c.orgId }))).actualCents).toBe(2_180_051 + 1_250);
  });

  it('refuses a bad amount, a bad date, a zero spend and a duplicate category, and writes nothing', async () => {
    await ok(addCategory(c.slug, { name: 'Flowers', estimate: '3,000' }));
    const categoryId = (await db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId } })).id;
    const before = await snapshot();
    await refused(addExpense(c.slug, { categoryId, vendorId: '', description: 'x', amount: 'twelve', paidOn: '' }), /an amount like/);
    await refused(addExpense(c.slug, { categoryId, vendorId: '', description: 'x', amount: '10.999', paidOn: '' }), /an amount like/);
    await refused(addExpense(c.slug, { categoryId, vendorId: '', description: 'x', amount: '10', paidOn: '2026-02-30' }), /real date/);
    await refused(addExpense(c.slug, { categoryId, vendorId: '', description: 'x', amount: '0', paidOn: '' }), /more than zero/);
    await refused(addCategory(c.slug, { name: 'Flowers', estimate: '1' }), /already a category/);
    expect(await snapshot()).toBe(before);
    await ok(updateCategory(c.slug, { id: categoryId, name: 'Flowers', estimate: '3,500.50' }));
    expect((await db.budgetCategory.findUniqueOrThrow({ where: { id: categoryId } })).estimateCents).toBe(350_050);
    expect((await log(c.orgId)).at(-1)!.data).toMatchObject({ before: { estimateCents: 300_000 }, after: { estimateCents: 350_050 } });
  });
});
