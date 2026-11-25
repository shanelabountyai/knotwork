'use server';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { hasPending, propose } from '@/lib/knotwork/consent/store';
import { lifeModeOpen, loadWho, need, requireWedding, todayOf, weddingDay } from '@/lib/knotwork/context';
import { UNITS } from '@/lib/knotwork/lifeadmin/recurrence';
import { addRecurring, markDone, removeRecurring, undoDone, updateRecurring } from '@/lib/knotwork/lifeadmin/store';

// Phase 5, life-admin mode: two actions (the template's action harness has a fixed time budget, D-133; one action per
// kind of thing, with a discriminated input, reads naturally here).
//
// RULE 2: `proposeMode` only PROPOSES the switch into life-admin mode and back (designated, D-143). The other partner
// approves it on the approvals page and src/lib/knotwork/consent/execute.ts makes it, or, in solo mode (D-33), it is
// approved and made at once there, marked solo. Nothing here writes the mode.

const home = (ctx: OrgCtx, page = '') => `/o/${ctx.slug}${page && `/wedding${page}`}`;

export const proposeMode = orgAction(null, z.object({ to: z.enum(['life', 'planning']) }), async (ctx, i) => {
  const out = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'consent.propose');
    const w = await requireWedding(tx, ctx);
    if (w.mode === i.to) throw new Refused(i.to === 'life' ? 'The workspace is already in life-admin mode.' : 'The workspace is already in planning mode.');
    if (i.to === 'life' && !lifeModeOpen(w)) throw new Refused('Life-admin mode opens the day after the wedding.');
    if (await hasPending(tx, ctx, 'set_mode')) throw new Refused('A switch is already waiting for your partner.');
    const summary = i.to === 'life' ? 'Switch to life-admin mode: the wedding plan becomes a read-only archive' : 'Switch back to planning mode: the wedding plan can be changed again';
    return propose(tx, ctx, w, 'set_mode', { to: i.to }, summary);
  });
  redirect(out.executed ? home(ctx) : home(ctx, '/approvals'));
});

/** A form posts strings; tests and the harness may post numbers. */
const every = z.union([z.number().int(), z.string().max(40)]).optional().transform((v) => (v === undefined || v === '' ? 1 : typeof v === 'number' ? v : /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN));

async function taskIn(tx: Tx, ctx: OrgCtx, id: string) {
  return (await tx.recurringTask.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();
}

/**
 * One recurring household task: add, edit, mark done (on a day, '' for today), take a done day off, or remove. Partners
 * only (`life.edit`, D-147), and only in life-admin mode. The order: capability, the ref (another workspace's task is
 * notFound, like a missing one), then the rules, then the write and its log line in one transaction.
 */
export const householdTask = orgAction(
  null,
  z.object({
    op: z.enum(['done', 'undo', 'edit', 'remove', 'add']),
    id: z.union([ref('recurringTask'), z.literal('')]).optional().transform((v) => v || null),
    title: z.string().trim().max(200).default(''),
    unit: z.enum(UNITS).default('week'),
    every,
    notes: z.string().trim().max(2000).default(''),
    on: z.string().trim().max(10).default(''),
  }),
  async (ctx, i) => {
    await withOrg(ctx, async (tx) => {
      const who = await loadWho(tx, ctx);
      need(who, 'life.edit');
      if (i.id) await taskIn(tx, ctx, i.id);
      const w = await requireWedding(tx, ctx);
      if (w.mode !== 'life') throw new Refused('Household tasks begin in life-admin mode, after the wedding.');
      const input = { title: i.title, unit: i.unit, every: i.every, notes: i.notes };
      if (i.op === 'add') {
        if (i.id) throw new Refused('A new task has no id yet.');
        await addRecurring(tx, ctx, input);
        return;
      }
      if (!i.id) throw new Refused('Pick a task.');
      const today = todayOf(w);
      if (i.op === 'edit') await updateRecurring(tx, ctx, i.id, input);
      else if (i.op === 'remove') await removeRecurring(tx, ctx, i.id);
      else if (i.op === 'done') await markDone(tx, ctx, i.id, i.on || today, { today, wedding: weddingDay(w) });
      else await undoDone(tx, ctx, i.id, i.on);
    });
    redirect(home(ctx, '/life'));
  },
);
