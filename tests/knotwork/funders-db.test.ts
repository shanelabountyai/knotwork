import { beforeEach, describe, expect, it } from 'vitest';
import { addCategory, addExpense, grantHelper, revokeHelper } from '@/app/o/[org]/wedding/actions';
import * as funding from '@/app/o/[org]/wedding/funding/actions';
import { onMembershipEnded } from '@/app/org-hooks';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { parseAction } from '@/lib/knotwork/changelog-diff';
import { as, db, log, makeWedding, ok, refused, snapshot, type Couple } from './db';
import { NOT_FOUND, PAGES, render } from './render';

// P1-2, the multi-funder family budget, in the database: every funding action leaves its log entries; the pledge
// arithmetic is enforced by the store and again by the database at commit; and contributor-scoped visibility: a helper
// linked to a funder sees that funder's part and nothing else of the budget.
let c: Couple;
const today = () => todayIn('America/Chicago', now());
const page = async (name: string) => render(await PAGES[`src/app/o/[org]/wedding/${name}/page.tsx`]!(), { org: c.slug });
const ids = async () => ({
  venue: (await db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Venue' } })).id,
  flowers: (await db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Flowers' } })).id,
  deposit: (await db.expense.findFirstOrThrow({ where: { orgId: c.orgId, description: 'Venue deposit' } })).id,
  peonies: (await db.expense.findFirstOrThrow({ where: { orgId: c.orgId, description: 'Peonies' } })).id,
});
const funder = (name: string) => db.funder.findFirstOrThrow({ where: { orgId: c.orgId, name } });
const pledge = async (name: string, categoryId: string) => db.funderPledge.findFirstOrThrow({ where: { funderId: (await funder(name)).id, categoryId } });

beforeEach(async () => {
  c = await makeWedding(addDays(today(), 300));
  await as(c.a);
  await ok(addCategory(c.slug, { name: 'Venue', estimate: '12,000' }));
  await ok(addCategory(c.slug, { name: 'Flowers', estimate: '2,000' }));
  await ok(addExpense(c.slug, { categoryId: (await db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Venue' } })).id, vendorId: '', description: 'Venue deposit', amount: '400', paidOn: '' }));
  await ok(addExpense(c.slug, { categoryId: (await db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Flowers' } })).id, vendorId: '', description: 'Peonies', amount: '300', paidOn: '' }));
});

describe('a scripted funding session', () => {
  it('every funding action, who did it, and the before and after of what changed', async () => {
    const x = await ids();
    type Step = { action: keyof typeof funding; by: 'a' | 'b'; input: () => Promise<Record<string, unknown>> | Record<string, unknown>; expect: { action: string; before?: object | null; after?: object | null; label?: RegExp }[] };
    const script: Step[] = [
      { action: 'addFunder', by: 'a', input: () => ({ name: 'Hazel & Oren Vale', note: 'Juniper\'s parents' }), expect: [{ action: 'knotwork.funder.created', before: null, after: { name: 'Hazel & Oren Vale' } }] },
      { action: 'addPledge', by: 'a', input: async () => ({ funderId: (await funder('Hazel & Oren Vale')).id, categoryId: x.venue, amount: '5,000' }), expect: [{ action: 'knotwork.pledge.created', after: { amountCents: 500_000 }, label: /^Hazel & Oren Vale: Venue$/ }] },
      { action: 'changePledge', by: 'b', input: async () => ({ id: (await pledge('Hazel & Oren Vale', x.venue)).id, amount: '6,000' }), expect: [{ action: 'knotwork.pledge.updated', before: { amountCents: 500_000 }, after: { amountCents: 600_000 } }] },
      { action: 'recordReceipt', by: 'a', input: async () => ({ pledgeId: (await pledge('Hazel & Oren Vale', x.venue)).id, amount: '1,000', receivedOn: today(), note: 'first cheque' }), expect: [{ action: 'knotwork.receipt.created', after: { amountCents: 100_000, receivedOn: today(), note: 'first cheque' } }] },
      { action: 'payFromPledge', by: 'b', input: async () => ({ pledgeId: (await pledge('Hazel & Oren Vale', x.venue)).id, expenseId: x.deposit, amount: '400' }), expect: [{ action: 'knotwork.allocation.created', after: { amountCents: 40_000 }, label: /Venue deposit/ }] },
      { action: 'removeFromPledge', by: 'a', input: async () => ({ id: (await db.funderAllocation.findFirstOrThrow({ where: { orgId: c.orgId } })).id }), expect: [{ action: 'knotwork.allocation.deleted', before: { amountCents: 40_000 }, after: null }] },
      { action: 'removeReceipt', by: 'b', input: async () => ({ id: (await db.funderReceipt.findFirstOrThrow({ where: { orgId: c.orgId } })).id }), expect: [{ action: 'knotwork.receipt.deleted', before: { amountCents: 100_000 }, after: null }] },
      { action: 'linkFunder', by: 'a', input: async () => ({ funderId: (await funder('Hazel & Oren Vale')).id, userId: c.helper }), expect: [{ action: 'knotwork.funder.linked', before: { userId: null }, after: { userId: c.helper } }, { action: 'knotwork.grant.granted', after: { userId: c.helper, scope: 'funder' } }] },
      { action: 'unlinkFunder', by: 'b', input: async () => ({ id: (await funder('Hazel & Oren Vale')).id }), expect: [{ action: 'knotwork.funder.unlinked', before: { userId: c.helper }, after: { userId: null } }, { action: 'knotwork.grant.revoked', before: { scope: 'funder' }, after: null }] },
    ];
    expect([...new Set(script.map((s) => s.action))].sort()).toEqual(Object.keys(funding).sort());
    let seen = (await log(c.orgId)).length;
    for (const [n, step] of script.entries()) {
      const who = step.by === 'a' ? c.a : c.b;
      await as(who);
      await ok((funding[step.action] as (slug: string, input: unknown) => Promise<unknown>)(c.slug, await step.input()));
      const all = await log(c.orgId);
      const fresh = all.slice(seen);
      seen = all.length;
      const at = `step ${n + 1} ${step.action}`;
      expect(fresh.map((e) => e.action), at).toEqual(step.expect.map((e) => e.action));
      fresh.forEach((e, i) => {
        const want = step.expect[i]!;
        expect(e.actorUserId, at).toBe(who);
        expect(e.targetType, at).toBe(parseAction(e.action)!.entity);
        const data = e.data as { label: string; before: object | null; after: object | null };
        if (want.label) expect(data.label, at).toMatch(want.label);
        if (want.before === null) expect(data.before, at).toBeNull();
        else if (want.before) expect(data.before, at).toMatchObject(want.before);
        if (want.after === null) expect(data.after, at).toBeNull();
        else if (want.after) expect(data.after, at).toMatchObject(want.after);
      });
    }
    for (const entity of ['funder', 'pledge', 'receipt', 'allocation']) expect((await log(c.orgId)).some((e) => parseAction(e.action)!.entity === entity), entity).toBe(true);
  });
});

describe('the pledge arithmetic, in the store and in the database', () => {
  it('pledged → received (in parts, on a day of fact) → spent from that category\'s spends; every bound refused with a sentence', async () => {
    const x = await ids();
    await ok(funding.addFunder(c.slug, { name: 'Aunt Wren', note: '' }));
    const wren = (await funder('Aunt Wren')).id;
    await refused(funding.addPledge(c.slug, { funderId: wren, categoryId: x.venue, amount: '0.99' }), /\$1\.00 to \$1,000,000\.00/);
    await refused(funding.addPledge(c.slug, { funderId: wren, categoryId: x.venue, amount: '1,000,000.01' }), /\$1\.00 to \$1,000,000\.00/);
    await ok(funding.addPledge(c.slug, { funderId: wren, categoryId: x.venue, amount: '500' }));
    await refused(funding.addPledge(c.slug, { funderId: wren, categoryId: x.venue, amount: '10' }), /already there/);
    const p = (await pledge('Aunt Wren', x.venue)).id;
    await refused(funding.recordReceipt(c.slug, { pledgeId: p, amount: '500.01', receivedOn: '', note: '' }), /more than is left of the pledge/);
    await refused(funding.recordReceipt(c.slug, { pledgeId: p, amount: '10', receivedOn: addDays(today(), 1), note: '' }), /a fact/);
    await refused(funding.recordReceipt(c.slug, { pledgeId: p, amount: '10', receivedOn: '2026-02-30', note: '' }), /real date/);
    await ok(funding.recordReceipt(c.slug, { pledgeId: p, amount: '200', receivedOn: addDays(today(), -3), note: '' }));
    await ok(funding.recordReceipt(c.slug, { pledgeId: p, amount: '100', receivedOn: '', note: '' }));
    await refused(funding.payFromPledge(c.slug, { pledgeId: p, expenseId: x.peonies, amount: '10' }), /its own budget category/);
    await refused(funding.payFromPledge(c.slug, { pledgeId: p, expenseId: x.deposit, amount: '300.01' }), /received and not yet spent/);
    await ok(funding.payFromPledge(c.slug, { pledgeId: p, expenseId: x.deposit, amount: '300' }));
    await refused(funding.payFromPledge(c.slug, { pledgeId: p, expenseId: x.deposit, amount: '1' }), /already there/);
    await refused(funding.changePledge(c.slug, { id: p, amount: '299.99' }), /less than what has already been received/);
    const receipt = (await db.funderReceipt.findFirstOrThrow({ where: { pledgeId: p, amountCents: 10_000 } })).id;
    await refused(funding.removeReceipt(c.slug, { id: receipt }), /already been spent/);
    // A second funder cannot pay more of the deposit than is left of it ($400 − $300).
    await ok(funding.addFunder(c.slug, { name: 'Uncle Bram', note: '' }));
    await ok(funding.addPledge(c.slug, { funderId: (await funder('Uncle Bram')).id, categoryId: x.venue, amount: '1,000' }));
    const bram = (await pledge('Uncle Bram', x.venue)).id;
    await ok(funding.recordReceipt(c.slug, { pledgeId: bram, amount: '1,000', receivedOn: '', note: '' }));
    await refused(funding.payFromPledge(c.slug, { pledgeId: bram, expenseId: x.deposit, amount: '100.01' }), /more than is left of the spend/);
    await ok(funding.payFromPledge(c.slug, { pledgeId: bram, expenseId: x.deposit, amount: '100' }));
    // The budget page shows each category's funding mix.
    const budget = await page('budget');
    expect(budget).toContain('Aunt Wren: $500.00 pledged, $300.00 received, $300.00 spent; Uncle Bram: $1,000.00 pledged, $1,000.00 received, $100.00 spent');
  });

  it('the database checks the sums at commit, whatever the code does', async () => {
    const x = await ids();
    const f = await db.funder.create({ data: { orgId: c.orgId, name: 'Direct' } });
    const p = await db.funderPledge.create({ data: { orgId: c.orgId, funderId: f.id, categoryId: x.venue, amountCents: 10_000 } });
    await expect(db.funderReceipt.create({ data: { orgId: c.orgId, pledgeId: p.id, amountCents: 10_001, receivedOn: new Date() } })).rejects.toThrow(/more received than pledged/);
    await db.funderReceipt.create({ data: { orgId: c.orgId, pledgeId: p.id, amountCents: 5_000, receivedOn: new Date() } });
    await expect(db.funderAllocation.create({ data: { orgId: c.orgId, pledgeId: p.id, expenseId: x.deposit, amountCents: 5_001 } })).rejects.toThrow(/more spent than received/);
    await expect(db.funderAllocation.create({ data: { orgId: c.orgId, pledgeId: p.id, expenseId: x.peonies, amountCents: 100 } })).rejects.toThrow(/its own category/);
    await expect(db.funderPledge.update({ where: { id: p.id }, data: { amountCents: 4_999 } })).rejects.toThrow(/more received than pledged/);
    await expect(db.funderPledge.update({ where: { id: p.id }, data: { amountCents: 0 } })).rejects.toThrow(/FunderPledge_amount_check/);
    const a = await db.funderAllocation.create({ data: { orgId: c.orgId, pledgeId: p.id, expenseId: x.deposit, amountCents: 5_000 } });
    expect(a.amountCents).toBe(5_000);
    await expect(db.funderReceipt.deleteMany({ where: { pledgeId: p.id } })).rejects.toThrow(/more spent than received/);
  });
});

describe('contributor-scoped visibility (the funder grant)', () => {
  beforeEach(async () => {
    const x = await ids();
    await ok(funding.addFunder(c.slug, { name: 'Hazel Vale', note: '' }));
    await ok(funding.addFunder(c.slug, { name: 'Aunt Wren', note: '' }));
    await ok(funding.addPledge(c.slug, { funderId: (await funder('Hazel Vale')).id, categoryId: x.venue, amount: '3,000' }));
    await ok(funding.addPledge(c.slug, { funderId: (await funder('Aunt Wren')).id, categoryId: x.flowers, amount: '700' }));
    const p = (await pledge('Hazel Vale', x.venue)).id;
    await ok(funding.recordReceipt(c.slug, { pledgeId: p, amount: '1,000', receivedOn: '', note: '' }));
    await ok(funding.payFromPledge(c.slug, { pledgeId: p, expenseId: x.deposit, amount: '250' }));
  });

  it('a linked helper sees their categories by name, their pledge, received and spent; no other funder, category or spend; no budget page; no budget entry in the feed', async () => {
    await ok(funding.linkFunder(c.slug, { funderId: (await funder('Hazel Vale')).id, userId: c.helper }));
    await as(c.helper);
    const f = await page('funding');
    expect(f).toContain('What you are giving toward');
    expect(f).toContain('Pledged $3,000.00 · received $1,000.00 · spent $250.00');
    expect(f).toContain('Venue');
    expect(f).toContain('$250.00 of Venue deposit');
    for (const s of ['Aunt Wren', 'Flowers', 'Peonies', '$700.00', '$12,000.00', '$400.00', 'Add a funder', 'Add pledge', 'Link']) expect(f, s).not.toContain(s);
    expect(await page('budget')).toBe(NOT_FOUND);
    expect(await page('vendors')).toBe(NOT_FOUND);
    const feed = await page('activity');
    for (const s of ['Venue', 'Flowers', 'Peonies', 'Hazel', 'Aunt Wren', '$']) expect(feed, s).not.toContain(s);
    // Every write is refused: the grant reads, it does not edit.
    const before = await snapshot();
    await refused(funding.addFunder(c.slug, { name: 'x', note: '' }), /do not have access/);
    await refused(funding.recordReceipt(c.slug, { pledgeId: (await pledge('Hazel Vale', (await ids()).venue)).id, amount: '1', receivedOn: '', note: '' }), /do not have access/);
    await refused(addExpense(c.slug, { categoryId: (await ids()).venue, vendorId: '', description: 'x', amount: '1', paidOn: '' }), /do not have access/);
    expect(await snapshot()).toBe(before);
  });

  it('a helper with no grant has no funding page; the grant is given only by linking, and goes with the link', async () => {
    await as(c.helper);
    expect(await page('funding')).toBe(NOT_FOUND);
    await as(c.a);
    await refused(grantHelper(c.slug, { userId: c.helper, scope: 'funder' }), /Link them to a funder on the Funding page/);
    await refused(funding.linkFunder(c.slug, { funderId: (await funder('Hazel Vale')).id, userId: c.b }), /partner already sees the whole budget/);
    await ok(funding.linkFunder(c.slug, { funderId: (await funder('Hazel Vale')).id, userId: c.helper }));
    await refused(funding.linkFunder(c.slug, { funderId: (await funder('Aunt Wren')).id, userId: c.helper }), /already linked to another funder/);
    // Revoking the grant on the Helpers page ends the link too.
    await ok(revokeHelper(c.slug, { id: (await db.helperGrant.findFirstOrThrow({ where: { orgId: c.orgId, scope: 'funder' } })).id }));
    expect((await funder('Hazel Vale')).userId).toBeNull();
    await as(c.helper);
    expect(await page('funding')).toBe(NOT_FOUND);
  });

  it('when the membership ends, the grant and the link go with it', async () => {
    await ok(funding.linkFunder(c.slug, { funderId: (await funder('Hazel Vale')).id, userId: c.helper }));
    await withOrg({ orgId: c.orgId }, (tx) => onMembershipEnded(tx, c.orgId, c.helper));
    expect((await funder('Hazel Vale')).userId).toBeNull();
    expect(await db.helperGrant.count({ where: { orgId: c.orgId, userId: c.helper } })).toBe(0);
  });

  it('a helper who can see the budget sees every funder, as a partner does', async () => {
    await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope: 'budget_view' } });
    await as(c.helper);
    const f = await page('funding');
    expect(f).toContain('Hazel Vale');
    expect(f).toContain('Aunt Wren');
    expect(f).not.toContain('Add a funder'); // view, not edit
  });
});
