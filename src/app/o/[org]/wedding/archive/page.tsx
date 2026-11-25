import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows, isPartner, type Capability } from '@/lib/knotwork/access';
import { hasPending } from '@/lib/knotwork/consent/store';
import { lifeModeOpen } from '@/lib/knotwork/context';
import { showDay, todayIn } from '@/lib/knotwork/days';
import { NoWedding, WeddingNav } from '../bits';
import { view } from '../view';
import { proposeMode } from '../life/actions';

export const metadata = { title: 'Archive' };

/** The planning pages, each with what it takes to see it. */
const PLAN: { path: string; label: string; cap: Capability }[] = [
  { path: 'dashboard', label: 'Progress dashboard', cap: 'schedule.view' },
  { path: 'schedule', label: 'Schedule', cap: 'schedule.view' },
  { path: 'budget', label: 'Budget', cap: 'budget.view' },
  { path: 'funding', label: 'Funding', cap: 'funding.view' },
  { path: 'vendors', label: 'Vendors and their documents', cap: 'vendors.view' },
  { path: 'flags', label: 'Vendor flags', cap: 'vendors.view' },
  { path: 'guests', label: 'Guests and seating', cap: 'guests.view' },
  { path: 'contingency', label: 'Contingency plans', cap: 'contingency.view' },
  { path: 'date', label: 'The wedding date', cap: 'consent.propose' },
];

// Phase 5, the archive (D-144): in life-admin mode the wedding plan is kept here, read-only for everyone (the archive
// refuses every write to it with one sentence; access.ts ARCHIVED_CAPS). The switch into life-admin mode and back is a
// designated action (D-143): proposed here or on the home page, made by consent/execute.ts once the other partner
// approves (or at once in solo mode, D-33).
export default async function Archive({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'schedule.view', async (tx, v) => ({ pending: isPartner(ctx.role) && (await hasPending(tx, ctx, 'set_mode')), open: lifeModeOpen(v.wedding) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, pending, open } = data;
  const life = v.wedding.mode === 'life';
  const base = `/o/${ctx.slug}/wedding`;
  return (
    <main>
      <WeddingNav slug={ctx.slug} life={life} />
      <h1>Archive</h1>
      {life ? (
        <p role="note">Life-admin mode{v.wedding.modeChangedAt ? ` since ${showDay(todayIn(v.wedding.timeZone, v.wedding.modeChangedAt))}` : ''}. The wedding plan below is kept as it was, <strong>read-only</strong>: nothing in it can be changed until you switch back to planning mode. Secrets stay secret here too.</p>
      ) : (
        <p>The workspace is in planning mode. {open ? 'The wedding day has passed: you can switch to life-admin mode, and the plan below becomes a read-only archive.' : 'Life-admin mode opens the day after the wedding.'}</p>
      )}
      <ul aria-label="The wedding plan">
        {PLAN.filter((p) => allows(v.who, p.cap)).map((p) => <li key={p.path}><Link href={`${base}/${p.path}`}>{p.label}</Link></li>)}
      </ul>
      {isPartner(ctx.role) && (life || open) && (
        <section aria-label="Switch mode">
          <h2>{life ? 'Back to planning' : 'Life-admin mode'}</h2>
          <p>Switching takes both of you: your partner approves it on the approvals page.</p>
          {pending ? <p><Link href={`${base}/approvals`}>A switch is waiting for approval.</Link></p> : (
            <ActionForm action={proposeMode.bind(null, ctx.slug)}>
              <input type="hidden" name="to" value={life ? 'planning' : 'life'} />
              <button type="submit">{life ? 'Switch back to planning mode' : 'Switch to life-admin mode'}</button>
            </ActionForm>
          )}
        </section>
      )}
    </main>
  );
}
