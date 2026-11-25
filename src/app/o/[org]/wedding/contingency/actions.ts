'use server';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { loadWho, need, requireWedding } from '@/lib/knotwork/context';
import { parseTreeText, STARTER_KEYS, STARTERS, TREE_TEXT_MAX, type StarterKey } from '@/lib/knotwork/contingency/schema';
import { createPlan, executeBranch, removePlan, tickItem, TITLE_MAX, updatePlan } from '@/lib/knotwork/contingency/store';
import { parsePath } from '@/lib/knotwork/contingency/tree';
import { seen } from '@/lib/knotwork/secrecy/store';
import { contingencyWorld } from '@/lib/knotwork/secrecy/views';

// P1-6, contingency decision trees. Order as everywhere: capability, then every ref (another workspace's plan or item is
// notFound, like one that does not exist), then the rules (Refused), then the writes and their change-log lines in one
// transaction (in the store). RULE 2: executing a branch never books, signs or spends over the threshold itself: a
// spend over it is proposed through consent (contingency/store.ts).

const base = (ctx: OrgCtx, rest = '') => `/o/${ctx.slug}/wedding/contingency${rest}`;
const title = z.string().trim().min(1, 'Give the plan a name.').max(TITLE_MAX, 'That name is too long.');
const treeText = z.string().max(TREE_TEXT_MAX + 1).default('');
const checkbox = z.union([z.boolean(), z.string().max(8)]).optional().transform((v) => v === true || v === 'on' || v === 'true' || v === '1');

const planIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.contingencyPlan.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();
const itemIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.contingencyItem.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();

function treeFrom(text: string) {
  const r = parseTreeText(text);
  if (!r.ok) throw new Refused(`That plan cannot be used: ${r.problems.join(' ')}`);
  return r.tree;
}

/** A new plan from a starter, or from the text of a tree (the text wins when both are given). */
export const createContingencyPlan = orgAction(null, z.object({ title, starter: z.string().trim().max(40).default(''), tree: treeText }), async (ctx, i) => {
  const id = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'contingency.edit');
    let tree;
    if (i.tree.trim()) tree = treeFrom(i.tree);
    else if ((STARTER_KEYS as string[]).includes(i.starter)) tree = STARTERS[i.starter as StarterKey].tree;
    else throw new Refused('Pick a starter plan, or paste one.');
    return (await createPlan(tx, ctx, i.title, tree)).id;
  });
  redirect(base(ctx, `/${id}`));
});

export const updateContingencyPlan = orgAction(null, z.object({ id: ref('contingencyPlan'), title, tree: treeText }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'contingency.edit');
    await planIn(tx, ctx, i.id);
    await updatePlan(tx, ctx, i.id, i.title, treeFrom(i.tree));
  });
  redirect(base(ctx, `/${i.id}`));
});

export const removeContingencyPlan = orgAction(null, z.object({ id: ref('contingencyPlan') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'contingency.edit');
    await planIn(tx, ctx, i.id);
    await removePlan(tx, ctx, i.id);
  });
  redirect(base(ctx));
});

/** Puts one branch into action, exactly as previewed (the fingerprint the page showed). Partners only. */
export const executeContingencyBranch = orgAction(null, z.object({ id: ref('contingencyPlan'), path: z.string().trim().max(40), fingerprint: z.string().trim().max(32) }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'contingency.edit');
    await planIn(tx, ctx, i.id);
    const path = parsePath(i.path);
    if (!path) throw new Refused('Answer every question first.');
    if (!i.fingerprint) throw new Refused('Look at the preview first.');
    // The world is read inside the store, after the wedding lock: the wedding row (its threshold) is read fresh there.
    await executeBranch(tx, ctx, { id: i.id, path, fingerprint: i.fingerprint }, async () => contingencyWorld(tx, ctx, await requireWedding(tx, ctx), await seen(tx, ctx)));
  });
  redirect(base(ctx, `/${i.id}`));
});

export const tickContingencyItem = orgAction(null, z.object({ id: ref('contingencyItem'), done: checkbox }), async (ctx, i) => {
  const planId = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'contingency.edit');
    await itemIn(tx, ctx, i.id);
    await tickItem(tx, ctx, i.id, i.done);
    return (await tx.contingencyItem.findUniqueOrThrow({ where: { id: i.id }, select: { run: { select: { planId: true } } } })).run.planId;
  });
  redirect(base(ctx, `/${planId}`));
});
