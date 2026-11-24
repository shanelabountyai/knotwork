// P1-5, the seating chart in the database: tables, pair rules, seats, generate. A store; everything runs inside the
// caller's withOrg transaction, every write takes the wedding lock (one seating writer at a time) and logs its change.
//
// Who is seated (D-125): the guests of invited households who are attending, and also those who have not answered
// when the couple chose so (GuestPlan.seatPending). A declined or removed guest's seat no longer counts anywhere and
// is cleared by the next seating write. A rule counts only while both of its guests are to be seated.
// Never guest-facing (rule 3): nothing here is reachable from /r, /p or /v.
import { inOrg } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { logChange } from '../changelog';
import { requireWedding } from '../context';
import { loadHouseholds } from '../guests/store';
import { lockWedding } from '../schedule/store';
import { generate, problemErrors, reasonText, score, SEATING_LIMITS, violationText, type Problem, type Score, type Seats } from './engine';

type Ctx = { orgId: string; userId: string | null };
export const TABLE_NAME_MAX = 40;
export const SEED_MAX = 999_999;

export type SeatingGuest = { id: string; name: string; householdId: string; householdName: string; rsvp: 'attending' | 'pending' };
export type SeatingState = {
  seatPending: boolean;
  tables: { id: string; name: string; capacity: number }[];
  /** Everyone to be seated, by household then name. */
  guests: SeatingGuest[];
  /** Guests of invited households who have not answered and are not seated because seatPending is off. */
  waiting: number;
  /** Every guest a rule may name: invited, not removed, not declined (a rule on someone not seated now waits). */
  ruleOptions: { id: string; name: string }[];
  rules: { id: string; kind: 'apart' | 'together'; hard: boolean; a: { id: string; name: string }; b: { id: string; name: string }; active: boolean }[];
  seats: Record<string, { tableId: string; locked: boolean }>;
  /** Seats still held by guests who are no longer to be seated (cleared at the next write). */
  stale: number;
  problem: Problem;
  score: Score;
};

