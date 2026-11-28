// Small shared pieces of the Knotwork pages. Plain HTML on purpose: Phase 1 is function, not design.
import Link from 'next/link';
import { showDay, type Day } from '@/lib/knotwork/days';
import type { MovePreview, PlanTask } from '@/lib/knotwork/schedule/engine';
import { PRIVACY_CHOICES } from '@/lib/knotwork/secrecy/compartment';
import type { Hidden } from '@/lib/knotwork/secrecy/lens';

/**
 * `mode`: the wedding's (Phase 5). In life-admin mode the nav is the couple's, and a page of the plan says it is the
 * archive, read-only (D-144). `life`: the page is one of life-admin mode's own (the home page, household tasks).
 */
export function WeddingNav({ slug, counts, life, mode }: { slug: string; counts?: { approvals: number; flags: number }; life?: boolean; mode?: 'planning' | 'life' }) {
  const base = `/o/${slug}/wedding`;
  if (life || mode === 'life') {
    return (
      <>
      <nav aria-label="Wedding">
        <Link href={`/o/${slug}`}>Home</Link> · <Link href={`${base}/life`}>Household</Link> · <Link href={`${base}/gifts/thank-yous`}>Thank-yous</Link> · <Link href={`${base}/photos`}>Photos</Link> ·{' '}
        <Link href={`${base}/name-change`}>Name change</Link> · <Link href={`${base}/archive`}>Archive</Link> · <Link href={`${base}/approvals`}>Approvals{counts?.approvals ? ` (${counts.approvals})` : ''}</Link> ·{' '}
        <Link href={`${base}/activity`}>Activity</Link> · <Link href={`${base}/helpers`}>Helpers</Link>
      </nav>
      {!life && <p role="note" aria-label="Archive">From the <Link href={`${base}/archive`}>Archive</Link>: the wedding plan is read-only in life-admin mode.</p>}
      </>
    );
  }
  return (
    <nav aria-label="Wedding">
      <Link href={`/o/${slug}`}>Overview</Link> · <Link href={`${base}/dashboard`}>Dashboard</Link> · <Link href={`${base}/schedule`}>Schedule</Link> · <Link href={`${base}/budget`}>Budget</Link> · <Link href={`${base}/funding`}>Funding</Link> ·{' '}
      <Link href={`${base}/vendors`}>Vendors</Link> · <Link href={`${base}/guests`}>Guests</Link> · <Link href={`${base}/gifts`}>Gifts</Link> · <Link href={`${base}/photos`}>Photos</Link> · <Link href={`${base}/contingency`}>Contingency plans</Link> · <Link href={`${base}/name-change`}>Name change</Link> · <Link href={`${base}/approvals`}>Approvals{counts?.approvals ? ` (${counts.approvals})` : ''}</Link> ·{' '}
      <Link href={`${base}/flags`}>Vendor flags{counts?.flags ? ` (${counts.flags})` : ''}</Link> · <Link href={`${base}/activity`}>Activity</Link> ·{' '}
      <Link href={`${base}/helpers`}>Helpers</Link>
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
export const HiddenText = ({ h, owner }: { h: Hidden; owner: string }) => <span aria-label={h.label}><em>{h.label}</em> <small>({owner}&apos;s, {revealsOn(h.revealsOn)})</small></span>;
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
        <li>{preview.late.length} late after the move{preview.late.length ? ` (${preview.late.filter((x) => x.isNew).length} new)` : ''}</li>
        <li>{preview.impossible.length} impossible after the move{preview.impossible.length ? ` (${preview.impossible.filter((x) => x.isNew).length} new)` : ''}</li>
        {preview.resolved.length > 0 && <li>{preview.resolved.length} that were late or impossible become on track</li>}
        {preview.marginDays !== null && <li>{preview.marginDays >= 0 ? `${preview.marginDays} days of margin on the longest chain` : `${-preview.marginDays} days short on the longest chain`}</li>}
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
        <table aria-label="New dates">
          <thead><tr><th scope="col">Task</th><th scope="col">Start by</th><th scope="col">Due</th><th scope="col">State</th></tr></thead>
          <tbody>
            {plan.map((t) => (
              <tr key={t.id}><th scope="row">{t.title}</th><td>{showDay(preview.tasks[t.id]!.startBy)}</td><td>{showDay(preview.tasks[t.id]!.due)}</td><td>{stateText(preview.tasks[t.id]!.state)}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
