// P1-1 (ADR-001): what each signed-in page shows of tasks, expenses, vendors and budget categories, already passed
// through the lens for the person looking. A store. Every page and route under src/app/o/[org] that lists or shows
// one of those reads it from here, never from the tables (tests/knotwork/structure.test.ts holds that list), so the
// other partner's view and every helper's view go through `lens` and nowhere else.
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { now } from '@/core/clock';
import type { Tx } from '@/core/db/rls';
import { canSeeEntity, type Who } from '../access';
import { loadBudget } from '../budget-store';
import { changeLog } from '../changelog';
import { parseAction } from '../changelog-diff';
import type { WeddingRow } from '../context';
import { dayOfDb, type Day } from '../days';
import { fundingByCategory } from '../funding/store';
import { loadSchedule, previewDateMove } from '../schedule/store';
import { listAttachments, readAttachment } from '../vendors/attachments';
import type { World } from '../contingency/preview';
import type { Seen } from './compartment';
import { lens, type Hidden, type Lensed } from './lens';
import { compartmentsOf, seenOf } from './seal';

/** What every page already has (view.ts): who, the wedding, today, the wedding day and the partners. */
type V = { who: Who; wedding: WeddingRow; today: Day; date: Day; partners: string[] };
export const seenFor = (ctx: { userId: string }, v: V): Seen => ({ viewerId: ctx.userId, partners: v.partners, weddingDay: v.date, today: v.today });
const C = { privateToId: true, revealDays: true } as const;

// ---- the schedule (and the home page's counts) ------------------------------------------------------------------------

export async function scheduleView(tx: Tx, ctx: OrgCtx, v: V) {
  const { rows, schedule } = await loadSchedule(tx, ctx, v.wedding);
  const L = lens(seenFor(ctx, v));
  const titles = L.titles(rows);
  const critical = new Set(schedule.criticalPath);
  const lines = rows.map((t) => {
    const lensed = L.task(t);
    const dates = schedule.tasks[t.id]!;
    // A hidden task keeps its derived dates and state (they are the wedding's, not the secret's) and loses everything
    // else, including which tasks it waits for and whether it is on the critical path.
    return lensed.hidden
      ? { ...lensed, dates }
      : { ...lensed, dates, critical: critical.has(t.id), after: t.dependsOn.map((d) => titles.get(d.dependsOnId)!) };
  });
  return {
    lines: lines.sort((a, b) => (a.dates.startBy < b.dates.startBy ? -1 : a.dates.startBy > b.dates.startBy ? 1 : (a.hidden ? 1 : 0) - (b.hidden ? 1 : 0) || (!a.hidden && !b.hidden ? a.row.title.localeCompare(b.row.title) : 0))),
    criticalPath: schedule.criticalPath.map((id) => titles.get(id)!),
    runwayDays: schedule.runwayDays,
    marginDays: schedule.marginDays,
    /** The tasks this viewer may pick as "comes after" (a hidden one is not offered). */
    options: rows.filter((t) => !L.task(t).hidden).map((t) => ({ id: t.id, title: t.title })),
  };
}

/** The home page: counts (a hidden task counts, unnamed), what waits for this partner, and the open vendor flags. */
export async function overviewView(tx: Tx, ctx: OrgCtx, v: V, withFlags: boolean) {
  const { schedule, plan } = await loadSchedule(tx, ctx, v.wedding);
  const states = Object.values(schedule.tasks);
  const waiting = await tx.consentRequest.count({ where: { ...inOrg(ctx), status: 'pending', expiresAt: { gt: now() }, proposerId: { not: ctx.userId } } });
  const flags = withFlags ? await flagsView(tx, ctx, v, true) : [];
  return {
    open: plan.filter((t) => !t.done).length, late: states.filter((t) => t.state === 'late').length, impossible: states.filter((t) => t.state === 'impossible').length,
    marginDays: schedule.marginDays, waiting, flags,
  };
}

/** A date-move preview with hidden task titles replaced (the date page and the approvals page). */
export async function movePreview(tx: Tx, ctx: OrgCtx, v: V, to: Day) {
  const p = await previewDateMove(tx, ctx, v.wedding, to);
  const { rows } = await loadSchedule(tx, ctx, v.wedding);
  return { ...p, plan: lens(seenFor(ctx, v)).plan(p.plan, rows) };
}

// ---- the budget --------------------------------------------------------------------------------------------------------

