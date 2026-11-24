import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { showDay, todayIn } from '@/lib/knotwork/days';
import { loadThankYous } from '@/lib/knotwork/gifts/couple';
import { NoWedding, WeddingNav } from '../../bits';
import { view } from '../../view';
import { acknowledgeThankYou } from '../actions';
import { GiftNav } from '../nav';

export const metadata = { title: 'Thank-yous' };

// PRD P0-5: "funded items emit obligations". When a gift funds, each household that gave toward it appears here until
// a partner marks the thank-you as sent. (P1-3 adds aging on top of the same rows.)
export default async function ThankYous({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'gifts.view', async (tx, v) => ({ rows: await loadThankYous(tx, ctx, (at) => todayIn(v.wedding.timeZone, at)) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, rows } = data;
  const canEdit = allows(v.who, 'gifts.edit');
  const owed = rows.filter((r) => !r.acknowledgedOn);
  return (
    <main>
      <WeddingNav slug={ctx.slug} />
      <GiftNav slug={ctx.slug} />
      <h1>Thank-yous</h1>
      <p>{rows.length === 0 ? 'Nothing yet: a thank-you is owed to each household that gave toward a gift, once that gift is funded.' : `${owed.length} of ${rows.length} still to send.`}</p>
      <ul aria-label="Thank-yous">
        {rows.map((r) => (
          <li key={r.id} aria-label={`Thank-you to ${r.household} for ${r.item}`}>
            <strong>{r.household}</strong>, for {r.item} (funded {showDay(r.owedSince)}): {r.acknowledgedOn ? `sent ${showDay(r.acknowledgedOn)}` : 'not sent yet'}
            {canEdit && !r.acknowledgedOn && (
              <ActionForm action={acknowledgeThankYou.bind(null, ctx.slug)}>
                <input type="hidden" name="id" value={r.id} />
                <button type="submit">Mark the thank-you to {r.household} as sent</button>
              </ActionForm>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
