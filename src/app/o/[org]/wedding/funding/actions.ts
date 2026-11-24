'use server';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { isPartner } from '@/lib/knotwork/access';
import { loadWho, need, requireWedding, todayOf } from '@/lib/knotwork/context';
import { isRealDay } from '@/lib/knotwork/days';
import { addFunder as addFunderRow, addPledge as addPledgeRow, allocate, changePledge as changePledgeRow, linkFunder as linkFunderRow, receive, removeAllocation, removeReceipt as removeReceiptRow, unlinkFunder as unlinkFunderRow } from '@/lib/knotwork/funding/store';
import { parseCents } from '@/lib/knotwork/money';
import { canSee } from '@/lib/knotwork/secrecy/store';

// P1-2, the multi-funder family budget. Writes need `budget.edit`; linking a person to a funder (which gives them the
// `funder` grant) needs `helpers.manage`, so only the partners do it. Order as everywhere: capability, every ref
// (another workspace's row, or a category or spend hidden from the asker by P1-1, is notFound), the rules, then the
// write and its log line in one transaction.

const home = (ctx: OrgCtx) => `/o/${ctx.slug}/wedding/funding`;
const text = (label: string, max = 120) => z.string().trim().min(1, `${label} is required.`).max(max, `${label} is too long.`);
const note = (max = 500) => z.string().trim().max(max).default('');
/** Typed dollars to integer cents; the bounds are the ledger's (checked in the store, after the refs). */
const money = (label: string) =>
  z.union([z.number().int(), z.string().max(40)]).transform((v, c) => {
    const cents = typeof v === 'number' ? v : parseCents(v);
    if (cents === null || !Number.isInteger(cents) || cents < 0) c.addIssue({ code: 'custom', message: `${label}: an amount like 1,250.00.` });
    return cents ?? 0;
  });
const dayOrToday = z.union([z.literal(''), z.string().trim().max(10)]).default('');

const funderIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.funder.findFirst({ where: { id, ...inOrg(ctx) } })) ?? notFound();
async function categoryIn(tx: Tx, ctx: OrgCtx, id: string) {
  const c = (await tx.budgetCategory.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();
  if (!(await canSee(tx, ctx, 'category', id))) notFound();
  return c;
}
async function pledgeIn(tx: Tx, ctx: OrgCtx, id: string) {
  const p = (await tx.funderPledge.findFirst({ where: { id, ...inOrg(ctx) } })) ?? notFound();
  if (!(await canSee(tx, ctx, 'category', p.categoryId))) notFound();
  return p;
}

export const addFunder = orgAction(null, z.object({ name: text('Name'), note: note() }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'budget.edit');
    await addFunderRow(tx, ctx, i.name, i.note);
  });
  redirect(home(ctx));
});

export const linkFunder = orgAction(null, z.object({ funderId: ref('funder'), userId: ref('member') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'helpers.manage');
    await funderIn(tx, ctx, i.funderId);
    const m = (await tx.membership.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId: i.userId } }, select: { role: true, user: { select: { email: true } } } })) ?? notFound();
    if (isPartner(m.role)) throw new Refused('A partner already sees the whole budget.');
    await linkFunderRow(tx, ctx, i.funderId, i.userId, m.user.email);
  });
  redirect(home(ctx));
});

export const unlinkFunder = orgAction(null, z.object({ id: ref('funder') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'helpers.manage');
    await funderIn(tx, ctx, i.id);
    await unlinkFunderRow(tx, ctx, i.id);
  });
  redirect(home(ctx));
});

export const addPledge = orgAction(null, z.object({ funderId: ref('funder'), categoryId: ref('budgetCategory'), amount: money('Pledge') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'budget.edit');
    await funderIn(tx, ctx, i.funderId);
    await categoryIn(tx, ctx, i.categoryId);
    await addPledgeRow(tx, ctx, i.funderId, i.categoryId, i.amount);
  });
  redirect(home(ctx));
});

export const changePledge = orgAction(null, z.object({ id: ref('funderPledge'), amount: money('Pledge') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'budget.edit');
    await pledgeIn(tx, ctx, i.id);
    await changePledgeRow(tx, ctx, i.id, i.amount);
  });
  redirect(home(ctx));
});

export const recordReceipt = orgAction(null, z.object({ pledgeId: ref('funderPledge'), amount: money('Amount received'), receivedOn: dayOrToday, note: note(200) }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'budget.edit');
    await pledgeIn(tx, ctx, i.pledgeId);
    const today = todayOf(await requireWedding(tx, ctx));
    const on = i.receivedOn === '' ? today : i.receivedOn;
    if (!isRealDay(on)) throw new Refused('Pick a real date.');
    if (on > today) throw new Refused('Money received is a fact: pick today or a day before.');
    await receive(tx, ctx, i.pledgeId, i.amount, on, i.note);
  });
  redirect(home(ctx));
});

export const removeReceipt = orgAction(null, z.object({ id: ref('funderReceipt') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'budget.edit');
    const r = (await tx.funderReceipt.findFirst({ where: { id: i.id, ...inOrg(ctx) }, select: { pledgeId: true } })) ?? notFound();
    await pledgeIn(tx, ctx, r.pledgeId);
    await removeReceiptRow(tx, ctx, i.id);
  });
  redirect(home(ctx));
});

export const payFromPledge = orgAction(null, z.object({ pledgeId: ref('funderPledge'), expenseId: ref('expense'), amount: money('Amount') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'budget.edit');
    await pledgeIn(tx, ctx, i.pledgeId);
    if (!(await tx.expense.findFirst({ where: { id: i.expenseId, ...inOrg(ctx) }, select: { id: true } })) || !(await canSee(tx, ctx, 'expense', i.expenseId))) notFound();
    await allocate(tx, ctx, i.pledgeId, i.expenseId, i.amount);
  });
  redirect(home(ctx));
});

export const removeFromPledge = orgAction(null, z.object({ id: ref('funderAllocation') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'budget.edit');
    const a = (await tx.funderAllocation.findFirst({ where: { id: i.id, ...inOrg(ctx) }, select: { pledgeId: true, expenseId: true } })) ?? notFound();
    await pledgeIn(tx, ctx, a.pledgeId);
    if (!(await canSee(tx, ctx, 'expense', a.expenseId))) notFound();
    await removeAllocation(tx, ctx, i.id);
  });
  redirect(home(ctx));
});
