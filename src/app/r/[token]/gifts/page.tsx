// public: the RSVP token is the credential (matched by its sha256, INV-07); everything shown comes from gifts/projection.ts
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { clientIp } from '@/core/http';
import { GIFT_DONE, GIFT_PROBLEM, isGiftDone, isGiftProblem } from '@/lib/knotwork/gifts/projection';
import { readGifts } from '@/lib/knotwork/gifts/public';
import { LINK_REL, LINK_TARGET } from '@/lib/knotwork/registry/links';

// RULE 3: this page is guest-facing. It renders the GiftView and nothing else: the registry's items and their
// progress (the same for every household) and this household's own contributions. No list, wave, invite date or state
// exists in that shape, and nothing about any other household. No-store and no-referrer headers come from
// next.config.ts on /r/:path*.
export const dynamic = 'force-dynamic';
export async function generateMetadata({ searchParams }: { searchParams: Promise<{ done?: string; e?: string }> }) {
  const q = await searchParams;
  const title = typeof q.e === 'string' && isGiftProblem(q.e) ? 'Not recorded: Gifts' : typeof q.done === 'string' && isGiftDone(q.done) ? 'Recorded: Gifts' : 'Gifts';
  return { title, robots: { index: false, follow: false } };
}

export default async function Gifts({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string; e?: string }> }) {
  const { token } = await params;
  const q = await searchParams;
  const view = await readGifts(token, clientIp(await headers()));
  if (view === 'limited') return <main><h1>Too many requests</h1><p>Wait a few minutes and try again.</p></main>;
  if (!view) notFound();
  // The query carries a code from a closed list; the sentence comes from here. Unknown codes show nothing.
  const problem = typeof q.e === 'string' && isGiftProblem(q.e) ? GIFT_PROBLEM[q.e] : null;
  const done = typeof q.done === 'string' && isGiftDone(q.done) ? GIFT_DONE[q.done] : null;
  return (
    <main>
      <h1>{view.weddingTitle}: gifts</h1>
      <p>Dear {view.householdName}, these are gifts several people can give toward together. Give any part; if a gift needs less than you offer, the rest comes straight back to you.</p>
      <p>No payment is taken on this page: a contribution is recorded, not charged.</p>
      {done && !problem && <p role="status" tabIndex={-1} autoFocus>{done}</p>}
      {problem && <p role="alert" tabIndex={-1} autoFocus>{problem} Nothing was recorded.</p>}
      {view.items.length === 0 && view.links.length === 0 && <p>There are no gifts on the registry yet.</p>}
      {view.items.map((item) => (
        <section key={item.id} aria-label={item.title}>
          <h2>{item.title}</h2>
          {item.note && <p>{item.note}</p>}
          {item.status === 'open' && <p>{item.raisedText} of {item.targetText} given so far ({item.percent}%); {item.remainingText} to go.</p>}
          {item.status === 'funded' && <p>Fully funded: {item.targetText}. Thank you.</p>}
          {item.status === 'closed' && <p>This gift was closed before it was funded. Everything given toward it was refunded.</p>}
          {item.status === 'open' && <progress max={100} value={item.percent} aria-label={`${item.title}: ${item.percent}% funded`} />}
          {item.yours.length > 0 && (
            <>
              <h3>Your contributions</h3>
              <ul aria-label={`Your contributions to ${item.title}`}>
                {item.yours.map((line, n) => <li key={n}>{line.text}: {line.amountText} ({line.onText})</li>)}
              </ul>
              <p>From you toward this gift in all: {item.yoursText}.</p>
            </>
          )}
          {item.status === 'open' && (
            <form method="post" action={`/r/${token}/gifts/contribute`}>
              <input type="hidden" name="item" value={item.id} />
              <label>Amount in dollars <input name="amount" inputMode="decimal" required maxLength={12} placeholder="25.00" aria-label={`Amount toward ${item.title}, in dollars`} /></label>
              <button type="submit">Give toward {item.title}</button>
            </form>
          )}
        </section>
      ))}
      {view.links.length > 0 && (
        <section aria-label="From a store">
          <h2>From a store</h2>
          <p>These are bought from a store directly. The links open the store in a new tab; nothing is bought or paid here. Once you have bought one, mark it below so nobody else buys the same.</p>
          {view.links.map((l) => (
            <section key={l.id} aria-label={l.title}>
              <h3>{l.title}</h3>
              <p>
                {l.href ? <a href={l.href} target={LINK_TARGET} rel={LINK_REL}>{l.store}</a> : l.store}
                {l.host && <> ({l.host})</>}
                {l.priceText && <>, about {l.priceText}</>}
              </p>
              <p>{l.remaining === 0 ? 'All bought. Thank you.' : `${l.remaining} of ${l.wanted} still wanted.`}</p>
              {l.yours ? (
                <form method="post" action={`/r/${token}/gifts/claim`}>
                  <p>You marked {l.yours.quantity} as bought ({l.yours.onText}).</p>
                  <input type="hidden" name="link" value={l.id} />
                  <input type="hidden" name="op" value="withdraw" />
                  <button type="submit">Take back my mark on {l.title}</button>
                </form>
              ) : l.remaining > 0 && (
                <form method="post" action={`/r/${token}/gifts/claim`}>
                  <input type="hidden" name="link" value={l.id} />
                  <input type="hidden" name="op" value="claim" />
                  <label>How many you bought <input name="quantity" inputMode="numeric" required maxLength={2} defaultValue="1" aria-label={`How many ${l.title} you bought`} /></label>
                  <button type="submit">I bought {l.title}</button>
                </form>
              )}
            </section>
          ))}
        </section>
      )}
      <p><a href={`/r/${token}`}>Back to your RSVP</a></p>
    </main>
  );
}
