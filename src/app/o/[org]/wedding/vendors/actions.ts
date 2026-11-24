'use server';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { loadWho, need } from '@/lib/knotwork/context';
import { showDay } from '@/lib/knotwork/days';
import { canSee } from '@/lib/knotwork/secrecy/store';
import { removeAttachment } from '@/lib/knotwork/vendors/attachments';
import { endVendorLink, makeVendorLink, vendorLinkOf } from '@/lib/knotwork/vendors/link';

// Contract attachments (D-39, D-65). ADDING one is not here: a file cannot be a server action's JSON input, so it
// comes in through the route handler ./[id]/attachments (rule 4). Removing one is an ordinary action.
export const removeVendorAttachment = orgAction(null, z.object({ id: ref('vendorAttachment') }), async (ctx, i) => {
  const vendorId = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'vendors.edit');
    const a = (await tx.vendorAttachment.findFirst({ where: { id: i.id, ...inOrg(ctx) }, select: { vendorId: true } })) ?? notFound();
    await removeAttachment(tx, ctx, i.id);
    return a.vendorId;
  });
  redirect(`/o/${ctx.slug}/wedding/vendors/${vendorId}`);
});

// ---- D-42, the vendor's read-only link (/v/[token]) ----------------------------------------------------------------
// vendors.edit: the link shows the vendor's brief, which that grant already sees. A vendor hidden from the asker (or
// another workspace's) is notFound, as everywhere.
async function vendorSeen(tx: Tx, ctx: OrgCtx, id: string) {
  if (!(await tx.vendor.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) || !(await canSee(tx, ctx, 'vendor', id))) notFound();
}

/** Shows the vendor's link again (from its sealed copy). */
export const showVendorLink = orgAction(null, z.object({ id: ref('vendor') }), async (ctx, i) => {
  const state = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'vendors.edit');
    await vendorSeen(tx, ctx, i.id);
    return vendorLinkOf(tx, ctx, i.id);
  });
  if (!state.exists) throw new Refused('This vendor has no read-only link yet.');
  if (!state.url) throw new Refused('The saved link can no longer be read. The link the vendor has still works; make a new one to see a link, and the old one will stop.');
  return { notice: `${state.url} works until ${showDay(state.lastDay)}.` };
});

/** Makes the vendor's link, or replaces it: the earlier link stops working at once. */
export const newVendorLink = orgAction(null, z.object({ id: ref('vendor') }), async (ctx, i) => {
  const { url, replaced, lastDay } = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'vendors.edit');
    await vendorSeen(tx, ctx, i.id);
    const before = await vendorLinkOf(tx, ctx, i.id);
    return { url: await makeVendorLink(tx, ctx, i.id), replaced: before.exists, lastDay: before.lastDay };
  });
  return { notice: `${url} is ${replaced ? 'the new link. The earlier link no longer works; send this one' : 'the link to send'}. It works until ${showDay(lastDay)}.` };
});

export const endVendorReadLink = orgAction(null, z.object({ id: ref('vendor') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'vendors.edit');
    await vendorSeen(tx, ctx, i.id);
    await endVendorLink(tx, ctx, i.id);
  });
  redirect(`/o/${ctx.slug}/wedding/vendors/${i.id}`);
});
