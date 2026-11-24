'use server';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { parsePrivacy, type ItemKind } from '@/lib/knotwork/secrecy/compartment';
import { canSee, setPrivacy } from '@/lib/knotwork/secrecy/store';

// P1-1 (ADR-001): "private to me until …", set or changed on an existing item by a partner, or revealed early by its
// owner (privacy ''). Order as everywhere: the ref (another workspace's row, or one hidden from the asker, is
// notFound), then the rules (Refused: helpers, a designated item, a reveal point already past), then the write and
// its log line in one transaction (secrecy/store.ts).

const privacy = z.union([z.number().int(), z.string().max(12)]).optional().transform((v) => v ?? '');

async function exists(tx: Tx, ctx: OrgCtx, kind: ItemKind, id: string): Promise<string | null> {
  const where = { id, ...inOrg(ctx) };
  if (kind === 'task') return (await tx.task.findFirst({ where, select: { id: true } }))?.id ?? null;
  if (kind === 'expense') return (await tx.expense.findFirst({ where, select: { id: true } }))?.id ?? null;
  if (kind === 'vendor') return (await tx.vendor.findFirst({ where, select: { id: true } }))?.id ?? null;
  return (await tx.budgetCategory.findFirst({ where, select: { id: true } }))?.id ?? null;
}

async function change(ctx: OrgCtx, kind: ItemKind, id: string, raw: string | number) {
  await withOrg(ctx, async (tx) => {
    if (!(await exists(tx, ctx, kind, id)) || !(await canSee(tx, ctx, kind, id))) notFound();
    const p = parsePrivacy(raw);
    if (!p) throw new Refused('Pick when it should be revealed: the wedding day, a number of days before or after, or never.');
    await setPrivacy(tx, ctx, kind, id, p);
  });
}

export const setTaskPrivacy = orgAction(null, z.object({ id: ref('task'), privacy }), async (ctx, i) => {
  await change(ctx, 'task', i.id, i.privacy);
  redirect(`/o/${ctx.slug}/wedding/schedule`);
});

export const setExpensePrivacy = orgAction(null, z.object({ id: ref('expense'), privacy }), async (ctx, i) => {
  await change(ctx, 'expense', i.id, i.privacy);
  redirect(`/o/${ctx.slug}/wedding/budget`);
});

export const setVendorPrivacy = orgAction(null, z.object({ id: ref('vendor'), privacy }), async (ctx, i) => {
  await change(ctx, 'vendor', i.id, i.privacy);
  redirect(`/o/${ctx.slug}/wedding/vendors/${i.id}`);
});

export const setCategoryPrivacy = orgAction(null, z.object({ id: ref('budgetCategory'), privacy }), async (ctx, i) => {
  await change(ctx, 'category', i.id, i.privacy);
  redirect(`/o/${ctx.slug}/wedding/budget`);
});
