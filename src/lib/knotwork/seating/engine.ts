// P1-5, the seating chart: generate (a greedy draft, seeded so a result can be reproduced) → score (hard violations,
// soft preferences, one comparable number) → repair (a bounded local search). PURE: no clock, no database.
//
// Bracketry's engine is a reference this run cannot read (D-91); the generate-score-repair shape is rebuilt from the
// PRD text. tools/seating_oracle.py scores a seating independently (and, for small cases, finds the best one by brute
// force), so the fixtures in fixtures/seating/ are checked by two implementations that share no code.
//
// The rules (D-125):
// - A table seats at most its capacity. Every guest given to the engine must be seated.
// - A pair is "apart" or "together", hard (never broken) or soft (a preference with a weight).
// - A household sits together by default, as a SOFT rule: a household bigger than a table, or one split by a hard
//   rule, still gets a seating; each member away from the household's largest group costs a little.
// - A locked seat never moves. A regenerate keeps every locked seat and redoes the rest.
// Score: hard = unseated guests + seats over capacity + hard pairs broken; soft = 3 per soft pair broken + 2 per
// household member away from the household's largest group. total = hard × 1,000,000 + soft; lower is better, 0 is
// perfect. When a hard rule cannot be kept the answer says so: `infeasible` (provably, with the reasons) or
// `unsolved` (the bounded search found nothing that keeps every hard rule; the hard violations are listed). Neither is
// ever saved as if it were a seating.

export type SeatTable = { id: string; name: string; capacity: number };
export type SeatGuest = { id: string; name: string; household: string };
export type PairRule = { a: string; b: string; kind: 'apart' | 'together'; hard: boolean };
export type Problem = { tables: SeatTable[]; guests: SeatGuest[]; rules: PairRule[]; locked: Record<string, string> };
/** guest id → table id. */
export type Seats = Record<string, string>;

export const WEIGHT = { hard: 1_000_000, pair: 3, household: 2 } as const;
/** Bounds on what one chart may hold: the score stays exact (soft never reaches the hard weight) and a search stays bounded. */
export const SEATING_LIMITS = { tables: 100, capacity: 30, guests: 1000, rules: 2000 } as const;
/** The search's budget: how many candidate moves it may evaluate in all, passes per draft, and how many drafts. */
export const DEFAULT_BUDGET = { evaluations: 400_000, passes: 60, restarts: 6 } as const;

export type Code = 'unseated' | 'over' | 'apart' | 'together' | 'household';
export type Violation = { code: Code; hard: boolean; guests: string[]; table: string | null; household: string | null; count: number };
export type Score = { hard: number; soft: number; total: number; violations: Violation[] };

export type Reason =
  | { code: 'capacity'; need: number; have: number }
  | { code: 'group-too-big'; guests: string[]; size: number; largest: number }
  | { code: 'apart-in-group'; guests: string[] }
  | { code: 'locked-split'; guests: string[] }
  | { code: 'locked-full'; table: string; need: number; capacity: number }
  | { code: 'locked-apart'; guests: string[]; table: string };

export type Result = { status: 'ok' | 'unsolved' | 'infeasible'; reasons: Reason[]; seats: Seats; score: Score | null };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const CODE_ORDER: Record<Code, number> = { unseated: 0, over: 1, apart: 2, together: 3, household: 4 };

/** What is wrong with a problem's shape (duplicate ids, unknown guests, a guest paired with themself, bounds). Empty when sound. */
export function problemErrors(p: Problem): string[] {
  const out: string[] = [];
  const tables = new Set(p.tables.map((t) => t.id));
  const guests = new Set(p.guests.map((g) => g.id));
  if (tables.size !== p.tables.length) out.push('duplicate table id');
  if (guests.size !== p.guests.length) out.push('duplicate guest id');
  if (p.tables.length > SEATING_LIMITS.tables) out.push('too many tables');
  if (p.guests.length > SEATING_LIMITS.guests) out.push('too many guests');
  if (p.rules.length > SEATING_LIMITS.rules) out.push('too many rules');
  for (const t of p.tables) if (!Number.isInteger(t.capacity) || t.capacity < 1 || t.capacity > SEATING_LIMITS.capacity) out.push(`table ${t.id}: capacity`);
  const pairs = new Set<string>();
  for (const r of p.rules) {
    if (!guests.has(r.a) || !guests.has(r.b)) out.push(`rule ${r.a}/${r.b}: unknown guest`);
    if (r.a === r.b) out.push(`rule ${r.a}: a guest paired with themself`);
    const key = [r.a, r.b].sort(cmp).join('|');
    if (pairs.has(key)) out.push(`rule ${key}: twice`);
    pairs.add(key);
  }
  for (const [g, t] of Object.entries(p.locked)) if (!guests.has(g) || !tables.has(t)) out.push(`lock ${g}: unknown guest or table`);
  return out;
}

