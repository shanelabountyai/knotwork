import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { allows } from '@/lib/knotwork/access';
import { flagsView } from '@/lib/knotwork/secrecy/views';
import { flagText } from '@/lib/knotwork/vendors/store';
import { acknowledgeFlag } from '../actions';
import { HiddenText, NoWedding, WeddingNav } from '../bits';
import { nameOf, view } from '../view';

export const metadata = { title: 'Vendor flags' };
const when = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// PRD P0-2 (bride review #4): a change touching a booked vendor's scope keeps them flagged until someone marks the
// vendor re-confirmed. P1-1: flags come through secrecy/views.ts (a flag is raised only on a booked vendor, which is
// never private, but the lens is applied all the same).
export default async function Flags({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'vendors.view', async (tx, v) => ({ all: await flagsView(tx, ctx, v) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, all } = data;
  const hidden = all.flatMap((f) => (f.hidden ? [f] : []));
  const flags = all.flatMap((f) => (f.hidden ? [] : [f.row]));
  const [open, done] = [flags.filter((f) => !f.ackAt), flags.filter((f) => f.ackAt)];
  const canEdit = allows(v.who, 'vendors.edit');
  return (
    <main>
      <WeddingNav slug={ctx.slug} mode={v.wedding.mode} counts={{ approvals: 0, flags: open.length }} />
      <h1>Vendor flags</h1>
      <section aria-label="Open flags">
        <h2>Needs re-confirmation</h2>
        {open.length === 0 && hidden.length === 0 && <p>No vendor needs re-confirmation.</p>}
        <ul>
          {hidden.map((h, n) => <li key={`hidden-${n}`}><HiddenText h={h} owner={nameOf(v, h.owner)} /></li>)}
          {open.map((f) => (
            <li key={f.id} aria-label={`Flag for ${f.vendor.name}`}>
              <Link href={`/o/${ctx.slug}/wedding/vendors/${f.vendor.id}`}>{f.vendor.name}</Link>: {flagText(f.reason, f.detail)} <small>(flagged {when(f.raisedAt)} by {nameOf(v, f.raisedById)})</small>
              {canEdit && (
                <ActionForm action={acknowledgeFlag.bind(null, ctx.slug)}>
                  <input type="hidden" name="id" value={f.id} />
                  <label>Note <input name="note" maxLength={500} aria-label={`Note for ${f.vendor.name}`} /></label>
                  <button type="submit">Mark {f.vendor.name} re-confirmed</button>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Acknowledged flags">
        <h2>Re-confirmed</h2>
        <ul>
          {done.map((f) => (
            <li key={f.id}>{f.vendor.name}: {flagText(f.reason, f.detail)} <small>(re-confirmed {when(f.ackAt!)} by {nameOf(v, f.ackById)}{f.ackNote && `: ${f.ackNote}`})</small></li>
          ))}
        </ul>
      </section>
    </main>
  );
}
