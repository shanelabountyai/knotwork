'use server';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { loadWho, need } from '@/lib/knotwork/context';
import { removeAttachment } from '@/lib/knotwork/vendors/attachments';

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
