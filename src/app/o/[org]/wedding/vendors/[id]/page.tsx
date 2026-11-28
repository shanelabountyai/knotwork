import { notFound } from 'next/navigation';
import { Keys, Status, TableWrap, vendorKind } from '@/app/ui/kw';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows, isPartner } from '@/lib/knotwork/access';
import { addDays, dayOfDb, showDay } from '@/lib/knotwork/days';
import { usd } from '@/lib/knotwork/money';
import { isUploadProblem, UPLOAD_PROBLEM } from '@/lib/knotwork/uploads/caps';
import { vendorView } from '@/lib/knotwork/secrecy/views';
import { ATTACHMENT_PROBLEM, ATTACHMENTS_PER_VENDOR } from '@/lib/knotwork/vendors/attachments';
import { VENDOR_CATEGORIES } from '@/lib/knotwork/vendors/brief';
import { hhmm } from '@/lib/knotwork/vendors/scope';
import { vendorLinkOf } from '@/lib/knotwork/vendors/link';
import { flagText } from '@/lib/knotwork/vendors/store';
import { acknowledgeFlag, addVendorPayment, payVendorPayment, proposeBooking, proposeContract, regenerateBrief, updateVendor } from '../../actions';
import { MineNote, NoWedding, PrivacySelect, privacyValue, WeddingNav } from '../../bits';
import { setVendorPrivacy } from '../../privacy/actions';
import { nameOf, view } from '../../view';
import { endVendorReadLink, newVendorLink, removeVendorAttachment, showVendorLink } from '../actions';

export const metadata = { title: 'Vendor' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One vendor: contact, scope (a change here on a booked vendor raises a re-confirmation flag), the two designated
// steps (book, sign), scheduled payments, the brief, and contract attachments (images only, D-65; rule 4: the form
// posts the file to ./attachments, a route handler that hands it to src/lib/knotwork/uploads). P1-1: a vendor private
// to the other partner is a 404 to them and to every helper (secrecy/views.ts `vendorView`).
export default async function VendorPage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: Promise<{ e?: string; attached?: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  const q = await searchParams;
  if (!UUID.test(id)) notFound();
  const data = await view(ctx, 'vendors.view', async (tx, v) => {
    const page = await vendorView(tx, ctx, v, id);
    // D-42: the read-only link's state (never the token itself: that is shown only by an action, to vendors.edit).
    return { page, link: page && allows(v.who, 'vendors.edit') ? await vendorLinkOf(tx, ctx, id) : null };
  });
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, page, link } = data;
  if (!page) notFound();
  const { vendor: x, mine, categories, attachments } = page;
  const canEdit = allows(v.who, 'vendors.edit');
  const partner = isPartner(ctx.role);
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  const brief = x.briefs[0];
  // The query carries a code from a closed list; the sentence comes from here. Unknown codes show nothing.
  const problems: Record<string, string> = { ...UPLOAD_PROBLEM, ...ATTACHMENT_PROBLEM };
  const problem = typeof q.e === 'string' && (isUploadProblem(q.e) || Object.hasOwn(ATTACHMENT_PROBLEM, q.e)) ? problems[q.e] : null;
  const attachBase = `/o/${ctx.slug}/wedding/vendors/${x.id}/attachments`;

  return (
    <main>
      <WeddingNav who={v.who} slug={ctx.slug} mode={v.wedding.mode} />
      <h1>{x.name}</h1>
      {mine && <p role="note">Private to you<MineNote mine={mine} />. Your partner and the helpers see it as &quot;Private vendor&quot;, with no name. Proposing to book it or sign its contract reveals it.</p>}
      <p aria-label="Vendor status" className="kw-meta">
        {x.category} · <Status k={vendorKind(x.status)}><strong>{x.status}</strong></Status>
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
                    <button type="submit" className="secondary">Mark re-confirmed</button>
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
          {v.partners.length < 2 && !v.wedding.pairedAt
            ? <Keys on={1} solo>You are the only partner so far: booking and signing happen as soon as you propose them, marked solo.</Keys>
            : <Keys on={0}>Booking and signing take both keys: proposing turns yours; it happens when your partner approves.</Keys>}
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
          {x.status === 'considering' && !x.contractSignedOn && (
            <ActionForm action={bind(setVendorPrivacy)}>
              <input type="hidden" name="id" value={x.id} />
              <PrivacySelect defaultValue={privacyValue(x, mine)} />
              <button type="submit" className="secondary">Save privacy</button>
            </ActionForm>
          )}
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
        <TableWrap label="Payments">
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
        </TableWrap>
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

      {link && (
        <section aria-label="Read-only link">
          <h2>Read-only link for the vendor</h2>
          <p>
            A link the vendor can open without an account. It shows this brief, worked out fresh each time (counts, never guests&apos; names), and nothing else.{' '}
            {link.exists ? (link.working ? `It works until ${showDay(link.lastDay)}.` : 'It does not work at the moment.') : `No link yet. A link works until ${showDay(link.lastDay)}.`}
          </p>
          {link.exists && (
            <ActionForm action={bind(showVendorLink)}>
              <input type="hidden" name="id" value={x.id} />
              <button type="submit">Show the vendor link</button>
            </ActionForm>
          )}
          <ActionForm action={bind(newVendorLink)}>
            <input type="hidden" name="id" value={x.id} />
            <button type="submit" className={link.exists ? 'secondary' : undefined}>{link.exists ? 'Replace the vendor link' : 'Make a vendor link'}</button>
            {link.exists && <small>Replacing it stops the link the vendor has now.</small>}
          </ActionForm>
          {link.exists && (
            <ActionForm action={bind(endVendorReadLink)}>
              <input type="hidden" name="id" value={x.id} />
              <button type="submit" className="secondary">End the vendor link</button>
            </ActionForm>
          )}
          {mine && <p><small>While this vendor is private there is no link: making one is refused.</small></p>}
        </section>
      )}

      <section aria-label="Contract attachments" id="attachments">
        <h2>Contract attachments</h2>
        {problem && <p role="alert">{problem} Nothing was attached.</p>}
        {!problem && q.attached === '1' && <p role="status">Attached.</p>}
        {attachments.length === 0 ? <p>Nothing attached yet.</p> : (
          <ul aria-label="Attachments">
            {attachments.map((a) => (
              <li key={a.id} aria-label={`Attachment ${a.label}`}>
                <a href={`${attachBase}/${a.id}`}>{a.label}</a> <small>({a.width}×{a.height}, {Math.ceil(a.size / 1024)} KB, added by {nameOf(v, a.uploadedById)})</small>
                {canEdit && (
                  <ActionForm action={bind(removeVendorAttachment)}>
                    <input type="hidden" name="id" value={a.id} />
                    <button type="submit" aria-label={`Remove ${a.label}`}>Remove</button>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <form method="post" action={attachBase} encType="multipart/form-data">
            <label>A photo or scan of a contract page <input type="file" name="file" accept="image/jpeg,image/png,image/webp" required /></label>
            <label>Label <input name="label" maxLength={80} placeholder="Contract, page 1" /></label>
            <button type="submit">Attach</button>
            <p><small>JPEG, PNG or WebP images, up to 10 MB each, {ATTACHMENTS_PER_VENDOR} per vendor. PDFs are not accepted yet: attach a photo or a scan of each page. What is stored is a re-encoded copy with nothing but the picture in it.</small></p>
          </form>
        )}
      </section>
    </main>
  );
}
