import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows, isPartner } from '@/lib/knotwork/access';
import { vendorsView } from '@/lib/knotwork/secrecy/views';
import { VENDOR_CATEGORIES } from '@/lib/knotwork/vendors/brief';
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
      <WeddingNav slug={ctx.slug} mode={v.wedding.mode} />
      <h1>Vendors</h1>
      <table aria-label="Vendors">
        <thead><tr><th scope="col">Vendor</th><th scope="col">Category</th><th scope="col">Status</th><th scope="col">Contract</th><th scope="col">Re-confirmation</th></tr></thead>
        <tbody>
          {vendors.map((l, n) => {
            if (l.hidden) return <tr key={`hidden-${n}`} aria-label={l.label}><th scope="row"><HiddenText h={l} owner={nameOf(v, l.owner)} /></th><td /><td /><td /><td /></tr>;
            const x = l.row;
            return (
              <tr key={x.id} aria-label={`Vendor ${x.name}`}>
                <th scope="row"><Link href={`/o/${ctx.slug}/wedding/vendors/${x.id}`}>{x.name}</Link><MineNote mine={l.mine} /></th>
                <td>{x.category}</td><td>{x.status}</td><td>{x.contractSignedOn ? 'signed' : ''}</td><td>{x.flags.length ? 'needs re-confirmation' : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {allows(v.who, 'vendors.edit') && (
        <>
          <h2>Add a vendor</h2>
          <ActionForm action={addVendor.bind(null, ctx.slug)}>
            <label>Name <input name="name" required maxLength={120} /></label>
            <label>Category <select name="category">{VENDOR_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
            <label>Contact <input name="contactName" maxLength={120} /></label>
            <label>Email <input name="email" type="email" maxLength={200} /></label>
            <label>Phone <input name="phone" maxLength={40} /></label>
            {isPartner(ctx.role) && <PrivacySelect />}
            <button type="submit">Add vendor</button>
          </ActionForm>
        </>
      )}
    </main>
  );
}
