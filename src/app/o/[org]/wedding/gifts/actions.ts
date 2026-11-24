'use server';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { loadWho, need, requireWedding } from '@/lib/knotwork/context';
import { GIFT_MIN_CENTS, TARGET_MAX_CENTS } from '@/lib/knotwork/gifts/ledger';
import { acknowledgeThankYou as acknowledgeRow, addItem, closeRegistry as closeRows, updateItem } from '@/lib/knotwork/gifts/store';
import { parseCents, usd } from '@/lib/knotwork/money';

// The couple's side of group gifting (PRD P0-5). Same order as every other action: capability, every ref (another
// org's row is notFound), the rules, then the write and its change-log line (in the store). Nothing here is
// guest-facing: a household's contribution comes in through /r/[token]/gifts. And nothing here reads the ledger: the
// couple never sees what one household gave (tests/knotwork/structure.test.ts scans this folder).

const page = (ctx: OrgCtx, rest = '') => `/o/${ctx.slug}/wedding/gifts${rest}`;
const checkbox = z.union([z.boolean(), z.string().max(8)]).optional().transform((v) => v === true || v === 'on' || v === 'true' || v === '1');
const TARGET_TEXT = `Target: an amount from ${usd(GIFT_MIN_CENTS)} to ${usd(TARGET_MAX_CENTS)}, like 450.00.`;
const target = z.union([z.number().int(), z.string().max(40)]).transform((v, c) => {
  const cents = typeof v === 'number' ? v : parseCents(v);
  if (cents === null || !Number.isInteger(cents) || cents < 0 || cents > TARGET_MAX_CENTS) c.addIssue({ code: 'custom', message: TARGET_TEXT });
  return cents ?? 0;
});
/** The lower bound is a rule, not a shape: it is checked after every ref has resolved (another org's row is notFound first). */
const atLeastMinimum = (cents: number) => {
  if (cents < GIFT_MIN_CENTS) throw new Refused(TARGET_TEXT);
};
const itemFields = { title: z.string().trim().min(1, 'A title is required.').max(120, 'That title is too long.'), note: z.string().trim().max(300, 'That note is too long.').default(''), target };

const itemIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.registryItem.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();
const thankYouIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.thankYou.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();

export const addRegistryItem = orgAction(null, z.object(itemFields), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'gifts.edit');
    await requireWedding(tx, ctx);
    atLeastMinimum(i.target);
    await addItem(tx, ctx, { title: i.title, note: i.note, targetCents: i.target });
  });
  redirect(page(ctx));
});

export const updateRegistryItem = orgAction(null, z.object({ id: ref('registryItem'), ...itemFields }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'gifts.edit');
    await itemIn(tx, ctx, i.id);
    atLeastMinimum(i.target);
    await updateItem(tx, ctx, i.id, { title: i.title, note: i.note, targetCents: i.target });
  });
  redirect(page(ctx));
});

/** Closes every open gift and refunds what was given toward each. One partner, with the box ticked (D-72). */
export const closeRegistry = orgAction(null, z.object({ confirm: checkbox }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'gifts.edit');
    await requireWedding(tx, ctx);
    if (!i.confirm) throw new Refused('Tick the box to close the registry. Every open gift is closed and everything given toward it is refunded; this cannot be undone.');
    await closeRows(tx, ctx);
  });
  redirect(page(ctx));
});

export const acknowledgeThankYou = orgAction(null, z.object({ id: ref('thankYou') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'gifts.edit');
    await thankYouIn(tx, ctx, i.id);
    await acknowledgeRow(tx, ctx, i.id);
  });
  redirect(page(ctx, '/thank-yous'));
});
