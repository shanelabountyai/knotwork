import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { isRealDay, showDay } from '@/lib/knotwork/days';
import { usd } from '@/lib/knotwork/money';
import { insuranceView } from '@/lib/knotwork/secrecy/views';
import { HiddenText, NoWedding, WeddingNav } from '../../bits';
import { nameOf, view } from '../../view';

export const metadata = { title: 'Moving the date: insurance and contracts' };

// Phase 5: plain information for a couple thinking about moving the date, linked from the date-move preview. General
// questions to take to a vendor or an insurer, and the couple's own facts from the app (signed contracts, payments
// made and due, what the move would leave late). Every fact is read through secrecy/views.ts (insuranceView), so a
// private item is a masked line. No prices, no insurers, no statistics: nothing here is invented or a recommendation.
export default async function Insurance({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ to?: string }> }) {
  const ctx = await requireOrg((await params).org);
  const to = ((await searchParams).to ?? '').trim();
  const data = await view(ctx, 'consent.propose', async (tx, v) => ({ facts: await insuranceView(tx, ctx, v, isRealDay(to) && to !== v.date ? to : null) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, facts } = data;
  const { signed, paid, due, spends, move } = facts;
  const hiddenNote = (n: number) => (n ? ` (including ${n} private ${n === 1 ? 'item' : 'items'}, counted but not named)` : '');
  const back = `/o/${ctx.slug}/wedding/date${move ? `?to=${move.to}` : ''}`;
  return (
    <main>
      <WeddingNav slug={ctx.slug} />
      <h1>Moving the date: insurance and contracts</h1>
      <p role="note"><strong>General information, not insurance or legal advice.</strong> Policies and contracts differ. What yours say is what counts; read the wording, and ask the vendor or the insurer when something is unclear. Nothing here is a quote, an offer or a recommendation of any company.</p>
      <p><Link href={back}>Back to the date move</Link></p>

      <section aria-label="Your facts">
        <h2>Your facts, from this app</h2>
        <p>The wedding is on <strong>{showDay(v.date)}</strong>.{move && <> You are looking at a move to <strong>{showDay(move.to)}</strong> ({Math.abs(move.deltaDays)} days {move.deltaDays > 0 ? 'later' : 'earlier'}).</>}</p>

        <h3>Signed contracts</h3>
        {signed.length === 0 ? <p>No contract is recorded as signed.</p> : (
          <ul aria-label="Signed contracts">
            {signed.map((x, i) => x.hidden
              ? <li key={`h${i}`}><HiddenText h={x} owner={nameOf(v, x.owner)} /></li>
              : <li key={x.row.id}>{x.row.name} ({x.row.category}): signed {showDay(x.row.signedOn)}{x.row.contractTotalCents !== null && <>, contract total {usd(x.row.contractTotalCents)}</>}</li>)}
          </ul>
        )}

        <h3>Payments already made</h3>
        <p>{usd(paid.totalCents)} on the vendors&apos; payment schedules{hiddenNote(paid.hidden)}.</p>
        {paid.lines.length > 0 && (
          <ul aria-label="Payments made">
            {paid.lines.map((l, i) => l.hidden
              ? <li key={`h${i}`}><HiddenText h={l} owner={nameOf(v, l.owner)} /></li>
              : <li key={i}>{l.row.vendor}: {l.row.label}, {usd(l.row.amountCents)}, paid {showDay(l.row.paidOn!)}</li>)}
          </ul>
        )}
        {spends.lines.length > 0 && (
          <>
            <p>Other money recorded against a vendor: {usd(spends.totalCents)}{hiddenNote(spends.hidden)}.</p>
            <ul aria-label="Other money paid to vendors">
              {spends.lines.map((l, i) => l.hidden
                ? <li key={`h${i}`}><HiddenText h={l} owner={nameOf(v, l.owner)} /></li>
                : <li key={l.row.id}>{l.row.vendorName}: {l.row.description}, {usd(l.row.amountCents)}, paid {showDay(l.row.paidOnDay)}</li>)}
            </ul>
          </>
        )}

        <h3>Payments still due</h3>
        <p>{usd(due.totalCents)} still to pay on the vendors&apos; payment schedules{hiddenNote(due.hidden)}. Due dates count back from the current wedding date.</p>
        {due.lines.length > 0 && (
          <ul aria-label="Payments due">
            {due.lines.map((l, i) => l.hidden
              ? <li key={`h${i}`}><HiddenText h={l} owner={nameOf(v, l.owner)} /></li>
              : <li key={i}>{l.row.vendor}: {l.row.label}, {usd(l.row.amountCents)}, due {showDay(l.row.due)}</li>)}
          </ul>
        )}

        <h3>What the move would leave late or impossible</h3>
        {!move ? <p>Pick a new date on the <Link href={`/o/${ctx.slug}/wedding/date`}>date move page</Link> and follow its link here to see this.</p> : (
          <>
            {move.late.length === 0 && move.impossible.length === 0 && <p>Nothing: every task still fits.</p>}
            {move.late.length > 0 && <ul aria-label="Late after the move">{move.late.map((t, i) => <li key={i}>{t.title}: due {showDay(t.due)}{t.isNew ? ' (new)' : ''}</li>)}</ul>}
            {move.impossible.length > 0 && <ul aria-label="Impossible after the move">{move.impossible.map((t, i) => <li key={i}>{t.title}: cannot be finished by {showDay(t.due)}{t.isNew ? ' (new)' : ''}</li>)}</ul>}
          </>
        )}
      </section>

      <section aria-label="Contracts">
        <h2>What vendor contracts commonly say about a new date</h2>
        <ul>
          <li><strong>Postponement or rescheduling.</strong> Some contracts let you move the date once, or within a window, if the vendor is free on the new day; some charge for it; some treat a move as a cancellation.</li>
          <li><strong>Cancellation and refunds.</strong> Look for what happens to money already paid, and whether what is owed changes the closer you are to the date.</li>
          <li><strong>Deposits and retainers.</strong> Often described as non-refundable, but sometimes transferable to a new date.</li>
          <li><strong>Events outside anyone&apos;s control</strong> (often called force majeure). What counts, who decides, and whether it covers a postponement as well as a cancellation.</li>
          <li><strong>Availability.</strong> Whether the vendor must hold the new date, and what happens if they cannot.</li>
          <li><strong>Notice.</strong> How, and by when, a change has to be asked for in writing.</li>
        </ul>
      </section>

      <section aria-label="Insurance">
        <h2>What wedding insurance commonly addresses</h2>
        <p>Policies vary a great deal, and many people do not have one. Where a policy exists, its wording usually sets out:</p>
        <ul>
          <li>which reasons for cancelling or postponing are covered, and which are excluded (a change of heart is commonly excluded);</li>
          <li>whether money lost to a vendor who fails to deliver, or goes out of business, is covered;</li>
          <li>whether extra costs of moving the date (new fees, re-printing, travel changes) are covered;</li>
          <li>damage or loss of things such as attire, rings, gifts or rented items;</li>
          <li>liability for injury or damage at the venue, which some venues ask to see proof of;</li>
          <li>when cover starts, and whether anything already known when it was bought is excluded.</li>
        </ul>
      </section>

      <section aria-label="Questions">
        <h2>Questions to ask</h2>
        <h3>A vendor</h3>
        <ul>
          <li>Can we move to the new date, and are you free that day?</li>
          <li>Does what we have paid carry over to the new date? Is there a fee for moving?</li>
          <li>Does the payment schedule move with the date, or stay as it is?</li>
          <li>Would anything we agreed change (what is included, times, prices)?</li>
          <li>Can you confirm the change in writing?</li>
        </ul>
        <h3>An insurer, or whoever sold you a policy</h3>
        <ul>
          <li>Is our reason for moving the date covered under the policy wording?</li>
          <li>Does the policy follow the wedding to the new date, or does it need changing?</li>
          <li>What evidence would a claim need (contracts, receipts, letters from vendors)?</li>
          <li>Are there deadlines for telling you, or for making a claim?</li>
          <li>What is excluded that we should know about before deciding?</li>
        </ul>
      </section>
    </main>
  );
}
