import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows, isPartner } from '@/lib/knotwork/access';
import { addDays, dayOfDb, showDay } from '@/lib/knotwork/days';
import { usd } from '@/lib/knotwork/money';
import { VENDOR_CATEGORIES } from '@/lib/knotwork/vendors/brief';
import { hhmm } from '@/lib/knotwork/vendors/scope';
import { flagText } from '@/lib/knotwork/vendors/store';
import { acknowledgeFlag, addVendorPayment, payVendorPayment, proposeBooking, proposeContract, regenerateBrief, updateVendor } from '../../actions';
import { NoWedding, WeddingNav } from '../../bits';
import { view } from '../../view';

export const metadata = { title: 'Vendor' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One vendor: contact, scope (a change here on a booked vendor raises a re-confirmation flag), the two designated
// steps (book, sign), scheduled payments and the brief.
export default async function VendorPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const data = await view(ctx, 'vendors.view', async (tx) => ({
    vendor: await tx.vendor.findFirst({ where: { id, ...inOrg(ctx) }, include: { payments: { orderBy: { dueDaysBefore: 'desc' } }, flags: { where: { ackAt: null }, orderBy: { raisedAt: 'asc' } }, briefs: { orderBy: { version: 'desc' }, take: 1 } } }),
    categories: await tx.budgetCategory.findMany({ where: inOrg(ctx), select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, vendor: x, categories } = data;
  if (!x) notFound();
  const canEdit = allows(v.who, 'vendors.edit');
  const partner = isPartner(ctx.role);
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  const brief = x.briefs[0];

  return (
    <main>
      <WeddingNav slug={ctx.slug} />
      <h1>{x.name}</h1>
      <p aria-label="Vendor status">
        {x.category} · <strong>{x.status}</strong>
        {x.contractSignedOn && <> · contract signed {showDay(dayOfDb(x.contractSignedOn))}{x.contractTotalCents !== null && ` for ${usd(x.contractTotalCents)}`}</>}
      </p>

      {x.flags.length > 0 && (
        <section aria-label="Needs re-confirmation">
          <h2>Needs re-confirmation</h2>
          <ul>
            {x.flags.map((f) => (
              <li key={f.id}>
                {flagText(f.reason, f.detail)}
                {canEdit && (
                  <ActionForm action={bind(acknowledgeFlag)}>
                    <input type="hidden" name="id" value={f.id} />
                    <label>Note <input name="note" maxLength={500} placeholder="How they confirmed" /></label>
                    <button type="submit">Mark re-confirmed</button>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {partner && (
        <section aria-label="Needs both partners">
          <h2>Needs both of you</h2>
          {x.status === 'considering' && (
            <ActionForm action={bind(proposeBooking)}>
              <input type="hidden" name="id" value={x.id} />
              <button type="submit">Propose booking {x.name}</button>
            </ActionForm>
          )}
          {!x.contractSignedOn && (
            <ActionForm action={bind(proposeContract)}>
              <input type="hidden" name="id" value={x.id} />
              <label>Contract total <input name="total" required placeholder="8,400.00" defaultValue={x.contractTotalCents !== null ? (x.contractTotalCents / 100).toFixed(2) : ''} /></label>
              <button type="submit">Propose signing the contract</button>
            </ActionForm>
          )}
          {x.status !== 'considering' && x.contractSignedOn && <p>Booked and signed.</p>}
        </section>
      )}

      {canEdit && (
        <section aria-label="Details">
          <h2>Details and scope</h2>
          <p>{x.status === 'booked' ? 'This vendor is booked: changing deliverables, times or the count flags them for re-confirmation.' : 'Scope changes are flagged for re-confirmation once the vendor is booked.'}</p>
          <ActionForm action={bind(updateVendor)}>
            <input type="hidden" name="id" value={x.id} />
            <label>Name <input name="name" required maxLength={120} defaultValue={x.name} /></label>
            <label>Category <select name="category" defaultValue={x.category}>{VENDOR_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
            <label>Contact <input name="contactName" maxLength={120} defaultValue={x.contactName} /></label>
            <label>Email <input name="email" type="email" maxLength={200} defaultValue={x.email} /></label>
            <label>Phone <input name="phone" maxLength={40} defaultValue={x.phone} /></label>
            <label>Notes <textarea name="notes" maxLength={2000} defaultValue={x.notes} /></label>
            <label>Deliverables <textarea name="deliverables" maxLength={4000} defaultValue={x.deliverables} /></label>
            <label>Arrives <input name="arrive" type="time" defaultValue={hhmm(x.arriveMin)} /></label>
            <label>Leaves <input name="depart" type="time" defaultValue={hhmm(x.departMin)} /></label>
            <label>Count estimate <input name="countEstimate" inputMode="numeric" defaultValue={x.countEstimate ?? ''} /></label>
            <label>Needs the final count this many days before <input name="countDueDaysBefore" inputMode="numeric" defaultValue={x.countDueDaysBefore ?? ''} /></label>
            <label><input name="onSite" type="checkbox" defaultChecked={x.onSite} /> Eats on site</label>
            {!x.contractSignedOn && <label>Quoted total <input name="contractTotal" defaultValue={x.contractTotalCents !== null ? (x.contractTotalCents / 100).toFixed(2) : ''} /></label>}
            <button type="submit">Save vendor</button>
          </ActionForm>
        </section>
      )}

      <section aria-label="Payments">
        <h2>Payments</h2>
        <table aria-label="Payments">
          <thead><tr><th scope="col">Payment</th><th scope="col">Amount</th><th scope="col">Due</th><th scope="col">Paid</th></tr></thead>
          <tbody>
            {x.payments.map((p) => (
              <tr key={p.id} aria-label={`Payment ${p.label}`}>
                <th scope="row">{p.label}</th><td>{usd(p.amountCents)}</td><td>{showDay(addDays(v.date, -p.dueDaysBefore))} ({p.dueDaysBefore} days before)</td>
                <td>
                  {p.paidOn ? showDay(dayOfDb(p.paidOn)) : canEdit && allows(v.who, 'budget.edit') && categories.length > 0 ? (
                    <ActionForm action={bind(payVendorPayment)}>
                      <input type="hidden" name="id" value={p.id} />
                      <select name="categoryId" aria-label={`Budget category for ${p.label}`}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                      <button type="submit">Record as paid</button>
                    </ActionForm>
                  ) : 'not yet'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {canEdit && (
          <ActionForm action={bind(addVendorPayment)}>
            <input type="hidden" name="vendorId" value={x.id} />
            <label>Label <input name="label" required maxLength={60} placeholder="Deposit" /></label>
            <label>Amount <input name="amount" required placeholder="400.00" /></label>
            <label>Due this many days before the wedding <input name="dueDaysBefore" inputMode="numeric" required defaultValue={30} /></label>
            <button type="submit">Schedule payment</button>
          </ActionForm>
        )}
      </section>

      <section aria-label="Brief">
        <h2>Brief</h2>
        {brief ? <><p>Version {brief.version}.</p><pre aria-label="Vendor brief">{brief.body}</pre></> : <p>No brief generated yet.</p>}
        {canEdit && (
          <ActionForm action={bind(regenerateBrief)}>
            <input type="hidden" name="id" value={x.id} />
            <button type="submit">{brief ? 'Regenerate brief' : 'Generate brief'}</button>
          </ActionForm>
        )}
      </section>
    </main>
  );
}
