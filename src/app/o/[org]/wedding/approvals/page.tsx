import { inOrg, requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { PAYLOAD } from '@/lib/knotwork/consent/execute';
import { KIND_LABEL } from '@/lib/knotwork/consent/machine';
import { expireDue } from '@/lib/knotwork/consent/store';
import { usd } from '@/lib/knotwork/money';
import { movePreview } from '@/lib/knotwork/secrecy/views';
import { approveRequest, declineRequest, proposeSettings, withdrawRequest } from '../actions';
import { MovePreviewView, NoWedding, WeddingNav } from '../bits';
import { nameOf, view } from '../view';

export const metadata = { title: 'Approvals' };
const when = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// PRD P0-2: the two-key requests. A request shows here until the OTHER partner approves or declines it, its
// proposer withdraws it, or it expires. Approving runs the action in the same transaction.
export default async function Approvals({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'consent.view', async (tx, v) => {
    await expireDue(tx, ctx); // overdue requests become expired before anything is listed
    const requests = await tx.consentRequest.findMany({ where: inOrg(ctx), orderBy: { proposedAt: 'desc' }, take: 100 });
    // For a date move, the approver is shown the cascade as it is NOW; approving sends this preview's fingerprint.
    const previews = new Map<string, Awaited<ReturnType<typeof movePreview>>>(); // P1-1: private task titles masked
    for (const r of requests.filter((x) => x.status === 'pending' && x.kind === 'change_date')) {
      const p = PAYLOAD.change_date.safeParse(r.payload);
      if (p.success && p.data.to !== v.date) previews.set(r.id, await movePreview(tx, ctx, v, p.data.to));
    }
    return { requests, previews };
  });
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, requests, previews } = data;
  const pending = requests.filter((r) => r.status === 'pending');
  const [forMe, mine] = [pending.filter((r) => r.proposerId !== ctx.userId), pending.filter((r) => r.proposerId === ctx.userId)];
  const decided = requests.filter((r) => r.status !== 'pending');
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  const w = v.wedding;

  return (
    <main>
      <WeddingNav slug={ctx.slug} counts={{ approvals: forMe.length, flags: 0 }} />
      <h1>Approvals</h1>
      <p>Booking a vendor, signing a contract, a spend over {usd(w.spendThresholdCents)}, moving the date and changing these rules each need both of you.</p>
      {v.partners.length < 2 && (
        <p role="status">
          {w.pairedAt
            ? 'This workspace has had two partners and now has one. Nothing here can be approved until a second partner joins as an owner.'
            : 'You are the only partner so far, so these happen as soon as you ask and are marked solo. From the moment your partner joins as an owner, each needs both of you, for good.'}
        </p>
      )}

      <section aria-label="Waiting for you">
        <h2>Waiting for you</h2>
        {forMe.length === 0 && <p>Nothing is waiting for you.</p>}
        {forMe.map((r) => {
          const p = previews.get(r.id);
          return (
            <article key={r.id} aria-label={`Request: ${r.summary}`}>
              <h3>{r.summary}</h3>
              <p>{KIND_LABEL[r.kind]} · proposed by {nameOf(v, r.proposerId)} · expires {when(r.expiresAt)}</p>
              {p && <MovePreviewView preview={p.preview} plan={p.plan} from={p.from} to={PAYLOAD.change_date.parse(r.payload).to} />}
              <ActionForm action={bind(approveRequest)}>
                <input type="hidden" name="id" value={r.id} />
                {p && <input type="hidden" name="fingerprint" value={p.preview.fingerprint} />}
                <button type="submit">Approve</button>
              </ActionForm>
              <ActionForm action={bind(declineRequest)}>
                <input type="hidden" name="id" value={r.id} />
                <label>Reason <input name="reason" maxLength={500} /></label>
                <button type="submit">Decline</button>
              </ActionForm>
            </article>
          );
        })}
      </section>

      <section aria-label="Waiting for your partner">
        <h2>Waiting for your partner</h2>
        {mine.length === 0 && <p>You have nothing waiting.</p>}
        {mine.map((r) => (
          <article key={r.id} aria-label={`Your request: ${r.summary}`}>
            <h3>{r.summary}</h3>
            <p>{KIND_LABEL[r.kind]} · expires {when(r.expiresAt)}. It has not happened yet.</p>
            <ActionForm action={bind(withdrawRequest)}>
              <input type="hidden" name="id" value={r.id} />
              <button type="submit">Withdraw</button>
            </ActionForm>
          </article>
        ))}
      </section>

      <section aria-label="Decided">
        <h2>Decided</h2>
        <table aria-label="Decided requests">
          <thead><tr><th scope="col">Request</th><th scope="col">Outcome</th><th scope="col">Proposed by</th><th scope="col">Decided by</th><th scope="col">When</th></tr></thead>
          <tbody>
            {decided.map((r) => (
              <tr key={r.id}>
                <th scope="row">{r.summary}</th><td>{r.status}{r.solo && ' (solo)'}{r.declineReason && `: ${r.declineReason}`}</td><td>{nameOf(v, r.proposerId)}</td>
                <td>{r.deciderId ? nameOf(v, r.deciderId) : r.solo ? 'nobody: solo' : ''}</td><td>{r.decidedAt ? when(r.decidedAt) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="Approval rules">
        <h2>The rules</h2>
        <p>A spend over <strong>{usd(w.spendThresholdCents)}</strong> needs both of you. A request expires after <strong>{w.consentExpiryDays} days</strong>. RSVPs are due <strong>{w.chaseBufferDays} days</strong> before the earliest vendor count deadline. Changing any of these needs both of you too.</p>
        <ActionForm action={bind(proposeSettings)}>
          <label>Spend threshold <input name="spendThreshold" required defaultValue={(w.spendThresholdCents / 100).toFixed(2)} /></label>
          <label>Days until a request expires <input name="consentExpiryDays" inputMode="numeric" required defaultValue={w.consentExpiryDays} /></label>
          <label>RSVP chase buffer in days <input name="chaseBufferDays" inputMode="numeric" required defaultValue={w.chaseBufferDays} /></label>
          <button type="submit">Propose new rules</button>
        </ActionForm>
      </section>
    </main>
  );
}
