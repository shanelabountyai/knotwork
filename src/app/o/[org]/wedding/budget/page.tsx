import { inOrg, requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { loadBudget } from '@/lib/knotwork/budget-store';
import type { Rollup } from '@/lib/knotwork/budget';
import { dayOfDb, showDay } from '@/lib/knotwork/days';
import { usd } from '@/lib/knotwork/money';
import { addCategory, addExpense, takeBudgetSnapshot, updateCategory } from '../actions';
import { NoWedding, WeddingNav } from '../bits';
import { view } from '../view';

export const metadata = { title: 'Budget' };

// PRD P0-7: categories, estimates vs actuals in integer cents, snapshots.
export default async function Budget({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'budget.view', async (tx) => ({
    budget: await loadBudget(tx, ctx),
    expenses: await tx.expense.findMany({ where: inOrg(ctx), include: { category: { select: { name: true } }, vendor: { select: { name: true } } }, orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }], take: 100 }),
    snapshots: await tx.budgetSnapshot.findMany({ where: inOrg(ctx), orderBy: { takenAt: 'desc' }, take: 20 }),
    vendors: await tx.vendor.findMany({ where: inOrg(ctx), select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, budget, expenses, snapshots, vendors } = data;
  const canEdit = allows(v.who, 'budget.edit');
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  return (
    <main>
      <WeddingNav slug={ctx.slug} />
      <h1>Budget</h1>
      <table aria-label="Budget">
        <thead><tr><th scope="col">Category</th><th scope="col">Estimate</th><th scope="col">Actual</th><th scope="col">Remaining</th>{canEdit && <th scope="col">Change estimate</th>}</tr></thead>
        <tbody>
          {budget.lines.map((l) => (
            <tr key={l.id} aria-label={`Category ${l.name}`}>
              <th scope="row">{l.name}</th><td>{usd(l.estimateCents)}</td><td>{usd(l.actualCents)}</td><td>{l.over ? `over by ${usd(-l.remainingCents)}` : usd(l.remainingCents)}</td>
              {canEdit && (
                <td>
                  <ActionForm action={bind(updateCategory)}>
                    <input type="hidden" name="id" value={l.id} /><input type="hidden" name="name" value={l.name} />
                    <input name="estimate" defaultValue={(l.estimateCents / 100).toFixed(2)} aria-label={`Estimate for ${l.name}`} size={10} />
                    <button type="submit">Save</button>
                  </ActionForm>
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr aria-label="Budget total"><th scope="row">Total</th><td>{usd(budget.estimateCents)}</td><td>{usd(budget.actualCents)}</td><td>{budget.over ? `over by ${usd(-budget.remainingCents)}` : usd(budget.remainingCents)}</td>{canEdit && <td />}</tr>
        </tfoot>
      </table>

      {canEdit && (
        <>
          <h2>Add a category</h2>
          <ActionForm action={bind(addCategory)}>
            <label>Name <input name="name" required maxLength={60} /></label>
            <label>Estimate <input name="estimate" required placeholder="3,000.00" /></label>
            <button type="submit">Add category</button>
          </ActionForm>
          <h2>Record a spend</h2>
          <p>A spend over {usd(v.wedding.spendThresholdCents)} is not recorded here: it goes to your partner for approval first.</p>
          <ActionForm action={bind(addExpense)}>
            <label>Category <select name="categoryId" required aria-label="Spend category">{budget.lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
            <label>Vendor <select name="vendorId" aria-label="Spend vendor"><option value="">none</option>{vendors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            <label>What it was for <input name="description" required maxLength={200} /></label>
            <label>Amount <input name="amount" required placeholder="250.00" /></label>
            <label>Paid on <input name="paidOn" type="date" /></label>
            <button type="submit">Record spend</button>
          </ActionForm>
          <h2>Snapshots</h2>
          <ActionForm action={bind(takeBudgetSnapshot)}>
            <label>Note <input name="note" maxLength={200} /></label>
            <button type="submit">Take a snapshot</button>
          </ActionForm>
        </>
      )}
      <ul aria-label="Snapshots">
        {snapshots.map((s) => {
          const t = s.totals as unknown as Rollup;
          return <li key={s.id}>{s.takenAt.toISOString().slice(0, 16).replace('T', ' ')} UTC: estimate {usd(t.estimateCents)}, actual {usd(t.actualCents)}{s.note && ` (${s.note})`}</li>;
        })}
      </ul>

      <h2>Spends</h2>
      <table aria-label="Spends">
        <thead><tr><th scope="col">Paid on</th><th scope="col">What</th><th scope="col">Category</th><th scope="col">Vendor</th><th scope="col">Amount</th><th scope="col">Approved by both</th></tr></thead>
        <tbody>
          {expenses.map((e) => (
            <tr key={e.id}><td>{showDay(dayOfDb(e.paidOn))}</td><th scope="row">{e.description}</th><td>{e.category.name}</td><td>{e.vendor?.name ?? ''}</td><td>{usd(e.amountCents)}</td><td>{e.requestId ? 'yes' : ''}</td></tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
