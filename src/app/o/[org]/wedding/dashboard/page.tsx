import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { allows } from '@/lib/knotwork/access';
import { dashboardExtras } from '@/lib/knotwork/dashboard/store';
import { diffDays, showDay } from '@/lib/knotwork/days';
import { usd } from '@/lib/knotwork/money';
import { dashboardView } from '@/lib/knotwork/secrecy/views';
import { showAge } from '@/lib/knotwork/thanks/aging';
import { flagText } from '@/lib/knotwork/vendors/store';
import { HiddenText, NoWedding, WeddingNav } from '../bits';
import { nameOf, view } from '../view';

export const metadata = { title: 'Dashboard' };

// PRD P1-7, the progress dashboard: one page of figures, each read on this request from the engine that owns it (the
// scheduler, the vendor flags, the guest counts, the approvals, the budget rollup, the thank-you ledger, the
// contingency plans, the seating chart). Nothing is stored. Secrecy (P1-1): tasks, flags and budget lines come through
// secrecy/views.ts, so a private item counts in every figure and shows no label. A helper sees only the sections their
// grants reach; the others are not computed at all (dashboard/store.ts).
export default async function Dashboard({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'schedule.view', async (tx, v) => {
    // One at a time: these share the transaction's single connection.
    const core = await dashboardView(tx, ctx, v, { vendors: allows(v.who, 'vendors.view'), budget: allows(v.who, 'budget.view') });
    const extras = await dashboardExtras(tx, ctx, v.who, v.today);
    return { core, extras };
  });
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, core, extras } = data;
  const { tasks, overdue, flags, budget } = core;
  const { guests, seating, approvals, thanks, contingency } = extras;
  const base = `/o/${ctx.slug}/wedding`;
  const daysToGo = diffDays(v.date, v.today);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <main>
      <WeddingNav slug={ctx.slug} counts={{ approvals: approvals?.waitingForYou ?? 0, flags: flags?.length ?? 0 }} />
      <h1>Dashboard</h1>
      <p>{v.wedding.title}: <strong>{showDay(v.date)}</strong>, {daysToGo >= 0 ? `${daysToGo} days to go` : `${-daysToGo} days ago`}. Every figure is worked out now, from the plan as it stands.</p>

      <section aria-label="Tasks">
        <h2><Link href={`${base}/schedule`}>Tasks</Link>: {tasks.onTrackPct}% on track</h2>
        <ul>
          <li>{plural(tasks.total, 'task', 'tasks')}: {tasks.done} done, {tasks.onTrack} open and on track, {tasks.late} overdue, {tasks.impossible} that can no longer be finished in time</li>
          {core.marginDays !== null && <li>{core.marginDays >= 0 ? `${core.marginDays} days of margin on the longest chain of tasks` : `${-core.marginDays} days short on the longest chain of tasks`}</li>}
        </ul>
        <h3>Overdue</h3>
        {overdue.length === 0 ? <p>Nothing is overdue.</p> : (
          <ul aria-label="Overdue tasks">
            {overdue.map((t, n) => (
              <li key={t.hidden ? `hidden-${n}` : t.row.id}>
                {t.hidden ? <HiddenText h={t} owner={nameOf(v, t.owner)} /> : t.row.title}: due {showDay(t.due)} ({diffDays(v.today, t.due)} days ago){!t.hidden && t.row.assigneeId && <>, {nameOf(v, t.row.assigneeId)}</>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {flags && (
        <section aria-label="Vendor flags">
          <h2><Link href={`${base}/flags`}>Vendor flags</Link>: {flags.length} not acknowledged</h2>
          {flags.length > 0 && (
            <ul>
              {flags.map((f, n) => (f.hidden
                ? <li key={`hidden-${n}`}>{f.label}: needs re-confirmation</li>
                : <li key={f.row.id}><Link href={`${base}/vendors/${f.row.vendor.id}`}>{f.row.vendor.name}</Link>: {flagText(f.row.reason, f.row.detail)}</li>))}
            </ul>
          )}
        </section>
      )}

      {guests && (
        <section aria-label="Headcount">
          <h2><Link href={`${base}/guests/waves`}>Headcount</Link>: {guests.held} of {guests.cap} seats held{guests.heldPct !== null && ` (${guests.heldPct}%)`}</h2>
          <ul>
            <li>{guests.attending} attending, {guests.pending} not answered, {guests.declined} declined; {guests.responseRatePct}% have answered</li>
            <li>{guests.available >= 0 ? `${guests.available} seats left under the cap` : `${-guests.available} over the cap`}</li>
            {(guests.venueMin !== null || guests.venueMax !== null) && <li>The venue takes {guests.venueMin ?? 'any number'} to {guests.venueMax ?? 'any number'}</li>}
            {seating && <li><Link href={`${base}/guests/seating`}>Seating</Link>: {seating.seated} of {seating.toSeat} seated at {plural(seating.tables, 'table', 'tables')}{seating.hard ? `, ${plural(seating.hard, 'problem', 'problems')} with "must" rules` : ''}</li>}
          </ul>
        </section>
      )}

      {approvals && (
        <section aria-label="Approvals">
          <h2><Link href={`${base}/approvals`}>Approvals</Link>: {approvals.waitingForYou} waiting for you</h2>
          <p>{plural(approvals.yours, 'request of yours waits', 'requests of yours wait')} for your partner.</p>
        </section>
      )}

      {budget && (
        <section aria-label="Budget">
          <h2><Link href={`${base}/budget`}>Budget</Link>: {usd(budget.actualCents)} spent of {usd(budget.estimateCents)}{budget.spentPct !== null && ` (${budget.spentPct}%)`}</h2>
          <ul>
            <li>{budget.over ? `Over the estimate by ${usd(-budget.remainingCents)}` : `${usd(budget.remainingCents)} left`}{budget.overLines > 0 && `; ${plural(budget.overLines, 'category is', 'categories are')} over its estimate`}</li>
            {budget.hiddenLines > 0 && <li>The totals include {plural(budget.hiddenLines, 'private line', 'private lines')}.</li>}
          </ul>
        </section>
      )}

      {thanks && (
        <section aria-label="Thank-you notes">
          <h2><Link href={`${base}/gifts/thank-yous`}>Thank-you notes</Link>: {thanks.headline}</h2>
          <ul>
            <li>{thanks.owed.length} still to send, {thanks.thanked.length} sent</li>
            {thanks.owed.length > 0 && <li>Oldest: {thanks.owed[0]!.giver}, {showAge(thanks.owed[0]!.ageDays)}</li>}
            <li>{thanks.buckets.map((b) => `${b.label}: ${b.count}`).join(' · ')}</li>
          </ul>
        </section>
      )}

      {contingency && (
        <section aria-label="Contingency plans">
          <h2><Link href={`${base}/contingency`}>Contingency plans</Link>: {contingency.ready} ready, {contingency.ran} put into action</h2>
          {contingency.ran > 0 && <p>{plural(contingency.openItems, 'checklist line', 'checklist lines')} not ticked off yet.</p>}
        </section>
      )}
    </main>
  );
}
