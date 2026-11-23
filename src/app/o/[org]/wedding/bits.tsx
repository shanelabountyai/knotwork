// Small shared pieces of the Knotwork pages. Plain HTML on purpose: Phase 1 is function, not design.
import Link from 'next/link';
import { showDay, type Day } from '@/lib/knotwork/days';
import type { MovePreview, PlanTask } from '@/lib/knotwork/schedule/engine';

export function WeddingNav({ slug, counts }: { slug: string; counts?: { approvals: number; flags: number } }) {
  const base = `/o/${slug}/wedding`;
  return (
    <nav aria-label="Wedding">
      <Link href={`/o/${slug}`}>Overview</Link> · <Link href={`${base}/schedule`}>Schedule</Link> · <Link href={`${base}/budget`}>Budget</Link> ·{' '}
      <Link href={`${base}/vendors`}>Vendors</Link> · <Link href={`${base}/approvals`}>Approvals{counts?.approvals ? ` (${counts.approvals})` : ''}</Link> ·{' '}
      <Link href={`${base}/flags`}>Vendor flags{counts?.flags ? ` (${counts.flags})` : ''}</Link> · <Link href={`${base}/activity`}>Activity</Link> ·{' '}
      <Link href={`${base}/helpers`}>Helpers</Link>
    </nav>
  );
}

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
