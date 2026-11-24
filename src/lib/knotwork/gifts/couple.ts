// What the COUPLE sees of the registry (PRD P0-5: "couple sees progress + contributor names, never individual
// amounts"). The separation is structural: this file reads the ledger in exactly two ways, and neither can return what
// one household gave:
//   1. a SUM per item (`groupBy` by item only), and
//   2. the DISTINCT (item, household) pairs, selecting the household's name and nothing from the entry.
// tests/knotwork/structure.test.ts holds this file to those two shapes, and holds the couple's pages, actions and the
// data export to never naming an entry's amount at all. (With a single contributor the item's total IS their amount;
// that is what "progress and names" means, D-70.)
import type { Tx } from '@/core/db/rls';
import { dayOfDb, type Day } from '../days';

export type CoupleItem = {
  id: string; title: string; note: string; targetCents: number; raisedCents: number; remainingCents: number; percent: number;
  state: 'open' | 'funded' | 'closed_unfunded'; fundedOn: Day | null; closedOn: Day | null;
  /** Household names, A to Z: everyone who gave toward it (for a closed item: everyone who was refunded). */
  contributors: string[];
};

async function raisedByItem(tx: Tx, orgId: string): Promise<Map<string, number>> {
  const sums = await tx.giftEntry.groupBy({ by: ['itemId'], where: { orgId }, _sum: { amountCents: true } });
  return new Map(sums.map((s) => [s.itemId, s._sum.amountCents ?? 0]));
}

async function namesByItem(tx: Tx, orgId: string): Promise<Map<string, string[]>> {
  const pairs = await tx.giftEntry.findMany({ where: { orgId }, distinct: ['itemId', 'householdId'], select: { itemId: true, household: { select: { name: true } } } });
  const names = new Map<string, string[]>();
  for (const p of pairs) names.set(p.itemId, [...(names.get(p.itemId) ?? []), p.household.name]);
  for (const list of names.values()) list.sort((a, b) => a.localeCompare(b));
  return names;
}

export async function loadRegistry(tx: Tx, ctx: { orgId: string }): Promise<CoupleItem[]> {
  const items = await tx.registryItem.findMany({ where: { orgId: ctx.orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const [raised, names] = [await raisedByItem(tx, ctx.orgId), await namesByItem(tx, ctx.orgId)];
  return items.map((i) => {
    const got = raised.get(i.id) ?? 0;
    return {
      id: i.id, title: i.title, note: i.note, targetCents: i.targetCents, raisedCents: got, remainingCents: i.targetCents - got, percent: Math.floor((got * 100) / i.targetCents),
      state: i.state, fundedOn: i.fundedOn ? dayOfDb(i.fundedOn) : null, closedOn: i.closedOn ? dayOfDb(i.closedOn) : null, contributors: names.get(i.id) ?? [],
    };
  });
}

export type ThankYouRow = { id: string; household: string; item: string; owedSince: Day; acknowledgedOn: Day | null };

/** The thank-you feed: one obligation per household per funded item, unacknowledged first, then oldest first. */
export async function loadThankYous(tx: Tx, ctx: { orgId: string }, timeZoneDay: (at: Date) => Day): Promise<ThankYouRow[]> {
  const rows = await tx.thankYou.findMany({ where: { orgId: ctx.orgId }, include: { household: { select: { name: true } }, item: { select: { title: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return rows
    .map((t) => ({ id: t.id, household: t.household.name, item: t.item.title, owedSince: timeZoneDay(t.createdAt), acknowledgedOn: t.acknowledgedOn ? dayOfDb(t.acknowledgedOn) : null }))
    .sort((a, b) => Number(!!a.acknowledgedOn) - Number(!!b.acknowledgedOn) || a.owedSince.localeCompare(b.owedSince) || a.household.localeCompare(b.household));
}

/** For the data export: each item with its total and its contributors' names. The ledger's entries are not exported. */
export async function exportRegistry(tx: Tx, orgId: string): Promise<object[]> {
  return (await loadRegistry(tx, { orgId })).map((i) => ({ id: i.id, title: i.title, note: i.note, targetCents: i.targetCents, raisedCents: i.raisedCents, state: i.state, fundedOn: i.fundedOn, closedOn: i.closedOn, contributors: i.contributors }));
}
