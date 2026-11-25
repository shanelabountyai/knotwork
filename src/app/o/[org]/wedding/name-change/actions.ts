'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction } from '@/core/authz/action';
import type { OrgCtx } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { loadWho, need } from '@/lib/knotwork/context';
import { changeJurisdiction as changeRules, moveNameChange, removeNameChange as removeRows, shareNameChange as shareRows, startNameChange as startRows } from '@/lib/knotwork/namechange/store';

// P1-4, the name-change sequence. Every action is the asking partner's own name change: there is no id to post, so
// nobody can name another person's. Order as everywhere: capability, then the rules (Refused), then the write and its
// change-log line in one transaction (in the store, under a row lock, where the gating is checked).

const page = (ctx: OrgCtx) => `/o/${ctx.slug}/wedding/name-change`;
const key = z.string().trim().max(40);
const checkbox = z.union([z.boolean(), z.string().max(8)]).optional().transform((v) => v === true || v === 'on' || v === 'true' || v === '1');

export const startNameChange = orgAction(null, z.object({ jurisdiction: key }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'namechange.own');
    await startRows(tx, ctx, i.jurisdiction);
  });
  redirect(page(ctx));
});

export const changeJurisdiction = orgAction(null, z.object({ jurisdiction: key }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'namechange.own');
    await changeRules(tx, ctx, i.jurisdiction);
  });
  redirect(page(ctx));
});

export const shareNameChange = orgAction(null, z.object({ shared: checkbox }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'namechange.own');
    await shareRows(tx, ctx, i.shared);
  });
  redirect(page(ctx));
});

/** Start, finish, stop or reopen one step. Gated in the store: prerequisites done and documents held. */
export const moveNameChangeStep = orgAction(null, z.object({ step: key, op: z.enum(['start', 'finish', 'stop', 'reopen']) }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'namechange.own');
    await moveNameChange(tx, ctx, { op: i.op, key: i.step });
  });
  redirect(page(ctx));
});

/** Mark a document held, or no longer held. */
export const holdNameChangeArtifact = orgAction(null, z.object({ artifact: key, op: z.enum(['hold', 'release']) }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'namechange.own');
    await moveNameChange(tx, ctx, { op: i.op, key: i.artifact });
  });
  redirect(page(ctx));
});

export const removeNameChange = orgAction(null, z.object({ confirm: checkbox }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'namechange.own');
    if (!i.confirm) throw new Refused('Tick the box to remove your name change and everything you marked in it.');
    await removeRows(tx, ctx);
  });
  redirect(page(ctx));
});
