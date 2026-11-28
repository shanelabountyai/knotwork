import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows, isPartner } from '@/lib/knotwork/access';
import { vendorsView } from '@/lib/knotwork/secrecy/views';
import { VENDOR_CATEGORIES } from '@/lib/knotwork/vendors/brief';
import { showDay } from '@/lib/knotwork/days';
import { usd } from '@/lib/knotwork/money';
import { paymentSummary } from '@/lib/knotwork/vendors/payments';
import { Status, TableWrap, vendorKind } from '@/app/ui/kw';
import { addVendor } from '../actions';
import { HiddenText, MineNote, NoWedding, PrivacySelect, WeddingNav } from '../bits';
import { nameOf, view } from '../view';

export const metadata = { title: 'Vendors' };

// PRD P0-7: the couple's own vendor book (not a marketplace). P1-1: a vendor private to the other partner is a masked
// line (no name, no category, no link); its page is a 404 to them.
export default async function Vendors({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'vendors.view', async (tx, v) => ({ vendors: await vendorsView(tx, ctx, v) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, vendors } = data;
  return (
    <main>
      <WeddingNav who={v.who} slug={ctx.slug} mode={v.wedding.mode} />
      <h1>Vendors</h1>
      <TableWrap label="Vendors">
      <table aria-label="Vendors" role="table" className="kw-stack-sm">
        <thead><tr role="row"><th role="columnheader" scope="col">Vendor</th><th role="columnheader" scope="col">Category</th><th role="columnheader" scope="col">Status</th><th role="columnheader" scope="col">Contract</th><th role="columnheader" scope="col">Re-confirmation</th><th role="columnheader" scope="col" className="num">Paid</th><th role="columnheader" scope="col" className="num">Balance</th><th role="columnheader" scope="col">Next due</th></tr></thead>
        <tbody>
          {vendors.map((l, n) => {
            if (l.hidden) return <tr role="row" key={`hidden-${n}`} aria-label={l.label}><th role="rowheader" scope="row"><HiddenText h={l} owner={nameOf(v, l.owner)} /></th><td role="cell" data-label="Category" /><td role="cell" data-label="Status" /><td role="cell" data-label="Contract" /><td role="cell" data-label="Re-confirmation" /><td role="cell" data-label="Paid" /><td role="cell" data-label="Balance" /><td role="cell" data-label="Next due" /></tr>;
            const x = l.row;
            // Round 2 (D-175): the vendor's scheduled payments, summed; each due day from the wedding date (rule 1).
            const m = paymentSummary(x.payments, v.date);
            const page = `/o/${ctx.slug}/wedding/vendors/${x.id}`;
            return (
              <tr role="row" key={x.id} aria-label={`Vendor ${x.name}`}>
                <th role="rowheader" scope="row"><Link href={page}>{x.name}</Link><MineNote mine={l.mine} /></th>
                <td role="cell" data-label="Category">{x.category}</td><td role="cell" data-label="Status"><Status k={vendorKind(x.status)}>{x.status}</Status></td><td role="cell" data-label="Contract">{x.contractSignedOn ? <Status k="ok">signed</Status> : ''}</td><td role="cell" data-label="Re-confirmation">{x.flags.length ? <Status k="wait">needs re-confirmation</Status> : ''}</td>
                <td role="cell" data-label="Paid" className="num">{m.count ? usd(m.paidCents) : ''}</td><td role="cell" data-label="Balance" className="num">{m.count ? usd(m.balanceCents) : ''}</td>
                <td role="cell" data-label="Next due" className="num">{m.nextDue ? <Link href={`${page}#payments`}>{showDay(m.nextDue.day)}<span className="kw-sub">{usd(m.nextDue.amountCents)}</span></Link> : m.count ? <Status k="ok">all paid</Status> : <small>no payments scheduled</small>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </TableWrap>
      {vendors.length === 0 && <p>No vendors yet.</p>}
      {allows(v.who, 'vendors.edit') && (
        <>
          <h2>Add a vendor</h2>
          <div className="card">
          <ActionForm action={addVendor.bind(null, ctx.slug)}>
            <label>Name <input name="name" required maxLength={120} /></label>
            <label>Category <select name="category">{VENDOR_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
            <label>Contact <input name="contactName" maxLength={120} /></label>
            <label>Email <input name="email" type="email" maxLength={200} /></label>
            <label>Phone <input name="phone" maxLength={40} /></label>
            {isPartner(ctx.role) && <PrivacySelect />}
            <button type="submit">Add vendor</button>
          </ActionForm>
          </div>
        </>
      )}
    </main>
  );
}
