// P1-4: one partner's name change in the database. A store; everything runs inside the caller's withOrg transaction
// and every write is logged in it.
//
// Whose (D-114): a name change belongs to one partner and only that partner changes it. It is PRIVATE to them unless
// they share it; shared, the other partner can read it (never change it); helpers never see one. Privacy uses the
// ADR-001 machinery for the change log: secrecy/seal.ts treats an unshared name change as a compartment owned by its
// partner with no reveal day, so every entry about it is written as "a private item" (the log is append-only and
// exported whole). There is no masked line: a name change is not in any total or any plan, so the other partner's
// pages simply do not show one that is not shared with them.
//
// Gating (D-115) is the pure workflow.ts `check`, run here under a row lock against the stored progress.
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { isPartner } from '../access';
import { logChange } from '../changelog';
import { requireWedding, todayOf } from '../context';
import { dayOfDb, dbOfDay, type Day } from '../days';
import { RULESETS, rulesFor } from './rules';
import { apply, board, check, REFUSAL_TEXT, type Op, type Progress, type Ruleset } from './workflow';

type Ctx = { orgId: string; userId: string; role: string };

const load = (tx: Tx, orgId: string, userId: string) => tx.nameChange.findUnique({ where: { orgId_userId: { orgId, userId } }, include: { steps: { orderBy: { step: 'asc' } }, artifacts: { orderBy: { artifact: 'asc' } } } });
type Row = NonNullable<Awaited<ReturnType<typeof load>>>;

export const progressOf = (row: Row): { progress: Progress; completed: Record<string, Day> } => ({
  progress: { steps: Object.fromEntries(row.steps.map((s) => [s.step, s.status])), held: row.artifacts.map((a) => a.artifact).sort() },
  completed: Object.fromEntries(row.steps.filter((s) => s.completedOn).map((s) => [s.step, dayOfDb(s.completedOn!)])),
});

function partnerOnly(ctx: Ctx) {
  if (!isPartner(ctx.role)) throw new Refused('A name change belongs to one of the two partners.');
}
function known(jurisdiction: string): Ruleset {
  const r = RULESETS[jurisdiction];
  if (!r) throw new Refused('Pick one of the places on the list (or the generic one).');
  return r;
}
async function mine(tx: Tx, ctx: Ctx): Promise<Row> {
  const row = await load(tx, ctx.orgId, ctx.userId);
  if (!row) throw new Refused('Start your name change first.');
  // One move at a time on one name change: the gating reads the progress, so two moves at once must not both pass.
  await tx.$queryRaw`SELECT 1 FROM "NameChange" WHERE id = ${row.id}::uuid FOR UPDATE`;
  return (await load(tx, ctx.orgId, ctx.userId))!;
}

export async function startNameChange(tx: Tx, ctx: Ctx, jurisdiction: string) {
  partnerOnly(ctx);
  const r = known(jurisdiction);
  await requireWedding(tx, ctx);
  if (await load(tx, ctx.orgId, ctx.userId)) throw new Refused('You already have a name change.');
  const row = await tx.nameChange.create({ data: { orgId: ctx.orgId, userId: ctx.userId, jurisdiction } });
  await logChange(tx, ctx, 'namechange', 'created', row.id, `Name change (${r.name})`, null, { jurisdiction, shared: false });
  return row;
}

/** Another jurisdiction's rules: only before any step has been started (the steps differ between files). */
export async function changeJurisdiction(tx: Tx, ctx: Ctx, jurisdiction: string) {
  partnerOnly(ctx);
  const r = known(jurisdiction);
  const row = await mine(tx, ctx);
  if (row.jurisdiction === jurisdiction) throw new Refused('Your name change already follows those rules.');
  if (row.steps.length) throw new Refused('You have already started steps. Reopen and stop them first, or keep these rules.');
  // A document the new rules do not ask for is let go (logged); the ones they share stay held.
  const dropped = row.artifacts.filter((a) => !r.artifacts.some((x) => x.key === a.artifact)).map((a) => a.artifact);
  if (dropped.length) await tx.nameChangeArtifact.deleteMany({ where: { nameChangeId: row.id, artifact: { in: dropped } } });
  await tx.nameChange.update({ where: { id: row.id }, data: { jurisdiction } });
  await logChange(tx, ctx, 'namechange', 'updated', row.id, `Name change (${r.name})`, { jurisdiction: row.jurisdiction }, { jurisdiction }, { dropped });
}

/** Share it with the other partner (read-only), or make it private again. */
export async function shareNameChange(tx: Tx, ctx: Ctx, shared: boolean) {
  partnerOnly(ctx);
  const row = await mine(tx, ctx);
  if (row.shared === shared) return;
  await tx.nameChange.update({ where: { id: row.id }, data: { shared } });
  // Written after the update: sharing is logged with its details (it is shared now); making it private again is not.
  await logChange(tx, ctx, 'namechange', shared ? 'shared' : 'unshared', row.id, `Name change (${rulesFor(row.jurisdiction).name})`, { shared: row.shared }, { shared });
}

