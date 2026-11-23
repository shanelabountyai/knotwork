import { beforeEach, describe, expect, it } from 'vitest';
import {
  addCategory, addTask, addVendor, grantHelper, proposeBooking, proposeDateMove, proposeSettings, revokeHelper, setTaskStatus, takeBudgetSnapshot, updateTask,
} from '@/app/o/[org]/wedding/actions';
import { onMembershipEnded } from '@/app/org-hooks';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { as, db, makeWedding, ok, refused, snapshot, type Couple } from './db';

// PRD P0-2: "Helper permissions are scoped grants (guest-list-only, budget-view-only)". Enforced in every action,
// not in the page: a helper posting straight to an action gets the same answer.
let c: Couple;
const NO = /do not have access/;

beforeEach(async () => {
  c = await makeWedding(addDays(todayIn('America/Chicago', now()), 330));
});

describe('a helper with no grant', () => {
  it('cannot edit the schedule, the budget or vendors, and cannot propose anything designated: nothing changes', async () => {
    const vendor = await db.vendor.create({ data: { orgId: c.orgId, name: 'Example', category: 'dj' } });
    await as(c.helper);
    const before = await snapshot();
    await refused(addTask(c.slug, { title: 'x', leadDays: 1, bufferDays: 1, assigneeId: '', dependsOn: [] }), NO);
    await refused(addCategory(c.slug, { name: 'x', estimate: 1 }), NO);
    await refused(takeBudgetSnapshot(c.slug, { note: '' }), NO);
    await refused(addVendor(c.slug, { name: 'x', category: 'dj', contactName: '', email: '', phone: '' }), NO);
    await refused(proposeBooking(c.slug, { id: vendor.id }), NO);
    await refused(proposeSettings(c.slug, { spendThreshold: 1, consentExpiryDays: 1, chaseBufferDays: 1 }), NO);
    await refused(proposeDateMove(c.slug, { to: '2030-01-01', fingerprint: 'x' }), NO);
    await refused(grantHelper(c.slug, { userId: c.helper, scope: 'budget_edit' }), NO); // cannot grant themselves anything
    expect(await snapshot()).toBe(before);
  });

  it('can move along a task assigned to them, and only that one', async () => {
    const [mine, other] = await db.task.findMany({ where: { orgId: c.orgId }, orderBy: { createdAt: 'asc' }, take: 2 });
    await db.task.update({ where: { id: mine!.id }, data: { assigneeId: c.helper } });
    await as(c.helper);
    await ok(setTaskStatus(c.slug, { id: mine!.id, status: 'done' }));
    expect(await db.task.findUniqueOrThrow({ where: { id: mine!.id } })).toMatchObject({ status: 'done' });
    await refused(setTaskStatus(c.slug, { id: other!.id, status: 'done' }), NO);
  });
});

describe('scoped grants', () => {
  it('budget-view-only does not allow a budget edit; budget-edit does; neither reaches vendors', async () => {
    await as(c.a);
    await ok(grantHelper(c.slug, { userId: c.helper, scope: 'budget_view' }));
    await as(c.helper);
    await refused(addCategory(c.slug, { name: 'Flowers', estimate: '100' }), NO);
    await as(c.b);
    await ok(grantHelper(c.slug, { userId: c.helper, scope: 'budget_edit' }));
    await as(c.helper);
    await ok(addCategory(c.slug, { name: 'Flowers', estimate: '100' }));
    await refused(addVendor(c.slug, { name: 'x', category: 'dj', contactName: '', email: '', phone: '' }), NO);
  });

  it('schedule-edit allows task edits, never a date move', async () => {
    await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope: 'schedule_edit' } });
    const t = await db.task.findFirstOrThrow({ where: { orgId: c.orgId, key: 'order-cake' } });
    await as(c.helper);
    await ok(updateTask(c.slug, { id: t.id, title: t.title, leadDays: 21, bufferDays: t.bufferDays, assigneeId: c.helper, dependsOn: [] }));
    await refused(proposeDateMove(c.slug, { to: '2030-01-01', fingerprint: 'x' }), NO);
  });

  it('a partner is refused a grant (they already have everything), a duplicate is refused, and a revoke takes effect at once', async () => {
    await as(c.a);
    await refused(grantHelper(c.slug, { userId: c.b, scope: 'budget_view' }), /already has full access/);
    await ok(grantHelper(c.slug, { userId: c.helper, scope: 'vendors_edit' }));
    await refused(grantHelper(c.slug, { userId: c.helper, scope: 'vendors_edit' }), /already have that/);
    await as(c.helper);
    await ok(addVendor(c.slug, { name: 'Tin Roof Strings', category: 'dj', contactName: '', email: '', phone: '' }));
    await as(c.a);
    await ok(revokeHelper(c.slug, { id: (await db.helperGrant.findFirstOrThrow({ where: { orgId: c.orgId } })).id }));
    await as(c.helper);
    await refused(addVendor(c.slug, { name: 'Another', category: 'dj', contactName: '', email: '', phone: '' }), NO);
  });

  it('when a membership ends, the grants go and the tasks become unassigned (org-hooks)', async () => {
    await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope: 'budget_view' } });
    const t = await db.task.findFirstOrThrow({ where: { orgId: c.orgId } });
    await db.task.update({ where: { id: t.id }, data: { assigneeId: c.helper } });
    await withOrg({ orgId: c.orgId }, (tx) => onMembershipEnded(tx, c.orgId, c.helper));
    expect(await db.helperGrant.count({ where: { orgId: c.orgId } })).toBe(0);
    expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).assigneeId).toBeNull();
  });
});
