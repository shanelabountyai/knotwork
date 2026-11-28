// Small shared pieces of the Knotwork pages. Semantic HTML first; the look is src/app/ui/knotwork.css (docs/DESIGN_SYSTEM.md).
import Link from 'next/link';
import { WeddingTabs, type TabGroup } from '@/app/ui/nav-link';
import { Status, stateKind, TableWrap } from '@/app/ui/kw';
import { showDay, type Day } from '@/lib/knotwork/days';
import type { MovePreview, PlanTask } from '@/lib/knotwork/schedule/engine';
import { PRIVACY_CHOICES } from '@/lib/knotwork/secrecy/compartment';
import type { Hidden } from '@/lib/knotwork/secrecy/lens';
import { allows, type Capability, type Who } from '@/lib/knotwork/access';

/** The viewer may open a page needing `cap` (no viewer: nothing is hidden, as before D-162). */
const opens = (who: Who | undefined, cap?: Capability) => !who || !cap || allows(who, cap);

type Page = { path: string; text: string; cap?: Capability; count?: number; exact?: boolean };
type Section = { key: string; text: string; root?: Page; pages: Page[]; also?: string[] };

/**
 * The wedding's tab map (round 2, D-173): five top tabs, every other page a second-row tab under one of them. Only the
 * grouping and the labels are the nav's; every route is where it was. A page the viewer cannot open is not offered
 * (D-162); a top tab with no page left for the viewer is not shown; a top tab opens its first page the viewer can open.
 * `root`: a top tab's own page that is not repeated in its second row (Home). `also`: paths that belong to the tab
 * without a tab of their own (the date-move insurance page sits under "Move the date" by its path already).
 */
export function weddingTabs(slug: string, opts: { who?: Who; life?: boolean; counts?: { approvals: number; flags: number } } = {}): TabGroup[] {
  const w = `/o/${slug}/wedding`;
  const home: Section = { key: 'home', text: 'Home', root: { path: `/o/${slug}`, text: 'Home', exact: true }, pages: [] };
  const approvals: Section = { key: 'approvals', text: 'Approvals', pages: [{ path: `${w}/approvals`, text: 'Approvals', cap: 'consent.view', count: opts.counts?.approvals }] };
  const plan = ['schedule', 'date', 'budget', 'funding', 'vendors', 'flags', 'guests', 'contingency', 'dashboard'].map((p) => `${w}/${p}`);
  const sections: Section[] = opts.life
    ? [
      { ...home, pages: [{ path: `${w}/activity`, text: 'Activity', cap: 'activity.view' }, { path: `${w}/helpers`, text: 'Helpers', cap: 'helpers.manage' }] },
      { key: 'household', text: 'Household', pages: [{ path: `${w}/life`, text: 'Household tasks', cap: 'life.view' }, { path: `${w}/name-change`, text: 'Name change', cap: 'namechange.own' }] },
      { key: 'keepsakes', text: 'Gifts and photos', pages: [{ path: `${w}/gifts/thank-yous`, text: 'Thank-yous', cap: 'gifts.view' }, { path: `${w}/photos`, text: 'Photos', cap: 'photos.view' }], also: [`${w}/gifts`] },
      { key: 'archive', text: 'Archive', pages: [{ path: `${w}/archive`, text: 'Archive', cap: 'schedule.view' }], also: plan },
      approvals,
    ]
    : [
      { ...home, pages: [{ path: `${w}/dashboard`, text: 'Progress', cap: 'schedule.view' }, { path: `${w}/activity`, text: 'Activity', cap: 'activity.view' }, { path: `${w}/helpers`, text: 'Helpers', cap: 'helpers.manage' }] },
      { key: 'plan', text: 'Plan', pages: [{ path: `${w}/schedule`, text: 'Schedule', cap: 'schedule.view' }, { path: `${w}/date`, text: 'Move the date', cap: 'consent.propose' }, { path: `${w}/contingency`, text: 'Contingency plans', cap: 'contingency.view' }, { path: `${w}/name-change`, text: 'Name change', cap: 'namechange.own' }], also: [`${w}/archive`, `${w}/life`] },
      { key: 'money', text: 'Money', pages: [{ path: `${w}/budget`, text: 'Budget', cap: 'budget.view' }, { path: `${w}/vendors`, text: 'Vendors', cap: 'vendors.view' }, { path: `${w}/funding`, text: 'Funding', cap: 'funding.view' }, { path: `${w}/flags`, text: 'Re-confirmations', cap: 'vendors.view', count: opts.counts?.flags }] },
      { key: 'guests', text: 'Guests', pages: [{ path: `${w}/guests`, text: 'Guest list', cap: 'guests.view' }, { path: `${w}/guests/seating`, text: 'Seating', cap: 'guests.view' }, { path: `${w}/gifts`, text: 'Gifts', cap: 'gifts.view' }, { path: `${w}/photos`, text: 'Photos', cap: 'photos.view' }] },
      approvals,
    ];
  const out: TabGroup[] = [];
  for (const s of sections) {
    const pages = s.pages.filter((p) => opens(opts.who, p.cap));
    const first = s.root ?? pages[0];
    if (!first) continue;
    const items = !s.root && pages.length === 1 ? [] : pages.map((p) => ({ href: p.path, text: p.text, count: p.count, exact: p.exact }));
    out.push({
      // A tab left with one page for this viewer (a helper) is named after that page, so "Guests" never opens Photos.
      // Its count is the sum of its pages' counts, so a badge on a second-row tab also shows on the top row (review).
      key: s.key, text: !s.root && pages.length === 1 ? pages[0]!.text : s.text, href: first.path,
      count: pages.reduce((n, p) => n + (p.count ?? 0), 0) || undefined,
      match: [...(s.root ? [{ href: s.root.path, exact: true }] : []), ...pages.map((p) => ({ href: p.path })), ...(s.also ?? []).map((href) => ({ href }))],
      items,
    });
  }
  return out;
}

