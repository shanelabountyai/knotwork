import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { loadConsole } from '@/lib/knotwork/photos/store';
import { NoWedding, WeddingNav } from '../../../bits';
import { view } from '../../../view';
import { moderatePhoto, setPhotoDeviceBlocked, setPhotoHidden } from '../../actions';
import { PhotoNav, UUID } from '../../nav';
import { CLASSIFIER_TEXT, SUGGESTION_TEXT } from '@/lib/knotwork/photos/classifier';

export const metadata = { title: 'Moderate photos' };
export const dynamic = 'force-dynamic';

type Row = Awaited<ReturnType<typeof loadConsole>>['live'][number];

// The moderation console (PRD P0-6): what is waiting, what is live, what was removed (each removal can be undone),
// and the devices photos came from (a device can be blocked). For a partner or a helper with the photo permission.
export default async function Moderate({ params }: { params: Promise<{ org: string; event: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { event: id } = await params;
  if (!UUID.test(id)) notFound();
  const data = await view(ctx, 'photos.view', async (tx) => {
    const event = await tx.photoEvent.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true, name: true, mode: true, classifier: true } });
    return { event, console: event ? await loadConsole(tx, ctx, id) : null };
  });
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, event, console: c } = data;
  if (!event || !c) notFound();
  const can = allows(v.who, 'photos.moderate');
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  const src = (p: Row) => `/o/${ctx.slug}/wedding/photos/image/${p.id}/thumb`;
  const what = (p: Row) => `photo ${p.id.slice(0, 8)}${p.uploaderName ? ` from ${p.uploaderName}` : ''}`;
  const Move = ({ p, action, label }: { p: Row; action: string; label: string }) => (
    <ActionForm action={bind(moderatePhoto)}>
      <input type="hidden" name="id" value={p.id} />
      <input type="hidden" name="action" value={action} />
      <button type="submit" aria-label={`${label}: ${what(p)}`}>{label}</button>
    </ActionForm>
  );
  const Hide = ({ p, where }: { p: Row; where: 'wall' | 'album' }) => {
    const hidden = where === 'wall' ? p.hiddenFromWall : p.hiddenFromAlbum;
    const label = hidden ? (where === 'wall' ? 'Show on the wall' : 'Show in the album') : where === 'wall' ? 'Hide from the wall' : 'Hide from the album';
    return (
      <ActionForm action={bind(setPhotoHidden)}>
        <input type="hidden" name="id" value={p.id} />
        <input type="hidden" name="where" value={where} />
        <input type="hidden" name="hidden" value={hidden ? 'no' : 'yes'} />
        <button type="submit" aria-label={`${label}: ${what(p)}`}>{label}</button>
      </ActionForm>
    );
  };
  const Card = ({ p, children }: { p: Row; children?: React.ReactNode }) => (
    <li aria-label={what(p)} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', margin: '0.5rem 0' }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- served by the signed-in image route, already a thumbnail */}
      <img src={src(p)} alt={p.caption || `Photo from ${p.uploaderName || 'a guest'}`} width={120} loading="lazy" />
      <div>
        <p>{p.uploaderName || 'No name'}{p.caption && <>: {p.caption}</>} <small>(device {p.device}, {p.width}×{p.height})</small></p>
        {p.suggestion && p.suggestion !== 'ok' && <p aria-label={`Suggestion for ${what(p)}`}><strong>Suggestion: {SUGGESTION_TEXT[p.suggestion]}.</strong> {p.suggestionReason} <small>(advice only; you decide)</small></p>}
        {can && children}
      </div>
    </li>
  );
  return (
    <main>
      <WeddingNav slug={ctx.slug} />
      <PhotoNav slug={ctx.slug} event={event} />
      <h1>Moderate: {event.name}</h1>
      <p>{event.mode === 'pre' ? 'Each new photo waits here until someone approves it.' : 'New photos go on the wall at once. Take down what should not be there; a takedown can be undone.'}</p>
      {event.classifier !== 'none' && <p>Suggestions are on ({CLASSIFIER_TEXT[event.classifier]}). A suggestion is advice: it can hold a new photo here for a decision, and never approves, removes or publishes one.</p>}

      <section aria-label="Waiting">
        <h2>Waiting ({c.queue.length})</h2>
        {c.queue.length === 0 && <p>Nothing is waiting.</p>}
        <ul style={{ listStyle: 'none', padding: 0 }}>{c.queue.map((p) => <Card key={p.id} p={p}><Move p={p} action="approve" label="Approve" /> <Move p={p} action="reject" label="Reject" /></Card>)}</ul>
      </section>

      <section aria-label="Live">
        <h2>Live ({c.live.length})</h2>
        {c.live.length === 0 && <p>Nothing is live.</p>}
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {c.live.map((p) => (
            <Card key={p.id} p={p}>
              {(p.hiddenFromWall || p.hiddenFromAlbum) && <p><strong>{[p.hiddenFromWall && 'Hidden from the wall', p.hiddenFromAlbum && 'Hidden from the album'].filter(Boolean).join('. ')}.</strong></p>}
              <Move p={p} action="take_down" label="Take down" /> <Hide p={p} where="wall" /> <Hide p={p} where="album" />
            </Card>
          ))}
        </ul>
      </section>

      <section aria-label="Removed">
        <h2>Removed ({c.removed.length})</h2>
        {c.removed.length === 0 && <p>Nothing has been removed.</p>}
        <ul style={{ listStyle: 'none', padding: 0 }}>{c.removed.map((p) => <Card key={p.id} p={p}><p>{p.removedFrom === 'live' ? 'Taken down.' : 'Rejected.'}</p><Move p={p} action="undo" label={p.removedFrom === 'live' ? 'Undo: put it back' : 'Undo: back to waiting'} /></Card>)}</ul>
      </section>

      <section aria-label="Devices">
        <h2>Devices ({c.devices.length})</h2>
        <p>A device is one browser that has added a photo. Blocking it refuses its next uploads; what it already sent stays until you take it down.</p>
        <ul>
          {c.devices.map((d) => (
            <li key={d.id} aria-label={`Device ${d.number}`}>
              Device {d.number}: {d.photos} {d.photos === 1 ? 'photo' : 'photos'}{d.blocked && <strong> · blocked</strong>}
              {can && (
                <ActionForm action={bind(setPhotoDeviceBlocked)}>
                  <input type="hidden" name="id" value={d.id} />
                  <input type="hidden" name="blocked" value={d.blocked ? 'no' : 'yes'} />
                  <button type="submit">{d.blocked ? `Unblock device ${d.number}` : `Block device ${d.number}`}</button>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
