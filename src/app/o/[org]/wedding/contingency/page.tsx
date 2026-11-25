import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { showDay, dayOfDb } from '@/lib/knotwork/days';
import { STARTER_KEYS, STARTERS, TREE_TEXT_MAX } from '@/lib/knotwork/contingency/schema';
import { listPlans, TITLE_MAX } from '@/lib/knotwork/contingency/store';
import { paths } from '@/lib/knotwork/contingency/tree';
import { NoWedding, WeddingNav } from '../bits';
import { view } from '../view';
import { createContingencyPlan } from './actions';

export const metadata = { title: 'Contingency plans' };

// PRD P1-6: contingency decision trees (a rain plan, a vendor no-show, someone running late). Each plan is a few
// questions; each set of answers ends in an outcome, which is what to do. Putting one outcome into action adds its
// tasks to the schedule (their dates from the wedding date), records its small spends, PROPOSES any spend over the
// threshold for the other partner to approve, and leaves a checklist. A plan runs once. Partners only.
export default async function Contingency({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'contingency.view', async (tx) => ({ plans: await listPlans(tx, ctx) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { plans } = data;
  return (
    <main>
      <WeddingNav slug={ctx.slug} mode={data.v.wedding.mode} />
      <h1>Contingency plans</h1>
      {plans.length === 0 && <p>No plans yet. Start from one of the starters below and change it to fit your day.</p>}
      <ul aria-label="Plans">
        {plans.map((p) => (
          <li key={p.id}>
            <Link href={`/o/${ctx.slug}/wedding/contingency/${p.id}`}>{p.title}</Link>: {paths(p.tree).length} outcomes.{' '}
            {p.run ? `Put into action on ${showDay(dayOfDb(p.run.executedAt))}.` : 'Not put into action.'}
          </li>
        ))}
      </ul>

      <h2>New plan</h2>
      <ActionForm action={createContingencyPlan.bind(null, ctx.slug)}>
        <label>Name <input name="title" required maxLength={TITLE_MAX} placeholder="Rain plan" /></label>
        <label>Start from <select name="starter" defaultValue="rain">
          {STARTER_KEYS.map((k) => <option key={k} value={k}>{STARTERS[k].title}</option>)}
        </select></label>
        <details>
          <summary>Or paste a plan (JSON)</summary>
          <label>Plan <textarea name="tree" rows={8} cols={80} maxLength={TREE_TEXT_MAX} /></label>
        </details>
        <button type="submit">Create the plan</button>
      </ActionForm>
    </main>
  );
}
