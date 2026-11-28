import { TableWrap } from '@/app/ui/kw';
import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { showDay } from '@/lib/knotwork/days';
import { EVENT_DEFAULTS } from '@/lib/knotwork/photos/dates';
import { loadEvents } from '@/lib/knotwork/photos/store';
import { NoWedding, WeddingNav } from '../bits';
import { view } from '../view';
import { createPhotoEvent, purgeExpiredPhotos } from './actions';
import { PhotoNav } from './nav';
import { CLASSIFIER_TEXT, CLASSIFIERS } from '@/lib/knotwork/photos/classifier';

export const metadata = { title: 'Photos' };

// PRD P0-6: the photo wall. Each event has one upload link (a QR code to print); guests add photos with no account.
// This page lists the events. For the two partners and for a helper with the photo permission.
export default async function Photos({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'photos.view', async (tx) => ({ events: await loadEvents(tx, ctx) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, events } = data;
  const canManage = allows(v.who, 'photos.manage');
  const due = events.filter((e) => e.purgeDue && e.counts.pending + e.counts.live + e.counts.removed > 0);
  return (
    <main>
      <WeddingNav who={v.who} slug={ctx.slug} life={v.wedding.mode === 'life'} />
      <PhotoNav slug={ctx.slug} />
      <h1>Photos</h1>
      <p>Guests add photos through an event&apos;s link, with no account. Where and when a photo was taken, and everything else stored inside the file, is removed before it is kept.</p>
      {events.length === 0 && <p>No photo events yet.</p>}
      {events.length > 0 && (
        <TableWrap label="Photo events">
        <table aria-label="Photo events">
          <thead><tr><th scope="col">Event</th><th scope="col">Moderation</th><th scope="col">Uploads</th><th scope="col">Photos</th><th scope="col">Kept until</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} aria-label={`Photo event ${e.name}`}>
                <th scope="row"><Link href={`/o/${ctx.slug}/wedding/photos/${e.id}`}>{e.name}</Link></th>
                <td>{e.mode === 'pre' ? 'approve first' : 'live at once'}</td>
                <td>{e.linkOpen ? `open until ${showDay(e.lastUploadDay)}` : e.uploadsOpen ? `ended ${showDay(e.lastUploadDay)}` : 'closed by you'}</td>
                <td>{e.counts.live} live, {e.counts.pending} waiting, {e.counts.removed} removed{e.counts.purged > 0 && `, ${e.counts.purged} deleted`}</td>
                <td>{showDay(e.lastKeptDay)}{e.purgeDue && ' (past)'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </TableWrap>
      )}

      {canManage && (
        <>
          <h2>Add a photo event</h2>
          <ActionForm action={createPhotoEvent.bind(null, ctx.slug)}>
            <label>Name <input name="name" required maxLength={80} placeholder="Reception" /></label>
            <label>Moderation <select name="mode" defaultValue="post"><option value="post">Live at once; remove on sight</option><option value="pre">Approve each photo first</option></select></label>
            <label>Uploads stay open this many days after the wedding <input name="uploadDays" inputMode="numeric" required defaultValue={EVENT_DEFAULTS.uploadDays} /></label>
            <label>Photos are kept this many days after the wedding <input name="retentionDays" inputMode="numeric" required defaultValue={EVENT_DEFAULTS.retentionDays} /></label>
            <label>Suggestions for moderators <select name="classifier" defaultValue="none">{CLASSIFIERS.map((k) => <option key={k} value={k}>{CLASSIFIER_TEXT[k]}</option>)}</select></label>
            <button type="submit">Add photo event</button>
          </ActionForm>

          <h2>Delete photos past their last kept day</h2>
          {due.length === 0 ? <p>No photo is past its last kept day. Download the gallery before that day: afterwards the photos are deleted for good.</p> : (
            <ActionForm action={purgeExpiredPhotos.bind(null, ctx.slug)}>
              <p>{due.map((e) => e.name).join(', ')}: past the last kept day. Deleting removes every photo&apos;s image for good; the list of who sent what stays in the activity log. This also happens on its own, daily.</p>
              <label><input type="checkbox" name="confirm" /> Delete these photos for good</label>
              <button type="submit">Delete expired photos</button>
            </ActionForm>
          )}
        </>
      )}
    </main>
  );
}
