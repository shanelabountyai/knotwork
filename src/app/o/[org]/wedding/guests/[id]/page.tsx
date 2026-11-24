import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows, isPartner } from '@/lib/knotwork/access';
import { dayOfDb, showDay } from '@/lib/knotwork/days';
import { heldSeats } from '@/lib/knotwork/guests/backfill';
import { entitlement } from '@/lib/knotwork/guests/plus-one';
import { ACCESSIBILITY, DIETARY, TAG_LABEL } from '@/lib/knotwork/guests/projection';
import { loadPlan, toIn } from '@/lib/knotwork/guests/store';
import { NoWedding, WeddingNav } from '../../bits';
import { view } from '../../view';
import { addGuest, markSaveTheDate, proposeGuestRemoval, recordRsvp, showRsvpLink, updateGuest, updateHousehold } from '../actions';
import { GuestNav } from '../nav';

export const metadata = { title: 'Household' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTNER = { none: 'no partner listed', dating: 'dating', long_distance: 'travelling a long way', engaged: 'engaged', married: 'married' } as const;

// One household: the invitation unit. Its people answer one by one. The plus-one line shows the rule that decided it.
export default async function HouseholdPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const data = await view(ctx, 'guests.view', async (tx) => ({
    h: await tx.household.findFirst({ where: { id, ...inOrg(ctx) }, include: { guests: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, wave: { select: { number: true } } } }),
    plan: await loadPlan(tx, ctx),
  }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, h, plan } = data;
  if (!h) notFound();
  const canEdit = allows(v.who, 'guests.edit');
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  const core = toIn(h);
  const plus = entitlement(core);
  const people = h.guests.filter((g) => !g.removedAt);

  return (
    <main>
      <WeddingNav slug={ctx.slug} />
      <GuestNav slug={ctx.slug} />
      <h1>{h.name}</h1>
      <p aria-label="Invitation status">
        {h.list} list · {h.state === 'invited' ? `invited ${showDay(dayOfDb(h.invitedOn!))}${h.wave ? ` in wave ${h.wave.number}` : ''}` : h.state === 'regrets' ? 'not invited (regrets)' : 'waiting to be invited'} · holds {heldSeats(core)} seats
        {h.saveTheDateSentOn && <> · save-the-date sent {showDay(dayOfDb(h.saveTheDateSentOn))}</>}
      </p>
      <p aria-label="Plus-one">Guest: <strong>{plus.entitled ? 'yes' : 'no'}</strong>. {plus.reason}</p>

      {canEdit && h.state === 'invited' && (
        <ActionForm action={bind(showRsvpLink)}>
          <input type="hidden" name="id" value={h.id} />
          <button type="submit">Show the RSVP link</button>
        </ActionForm>
      )}
      {canEdit && !h.saveTheDateSentOn && (
        <ActionForm action={bind(markSaveTheDate)}>
          <input type="hidden" name="id" value={h.id} />
          <button type="submit">Mark save-the-date as sent</button>
        </ActionForm>
      )}

      <h2>People</h2>
      {people.map((g) => (
        <article key={g.id} aria-label={`Guest ${g.name}`}>
          <h3>{g.name}{g.isPlusOne && ' (their guest)'}</h3>
          <p>{g.ageGroup} · {PARTNER[g.partnerStatus]}{g.inWeddingParty && ' · wedding party'} · <strong>{g.rsvp === 'pending' ? 'has not answered' : g.rsvp}</strong>{g.meal && ` · ${g.meal}`}{g.dietary.length > 0 && ` · ${g.dietary.map((d) => TAG_LABEL[d]).join(', ')}`}{g.accessibility.length > 0 && ` · ${g.accessibility.map((d) => TAG_LABEL[d]).join(', ')}`}{g.songRequest && ` · song: ${g.songRequest}`}</p>
          {canEdit && h.state === 'invited' && (
            <ActionForm action={bind(recordRsvp)}>
              <input type="hidden" name="id" value={g.id} />
              <select name="rsvp" defaultValue={g.rsvp} aria-label={`Answer for ${g.name}`}><option value="pending">has not answered</option><option value="attending">attending</option><option value="declined">declined</option></select>
              {g.ageGroup === 'adult' && <select name="meal" defaultValue={g.meal ?? ''} aria-label={`Meal for ${g.name}`}><option value="">no meal chosen</option>{plan.mealOptions.map((m) => <option key={m} value={m}>{m}</option>)}</select>}
              {DIETARY.map((d) => <label key={d}><input type="checkbox" name="dietary[]" value={d} defaultChecked={g.dietary.includes(d)} /> {TAG_LABEL[d]}</label>)}
              {ACCESSIBILITY.map((d) => <label key={d}><input type="checkbox" name="accessibility[]" value={d} defaultChecked={g.accessibility.includes(d)} /> {TAG_LABEL[d]}</label>)}
              <label>Song request <input name="songRequest" maxLength={120} defaultValue={g.songRequest} /></label>
              <button type="submit">Record answer</button>
            </ActionForm>
          )}
          {canEdit && (
            <ActionForm action={bind(updateGuest)}>
              <input type="hidden" name="id" value={g.id} />
              <label>Name <input name="name" required maxLength={120} defaultValue={g.name} /></label>
              <select name="ageGroup" defaultValue={g.ageGroup} aria-label={`Age group of ${g.name}`}><option value="adult">adult</option><option value="child">child</option><option value="infant">infant</option></select>
              <select name="partnerStatus" defaultValue={g.partnerStatus} aria-label={`Partner of ${g.name}`}>{Object.entries(PARTNER).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
              <label><input type="checkbox" name="inWeddingParty" defaultChecked={g.inWeddingParty} /> Wedding party</label>
              <label>Private note <input name="privateNote" maxLength={500} defaultValue={g.privateNote} /></label>
              <button type="submit">Save</button>
            </ActionForm>
          )}
          {isPartner(ctx.role) && (
            <ActionForm action={bind(proposeGuestRemoval)}>
              <input type="hidden" name="id" value={g.id} />
              <button type="submit">Propose removing {g.name}</button>
            </ActionForm>
          )}
        </article>
      ))}
      {h.guests.some((g) => g.removedAt) && <p>Removed: {h.guests.filter((g) => g.removedAt).map((g) => g.name).join(', ')}.</p>}

      {canEdit && h.state !== 'regrets' && (
        <>
          <h2>Add a person</h2>
          <ActionForm action={bind(addGuest)}>
            <input type="hidden" name="householdId" value={h.id} />
            <label>Name <input name="name" required maxLength={120} /></label>
            <select name="ageGroup" aria-label="Age group of the new person"><option value="adult">adult</option><option value="child">child</option><option value="infant">infant</option></select>
            <select name="partnerStatus" aria-label="Partner of the new person">{Object.entries(PARTNER).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
            <label><input type="checkbox" name="inWeddingParty" /> Wedding party</label>
            <button type="submit">Add person</button>
          </ActionForm>
        </>
      )}

      {canEdit && (
        <>
          <h2>Household details</h2>
          <ActionForm action={bind(updateHousehold)}>
            <input type="hidden" name="id" value={h.id} />
            <label>Household name <input name="name" required maxLength={120} defaultValue={h.name} /></label>
            <label>Email <input name="email" type="email" maxLength={200} defaultValue={h.email} /></label>
            <label>Phone <input name="phone" maxLength={40} defaultValue={h.phone} /></label>
            <label>Address <input name="address1" maxLength={200} defaultValue={h.address1} /></label>
            <label>City <input name="city" maxLength={80} defaultValue={h.city} /></label>
            <label>State or region <input name="region" maxLength={80} defaultValue={h.region} /></label>
            <label>Postal code <input name="postal" maxLength={20} defaultValue={h.postal} /></label>
            <label>List <select name="list" defaultValue={h.list} aria-label="List"><option value="A">A</option><option value="B">B</option></select></label>
            <label>Priority (lower goes first) <input name="priority" inputMode="numeric" defaultValue={h.priority} /></label>
            <label>Guest override <select name="plusOneOverride" defaultValue={h.plusOneOverride ?? ''} aria-label="Guest override"><option value="">follow the rules</option><option value="grant">give them a guest</option><option value="deny">no guest</option></select></label>
            <label>Why <input name="plusOneNote" maxLength={300} defaultValue={h.plusOneNote} /></label>
            <button type="submit">Save household</button>
          </ActionForm>
        </>
      )}
    </main>
  );
}