// ---- score ------------------------------------------------------------------------------------------------------------

/** The score of a seating, from scratch. A seat at a table that does not exist counts as no seat. */
export function score(p: Problem, seats: Seats): Score {
  const cap = new Map(p.tables.map((t) => [t.id, t.capacity]));
  const at = (g: string) => (seats[g] !== undefined && cap.has(seats[g]) ? seats[g] : null);
  const v: Violation[] = [];
  const count = new Map<string, number>();
  for (const g of p.guests) {
    const t = at(g.id);
    if (t === null) v.push({ code: 'unseated', hard: true, guests: [g.id], table: null, household: null, count: 1 });
    else count.set(t, (count.get(t) ?? 0) + 1);
  }
  for (const t of p.tables) {
    const over = (count.get(t.id) ?? 0) - t.capacity;
    if (over > 0) v.push({ code: 'over', hard: true, guests: [], table: t.id, household: null, count: over });
  }
  for (const r of p.rules) {
    const [ta, tb] = [at(r.a), at(r.b)];
    if (ta === null || tb === null) continue;
    const broken = r.kind === 'apart' ? ta === tb : ta !== tb;
    if (broken) v.push({ code: r.kind, hard: r.hard, guests: [r.a, r.b].sort(cmp), table: r.kind === 'apart' ? ta : null, household: null, count: 1 });
  }
  const byHousehold = new Map<string, Map<string, number>>();
  for (const g of p.guests) {
    const t = at(g.id);
    if (t === null) continue;
    const m = byHousehold.get(g.household) ?? new Map<string, number>();
    m.set(t, (m.get(t) ?? 0) + 1);
    byHousehold.set(g.household, m);
  }
  for (const [h, m] of byHousehold) {
    const seated = [...m.values()].reduce((n, x) => n + x, 0);
    const away = seated - Math.max(...m.values());
    if (away > 0) v.push({ code: 'household', hard: false, guests: [], table: null, household: h, count: away });
  }
  v.sort((x, y) => Number(y.hard) - Number(x.hard) || CODE_ORDER[x.code] - CODE_ORDER[y.code] || cmp(x.guests.join(','), y.guests.join(',')) || cmp(x.table ?? '', y.table ?? '') || cmp(x.household ?? '', y.household ?? ''));
  const hard = v.filter((x) => x.hard).reduce((n, x) => n + x.count, 0);
  const soft = v.filter((x) => !x.hard).reduce((n, x) => n + x.count * (x.code === 'household' ? WEIGHT.household : WEIGHT.pair), 0);
  return { hard, soft, total: hard * WEIGHT.hard + soft, violations: v };
}

// ---- what can never work ------------------------------------------------------------------------------------------------

class Groups {
  private parent = new Map<string, string>();
  find(x: string): string {
    let r = x;
    while (this.parent.has(r) && this.parent.get(r) !== r) r = this.parent.get(r)!;
    let y = x;
    while (y !== r) {
      const next = this.parent.get(y) ?? y;
      this.parent.set(y, r);
      y = next;
    }
    return r;
  }
  join(a: string, b: string) {
    const [ra, rb] = [this.find(a), this.find(b)];
    if (ra !== rb) this.parent.set(cmp(ra, rb) < 0 ? rb : ra, cmp(ra, rb) < 0 ? ra : rb);
  }
}

/** Guests who must sit at one table (hard "together" pairs, followed through), each list in input order. */
function hardGroups(p: Problem): string[][] {
  const u = new Groups();
  for (const g of p.guests) u.find(g.id);
  for (const r of p.rules) if (r.kind === 'together' && r.hard) u.join(r.a, r.b);
  const out = new Map<string, string[]>();
  for (const g of p.guests) {
    const k = u.find(g.id);
    out.set(k, [...(out.get(k) ?? []), g.id]);
  }
  return [...out.values()];
}

