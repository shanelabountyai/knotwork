import Link from 'next/link';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { ActionForm } from '@/core/ui/action-form';
import { isRealDay, showDay } from '@/lib/knotwork/days';
import { movePreview } from '@/lib/knotwork/secrecy/views';
import { proposeDateMove } from '../actions';
import { MovePreviewView, NoWedding, WeddingNav } from '../bits';
import { view } from '../view';

export const metadata = { title: 'Move the date' };

// PRD P0-1: date move → previewed cascade → commit. The move is designated (P0-2), so this page previews and
// PROPOSES; the commit happens when the other partner approves, against the preview they see then.
export default async function MoveDate({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ to?: string }> }) {
  const ctx = await requireOrg((await params).org);
  const to = ((await searchParams).to ?? '').trim();
  const data = await view(ctx, 'consent.propose', async (tx, v) => ({
    move: isRealDay(to) && to !== v.date ? await movePreview(tx, ctx, v, to) : null, // P1-1: private task titles masked
    waiting: await tx.consentRequest.findFirst({ where: { ...inOrg(ctx), kind: 'change_date', status: 'pending', expiresAt: { gt: now() } }, select: { summary: true } }),
  }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, move, waiting } = data;
  return (
    <main>
      <WeddingNav slug={ctx.slug} mode={v.wedding.mode} />
      <h1>Move the date</h1>
      <p>The wedding is on <strong>{showDay(v.date)}</strong>. Pick a new date to see what it does to the plan. Nothing changes until your partner approves.</p>
      {waiting && <p role="status">Already waiting for your partner: {waiting.summary}.</p>}
      <form method="get">
        <label>New date <input name="to" type="date" required defaultValue={isRealDay(to) ? to : ''} /></label>
        <button type="submit">Preview</button>
      </form>
      {to !== '' && !isRealDay(to) && <p role="alert">Pick a real date.</p>}
      {to === v.date && <p role="alert">The wedding is already on that date.</p>}
      {move && (
        <>
          <h2>Preview</h2>
          <MovePreviewView preview={move.preview} plan={move.plan} from={move.from} to={to} />
          <ActionForm action={proposeDateMove.bind(null, ctx.slug)}>
            <input type="hidden" name="to" value={to} />
            <input type="hidden" name="fingerprint" value={move.preview.fingerprint} />
            <button type="submit">Propose this move</button>
          </ActionForm>
          <p>Moving the date also flags every booked vendor for re-confirmation.</p>
          <p><Link href={`/o/${ctx.slug}/wedding/date/insurance?to=${to}`}>Before you decide: contracts, payments and insurance questions for this move</Link> (general information, not insurance or legal advice).</p>
        </>
      )}
    </main>
  );
}