/** One move through the workflow: start, finish, stop or reopen a step; hold or release a document. */
export async function moveNameChange(tx: Tx, ctx: Ctx, op: Op) {
  partnerOnly(ctx);
  const row = await mine(tx, ctx);
  const r = rulesFor(row.jurisdiction);
  const { progress } = progressOf(row);
  const c = check(r, progress, op);
  if (!c.ok) {
    const names = c.keys.map((k) => r.steps.find((s) => s.key === k)?.title ?? r.artifacts.find((a) => a.key === k)?.label ?? k);
    throw new Refused(names.length ? `${REFUSAL_TEXT[c.code]}: ${names.join('; ')}.` : REFUSAL_TEXT[c.code]);
  }
  const after = apply(progress, op);
  const label = op.op === 'hold' || op.op === 'release' ? r.artifacts.find((a) => a.key === op.key)!.label : r.steps.find((s) => s.key === op.key)!.title;
  if (op.op === 'hold') await tx.nameChangeArtifact.create({ data: { orgId: ctx.orgId, nameChangeId: row.id, artifact: op.key } });
  else if (op.op === 'release') await tx.nameChangeArtifact.deleteMany({ where: { nameChangeId: row.id, artifact: op.key } });
  else {
    const status = after.steps[op.key] ?? 'todo';
    const where = { nameChangeId_step: { nameChangeId: row.id, step: op.key } };
    if (status === 'todo') await tx.nameChangeStep.delete({ where });
    else {
      const completedOn = status === 'done' ? dbOfDay(todayOf(await requireWedding(tx, ctx))) : null;
      await tx.nameChangeStep.upsert({ where, create: { orgId: ctx.orgId, nameChangeId: row.id, step: op.key, status, completedOn }, update: { status, completedOn } });
    }
  }
  const was = op.op === 'hold' || op.op === 'release' ? { held: progress.held.includes(op.key) } : { status: progress.steps[op.key] ?? 'todo' };
  const now = op.op === 'hold' || op.op === 'release' ? { held: after.held.includes(op.key) } : { status: after.steps[op.key] ?? 'todo' };
  await logChange(tx, ctx, 'namechange', 'updated', row.id, `Name change: ${label}`, was, now, { [op.op === 'hold' || op.op === 'release' ? 'artifact' : 'step']: op.key });
}

/** Removes the whole name change (its steps and documents go with it). Logged first, while its privacy can be read. */
export async function removeNameChange(tx: Tx, ctx: Ctx) {
  partnerOnly(ctx);
  const row = await mine(tx, ctx);
  await logChange(tx, ctx, 'namechange', 'deleted', row.id, `Name change (${rulesFor(row.jurisdiction).name})`, { jurisdiction: row.jurisdiction, steps: row.steps.length, held: row.artifacts.length }, null);
  await tx.nameChange.delete({ where: { id: row.id } });
}

export type NameChangeCard = { userId: string; shared: boolean; rules: Ruleset; board: ReturnType<typeof board> };
const card = (row: Row, weddingDay: Day): NameChangeCard => {
  const rules = rulesFor(row.jurisdiction);
  const { progress, completed } = progressOf(row);
  return { userId: row.userId, shared: row.shared, rules, board: board(rules, progress, weddingDay, completed) };
};

/**
 * The page's view for one partner: their own name change, and the other partner's only if it is shared with them.
 * An unshared one of the other partner is not read at all. Helpers have no view (the page is partners-only).
 */
export async function nameChangeView(tx: Tx, ctx: { orgId: string; userId: string }, v: { date: Day; partners: string[] }) {
  const rows = await tx.nameChange.findMany({ where: { orgId: ctx.orgId, OR: [{ userId: ctx.userId }, { shared: true, userId: { in: v.partners.filter((p) => p !== ctx.userId) } }] }, include: { steps: { orderBy: { step: 'asc' } }, artifacts: { orderBy: { artifact: 'asc' } } }, orderBy: { createdAt: 'asc' } });
  const own = rows.find((r) => r.userId === ctx.userId);
  return { mine: own ? card(own, v.date) : null, others: rows.filter((r) => r.userId !== ctx.userId).map((r) => card(r, v.date)) };
}

// ---- the data export (built for nobody, as ADR-001's export is: an unshared name change keeps its ids and days of fact
// and loses which rules it follows and which steps and documents it holds).

const UNSHARED = { shared: false } as const;
async function privateIds(tx: Tx, orgId: string): Promise<Set<string>> {
  const partners = (await tx.membership.findMany({ where: { orgId, role: 'owner' }, select: { userId: true } })).map((m) => m.userId);
  return new Set((await tx.nameChange.findMany({ where: { orgId, ...UNSHARED, userId: { in: partners } }, select: { id: true } })).map((r) => r.id));
}
export async function exportNameChanges(tx: Tx, orgId: string): Promise<object[]> {
  const hidden = await privateIds(tx, orgId);
  return (await tx.nameChange.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })).map((r) => (hidden.has(r.id) ? { ...r, jurisdiction: '' } : r));
}
export async function exportNameChangeSteps(tx: Tx, orgId: string): Promise<object[]> {
  const hidden = await privateIds(tx, orgId);
  return (await tx.nameChangeStep.findMany({ where: { orgId }, orderBy: [{ nameChangeId: 'asc' }, { step: 'asc' }] })).map((r) => (hidden.has(r.nameChangeId) ? { ...r, step: '' } : r));
}
export async function exportNameChangeArtifacts(tx: Tx, orgId: string): Promise<object[]> {
  const hidden = await privateIds(tx, orgId);
  return (await tx.nameChangeArtifact.findMany({ where: { orgId }, orderBy: [{ nameChangeId: 'asc' }, { artifact: 'asc' }] })).map((r) => (hidden.has(r.nameChangeId) ? { ...r, artifact: '' } : r));
}
