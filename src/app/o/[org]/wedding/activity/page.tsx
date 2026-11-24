import { requireOrg } from '@/core/authz/guards';
import { activityView } from '@/lib/knotwork/secrecy/views';
import { NoWedding, WeddingNav } from '../bits';
import { nameOf, view } from '../view';

export const metadata = { title: 'Activity' };

const ENTITY_TEXT: Record<string, string> = {
  wedding: 'the wedding', task: 'a task', baseline: 'the plan', category: 'a budget category', expense: 'a spend', snapshot: 'a budget snapshot',
  vendor: 'a vendor', payment: 'a vendor payment', flag: 'a re-confirmation flag', brief: 'a vendor brief', request: 'a request', grant: 'a helper permission',
  registry: 'a gift', gift: 'toward a gift', thankyou: 'a thank-you',
  photoevent: 'a photo event', photo: 'a photo', photodevice: 'a photo device', attachment: 'a contract attachment',
  funder: 'a funder', pledge: 'a pledge', receipt: 'money received', allocation: 'a payment from a pledge',
};
const show = (v: unknown) => (v === null || v === undefined || v === '' ? 'nothing' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// PRD P0-2 (bride review #4): the universal change log, rendered for people. Same rows as the template's audit log
// (Settings → Audit log); a helper sees only the entries inside their grants. P1-1: an entry about an item hidden
// from the viewer shows who and when, never what (secrecy/views.ts `activityView`).
export default async function Activity({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'activity.view', async (tx, v) => ({ lines: await activityView(tx, ctx, v, 200) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, lines } = data;
  return (
    <main>
      <WeddingNav slug={ctx.slug} />
      <h1>Activity</h1>
      <p>Everything anyone changed, newest first. Entries cannot be edited or removed.</p>
      <ol aria-label="Activity" reversed>
        {lines.map((e) => {
          const keys = [...new Set([...Object.keys(e.before ?? {}), ...Object.keys(e.after ?? {})])];
          return (
            <li key={e.id}>
              <time dateTime={e.at.toISOString()}>{e.at.toISOString().slice(0, 16).replace('T', ' ')} UTC</time> · <strong>{nameOf(v, e.actorUserId)}</strong> {e.text} {ENTITY_TEXT[e.entity] ?? e.entity}: {e.label}
              {e.before && e.after && keys.length > 0 && (
                <ul>{keys.map((k) => <li key={k}>{k}: {show(e.before![k])} → {show(e.after![k])}</li>)}</ul>
              )}
            </li>
          );
        })}
      </ol>
    </main>
  );
}
