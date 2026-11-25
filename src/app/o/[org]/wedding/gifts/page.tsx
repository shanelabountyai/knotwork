import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { showDay } from '@/lib/knotwork/days';
import { loadRegistry } from '@/lib/knotwork/gifts/couple';
import { usd } from '@/lib/knotwork/money';
import { LINK_REL, LINK_TARGET, QUANTITY_MAX, URL_MAX } from '@/lib/knotwork/registry/links';
import { loadLinks } from '@/lib/knotwork/registry/store';
import { NoWedding, WeddingNav } from '../bits';
import { view } from '../view';
import { addRegistryItem, addRegistryLink, closeRegistry } from './actions';
import { GiftNav } from './nav';

export const metadata = { title: 'Gifts' };

// PRD P0-5: gifts several households give toward together. This page is for the two partners (no helper grant reaches
// it). It shows each gift's progress and WHO gave, never what any one household gave: the loader (gifts/couple.ts)
// reads a sum per gift and the givers' names, and nothing else exists to show.
export default async function Gifts({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'gifts.view', async (tx) => ({ items: await loadRegistry(tx, ctx), links: await loadLinks(tx, ctx) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, items, links } = data;
  const canEdit = allows(v.who, 'gifts.edit');
  const open = items.filter((i) => i.state === 'open');
  return (
    <main>
      <WeddingNav slug={ctx.slug} life={v.wedding.mode === 'life'} />
      <GiftNav slug={ctx.slug} />
      <h1>Gifts</h1>
      <p>Guests give through the link on their own invitation. You see how far each gift has come and who gave toward it. What each household gave stays with that household.</p>
      {items.length === 0 && <p>No gifts yet.</p>}
      <table aria-label="Registry">
        <thead><tr><th scope="col">Gift</th><th scope="col">Target</th><th scope="col">Given so far</th><th scope="col">Status</th><th scope="col">Who gave</th></tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id} aria-label={`Gift ${i.title}`}>
              <th scope="row">{canEdit && i.state === 'open' ? <Link href={`/o/${ctx.slug}/wedding/gifts/${i.id}`}>{i.title}</Link> : i.title}{i.note && <><br /><small>{i.note}</small></>}</th>
              <td>{usd(i.targetCents)}</td>
              <td>{usd(i.raisedCents)} ({i.percent}%){i.state === 'open' && `, ${usd(i.remainingCents)} to go`}</td>
              <td>{i.state === 'open' ? 'open' : i.state === 'funded' ? `funded ${showDay(i.fundedOn!)}` : `closed unfunded ${showDay(i.closedOn!)}`}</td>
              <td>{i.contributors.length === 0 ? 'nobody yet' : `${i.state === 'closed_unfunded' ? 'refunded: ' : ''}${i.contributors.join(', ')}`}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>From a store</h2>
      <p>Things guests buy from a store themselves. Guests see each one beside the gifts above, follow the link to the store, and mark it as bought so nobody buys the same one twice. Nothing is fetched from the store.</p>
      {links.length === 0 ? <p>No store items yet.</p> : (
        <table aria-label="Store items">
          <thead><tr><th scope="col">Item</th><th scope="col">Store</th><th scope="col">Price</th><th scope="col">Bought</th><th scope="col">Who bought</th></tr></thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id} aria-label={`Store item ${l.title}`}>
                <th scope="row">{canEdit ? <Link href={`/o/${ctx.slug}/wedding/gifts/links/${l.id}`}>{l.title}</Link> : l.title}</th>
                <td>{l.link ? <a href={l.link.href} target={LINK_TARGET} rel={LINK_REL}>{l.store}</a> : l.store}{l.link && <> ({l.link.host})</>}</td>
                <td>{l.priceCents === null ? 'not given' : usd(l.priceCents)}</td>
                <td>{l.claimed} of {l.quantityWanted}{l.remaining === 0 ? ', all bought' : ''}</td>
                <td>{l.claimants.length === 0 ? 'nobody yet' : l.claimants.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canEdit && (
        <>
          <h2>Add a store item</h2>
          <ActionForm action={addRegistryLink.bind(null, ctx.slug)}>
            <label>Item <input name="title" required maxLength={120} placeholder="Cast-iron skillet" /></label>
            <label>Store <input name="store" required maxLength={80} placeholder="Example Kitchen Co." /></label>
            <label>Link to the item <input name="url" type="url" required maxLength={URL_MAX} placeholder="https://www.example.com/skillet" /></label>
            <label>Price in dollars (optional) <input name="price" inputMode="decimal" placeholder="45.00" /></label>
            <label>How many you want <input name="wanted" required inputMode="numeric" defaultValue="1" maxLength={2} /></label>
            <p>The link must start with https://. Up to {QUANTITY_MAX} of one item.</p>
            <button type="submit">Add store item</button>
          </ActionForm>

          <h2>Add a gift</h2>
          <ActionForm action={addRegistryItem.bind(null, ctx.slug)}>
            <label>Title <input name="title" required maxLength={120} placeholder="Honeymoon canoe trip" /></label>
            <label>Note for guests <input name="note" maxLength={300} /></label>
            <label>Target in dollars <input name="target" required inputMode="decimal" placeholder="450.00" /></label>
            <button type="submit">Add gift</button>
          </ActionForm>

          <h2>Close the registry</h2>
          {open.length === 0 ? <p>No gift is open.</p> : (
            <ActionForm action={closeRegistry.bind(null, ctx.slug)}>
              <p>Closing ends giving. {open.length === 1 ? 'The 1 open gift is' : `The ${open.length} open gifts are`} closed unfunded and everything given toward {open.length === 1 ? 'it' : 'them'} is refunded to the households that gave. Funded gifts stay funded. This cannot be undone.</p>
              <label><input type="checkbox" name="confirm" /> Close the registry and refund the unfunded gifts</label>
              <button type="submit">Close the registry</button>
            </ActionForm>
          )}
        </>
      )}
    </main>
  );
}