export async function budgetView(tx: Tx, ctx: OrgCtx, v: V) {
  const L = lens(seenFor(ctx, v));
  const budget = await loadBudget(tx, ctx); // every figure, hidden ones included: the totals are the real totals
  const categories = await tx.budgetCategory.findMany({ where: inOrg(ctx), select: { id: true, name: true, ...C } });
  const byId = new Map(categories.map((c) => [c.id, c]));
  const funding = await fundingByCategory(tx, ctx);
  const lines = budget.lines.map((l) => L.category({ ...l, ...byId.get(l.id)!, funding: funding.get(l.id) ?? [] }));
  const expenses = await tx.expense.findMany({
    where: inOrg(ctx), include: { category: { select: { name: true, ...C } }, vendor: { select: { name: true, ...C } } }, orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }], take: 100,
  });
  const vendors = await tx.vendor.findMany({ where: inOrg(ctx), select: { id: true, name: true, ...C }, orderBy: { name: 'asc' } });
  const snapshots = await tx.budgetSnapshot.findMany({ where: inOrg(ctx), orderBy: { takenAt: 'desc' }, take: 20 });
  return {
    totals: { estimateCents: budget.estimateCents, actualCents: budget.actualCents, remainingCents: budget.remainingCents, over: budget.over },
    lines: [...lines.filter((l) => !l.hidden), ...lines.filter((l) => l.hidden)],
    expenses: expenses.map((e) => L.expense(e)),
    snapshots: snapshots.map((s) => ({ id: s.id, takenAt: s.takenAt, note: s.note, totals: s.totals as { estimateCents: number; actualCents: number } })),
    /** What this viewer may pick in a form. */
    categoryOptions: categories.filter((c) => !L.category(c).hidden).map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
    vendorOptions: vendors.filter((x) => !L.vendor(x).hidden).map((x) => ({ id: x.id, name: x.name })),
    expenseOptions: expenses.filter((e) => !L.expense(e).hidden).map((e) => ({ id: e.id, categoryId: e.categoryId, label: `${dayOfDb(e.paidOn)} ${e.description} (${e.category.name})`, amountCents: e.amountCents })),
  };
}

// ---- vendors -----------------------------------------------------------------------------------------------------------

export async function vendorsView(tx: Tx, ctx: OrgCtx, v: V) {
  const L = lens(seenFor(ctx, v));
  const rows = await tx.vendor.findMany({ where: inOrg(ctx), include: { flags: { where: { ackAt: null }, select: { id: true } } }, orderBy: { name: 'asc' } });
  const out = rows.map((x) => L.vendor(x));
  return [...out.filter((x) => !x.hidden), ...out.filter((x) => x.hidden)];
}

/** One vendor's page, or null when it does not exist in this workspace OR is hidden from this viewer (a 404 either way). */
export async function vendorView(tx: Tx, ctx: OrgCtx, v: V, id: string) {
  const L = lens(seenFor(ctx, v));
  const x = await tx.vendor.findFirst({ where: { id, ...inOrg(ctx) }, include: { payments: { orderBy: { dueDaysBefore: 'desc' } }, flags: { where: { ackAt: null }, orderBy: { raisedAt: 'asc' } }, briefs: { orderBy: { version: 'desc' }, take: 1 } } });
  if (!x) return null;
  const seen = L.vendor(x);
  if (seen.hidden) return null;
  const categories = await tx.budgetCategory.findMany({ where: inOrg(ctx), select: { id: true, name: true, ...C }, orderBy: { name: 'asc' } });
  return { vendor: seen.row, mine: seen.mine, categories: categories.filter((c) => !L.category(c).hidden).map((c) => ({ id: c.id, name: c.name })), attachments: await listAttachments(tx, ctx, id) };
}

/** One attachment's bytes for the image route: null when missing or when its vendor is hidden from the viewer. */
export async function attachmentFile(tx: Tx, ctx: OrgCtx, v: { userId: string }, vendorId: string, id: string) {
  if (!(await vendorVisible(tx, ctx, v.userId, vendorId))) return null;
  return readAttachment(tx, ctx, vendorId, id);
}

/** For routes that have no View: may this person see this vendor? (Missing is false.) */
export async function vendorVisible(tx: Tx, ctx: { orgId: string }, userId: string, vendorId: string): Promise<boolean> {
  const x = await tx.vendor.findFirst({ where: { id: vendorId, ...inOrg(ctx) }, select: C });
  if (!x) return false;
  if (!x.privateToId) return true;
  const s = await seenOf(tx, ctx.orgId, userId);
  return !s || !lens(s).vendor(x).hidden;
}

