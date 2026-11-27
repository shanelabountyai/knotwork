// Small shared pieces of the Knotwork pages. Semantic HTML first; the look is src/app/ui/knotwork.css (docs/DESIGN_SYSTEM.md).
import Link from 'next/link';
import { NavLink } from '@/app/ui/nav-link';
import { Status, stateKind, TableWrap } from '@/app/ui/kw';
import { showDay, type Day } from '@/lib/knotwork/days';
import type { MovePreview, PlanTask } from '@/lib/knotwork/schedule/engine';
import { PRIVACY_CHOICES } from '@/lib/knotwork/secrecy/compartment';
import type { Hidden } from '@/lib/knotwork/secrecy/lens';
import { allows, type Capability, type Who } from '@/lib/knotwork/access';

/**
 * `mode`: the wedding's (Phase 5). In life-admin mode the nav is the couple's, and a page of the plan says it is the
 * archive, read-only (D-144). `life`: the page is one of life-admin mode's own (the home page, household tasks).
 * The design pass (docs/DESIGN_SYSTEM.md): a row of tabs, the current one marked by NavLink; a count is a badge
 * whose words stay in the link's name ("Approvals (1)").
 */
export function WeddingNav({ slug, counts, life, mode, who }: { slug: string; counts?: { approvals: number; flags: number }; life?: boolean; mode?: 'planning' | 'life'; who?: Who }) {
  const base = `/o/${slug}/wedding`;
  // `who`: the viewer. A tab whose page would be a 404 to them (a helper without the grant) is not shown; the page
  // itself still decides (view.ts), this only stops the nav offering a dead end.
  const open = (cap?: Capability) => !who || !cap || allows(who, cap);
  const tab = (href: string, text: string, n?: number, exact?: boolean, cap?: Capability) => open(cap) && (
    <li key={href}>
      <NavLink href={href} exact={exact}>{text}{n ? <> <span className="kw-count"><span className="sr-only">(</span>{n}<span className="sr-only">)</span></span></> : null}</NavLink>
    </li>
  );
  if (life || mode === 'life') {
    return (
      <>
      <nav aria-label="Wedding" className="kw-tabs">
        <ul>
          {tab(`/o/${slug}`, 'Home', 0, true)}{tab(`${base}/life`, 'Household', 0, false, 'life.view')}{tab(`${base}/gifts/thank-yous`, 'Thank-yous', 0, false, 'gifts.view')}{tab(`${base}/photos`, 'Photos', 0, false, 'photos.view')}
          {tab(`${base}/name-change`, 'Name change', 0, false, 'namechange.own')}{tab(`${base}/archive`, 'Archive', 0, false, 'schedule.view')}{tab(`${base}/approvals`, 'Approvals', counts?.approvals, false, 'consent.view')}
          {tab(`${base}/activity`, 'Activity', 0, false, 'activity.view')}{tab(`${base}/helpers`, 'Helpers', 0, false, 'helpers.manage')}
        </ul>
      </nav>
      {!life && <p role="note" aria-label="Archive">From the <Link href={`${base}/archive`}>Archive</Link>: the wedding plan is read-only in life-admin mode.</p>}
      </>
    );
  }
  return (
    <nav aria-label="Wedding" className="kw-tabs">
      <ul>
        {tab(`/o/${slug}`, 'Overview', 0, true)}{tab(`${base}/dashboard`, 'Dashboard', 0, false, 'schedule.view')}{tab(`${base}/schedule`, 'Schedule', 0, false, 'schedule.view')}{tab(`${base}/budget`, 'Budget', 0, false, 'budget.view')}{tab(`${base}/funding`, 'Funding', 0, false, 'funding.view')}
        {tab(`${base}/vendors`, 'Vendors', 0, false, 'vendors.view')}{tab(`${base}/guests`, 'Guests', 0, false, 'guests.view')}{tab(`${base}/gifts`, 'Gifts', 0, false, 'gifts.view')}{tab(`${base}/photos`, 'Photos', 0, false, 'photos.view')}{tab(`${base}/contingency`, 'Contingency plans', 0, false, 'contingency.view')}
        {tab(`${base}/name-change`, 'Name change', 0, false, 'namechange.own')}{tab(`${base}/approvals`, 'Approvals', counts?.approvals, false, 'consent.view')}{tab(`${base}/flags`, 'Vendor flags', counts?.flags, false, 'vendors.view')}
        {tab(`${base}/activity`, 'Activity', 0, false, 'activity.view')}{tab(`${base}/helpers`, 'Helpers', 0, false, 'helpers.manage')}
      </ul>
    </nav>
  );
}

// ---- P1-1 secrecy (ADR-001) ---------------------------------------------------------------------------------------

