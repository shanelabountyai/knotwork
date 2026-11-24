// The guest list in the database (PRD P0-3, P0-4): households, guests, responses, invite waves, import, chasing.
// Every write here takes the wedding lock first and ends with assertWithinCap: held seats never pass the cap, whatever
// was edited. Removal of a guest is designated and is NOT here (consent/execute.ts).
import { randomUUID } from 'node:crypto';
import { openSecret, sealSecret } from '@/core/auth/secret-box';
import { inOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import type { Tx } from '@/core/db/rls';
import { env } from '@/core/env';
import { Refused } from '@/core/errors';
import { hashToken, newToken } from '@/core/tokens';
import { enqueue } from '@/modules/notifications/outbox';
import { logChange } from '../changelog';
import { requireWedding, todayOf, weddingDay, type WeddingRow } from '../context';
import { addDays, dbOfDay, diffDays, type Day } from '../days';
import { RSVP_TASK_KEY } from '../schedule/rsvp';
import { lockWedding } from '../schedule/store';
import { capState, lockoutRegrets, planRelease, RELEASE_TEXT, type CapState, type HouseholdIn, type ReleasePlan } from './backfill';
import { chasePlan, type ChasePlan } from './chase';
import type { ImportHousehold } from './csv';
import { costCents, deltaFor, headcount, type GuestFull, type Headcount, type Prices } from './headcount';
import { reminderText, type CheckedRsvp } from './projection';

type Ctx = { orgId: string; userId: string | null };
export const DEFAULT_MEALS = ['Chicken', 'Fish', 'Vegetarian'];
/** With no booked vendor asking for a count, RSVPs are due this many days plus the chase buffer before the wedding (D-44). */
export const DEFAULT_COUNT_DAYS = 14;

const PLAN_DEFAULTS = { cap: 100, venueMin: null as number | null, venueMax: null as number | null, perHeadCents: 0, kidsMealCents: 0, vendorMealCents: 0, lockoutDays: 42, minBatchSeats: 4, mealOptions: DEFAULT_MEALS };
export type Plan = typeof PLAN_DEFAULTS;

/** The guest plan, or its defaults when none was saved yet (reading never writes). */
export async function loadPlan(tx: Tx, ctx: { orgId: string }): Promise<Plan> {
  const p = await tx.guestPlan.findUnique({ where: { orgId: ctx.orgId } });
  return p ? { cap: p.cap, venueMin: p.venueMin, venueMax: p.venueMax, perHeadCents: p.perHeadCents, kidsMealCents: p.kidsMealCents, vendorMealCents: p.vendorMealCents, lockoutDays: p.lockoutDays, minBatchSeats: p.minBatchSeats, mealOptions: p.mealOptions.length ? p.mealOptions : DEFAULT_MEALS } : { ...PLAN_DEFAULTS };
}

export const loadHouseholds = (tx: Tx, ctx: { orgId: string }) => tx.household.findMany({ where: inOrg(ctx), include: { guests: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } }, orderBy: [{ priority: 'asc' }, { name: 'asc' }] });
export type HouseholdRow = Awaited<ReturnType<typeof loadHouseholds>>[number];

export const toIn = (h: HouseholdRow): HouseholdIn & { guests: GuestFull[] } => ({
  id: h.id, name: h.name, list: h.list, state: h.state, priority: h.priority, plusOneOverride: h.plusOneOverride,
  guests: h.guests.map((g) => ({ id: g.id, name: g.name, ageGroup: g.ageGroup, partnerStatus: g.partnerStatus, inWeddingParty: g.inWeddingParty, isPlusOne: g.isPlusOne, rsvp: g.rsvp, removed: !!g.removedAt, meal: g.meal, dietary: g.dietary, accessibility: g.accessibility, songRequest: g.songRequest })),
});

/** The RSVP-by date: the derived RSVP task's due date, or a default buffer when no vendor has asked for a count. Same for every household. */
export async function rsvpDeadline(tx: Tx, ctx: { orgId: string }, wedding: WeddingRow): Promise<Day> {
  const t = await tx.task.findUnique({ where: { orgId_key: { orgId: ctx.orgId, key: RSVP_TASK_KEY } }, select: { bufferDays: true } });
  return addDays(weddingDay(wedding), -(t?.bufferDays ?? DEFAULT_COUNT_DAYS + wedding.chaseBufferDays));
}

