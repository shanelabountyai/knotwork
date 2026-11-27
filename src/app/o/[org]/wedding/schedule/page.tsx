import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows, isPartner } from '@/lib/knotwork/access';
import { showDay } from '@/lib/knotwork/days';
import { scheduleView } from '@/lib/knotwork/secrecy/views';
import { addTask, removeTask, setTaskStatus, updateTask } from '../actions';
import { HiddenText, MineNote, NoWedding, PrivacySelect, privacyValue, stateText, WeddingNav } from '../bits';
import { Status, stateKind, TableWrap } from '@/app/ui/kw';
import { setTaskPrivacy } from '../privacy/actions';
import { nameOf, view } from '../view';

export const metadata = { title: 'Schedule' };

// PRD P0-1: every date on this page is computed, on this request, from the wedding date; none is stored.
// P1-1: the rows come through secrecy/views.ts. A task private to the other partner is a masked line with its dates.
export default async function Schedule({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ edit?: string }> }) {
  const ctx = await requireOrg((await params).org);
  const editId = (await searchParams).edit;
  const data = await view(ctx, 'schedule.view', async (tx, v) => ({ s: await scheduleView(tx, ctx, v) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, s } = data;
  const canEdit = allows(v.who, 'schedule.edit');
  const partner = isPartner(ctx.role);
  const shown = s.lines.flatMap((l) => (l.hidden ? [] : [l]));
  const editing = canEdit ? shown.find((l) => l.row.id === editId) : undefined;
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  const people = [...v.people];

  return (
    <main>
      <WeddingNav who={v.who} slug={ctx.slug} mode={v.wedding.mode} />
      <h1>Schedule</h1>
      <p className="kw-lede">
        Wedding: <strong>{showDay(v.date)}</strong>. Today: {showDay(v.today)}.
        {partner && <> <Link href={`/o/${ctx.slug}/wedding/date`}>Move the date</Link></>}
      </p>
      <div className="kw-grid">
      <section aria-label="Critical path">
        <h2>Critical path</h2>
        {s.criticalPath.length ? (
          <>
            <p>The longest chain back from the wedding. It needs {s.runwayDays} days{s.marginDays !== null && (s.marginDays >= 0 ? `; you have ${s.marginDays} to spare` : `; you are ${-s.marginDays} short`)}.</p>
            <ol>{s.criticalPath.map((title, n) => <li key={n}>{title}</li>)}</ol>
          </>
        ) : (
          <p>Every task is finished.</p>
        )}
      </section>
        {partner && (
          <div className="card">
            <h2>Move the date</h2>
            <p>Pick a new date to see what it does to the plan first. Nothing changes until your partner approves.</p>
            <form method="get" action={`/o/${ctx.slug}/wedding/date`}>
              <label>New date <input name="to" type="date" required /></label>
              <button type="submit" className="secondary">Preview the move</button>
            </form>
          </div>
        )}
      </div>

      <TableWrap label="Schedule">
      <table aria-label="Schedule">
        <thead>
          <tr><th scope="col">Task</th><th scope="col">Start by</th><th scope="col">Due</th><th scope="col">Slack</th><th scope="col">State</th><th scope="col">Who</th><th scope="col">Status</th></tr>
        </thead>
        <tbody>
          {s.lines.map((l, n) => {
            const d = l.dates;
            if (l.hidden) {
              return (
                <tr key={`hidden-${n}`} aria-label={l.label}>
                  <th scope="row"><HiddenText h={l} owner={nameOf(v, l.owner)} /></th>
                  <td>{showDay(d.startBy)}</td><td>{showDay(d.due)}</td><td>{d.slackDays === null ? '' : `${d.slackDays} days`}</td><td><Status k={stateKind(d.state)}>{stateText(d.state)}</Status></td><td /><td />
                </tr>
              );
            }
            const t = l.row;
            const mayMove = t.kind !== 'payment' && (canEdit || t.assigneeId === ctx.userId);
            return (
              <tr key={t.id} aria-label={`Task ${t.title}`}>
                <th scope="row">
                  {t.title}{l.critical && ' (critical)'}<MineNote mine={l.mine} />
                  {l.after.length > 0 && <small> after {l.after.join(', ')}</small>}
                </th>
                <td>{showDay(d.startBy)}</td>
                <td>{showDay(d.due)}</td>
                <td>{d.slackDays === null ? '' : `${d.slackDays} days`}</td>
                <td><Status k={stateKind(d.state)}>{stateText(d.state)}</Status></td>
                <td>{t.assigneeId ? nameOf(v, t.assigneeId) : ''}</td>
                <td>
                  {mayMove ? (
                    <ActionForm action={bind(setTaskStatus)}>
                      <input type="hidden" name="id" value={t.id} />
                      <select name="status" defaultValue={t.status} aria-label={`Status of ${t.title}`}>
                        <option value="todo">to do</option>
                        <option value="in_progress">in progress</option>
                        <option value="done">done</option>
                      </select>
                      <button type="submit" className="secondary">Save</button>
                    </ActionForm>
                  ) : (
                    { todo: 'to do', in_progress: 'in progress', done: 'done' }[t.status]
                  )}
                  {canEdit && <> <Link href={`/o/${ctx.slug}/wedding/schedule?edit=${t.id}`}>Edit</Link></>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </TableWrap>

      {canEdit && (
        <section aria-label={editing ? 'Edit task' : 'Add a task'}>
          <h2>{editing ? `Edit: ${editing.row.title}` : 'Add a task'}</h2>
          <p>A task has no date of its own. Say how long it takes and how long before the wedding it must be finished; its dates follow the wedding.</p>
          <ActionForm action={editing ? bind(updateTask) : bind(addTask)}>
            {editing && <input type="hidden" name="id" value={editing.row.id} />}
            <label>Title <input name="title" required maxLength={120} defaultValue={editing?.row.title} /></label>
            <label>Days it takes <input name="leadDays" inputMode="numeric" required defaultValue={editing?.row.leadDays ?? 7} /></label>
            <label>Finished at least this many days before the wedding <input name="bufferDays" inputMode="numeric" required defaultValue={editing?.row.bufferDays ?? 30} /></label>
            <label>
              Who
              <select name="assigneeId" defaultValue={editing?.row.assigneeId ?? ''}>
                <option value="">nobody yet</option>
                {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
            <label>
              Comes after
              <select name="dependsOn[]" multiple size={6} defaultValue={editing?.row.dependsOn.map((d) => d.dependsOnId) ?? []}>
                {s.options.filter((t) => t.id !== editing?.row.id).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
            </label>
            {!editing && partner && <PrivacySelect />}
            <button type="submit">{editing ? 'Save task' : 'Add task'}</button>
          </ActionForm>
          {editing && partner && editing.row.kind !== 'payment' && editing.row.kind !== 'rsvp' && (
            <ActionForm action={bind(setTaskPrivacy)}>
              <input type="hidden" name="id" value={editing.row.id} />
              <PrivacySelect defaultValue={privacyValue(editing.row, editing.mine)} />
              <button type="submit" className="secondary">Save privacy</button>
            </ActionForm>
          )}
          {editing && editing.row.kind !== 'payment' && editing.row.kind !== 'rsvp' && (
            <ActionForm action={bind(removeTask)}>
              <input type="hidden" name="id" value={editing.row.id} />
              <button type="submit" className="secondary">Remove this task</button>
            </ActionForm>
          )}
        </section>
      )}
    </main>
  );
}
