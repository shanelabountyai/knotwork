// P1-6: contingency plans in the database: create, change, remove, and execute one branch. A store; everything runs
// inside the caller's withOrg transaction and every write is logged in it.
//
// executeBranch is ONE transaction under the wedding lock (the lock every plan edit and date move takes), so the
// schedule it adds to, the vendors it names and the threshold it compares against cannot change underneath it. It
// recomputes the preview and refuses unless it is exactly the one that was shown (its fingerprint). Then:
//   - the tasks are ordinary manual tasks with leadDays and bufferDays, through the scheduler's own model, so their
//     dates derive from the wedding date (rule 1) and move with it;
//   - a spend at or under the threshold is recorded (createExpense, no request), and one over it is only PROPOSED
//     through consent (rule 2: `propose`; it executes in the consent module when the other partner approves, or at
//     once in solo mode, D-33, still inside the consent module);
//   - the checklist and the vendors to tell become the run's items, ticked off one by one.
// A plan runs once (D-121): a second execute is refused, the database's unique planId refuses it too, and the tree of
// a plan that ran cannot change (a trigger).
import { inOrg } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import type { Prisma } from '@/generated/prisma/client';
import { createExpense } from '../budget-store';
import { logChange } from '../changelog';
import { propose } from '../consent/store';
import { requireWedding, todayOf } from '../context';
import { dayOfDb, dbOfDay, showDay } from '../days';
import { usd } from '../money';
import { assertValidPlan, loadTasks, lockWedding, toPlan } from '../schedule/store';
import { previewBranch, summary, type Preview, type World } from './preview';
import { parseTree } from './schema';
import type { Tree } from './tree';

type Ctx = { orgId: string; userId: string; role: string };

export const TITLE_MAX = 80;

function treeOf(json: unknown): Tree {
  const r = parseTree(json);
  if (!r.ok) throw new Error(`stored contingency plan is invalid: ${r.problems.join('; ')}`); // every write goes through parseTree
  return r.tree;
}

export async function listPlans(tx: Tx, ctx: { orgId: string }) {
  const rows = await tx.contingencyPlan.findMany({ where: inOrg(ctx), include: { run: { select: { executedAt: true, leaf: true } } }, orderBy: [{ title: 'asc' }] });
  return rows.map((p) => ({ id: p.id, title: p.title, tree: treeOf(p.tree), run: p.run }));
}

/** One plan, its run (if it ran) and the run's items in order. Null when it is not in this workspace. */
export async function loadPlan(tx: Tx, ctx: { orgId: string }, id: string) {
  const p = await tx.contingencyPlan.findFirst({ where: { id, ...inOrg(ctx) }, include: { run: { include: { items: { orderBy: { position: 'asc' } } } } } });
  return p ? { ...p, tree: treeOf(p.tree) } : null;
}

async function titleFree(tx: Tx, ctx: { orgId: string }, title: string, except?: string) {
  if (await tx.contingencyPlan.findFirst({ where: { ...inOrg(ctx), title, ...(except && { id: { not: except } }) }, select: { id: true } })) throw new Refused('There is already a plan with that name.');
}

export async function createPlan(tx: Tx, ctx: Ctx, title: string, tree: Tree) {
  await requireWedding(tx, ctx);
  await titleFree(tx, ctx, title);
  const p = await tx.contingencyPlan.create({ data: { orgId: ctx.orgId, title, tree: tree as unknown as Prisma.InputJsonObject, createdById: ctx.userId } });
  await logChange(tx, ctx, 'contingency', 'created', p.id, title, null, { title, outcomes: Object.values(tree.nodes).filter((n) => n.type === 'leaf').length });
  return p;
}

/** A new title or tree, only while the plan has not been put into action. */
export async function updatePlan(tx: Tx, ctx: Ctx, id: string, title: string, tree: Tree) {
  await tx.$queryRaw`SELECT 1 FROM "ContingencyPlan" WHERE id = ${id}::uuid AND "orgId" = ${ctx.orgId}::uuid FOR UPDATE`;
  const p = await tx.contingencyPlan.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, include: { run: { select: { executedAt: true } } } });
  if (p.run) throw new Refused('This plan was already put into action, so it stays as it was run. Make a new plan instead.');
  await titleFree(tx, ctx, title, id);
  await tx.contingencyPlan.update({ where: { id }, data: { title, tree: tree as unknown as Prisma.InputJsonObject } });
  // The tree is logged by its size, not its text (it can be long); an edit that changes nothing writes no entry.
  const shape = (t: unknown) => ({ nodes: Object.keys((t as Tree).nodes).length, text: JSON.stringify(t).length });
  await logChange(tx, ctx, 'contingency', 'updated', id, title, { title: p.title, ...shape(p.tree), same: true }, { title, ...shape(tree), same: JSON.stringify(p.tree) === JSON.stringify(tree) });
}

/** Only a plan that never ran (one that ran is the record of what was done). Logged first. */
export async function removePlan(tx: Tx, ctx: Ctx, id: string) {
  const p = await tx.contingencyPlan.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, include: { run: { select: { executedAt: true } } } });
  if (p.run) throw new Refused('This plan was put into action, so it stays as the record of what was done.');
  await logChange(tx, ctx, 'contingency', 'deleted', id, p.title, { title: p.title }, null);
  await tx.contingencyPlan.delete({ where: { id } });
}

