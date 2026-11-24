// Group gifting in the database (PRD P0-5): registry items, the append-only ledger, thank-you obligations.
// Every write takes the wedding lock first, then RE-READS the pot: two households completing a pot at once are
// served one after the other, the second against the true remainder (docs/knotwork/PHASE-3-PLAN.md, "The race").
//
// PRIVACY: this file is the engine, and it does read what a household has in a pot (it has to, to refund it). Nothing
// it returns carries an amount of one household's: the couple's pages read through couple.ts, a guest's through
// public.ts. No change-log line written here carries an amount either.
import { inOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { logChange } from '../changelog';
import { requireWedding, todayOf } from '../context';
import { dbOfDay } from '../days';
import { lockWedding } from '../schedule/store';
import { planClose, planContribution, type RefusalCode } from './ledger';

type Ctx = { orgId: string; userId: string | null };

/** What an item's pot holds: the sum of its entries. Read it only after lockWedding. */
async function potOf(tx: Tx, orgId: string, itemId: string): Promise<number> {
  return (await tx.giftEntry.aggregate({ where: { orgId, itemId }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
}

/** What each household has in the pot (for thank-yous and refunds). Never returned to a page. */
async function netOf(tx: Tx, orgId: string, itemId: string) {
  const rows = await tx.giftEntry.groupBy({ by: ['householdId'], where: { orgId, itemId }, _sum: { amountCents: true } });
  return rows.map((r) => ({ householdId: r.householdId, kind: 'contribution' as const, amountCents: r._sum.amountCents ?? 0 })).filter((r) => r.amountCents > 0);
}

export type ItemInput = { title: string; note: string; targetCents: number };

export async function addItem(tx: Tx, ctx: Ctx, input: ItemInput) {
  await lockWedding(tx, ctx.orgId);
  if (await tx.registryItem.findFirst({ where: { ...inOrg(ctx), title: input.title }, select: { id: true } })) throw new Refused(`There is already a gift called ${input.title}.`);
  const item = await tx.registryItem.create({ data: { orgId: ctx.orgId, ...input, createdById: ctx.userId } });
  await logChange(tx, ctx, 'registry', 'created', item.id, item.title, null, { ...input });
  return item;
}

/** An open item can be renamed, re-described and re-priced, but never below what is already in its pot. */
export async function updateItem(tx: Tx, ctx: Ctx, id: string, input: ItemInput) {
  await lockWedding(tx, ctx.orgId);
  const item = await tx.registryItem.findFirstOrThrow({ where: { id, ...inOrg(ctx) } });
  if (item.state !== 'open') throw new Refused(item.state === 'funded' ? 'That gift is funded; it can no longer change.' : 'That gift is closed; it can no longer change.');
  if (input.title !== item.title && (await tx.registryItem.findFirst({ where: { ...inOrg(ctx), title: input.title }, select: { id: true } }))) throw new Refused(`There is already a gift called ${input.title}.`);
  const pot = await potOf(tx, ctx.orgId, id);
  if (input.targetCents < pot) throw new Refused('Guests have already given more than that toward this gift. The target cannot go below what is in the pot.');
  const after = await tx.registryItem.update({ where: { id }, data: input });
  await logChange(tx, ctx, 'registry', 'updated', id, after.title, { title: item.title, note: item.note, targetCents: item.targetCents }, { ...input });
  if (pot > 0 && pot === after.targetCents) await fund(tx, ctx, after);
}

/** The fully-funded trigger: the item becomes funded and each household that gave is owed a thank-you. */
async function fund(tx: Tx, ctx: Ctx, item: { id: string; title: string }) {
  const on = todayOf(await requireWedding(tx, ctx));
  await tx.registryItem.update({ where: { id: item.id }, data: { state: 'funded', fundedOn: dbOfDay(on) } });
  await logChange(tx, ctx, 'registry', 'funded', item.id, item.title, { state: 'open' }, { state: 'funded', fundedOn: on });
  const givers = await netOf(tx, ctx.orgId, item.id);
  const households = await tx.household.findMany({ where: { orgId: ctx.orgId, id: { in: givers.map((g) => g.householdId) } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  for (const h of households) {
    const t = await tx.thankYou.create({ data: { orgId: ctx.orgId, itemId: item.id, householdId: h.id, createdAt: now() } });
    await logChange(tx, ctx, 'thankyou', 'created', t.id, `${h.name}, for ${item.title}`, null, { household: h.name, item: item.title });
  }
}

export type Contributed = { ok: true; returned: boolean; funded: boolean } | { ok: false; code: RefusalCode | 'not-here' };

/**
 * One household's offer toward one item. Null when the household is not (or no longer) invited. The offer is planned
 * against the pot as it is once every earlier offer has committed; whatever is more than needed goes straight back.
 * The change-log line says who gave toward what, and never how much.
 */
export async function contribute(tx: Tx, orgId: string, householdId: string, itemId: string, offerCents: number): Promise<Contributed | null> {
  await lockWedding(tx, orgId);
  const ctx = { orgId, userId: null };
  const household = await tx.household.findFirst({ where: { id: householdId, orgId, state: 'invited' }, select: { id: true, name: true } });
  if (!household) return null;
  const item = await tx.registryItem.findFirst({ where: { id: itemId, orgId } });
  if (!item) return { ok: false, code: 'not-here' };
  const plan = planContribution(item, await potOf(tx, orgId, item.id), offerCents);
  if (!plan.ok) return plan;
  const at = now();
  for (const line of plan.lines) await tx.giftEntry.create({ data: { orgId, itemId: item.id, householdId: household.id, kind: line.kind, amountCents: line.amountCents, createdAt: at } });
  await logChange(tx, ctx, 'gift', 'contributed', item.id, `${household.name} gave toward ${item.title}`, null, { household: household.name, item: item.title }, { via: 'gift-link' });
  if (plan.funds) await fund(tx, ctx, item);
  return { ok: true, returned: plan.returnedCents > 0, funded: plan.funds };
}

/**
 * Close the registry: every open item is closed unfunded, and everything given toward it is refunded, one refund
 * entry per household, netting each to zero. Funded items stay funded. One transaction. Returns how many closed.
 */
export async function closeRegistry(tx: Tx, ctx: Ctx): Promise<number> {
  await lockWedding(tx, ctx.orgId);
  const open = await tx.registryItem.findMany({ where: { ...inOrg(ctx), state: 'open' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  if (!open.length) throw new Refused('Nothing to close: no gift is open.');
  const on = todayOf(await requireWedding(tx, ctx));
  const at = now();
  for (const item of open) {
    const refunds = planClose(await netOf(tx, ctx.orgId, item.id));
    for (const r of refunds) await tx.giftEntry.create({ data: { orgId: ctx.orgId, itemId: item.id, householdId: r.householdId, kind: r.kind, amountCents: r.amountCents, createdAt: at } });
    await tx.registryItem.update({ where: { id: item.id }, data: { state: 'closed_unfunded', closedOn: dbOfDay(on) } });
    await logChange(tx, ctx, 'registry', 'closed', item.id, item.title, { state: 'open' }, { state: 'closed_unfunded', closedOn: on }, { householdsRefunded: refunds.length });
  }
  return open.length;
}

/** A partner marks a thank-you as sent. Once. */
export async function acknowledgeThankYou(tx: Tx, ctx: Ctx & { userId: string }, id: string) {
  const t = await tx.thankYou.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, include: { household: { select: { name: true } }, item: { select: { title: true } } } });
  if (t.acknowledgedOn) throw new Refused('That thank-you is already marked as sent.');
  const on = todayOf(await requireWedding(tx, ctx));
  await tx.thankYou.update({ where: { id }, data: { acknowledgedOn: dbOfDay(on), acknowledgedById: ctx.userId } });
  await logChange(tx, ctx, 'thankyou', 'acknowledged', id, `${t.household.name}, for ${t.item.title}`, { acknowledgedOn: null }, { acknowledgedOn: on });
}
