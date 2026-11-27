import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows, isPartner } from '@/lib/knotwork/access';
import { dayOfDb, showDay } from '@/lib/knotwork/days';
import { usd } from '@/lib/knotwork/money';
import { budgetView } from '@/lib/knotwork/secrecy/views';
import { Status, TableWrap } from '@/app/ui/kw';
import { addCategory, addExpense, takeBudgetSnapshot, updateCategory } from '../actions';
import { HiddenText, MineNote, NoWedding, PrivacySelect, privacyValue, WeddingNav } from '../bits';
import { setCategoryPrivacy, setExpensePrivacy } from '../privacy/actions';
import { nameOf, view } from '../view';

export const metadata = { title: 'Budget' };

// PRD P0-7: categories, estimates vs actuals in integer cents, snapshots. P1-2: each category's funding mix.
// P1-1: lines come through secrecy/views.ts. A category or spend private to the other partner is a masked line with
// no name and no figures; its amounts are in the totals ("amounts visible in totals, line hidden").
export default async function Budget({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'budget.view', async (tx, v) => ({ b: await budgetView(tx, ctx, v) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, b } = data;
  const canEdit = allows(v.who, 'budget.edit');
  const partner = isPartner(ctx.role);
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  const hiddenLines = b.lines.filter((l) => l.hidden).length + b.expenses.filter((e) => e.hidden).length;
  const t = b.totals;
  return (
    <main>
      <WeddingNav who={v.who} slug={ctx.slug} mode={v.wedding.mode} />
      <h1>Budget</h1>
      <TableWrap label="Budget">
      <table aria-label="Budget">
        <thead><tr><th scope="col">Category</th><th scope="col">Estimate</th><th scope="col">Actual</th><th scope="col">Remaining</th><th scope="col">Funded by</th>{canEdit && <th scope="col">Change estimate</th>}</tr></thead>
        <tbody>
          {b.lines.map((x, n) => {
            if (x.hidden) return <tr key={`hidden-${n}`} aria-label={x.label}><th scope="row"><HiddenText h={x} owner={nameOf(v, x.owner)} /></th><td /><td /><td /><td />{canEdit && <td />}</tr>;
            const l = x.row;
            return (
              <tr key={l.id} aria-label={`Category ${l.name}`}>
                <th scope="row">{l.name}<MineNote mine={x.mine} /></th><td>{usd(l.estimateCents)}</td><td>{usd(l.actualCents)}</td><td>{l.over ? <Status k="late">over by {usd(-l.remainingCents)}</Status> : usd(l.remainingCents)}</td>
                <td>{l.funding.length === 0 ? '' : l.funding.map((f) => `${f.funder}: ${usd(f.line.pledgedCents)} pledged, ${usd(f.line.receivedCents)} received, ${usd(f.line.spentCents)} spent`).join('; ')}</td>
                {canEdit && (
                  <td>
                    <ActionForm action={bind(updateCategory)}>
                      <input type="hidden" name="id" value={l.id} /><input type="hidden" name="name" value={l.name} />
                      <input name="estimate" defaultValue={(l.estimateCents / 100).toFixed(2)} aria-label={`Estimate for ${l.name}`} size={10} />
                      <button type="submit" className="secondary">Save</button>
                    </ActionForm>
                    {partner && (
                      <ActionForm action={bind(setCategoryPrivacy)}>
                        <input type="hidden" name="id" value={l.id} />
                        <PrivacySelect label={`Who sees ${l.name}`} defaultValue={privacyValue(l, x.mine)} />
                        <button type="submit" className="secondary">Save privacy</button>
                      </ActionForm>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr aria-label="Budget total"><th scope="row">Total</th><td>{usd(t.estimateCents)}</td><td>{usd(t.actualCents)}</td><td>{t.over ? `over by ${usd(-t.remainingCents)}` : usd(t.remainingCents)}</td><td><Link href={`/o/${ctx.slug}/wedding/funding`}>Funding</Link></td>{canEdit && <td />}</tr>
        </tfoot>
      </table>
      </TableWrap>
      {hiddenLines > 0 && <p role="note">The totals include {hiddenLines} private {hiddenLines === 1 ? 'line' : 'lines'}, shown here without a name or an amount until they are revealed.</p>}

      {canEdit && (
        <>
          <h2>Add a category</h2>
          <ActionForm action={bind(addCategory)}>
            <label>Name <input name="name" required maxLength={60} /></label>
            <label>Estimate <input name="estimate" required placeholder="3,000.00" /></label>
            {partner && <PrivacySelect />}
            <button type="submit">Add category</button>
          </ActionForm>
          <h2>Record a spend</h2>
          <p>A spend over {usd(v.wedding.spendThresholdCents)} is not recorded here: it goes to your partner for approval first, so it cannot be private, and proposing it reveals a private category or vendor it names.</p>
          <ActionForm action={bind(addExpense)}>
            <label>Category <select name="categoryId" required aria-label="Spend category">{b.categoryOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label>Vendor <select name="vendorId" aria-label="Spend vendor"><option value="">none</option>{b.vendorOptions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            <label>What it was for <input name="description" required maxLength={200} /></label>
            <label>Amount <input name="amount" required placeholder="250.00" /></label>
            <label>Paid on <input name="paidOn" type="date" /></label>
            {partner && <PrivacySelect />}
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
        {b.snapshots.map((s) => <li key={s.id}>{s.takenAt.toISOString().slice(0, 16).replace('T', ' ')} UTC: estimate {usd(s.totals.estimateCents)}, actual {usd(s.totals.actualCents)}{s.note && ` (${s.note})`}</li>)}
      </ul>

      <h2>Spends</h2>
      <TableWrap label="Spends">
      <table aria-label="Spends">
        <thead><tr><th scope="col">Paid on</th><th scope="col">What</th><th scope="col">Category</th><th scope="col">Vendor</th><th scope="col">Amount</th><th scope="col">Approved by both</th></tr></thead>
        <tbody>
          {b.expenses.map((x, n) => {
            if (x.hidden) return <tr key={`hidden-${n}`} aria-label={x.label}><td /><th scope="row"><HiddenText h={x} owner={nameOf(v, x.owner)} /></th><td /><td /><td /><td /></tr>;
            const e = x.row;
            return (
              <tr key={e.id}>
                <td>{showDay(dayOfDb(e.paidOn))}</td>
                <th scope="row">
                  {e.description}<MineNote mine={x.mine} />
                  {partner && canEdit && !e.requestId && (
                    <ActionForm action={bind(setExpensePrivacy)}>
                      <input type="hidden" name="id" value={e.id} />
                      <PrivacySelect label={`Who sees ${e.description}`} defaultValue={privacyValue(e, x.mine)} />
                      <button type="submit" className="secondary">Save privacy</button>
                    </ActionForm>
                  )}
                </th>
                <td>{e.category.name}</td><td>{e.vendor?.name ?? ''}</td><td>{usd(e.amountCents)}</td><td>{e.requestId ? <Status k="ok">yes</Status> : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </TableWrap>
      {b.expenses.length === 0 && <p>No spends recorded yet.</p>}
    </main>
  );
}
