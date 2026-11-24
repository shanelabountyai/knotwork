import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { linkOpen } from '@/lib/knotwork/photos/dates';
import { qrDataUrl } from '@/lib/knotwork/photos/qr';
import { uploadLink, wallFeed } from '@/lib/knotwork/photos/store';
import { NoWedding } from '../../../bits';
import { view } from '../../../view';
import { UUID } from '../../nav';
import { Wall } from './wall';

export const metadata = { title: 'Photo wall' };
export const dynamic = 'force-dynamic';

// The live wall (PRD P0-6): dark, full screen, for a projector or a television. Signed-in only (a partner, or a
// helper with the photo permission); it is not a public page. The screen asks ./feed for the wall-visible photos
// every few seconds; which one shows next is decided by src/lib/knotwork/photos/wall.ts (new first, then rotation).
// The corner QR code is the event's upload link, shown only while that link is working.
export default async function WallPage({ params }: { params: Promise<{ org: string; event: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { event: id } = await params;
  if (!UUID.test(id)) notFound();
  const data = await view(ctx, 'photos.view', async (tx, v) => {
    const event = await tx.photoEvent.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true, name: true, uploadsOpen: true, uploadDays: true } });
    if (!event) return { event: null, feed: [], link: null };
    return { event, feed: await wallFeed(tx, ctx, id), link: linkOpen(event, v.date, v.today) ? await uploadLink(tx, ctx, id) : null };
  });
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, event, feed, link } = data;
  if (!event) notFound();
  const base = `/o/${ctx.slug}/wedding/photos`;
  return (
    <Wall
      title={v.wedding.title}
      eventName={event.name}
      feedUrl={`${base}/${event.id}/wall/feed`}
      backUrl={`${base}/${event.id}`}
      initial={feed.map((p) => ({ ...p, src: `${base}/image/${p.id}/display` }))}
      qr={link ? await qrDataUrl(link) : null}
    />
  );
}