/** The "private to me until …" choice on a form. Partners only (the action refuses a helper anyway). */
export function PrivacySelect({ label = 'Who sees it', defaultValue = '', name = 'privacy' }: { label?: string; defaultValue?: string; name?: string }) {
  return (
    <label>
      {label}{' '}
      <select name={name} defaultValue={defaultValue}>
        {PRIVACY_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.text}</option>)}
      </select>
    </label>
  );
}

const revealsOn = (d: Day | null) => (d ? `reveals ${showDay(d)}` : 'until revealed');
/** A masked line: what kind of thing, whose, and when it shows. Nothing else of it exists on the page. */
export const HiddenText = ({ h, owner }: { h: Hidden; owner: string }) => <span aria-label={h.label} className="kw-hidden"><Status k="priv">{h.label}</Status> <small>({owner}&apos;s, {revealsOn(h.revealsOn)})</small></span>;
/** On the owner's own private item. */
export const MineNote = ({ mine }: { mine: { revealsOn: Day | null } | null }) => (mine ? <small> (private to you, {revealsOn(mine.revealsOn)})</small> : null);
export const privacyValue = (row: { privateToId: string | null; revealDays: number | null }, mine: unknown) => (mine ? (row.revealDays === null ? 'never' : String(row.revealDays)) : '');

export const NoWedding = ({ slug }: { slug: string }) => (
  <main>
    <h1>No wedding yet</h1>
    <p>
      <Link href={`/o/${slug}`}>Create the wedding</Link> first.
    </p>
  </main>
);

const STATE_TEXT = { ok: 'on track', late: 'late', impossible: 'impossible', done: 'done' } as const;
export const stateText = (s: keyof typeof STATE_TEXT) => STATE_TEXT[s];

/** The cascade preview (PRD P0-1): what shifts, what is now late, what is now impossible. */
export function MovePreviewView({ preview, plan, from, to }: { preview: MovePreview; plan: PlanTask[]; from: Day; to: Day }) {
  const title = new Map(plan.map((t) => [t.id, t.title]));
  const open = plan.filter((t) => !t.done);
  const direction = preview.deltaDays > 0 ? 'later' : 'earlier';
  return (
    <section aria-label="Move preview">
      <p>
        From <strong>{showDay(from)}</strong> to <strong>{showDay(to)}</strong>: {Math.abs(preview.deltaDays)} days {direction}.
      </p>
      <ul aria-label="Preview summary">
        <li>{open.length} open tasks shift by {Math.abs(preview.deltaDays)} days</li>
        <li data-k={preview.late.length ? 'late' : undefined}>{preview.late.length} late after the move{preview.late.length ? ` (${preview.late.filter((x) => x.isNew).length} new)` : ''}</li>
        <li data-k={preview.impossible.length ? 'late' : undefined}>{preview.impossible.length} impossible after the move{preview.impossible.length ? ` (${preview.impossible.filter((x) => x.isNew).length} new)` : ''}</li>
        {preview.resolved.length > 0 && <li>{preview.resolved.length} that were late or impossible become on track</li>}
        {preview.marginDays !== null && <li data-k={preview.marginDays < 0 ? 'late' : undefined}>{preview.marginDays >= 0 ? `${preview.marginDays} days of margin on the longest chain` : `${-preview.marginDays} days short on the longest chain`}</li>}
      </ul>
      {preview.late.length > 0 && (
        <>
          <h3>Late after the move</h3>
          <ul aria-label="Late after the move">{preview.late.map((x) => <li key={x.id}>{title.get(x.id)}: due {showDay(preview.tasks[x.id]!.due)}{x.isNew ? ' (new)' : ''}</li>)}</ul>
        </>
      )}
      {preview.impossible.length > 0 && (
        <>
          <h3>Impossible after the move (lead time exceeds runway)</h3>
          <ul aria-label="Impossible after the move">{preview.impossible.map((x) => <li key={x.id}>{title.get(x.id)}: start by {showDay(preview.tasks[x.id]!.startBy)}, due {showDay(preview.tasks[x.id]!.due)}{x.isNew ? ' (new)' : ''}</li>)}</ul>
        </>
      )}
      <details>
        <summary>Every task&apos;s new dates</summary>
        <TableWrap label="New dates">
        <table aria-label="New dates">
          <thead><tr><th scope="col">Task</th><th scope="col">Start by</th><th scope="col">Due</th><th scope="col">State</th></tr></thead>
          <tbody>
            {plan.map((t) => (
              <tr key={t.id}><th scope="row">{t.title}</th><td>{showDay(preview.tasks[t.id]!.startBy)}</td><td>{showDay(preview.tasks[t.id]!.due)}</td><td><Status k={stateKind(preview.tasks[t.id]!.state)}>{stateText(preview.tasks[t.id]!.state)}</Status></td></tr>
            ))}
          </tbody>
        </table>
        </TableWrap>
      </details>
    </section>
  );
}
