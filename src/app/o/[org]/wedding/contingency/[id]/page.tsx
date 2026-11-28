import { TableWrap } from '@/app/ui/kw';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { showDay, dayOfDb } from '@/lib/knotwork/days';
import { usd } from '@/lib/knotwork/money';
import { TREE_TEXT_MAX } from '@/lib/knotwork/contingency/schema';
import { loadPlan, previewFor, TITLE_MAX } from '@/lib/knotwork/contingency/store';
import { parsePath, showPath, walk, type Tree } from '@/lib/knotwork/contingency/tree';
import { contingencyWorld, seenFor } from '@/lib/knotwork/secrecy/views';
import { NoWedding, stateText, WeddingNav } from '../../bits';
import { nameOf, view } from '../../view';
import { executeContingencyBranch, removeContingencyPlan, tickContingencyItem, updateContingencyPlan } from '../actions';

export const metadata = { title: 'Contingency plan' };

// P1-6: one plan. Answer its questions (each answer is a link, so the page works without script); at an outcome the
// page shows exactly what putting it into action would change (previewBranch), and the button sends that preview's
// fingerprint, so what runs is what was shown. After it ran: the answers given, what was done, and the checklist.
export default async function Plan({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: Promise<{ path?: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  const asked = parsePath((await searchParams).path ?? '') ?? [];
  const data = await view(ctx, 'contingency.view', async (tx, v) => {
    const plan = await loadPlan(tx, ctx, id);
    if (!plan || plan.run) return { plan, preview: null };
    return { plan, preview: previewFor(plan.tree, asked, await contingencyWorld(tx, ctx, v.wedding, seenFor(ctx, v))) };
  });
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, plan, preview } = data;
  if (!plan) notFound();
  const href = (p: readonly number[]) => `/o/${ctx.slug}/wedding/contingency/${plan.id}${p.length ? `?path=${showPath(p)}` : ''}`;

  if (plan.run) {
    const ran = walk(plan.tree, plan.run.path as number[]);
    const result = plan.run.result as { tasks: string[]; expenses: string[]; requests: string[] };
    return (
      <main>
        <WeddingNav who={v.who} slug={ctx.slug} mode={v.wedding.mode} />
        <h1>{plan.title}</h1>
        <p>Put into action on {showDay(dayOfDb(plan.run.executedAt))} by {nameOf(v, plan.run.executedById)}. A plan runs once.</p>
        {ran && <Answers answers={ran.answers} />}
        <p>Outcome: <strong>{ran?.node.type === 'leaf' ? ran.node.title : plan.run.leaf}</strong>.</p>
        <p>
          {result.tasks.length} tasks added to the <Link href={`/o/${ctx.slug}/wedding/schedule`}>schedule</Link>, {result.expenses.length} spends recorded on the{' '}
          <Link href={`/o/${ctx.slug}/wedding/budget`}>budget</Link>, {result.requests.length} spends waiting on the <Link href={`/o/${ctx.slug}/wedding/approvals`}>approvals page</Link>.
        </p>
        <h2>Checklist</h2>
        <ul aria-label="Checklist">
          {plan.run.items.map((it) => (
            <li key={it.id} aria-label={it.text}>
              {it.doneOn ? <s>{it.text}</s> : it.text}{it.doneOn && <small> (done {showDay(dayOfDb(it.doneOn))})</small>}
              <ActionForm action={tickContingencyItem.bind(null, ctx.slug)}>
                <input type="hidden" name="id" value={it.id} />
                <input type="hidden" name="done" value={it.doneOn ? '' : 'on'} />
                <button type="submit">{it.doneOn ? 'Not done' : 'Done'}: {it.text.slice(0, 60)}</button>
              </ActionForm>
            </li>
          ))}
        </ul>
        <Outline tree={plan.tree} />
      </main>
    );
  }

  const at = walk(plan.tree, asked) ?? walk(plan.tree, [])!;
  const path = at.answers.map((a) => a.index);
  return (
    <main>
      <WeddingNav who={v.who} slug={ctx.slug} mode={v.wedding.mode} />
      <h1>{plan.title}</h1>
      <p>Not put into action yet. Answer the questions to see what it would do.</p>
      <Answers answers={at.answers} back={(i) => href(path.slice(0, i))} />
      {at.node.type === 'question' ? (
        <section aria-label="Question">
          <h2>{at.node.text}</h2>
          <ul aria-label="Answers to choose from">
            {at.node.branches.map((b, i) => <li key={i}><Link href={href([...path, i])}>{b.label}</Link></li>)}
          </ul>
        </section>
      ) : preview && (
        <section aria-label="What this would do">
          <h2>{preview.leaf.title}</h2>
          <h3>Checklist</h3>
          {preview.items.length ? <ul aria-label="Checklist preview">{preview.items.map((it, i) => <li key={i}>{it.text}</li>)}</ul> : <p>Nothing to tick off.</p>}
          <h3>Vendors to tell</h3>
          {preview.notify.length ? (
            <ul aria-label="Vendors to tell">{preview.notify.map((n, i) => <li key={i}><strong>{n.name}</strong>{n.phone && ` (${n.phone})`}: {n.message}</li>)}</ul>
          ) : <p>No booked vendor to tell.</p>}
          <h3>Tasks to add to the schedule</h3>
          {preview.tasks.length ? (
            <TableWrap label="Tasks to add">
            <table aria-label="Tasks to add">
              <thead><tr><th scope="col">Task</th><th scope="col">Start by</th><th scope="col">Due</th><th scope="col">State</th></tr></thead>
              <tbody>{preview.tasks.map((t) => <tr key={t.key}><th scope="row">{t.title}</th><td>{showDay(t.startBy)}</td><td>{showDay(t.due)}</td><td>{stateText(t.state)}</td></tr>)}</tbody>
            </table>
            </TableWrap>
          ) : <p>No tasks to add.</p>}
          <p><small>Dates are worked out from the wedding date ({showDay(v.date)}); nothing already on the schedule moves.</small></p>
          <h3>Spends</h3>
          {preview.spends.length ? (
            <ul aria-label="Spends">
              {preview.spends.map((s, i) => <li key={i}>{s.description} ({s.category}), {usd(s.amountCents)}: {s.designated ? `over ${usd(v.wedding.spendThresholdCents)}, so it is proposed for your partner to approve` : 'recorded on the budget'}</li>)}
            </ul>
          ) : <p>No spends.</p>}
          {preview.problems.length > 0 && (
            <ul aria-label="Problems">{preview.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
          )}
          <ActionForm action={executeContingencyBranch.bind(null, ctx.slug)}>
            <input type="hidden" name="id" value={plan.id} />
            <input type="hidden" name="path" value={showPath(path)} />
            <input type="hidden" name="fingerprint" value={preview.fingerprint} />
            <button type="submit">Put this into action</button>
          </ActionForm>
        </section>
      )}

      <Outline tree={plan.tree} />
      <details>
        <summary>Change this plan</summary>
        <ActionForm action={updateContingencyPlan.bind(null, ctx.slug)}>
          <input type="hidden" name="id" value={plan.id} />
          <label>Name <input name="title" required maxLength={TITLE_MAX} defaultValue={plan.title} /></label>
          <label>Plan (JSON) <textarea name="tree" rows={16} cols={80} maxLength={TREE_TEXT_MAX} defaultValue={JSON.stringify(plan.tree, null, 2)} /></label>
          <button type="submit">Save the plan</button>
        </ActionForm>
        <ActionForm action={removeContingencyPlan.bind(null, ctx.slug)}>
          <input type="hidden" name="id" value={plan.id} />
          <button type="submit">Remove this plan</button>
        </ActionForm>
      </details>
    </main>
  );
}

function Answers({ answers, back }: { answers: { question: string; answer: string }[]; back?: (i: number) => string }) {
  if (!answers.length) return null;
  return (
    <ol aria-label="Answers so far">
      {answers.map((a, i) => <li key={i}>{a.question} <strong>{a.answer}</strong>{back && <> (<Link href={back(i)}>change</Link>)</>}</li>)}
    </ol>
  );
}

/** The whole tree as nested lists, for reading. */
function Outline({ tree }: { tree: Tree }) {
  const node = (k: string): React.ReactNode => {
    const n = tree.nodes[k]!;
    if (n.type === 'leaf') return <em>{n.title}</em>;
    return <>{n.text}<ul>{n.branches.map((b, i) => <li key={i}>{b.label}: {node(b.next)}</li>)}</ul></>;
  };
  return (
    <details>
      <summary>The whole plan</summary>
      <div aria-label="The whole plan">{node(tree.root)}</div>
    </details>
  );
}
