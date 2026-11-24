import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { allows } from '@/lib/knotwork/access';
import { loadWho } from '@/lib/knotwork/context';
import { wallFeed } from '@/lib/knotwork/photos/store';
import { UUID } from '../../../nav';

export const dynamic = 'force-dynamic';

// What the wall's screen polls (PRD P0-6): the wall-visible photos, newest first. Signed-in only, like the wall.
export async function GET(_req: Request, { params }: { params: Promise<{ org: string; event: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { event: id } = await params;
  if (!UUID.test(id)) notFound();
  const feed = await withOrg(ctx, async (tx) => {
    if (!allows(await loadWho(tx, ctx), 'photos.view')) notFound();
    if (!(await tx.photoEvent.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } }))) notFound();
    return wallFeed(tx, ctx, id);
  });
  const base = `/o/${ctx.slug}/wedding/photos/image`;
  return Response.json({ photos: feed.map((p) => ({ ...p, src: `${base}/${p.id}/display` })) }, { headers: { 'Cache-Control': 'private, no-store' } });
}
