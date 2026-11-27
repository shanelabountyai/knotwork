import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { SEATING_LIMITS } from '@/lib/knotwork/seating/engine';
import { loadSeating, problemsText, SEED_MAX, TABLE_NAME_MAX } from '@/lib/knotwork/seating/store';
import { NoWedding, WeddingNav } from '../../bits';
import { view } from '../../view';
import { Status } from '@/app/ui/kw';
import { GuestNav } from '../nav';
import { addSeatingRule, addSeatingTable, clearUnlockedSeats, generateSeatingChart, lockSeat, moveSeatedGuest, removeSeatingRule, removeSeatingTable, seatPendingGuests, updateSeatingTable } from './actions';

export const metadata = { title: 'Seating' };

// PRD P1-5, the seating chart: tables with how many they seat, pairs of guests who must (or would like to) sit apart
// or together, and households kept together where they fit. "Generate" drafts a seating, scores it and improves it
// (src/lib/knotwork/seating/engine.ts); locked seats stay where they are. A move by hand locks the seat. When the
// "must" rules cannot all be kept, nothing changes and the page says which rules collide. Guest list only: never on a
// guest-facing page (rule 3).
export default async function Seating({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ arrangement?: string }> }) {
  const ctx = await requireOrg((await params).org);
  const q = await searchParams;
  const data = await view(ctx, 'guests.view', async (tx) => ({ s: await loadSeating(tx, ctx) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, s } = data;
  const canEdit = allows(v.who, 'guests.edit');
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  const arrangement = /^\d{1,6}$/.test(q.arrangement ?? '') ? Number(q.arrangement) : 1;
  const unseated = s.guests.filter((g) => !s.seats[g.id]);
  const at = (tableId: string) => s.guests.filter((g) => s.seats[g.id]?.tableId === tableId);
  const problems = problemsText(s);
  const hardCount = s.score.violations.filter((x) => x.hard).length;
  const seatsTotal = s.tables.reduce((n, t) => n + t.capacity, 0);

  const MoveForm = ({ guestId, name, current }: { guestId: string; name: string; current: string | null }) => (
    <ActionForm action={bind(moveSeatedGuest)}>
      <input type="hidden" name="guestId" value={guestId} />
      <label>Move {name} to{' '}
        <select name="tableId" defaultValue={current ?? ''}>
          <option value="">No table</option>
          {s.tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>{' '}
      <button type="submit" className="secondary" aria-label={`Move ${name}`}>Move</button>
    </ActionForm>
  );

  return (
    <main>
      <WeddingNav who={v.who} slug={ctx.slug} mode={v.wedding.mode} />
      <GuestNav slug={ctx.slug} />
      <h1>Seating</h1>
      <p aria-label="Seating summary" className="kw-lede">
        {Object.keys(s.seats).length} of {s.guests.length} guests seated at {s.tables.length} {s.tables.length === 1 ? 'table' : 'tables'} ({seatsTotal} seats).{' '}
        {s.seatPending ? 'Guests who have not answered are seated too.' : `Guests who are coming are seated; ${s.waiting} who have not answered are not.`}
      </p>
      <section aria-label="Score">
        <h2>Score: {s.score.total === 0 ? '0 (nothing to improve)' : s.score.hard ? `${s.score.hard} ${s.score.hard === 1 ? 'problem' : 'problems'} with "must" rules, ${s.score.soft} preference points` : `${s.score.soft} preference points`}</h2>
        <p><small>Lower is better. A broken &quot;must&quot; rule or a guest with no seat is a problem; a broken &quot;would like&quot; costs 3 points, and each household member sitting away from the rest of the household costs 2.</small></p>
        {problems.length > 0 && <ul aria-label="Seating problems" className="kw-plain kw-rows">{problems.map((p, n) => <li key={n}>{n < hardCount ? <><Status k="late">problem</Status> <strong>{p}</strong></> : <><Status k="wait">preference</Status> {p}</>}</li>)}</ul>}
      </section>

      {canEdit && (
        <section aria-label="Generate" className="kw-generate">
          <h2>Generate</h2>
          <ActionForm action={bind(generateSeatingChart)}>
            <label>Arrangement number <input name="seed" inputMode="numeric" defaultValue={arrangement} maxLength={6} size={6} /></label>{' '}
            <button type="submit">Generate seating</button>
          </ActionForm>
          <ActionForm action={bind(generateSeatingChart)}>
            <input type="hidden" name="seed" value={arrangement >= SEED_MAX ? 1 : arrangement + 1} />
            <button type="submit" className="secondary">Try another arrangement</button>
          </ActionForm>
          <p><small>Locked seats stay where they are; everyone else is seated again. The same arrangement number on the same chart always gives the same seating.</small></p>
          <ActionForm action={bind(seatPendingGuests)}>
            <input type="hidden" name="on" value={s.seatPending ? '' : 'on'} />
            <button type="submit" className="secondary">{s.seatPending ? 'Seat only guests who are coming' : 'Also seat guests who have not answered'}</button>
          </ActionForm>
          {Object.values(s.seats).some((x) => !x.locked) && <ActionForm action={bind(clearUnlockedSeats)}><button type="submit" className="secondary">Clear unlocked seats</button></ActionForm>}
        </section>
      )}

      <h2>Tables</h2>
      {s.tables.length === 0 && <p>No tables yet.</p>}
      <div className="kw-tables">
      {s.tables.map((t) => {
        const here = at(t.id);
        return (
          <section key={t.id} aria-label={`Table ${t.name}`}>
            <h3>{t.name} <small>({here.length} of {t.capacity})</small></h3>
            <ul className="kw-plain kw-rows">
              {here.length === 0 && <li>Nobody yet.</li>}
              {here.map((g) => (
                <li key={g.id}>
                  {g.name} <small>({g.householdName}{g.rsvp === 'pending' ? ', not answered' : ''})</small>{s.seats[g.id]!.locked && <> <Status k="info">locked</Status></>}
                  {canEdit && (
                    <>
                      <MoveForm guestId={g.id} name={g.name} current={t.id} />
                      <ActionForm action={bind(lockSeat)}>
                        <input type="hidden" name="guestId" value={g.id} />
                        <input type="hidden" name="locked" value={s.seats[g.id]!.locked ? '' : 'on'} />
                        <button type="submit" className="ghost" aria-label={`${s.seats[g.id]!.locked ? 'Unlock' : 'Lock'} ${g.name}`}>{s.seats[g.id]!.locked ? 'Unlock' : 'Lock'}</button>
                      </ActionForm>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {canEdit && (
              <details>
                <summary>Change {t.name}</summary>
                <ActionForm action={bind(updateSeatingTable)}>
                  <input type="hidden" name="id" value={t.id} />
                  <label>Name <input name="name" defaultValue={t.name} required maxLength={TABLE_NAME_MAX} /></label>
                  <label>Seats <input name="capacity" inputMode="numeric" defaultValue={t.capacity} required /></label>
                  <button type="submit">Save table</button>
                </ActionForm>
                <ActionForm action={bind(removeSeatingTable)}>
                  <input type="hidden" name="id" value={t.id} />
                  <button type="submit" className="secondary">Remove {t.name}</button>
                </ActionForm>
              </details>
            )}
          </section>
        );
      })}
      </div>

      <section aria-label="Not seated">
        <h2>Not seated</h2>
        {unseated.length === 0 ? <p>Everyone is seated.</p> : (
          <ul className="kw-plain kw-rows">
            {unseated.map((g) => (
              <li key={g.id}>{g.name} <small>({g.householdName}{g.rsvp === 'pending' ? ', not answered' : ''})</small>{canEdit && s.tables.length > 0 && <MoveForm guestId={g.id} name={g.name} current={null} />}</li>
            ))}
          </ul>
        )}
      </section>

      {canEdit && (
        <>
          <h2>Add a table</h2>
          <ActionForm action={bind(addSeatingTable)}>
            <label>Name <input name="name" required maxLength={TABLE_NAME_MAX} placeholder="Table 1" /></label>
            <label>Seats <input name="capacity" inputMode="numeric" required defaultValue={8} /></label>
            <button type="submit">Add table</button>
          </ActionForm>
          <p><small>Up to {SEATING_LIMITS.tables} tables, each seating 1 to {SEATING_LIMITS.capacity}.</small></p>
        </>
      )}

      <section aria-label="Rules">
        <h2>Who sits apart, who sits together</h2>
        {s.rules.length === 0 ? <p>No rules yet. Households are kept together where they fit.</p> : (
          <ul aria-label="Seating rules" className="kw-plain kw-rows">
            {s.rules.map((r) => (
              <li key={r.id}>
                {r.a.name} and {r.b.name} {r.hard ? 'must' : 'would like to'} sit {r.kind}{!r.active && <small> (waits: one of them is not being seated)</small>}
                {canEdit && <ActionForm action={bind(removeSeatingRule)}><input type="hidden" name="id" value={r.id} /><button type="submit" className="ghost" aria-label={`Remove the rule for ${r.a.name} and ${r.b.name}`}>Remove</button></ActionForm>}
              </li>
            ))}
          </ul>
        )}
        {canEdit && s.ruleOptions.length >= 2 && (
          <ActionForm action={bind(addSeatingRule)}>
            <label>Guest <select name="a" required>{s.ruleOptions.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>{' '}
            <label>and <select name="b" required defaultValue={s.ruleOptions[1]!.id}>{s.ruleOptions.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>{' '}
            <label>sit <select name="kind" defaultValue="apart"><option value="apart">apart</option><option value="together">together</option></select></label>{' '}
            <label><input type="checkbox" name="hard" defaultChecked /> A must (otherwise a wish)</label>{' '}
            <button type="submit">Add rule</button>
          </ActionForm>
        )}
      </section>
    </main>
  );
}
