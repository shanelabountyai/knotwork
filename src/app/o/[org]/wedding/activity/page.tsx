import { requireOrg } from '@/core/authz/guards';
import { canSeeEntity } from '@/lib/knotwork/access';
import { changeLog } from '@/lib/knotwork/changelog';
import { parseAction } from '@/lib/knotwork/changelog-diff';
import { NoWedding, WeddingNav } from '../bits';
import { nameOf, view } from '../view';

export const metadata = { title: 'Activity' };

const ENTITY_TEXT: Record<string, string> = {
  wedding: 'the wedding', task: 'a task', baseline: 'the plan', category: 'a budget category', expense: 'a spend', snapshot: 'a budget snapshot',
  vendor: 'a vendor', payment: 'a vendor payment', flag: 'a re-confirmation flag', brief: 'a vendor brief', request: 'a request', grant: 'a helper permission',
  registry: 'a gift', gift: 'toward a gift', thankyou: 'a thank-you',
  photoevent: 'a photo event', photo: 'a photo', photodevice: 'a photo device', attachment: 'a contract attachment',
};
const show = (v: unknown) => (v === null || v === undefined || v === '' ? 'nothing' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// PRD P0-2 (bride review #4): the universal change log, rendered for people. Same rows as the template's audit log
// (Settings → Audit log); a helper sees only the entries inside their grants.
export default async function Activity({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'activity.view', async (tx) => ({ events: await changeLog(tx, ctx.orgId, 200) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, events } = data;
  const visible = events.flatMap((e) => {
    const a = parseAction(e.action);
    return a && canSeeEntity(v.who, a.entity) ? [{ e, a }] : [];
  });
  return (
    <main>
      <WeddingNav slug={ctx.slug} />
      <h1>Activity</h1>
      <p>Everything anyone changed, newest first. Entries cannot be edited or removed.</p>
      <ol aria-label="Activity" reversed>
        {visible.map(({ e, a }) => {
          const d = (e.data ?? {}) as { label?: string; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null };
          const keys = [...new Set([...Object.keys(d.before ?? {}), ...Object.keys(d.after ?? {})])];
          return (
            <li key={String(e.id)}>
              <time dateTime={e.at.toISOString()}>{e.at.toISOString().slice(0, 16).replace('T', ' ')} UTC</time> · <strong>{nameOf(v, e.actorUserId)}</strong> {a.text} {ENTITY_TEXT[a.entity] ?? a.entity}: {d.label}
              {d.before && d.after && keys.length > 0 && (
                <ul>{keys.map((k) => <li key={k}>{k}: {show(d.before![k])} → {show(d.after![k])}</li>)}</ul>
              )}
            </li>
          );
        })}
      </ol>
    </main>
  );
}