export type GuestState = { plan: Plan; rows: HouseholdRow[]; households: (HouseholdIn & { guests: GuestFull[] })[]; cap: CapState; count: Headcount; costCents: number; prices: Prices; onSiteVendors: number };

export async function loadGuestState(tx: Tx, ctx: { orgId: string }): Promise<GuestState> {
  const plan = await loadPlan(tx, ctx);
  const rows = await loadHouseholds(tx, ctx);
  const households = rows.map(toIn);
  const onSiteVendors = await tx.vendor.count({ where: { ...inOrg(ctx), status: 'booked', onSite: true } });
  const count = headcount(households, onSiteVendors);
  const prices = { perHeadCents: plan.perHeadCents, kidsMealCents: plan.kidsMealCents, vendorMealCents: plan.vendorMealCents };
  return { plan, rows, households, cap: capState(households, plan.cap), count, costCents: costCents(count, prices), prices, onSiteVendors };
}

/** The invariant of P0-4, checked after every write: held seats ≤ cap. Throwing rolls the write back. */
export async function assertWithinCap(tx: Tx, ctx: { orgId: string }, what: string): Promise<GuestState> {
  const s = await loadGuestState(tx, ctx);
  if (s.cap.held > s.plan.cap) throw new Refused(`${what} would hold ${s.cap.held} seats against a cap of ${s.plan.cap}. Raise the cap or free seats first.`);
  return s;
}

export async function savePlan(tx: Tx, ctx: Ctx, input: Plan) {
  await lockWedding(tx, ctx.orgId);
  if (input.venueMin !== null && input.venueMax !== null && input.venueMin > input.venueMax) throw new Refused('The venue minimum is above its maximum.');
  const before = await loadPlan(tx, ctx);
  const row = await tx.guestPlan.upsert({ where: { orgId: ctx.orgId }, create: { orgId: ctx.orgId, ...input }, update: input });
  await assertWithinCap(tx, ctx, 'That cap');
  await logChange(tx, ctx, 'guestplan', 'updated', row.id, 'Guest plan', before, input);
}

// ---- households and guests

export type HouseholdInput = { name: string; email: string; phone: string; address1: string; city: string; region: string; postal: string; list: 'A' | 'B'; priority: number };

export async function addHousehold(tx: Tx, ctx: Ctx, input: HouseholdInput) {
  await lockWedding(tx, ctx.orgId);
  if (await tx.household.findFirst({ where: { ...inOrg(ctx), name: input.name }, select: { id: true } })) throw new Refused(`There is already a household called ${input.name}.`);
  const h = await tx.household.create({ data: { orgId: ctx.orgId, ...input } });
  await logChange(tx, ctx, 'household', 'created', h.id, h.name, null, { name: h.name, list: h.list, priority: h.priority });
  return h;
}

export async function updateHousehold(tx: Tx, ctx: Ctx, id: string, input: HouseholdInput & { plusOneOverride: 'grant' | 'deny' | null; plusOneNote: string }) {
  await lockWedding(tx, ctx.orgId);
  const h = await tx.household.findFirstOrThrow({ where: { id, ...inOrg(ctx) } });
  if (input.name !== h.name && (await tx.household.findFirst({ where: { ...inOrg(ctx), name: input.name }, select: { id: true } }))) throw new Refused(`There is already a household called ${input.name}.`);
  if (h.state !== 'queued' && input.list !== h.list) throw new Refused('This household has already left the queue; its list can no longer change.');
  const after = await tx.household.update({ where: { id }, data: input });
  await assertWithinCap(tx, ctx, 'That change');
  // PRD P0-3: "per-household overrides logged" — the diff carries plusOneOverride and its note when they change.
  await logChange(tx, ctx, 'household', 'updated', id, after.name, pick(h), pick(after));
}
const pick = (h: { name: string; email: string; phone: string; address1: string; city: string; region: string; postal: string; list: string; priority: number; plusOneOverride: string | null; plusOneNote: string }) =>
  ({ name: h.name, email: h.email, phone: h.phone, address1: h.address1, city: h.city, region: h.region, postal: h.postal, list: h.list, priority: h.priority, plusOneOverride: h.plusOneOverride, plusOneNote: h.plusOneNote });

