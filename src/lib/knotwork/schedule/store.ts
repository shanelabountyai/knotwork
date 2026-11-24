// The schedule in the database: loading the plan, creating a wedding from the template, and the atomic date move.
import { inOrg } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import type { Prisma } from '@/generated/prisma/client';
import { logChange } from '../changelog';
import { requireWedding, todayOf, weddingDay, type WeddingRow } from '../context';
import { dbOfDay, showDay, type Day } from '../days';
import { nobodyLens } from '../secrecy/seal';
import { flagsForDateMove } from '../vendors/scope';
import { computeSchedule, previewMove, validatePlan, type Invalid, type MovePreview, type PlanTask, type Schedule } from './engine';
import { RSVP_TASK_KEY, rsvpBufferDays } from './rsvp';
import { DEFAULT_TEMPLATE } from './template';

type Ctx = { orgId: string; userId: string | null };

export const loadTasks = (tx: Tx, ctx: { orgId: string }) =>
  tx.task.findMany({ where: inOrg(ctx), include: { dependsOn: { select: { dependsOnId: true } }, payment: { select: { id: true, vendorId: true, amountCents: true, paidOn: true } }, vendor: { select: { privateToId: true, revealDays: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
export type TaskRow = Awaited<ReturnType<typeof loadTasks>>[number];

export const toPlan = (rows: readonly TaskRow[]): PlanTask[] =>
  rows.map((t) => ({ id: t.id, title: t.title, leadDays: t.leadDays, bufferDays: t.bufferDays, dependsOn: t.dependsOn.map((d) => d.dependsOnId).sort(), done: t.status === 'done' }));

const INVALID_TEXT: Record<Invalid['kind'], string> = {
  cycle: 'That would make tasks depend on each other in a circle',
  'missing-dependency': 'A task depends on one that does not exist',
  'duplicate-id': 'Two tasks have the same id',
  'negative-days': 'Days must be whole numbers, zero or more',
};

/** Refuses a plan the engine cannot schedule, naming the tasks. Called before any write to a task or a dependency. */
export function assertValidPlan(plan: PlanTask[]) {
  const bad = validatePlan(plan);
  if (!bad) return;
  const titles = bad.ids.map((id) => plan.find((t) => t.id === id)?.title ?? id).join(', ');
  throw new Refused(`${INVALID_TEXT[bad.kind]}: ${titles}.`);
}

/** The plan and its schedule as of today. */
export async function loadSchedule(tx: Tx, ctx: { orgId: string }, wedding: WeddingRow) {
  const rows = await loadTasks(tx, ctx);
  const plan = toPlan(rows);
  const schedule = computeSchedule(plan, weddingDay(wedding), todayOf(wedding)) as Extract<Schedule, { invalid: null }>;
  if (schedule.invalid) throw new Error('stored plan is invalid'); // every write goes through assertValidPlan
  return { rows, plan, schedule };
}

/** Serialises every date move and every plan edit of one wedding. */
export async function lockWedding(tx: Tx, orgId: string) {
  await tx.$queryRaw`SELECT 1 FROM "Wedding" WHERE "orgId" = ${orgId}::uuid FOR UPDATE`;
}

/** A new wedding: the row, the default template's tasks and dependencies, and the first baseline (D-11: one key). */
export async function createWedding(tx: Tx, ctx: Ctx, input: { title: string; date: Day; timeZone: string }) {
  const wedding = await tx.wedding.create({ data: { orgId: ctx.orgId, title: input.title, date: dbOfDay(input.date), timeZone: input.timeZone, createdById: ctx.userId } });
  const ids = new Map<string, string>();
  for (const t of DEFAULT_TEMPLATE) {
    const row = await tx.task.create({ data: { orgId: ctx.orgId, key: t.key, title: t.title, kind: 'template', leadDays: t.leadDays, bufferDays: t.bufferDays } });
    ids.set(t.key, row.id);
  }
  await tx.taskDependency.createMany({ data: DEFAULT_TEMPLATE.flatMap((t) => t.dependsOn.map((d) => ({ orgId: ctx.orgId, taskId: ids.get(t.key)!, dependsOnId: ids.get(d)! }))) });
  const { plan, schedule } = await loadSchedule(tx, ctx, wedding);
  const snapshot = { tasks: Object.fromEntries(plan.map((t) => [t.id, { title: t.title, dueTo: schedule.tasks[t.id]!.due, startByTo: schedule.tasks[t.id]!.startBy, state: schedule.tasks[t.id]!.state }])) };
  const baseline = await tx.scheduleBaseline.create({ data: { orgId: ctx.orgId, kind: 'initial', toDate: wedding.date, snapshot, fingerprint: 'initial', createdById: ctx.userId } });
  await logChange(tx, ctx, 'wedding', 'created', wedding.id, input.title, null, { title: input.title, date: input.date, timeZone: input.timeZone, tasksFromTemplate: DEFAULT_TEMPLATE.length });
  await logChange(tx, ctx, 'baseline', 'created', baseline.id, `First plan for ${showDay(input.date)}`, null, { date: input.date, tasks: plan.length });
  return wedding;
}

/** What moving the wedding to `to` would do, as of today. Reads only. */
export async function previewDateMove(tx: Tx, ctx: { orgId: string }, wedding: WeddingRow, to: Day): Promise<{ preview: MovePreview; plan: PlanTask[]; from: Day }> {
  const plan = toPlan(await loadTasks(tx, ctx));
  const from = weddingDay(wedding);
  return { preview: previewMove(plan, from, to, todayOf(wedding)), plan, from };
}

/**
 * The atomic date move (PRD P0-1). Called ONLY by consent/execute.ts, inside the approval's transaction, with the
 * fingerprint the approver saw. Under the wedding lock: recompute the preview; refuse if it is not the one that was
 * shown; set the date; write the baseline; flag every booked vendor; log all of it. Any throw undoes everything.
 */
export async function commitMove(tx: Tx, ctx: Ctx, input: { to: Day; fingerprint: string; requestId: string }): Promise<MovePreview> {
  await lockWedding(tx, ctx.orgId);
  const wedding = await requireWedding(tx, ctx);
  const { preview, plan, from } = await previewDateMove(tx, ctx, wedding, input.to);
  if (from === input.to) throw new Refused('The wedding is already on that date.');
  if (preview.fingerprint !== input.fingerprint) throw new Refused('The plan changed since this preview was made. Look at the new preview, then approve again.');
  const before = computeSchedule(plan, from, todayOf(wedding));
  await tx.wedding.update({ where: { orgId: ctx.orgId }, data: { date: dbOfDay(input.to), dateRequestId: input.requestId } });
  // The baseline is shared and exported: a task that is private right now is stored as "Private task" (ADR-001).
  const titles = (await nobodyLens(tx, ctx.orgId))?.titles(await loadTasks(tx, ctx));
  const snapshot = {
    tasks: Object.fromEntries(plan.map((t) => [t.id, { title: titles?.get(t.id) ?? t.title, dueFrom: before.tasks![t.id]!.due, dueTo: preview.tasks[t.id]!.due, startByFrom: before.tasks![t.id]!.startBy, startByTo: preview.tasks[t.id]!.startBy, state: preview.tasks[t.id]!.state }])),
    late: preview.late,
    impossible: preview.impossible,
    resolved: preview.resolved,
  } as Prisma.InputJsonObject;
  const baseline = await tx.scheduleBaseline.create({ data: { orgId: ctx.orgId, kind: 'move', fromDate: wedding.date, toDate: dbOfDay(input.to), requestId: input.requestId, snapshot, fingerprint: preview.fingerprint, createdById: ctx.userId } });
  await logChange(tx, ctx, 'wedding', 'moved', wedding.id, wedding.title, { date: from }, { date: input.to }, { deltaDays: preview.deltaDays, shifted: plan.filter((t) => !t.done).length, late: preview.late.length, impossible: preview.impossible.length });
  await logChange(tx, ctx, 'baseline', 'created', baseline.id, `Re-baselined to ${showDay(input.to)}`, null, { from, to: input.to, tasks: plan.length });
  const vendors = await tx.vendor.findMany({ where: inOrg(ctx), select: { id: true, status: true, name: true }, orderBy: { createdAt: 'asc' } });
  for (const f of flagsForDateMove(vendors, from, input.to)) {
    const flag = await tx.vendorFlag.create({ data: { orgId: ctx.orgId, vendorId: f.vendorId, reason: f.reason, detail: f.detail as Prisma.InputJsonObject, raisedById: ctx.userId } });
    await logChange(tx, ctx, 'flag', 'raised', flag.id, vendors.find((v) => v.id === f.vendorId)!.name, null, { reason: f.reason, from, to: input.to });
  }
  return preview;
}

/**
 * Keeps the derived RSVP-deadline task in step with the booked vendors' count deadlines and the chase buffer
 * (PRD P0-1, D-22). Creates it, moves it, or removes it when no booked vendor asks for a count. Returns what it did.
 */
export async function syncRsvpTask(tx: Tx, ctx: Ctx): Promise<'created' | 'updated' | 'removed' | 'unchanged'> {
  const wedding = await requireWedding(tx, ctx);
  const vendors = await tx.vendor.findMany({ where: { ...inOrg(ctx), status: 'booked' }, select: { countDueDaysBefore: true } });
  const buffer = rsvpBufferDays(vendors.map((v) => v.countDueDaysBefore), wedding.chaseBufferDays);
  const existing = await tx.task.findUnique({ where: { orgId_key: { orgId: ctx.orgId, key: RSVP_TASK_KEY } } });
  if (buffer === null) {
    if (!existing) return 'unchanged';
    await tx.task.delete({ where: { id: existing.id } });
    await logChange(tx, ctx, 'task', 'deleted', existing.id, existing.title, { bufferDays: existing.bufferDays }, null, { why: 'no booked vendor asks for a count' });
    return 'removed';
  }
  if (!existing) {
    const t = await tx.task.create({ data: { orgId: ctx.orgId, key: RSVP_TASK_KEY, title: 'RSVP deadline', kind: 'rsvp', leadDays: 0, bufferDays: buffer, notes: 'Derived: the earliest vendor count deadline, minus the chase buffer.' } });
    await logChange(tx, ctx, 'task', 'created', t.id, t.title, null, { kind: 'rsvp', leadDays: 0, bufferDays: buffer });
    return 'created';
  }
  if (existing.bufferDays === buffer) return 'unchanged';
  await tx.task.update({ where: { id: existing.id }, data: { bufferDays: buffer } });
  await logChange(tx, ctx, 'task', 'updated', existing.id, existing.title, { bufferDays: existing.bufferDays }, { bufferDays: buffer });
  return 'updated';
}
