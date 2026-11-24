import Link from 'next/link';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { ActionForm } from '@/core/ui/action-form';
import { allows, isPartner } from '@/lib/knotwork/access';
import { diffDays, showDay } from '@/lib/knotwork/days';
import { loadGuestState } from '@/lib/knotwork/guests/store';
import { loadSchedule } from '@/lib/knotwork/schedule/store';
import { flagText } from '@/lib/knotwork/vendors/store';
import { createWedding } from './wedding/actions';
import { WeddingNav } from './wedding/bits';
import { view } from './wedding/view';

export const metadata = { title: 'Overview' };

// The workspace home. No wedding yet: the form that creates one. Otherwise the four counts a couple checks first
// (PRD P0-2: "unacknowledged flags surface on the dashboard"). The fuller P1-7 dashboard is Phase 4.
export default async function OrgHome({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'schedule.view', async (tx, v) => {
    const { schedule, plan } = await loadSchedule(tx, ctx, v.wedding);
    // One at a time: these share the transaction's single connection.
    const waiting = await tx.consentRequest.count({ where: { ...inOrg(ctx), status: 'pending', expiresAt: { gt: now() }, proposerId: { not: ctx.userId } } });
    const flags = allows(v.who, 'vendors.view') ? await tx.vendorFlag.findMany({ where: { ...inOrg(ctx), ackAt: null }, include: { vendor: { select: { id: true, name: true } } }, orderBy: { raisedAt: 'asc' } }) : [];
    const guests = allows(v.who, 'guests.view') ? await loadGuestState(tx, ctx) : null;
    return { schedule, plan, waiting, flags, guests };
  });

  if (!data) {
    return (
      <main>
        <h1>Start your wedding plan</h1>
        {isPartner(ctx.role) ? (
          <>
            <p>Pick the date. Every deadline in the plan is worked out backward from it, and moves with it.</p>
            <ActionForm action={createWedding.bind(null, ctx.slug)}>
              <label>Name <input name="title" required maxLength={120} placeholder="Juniper & Rowan" /></label>
              <label>Wedding date <input name="date" type="date" required /></label>
              <label>Time zone <input name="timeZone" defaultValue="America/Chicago" maxLength={64} /></label>
              <button type="submit">Create the wedding</button>
            </ActionForm>
            <p>The plan starts from a default list of tasks. Their lead times are illustrative defaults; change them to match your vendors.</p>
          </>
        ) : (
          <p>One of the partners has to create the wedding first.</p>
        )}
      </main>
    );
  }

  const { v, schedule, plan, waiting, flags, guests } = data;
  const states = Object.values(schedule.tasks);
  const [late, impossible] = [states.filter((t) => t.state === 'late').length, states.filter((t) => t.state === 'impossible').length];
  const daysToGo = diffDays(v.date, v.today);
  const partner = isPartner(ctx.role);
  return (
    <main>
      <WeddingNav slug={ctx.slug} counts={{ approvals: partner ? waiting : 0, flags: flags.length }} />
      <h1>{v.wedding.title}</h1>
      <p aria-label="Wedding date">
        <strong>{showDay(v.date)}</strong> · {daysToGo >= 0 ? `${daysToGo} days to go` : `${-daysToGo} days ago`}
        {partner && <> · <Link href={`/o/${ctx.slug}/wedding/date`}>Move the date</Link></>}
      </p>
      <ul aria-label="At a glance">
        <li><Link href={`/o/${ctx.slug}/wedding/schedule`}>{plan.filter((t) => !t.done).length} open tasks</Link>: {late} late, {impossible} impossible</li>
        {partner && <li><Link href={`/o/${ctx.slug}/wedding/approvals`}>{waiting} waiting for your approval</Link></li>}
        {allows(v.who, 'vendors.view') && <li><Link href={`/o/${ctx.slug}/wedding/flags`}>{flags.length} vendors need re-confirmation</Link></li>}
        {guests && guests.rows.length > 0 && <li><Link href={`/o/${ctx.slug}/wedding/guests`}>{guests.count.attending} guests attending</Link>, {guests.count.pending} not answered; {guests.cap.held} of {guests.plan.cap} seats held</li>}
        {schedule.marginDays !== null && <li>{schedule.marginDays >= 0 ? `${schedule.marginDays} days of margin on the longest chain of tasks` : `${-schedule.marginDays} days short on the longest chain of tasks`}</li>}
      </ul>
      {flags.length > 0 && (
        <section aria-label="Needs re-confirmation">
          <h2>Needs re-confirmation</h2>
          <ul>
            {flags.map((f) => (
              <li key={f.id}><Link href={`/o/${ctx.slug}/wedding/vendors/${f.vendor.id}`}>{f.vendor.name}</Link>: {flagText(f.reason, f.detail)}</li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
