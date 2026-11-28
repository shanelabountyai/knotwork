import Link from 'next/link';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { heldSeats } from '@/lib/knotwork/guests/backfill';
import { venueStatus } from '@/lib/knotwork/guests/headcount';
import { loadGuestState } from '@/lib/knotwork/guests/store';
import { usd } from '@/lib/knotwork/money';
import { NoWedding, WeddingNav } from '../bits';
import { view } from '../view';
import { addHousehold } from './actions';
import { GuestNav } from './nav';

export const metadata = { title: 'Guests' };
const VENUE = { unset: 'no venue limits set', 'below-min': 'below the venue minimum', ok: 'within the venue limits', 'over-max': 'over the venue maximum' } as const;

// PRD P0-3: households are invited, individuals answer; the headcount and its cost are recomputed on every request.
// This page is for the couple. Nothing here is guest-facing (rule 3): lists and waves appear only on couple pages.
export default async function Guests({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'guests.view', async (tx) => ({
    s: await loadGuestState(tx, ctx),
    deltas: await tx.headcountDelta.findMany({ where: inOrg(ctx), orderBy: { at: 'desc' }, take: 15 }),
  }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, s, deltas } = data;
  const canEdit = allows(v.who, 'guests.edit');
  return (
    <main>
      <WeddingNav slug={ctx.slug} mode={v.wedding.mode} />
      <GuestNav slug={ctx.slug} />
      <h1>Guests</h1>
      <section aria-label="Headcount">
        <h2>Headcount</h2>
        <ul aria-label="Headcount summary">
          <li>{s.count.attending} attending ({s.count.adults} adults, {s.count.kids} children, {s.count.infants} infants), {s.count.declined} declined, {s.count.pending} not answered</li>
          <li>{s.count.responded} of {s.count.invited} invited have answered ({s.count.responseRatePct}%)</li>
          <li>{s.cap.held} of {s.plan.cap} seats held, {s.cap.available} free</li>
          <li>Cost so far: {usd(s.costCents)} ({s.count.catererMeals} meals: {s.count.adults} adult, {s.count.kids} kids, {s.count.vendorMeals} vendor)</li>
          <li>Venue: {VENUE[venueStatus(s.count.attending, s.plan.venueMin, s.plan.venueMax)]}{s.plan.venueMin !== null && ` (minimum ${s.plan.venueMin})`}{s.plan.venueMax !== null && ` (maximum ${s.plan.venueMax})`}</li>
        </ul>
        <h3>What changed</h3>
        <ul aria-label="Headcount changes">
          {deltas.length === 0 && <li>No replies yet.</li>}
          {deltas.map((d) => (
            <li key={d.id}>{d.label}: {d.deltaCents === 0 ? 'no change in cost' : `${d.deltaCents < 0 ? '−' : '+'}${usd(Math.abs(d.deltaCents))}`} ({d.attendingAfter} attending, {usd(d.costAfterCents)})</li>
          ))}
        </ul>
      </section>

      <table aria-label="Households">
        <thead><tr><th scope="col">Household</th><th scope="col">List</th><th scope="col">Invitation</th><th scope="col">People</th><th scope="col">Answers</th><th scope="col">Seats held</th></tr></thead>
        <tbody>
          {s.rows.map((h, i) => {
            const people = h.guests.filter((g) => !g.removedAt);
            const by = (r: string) => people.filter((g) => g.rsvp === r).length;
            return (
              <tr key={h.id} aria-label={`Household ${h.name}`}>
                <th scope="row"><Link href={`/o/${ctx.slug}/wedding/guests/${h.id}`}>{h.name}</Link></th>
                <td>{h.list}</td><td>{h.state === 'invited' ? 'invited' : h.state === 'regrets' ? 'not invited (regrets)' : 'waiting'}</td><td>{people.length}</td>
                <td>{h.state === 'invited' ? `${by('attending')} yes, ${by('declined')} no, ${by('pending')} waiting` : ''}</td><td>{heldSeats(s.households[i]!)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {canEdit && (
        <>
          <h2>Add a household</h2>
          <ActionForm action={addHousehold.bind(null, ctx.slug)}>
            <label>Household name <input name="name" required maxLength={120} placeholder="The Lindqvists" /></label>
            <label>Email <input name="email" type="email" maxLength={200} /></label>
            <label>Phone <input name="phone" maxLength={40} /></label>
            <label>Address <input name="address1" maxLength={200} /></label>
            <label>City <input name="city" maxLength={80} /></label>
            <label>State or region <input name="region" maxLength={80} /></label>
            <label>Postal code <input name="postal" maxLength={20} /></label>
            <label>List <select name="list" aria-label="List for the new household"><option value="A">A</option><option value="B">B</option></select></label>
            <label>Priority (lower goes first) <input name="priority" inputMode="numeric" defaultValue={100} /></label>
            <button type="submit">Add household</button>
          </ActionForm>
        </>
      )}
    </main>
  );
}
