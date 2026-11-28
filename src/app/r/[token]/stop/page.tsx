// public: the RSVP token is the credential (the household's own link, D-46); everything shown comes from guests/projection.ts (stopView)
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { clientIp } from '@/core/http';
import { readStop } from '@/lib/knotwork/guests/public';
import { GuestHead } from '@/app/ui/kw';

// RULE 3: guest-facing. The opt-out page every reminder links to (Phase 5). It shows the wedding's title and fixed
// sentences, the same for every household: nothing about the household, its list or whether it already stopped.
// Opening it changes nothing (a mail scanner may open links); the button posts to /r/[token]/stop/confirm.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Stop reminders', robots: { index: false, follow: false } };

export default async function StopReminders({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string }> }) {
  const { token } = await params;
  const done = (await searchParams).done === '1';
  const view = await readStop(token, clientIp(await headers()));
  if (view === 'limited') return <main className="guest"><h1>Too many requests</h1><p>Wait a few minutes and try again.</p></main>;
  if (!view) notFound();
  return (
    <main className="guest">
      <GuestHead title={view.weddingTitle} />
      {done ? (
        <p role="status" tabIndex={-1} autoFocus>Reminders are stopped. You will not get another one. You can still reply using the link in your invitation.</p>
      ) : (
        <>
          <p>Stop the reminders about replying to this invitation? You can still reply using the link in your invitation.</p>
          <form method="post" action={`/r/${token}/stop/confirm`}>
            <button type="submit">Stop reminders</button>
          </form>
        </>
      )}
    </main>
  );
}
