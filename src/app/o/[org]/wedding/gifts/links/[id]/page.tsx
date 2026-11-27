import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { LINK_REL, LINK_TARGET, URL_MAX } from '@/lib/knotwork/registry/links';
import { loadLinks } from '@/lib/knotwork/registry/store';
import { NoWedding, WeddingNav } from '../../../bits';
import { view } from '../../../view';
import { removeRegistryLink, updateRegistryLink } from '../../actions';
import { GiftNav } from '../../nav';

export const metadata = { title: 'Edit store item' };

const dollars = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

// P1-8: one store item, for editing. Another workspace's item is a 404, like one that does not exist. It can ask for
// fewer, but never fewer than households have already marked as bought; one nobody bought can be removed.
export default async function StoreItem({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  const data = await view(ctx, 'gifts.edit', async (tx) => ({ link: (await loadLinks(tx, ctx)).find((l) => l.id === id) ?? null }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { link } = data;
  if (!link) notFound();
  return (
    <main>
      <WeddingNav who={data.v.who} slug={ctx.slug} life={data.v.wedding.mode === 'life'} />
      <GiftNav slug={ctx.slug} />
      <h1>{link.title}</h1>
      <p>
        From {link.link ? <a href={link.link.href} target={LINK_TARGET} rel={LINK_REL}>{link.store}</a> : link.store}. {link.claimed} of {link.quantityWanted} bought
        {link.claimants.length > 0 && `, by ${link.claimants.join(', ')}`}.
      </p>
      <ActionForm action={updateRegistryLink.bind(null, ctx.slug)}>
        <input type="hidden" name="id" value={link.id} />
        <label>Item <input name="title" required maxLength={120} defaultValue={link.title} /></label>
        <label>Store <input name="store" required maxLength={80} defaultValue={link.store} /></label>
        <label>Link to the item <input name="url" type="url" required maxLength={URL_MAX} defaultValue={link.url} /></label>
        <label>Price in dollars (optional) <input name="price" inputMode="decimal" defaultValue={link.priceCents === null ? '' : dollars(link.priceCents)} /></label>
        <label>How many you want <input name="wanted" required inputMode="numeric" maxLength={2} defaultValue={String(link.quantityWanted)} /></label>
        <button type="submit">Save store item</button>
      </ActionForm>
      {link.claimed === 0 ? (
        <ActionForm action={removeRegistryLink.bind(null, ctx.slug)}>
          <input type="hidden" name="id" value={link.id} />
          <button type="submit">Remove {link.title} from the registry</button>
        </ActionForm>
      ) : <p>A guest has marked this as bought, so it stays on the registry.</p>}
    </main>
  );
}
