import { inOrg, requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { RELEASE_TEXT, seatsNeeded } from '@/lib/knotwork/guests/backfill';
import { loadGuestState, previewRelease, releaseRules } from '@/lib/knotwork/guests/store';
import { NoWedding, WeddingNav } from '../../bits';
import { view } from '../../view';
import { closeBList, releaseWave, saveGuestPlan } from '../actions';
import { GuestNav } from '../nav';

export const metadata = { title: 'Invitations and cap' };

// PRD P0-4: invite waves against a headcount cap. The preview below is what a release would do right now; pressing
// the button plans again under a lock and invites exactly what fits. Couple-only: none of this ever reaches a guest.
export default async function Waves({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'guests.view', async (tx) => ({
    s: await loadGuestState(tx, ctx),
    a: await previewRelease(tx, ctx, 'A'),
    b: await previewRelease(tx, ctx, 'B'),
    rules: await releaseRules(tx, ctx, 'B'),
    waves: await tx.inviteWave.findMany({ where: inOrg(ctx), orderBy: { number: 'desc' } }),
  }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, s, a, b, rules, waves } = data;
  const canEdit = allows(v.who, 'guests.edit');
  const name = new Map(s.rows.map((h) => [h.id, h.name]));
  const bind = <A extends unknown[], R>(fn: (slug: string, ...x: A) => R) => fn.bind(null, ctx.slug);
  const queued = (list: 'A' | 'B') => s.households.filter((h) => h.state === 'queued' && h.list === list);
  const p = s.plan;

  return (
    <main>
      <WeddingNav slug={ctx.slug} mode={v.wedding.mode} />
      <GuestNav slug={ctx.slug} />
      <h1>Invitations and cap</h1>
      <ul aria-label="Cap">
        <li>Cap: {p.cap} seats. Held: {s.cap.held} ({s.cap.attending} attending, {s.cap.pending} waiting on an answer). Free: {s.cap.available}.</li>
        <li>{s.cap.declined} declined so far. A seat is held from the moment an invitation goes out until that person declines.</li>
        <li>{rules.daysToWedding} days to the wedding. No new B-list invitations inside {p.lockoutDays} days{rules.daysToWedding < p.lockoutDays ? ': that time has come.' : '.'}</li>
      </ul>

      {(['A', 'B'] as const).map((list) => {
        const plan = list === 'A' ? a.plan : b.plan;
        return (
          <section key={list} aria-label={`${list} list`}>
            <h2>{list} list</h2>
            <p>{queued(list).length} households waiting ({queued(list).reduce((n, h) => n + seatsNeeded(h), 0)} seats).</p>
            {plan.reason === 'ok' ? (
              <>
                <p>Ready: {plan.ids.length} households, {plan.seats} seats.</p>
                <ul aria-label={`Next ${list} release`}>{plan.ids.map((id) => <li key={id}>{name.get(id)}</li>)}</ul>
                {canEdit && (
                  <ActionForm action={bind(releaseWave)}>
                    <input type="hidden" name="list" value={list} />
                    <button type="submit">Release the {list} list batch</button>
                  </ActionForm>
                )}
              </>
            ) : (
              <p role="status">{RELEASE_TEXT[plan.reason]}</p>
            )}
          </section>
        );
      })}

      {b.regrets.length > 0 && (
        <section aria-label="Close the B list">
          <h2>Close the B list</h2>
          <p>It is inside {p.lockoutDays} days. The {b.regrets.length} B-list households still waiting will not be invited.</p>
          {canEdit && <ActionForm action={bind(closeBList)}><button type="submit">Mark them as regrets</button></ActionForm>}
        </section>
      )}

      <h2>Releases so far</h2>
      <table aria-label="Waves">
        <thead><tr><th scope="col">Wave</th><th scope="col">List</th><th scope="col">Households</th><th scope="col">Seats</th><th scope="col">Released</th></tr></thead>
        <tbody>{waves.map((w) => <tr key={w.id}><th scope="row">{w.number}</th><td>{w.list}</td><td>{w.householdCount}</td><td>{w.seatCount}</td><td>{w.releasedAt.toISOString().slice(0, 10)}</td></tr>)}</tbody>
      </table>

      {canEdit && (
        <section aria-label="Guest plan">
          <h2>Cap, venue and prices</h2>
          <ActionForm action={bind(saveGuestPlan)}>
            <label>Headcount cap <input name="cap" inputMode="numeric" required defaultValue={p.cap} /></label>
            <label>Venue minimum <input name="venueMin" inputMode="numeric" defaultValue={p.venueMin ?? ''} /></label>
            <label>Venue maximum <input name="venueMax" inputMode="numeric" defaultValue={p.venueMax ?? ''} /></label>
            <label>Per head <input name="perHead" required defaultValue={(p.perHeadCents / 100).toFixed(2)} /></label>
            <label>Kids meal <input name="kidsMeal" required defaultValue={(p.kidsMealCents / 100).toFixed(2)} /></label>
            <label>Vendor meal <input name="vendorMeal" required defaultValue={(p.vendorMealCents / 100).toFixed(2)} /></label>
            <label>No B-list invitations inside this many days <input name="lockoutDays" inputMode="numeric" required defaultValue={p.lockoutDays} /></label>
            <label>Smallest B-list batch, in seats <input name="minBatchSeats" inputMode="numeric" required defaultValue={p.minBatchSeats} /></label>
            <label>Meal options, separated by commas <input name="mealOptions" maxLength={400} defaultValue={p.mealOptions.join(', ')} /></label>
            <label><input type="checkbox" name="autoReminders" defaultChecked={p.autoReminders} /> Send due RSVP reminders on their own, once a day (as well as the button on the chase page)</label>
            <button type="submit">Save</button>
          </ActionForm>
        </section>
      )}
    </main>
  );
}
