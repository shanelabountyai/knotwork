import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows, isPartner } from '@/lib/knotwork/access';
import { showDay } from '@/lib/knotwork/days';
import { loadSchedule } from '@/lib/knotwork/schedule/store';
import { addTask, removeTask, setTaskStatus, updateTask } from '../actions';
import { NoWedding, stateText, WeddingNav } from '../bits';
import { nameOf, view } from '../view';

export const metadata = { title: 'Schedule' };

// PRD P0-1: every date on this page is computed, on this request, from the wedding date; none is stored.
export default async function Schedule({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ edit?: string }> }) {
  const ctx = await requireOrg((await params).org);
  const editId = (await searchParams).edit;
  const data = await view(ctx, 'schedule.view', async (tx, v) => ({ ...(await loadSchedule(tx, ctx, v.wedding)) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, rows, schedule } = data;
  const canEdit = allows(v.who, 'schedule.edit');
  const critical = new Set(schedule.criticalPath);
  const sorted = [...rows].sort((a, b) => (schedule.tasks[a.id]!.startBy < schedule.tasks[b.id]!.startBy ? -1 : schedule.tasks[a.id]!.startBy > schedule.tasks[b.id]!.startBy ? 1 : a.title.localeCompare(b.title)));
  const editing = canEdit ? rows.find((t) => t.id === editId) : undefined;
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  const title = new Map(rows.map((t) => [t.id, t.title]));
  const people = [...v.people];

  return (
    <main>
      <WeddingNav slug={ctx.slug} />
      <h1>Schedule</h1>
      <p>
        Wedding: <strong>{showDay(v.date)}</strong>. Today: {showDay(v.today)}.
        {isPartner(ctx.role) && <> <Link href={`/o/${ctx.slug}/wedding/date`}>Move the date</Link></>}
      </p>
      <section aria-label="Critical path">
        <h2>Critical path</h2>
        {schedule.criticalPath.length ? (
          <>
            <p>The longest chain back from the wedding. It needs {schedule.runwayDays} days{schedule.marginDays !== null && (schedule.marginDays >= 0 ? `; you have ${schedule.marginDays} to spare` : `; you are ${-schedule.marginDays} short`)}.</p>
            <ol>{schedule.criticalPath.map((id) => <li key={id}>{title.get(id)}</li>)}</ol>
          </>
        ) : (
          <p>Every task is finished.</p>
        )}
      </section>

      <table aria-label="Schedule">
        <thead>
          <tr><th scope="col">Task</th><th scope="col">Start by</th><th scope="col">Due</th><th scope="col">Slack</th><th scope="col">State</th><th scope="col">Who</th><th scope="col">Status</th></tr>
        </thead>
        <tbody>
          {sorted.map((t) => {
            const s = schedule.tasks[t.id]!;
            const mayMove = t.kind !== 'payment' && (canEdit || t.assigneeId === ctx.userId);
            return (
              <tr key={t.id} aria-label={`Task ${t.title}`}>
                <th scope="row">
                  {t.title}{critical.has(t.id) && ' (critical)'}
                  {t.dependsOn.length > 0 && <small> after {t.dependsOn.map((d) => title.get(d.dependsOnId)).join(', ')}</small>}
                </th>
                <td>{showDay(s.startBy)}</td>
                <td>{showDay(s.due)}</td>
                <td>{s.slackDays === null ? '' : `${s.slackDays} days`}</td>
                <td>{stateText(s.state)}</td>
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
                      <button type="submit">Save</button>
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

      {canEdit && (
        <section aria-label={editing ? 'Edit task' : 'Add a task'}>
          <h2>{editing ? `Edit: ${editing.title}` : 'Add a task'}</h2>
          <p>A task has no date of its own. Say how long it takes and how long before the wedding it must be finished; its dates follow the wedding.</p>
          <ActionForm action={editing ? bind(updateTask) : bind(addTask)}>
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <label>Title <input name="title" required maxLength={120} defaultValue={editing?.title} /></label>
            <label>Days it takes <input name="leadDays" inputMode="numeric" required defaultValue={editing?.leadDays ?? 7} /></label>
            <label>Finished at least this many days before the wedding <input name="bufferDays" inputMode="numeric" required defaultValue={editing?.bufferDays ?? 30} /></label>
            <label>
              Who
              <select name="assigneeId" defaultValue={editing?.assigneeId ?? ''}>
                <option value="">nobody yet</option>
                {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
            <label>
              Comes after
              <select name="dependsOn[]" multiple size={6} defaultValue={editing?.dependsOn.map((d) => d.dependsOnId) ?? []}>
                {rows.filter((t) => t.id !== editing?.id).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
            </label>
            <button type="submit">{editing ? 'Save task' : 'Add task'}</button>
          </ActionForm>
          {editing && editing.kind !== 'payment' && editing.kind !== 'rsvp' && (
            <ActionForm action={bind(removeTask)}>
              <input type="hidden" name="id" value={editing.id} />
              <button type="submit">Remove this task</button>
            </ActionForm>
          )}
        </section>
      )}
    </main>
  );
}
