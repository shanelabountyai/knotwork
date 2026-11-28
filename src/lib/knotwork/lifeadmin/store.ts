// Phase 5, life-admin mode in the database: recurring household tasks (a rule and a done-on log) and the couple's
// home page after the wedding. A store. RULE 1: nothing here stores when a task is due; recurrence.ts works it out on
// every read from the rule, the done days (dates of fact) and Wedding.date. Every write logs in its transaction.
// The home page's other sections come from the engines that own them (thank-yous, the name change, the photo album);
// the contract documents come through secrecy/views.ts (documentsView), so a private vendor's never show (ADR-001).
import { inOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { allows, type Who } from '../access';
import { logChange } from '../changelog';
import { dayOfDb, dbOfDay, isRealDay, type Day } from '../days';
import { nameChangeView } from '../namechange/store';
import { loadEvents } from '../photos/store';
import { ledger } from '../thanks/aging';
import { loadObligations } from '../thanks/store';
import { nextAnniversary, nextDue, ruleText, validRule, type Rule, type Unit } from './recurrence';

type Ctx = { orgId: string; userId: string };
export type TaskInput = { title: string; unit: Unit; every: number; notes: string };

const ONE_LINE = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u;
/** The rule as stored: the anniversary comes once a year whatever was typed. Refuses a title or a rule out of bounds. */
function checked(i: TaskInput): TaskInput {
  if (i.title.length < 1 || i.title.length > 120 || !ONE_LINE.test(i.title)) throw new Refused('Give the task a title: one line, 120 characters or fewer.');
  const every = i.unit === 'anniversary' ? 1 : i.every;
  if (!validRule({ unit: i.unit, every })) throw new Refused('How often: every 1 to 365 days, 1 to 52 weeks, 1 to 24 months, or yearly on the anniversary.');
  return { ...i, every };
}

export async function addRecurring(tx: Tx, ctx: Ctx, input: TaskInput) {
  const i = checked(input);
  const row = await tx.recurringTask.create({ data: { orgId: ctx.orgId, title: i.title, unit: i.unit, every: i.every, notes: i.notes, createdById: ctx.userId } });
  await logChange(tx, ctx, 'recurring', 'created', row.id, row.title, null, { title: i.title, rule: ruleText(i) });
  return row;
}

export async function updateRecurring(tx: Tx, ctx: Ctx, id: string, input: TaskInput) {
  const i = checked(input);
  const t = await tx.recurringTask.findFirstOrThrow({ where: { id, ...inOrg(ctx) } });
  await tx.recurringTask.update({ where: { id }, data: { title: i.title, unit: i.unit, every: i.every, notes: i.notes } });
  await logChange(tx, ctx, 'recurring', 'updated', id, i.title, { title: t.title, rule: ruleText(t), notes: t.notes }, { title: i.title, rule: ruleText(i), notes: i.notes });
}

/** Logged first, while the row is still there; its done days go with it. */
export async function removeRecurring(tx: Tx, ctx: Ctx, id: string) {
  const t = await tx.recurringTask.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, include: { _count: { select: { done: true } } } });
  await logChange(tx, ctx, 'recurring', 'deleted', id, t.title, { title: t.title, rule: ruleText(t), doneDays: t._count.done }, null);
  await tx.recurringTask.delete({ where: { id } });
}

/**
 * A day it was done: a date of fact, so never after today and never before the wedding (life-admin mode begins after
 * it). Once per day; a second tick on the same day is refused, not doubled.
 */
export async function markDone(tx: Tx, ctx: Ctx, id: string, on: Day, bounds: { today: Day; wedding: Day }) {
  if (!isRealDay(on)) throw new Refused('Pick a real date.');
  if (on > bounds.today) throw new Refused('That day has not come yet. Mark it done on the day, or after.');
  if (on < bounds.wedding) throw new Refused('Household tasks start from the wedding day. Pick that day or a later one.');
  const t = await tx.recurringTask.findFirstOrThrow({ where: { id, ...inOrg(ctx) } });
  if (await tx.recurringDone.findUnique({ where: { taskId_doneOn: { taskId: id, doneOn: dbOfDay(on) } }, select: { id: true } })) throw new Refused('That day is already marked done.');
  await tx.recurringDone.create({ data: { orgId: ctx.orgId, taskId: id, doneOn: dbOfDay(on), byId: ctx.userId } });
  await logChange(tx, ctx, 'recurring', 'done', id, t.title, null, { doneOn: on });
}

/** A day ticked by mistake comes off the log (the change log keeps that it was there). */
export async function undoDone(tx: Tx, ctx: Ctx, id: string, on: Day) {
  if (!isRealDay(on)) throw new Refused('Pick the day to take off.');
  const t = await tx.recurringTask.findFirstOrThrow({ where: { id, ...inOrg(ctx) } });
  const d = await tx.recurringDone.findUnique({ where: { taskId_doneOn: { taskId: id, doneOn: dbOfDay(on) } }, select: { id: true } });
  if (!d) throw new Refused('That day is not marked done.');
  await logChange(tx, ctx, 'recurring', 'undone', id, t.title, { doneOn: on }, null);
  await tx.recurringDone.delete({ where: { id: d.id } });
}

/** Each task with when it is next due (computed now), most pressing first, and its latest done days. */
export async function householdTasks(tx: Tx, ctx: { orgId: string }, v: { date: Day; today: Day }) {
  const rows = await tx.recurringTask.findMany({ where: inOrg(ctx), include: { done: { select: { doneOn: true }, orderBy: { doneOn: 'desc' } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return rows
    .map((t) => {
      const rule: Rule = { unit: t.unit, every: t.every };
      const days = t.done.map((x) => dayOfDb(x.doneOn));
      return { id: t.id, title: t.title, notes: t.notes, rule, ruleText: ruleText(rule), recent: days.slice(0, 5), doneCount: days.length, ...nextDue(rule, v.date, days, v.today) };
    })
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.title.localeCompare(b.title)));
}

/**
 * The couple's home page in life-admin mode: the next anniversary for everyone, and each other section only for whom
 * its capability reaches (a helper keeps only the album, if they moderate it: D-147). Nothing is stored.
 */
export async function lifeDashboard(tx: Tx, ctx: Ctx, v: { who: Who; date: Day; today: Day; partners: string[] }) {
  // One at a time: these share the transaction's single connection.
  const anniversary = nextAnniversary(v.date, v.today);
  const household = allows(v.who, 'life.view') ? await householdTasks(tx, ctx, v) : null;
  const thanks = allows(v.who, 'gifts.view') ? ledger(await loadObligations(tx, ctx), v.today) : null;
  const nameChange = allows(v.who, 'namechange.own') ? await nameChangeView(tx, ctx, v) : null;
  const albums = allows(v.who, 'photos.view') ? (await loadEvents(tx, ctx)).map((e) => ({ id: e.id, name: e.name, live: e.counts.live })) : null;
  return { anniversary, household, thanks, nameChange, albums };
}

/** Requests waiting for this partner's approval (the nav's count). */
export const waitingFor = (tx: Tx, ctx: Ctx) => tx.consentRequest.count({ where: { ...inOrg(ctx), status: 'pending', expiresAt: { gt: now() }, proposerId: { not: ctx.userId } } });
