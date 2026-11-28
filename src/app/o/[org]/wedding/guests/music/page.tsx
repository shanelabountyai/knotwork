import { inOrg, requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { rollups } from '@/lib/knotwork/guests/headcount';
import { loadGuestState } from '@/lib/knotwork/guests/store';
import { NoWedding, WeddingNav } from '../../bits';
import { view } from '../../view';
import { addDoNotPlay, removeDoNotPlay } from '../actions';
import { GuestNav } from '../nav';

export const metadata = { title: 'Music' };

// PRD P0-3 (bride review #6): song requests from RSVPs and the couple's do-not-play list; both ride onto the DJ's brief.
export default async function Music({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'guests.view', async (tx) => ({
    songs: rollups((await loadGuestState(tx, ctx)).households).songs,
    dnp: await tx.doNotPlay.findMany({ where: inOrg(ctx), orderBy: [{ title: 'asc' }, { artist: 'asc' }] }),
  }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, songs, dnp } = data;
  const canEdit = allows(v.who, 'guests.edit');
  return (
    <main>
      <WeddingNav who={v.who} slug={ctx.slug} mode={v.wedding.mode} />
      <GuestNav slug={ctx.slug} />
      <h1>Music</h1>
      <h2>Requests from guests who are coming</h2>
      <ul aria-label="Song requests">{songs.length ? songs.map((x) => <li key={x}>{x}</li>) : <li>None yet.</li>}</ul>
      <h2>Do not play</h2>
      <ul aria-label="Do not play">
        {dnp.length === 0 && <li>Nothing listed.</li>}
        {dnp.map((x) => (
          <li key={x.id}>
            {x.title}{x.artist && ` (${x.artist})`}
            {canEdit && <ActionForm action={removeDoNotPlay.bind(null, ctx.slug)}><input type="hidden" name="id" value={x.id} /><button type="submit">Remove {x.title}</button></ActionForm>}
          </li>
        ))}
      </ul>
      {canEdit && (
        <ActionForm action={addDoNotPlay.bind(null, ctx.slug)}>
          <label>Song <input name="title" required maxLength={120} /></label>
          <label>Artist <input name="artist" maxLength={120} /></label>
          <button type="submit">Add to do-not-play</button>
        </ActionForm>
      )}
      <p>Both lists appear on the DJ&apos;s brief the next time it is generated.</p>
    </main>
  );
}
