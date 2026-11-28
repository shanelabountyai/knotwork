import { TableWrap } from '@/app/ui/kw';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { showDay } from '@/lib/knotwork/days';
import { fundingView } from '@/lib/knotwork/funding/store';
import { usd } from '@/lib/knotwork/money';
import { fundingOptions, seenFor } from '@/lib/knotwork/secrecy/views';
import { HiddenText, NoWedding, WeddingNav } from '../bits';
import { nameOf, view } from '../view';
import { addFunder, addPledge, changePledge, linkFunder, payFromPledge, recordReceipt, removeFromPledge, removeReceipt, unlinkFunder } from './actions';

export const metadata = { title: 'Funding' };

const STAGE = { pledged: 'pledged', partly_received: 'partly received', received: 'received', spent: 'all spent' } as const;

// P1-2, the multi-funder family budget: who pledged what toward which category; what arrived; what it paid for.
// A partner, or a helper who can see the budget, sees every funder. A helper linked to a funder (the `funder` grant)
// sees only that funder: the categories it pledged toward, by name, and its own pledges, receipts and spends. Nothing
// else of the budget (funding/store.ts `fundingView` is the only reader). P1-1 applies on top: a pledge toward a
// private category, or a payment toward a private spend, is a masked line; its amount is in the funder's totals.
export default async function Funding({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'funding.view', async (tx, v) => {
    const f = await fundingView(tx, ctx, v.who, seenFor(ctx, v));
    const canEdit = allows(v.who, 'budget.edit');
    return {
      f, canEdit,
      options: canEdit ? await fundingOptions(tx, ctx, v) : null,
      helpers: allows(v.who, 'helpers.manage') ? await tx.membership.findMany({ where: { ...inOrg(ctx), role: { not: 'owner' } }, select: { userId: true, user: { select: { email: true, name: true } } }, orderBy: { createdAt: 'asc' } }) : [],
    };
  });
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, f, canEdit, options, helpers } = data;
  if (!f) return <NoWedding slug={ctx.slug} />;
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  const linking = helpers.length > 0;

  return (
    <main>
      <WeddingNav who={v.who} slug={ctx.slug} mode={v.wedding.mode} />
      <h1>{f.scope === 'own' ? 'What you are giving toward' : 'Funding'}</h1>
      {f.scope === 'own' ? (
        <p>What you pledged, what has arrived, and what it has paid for. The rest of the budget is the couple&apos;s.</p>
      ) : (
        <p>Family and friends who are helping pay: each pledge is toward one budget category. Money received is recorded as it arrives; spending it means paying part of a spend in that category from it.</p>
      )}
      {f.funders.length === 0 && <p>{f.scope === 'own' ? 'You are not linked to a funder yet.' : 'No funders yet.'}</p>}

      {f.funders.map((fu) => (
        <section key={fu.id} aria-label={`Funder ${fu.name}`}>
          <h2>{fu.name}</h2>
          {fu.note && <p>{fu.note}</p>}
          <p aria-label={`Totals for ${fu.name}`}>Pledged {usd(fu.pledgedCents)} · received {usd(fu.receivedCents)} · spent {usd(fu.spentCents)}</p>
          {f.scope === 'all' && fu.userId && <p>Linked to {nameOf(v, fu.userId)}, who sees only this funder&apos;s part.</p>}
          <TableWrap label={`Pledges from ${fu.name}`}>
          <table aria-label={`Pledges from ${fu.name}`}>
            <thead><tr><th scope="col">Toward</th><th scope="col">Pledged</th><th scope="col">Received</th><th scope="col">Spent</th><th scope="col">Stage</th></tr></thead>
            <tbody>
              {fu.pledges.map((x, n) => {
                if (x.hidden) return <tr key={`hidden-${n}`} aria-label={x.label}><th scope="row"><HiddenText h={x} owner={nameOf(v, x.owner)} /></th><td /><td /><td /><td /></tr>;
                const p = x.row;
                return (
                  <tr key={p.id} aria-label={`Pledge toward ${p.categoryName}`}>
                    <th scope="row">
                      {p.categoryName}
                      {p.receipts.length > 0 && (
                        <ul aria-label={`Received toward ${p.categoryName}`}>
                          {p.receipts.map((r) => (
                            <li key={r.id}>
                              {usd(r.amountCents)} on {showDay(r.receivedOn)}{r.note && ` (${r.note})`}
                              {canEdit && <ActionForm action={bind(removeReceipt)}><input type="hidden" name="id" value={r.id} /><button type="submit">Take back</button></ActionForm>}
                            </li>
                          ))}
                        </ul>
                      )}
                      {p.paid.length > 0 && (
                        <ul aria-label={`Paid for from ${p.categoryName}`}>
                          {p.paid.map((a, k) => (a.hidden
                            ? <li key={`hidden-${k}`}><HiddenText h={a} owner={nameOf(v, a.owner)} /></li>
                            : (
                              <li key={a.row.id}>
                                {usd(a.row.amountCents)} of {a.row.description} ({showDay(a.row.paidOn)})
                                {canEdit && <ActionForm action={bind(removeFromPledge)}><input type="hidden" name="id" value={a.row.id} /><button type="submit">Undo</button></ActionForm>}
                              </li>
                            )))}
                        </ul>
                      )}
                    </th>
                    <td>{usd(p.line.pledgedCents)}</td><td>{usd(p.line.receivedCents)}</td><td>{usd(p.line.spentCents)}</td><td>{STAGE[p.line.stage]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </TableWrap>

          {canEdit && options && (
            <details>
              <summary>Change {fu.name}&apos;s pledges</summary>
              <ActionForm action={bind(addPledge)}>
                <input type="hidden" name="funderId" value={fu.id} />
                <label>Toward <select name="categoryId" aria-label={`New pledge category for ${fu.name}`}>{options.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
                <label>Amount <input name="amount" required placeholder="5,000.00" /></label>
                <button type="submit">Add pledge</button>
              </ActionForm>
              {fu.pledges.flatMap((x) => (x.hidden ? [] : [x.row])).map((p) => (
                <div key={p.id}>
                  <h3>{p.categoryName}</h3>
                  <ActionForm action={bind(changePledge)}>
                    <input type="hidden" name="id" value={p.id} />
                    <label>Pledge <input name="amount" defaultValue={(p.line.pledgedCents / 100).toFixed(2)} aria-label={`Pledge from ${fu.name} toward ${p.categoryName}`} /></label>
                    <button type="submit">Save pledge</button>
                  </ActionForm>
                  <ActionForm action={bind(recordReceipt)}>
                    <input type="hidden" name="pledgeId" value={p.id} />
                    <label>Received <input name="amount" required placeholder="1,000.00" aria-label={`Received from ${fu.name} toward ${p.categoryName}`} /></label>
                    <label>On <input name="receivedOn" type="date" /></label>
                    <label>Note <input name="note" maxLength={200} /></label>
                    <button type="submit">Record money received</button>
                  </ActionForm>
                  <ActionForm action={bind(payFromPledge)}>
                    <input type="hidden" name="pledgeId" value={p.id} />
                    <label>Spend <select name="expenseId" aria-label={`Spend paid from ${fu.name}'s ${p.categoryName} pledge`}>{options.expenses.filter((e) => e.categoryId === p.categoryId).map((e) => <option key={e.id} value={e.id}>{e.label}: {usd(e.amountCents)}</option>)}</select></label>
                    <label>Amount <input name="amount" required placeholder="500.00" aria-label={`Amount paid from ${fu.name}'s ${p.categoryName} pledge`} /></label>
                    <button type="submit">Pay from this pledge</button>
                  </ActionForm>
                </div>
              ))}
            </details>
          )}
          {linking && (
            fu.userId ? (
              <ActionForm action={bind(unlinkFunder)}>
                <input type="hidden" name="id" value={fu.id} />
                <button type="submit">Unlink {nameOf(v, fu.userId)}</button>
              </ActionForm>
            ) : (
              <ActionForm action={bind(linkFunder)}>
                <input type="hidden" name="funderId" value={fu.id} />
                <label>Let a helper see this funder&apos;s part <select name="userId" aria-label={`Helper for ${fu.name}`}>{helpers.map((h) => <option key={h.userId} value={h.userId}>{h.user.name || h.user.email}</option>)}</select></label>
                <button type="submit">Link</button>
              </ActionForm>
            )
          )}
        </section>
      ))}

      {canEdit && (
        <section aria-label="Add a funder">
          <h2>Add a funder</h2>
          <ActionForm action={bind(addFunder)}>
            <label>Name <input name="name" required maxLength={120} placeholder="Hazel & Oren Vale" /></label>
            <label>Note <input name="note" maxLength={500} /></label>
            <button type="submit">Add funder</button>
          </ActionForm>
        </section>
      )}
    </main>
  );
}
