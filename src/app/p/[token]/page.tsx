// public: the upload token is the credential (matched by its sha256, INV-07); everything shown comes from photos/projection.ts
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { clientIp } from '@/core/http';
import { isPhotoDone, isPhotoProblem, PHOTO_DONE, PHOTO_PROBLEM } from '@/lib/knotwork/photos/projection';
import { readUploadPage } from '@/lib/knotwork/photos/public';

// RULE 3: this page is guest-facing. It renders the UploadView and nothing else: the wedding's title and the event's
// name. No date, no guest, no household, no list or wave, no other photo, no count. It is the same page for everyone
// who holds the link. No-store and no-referrer headers come from next.config.ts on /p/:path*.
// RULE 4: the form posts to ./upload, which hands the request to src/lib/knotwork/uploads and never touches the file.
export const dynamic = 'force-dynamic';
export async function generateMetadata({ searchParams }: { searchParams: Promise<{ done?: string; e?: string }> }) {
  const q = await searchParams;
  const title = typeof q.e === 'string' && isPhotoProblem(q.e) ? 'Not added: Photos' : typeof q.done === 'string' && isPhotoDone(q.done) ? 'Added: Photos' : 'Add a photo';
  return { title, robots: { index: false, follow: false } };
}
export const viewport = { width: 'device-width', initialScale: 1 };

const field = { display: 'block', width: '100%', boxSizing: 'border-box', fontSize: '1.05rem', padding: '0.7rem', margin: '0.3rem 0 1rem' } as const;

export default async function AddPhoto({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string; e?: string }> }) {
  const { token } = await params;
  const q = await searchParams;
  const view = await readUploadPage(token, clientIp(await headers()));
  if (view === 'limited') return <main><h1>Too many requests</h1><p>Wait a few minutes and try again.</p></main>;
  if (!view) notFound();
  // The query carries a code from a closed list; the sentence comes from here. Unknown codes show nothing.
  const problem = typeof q.e === 'string' && isPhotoProblem(q.e) ? PHOTO_PROBLEM[q.e] : null;
  const done = typeof q.done === 'string' && isPhotoDone(q.done) ? PHOTO_DONE[q.done] : null;
  return (
    <main style={{ maxWidth: '30rem', margin: '0 auto' }}>
      <h1>{view.weddingTitle}</h1>
      <p>Add a photo to <strong>{view.eventName}</strong>.</p>
      {done && !problem && <p role="status" tabIndex={-1} autoFocus>{done} Add another if you like.</p>}
      {problem && <p role="alert" tabIndex={-1} autoFocus>{problem} Nothing was added.</p>}
      <form method="post" action={`/p/${token}/upload`} encType="multipart/form-data">
        <label>Photo (take one, or choose one from your gallery)
          <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required style={field} />
        </label>
        <label>Your name (optional)
          <input name="name" maxLength={60} autoComplete="name" style={field} />
        </label>
        <label>Caption (optional)
          <input name="caption" maxLength={200} style={field} />
        </label>
        <button type="submit" style={{ ...field, fontWeight: 'bold' }}>Add photo</button>
      </form>
      <p><small>JPEG, PNG or WebP, up to 10 MB. Where and when the photo was taken, and anything else stored inside the file, is removed before it is kept.</small></p>
    </main>
  );
}