export type GuestInput = { name: string; ageGroup: 'adult' | 'child' | 'infant'; partnerStatus: 'none' | 'dating' | 'long_distance' | 'engaged' | 'married'; inWeddingParty: boolean };

export async function addGuest(tx: Tx, ctx: Ctx, householdId: string, input: GuestInput) {
  await lockWedding(tx, ctx.orgId);
  const h = await tx.household.findFirstOrThrow({ where: { id: householdId, ...inOrg(ctx) }, include: { guests: { select: { name: true, removedAt: true } } } });
  if (h.state === 'regrets') throw new Refused('This household was not invited; it cannot take new guests.');
  if (h.guests.some((g) => !g.removedAt && g.name.toLowerCase() === input.name.toLowerCase())) throw new Refused(`${input.name} is already in ${h.name}.`);
  const g = await tx.guest.create({ data: { orgId: ctx.orgId, householdId, ...input, dietary: [], accessibility: [] } });
  await assertWithinCap(tx, ctx, `Adding ${input.name}`);
  await logChange(tx, ctx, 'guest', 'created', g.id, `${g.name} (${h.name})`, null, { ...input });
  return g;
}

export async function updateGuest(tx: Tx, ctx: Ctx, id: string, input: GuestInput & { privateNote: string }) {
  await lockWedding(tx, ctx.orgId);
  const g = await tx.guest.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, include: { household: { select: { name: true } } } });
  if (g.removedAt) throw new Refused('That guest was removed.');
  await tx.guest.update({ where: { id }, data: input });
  await assertWithinCap(tx, ctx, 'That change');
  await logChange(tx, ctx, 'guest', 'updated', id, `${input.name} (${g.household.name})`, { name: g.name, ageGroup: g.ageGroup, partnerStatus: g.partnerStatus, inWeddingParty: g.inWeddingParty, privateNote: g.privateNote }, input);
}

// ---- responses (the couple on someone's behalf, or a guest through their link)

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * Applies a checked reply to one household: each person's answer, and a named plus-one. One HeadcountDelta row per
 * person whose attendance changed, with the cost before and after ("Linda declined: −$87.00"). `ctx.userId` is null
 * when the guest answered through their link.
 */
export async function applyRsvp(tx: Tx, ctx: Ctx, householdId: string, checked: Extract<CheckedRsvp, { ok: true }>): Promise<{ deltas: string[] }> {
  await lockWedding(tx, ctx.orgId);
  const h = await tx.household.findFirstOrThrow({ where: { id: householdId, ...inOrg(ctx) }, include: { guests: true } });
  if (h.state !== 'invited') throw new Refused('This household has not been invited yet.');
  const t = now();
  const deltas: string[] = [];
  let state = await loadGuestState(tx, ctx);
  const step = async (label: string, verb: string) => {
    const next = await loadGuestState(tx, ctx);
    if (next.count.attending !== state.count.attending || next.costCents !== state.costCents) {
      const d = deltaFor(label, verb, state.count, next.count, next.prices);
      await tx.headcountDelta.create({ data: { orgId: ctx.orgId, label: d.label, deltaSeats: d.deltaSeats, deltaCents: d.deltaCents, attendingAfter: next.count.attending, costAfterCents: next.costCents } });
      deltas.push(d.text);
    }
    state = next;
  };
  for (const r of checked.responses) {
    const g = h.guests.find((x) => x.id === r.guestId && !x.removedAt);
    if (!g) throw new Refused('That reply names someone who is not on this invitation.');
    const rsvp = r.attending ? 'attending' : 'declined';
    await tx.guest.update({ where: { id: g.id }, data: { rsvp, meal: r.meal, dietary: r.dietary, accessibility: r.accessibility, songRequest: r.songRequest, respondedAt: t } });
    await logChange(tx, ctx, 'guest', 'updated', g.id, `${g.name} (${h.name})`, { rsvp: g.rsvp, meal: g.meal, dietary: g.dietary, accessibility: g.accessibility, songRequest: g.songRequest }, { rsvp, meal: r.meal, dietary: r.dietary, accessibility: r.accessibility, songRequest: r.songRequest }, { via: ctx.userId ? 'couple' : 'rsvp-link' });
    if (g.rsvp !== rsvp) await step(firstName(g.name), r.attending ? 'accepted' : 'declined');
  }
  if (checked.plusOneName) {
    const p = await tx.guest.create({ data: { orgId: ctx.orgId, householdId, name: checked.plusOneName, isPlusOne: true, rsvp: 'attending', respondedAt: t, dietary: [], accessibility: [] } });
    await logChange(tx, ctx, 'guest', 'created', p.id, `${p.name} (${h.name})`, null, { name: p.name, isPlusOne: true, rsvp: 'attending' }, { via: ctx.userId ? 'couple' : 'rsvp-link' });
    await step(firstName(p.name), 'accepted');
  }
  await assertWithinCap(tx, ctx, 'That reply');
  return { deltas };
}

