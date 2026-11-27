import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows, isPartner } from '@/lib/knotwork/access';
import { diffDays, showDay } from '@/lib/knotwork/days';
import { loadGuestState } from '@/lib/knotwork/guests/store';
import { flagText } from '@/lib/knotwork/vendors/store';
import { hasPending } from '@/lib/knotwork/consent/store';
import { lifeModeOpen } from '@/lib/knotwork/context';
import { lifeDashboard, waitingFor } from '@/lib/knotwork/lifeadmin/store';
import { documentsView, overviewView } from '@/lib/knotwork/secrecy/views';
import { Keys } from '@/app/ui/kw';
import { usd } from '@/lib/knotwork/money';
import { createWedding } from './wedding/actions';
import { proposeMode } from './wedding/life/actions';
import { LifeHome } from './wedding/life/home';
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
    if (v.wedding.mode === 'life') {
      // Phase 5: life-admin mode. The couple's dashboard; the plan is in the archive.
      const life = await lifeDashboard(tx, ctx, v);
      const docs = allows(v.who, 'vendors.view') ? await documentsView(tx, ctx, v) : null;
      const waiting = isPartner(ctx.role) ? await waitingFor(tx, ctx) : 0;
      return { life: { life, docs, waiting }, o: null, guests: null, pendingSwitch: false };
    }
    const o = await overviewView(tx, ctx, v, allows(v.who, 'vendors.view'));
    const guests = allows(v.who, 'guests.view') ? await loadGuestState(tx, ctx) : null;
    const pendingSwitch = lifeModeOpen(v.wedding) && (await hasPending(tx, ctx, 'set_mode'));
    return { life: null, o, guests, pendingSwitch };
  });

  if (!data) {
    return (
      <main>
        <h1 className="display">Start your wedding plan</h1>
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

  const { v, life, o, guests, pendingSwitch } = data;
  if (life) return <LifeHome slug={ctx.slug} v={v} life={life.life} docs={life.docs} waiting={life.waiting} />;
  const { waiting, flags, late, impossible } = o!;
  const daysToGo = diffDays(v.date, v.today);
  const partner = isPartner(ctx.role);
  return (
    <main>
      <WeddingNav who={v.who} slug={ctx.slug} counts={{ approvals: partner ? waiting : 0, flags: flags.length }} />
      <header className="kw-hero">
        <div>
          <span className="kw-eyebrow">Your wedding</span>
          <h1 className="display">{v.wedding.title}</h1>
          <p aria-label="Wedding date" className="kw-when">
            <strong>{showDay(v.date)}</strong> · {daysToGo >= 0 ? `${daysToGo} days to go` : `${-daysToGo} days ago`}
            {partner && <> · <Link href={`/o/${ctx.slug}/wedding/date`}>Move the date</Link></>}
          </p>
        </div>
      </header>
      <p><Link href={`/o/${ctx.slug}/wedding/dashboard`}><strong>Progress dashboard</strong></Link>: tasks on track, what is overdue, headcount, budget and more, in one place.</p>
      <div className="kw-split">
        <div className="kw-col">
          <ul aria-label="At a glance" className="kw-tiles">
            <li><Link href={`/o/${ctx.slug}/wedding/schedule`}>{o!.open} open tasks</Link>: {late} late, {impossible} impossible</li>
            {partner && <li><Link href={`/o/${ctx.slug}/wedding/approvals`}>{waiting} waiting for your approval</Link>{waiting > 0 && <><br /><Keys on={1}>needs your key</Keys></>}</li>}
            {allows(v.who, 'vendors.view') && <li><Link href={`/o/${ctx.slug}/wedding/flags`}>{flags.length} vendors need re-confirmation</Link></li>}
            {guests && guests.rows.length > 0 && <li><Link href={`/o/${ctx.slug}/wedding/guests`}>{guests.count.attending} guests attending</Link>, {guests.count.pending} not answered; {guests.cap.held} of {guests.plan.cap} seats held</li>}
            {o!.marginDays !== null && <li>{o!.marginDays >= 0 ? `${o!.marginDays} days of margin on the longest chain of tasks` : `${-o!.marginDays} days short on the longest chain of tasks`}</li>}
          </ul>
          {flags.length > 0 && (
            <section aria-label="Needs re-confirmation">
              <h2>Needs re-confirmation</h2>
              <ul className="kw-plain kw-rows">
                {flags.map((f, n) => (f.hidden
                  ? <li key={`hidden-${n}`}>{f.label}: needs re-confirmation</li>
                  : <li key={f.row.id}><Link href={`/o/${ctx.slug}/wedding/vendors/${f.row.vendor.id}`}>{f.row.vendor.name}</Link>: {flagText(f.row.reason, f.row.detail)}</li>))}
              </ul>
            </section>
          )}
        </div>
        <div className="kw-col">
          {partner && (
            <div className="card">
              <h2>How the two keys work</h2>
              <p>Booking a vendor, signing a contract, a spend over {usd(v.wedding.spendThresholdCents)}, moving the date, removing a guest and changing these rules each need both of you.</p>
              <ul className="kw-plain kw-rows">
                <li><Keys on={1}>One key: proposed. Nothing has changed yet.</Keys></li>
                <li><Keys on={2}>Both keys: approved and done in the same step.</Keys></li>
                {v.partners.length < 2 && !v.wedding.pairedAt && <li><Keys on={1} solo>Solo: until your partner joins, yours is enough, and it is marked solo.</Keys></li>}
              </ul>
              <p><Link href={`/o/${ctx.slug}/wedding/approvals`}>Open approvals</Link></p>
            </div>
          )}
          {partner && lifeModeOpen(v.wedding) && (
            <section aria-label="Life-admin mode">
              <h2>After the wedding</h2>
              <p>The wedding day has passed. You can switch the workspace into <strong>life-admin mode</strong>: a home page for the two of you (anniversaries, household tasks, the name change, thank-yous still owed, your documents and photos), with the wedding plan kept as a read-only archive. Switching takes both of you, and so does switching back.</p>
              {pendingSwitch ? <p><Link href={`/o/${ctx.slug}/wedding/approvals`}>A switch is waiting for approval.</Link></p> : (
                <ActionForm action={proposeMode.bind(null, ctx.slug)}>
                  <input type="hidden" name="to" value="life" />
                  <button type="submit">Switch to life-admin mode</button>
                </ActionForm>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
