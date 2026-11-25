import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows, isPartner } from '@/lib/knotwork/access';
import { diffDays, showDay } from '@/lib/knotwork/days';
import { loadGuestState } from '@/lib/knotwork/guests/store';
import { overviewView } from '@/lib/knotwork/secrecy/views';
import { flagText } from '@/lib/knotwork/vendors/store';
import { createWedding } from './wedding/actions';
import { WeddingNav } from './wedding/bits';
import { view } from './wedding/view';

export const metadata = { title: 'Overview' };

// The workspace home. No wedding yet: the form that creates one. Otherwise the four counts a couple checks first
// (PRD P0-2: "unacknowledged flags surface on the dashboard"), and the link to the fuller P1-7 dashboard. Tasks and flags
// come through secrecy/views.ts (P1-1): a private task counts, unnamed.
export default async function OrgHome({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'schedule.view', async (tx, v) => {
    // One at a time: these share the transaction's single connection.
    const o = await overviewView(tx, ctx, v, allows(v.who, 'vendors.view'));
    const guests = allows(v.who, 'guests.view') ? await loadGuestState(tx, ctx) : null;
    return { o, guests };
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

  const { v, o, guests } = data;
  const { waiting, flags, late, impossible } = o;
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
      <p><Link href={`/o/${ctx.slug}/wedding/dashboard`}><strong>Progress dashboard</strong></Link>: tasks on track, what is overdue, headcount, budget and more, in one place.</p>
      <ul aria-label="At a glance">
        <li><Link href={`/o/${ctx.slug}/wedding/schedule`}>{o.open} open tasks</Link>: {late} late, {impossible} impossible</li>
        {partner && <li><Link href={`/o/${ctx.slug}/wedding/approvals`}>{waiting} waiting for your approval</Link></li>}
        {allows(v.who, 'vendors.view') && <li><Link href={`/o/${ctx.slug}/wedding/flags`}>{flags.length} vendors need re-confirmation</Link></li>}
        {guests && guests.rows.length > 0 && <li><Link href={`/o/${ctx.slug}/wedding/guests`}>{guests.count.attending} guests attending</Link>, {guests.count.pending} not answered; {guests.cap.held} of {guests.plan.cap} seats held</li>}
        {o.marginDays !== null && <li>{o.marginDays >= 0 ? `${o.marginDays} days of margin on the longest chain of tasks` : `${-o.marginDays} days short on the longest chain of tasks`}</li>}
      </ul>
      {flags.length > 0 && (
        <section aria-label="Needs re-confirmation">
          <h2>Needs re-confirmation</h2>
          <ul>
            {flags.map((f, n) => (f.hidden
              ? <li key={`hidden-${n}`}>{f.label}: needs re-confirmation</li>
              : <li key={f.row.id}><Link href={`/o/${ctx.slug}/wedding/vendors/${f.row.vendor.id}`}>{f.row.vendor.name}</Link>: {flagText(f.row.reason, f.row.detail)}</li>))}
          </ul>
        </section>
      )}
    </main>
  );
}
