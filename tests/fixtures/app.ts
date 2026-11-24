import { now } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system';

// CLONE-OWNED. The INV-01..04 harness seeds these rows in both fixture orgs, so it can drive
// actions whose inputs use ref('<model>') for the clone's own tables. Return { model: id } for
// one row of each model, owned by `org.orgId`. INV-29 (RLS enforce) calls it too, so every org-owned clone table has rows to scope.
// Knotwork: one row in each of the thirteen Phase 1 tables and the seven Phase 2 tables. Fixed ids: the harness re-seeds before every call, and a
// ref minted once must still resolve. The wedding is far in the future so nothing in the harness plan is late.
const id = (key: 'a' | 'b', n: number) => `00000000-0000-4000-8000-${String((key === 'a' ? 7000 : 7500) + n).padStart(12, '0')}`;

export async function seedApp(org: { orgId: string; userId: string }, key: 'a' | 'b'): Promise<Record<string, string>> {
  const orgId = org.orgId;
  const wedding = await db.wedding.create({ data: { id: id(key, 1), orgId, title: `harness wedding ${key}`, date: new Date('2031-06-14T00:00:00Z'), createdById: org.userId } });
  const task = await db.task.create({ data: { id: id(key, 2), orgId, title: `harness task ${key}`, leadDays: 10, bufferDays: 30 } });
  const second = await db.task.create({ data: { id: id(key, 3), orgId, title: `harness second task ${key}`, leadDays: 5, bufferDays: 0 } });
  const dependency = await db.taskDependency.create({ data: { id: id(key, 4), orgId, taskId: second.id, dependsOnId: task.id } });
  const baseline = await db.scheduleBaseline.create({ data: { id: id(key, 5), orgId, kind: 'initial', toDate: wedding.date, snapshot: {}, fingerprint: 'initial' } });
  const category = await db.budgetCategory.create({ data: { id: id(key, 6), orgId, name: `harness category ${key}`, estimateCents: 100_000 } });
  const expense = await db.expense.create({ data: { id: id(key, 7), orgId, categoryId: category.id, description: 'harness expense', amountCents: 100, paidOn: new Date('2026-11-01T00:00:00Z') } });
  const snapshot = await db.budgetSnapshot.create({ data: { id: id(key, 8), orgId, totals: {} } });
  const vendor = await db.vendor.create({ data: { id: id(key, 9), orgId, name: `harness vendor ${key}`, category: 'caterer', deliverables: 'harness', countEstimate: 10 } });
  const payTask = await db.task.create({ data: { id: id(key, 10), orgId, title: 'harness payment task', kind: 'payment', leadDays: 0, bufferDays: 30, vendorId: vendor.id } });
  const payment = await db.vendorPayment.create({ data: { id: id(key, 11), orgId, vendorId: vendor.id, label: 'Deposit', amountCents: 100, dueDaysBefore: 30, taskId: payTask.id } });
  const flag = await db.vendorFlag.create({ data: { id: id(key, 12), orgId, vendorId: vendor.id, reason: 'scope_changed', detail: { changes: [] } } });
  const brief = await db.vendorBrief.create({ data: { id: id(key, 13), orgId, vendorId: vendor.id, version: 1, body: 'harness brief', inputsHash: '0000000000000000' } });
  // A pending request from someone other than the harness actor, so the actor holds the second key.
  const request = await db.consentRequest.create({
    data: { id: id(key, 14), orgId, kind: 'book_vendor', payload: { vendorId: vendor.id }, summary: `Book harness vendor ${key}`, proposerId: id(key, 99), proposedAt: now(), expiresAt: new Date(now().getTime() + 86_400_000) },
  });
  const grant = await db.helperGrant.create({ data: { id: id(key, 15), orgId, userId: org.userId, scope: 'budget_view' } });
  // Phase 2: one row in each of the seven guest tables. The household is queued (never invited), so the harness can
  // drive every guest action without a cap or an RSVP link in the way.
  const guestPlan = await db.guestPlan.create({ data: { id: id(key, 16), orgId, cap: 50, mealOptions: ['Chicken'] } });
  const wave = await db.inviteWave.create({ data: { id: id(key, 17), orgId, number: 1, list: 'A', householdCount: 0, seatCount: 0 } });
  const household = await db.household.create({ data: { id: id(key, 18), orgId, name: `harness household ${key}`, email: `household-${key}@example.test` } });
  const guest = await db.guest.create({ data: { id: id(key, 19), orgId, householdId: household.id, name: `harness guest ${key}`, dietary: [], accessibility: [] } });
  const delta = await db.headcountDelta.create({ data: { id: id(key, 20), orgId, label: 'harness', deltaSeats: 0, deltaCents: 0, attendingAfter: 0, costAfterCents: 0 } });
  const chase = await db.chaseEvent.create({ data: { id: id(key, 21), orgId, householdId: household.id, kind: 'reminder', step: 21 } });
  const song = await db.doNotPlay.create({ data: { id: id(key, 22), orgId, title: `harness song ${key}` } });
  return {
    wedding: wedding.id, task: task.id, taskDependency: dependency.id, scheduleBaseline: baseline.id, budgetCategory: category.id, expense: expense.id, budgetSnapshot: snapshot.id,
    vendor: vendor.id, vendorPayment: payment.id, vendorFlag: flag.id, vendorBrief: brief.id, consentRequest: request.id, helperGrant: grant.id,
    guestPlan: guestPlan.id, inviteWave: wave.id, household: household.id, guest: guest.id, headcountDelta: delta.id, chaseEvent: chase.id, doNotPlay: song.id,
  };
}

// CLONE-OWNED. The clone's models with no orgId column, i.e. outside tenancy and RLS on purpose (INV-42, v1.7.0). Name
// each one with a comment saying why; a model without orgId that is not here (or in core's list) fails INV-42.
export const GLOBAL_MODELS: readonly string[] = [];