/** The couple sets one guest back to "no answer yet" (a mistaken entry). */
export async function clearRsvp(tx: Tx, ctx: Ctx, guestId: string) {
  await lockWedding(tx, ctx.orgId);
  const g = await tx.guest.findFirstOrThrow({ where: { id: guestId, ...inOrg(ctx) }, include: { household: { select: { name: true } } } });
  if (g.removedAt) throw new Refused('That guest was removed.');
  const before = await loadGuestState(tx, ctx);
  await tx.guest.update({ where: { id: guestId }, data: { rsvp: 'pending', meal: null, respondedAt: null } });
  const after = await assertWithinCap(tx, ctx, 'Re-opening that reply');
  if (after.count.attending !== before.count.attending) {
    const d = deltaFor(firstName(g.name), 'has not answered', before.count, after.count, after.prices);
    await tx.headcountDelta.create({ data: { orgId: ctx.orgId, label: d.label, deltaSeats: d.deltaSeats, deltaCents: d.deltaCents, attendingAfter: after.count.attending, costAfterCents: after.costCents } });
  }
  await logChange(tx, ctx, 'guest', 'updated', guestId, `${g.name} (${g.household.name})`, { rsvp: g.rsvp }, { rsvp: 'pending' });
}

// ---- RSVP links

/**
 * The household's RSVP link. Made once (32 random bytes) and reused. Stored two ways: its sha256, which is what a
 * guest's request is matched against, and a sealed copy (AES-GCM under AUTH_SECRET, D-46) so a reminder can carry the
 * same link. A sealed copy that can no longer be opened (AUTH_SECRET was rotated) is NOT replaced here: that would
 * end, without anyone deciding to, the link already printed on the invitations. The couple replaces it themselves
 * with replaceRsvpLink (review 2026-11-24, S3; D-59).
 */
export async function rsvpLink(tx: Tx, ctx: { orgId: string }, householdId: string): Promise<string> {
  const h = await tx.household.findFirstOrThrow({ where: { id: householdId, ...inOrg(ctx) }, select: { name: true, rsvpTokenHash: true, rsvpTokenSealed: true } });
  const existing = h.rsvpTokenSealed ? openSecret(h.rsvpTokenSealed, 'knotwork-rsvp') : null;
  if (existing) return `${env.APP_URL}/r/${existing}`;
  if (h.rsvpTokenHash) throw new Refused(`The saved RSVP link for ${h.name} can no longer be read. The link they were sent still works. To send a reminder or show a link, make a new link for them first; the old one will then stop working.`);
  return mint(tx, householdId);
}

async function mint(tx: Tx, householdId: string): Promise<string> {
  const token = newToken();
  await tx.household.update({ where: { id: householdId }, data: { rsvpTokenHash: hashToken(token), rsvpTokenSealed: sealSecret(token, 'knotwork-rsvp') } });
  return `${env.APP_URL}/r/${token}`;
}

/** Revokes the household's link and makes a new one: the old link is a 404 from this moment. Logged, without the token. */
export async function replaceRsvpLink(tx: Tx, ctx: Ctx, householdId: string): Promise<string> {
  await lockWedding(tx, ctx.orgId);
  const h = await tx.household.findFirstOrThrow({ where: { id: householdId, ...inOrg(ctx) }, select: { name: true, state: true } });
  if (h.state !== 'invited') throw new Refused('This household has not been invited yet, so it has no link.');
  const url = await mint(tx, householdId);
  await logChange(tx, ctx, 'household', 'relinked', householdId, h.name, null, { rsvpLink: 'replaced; the earlier link no longer works' });
  return url;
}

