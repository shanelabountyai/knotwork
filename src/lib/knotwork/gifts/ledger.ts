// The gift ledger (PRD P0-5: "partial contributions toward a target, fully-funded trigger, refund-on-unfunded at
// close"). PURE. Mock money in integer cents: nothing is charged, everything is ledgered.
//
// The pot of an item is the SUM of its entries; no total is stored. A contribution is one positive entry for the whole
// offer and, when the offer is more than what remains, one negative `excess_return` entry for the difference, so the
// pot lands on the target exactly. Closing an unfunded item writes one negative `refund` entry per household, for
// exactly what that household still has in the pot. Entries are never changed or removed (the database refuses it).
// tools/gift_oracle.py recomputes fixtures/gifts/ without sharing any of this code.

export type ItemState = 'open' | 'funded' | 'closed_unfunded';
export type EntryKind = 'contribution' | 'excess_return' | 'refund';
export type Line = { kind: EntryKind; amountCents: number };
export type Entry = Line & { householdId: string };

/** The smallest and largest single offer: $1.00 and $100,000.00 (D-69). */
export const GIFT_MIN_CENTS = 100;
export const GIFT_MAX_CENTS = 10_000_000;
/** The largest target an item can have: $100,000.00. */
export const TARGET_MAX_CENTS = 10_000_000;

export const potCents = (entries: readonly { amountCents: number }[]): number => entries.reduce((n, e) => n + e.amountCents, 0);

/** What each household has in the pot right now (its contributions less anything returned to it). */
export function netByHousehold(entries: readonly Entry[]): Map<string, number> {
  const net = new Map<string, number>();
  for (const e of entries) net.set(e.householdId, (net.get(e.householdId) ?? 0) + e.amountCents);
  return net;
}

/** The households with something in the pot, in a stable order. */
export const contributorsOf = (entries: readonly Entry[]): string[] => [...netByHousehold(entries)].filter(([, n]) => n > 0).map(([h]) => h).sort();

export type RefusalCode = 'amount' | 'funded' | 'closed';
export type ContributionPlan =
  | { ok: true; lines: Line[]; keptCents: number; returnedCents: number; potAfterCents: number; funds: boolean }
  | { ok: false; code: RefusalCode };

/**
 * What one offer does to a pot that currently holds `pot`. Refused when nothing remains (or the item is closed):
 * a refused offer writes nothing. The caller must have read `pot` under the wedding lock.
 */
export function planContribution(item: { targetCents: number; state: ItemState }, pot: number, offerCents: number): ContributionPlan {
  if (!Number.isInteger(offerCents) || offerCents < GIFT_MIN_CENTS || offerCents > GIFT_MAX_CENTS) return { ok: false, code: 'amount' };
  if (item.state === 'closed_unfunded') return { ok: false, code: 'closed' };
  const remaining = item.targetCents - pot;
  if (item.state === 'funded' || remaining <= 0) return { ok: false, code: 'funded' };
  const returned = Math.max(0, offerCents - remaining);
  const lines: Line[] = [{ kind: 'contribution', amountCents: offerCents }];
  if (returned > 0) lines.push({ kind: 'excess_return', amountCents: -returned });
  const potAfter = pot + offerCents - returned;
  return { ok: true, lines, keptCents: offerCents - returned, returnedCents: returned, potAfterCents: potAfter, funds: potAfter === item.targetCents };
}

/** Closing an unfunded item: one refund per household that still has something in the pot, netting each to zero. */
export function planClose(entries: readonly Entry[]): Entry[] {
  return [...netByHousehold(entries)].filter(([, n]) => n > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([householdId, n]) => ({ householdId, kind: 'refund' as const, amountCents: -n }));
}

// ---- a whole story, for the fixtures: contributions in order, then perhaps a close

export type Step = { op: 'contribute'; household: string; offerCents: number } | { op: 'close' };
export type StepResult = { ok: true; lines: Line[]; potCents: number; state: ItemState } | { ok: false; code: RefusalCode | 'not-open' };
export type Replay = { steps: StepResult[]; entries: Entry[]; potCents: number; state: ItemState; net: Record<string, number>; thankYous: string[] };

export function replay(targetCents: number, steps: readonly Step[]): Replay {
  const entries: Entry[] = [];
  let state: ItemState = 'open';
  let thankYous: string[] = [];
  const out: StepResult[] = [];
  for (const s of steps) {
    if (s.op === 'close') {
      if (state !== 'open') {
        out.push({ ok: false, code: 'not-open' });
        continue;
      }
      const refunds = planClose(entries);
      entries.push(...refunds);
      state = 'closed_unfunded';
      out.push({ ok: true, lines: refunds.map((r) => ({ kind: r.kind, amountCents: r.amountCents })), potCents: potCents(entries), state });
      continue;
    }
    const plan = planContribution({ targetCents, state }, potCents(entries), s.offerCents);
    if (!plan.ok) {
      out.push({ ok: false, code: plan.code });
      continue;
    }
    entries.push(...plan.lines.map((l) => ({ ...l, householdId: s.household })));
    if (plan.funds) {
      state = 'funded';
      thankYous = contributorsOf(entries); // one obligation per household that gave
    }
    out.push({ ok: true, lines: plan.lines, potCents: plan.potAfterCents, state });
  }
  const net = Object.fromEntries([...netByHousehold(entries)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { steps: out, entries, potCents: potCents(entries), state, net, thankYous };
}