/** The preview a page shows. Writes nothing. */
export const previewFor = (tree: Tree, path: readonly number[], world: World): Preview | null => previewBranch(tree, path, world);

/**
 * Executes the branch at `path`, exactly as previewed. `world` is read after the wedding lock is taken, so it is the
 * world the writes below see. Returns what it did.
 */
export async function executeBranch(tx: Tx, ctx: Ctx, input: { id: string; path: number[]; fingerprint: string }, world: () => Promise<World>) {
  await lockWedding(tx, ctx.orgId);
  await tx.$queryRaw`SELECT 1 FROM "ContingencyPlan" WHERE id = ${input.id}::uuid AND "orgId" = ${ctx.orgId}::uuid FOR UPDATE`;
  const plan = await tx.contingencyPlan.findFirstOrThrow({ where: { id: input.id, ...inOrg(ctx) }, include: { run: { select: { executedAt: true } } } });
  if (plan.run) throw new Refused(`This plan was already put into action (${showDay(dayOfDb(plan.run.executedAt))}). A plan runs once; it is not run again.`);
  const preview = previewBranch(treeOf(plan.tree), input.path, await world());
  if (!preview) throw new Refused('Answer every question first.');
  if (preview.problems.length) throw new Refused(preview.problems[0]!);
  if (preview.fingerprint !== input.fingerprint) throw new Refused('Something this plan touches changed since the preview was made. Look at the new preview, then put it into action again.');
  const wedding = await requireWedding(tx, ctx);
  const today = todayOf(wedding);

  // Tasks: through the scheduler's model (leadDays, bufferDays, dependencies), then the whole plan is checked.
  const taskIds = new Map<string, string>();
  for (const t of preview.tasks) {
    const row = await tx.task.create({ data: { orgId: ctx.orgId, title: t.title, kind: 'manual', leadDays: t.leadDays, bufferDays: t.bufferDays, notes: `Added by the plan "${plan.title}": ${preview.leaf.title}.` } });
    taskIds.set(t.key, row.id);
  }
  const edges = preview.tasks.flatMap((t) => t.after.map((a) => ({ orgId: ctx.orgId, taskId: taskIds.get(t.key)!, dependsOnId: taskIds.get(a)! })));
  if (edges.length) await tx.taskDependency.createMany({ data: edges });
  assertValidPlan(toPlan(await loadTasks(tx, ctx)));
  for (const t of preview.tasks) {
    await logChange(tx, ctx, 'task', 'created', taskIds.get(t.key)!, t.title, null, { title: t.title, leadDays: t.leadDays, bufferDays: t.bufferDays, dependsOn: t.after.map((a) => taskIds.get(a)!).sort() }, { via: 'contingency', plan: plan.title });
  }

  // Spends: recorded at or under the threshold; over it, proposed (rule 2). Never executed here.
  const expenses: string[] = [];
  const requests: string[] = [];
  for (const s of preview.spends) {
    const input = { categoryId: s.categoryId!, vendorId: null, description: s.description, amountCents: s.amountCents, paidOn: today, paymentId: null };
    if (!s.designated) {
      expenses.push((await createExpense(tx, ctx, wedding, input, null)).id);
      continue;
    }
    const r = await propose(tx, ctx, wedding, 'spend', input, `Spend ${usd(s.amountCents)}: ${s.description} (${s.category}), from the plan "${plan.title}"`);
    requests.push(r.id);
  }

  const run = await tx.contingencyRun.create({
    data: { orgId: ctx.orgId, planId: plan.id, path: input.path, leaf: preview.leaf.key, fingerprint: preview.fingerprint, result: { tasks: [...taskIds.values()], expenses, requests }, executedById: ctx.userId },
  });
  if (preview.items.length) await tx.contingencyItem.createMany({ data: preview.items.map((it, position) => ({ orgId: ctx.orgId, runId: run.id, position, kind: it.kind, text: it.text, vendorId: it.vendorId })) });
  await logChange(tx, ctx, 'contingency', 'executed', plan.id, plan.title, null, { answers: preview.answers.map((a) => `${a.question} ${a.answer}`), outcome: preview.leaf.title, did: summary(preview) });
  return { runId: run.id, tasks: taskIds.size, expenses: expenses.length, requests: requests.length };
}

/** Ticks a checklist line or a vendor to tell off (or back on). A date of fact. */
export async function tickItem(tx: Tx, ctx: Ctx, id: string, done: boolean) {
  const it = await tx.contingencyItem.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, include: { run: { select: { planId: true } } } });
  if (!!it.doneOn === done) return;
  const doneOn = done ? dbOfDay(todayOf(await requireWedding(tx, ctx))) : null;
  await tx.contingencyItem.update({ where: { id }, data: { doneOn, doneById: done ? ctx.userId : null } });
  await logChange(tx, ctx, 'contingency', done ? 'ticked' : 'unticked', it.id, it.text, { done: !!it.doneOn }, { done }, { planId: it.run.planId });
}