/** Why no seating can keep every hard rule, as far as these checks can prove it. Empty: none proven. */
export function infeasibility(p: Problem): Reason[] {
  const reasons: Reason[] = [];
  const have = p.tables.reduce((n, t) => n + t.capacity, 0);
  if (p.guests.length > have) reasons.push({ code: 'capacity', need: p.guests.length, have });
  const largest = Math.max(0, ...p.tables.map((t) => t.capacity));
  const groups = hardGroups(p);
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((x) => groupOf.set(x, i)));
  for (const g of groups) if (g.length > largest) reasons.push({ code: 'group-too-big', guests: g, size: g.length, largest });
  for (const r of p.rules) if (r.kind === 'apart' && r.hard && groupOf.get(r.a) === groupOf.get(r.b)) reasons.push({ code: 'apart-in-group', guests: [r.a, r.b].sort(cmp) });
  // Locks: a group locked at two tables; a table whose locked guests (and the groups they pin there) outgrow it; two
  // guests locked together at one table who must sit apart.
  const need = new Map<string, number>();
  for (const g of groups) {
    const at = [...new Set(g.map((x) => p.locked[x]).filter((t): t is string => t !== undefined))];
    if (at.length > 1) reasons.push({ code: 'locked-split', guests: g });
    else if (at.length === 1) need.set(at[0]!, (need.get(at[0]!) ?? 0) + g.length);
  }
  for (const t of p.tables) if ((need.get(t.id) ?? 0) > t.capacity) reasons.push({ code: 'locked-full', table: t.id, need: need.get(t.id)!, capacity: t.capacity });
  for (const r of p.rules) {
    if (r.kind === 'apart' && r.hard && p.locked[r.a] !== undefined && p.locked[r.a] === p.locked[r.b]) reasons.push({ code: 'locked-apart', guests: [r.a, r.b].sort(cmp), table: p.locked[r.a]! });
  }
  return reasons;
}

// ---- the board: a seating being built, with costs that change locally ---------------------------------------------------

/** A small, fast, seeded generator (mulberry32). Same seed, same numbers. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(xs: readonly T[], rnd: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

class Board {
  readonly at = new Map<string, string | null>();
  readonly count = new Map<string, number>();
  private readonly hh = new Map<string, Map<string, number>>();
  private readonly household = new Map<string, string>();
  private readonly adj = new Map<string, PairRule[]>();
  readonly cap: Map<string, number>;

  constructor(p: Problem) {
    this.cap = new Map(p.tables.map((t) => [t.id, t.capacity]));
    for (const t of p.tables) this.count.set(t.id, 0);
    for (const g of p.guests) {
      this.at.set(g.id, null);
      this.household.set(g.id, g.household);
      this.adj.set(g.id, []);
    }
    for (const r of p.rules) {
      this.adj.get(r.a)!.push(r);
      this.adj.get(r.b)!.push(r);
    }
  }
  free = (t: string) => this.cap.get(t)! - this.count.get(t)!;
  set(g: string, t: string | null) {
    const was = this.at.get(g)!;
    if (was === t) return;
    const h = this.household.get(g)!;
    const m = this.hh.get(h) ?? new Map<string, number>();
    if (was !== null) {
      this.count.set(was, this.count.get(was)! - 1);
      const n = m.get(was)! - 1;
      if (n) m.set(was, n);
      else m.delete(was);
    }
    if (t !== null) {
      this.count.set(t, this.count.get(t)! + 1);
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    this.hh.set(h, m);
    this.at.set(g, t);
  }
  private pairCost(r: PairRule) {
    const [ta, tb] = [this.at.get(r.a)!, this.at.get(r.b)!];
    if (ta === null || tb === null) return 0;
    const broken = r.kind === 'apart' ? ta === tb : ta !== tb;
    return broken ? (r.hard ? WEIGHT.hard : WEIGHT.pair) : 0;
  }
  private householdCost(h: string) {
    const m = this.hh.get(h);
    if (!m || !m.size) return 0;
    let seated = 0;
    let most = 0;
    for (const n of m.values()) {
      seated += n;
      if (n > most) most = n;
    }
    return (seated - most) * WEIGHT.household;
  }
  /** The cost of everything these guests touch: their rules, their households, and their being unseated. */
  private local(guests: readonly string[]) {
    const rules = new Set<PairRule>();
    const households = new Set<string>();
    let cost = 0;
    for (const g of guests) {
      for (const r of this.adj.get(g)!) rules.add(r);
      households.add(this.household.get(g)!);
      if (this.at.get(g) === null) cost += WEIGHT.hard;
    }
    for (const r of rules) cost += this.pairCost(r);
    for (const h of households) cost += this.householdCost(h);
    return cost;
  }
  /** How the total would change if each guest moved as given (capacity is the caller's to respect). */
  delta(moves: readonly (readonly [string, string | null])[]): number {
    const guests = moves.map(([g]) => g);
    const before = this.local(guests);
    const was = moves.map(([g]) => [g, this.at.get(g)!] as const);
    for (const [g, t] of moves) this.set(g, t);
    const after = this.local(guests);
    for (const [g, t] of was) this.set(g, t);
    return after - before;
  }
  seats(): Seats {
    const out: Seats = {};
    for (const [g, t] of this.at) if (t !== null) out[g] = t;
    return out;
  }
}