/** Vendor flags, newest first (or only the open ones, oldest first, for the home page). */
export async function flagsView(tx: Tx, ctx: OrgCtx, v: V, openOnly = false) {
  const L = lens(seenFor(ctx, v));
  const flags = await tx.vendorFlag.findMany({ where: { ...inOrg(ctx), ...(openOnly && { ackAt: null }) }, include: { vendor: { select: { id: true, name: true, ...C } } }, orderBy: { raisedAt: openOnly ? 'asc' : 'desc' }, take: 200 });
  return flags.map((f) => L.ofVendor(f, f.vendor));
}

// ---- the activity feed -------------------------------------------------------------------------------------------------

export type ActivityLine = { id: string; at: Date; actorUserId: string | null; entity: string; text: string; label: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; masked: boolean };

/**
 * The change log for this viewer: only entities inside their grants (access.ts), and an entry about a hidden item
 * shows who and when only. Entries written while the item was sealed were stored masked already (changelog.ts).
 */
export async function activityView(tx: Tx, ctx: OrgCtx, v: V, take = 200): Promise<ActivityLine[]> {
  const L = lens(seenFor(ctx, v));
  const events = (await changeLog(tx, ctx.orgId, take)).flatMap((e) => {
    const a = parseAction(e.action);
    return a && canSeeEntity(v.who, a.entity) ? [{ e, a }] : [];
  });
  const byEntity = new Map<string, string[]>();
  for (const { e, a } of events) if (e.targetId) byEntity.set(a.entity, [...(byEntity.get(a.entity) ?? []), e.targetId]);
  const cs = new Map<string, Awaited<ReturnType<typeof compartmentsOf>>>();
  for (const [entity, ids] of byEntity) cs.set(entity, await compartmentsOf(tx, ctx.orgId, entity, ids));
  return events.map(({ e, a }) => {
    const shown = L.entry((e.data ?? {}) as Parameters<typeof L.entry>[0], (e.targetId && cs.get(a.entity)?.get(e.targetId)) || []);
    return { id: String(e.id), at: e.at, actorUserId: e.actorUserId, entity: a.entity, text: a.text, ...shown };
  });
}

export type { Hidden, Lensed };

// ---- funding (P1-2) ----------------------------------------------------------------------------------------------------

/** What the funding page's forms may offer this editor: categories and spends they can see. */
export async function fundingOptions(tx: Tx, ctx: OrgCtx, v: V) {
  const L = lens(seenFor(ctx, v));
  const categories = await tx.budgetCategory.findMany({ where: inOrg(ctx), select: { id: true, name: true, ...C }, orderBy: { name: 'asc' } });
  const expenses = await tx.expense.findMany({ where: inOrg(ctx), include: { category: { select: { name: true, ...C } }, vendor: { select: C } }, orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }], take: 200 });
  return {
    categories: categories.filter((c) => !L.category(c).hidden).map((c) => ({ id: c.id, name: c.name })),
    expenses: expenses.filter((e) => !L.expense(e).hidden).map((e) => ({ id: e.id, categoryId: e.categoryId, label: `${e.description} (${e.category.name}, ${dayOfDb(e.paidOn)})`, amountCents: e.amountCents })),
  };
}

// ---- contingency plans (P1-6) ------------------------------------------------------------------------------------------

/**
 * What previewing or executing a branch may draw on, for the person doing it: the plan as it is (for the new tasks'
 * dates; titles of hidden tasks are replaced), the booked vendors they may see (booked vendors are never private,
 * and the lens is applied anyway), and the budget categories they may see, each marked when it is private to them.
 * Takes a Seen rather than a View so the execute action, which has no page, builds it the same way.
 */
export async function contingencyWorld(tx: Tx, ctx: { orgId: string }, wedding: WeddingRow, s: Seen): Promise<World> {
  const L = lens(s);
  const { rows, plan } = await loadSchedule(tx, ctx, wedding);
  const vendors = (await tx.vendor.findMany({ where: inOrg(ctx), select: { id: true, name: true, category: true, phone: true, email: true, status: true, ...C }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }))
    .filter((x) => x.status === 'booked' && !L.vendor(x).hidden);
  const categories = await tx.budgetCategory.findMany({ where: inOrg(ctx), select: { id: true, name: true, ...C }, orderBy: { name: 'asc' } });
  return {
    weddingDay: s.weddingDay, today: s.today, plan: L.plan(plan, rows), thresholdCents: wedding.spendThresholdCents,
    vendors: vendors.map((x) => ({ id: x.id, name: x.name, category: x.category, phone: x.phone, email: x.email })),
    categories: categories.flatMap((c) => {
      const seen = L.category(c);
      return seen.hidden ? [] : [{ id: c.id, name: c.name, sealed: seen.mine !== null }];
    }),
  };
}