/**
 * `mode`: the wedding's (Phase 5). In life-admin mode the nav is the couple's, and a page of the plan says it is the
 * archive, read-only (D-144). `life`: the page is one of life-admin mode's own (the home page, household tasks).
 * Round 2 (D-173): five top tabs and the current one's pages as a second row (`WeddingTabs`, the client half, marks the
 * current tab from the path); a count is a badge whose words stay in the link's name ("Approvals (1)").
 */
export function WeddingNav({ slug, counts, life, mode, who }: { slug: string; counts?: { approvals: number; flags: number }; life?: boolean; mode?: 'planning' | 'life'; who?: Who }) {
  const isLife = life || mode === 'life';
  const groups = weddingTabs(slug, { who, life: isLife, counts });
  if (isLife) {
    const base = `/o/${slug}/wedding`;
    return (
      <>
        <WeddingTabs groups={groups} />
        {!life && <p role="note" aria-label="Archive">From the <Link href={`${base}/archive`}>Archive</Link>: the wedding plan is read-only in life-admin mode.</p>}
      </>
    );
  }
  return <WeddingTabs groups={groups} />;
}

/** The designated actions in one sentence, the same on the home page and on Approvals (CLAUDE.md rule 2). */
export const designatedSentence = (threshold: string) =>
  `Booking a vendor, signing a contract, a spend over ${threshold}, moving the date, removing a guest, switching to life-admin mode and back, and changing these rules each need both of you.`;

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
export const MineNote = ({ mine }: { mine: { revealsOn: Day | null } | null }) => (mine ? <> <Status k="priv">private to you, {revealsOn(mine.revealsOn)}</Status></> : null);
export const privacyValue = (row: { privateToId: string | null; revealDays: number | null }, mine: unknown) => (mine ? (row.revealDays === null ? 'never' : String(row.revealDays)) : '');

export const NoWedding = ({ slug }: { slug: string }) => (
  <main>
    <h1>No wedding yet</h1>
    <p>
      <Link href={`/o/${slug}`}>Create the wedding</Link> first.
    </p>
  </main>
);

// Round 2 (D-179): the engine's `impossible` is shown as "can't fit before the day": still ahead, but it takes longer
// than the time left. The engine's identifiers are unchanged.
const STATE_TEXT = { ok: 'on track', late: 'late', impossible: "can't fit before the day", done: 'done' } as const;
export const stateText = (s: keyof typeof STATE_TEXT) => STATE_TEXT[s];

/** The cascade preview (PRD P0-1): what shifts, what is now late, what now cannot fit before the new date. */
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
        <li data-k={preview.impossible.length ? 'late' : undefined}>{preview.impossible.length} that can&apos;t fit before the new date{preview.impossible.length ? ` (${preview.impossible.filter((x) => x.isNew).length} new)` : ''}</li>
        {preview.resolved.length > 0 && <li>{preview.resolved.length} that were late or couldn&apos;t fit become on track</li>}
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
          <h3>Can&apos;t fit before the new date (each takes longer than the time left)</h3>
          <ul aria-label="Can't fit before the new date">{preview.impossible.map((x) => <li key={x.id}>{title.get(x.id)}: start by {showDay(preview.tasks[x.id]!.startBy)}, due {showDay(preview.tasks[x.id]!.due)}{x.isNew ? ' (new)' : ''}</li>)}</ul>
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
