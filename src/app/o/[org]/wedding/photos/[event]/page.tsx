import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { showDay } from '@/lib/knotwork/days';
import { qrDataUrl } from '@/lib/knotwork/photos/qr';
import { loadEvents, uploadLink } from '@/lib/knotwork/photos/store';
import { NoWedding, WeddingNav } from '../../bits';
import { view } from '../../view';
import { replacePhotoLink, setPhotoUploads, updatePhotoEvent } from '../actions';
import { PhotoNav, UUID } from '../nav';
import { CLASSIFIER_TEXT, CLASSIFIERS } from '@/lib/knotwork/photos/classifier';

export const metadata = { title: 'Photo event' };

// One photo event: its upload link and QR code, when the link stops and when the photos go (both worked out from the
// wedding date, never stored), and its settings. Another workspace's event is a 404, like one that does not exist.
export default async function PhotoEventPage({ params }: { params: Promise<{ org: string; event: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { event: id } = await params;
  if (!UUID.test(id)) notFound();
  const data = await view(ctx, 'photos.view', async (tx) => {
    const found = await tx.photoEvent.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } });
    return { event: found ? ((await loadEvents(tx, ctx)).find((e) => e.id === id) ?? null) : null, link: found ? await uploadLink(tx, ctx, id) : null };
  });
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, event: e, link } = data;
  if (!e) notFound();
  const canManage = allows(v.who, 'photos.manage');
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  const qr = link ? await qrDataUrl(link) : null;
  return (
    <main>
      <WeddingNav slug={ctx.slug} life={v.wedding.mode === 'life'} />
      <PhotoNav slug={ctx.slug} event={e} />
      <h1>{e.name}</h1>
      <p aria-label="Event status">
        {e.mode === 'pre' ? 'Each photo waits until someone approves it.' : 'A photo is on the wall at once; remove what should not be there.'}{' '}
        {e.linkOpen ? `Uploads are open until ${showDay(e.lastUploadDay)} (${e.uploadDays} days after the wedding).` : e.uploadsOpen ? `Uploads ended on ${showDay(e.lastUploadDay)}.` : 'Uploads are closed.'}{' '}
        Photos are kept until {showDay(e.lastKeptDay)} ({e.retentionDays} days after the wedding), then deleted.{' '}
        Suggestions for moderators: {CLASSIFIER_TEXT[e.classifier]}.
      </p>
      <p>{e.counts.live} live, {e.counts.pending} waiting, {e.counts.removed} removed{e.counts.purged > 0 && `, ${e.counts.purged} deleted`}. <a href={`/o/${ctx.slug}/wedding/photos/${e.id}/zip`} download>Download the gallery (zip)</a></p>

      <section aria-label="Upload link">
        <h2>Upload link</h2>
        {link && qr ? (
          <>
            {!e.linkOpen && <p>The link is not working right now: anyone who opens it sees a page-not-found.</p>}
            {/* eslint-disable-next-line @next/next/no-img-element -- an inline data: URL made on the server; nothing to optimise or fetch */}
            <img src={qr} alt={`QR code for the upload link of ${e.name}`} width={220} height={220} />
            <p>Print this code, or share the link: <code>{link}</code></p>
            <p>Anyone with the link can add a photo. It shows them the wedding&apos;s title and this event&apos;s name, and nothing else.</p>
          </>
        ) : <p>The saved link can no longer be read. The printed code still works. To see a link here, replace it; the printed one will then stop working.</p>}
      </section>

      {canManage && (
        <section aria-label="Settings">
          <h2>Settings</h2>
          <ActionForm action={bind(updatePhotoEvent)}>
            <input type="hidden" name="id" value={e.id} />
            <label>Name <input name="name" required maxLength={80} defaultValue={e.name} /></label>
            <label>Moderation <select name="mode" defaultValue={e.mode}><option value="post">Live at once; remove on sight</option><option value="pre">Approve each photo first</option></select></label>
            <label>Uploads stay open this many days after the wedding <input name="uploadDays" inputMode="numeric" required defaultValue={e.uploadDays} /></label>
            <label>Photos are kept this many days after the wedding <input name="retentionDays" inputMode="numeric" required defaultValue={e.retentionDays} /></label>
            <label>Suggestions for moderators <select name="classifier" defaultValue={e.classifier}>{CLASSIFIERS.map((k) => <option key={k} value={k}>{CLASSIFIER_TEXT[k]}</option>)}</select></label>
            <p><small>A suggestion is advice only: it can hold a new photo for a decision, and never approves, removes or publishes one. It runs on this server; no photo is sent anywhere.</small></p>
            <button type="submit">Save event</button>
          </ActionForm>
          <ActionForm action={bind(setPhotoUploads)}>
            <input type="hidden" name="id" value={e.id} />
            <input type="hidden" name="open" value={e.uploadsOpen ? 'closed' : 'open'} />
            <button type="submit">{e.uploadsOpen ? 'Close uploads now' : 'Open uploads again'}</button>
          </ActionForm>
          <ActionForm action={bind(replacePhotoLink)}>
            <input type="hidden" name="id" value={e.id} />
            <label><input type="checkbox" name="confirm" /> Replace the link: the one already handed out stops working</label>
            <button type="submit">Replace the upload link</button>
          </ActionForm>
        </section>
      )}
    </main>
  );
}
