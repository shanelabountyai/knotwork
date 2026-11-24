import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { allows } from '@/lib/knotwork/access';
import { loadWho } from '@/lib/knotwork/context';
import { readBlob } from '@/lib/knotwork/photos/blobs';
import { RENDITION_KINDS, type RenditionKind } from '@/lib/knotwork/uploads/caps';
import { UUID } from '../../../nav';

export const dynamic = 'force-dynamic';

// A photo's bytes, to signed-in people only (PRD P0-6): the wall, the album and the moderation console all read
// through here. The type sent is the one stored with the photo (the pipeline writes only JPEG), never one guessed
// from a name, and the browser is told not to guess either. A photo that is not live is served only to someone who
// can moderate; another workspace's photo, a purged one and an unknown one are the same 404.
export async function GET(_req: Request, { params }: { params: Promise<{ org: string; photo: string; kind: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { photo: id, kind } = await params;
  if (!UUID.test(id) || !(RENDITION_KINDS as string[]).includes(kind)) notFound();
  const found = await withOrg(ctx, async (tx) => {
    const who = await loadWho(tx, ctx);
    if (!allows(who, 'photos.view')) notFound();
    const photo = await tx.photo.findFirst({ where: { id, ...inOrg(ctx), purgedAt: null }, select: { id: true, mime: true, status: true } });
    if (!photo || (photo.status !== 'live' && !allows(who, 'photos.moderate'))) notFound();
    const bytes = await readBlob(tx, ctx.orgId, photo.id, kind as RenditionKind);
    return bytes ? { mime: photo.mime, bytes } : notFound();
  });
  return new Response(found.bytes as BodyInit, {
    headers: { 'Content-Type': found.mime, 'Content-Length': String(found.bytes.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300', 'Content-Disposition': `inline; filename="photo-${id.slice(0, 8)}-${kind}.jpg"` },
  });
}