// ---- waves (P0-4)

export async function releaseRules(tx: Tx, ctx: { orgId: string }, list: 'A' | 'B') {
  const wedding = await requireWedding(tx, ctx);
  const plan = await loadPlan(tx, ctx);
  return { cap: plan.cap, list, lockoutDays: plan.lockoutDays, minBatchSeats: plan.minBatchSeats, daysToWedding: diffDays(weddingDay(wedding), todayOf(wedding)), today: todayOf(wedding) };
}

/** What a release of `list` would do right now. Reads only. */
export async function previewRelease(tx: Tx, ctx: { orgId: string }, list: 'A' | 'B'): Promise<{ plan: ReleasePlan; households: HouseholdIn[]; regrets: string[] }> {
  const households = (await loadHouseholds(tx, ctx)).map(toIn);
  const rules = await releaseRules(tx, ctx, list);
  return { plan: planRelease(households, rules), households, regrets: lockoutRegrets(households, rules) };
}

/** Inside the lockout, queued B households become regrets (PRD P0-4). Idempotent. Returns how many changed. */
export async function applyLockout(tx: Tx, ctx: Ctx): Promise<number> {
  await lockWedding(tx, ctx.orgId);
  const rows = await loadHouseholds(tx, ctx);
  const ids = lockoutRegrets(rows.map(toIn), await releaseRules(tx, ctx, 'B'));
  for (const id of ids) {
    const h = rows.find((r) => r.id === id)!;
    await tx.household.update({ where: { id }, data: { state: 'regrets' } });
    await logChange(tx, ctx, 'household', 'updated', id, h.name, { state: 'queued' }, { state: 'regrets' }, { why: 'inside the lockout' });
  }
  return ids.length;
}

/**
 * Wave promotion, atomic (PRD P0-4): under the wedding lock, plan the release from what is true NOW, invite exactly
 * those households, record the wave. Two releases at once cannot both spend the same free seats: the second one
 * plans after the first has committed.
 */
export async function releaseWave(tx: Tx, ctx: Ctx, list: 'A' | 'B'): Promise<{ number: number; households: number; seats: number }> {
  await lockWedding(tx, ctx.orgId);
  const rules = await releaseRules(tx, ctx, list);
  const rows = await loadHouseholds(tx, ctx);
  const ins = rows.map(toIn);
  const plan = planRelease(ins, rules);
  if (plan.reason !== 'ok') throw new Refused(RELEASE_TEXT[plan.reason]);
  const last = await tx.inviteWave.findFirst({ where: inOrg(ctx), orderBy: { number: 'desc' }, select: { number: true } });
  const wave = await tx.inviteWave.create({ data: { orgId: ctx.orgId, number: (last?.number ?? 0) + 1, list, releasedById: ctx.userId, householdCount: plan.ids.length, seatCount: plan.seats } });
  for (const id of plan.ids) {
    await tx.household.update({ where: { id }, data: { state: 'invited', invitedOn: dbOfDay(rules.today), waveId: wave.id } });
    await rsvpLink(tx, ctx, id);
  }
  await assertWithinCap(tx, ctx, 'That release');
  await logChange(tx, ctx, 'wave', 'created', wave.id, `Wave ${wave.number} (${list} list)`, null, { number: wave.number, list, households: plan.ids.length, seats: plan.seats });
  return { number: wave.number, households: plan.ids.length, seats: plan.seats };
}

// ---- import