export async function loadSeating(tx: Tx, ctx: { orgId: string }): Promise<SeatingState> {
  const plan = await tx.guestPlan.findUnique({ where: { orgId: ctx.orgId }, select: { seatPending: true } });
  const seatPending = plan?.seatPending ?? false;
  const households = (await loadHouseholds(tx, ctx)).filter((h) => h.state === 'invited').sort((a, b) => a.name.localeCompare(b.name));
  const guests: SeatingGuest[] = [];
  const ruleOptions: { id: string; name: string }[] = [];
  let waiting = 0;
  for (const h of households) {
    for (const g of [...h.guests].sort((a, b) => a.name.localeCompare(b.name))) {
      if (g.removedAt || g.rsvp === 'declined') continue;
      ruleOptions.push({ id: g.id, name: g.name });
      if (g.rsvp === 'attending' || seatPending) guests.push({ id: g.id, name: g.name, householdId: h.id, householdName: h.name, rsvp: g.rsvp as SeatingGuest['rsvp'] });
      else waiting++;
    }
  }
  const seatable = new Set(guests.map((g) => g.id));
  const name = new Map(ruleOptions.map((g) => [g.id, g.name]));
  const tables = await tx.seatingTable.findMany({ where: inOrg(ctx), select: { id: true, name: true, capacity: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  const rows = await tx.seatingRule.findMany({ where: inOrg(ctx), orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const rules = rows.filter((r) => name.has(r.guestAId) && name.has(r.guestBId)).map((r) => {
    // Stored smaller id first; shown in name order.
    const [a, b] = [{ id: r.guestAId, name: name.get(r.guestAId)! }, { id: r.guestBId, name: name.get(r.guestBId)! }].sort((x, y) => x.name.localeCompare(y.name));
    return { id: r.id, kind: r.kind, hard: r.hard, a: a!, b: b!, active: seatable.has(r.guestAId) && seatable.has(r.guestBId) };
  });
  const seatRows = await tx.seat.findMany({ where: inOrg(ctx), select: { guestId: true, tableId: true, locked: true } });
  const seats: SeatingState['seats'] = {};
  for (const s of seatRows) if (seatable.has(s.guestId)) seats[s.guestId] = { tableId: s.tableId, locked: s.locked };
  const problem: Problem = {
    tables: tables.map((t) => ({ id: t.id, name: t.name, capacity: t.capacity })),
    guests: guests.map((g) => ({ id: g.id, name: g.name, household: g.householdId })),
    rules: rules.filter((r) => r.active).map((r) => ({ a: r.a.id, b: r.b.id, kind: r.kind, hard: r.hard })),
    locked: Object.fromEntries(Object.entries(seats).filter(([, s]) => s.locked).map(([g, s]) => [g, s.tableId])),
  };
  const current: Seats = Object.fromEntries(Object.entries(seats).map(([g, s]) => [g, s.tableId]));
  return { seatPending, tables, guests, waiting, ruleOptions, rules, seats, stale: seatRows.length - Object.keys(seats).length, problem, score: score(problem, current) };
}

/** Names for the engine's sentences. */
export function namesOf(s: Pick<SeatingState, 'tables' | 'guests' | 'ruleOptions'>) {
  const guest = new Map(s.ruleOptions.map((g) => [g.id, g.name]));
  const table = new Map(s.tables.map((t) => [t.id, t.name]));
  const household = new Map(s.guests.map((g) => [g.householdId, g.householdName]));
  return { guest: (id: string) => guest.get(id) ?? 'a guest', table: (id: string) => table.get(id) ?? 'a table', household: (id: string) => household.get(id) ?? 'A household' };
}
export const problemsText = (s: SeatingState) => s.score.violations.map((v) => violationText(v, namesOf(s)));

/** Takes the wedding lock and clears the seats of guests who are no longer to be seated. Every write starts here. */
async function begin(tx: Tx, ctx: Ctx): Promise<SeatingState> {
  const wedding = await requireWedding(tx, ctx);
  await lockWedding(tx, ctx.orgId);
  let s = await loadSeating(tx, ctx);
  if (s.stale) {
    const keep = new Set(s.guests.map((g) => g.id));
    const gone = (await tx.seat.findMany({ where: inOrg(ctx), select: { guestId: true } })).filter((x) => !keep.has(x.guestId)).map((x) => x.guestId);
    await tx.seat.deleteMany({ where: { ...inOrg(ctx), guestId: { in: gone } } });
    await logChange(tx, ctx, 'seating', 'updated', wedding.id, 'Seating chart', { seatsOfGuestsNotComing: gone.length }, { seatsOfGuestsNotComing: 0 });
    s = await loadSeating(tx, ctx);
  }
  return s;
}

// ---- tables ----------------------------------------------------------------------------------------------------------

export type TableInput = { name: string; capacity: number };
function checkTable(i: TableInput) {
  if (!i.name || i.name.length > TABLE_NAME_MAX) throw new Refused(`A table name is 1 to ${TABLE_NAME_MAX} characters.`);
  if (!Number.isInteger(i.capacity) || i.capacity < 1 || i.capacity > SEATING_LIMITS.capacity) throw new Refused(`A table seats 1 to ${SEATING_LIMITS.capacity}.`);
}

export async function addTable(tx: Tx, ctx: Ctx, i: TableInput) {
  checkTable(i);
  const s = await begin(tx, ctx);
  if (s.tables.length >= SEATING_LIMITS.tables) throw new Refused(`A seating chart holds up to ${SEATING_LIMITS.tables} tables.`);
  if (s.tables.some((t) => t.name === i.name)) throw new Refused('There is already a table with that name.');
  const t = await tx.seatingTable.create({ data: { orgId: ctx.orgId, name: i.name, capacity: i.capacity } });
  await logChange(tx, ctx, 'seating', 'created', t.id, `Table ${t.name}`, null, { capacity: t.capacity });
  return t;
}

export async function updateTable(tx: Tx, ctx: Ctx, id: string, i: TableInput) {
  checkTable(i);
  const s = await begin(tx, ctx);
  const t = s.tables.find((x) => x.id === id)!;
  if (i.name !== t.name && s.tables.some((x) => x.name === i.name)) throw new Refused('There is already a table with that name.');
  const seated = Object.values(s.seats).filter((x) => x.tableId === id).length;
  if (i.capacity < seated) throw new Refused(`${t.name} has ${seated} guests seated. Move some first, or keep at least ${seated} seats.`);
  await tx.seatingTable.update({ where: { id }, data: i });
  await logChange(tx, ctx, 'seating', 'updated', id, `Table ${i.name}`, { name: t.name, capacity: t.capacity }, { ...i });
}

/** Removes a table; its guests lose their seats (locked or not). */
export async function removeTable(tx: Tx, ctx: Ctx, id: string) {
  const s = await begin(tx, ctx);
  const t = s.tables.find((x) => x.id === id)!;
  const seated = Object.values(s.seats).filter((x) => x.tableId === id).length;
  await logChange(tx, ctx, 'seating', 'deleted', id, `Table ${t.name}`, { capacity: t.capacity, seated }, null);
  await tx.seatingTable.delete({ where: { id } });
}

// ---- rules -----------------------------------------------------------------------------------------------------------

export type RuleInput = { a: string; b: string; kind: 'apart' | 'together'; hard: boolean };

export async function addRule(tx: Tx, ctx: Ctx, i: RuleInput) {
  const s = await begin(tx, ctx);
  if (i.a === i.b) throw new Refused('Pick two different guests.');
  const known = new Map(s.ruleOptions.map((g) => [g.id, g.name]));
  if (!known.has(i.a) || !known.has(i.b)) throw new Refused('A rule names guests of invited households who have not declined.');
  const [a, b] = i.a < i.b ? [i.a, i.b] : [i.b, i.a];
  if (s.rules.some((r) => [r.a.id, r.b.id].sort().join() === [a, b].join())) throw new Refused(`${known.get(a)} and ${known.get(b)} already have a rule. Remove it first to change it.`);
  if ((await tx.seatingRule.count({ where: inOrg(ctx) })) >= SEATING_LIMITS.rules) throw new Refused(`A seating chart holds up to ${SEATING_LIMITS.rules} rules.`);
  const r = await tx.seatingRule.create({ data: { orgId: ctx.orgId, kind: i.kind, hard: i.hard, guestAId: a, guestBId: b, createdById: ctx.userId } });
  await logChange(tx, ctx, 'seating', 'created', r.id, `${[known.get(a)!, known.get(b)!].sort((x, y) => x.localeCompare(y)).join(' and ')}: ${i.kind}`, null, { kind: i.kind, hard: i.hard });
  return r;
}

export async function removeRule(tx: Tx, ctx: Ctx, id: string) {
  await begin(tx, ctx);
  const r = await tx.seatingRule.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, include: { guestA: { select: { name: true } }, guestB: { select: { name: true } } } });
  await logChange(tx, ctx, 'seating', 'deleted', id, `${r.guestA.name} and ${r.guestB.name}: ${r.kind}`, { kind: r.kind, hard: r.hard }, null);
  await tx.seatingRule.delete({ where: { id } });
}

// ---- seats -----------------------------------------------------------------------------------------------------------

/**
 * A manual move (D-127): the guest sits at `tableId` (or stands, with null), and the seat is LOCKED, so a regenerate
 * keeps what the couple placed by hand. Refused when the table is full. A hard rule the move breaks is shown on the
 * page as a problem; it is the couple's call.
 */
export async function moveGuest(tx: Tx, ctx: Ctx, guestId: string, tableId: string | null) {
  const s = await begin(tx, ctx);
  const g = s.guests.find((x) => x.id === guestId);
  if (!g) throw new Refused(s.ruleOptions.some((x) => x.id === guestId) ? 'Only guests who are coming are seated. Turn on seating guests who have not answered to seat them.' : 'That guest is not on the seating chart: only guests of invited households who have not declined are.');
  const was = s.seats[guestId] ?? null;
  if (tableId === null) {
    if (!was) throw new Refused(`${g.name} has no seat.`);
    await tx.seat.delete({ where: { guestId } });
  } else {
    const t = s.tables.find((x) => x.id === tableId)!;
    if (was?.tableId === tableId) throw new Refused(`${g.name} already sits at ${t.name}.`);
    const seated = Object.values(s.seats).filter((x) => x.tableId === tableId).length;
    if (seated >= t.capacity) throw new Refused(`${t.name} is full (${seated} of ${t.capacity}).`);
    await tx.seat.upsert({ where: { guestId }, create: { orgId: ctx.orgId, guestId, tableId, locked: true }, update: { tableId, locked: true } });
  }
  const tableName = (id: string | null | undefined) => (id ? s.tables.find((x) => x.id === id)!.name : null);
  await logChange(tx, ctx, 'seating', 'moved', guestId, g.name, { table: tableName(was?.tableId), locked: was?.locked ?? false }, { table: tableName(tableId), locked: tableId !== null });
}

export async function setLocked(tx: Tx, ctx: Ctx, guestId: string, locked: boolean) {
  const s = await begin(tx, ctx);
  const seat = s.seats[guestId];
  const g = s.guests.find((x) => x.id === guestId);
  if (!g || !seat) throw new Refused('Only a guest with a seat can be locked.');
  if (seat.locked === locked) throw new Refused(locked ? `${g.name}'s seat is already locked.` : `${g.name}'s seat is not locked.`);
  await tx.seat.update({ where: { guestId }, data: { locked } });
  await logChange(tx, ctx, 'seating', locked ? 'locked' : 'unlocked', guestId, g.name, { locked: seat.locked }, { locked });
}

/** Whether guests who have not answered are seated too. Turning it off clears their seats at once. */
export async function setSeatPending(tx: Tx, ctx: Ctx, on: boolean) {
  const wedding = await requireWedding(tx, ctx);
  await lockWedding(tx, ctx.orgId);
  const row = await tx.guestPlan.upsert({ where: { orgId: ctx.orgId }, create: { orgId: ctx.orgId, seatPending: on }, update: { seatPending: on } });
  await logChange(tx, ctx, 'guestplan', 'updated', row.id, 'Seating: who is seated', { seatPending: !on }, { seatPending: on });
  await begin(tx, ctx); // clears the seats of guests no longer to be seated
  return wedding;
}

export type Generated = { seated: number; locked: number; score: Score };

/**
 * Generates a seating (engine.ts) for everyone to be seated: locked seats stay, every other seat is replaced. When no
 * seating keeps every hard rule, nothing changes and the refusal says why, rule by rule (D-125).
 */
export async function generateSeating(tx: Tx, ctx: Ctx, seed: number): Promise<Generated> {
  if (!Number.isInteger(seed) || seed < 1 || seed > SEED_MAX) throw new Refused(`The arrangement number is a whole number from 1 to ${SEED_MAX}.`);
  const s = await begin(tx, ctx);
  if (!s.guests.length) throw new Refused('Nobody to seat yet: guests are seated once they say they are coming.');
  if (!s.tables.length) throw new Refused('Add a table first.');
  if (s.guests.length > SEATING_LIMITS.guests) throw new Refused(`The seating chart seats up to ${SEATING_LIMITS.guests} guests.`);
  const errors = problemErrors(s.problem);
  if (errors.length) throw new Error(`seating: ${errors.join('; ')}`);
  const r = generate(s.problem, seed);
  const n = namesOf(s);
  if (r.status === 'infeasible') throw new Refused(`No seating can keep every rule: ${r.reasons.map((x) => reasonText(x, n)).join(' ')} Nothing was changed.`);
  if (r.status === 'unsolved') throw new Refused(`No seating was found that keeps every rule marked "must": ${r.score!.violations.filter((v) => v.hard).map((v) => violationText(v, n)).join(' ')} Nothing was changed. Loosen one of these rules, or add a table.`);
  const locked = new Set(Object.keys(s.problem.locked));
  await tx.seat.deleteMany({ where: { ...inOrg(ctx), locked: false } });
  const fresh = Object.entries(r.seats).filter(([g]) => !locked.has(g));
  await tx.seat.createMany({ data: fresh.map(([guestId, tableId]) => ({ orgId: ctx.orgId, guestId, tableId, locked: false })) });
  const wedding = await requireWedding(tx, ctx);
  await logChange(tx, ctx, 'seating', 'generated', wedding.id, 'Seating chart', null, { arrangement: seed, seated: Object.keys(r.seats).length, locked: locked.size, hardProblems: r.score!.hard, preferencePoints: r.score!.soft });
  return { seated: Object.keys(r.seats).length, locked: locked.size, score: r.score! };
}

/** Clears every seat that is not locked. */
export async function clearSeats(tx: Tx, ctx: Ctx) {
  await begin(tx, ctx);
  const { count } = await tx.seat.deleteMany({ where: { ...inOrg(ctx), locked: false } });
  if (!count) throw new Refused('There are no unlocked seats to clear.');
  const wedding = await requireWedding(tx, ctx);
  await logChange(tx, ctx, 'seating', 'updated', wedding.id, 'Seating chart', { unlockedSeats: count }, { unlockedSeats: 0 });
}
