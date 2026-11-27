import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { loadRegistry } from '@/lib/knotwork/gifts/couple';
import { usd } from '@/lib/knotwork/money';
import { NoWedding, WeddingNav } from '../../bits';
import { view } from '../../view';
import { updateRegistryItem } from '../actions';
import { GiftNav } from '../nav';

export const metadata = { title: 'Edit gift' };

// One gift, for editing while it is open (PRD P0-5). Another workspace's gift is a 404, like one that does not exist.
export default async function Gift({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  const data = await view(ctx, 'gifts.edit', async (tx) => ({ item: (await loadRegistry(tx, ctx)).find((i) => i.id === id) ?? null }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { item } = data;
  if (!item) notFound();
  return (
    <main>
      <WeddingNav who={data.v.who} slug={ctx.slug} life={data.v.wedding.mode === 'life'} />
      <GiftNav slug={ctx.slug} />
      <h1>{item.title}</h1>
      <p>{usd(item.raisedCents)} of {usd(item.targetCents)} given so far{item.contributors.length > 0 && `, by ${item.contributors.join(', ')}`}.</p>
      {item.state !== 'open' ? <p>This gift is {item.state === 'funded' ? 'funded' : 'closed'}; it can no longer change.</p> : (
        <ActionForm action={updateRegistryItem.bind(null, ctx.slug)}>
          <input type="hidden" name="id" value={item.id} />
          <label>Title <input name="title" required maxLength={120} defaultValue={item.title} /></label>
          <label>Note for guests <input name="note" maxLength={300} defaultValue={item.note} /></label>
          <label>Target in dollars <input name="target" required inputMode="decimal" defaultValue={`${Math.floor(item.targetCents / 100)}.${String(item.targetCents % 100).padStart(2, '0')}`} /></label>
          <p>The target cannot go below what has already been given. Set it to exactly that and the gift is funded.</p>
          <button type="submit">Save gift</button>
        </ActionForm>
      )}
    </main>
  );
}