/** Writes a parsed import: every household and guest, or (on any clash with what is already there) nothing. */
export async function importHouseholds(tx: Tx, ctx: Ctx, parsed: ImportHousehold[]): Promise<{ households: number; guests: number }> {
  await lockWedding(tx, ctx.orgId);
  const existing = new Set((await tx.household.findMany({ where: inOrg(ctx), select: { name: true } })).map((h) => h.name.toLowerCase()));
  const clash = parsed.filter((h) => existing.has(h.name.toLowerCase())).map((h) => h.name);
  if (clash.length) throw new Refused(`Already on the guest list: ${clash.slice(0, 5).join(', ')}${clash.length > 5 ? ` and ${clash.length - 5} more` : ''}. Nothing was imported.`);
  // Two statements for the whole file, not two per household: 2,000 rows must fit inside one transaction's time.
  const rows = parsed.map(({ guests: people, ...fields }) => ({ id: randomUUID(), fields, people }));
  await tx.household.createMany({ data: rows.map((r) => ({ id: r.id, orgId: ctx.orgId, ...r.fields })) });
  await tx.guest.createMany({ data: rows.flatMap((r) => r.people.map((g) => ({ orgId: ctx.orgId, householdId: r.id, ...g, dietary: [], accessibility: [] }))) });
  const guests = rows.reduce((n, r) => n + r.people.length, 0);
  await logChange(tx, ctx, 'household', 'imported', ctx.orgId, `${parsed.length} households`, null, { households: parsed.length, guests });
  return { households: parsed.length, guests };
}

// ---- chasing (P0-3)

export type ChaseView = { deadline: Day; daysLeft: number; plan: ChasePlan; nonResponders: { id: string; name: string; email: string; phone: string; pending: string[]; remindersSent: number[]; called: boolean }[] };

export async function loadChase(tx: Tx, ctx: { orgId: string }): Promise<ChaseView> {
  const wedding = await requireWedding(tx, ctx);
  const deadline = await rsvpDeadline(tx, ctx, wedding);
  const rows = await tx.household.findMany({ where: { ...inOrg(ctx), state: 'invited' }, include: { guests: { where: { removedAt: null, rsvp: 'pending' }, select: { name: true } }, chaseEvents: true }, orderBy: { name: 'asc' } });
  const nonResponders = rows.filter((h) => h.guests.length).map((h) => ({
    id: h.id, name: h.name, email: h.email, phone: h.phone, pending: h.guests.map((g) => g.name),
    remindersSent: h.chaseEvents.filter((e) => e.kind === 'reminder').map((e) => e.step), called: h.chaseEvents.some((e) => e.kind === 'call'),
  }));
  const daysLeft = diffDays(deadline, todayOf(wedding));
  return { deadline, daysLeft, nonResponders, plan: chasePlan(nonResponders.map((h) => ({ id: h.id, hasEmail: !!h.email, remindersSent: h.remindersSent, called: h.called })), daysLeft) };
}

/** Enqueues every reminder that is due (outbox: captured, never really sent in this project) and records the step. */
export async function sendDueReminders(tx: Tx, ctx: Ctx): Promise<number> {
  await lockWedding(tx, ctx.orgId);
  const wedding = await requireWedding(tx, ctx);
  const chase = await loadChase(tx, ctx);
  for (const r of chase.plan.remind) {
    const h = chase.nonResponders.find((x) => x.id === r.id)!;
    const text = reminderText({ householdName: h.name, weddingTitle: wedding.title, rsvpBy: chase.deadline, url: await rsvpLink(tx, ctx, h.id), step: r.step });
    await enqueue({ channel: 'email', to: h.email, template: 'notice', data: text, orgId: ctx.orgId }, tx);
    await tx.chaseEvent.create({ data: { orgId: ctx.orgId, householdId: h.id, kind: 'reminder', step: r.step, byId: ctx.userId } });
  }
  if (chase.plan.remind.length) await logChange(tx, ctx, 'household', 'reminded', ctx.orgId, `${chase.plan.remind.length} households`, null, { households: chase.plan.remind.length, step: chase.plan.remind[0]!.step });
  return chase.plan.remind.length;
}

export async function markCalled(tx: Tx, ctx: Ctx, householdId: string) {
  const h = await tx.household.findFirstOrThrow({ where: { id: householdId, ...inOrg(ctx) }, select: { name: true } });
  if (await tx.chaseEvent.findFirst({ where: { householdId, kind: 'call' }, select: { id: true } })) throw new Refused('That household is already marked as called.');
  await tx.chaseEvent.create({ data: { orgId: ctx.orgId, householdId, kind: 'call', step: 0, byId: ctx.userId } });
  await logChange(tx, ctx, 'household', 'called', householdId, h.name, null, { called: true });
}

