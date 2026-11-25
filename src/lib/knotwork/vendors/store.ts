// Vendor writes that are NOT designated: contact and scope edits (which may raise a re-confirmation flag), scheduled
// payments (each one a task on the schedule), flag acknowledgement and brief generation.
import { inOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import type { Prisma } from '@/generated/prisma/client';
import { logChange } from '../changelog';
import { requireWedding, weddingDay } from '../context';
import { addDays, dayOfDb, showDay } from '../days';
import { loadSchedule, syncRsvpTask } from '../schedule/store';
import { rollups } from '../guests/headcount';
import { loadGuestState } from '../guests/store';
import { nobodyLens } from '../secrecy/seal';
import { renderBrief, type BriefInput, type VendorCategory } from './brief';
import { flagForScopeChange, hhmm, scopeChanges, type ScopeChange, type VendorScope } from './scope';

type Ctx = { orgId: string; userId: string | null };
export type VendorEdit = Partial<VendorScope> & { name?: string; category?: VendorCategory; contactName?: string; email?: string; phone?: string; notes?: string; countDueDaysBefore?: number | null; onSite?: boolean; contractTotalCents?: number | null };

const FIELD_LABEL: Record<string, string> = { deliverables: 'Deliverables', arriveMin: 'Arrival time', departMin: 'Departure time', countEstimate: 'Count estimate' };
const show = (c: ScopeChange, side: 'before' | 'after') => {
  const v = c[side];
  return v === null || v === '' ? 'not set' : c.field === 'arriveMin' || c.field === 'departMin' ? hhmm(v as number) : String(v);
};
/** What a flag says, for the dashboard, the flags list and the brief. */
export function flagText(reason: string, detail: unknown): string {
  const d = detail as { from?: string; to?: string; changes?: ScopeChange[] };
  if (reason === 'date_moved' && d.from && d.to) return `The wedding date moved from ${showDay(d.from)} to ${showDay(d.to)}`;
  return (d.changes ?? []).map((c) => `${FIELD_LABEL[c.field] ?? c.field} changed from ${show(c, 'before')} to ${show(c, 'after')}`).join('; ') || 'Scope changed';
}

/** Edits a vendor. A change to a scope field of a booked vendor raises one flag naming each field, before and after. */
export async function updateVendor(tx: Tx, ctx: Ctx, id: string, edit: VendorEdit): Promise<{ flagged: boolean }> {
  const v = await tx.vendor.findFirstOrThrow({ where: { id, ...inOrg(ctx) } });
  if (v.contractSignedOn && edit.contractTotalCents !== undefined && edit.contractTotalCents !== v.contractTotalCents) throw new Refused('The contract is signed; its total cannot be edited.');
  const changes = scopeChanges(v, edit);
  const after = await tx.vendor.update({ where: { id }, data: edit });
  const logged = await logChange(tx, ctx, 'vendor', 'updated', id, after.name, v, after);
  const draft = flagForScopeChange(v, changes);
  if (draft) {
    const flag = await tx.vendorFlag.create({ data: { orgId: ctx.orgId, vendorId: id, reason: draft.reason, detail: draft.detail as Prisma.InputJsonObject, raisedById: ctx.userId } });
    await logChange(tx, ctx, 'flag', 'raised', flag.id, after.name, null, { reason: draft.reason, fields: changes.map((c) => c.field) });
  }
  if (logged && edit.countDueDaysBefore !== undefined) await syncRsvpTask(tx, ctx);
  return { flagged: !!draft };
}

/** Schedules a payment: the row, and its zero-lead task due `dueDaysBefore` days before the wedding (P0-1). */
export async function addPayment(tx: Tx, ctx: Ctx, vendorId: string, input: { label: string; amountCents: number; dueDaysBefore: number }) {
  const v = await tx.vendor.findFirstOrThrow({ where: { id: vendorId, ...inOrg(ctx) }, select: { name: true } });
  const task = await tx.task.create({ data: { orgId: ctx.orgId, title: `Pay ${v.name}: ${input.label}`, kind: 'payment', leadDays: 0, bufferDays: input.dueDaysBefore, vendorId } });
  const p = await tx.vendorPayment.create({ data: { orgId: ctx.orgId, vendorId, label: input.label, amountCents: input.amountCents, dueDaysBefore: input.dueDaysBefore, taskId: task.id } });
  await logChange(tx, ctx, 'payment', 'created', p.id, `${v.name}: ${input.label}`, null, { amountCents: input.amountCents, dueDaysBefore: input.dueDaysBefore });
  await logChange(tx, ctx, 'task', 'created', task.id, task.title, null, { kind: 'payment', leadDays: 0, bufferDays: input.dueDaysBefore });
  return p;
}

export async function acknowledgeFlag(tx: Tx, ctx: Ctx, id: string, note: string): Promise<boolean> {
  const f = await tx.vendorFlag.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, include: { vendor: { select: { name: true } } } });
  if (f.ackAt) return false;
  const ackAt = now();
  await tx.vendorFlag.update({ where: { id }, data: { ackAt, ackById: ctx.userId, ackNote: note } });
  await logChange(tx, ctx, 'flag', 'acknowledged', id, f.vendor.name, { acknowledged: false }, { acknowledged: true, note });
  return true;
}