// ---- generate, then repair ----------------------------------------------------------------------------------------------

/**
 * A seating for the problem. Locked seats stay where they are; every other guest is placed by a greedy draft (bigger
 * households and groups first, each to the table where it costs least, best fit, ties broken by the seed) and then
 * improved by moving whole groups and swapping single guests while that lowers the score. Several drafts, within
 * `budget`; the best is kept.
 * Same problem and seed: same seating.
 */
export function generate(p: Problem, seed: number, budget: { evaluations: number; passes: number; restarts: number } = DEFAULT_BUDGET): Result {
  const errors = problemErrors(p);
  if (errors.length) throw new Error(`seating problem: ${errors.join('; ')}`);
  const reasons = infeasibility(p);
  if (reasons.length) return { status: 'infeasible', reasons, seats: {}, score: null };
  // A few drafts from seeds drawn from this one, each repaired with its share of the budget; the best is kept (the
  // first of equals), so a local search stuck in one draft can still be rescued by another.
  const seeds = prng(seed);
  let best: { seats: Seats; score: Score } | null = null;
  for (let i = 0; i < budget.restarts; i++) {
    const seats = draft(p, i === 0 ? seed : Math.floor(seeds() * 2 ** 32), { evaluations: Math.floor(budget.evaluations / budget.restarts), passes: budget.passes });
    const s = score(p, seats);
    if (!best || s.total < best.score.total) best = { seats, score: s };
    if (s.total === 0) break;
  }
  return { status: best!.score.hard === 0 ? 'ok' : 'unsolved', reasons: [], seats: best!.seats, score: best!.score };
}

function draft(p: Problem, seed: number, budget: { evaluations: number; passes: number }): Seats {
  const rnd = prng(seed);
  const b = new Board(p);
  const tables = shuffle(p.tables.map((t) => t.id), rnd); // the tie-break order for this seed
  const rank = new Map(tables.map((t, i) => [t, i]));
  const householdOf = new Map(p.guests.map((g) => [g.id, g.household]));

  // Units: hard-together groups. A group with a locked member is pinned to that table, all of it, and never moves.
  const units: string[][] = [];
  for (const g of hardGroups(p)) {
    const pin = g.map((x) => p.locked[x]).find((t) => t !== undefined);
    if (pin !== undefined) for (const x of g) b.set(x, pin);
    else units.push(g);
  }

  // Clusters: units by the household of their first member, biggest first; inside one, biggest unit first.
  const clusters = new Map<string, string[][]>();
  for (const u of units) {
    const h = householdOf.get(u[0]!)!;
    clusters.set(h, [...(clusters.get(h) ?? []), u]);
  }
  const size = (c: string[][]) => c.reduce((n, u) => n + u.length, 0);
  const order = shuffle([...clusters.values()], rnd).sort((x, y) => size(y) - size(x));
  for (const cluster of order) {
    let left = size(cluster);
    let started = false;
    for (const u of [...cluster].sort((x, y) => y.length - x.length)) {
      const fits = tables.filter((t) => b.free(t) >= u.length);
      if (fits.length) {
        const cost = (t: string) => b.delta(u.map((g) => [g, t] as const)) + (started ? 0 : WEIGHT.household * Math.max(0, left - b.free(t)));
        const best = fits.map((t) => ({ t, c: cost(t), after: b.free(t) - u.length })).sort((x, y) => x.c - y.c || x.after - y.after || rank.get(x.t)! - rank.get(y.t)!)[0]!;
        for (const g of u) b.set(g, best.t);
      } else {
        // No table has room for the whole group (only once tables are nearly full): seat its members one by one.
        for (const g of u) {
          const open = tables.filter((t) => b.free(t) >= 1);
          if (!open.length) break;
          const best = open.map((t) => ({ t, c: b.delta([[g, t]]) })).sort((x, y) => x.c - y.c || rank.get(x.t)! - rank.get(y.t)!)[0]!;
          b.set(g, best.t);
        }
      }
      left -= u.length;
      started = true;
    }
  }

  repair(b, units, tables, rnd, budget);
  return b.seats();
}

