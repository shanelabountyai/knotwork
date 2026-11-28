import Link from 'next/link';
import { dueKind, Status } from '@/app/ui/kw';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { showDay } from '@/lib/knotwork/days';
import { EVERY_MAX, UNITS } from '@/lib/knotwork/lifeadmin/recurrence';
import { householdTasks } from '@/lib/knotwork/lifeadmin/store';
import { NoWedding, WeddingNav } from '../bits';
import { view } from '../view';
import { householdTask } from './actions';
import { DUE_TEXT } from './home';

export const metadata = { title: 'Household tasks' };

const UNIT_TEXT = { day: 'days', week: 'weeks', month: 'months', anniversary: 'yearly, on the anniversary' } as const;

// Phase 5, life-admin mode: recurring household tasks. A task stores a rule (every N days, weeks or months, or yearly
// on the anniversary) and the days it was done; when it is next due is worked out on this request
// (lifeadmin/recurrence.ts) and never stored (rule 1). Partners only (D-147). In planning mode the page says when it begins.
export default async function Household({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'life.view', async (tx, v) => ({ tasks: v.wedding.mode === 'life' ? await householdTasks(tx, ctx, v) : null }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { tasks } = data;
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  if (!tasks) {
    return (
      <main>
        <WeddingNav who={data.v.who} slug={ctx.slug} />
        <h1>Household tasks</h1>
        <p>Household tasks begin in life-admin mode, after the wedding. <Link href={`/o/${ctx.slug}/wedding/archive`}>About life-admin mode</Link>.</p>
      </main>
    );
  }
  return (
    <main>
      <WeddingNav who={data.v.who} slug={ctx.slug} life />
      <h1>Household tasks</h1>
      <p>Things that come round again. Each one is next due its interval after the last time it was done (a month from the 31st lands on the month&apos;s last day), or, yearly, on your anniversary. Never done: due now.</p>

      {tasks.length === 0 ? <p>No household tasks yet.</p> : (
        <ul aria-label="Household tasks" className="kw-plain kw-cards">
          {tasks.map((t) => (
            <li key={t.id} aria-label={t.title}>
              <strong>{t.title}</strong>: <Status k={dueKind(t.state)}>{DUE_TEXT[t.state]}</Status>{t.never ? ' (never done)' : ''}, {showDay(t.due)} <small>({t.ruleText}{t.lastDone ? `; last done ${showDay(t.lastDone)}` : ''})</small>
              {t.notes && <p>{t.notes}</p>}
              <ActionForm action={bind(householdTask)}>
                <input type="hidden" name="op" value="done" />
                <input type="hidden" name="id" value={t.id} />
                <label>Done on <input name="on" type="date" /></label>
                <span className="kw-row"><button type="submit" aria-label={`Mark ${t.title} done`}>Mark done</button> <small>(empty: today)</small></span>
              </ActionForm>
              {t.recent.length > 0 && (
                <details>
                  <summary>Done {t.doneCount === 1 ? 'once' : `${t.doneCount} times`}</summary>
                  <ul>
                    {t.recent.map((d) => (
                      <li key={d}>{showDay(d)}{' '}
                        <ActionForm action={bind(householdTask)}>
                          <input type="hidden" name="op" value="undo" />
                          <input type="hidden" name="id" value={t.id} />
                          <input type="hidden" name="on" value={d} />
                          <button type="submit" className="secondary" aria-label={`Take ${showDay(d)} off ${t.title}`}>Take off</button>
                        </ActionForm>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <details>
                <summary>Change or remove</summary>
                <ActionForm action={bind(householdTask)}>
                  <input type="hidden" name="op" value="edit" />
                  <input type="hidden" name="id" value={t.id} />
                  <RuleFields title={t.title} unit={t.rule.unit} every={t.rule.every} notes={t.notes} />
                  <button type="submit" className="secondary">Save</button>
                </ActionForm>
                <ActionForm action={bind(householdTask)}>
                  <input type="hidden" name="op" value="remove" />
                  <input type="hidden" name="id" value={t.id} />
                  <button type="submit" className="secondary" aria-label={`Remove ${t.title}`}>Remove</button>
                </ActionForm>
              </details>
            </li>
          ))}
        </ul>
      )}

      <section aria-label="Add a household task">
        <h2>Add a household task</h2>
        <ActionForm action={bind(householdTask)}>
          <input type="hidden" name="op" value="add" />
          <RuleFields title="" unit="month" every={1} notes="" />
          <button type="submit">Add the task</button>
        </ActionForm>
      </section>
    </main>
  );
}

function RuleFields({ title, unit, every, notes }: { title: string; unit: (typeof UNITS)[number]; every: number; notes: string }) {
  return (
    <>
      <label>Task <input name="title" required maxLength={120} defaultValue={title} placeholder="Change the furnace filter" /></label>
      <label>Every <input name="every" type="number" min={1} max={EVERY_MAX.day} defaultValue={every} /></label>
      <label>Unit <select name="unit" defaultValue={unit}>{UNITS.map((u) => <option key={u} value={u}>{UNIT_TEXT[u]}</option>)}</select></label>
      <label>Notes <input name="notes" maxLength={2000} defaultValue={notes} /></label>
    </>
  );
}