/** Everything a brief is made of: this vendor's own rows and nothing else. */
export async function briefInput(tx: Tx, ctx: { orgId: string }, vendorId: string): Promise<BriefInput> {
  const wedding = await requireWedding(tx, ctx);
  const v = await tx.vendor.findFirstOrThrow({ where: { id: vendorId, ...inOrg(ctx) }, include: { payments: true, flags: { where: { ackAt: null }, orderBy: { raisedAt: 'asc' } } } });
  const { rows, schedule } = await loadSchedule(tx, ctx, wedding);
  const L = await nobodyLens(tx, ctx.orgId); // a brief is shared (and, from D-42, the vendor's own): no private task in it
  const date = weddingDay(wedding);
  // Phase 2: counts from the guest engine, only once there is a guest list. Counts and song titles, never a name.
  const gs = await loadGuestState(tx, ctx);
  const roll = rollups(gs.households);
  const doNotPlay = await tx.doNotPlay.findMany({ where: inOrg(ctx), select: { title: true, artist: true }, orderBy: [{ title: 'asc' }, { artist: 'asc' }] });
  return {
    wedding: { title: wedding.title, date },
    vendor: {
      name: v.name, category: v.category, contactName: v.contactName, deliverables: v.deliverables, arriveMin: v.arriveMin, departMin: v.departMin,
      countEstimate: v.countEstimate, countDueDaysBefore: v.countDueDaysBefore, countDue: v.countDueDaysBefore === null ? null : addDays(date, -v.countDueDaysBefore),
      contractTotalCents: v.contractTotalCents, contractSignedOn: v.contractSignedOn ? dayOfDb(v.contractSignedOn) : null,
    },
    payments: v.payments.map((p) => ({ label: p.label, amountCents: p.amountCents, due: addDays(date, -p.dueDaysBefore), paidOn: p.paidOn ? dayOfDb(p.paidOn) : null })),
    tasks: rows.filter((t) => t.vendorId === vendorId && t.kind !== 'payment' && !L?.task(t).hidden).map((t) => ({ title: t.title, due: schedule.tasks[t.id]!.due, state: schedule.tasks[t.id]!.state })),
    openFlags: v.flags.map((f) => ({ reason: f.reason, raisedOn: todayOfDate(f.raisedAt, wedding.timeZone), text: flagText(f.reason, f.detail) })),
    ...(gs.rows.length || doNotPlay.length ? { guests: { attending: gs.count.attending, adults: gs.count.adults, kids: gs.count.kids, infants: gs.count.infants, vendorMeals: gs.count.vendorMeals, catererMeals: gs.count.catererMeals, meals: roll.meals, dietary: roll.dietary, accessibility: roll.accessibility, songs: roll.songs, doNotPlay } } : {}),
  };
}
const todayOfDate = (at: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

/** Regenerates the brief: a new version only when the inputs changed since the last one. */
export async function generateBrief(tx: Tx, ctx: Ctx, vendorId: string): Promise<{ version: number; created: boolean }> {
  const { body, inputsHash } = renderBrief(await briefInput(tx, ctx, vendorId));
  const last = await tx.vendorBrief.findFirst({ where: { vendorId, ...inOrg(ctx) }, orderBy: { version: 'desc' } });
  if (last && last.inputsHash === inputsHash) return { version: last.version, created: false };
  const b = await tx.vendorBrief.create({ data: { orgId: ctx.orgId, vendorId, version: (last?.version ?? 0) + 1, body, inputsHash, generatedById: ctx.userId } });
  const v = await tx.vendor.findFirstOrThrow({ where: { id: vendorId, ...inOrg(ctx) }, select: { name: true } });
  await logChange(tx, ctx, 'brief', 'generated', b.id, v.name, null, { version: b.version });
  return { version: b.version, created: true };
}
