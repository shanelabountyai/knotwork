import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { showDay } from '@/lib/knotwork/days';
import { BUCKETS, ledger, noteTemplate, OVERDUE_AFTER_DAYS, showAge, type Obligation } from '@/lib/knotwork/thanks/aging';
import { loadObligations } from '@/lib/knotwork/thanks/store';
import { NoWedding, WeddingNav } from '../../bits';
import { view } from '../../view';
import { acknowledgeClaim, acknowledgeReceivedGift, acknowledgeThankYou, logReceivedGift, removeReceivedGift } from '../actions';
import { GiftNav } from '../nav';

export const metadata = { title: 'Thank-yous' };

const KIND: Record<Obligation['source'], string> = { pooled: 'a group gift', claimed: 'bought from the registry', logged: 'logged by hand' };
const describe = (o: Obligation) => (o.source === 'pooled' ? `toward ${o.what}` : o.what);

// PRD P1-3, the thank-you obligation ledger: one obligation per gift and giver (a pooled gift that funded, a store
// item a household marked as bought, a gift logged here by hand), received → acknowledged. How long each has been owed
// is computed from the day it was received, on every read; nothing about it is stored. A note to start from is shown
// for each: text to copy, never sent. Like the registry, this names who gave and what, never an amount (P0-5).
export default async function ThankYous({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'gifts.view', async (tx) => ({
    all: await loadObligations(tx, ctx),
    households: await tx.household.findMany({ where: { orgId: ctx.orgId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, all, households } = data;
  const canEdit = allows(v.who, 'gifts.edit');
  const book = ledger(all, v.today);
  const signOff = v.partners.map((id) => v.people.get(id) ?? '').filter(Boolean).join(' & ') || v.wedding.title;
  const ack = { pooled: acknowledgeThankYou, claimed: acknowledgeClaim, logged: acknowledgeReceivedGift } as const;
  return (
    <main>
      <WeddingNav slug={ctx.slug} life={v.wedding.mode === 'life'} />
      <GiftNav slug={ctx.slug} />
      <h1>Thank-yous</h1>
      <p><strong aria-label="Overdue thank-yous">{book.headline}</strong></p>
      <p>{book.total === 0 ? 'Nothing yet: a thank-you is owed for each gift you log here, each store item a household marks as bought, and each household that gave toward a gift once that gift is funded.' : `${book.owed.length} of ${book.total} still to send.`}</p>

      <table aria-label="How long thank-yous have been owed">
        <thead><tr><th scope="col">Owed for</th><th scope="col">Still to send</th></tr></thead>
        <tbody>
          {book.buckets.map((b) => <tr key={b.key}><th scope="row">{b.label}</th><td>{b.count}</td></tr>)}
        </tbody>
      </table>
      <p><small>Counted from the day each gift arrived ({BUCKETS.length} buckets; &quot;&gt; 3 weeks&quot; is more than {OVERDUE_AFTER_DAYS} days).</small></p>

      <h2>Still to send, oldest first</h2>
      {book.owed.length === 0 && <p>Every thank-you is sent.</p>}
      <ul aria-label="Thank-yous">
        {book.owed.map((o) => (
          <li key={`${o.source}:${o.id}`} aria-label={`Thank-you to ${o.giver} for ${o.what}`}>
            <strong>{o.giver}</strong>, {describe(o)} ({KIND[o.source]}): received {showDay(o.receivedOn)}, owed {showAge(o.ageDays)}{o.overdue && ', more than 3 weeks'}. Not sent yet.
            <details>
              <summary>A note to start from</summary>
              <pre>{noteTemplate(o, signOff)}</pre>
            </details>
            {canEdit && (
              <ActionForm action={ack[o.source].bind(null, ctx.slug)}>
                <input type="hidden" name="id" value={o.id} />
                <button type="submit">Mark the thank-you to {o.giver} as sent</button>
              </ActionForm>
            )}
            {canEdit && o.source === 'logged' && (
              <ActionForm action={removeReceivedGift.bind(null, ctx.slug)}>
                <input type="hidden" name="id" value={o.id} />
                <button type="submit">Remove the gift from {o.giver} from the log</button>
              </ActionForm>
            )}
          </li>
        ))}
      </ul>

      {book.thanked.length > 0 && (
        <>
          <h2>Sent</h2>
          <ul aria-label="Thank-yous sent">
            {book.thanked.map((o) => (
              <li key={`${o.source}:${o.id}`} aria-label={`Thank-you to ${o.giver} for ${o.what}`}>
                <strong>{o.giver}</strong>, {describe(o)} ({KIND[o.source]}): received {showDay(o.receivedOn)}, sent {showDay(o.acknowledgedOn!)}.
              </li>
            ))}
          </ul>
        </>
      )}

      {canEdit && (
        <>
          <h2>Log a gift</h2>
          <p>For a gift that came another way: by post, at the shower, in person. It joins the list above and is owed a thank-you from the day it arrived.</p>
          <ActionForm action={logReceivedGift.bind(null, ctx.slug)}>
            <label>From a household <select name="householdId" defaultValue="">
              <option value="">(not a household on the guest list)</option>
              {households.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select></label>
            <label>Or from someone else <input name="giverName" maxLength={120} placeholder="Great-aunt Odile" /></label>
            <label>What it was <input name="what" required maxLength={200} placeholder="a set of linen napkins" /></label>
            <label>Received on <input name="receivedOn" type="date" max={v.today} /></label>
            <p>Leave the date empty for today.</p>
            <button type="submit">Log the gift</button>
          </ActionForm>
        </>
      )}
    </main>
  );
}
