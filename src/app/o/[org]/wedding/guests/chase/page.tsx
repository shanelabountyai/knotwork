import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { showDay } from '@/lib/knotwork/days';
import { CADENCE_DAYS, CALL_FROM_DAYS } from '@/lib/knotwork/guests/chase';
import { CHANNEL_TEXT } from '@/lib/knotwork/guests/delivery';
import { loadChase, loadGuestState, loadPlan } from '@/lib/knotwork/guests/store';
import { NoWedding, WeddingNav } from '../../bits';
import { view } from '../../view';
import { markCalled, sendReminders } from '../actions';
import { Status, TableWrap } from '@/app/ui/kw';
import { GuestNav } from '../nav';

export const metadata = { title: 'Chasing RSVPs' };

// PRD P0-3 (bride review #2): reminders by cadence, then a call-personally worklist as the RSVP deadline approaches.
// The deadline is derived: the earliest booked vendor's count deadline minus the chase buffer.
export default async function Chase({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'guests.view', async (tx) => ({ chase: await loadChase(tx, ctx), s: await loadGuestState(tx, ctx), plan: await loadPlan(tx, ctx) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, chase, s, plan } = data;
  const canEdit = allows(v.who, 'guests.edit');
  const by = new Map(chase.nonResponders.map((h) => [h.id, h]));
  return (
    <main>
      <WeddingNav who={v.who} slug={ctx.slug} mode={v.wedding.mode} />
      <GuestNav slug={ctx.slug} />
      <h1>Chasing RSVPs</h1>
      <ul aria-label="Chase summary" className="card kw-plain kw-rows">
        <li>RSVPs are due <strong>{showDay(chase.deadline)}</strong>: {chase.daysLeft >= 0 ? `${chase.daysLeft} days from now` : `${-chase.daysLeft} days ago`}.</li>
        <li>{s.count.responded} of {s.count.invited} invited have answered ({s.count.responseRatePct}%). {chase.nonResponders.length} households still owe an answer.</li>
        <li>Reminders go out {CADENCE_DAYS.join(', ')} days before the deadline, each by the household&apos;s own choice of email or text message. From {CALL_FROM_DAYS} days before, and at once for anyone who cannot be reminded (nothing on file, no reminders, or stopped them), call them yourself.</li>
        <li>{plan.autoReminders ? 'Due reminders also go out on their own once a day.' : 'Due reminders go out only when you press the button.'} <Link href={`/o/${ctx.slug}/wedding/guests/waves`}>Change this</Link>. Every reminder carries a link that stops further reminders.</li>
      </ul>

      <div className="kw-grid">
      <section aria-label="Reminders due">
        <h2>Reminders due today</h2>
        {chase.plan.remind.length === 0 ? <p>None.</p> : <ul>{chase.plan.remind.map((r) => <li key={r.id}>{by.get(r.id)!.name} ({by.get(r.id)!.channel === 'sms' ? `text to ${by.get(r.id)!.phone}` : by.get(r.id)!.email})</li>)}</ul>}
        {canEdit && chase.plan.remind.length > 0 && <ActionForm action={sendReminders.bind(null, ctx.slug)}><button type="submit">Queue {chase.plan.remind.length} reminders</button></ActionForm>}
        <p>Reminders are queued in the outbox. This project sends no real email or text message.</p>
      </section>

      <section aria-label="Call personally">
        <h2>Call personally</h2>
        {chase.plan.call.length === 0 && <p>Nobody yet.</p>}
        <ul className="kw-plain kw-rows">
          {chase.plan.call.map((id) => {
            const h = by.get(id)!;
            return (
              <li key={id} aria-label={`Call ${h.name}`}>
                <Link href={`/o/${ctx.slug}/wedding/guests/${id}`}>{h.name}</Link>{h.phone && `, ${h.phone}`}: waiting on {h.pending.join(', ')}
                {canEdit && <ActionForm action={markCalled.bind(null, ctx.slug)}><input type="hidden" name="id" value={id} /><button type="submit" className="secondary">Mark {h.name} as called</button></ActionForm>}
              </li>
            );
          })}
        </ul>
      </section>
      </div>

      <h2>Everyone who has not answered</h2>
      <TableWrap label="Not answered">
      <table aria-label="Not answered">
        <thead><tr><th scope="col">Household</th><th scope="col">Waiting on</th><th scope="col">Reminded by</th><th scope="col">Reminders sent</th><th scope="col">Called</th></tr></thead>
        <tbody>{chase.nonResponders.map((h) => <tr key={h.id}><th scope="row">{h.name}</th><td>{h.pending.join(', ')}</td><td>{h.stopped ? <Status k="off">stopped by them</Status> : CHANNEL_TEXT[h.remindVia]}</td><td>{h.remindersSent.length}</td><td>{h.called ? <Status k="ok">yes</Status> : ''}</td></tr>)}</tbody>
      </table>
      </TableWrap>
      {chase.nonResponders.length === 0 && <p>Everyone invited has answered.</p>}
    </main>
  );
}
