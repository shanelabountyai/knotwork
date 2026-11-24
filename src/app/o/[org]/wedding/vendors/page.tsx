import Link from 'next/link';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { VENDOR_CATEGORIES } from '@/lib/knotwork/vendors/brief';
import { addVendor } from '../actions';
import { NoWedding, WeddingNav } from '../bits';
import { view } from '../view';

export const metadata = { title: 'Vendors' };

// PRD P0-7: the couple's own vendor book (not a marketplace).
export default async function Vendors({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'vendors.view', async (tx) => ({
    vendors: await tx.vendor.findMany({ where: inOrg(ctx), include: { flags: { where: { ackAt: null }, select: { id: true } } }, orderBy: { name: 'asc' } }),
  }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, vendors } = data;
  return (
    <main>
      <WeddingNav slug={ctx.slug} />
      <h1>Vendors</h1>
      <table aria-label="Vendors">
        <thead><tr><th scope="col">Vendor</th><th scope="col">Category</th><th scope="col">Status</th><th scope="col">Contract</th><th scope="col">Re-confirmation</th></tr></thead>
        <tbody>
          {vendors.map((x) => (
            <tr key={x.id} aria-label={`Vendor ${x.name}`}>
              <th scope="row"><Link href={`/o/${ctx.slug}/wedding/vendors/${x.id}`}>{x.name}</Link></th>
              <td>{x.category}</td><td>{x.status}</td><td>{x.contractSignedOn ? 'signed' : ''}</td><td>{x.flags.length ? 'needs re-confirmation' : ''}</td>
            </tr>
          ))}
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
            <button type="submit">Add vendor</button>
          </ActionForm>
        </>
      )}
    </main>
  );
}
