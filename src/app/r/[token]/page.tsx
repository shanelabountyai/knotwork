// public: the RSVP token is the credential (hashed at rest, INV-07); everything shown comes from guests/projection.ts
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { clientIp } from '@/core/http';
import { ACCESSIBILITY, DIETARY, TAG_LABEL } from '@/lib/knotwork/guests/projection';
import { readRsvp } from '@/lib/knotwork/guests/public';

// RULE 3: this page is guest-facing. It renders the RsvpView and nothing else: no list, wave, invite date or state
// exists in that shape. No-store and no-referrer headers come from next.config.ts on /r/:path*.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'RSVP', robots: { index: false, follow: false } };

const NOTE: Record<string, string> = { thanks: 'Thank you. Your reply is saved; you can change it here until the RSVP date.', limited: 'Too many tries. Wait a few minutes and try again.' };

export default async function Rsvp({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string; problem?: string }> }) {
  const { token } = await params;
  const q = await searchParams;
  const view = await readRsvp(token, clientIp(await headers()));
  if (view === 'limited') return <main><h1>Too many requests</h1><p>Wait a few minutes and try again.</p></main>;
  if (!view) notFound();
  return (
    <main>
      <h1>{view.wedding.title}</h1>
      <p>{view.wedding.dateText}</p>
      <p>Dear {view.householdName}, please reply by <strong>{view.rsvpByText}</strong>.</p>
      {q.done && <p role="status">{NOTE.thanks}</p>}
      {q.problem && <p role="alert">{q.problem.slice(0, 200)}</p>}
      <form method="post" action={`/r/${token}/respond`}>
        {view.guests.map((g) => (
          <fieldset key={g.id}>
            <legend>{g.name}</legend>
            <label><input type="radio" name={`attending:${g.id}`} value="yes" defaultChecked={g.rsvp === 'attending'} required /> Will attend</label>
            <label><input type="radio" name={`attending:${g.id}`} value="no" defaultChecked={g.rsvp === 'declined'} /> Cannot attend</label>
            {g.ageGroup === 'adult' && (
              <label>Meal <select name={`meal:${g.id}`} defaultValue={g.meal ?? ''} aria-label={`Meal for ${g.name}`}><option value="">choose</option>{view.mealOptions.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
            )}
            {g.ageGroup === 'child' && <p>A children&apos;s meal is provided.</p>}
            <p>Dietary needs</p>
            {DIETARY.map((d) => <label key={d}><input type="checkbox" name={`dietary:${g.id}`} value={d} defaultChecked={g.dietary.includes(d)} /> {TAG_LABEL[d]}</label>)}
            <p>Access needs</p>
            {ACCESSIBILITY.map((d) => <label key={d}><input type="checkbox" name={`accessibility:${g.id}`} value={d} defaultChecked={g.accessibility.includes(d)} /> {TAG_LABEL[d]}</label>)}
            <label>A song that gets you dancing <input name={`song:${g.id}`} maxLength={120} defaultValue={g.songRequest} /></label>
          </fieldset>
        ))}
        {view.plusOneAllowed && !view.plusOneNamed && <label>You are welcome to bring a guest. Their name <input name="plusOneName" maxLength={120} /></label>}
        <button type="submit">Send reply</button>
      </form>
    </main>
  );
}
