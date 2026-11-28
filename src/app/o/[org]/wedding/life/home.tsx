// Phase 5: the workspace home in life-admin mode, the couple's dashboard. A plain component the home page renders;
// its data comes from lifeadmin/store.ts (`lifeDashboard`) and, for the documents, secrecy/views.ts (`documentsView`),
// both read on this request. Nothing here is stored.
import Link from 'next/link';
import { showDay } from '@/lib/knotwork/days';
import type { lifeDashboard } from '@/lib/knotwork/lifeadmin/store';
import type { documentsView } from '@/lib/knotwork/secrecy/views';
import { showAge } from '@/lib/knotwork/thanks/aging';
import { WeddingNav } from '../bits';
import { nameOf, type View } from '../view';

type Life = Awaited<ReturnType<typeof lifeDashboard>>;
type Docs = Awaited<ReturnType<typeof documentsView>>;

export const DUE_TEXT = { overdue: 'overdue', today: 'due today', soon: 'due soon', later: 'coming up' } as const;
const days = (n: number) => (n === 1 ? '1 day' : `${n} days`);

export function LifeHome({ slug, v, life, docs, waiting }: { slug: string; v: View; life: Life; docs: Docs | null; waiting: number }) {
  const base = `/o/${slug}/wedding`;
  const { anniversary: a, household, thanks, nameChange, albums } = life;
  return (
    <main>
      <WeddingNav slug={slug} counts={{ approvals: waiting, flags: 0 }} life />
      <h1>{v.wedding.title}</h1>
      <p aria-label="Married">Married {showDay(v.date)}. The wedding plan is kept in the <Link href={`${base}/archive`}>Archive</Link>, read-only.</p>

      <section aria-label="Next anniversary">
        <h2>Next anniversary</h2>
        <p>{a.today ? <>Today is your <strong>{a.label}</strong>.</> : <>Your <strong>{a.label}</strong> is on {showDay(a.day)}, in {days(a.inDays)}.</>}</p>
      </section>

      {household && (
        <section aria-label="Household tasks">
          <h2><Link href={`${base}/life`}>Household tasks</Link></h2>
          {household.length === 0 ? <p>None yet. <Link href={`${base}/life`}>Add the things that come round again</Link>: the filter, the smoke alarms, the anniversary dinner.</p> : (
            <ul>
              {household.slice(0, 8).map((t) => (
                <li key={t.id}>{t.title}: {DUE_TEXT[t.state]}{t.never ? ' (never done)' : ''}, {showDay(t.due)}{t.state === 'overdue' ? `, ${days(t.overdueDays)} late` : ''} <small>({t.ruleText})</small></li>
              ))}
            </ul>
          )}
        </section>
      )}

      {thanks && (
        <section aria-label="Thank-yous still owed">
          <h2><Link href={`${base}/gifts/thank-yous`}>Thank-yous still owed</Link>: {thanks.owed.length}</h2>
          {thanks.owed.length > 0 && <p>{thanks.headline}. Oldest: {thanks.owed[0]!.giver} ({thanks.owed[0]!.what}), {showAge(thanks.owed[0]!.ageDays)}.</p>}
        </section>
      )}

      {nameChange && (
        <section aria-label="Name change">
          <h2><Link href={`${base}/name-change`}>Name change</Link></h2>
          {nameChange.mine ? <p>Yours: {nameChange.mine.board.done} of {nameChange.mine.board.total} steps done.</p> : <p>You have not started one. <Link href={`${base}/name-change`}>Start it</Link> if you are changing your name.</p>}
          {nameChange.others.map((o) => <p key={o.userId}>{nameOf(v, o.userId)}&apos;s (shared with you): {o.board.done} of {o.board.total} steps done.</p>)}
        </section>
      )}

      {docs && (
        <section aria-label="Documents">
          <h2>Documents</h2>
          <p>The vendors&apos; contract pages, read-only.</p>
          {docs.shown.length === 0 ? <p>No documents.</p> : (
            <ul>
              {docs.shown.map((d) => <li key={d.id}><a href={`${base}/vendors/${d.vendorId}/attachments/${d.id}`}>{d.label}</a> ({d.vendorName})</li>)}
            </ul>
          )}
          {docs.hidden > 0 && <p>{docs.hidden === 1 ? '1 more document belongs to a private vendor.' : `${docs.hidden} more documents belong to a private vendor.`}</p>}
        </section>
      )}

      {albums && (
        <section aria-label="Photo albums">
          <h2><Link href={`${base}/photos`}>Photos</Link></h2>
          {albums.length === 0 ? <p>No photo events.</p> : (
            <ul>{albums.map((e) => <li key={e.id}><Link href={`${base}/photos/${e.id}/album`}>{e.name}</Link>: {e.live} photos</li>)}</ul>
          )}
        </section>
      )}
    </main>
  );
}