/** Moves a group to the table where it gains most, or swaps a single guest with one at another table, while that helps. */
function repair(b: Board, units: string[][], tables: string[], rnd: () => number, budget: { evaluations: number; passes: number }) {
  let evaluations = 0;
  const singles = units.filter((u) => u.length === 1).map((u) => u[0]!);
  const single = new Set(singles);
  for (let pass = 0; pass < budget.passes && evaluations < budget.evaluations; pass++) {
    let improved = false;
    for (const u of shuffle(units, rnd)) {
      if (evaluations >= budget.evaluations) break;
      // Move the whole group to a table with room for the members not already there.
      let best: { t: string; d: number } | null = null;
      for (const t of tables) {
        const coming = u.filter((g) => b.at.get(g) !== t).length;
        if (!coming || b.free(t) < coming) continue;
        evaluations++;
        const d = b.delta(u.map((g) => [g, t] as const));
        if (d < 0 && (!best || d < best.d)) best = { t, d };
      }
      if (best) {
        for (const g of u) b.set(g, best.t);
        improved = true;
        continue;
      }
      // A single guest: swap with a single guest at another table.
      const g = u[0]!;
      const tg = b.at.get(g)!;
      if (u.length !== 1 || tg === null) continue;
      for (const h of singles) {
        if (evaluations >= budget.evaluations) break;
        const th = b.at.get(h)!;
        if (th === null || th === tg || !single.has(h)) continue;
        evaluations++;
        if (b.delta([[g, th], [h, tg]]) < 0) {
          b.set(g, th);
          b.set(h, tg);
          improved = true;
          break;
        }
      }
    }
    if (!improved) break;
  }
}

// ---- words ---------------------------------------------------------------------------------------------------------------

type Names = { guest: (id: string) => string; table: (id: string) => string; household: (id: string) => string };
const both = (n: Names, ids: readonly string[]) => ids.map(n.guest).join(' and ');

/** One sentence per violation, for the page. */
export function violationText(v: Violation, n: Names): string {
  const strength = v.hard ? 'must' : 'would like to';
  switch (v.code) {
    case 'unseated': return `${n.guest(v.guests[0]!)} has no seat.`;
    case 'over': return `${n.table(v.table!)} has ${v.count} more ${v.count === 1 ? 'guest' : 'guests'} than seats.`;
    case 'apart': return `${both(n, v.guests)} ${strength} sit apart, and both are at ${n.table(v.table!)}.`;
    case 'together': return `${both(n, v.guests)} ${strength} sit together, and are at different tables.`;
    case 'household': return `${n.household(v.household!)}: ${v.count} ${v.count === 1 ? 'member sits' : 'members sit'} away from the rest of the household.`;
  }
}

/** One sentence per reason no seating can work. */
export function reasonText(r: Reason, n: Names): string {
  switch (r.code) {
    case 'capacity': return `There are ${r.need} guests to seat and ${r.have} seats at the tables.`;
    case 'group-too-big': return `${both(n, r.guests)} must all sit together: ${r.size} guests, and the largest table seats ${r.largest}.`;
    case 'apart-in-group': return `${both(n, r.guests)} must sit apart, but the "together" rules put them at one table.`;
    case 'locked-split': return `${both(n, r.guests)} must sit together, but are locked at different tables.`;
    case 'locked-full': return `${n.table(r.table)} seats ${r.capacity}, and the locked seats need ${r.need} there.`;
    case 'locked-apart': return `${both(n, r.guests)} must sit apart, but both are locked at ${n.table(r.table)}.`;
  }
}
