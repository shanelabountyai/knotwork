import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { loadAlbum } from '@/lib/knotwork/photos/store';
import { NoWedding, WeddingNav } from '../../../bits';
import { view } from '../../../view';
import { PhotoNav, UUID } from '../../nav';

export const metadata = { title: 'Album' };
export const dynamic = 'force-dynamic';

// The album (PRD P0-6): every live photo that is not hidden from the album, oldest first, and the whole gallery as
// one download. Hiding a photo from the wall does not take it out of here, and the other way round.
export default async function Album({ params }: { params: Promise<{ org: string; event: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { event: id } = await params;
  if (!UUID.test(id)) notFound();
  const data = await view(ctx, 'photos.view', async (tx) => {
    const event = await tx.photoEvent.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true, name: true } });
    return { event, photos: event ? await loadAlbum(tx, ctx, id) : [] };
  });
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { event, photos } = data;
  if (!event) notFound();
  const base = `/o/${ctx.slug}/wedding/photos`;
  return (
    <main>
      <WeddingNav slug={ctx.slug} />
      <PhotoNav slug={ctx.slug} event={event} />
      <h1>Album: {event.name}</h1>
      <p>{photos.length} {photos.length === 1 ? 'photo' : 'photos'}. {photos.length > 0 && <a href={`${base}/${event.id}/zip`} download>Download the gallery (zip)</a>}</p>
      <ul aria-label="Album" style={{ listStyle: 'none', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(11rem, 1fr))', gap: '0.75rem' }}>
        {photos.map((p) => (
          <li key={p.id}>
            <a href={`${base}/image/${p.id}/full`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- served by the signed-in image route, already a thumbnail */}
              <img src={`${base}/image/${p.id}/thumb`} alt={p.caption || `Photo from ${p.uploaderName || 'a guest'}`} style={{ width: '100%' }} loading="lazy" />
            </a>
            <br />
            <small>{p.uploaderName || 'No name'}{p.caption && `: ${p.caption}`}</small>
          </li>
        ))}
      </ul>
    </main>
  );
}
