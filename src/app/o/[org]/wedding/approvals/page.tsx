import { inOrg, requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { PAYLOAD } from '@/lib/knotwork/consent/execute';
import { KIND_LABEL } from '@/lib/knotwork/consent/machine';
import { expireDue } from '@/lib/knotwork/consent/store';
import { usd } from '@/lib/knotwork/money';
import { movePreview } from '@/lib/knotwork/secrecy/views';
import { approveRequest, declineRequest, proposeSettings, withdrawRequest } from '../actions';
import { Keys, requestKind, Status, TableWrap } from '@/app/ui/kw';
import { designatedSentence, MovePreviewView, NoWedding, WeddingNav } from '../bits';
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
      <WeddingNav who={v.who} slug={ctx.slug} life={v.wedding.mode === 'life'} counts={{ approvals: forMe.length, flags: 0 }} />
      <h1>Approvals</h1>
      <p className="kw-lede">{designatedSentence(usd(w.spendThresholdCents))} Nothing happens until the second key turns; approving does it in the same step.</p>
      {v.partners.length < 2 && (
        <p role="status">
          {w.pairedAt
            ? 'This workspace has had two partners and now has one. Nothing here can be approved until a second partner joins as an owner.'
            : 'You are the only partner so far, so these happen as soon as you ask and are marked solo. From the moment your partner joins as an owner, each needs both of you, for good.'}
        </p>
      )}

      <div className="kw-split">
        <div className="kw-col">
          <section aria-label="Waiting for you" className="kw-stack">
            <h2>Waiting for you</h2>
            {forMe.length === 0 && <p>Nothing is waiting for you.</p>}
            {forMe.map((r) => {
              const p = previews.get(r.id);
              return (
                <article key={r.id} aria-label={`Request: ${r.summary}`} className="kw-request">
                  <h3>{r.summary}</h3>
                  <p className="kw-meta"><Status k="wait">waiting for you</Status> <span>{KIND_LABEL[r.kind]} · proposed by {nameOf(v, r.proposerId)} · expires {when(r.expiresAt)}</span></p>
                  <Keys on={1}>{nameOf(v, r.proposerId)}&apos;s key is turned; yours is the second</Keys>
                  {p && <MovePreviewView preview={p.preview} plan={p.plan} from={p.from} to={PAYLOAD.change_date.parse(r.payload).to} />}
                  <div className="kw-actions">
                    <ActionForm action={bind(approveRequest)}>
                      <input type="hidden" name="id" value={r.id} />
                      {p && <input type="hidden" name="fingerprint" value={p.preview.fingerprint} />}
                      <button type="submit">Approve<span className="sr-only">: {r.summary}</span></button>
                    </ActionForm>
                    <ActionForm action={bind(declineRequest)}>
                      <input type="hidden" name="id" value={r.id} />
                      <label>Reason for declining (optional) <input name="reason" maxLength={500} /></label>
                      <button type="submit" className="secondary">Decline<span className="sr-only">: {r.summary}</span></button>
                    </ActionForm>
                  </div>
                </article>
              );
            })}
          </section>

          <section aria-label="Waiting for your partner" className="kw-stack">
            <h2>Waiting for your partner</h2>
            {mine.length === 0 && <p>You have nothing waiting.</p>}
            {mine.map((r) => (
              <article key={r.id} aria-label={`Your request: ${r.summary}`} className="kw-request">
                <h3>{r.summary}</h3>
                <p className="kw-meta"><Status k="wait">waiting for your partner</Status> <span>{KIND_LABEL[r.kind]} · expires {when(r.expiresAt)}. It has not happened yet.</span></p>
                <Keys on={1}>Your key is turned; your partner&apos;s is the second</Keys>
                <ActionForm action={bind(withdrawRequest)}>
                  <input type="hidden" name="id" value={r.id} />
                  <button type="submit" className="secondary">Withdraw<span className="sr-only">: {r.summary}</span></button>
                </ActionForm>
              </article>
            ))}
          </section>
        </div>

        <div className="kw-col">
          <div className="card" aria-label="The keys" role="group">
            <h2>The keys</h2>
            <ul className="kw-plain kw-rows">
              <li><Keys on={0}>Nothing proposed</Keys></li>
              <li><Keys on={1}>One key turned: proposed, nothing has changed yet</Keys></li>
              <li><Keys on={2}>Both keys: approved and done, in the same step</Keys></li>
              <li><Keys on={1} solo>Solo: before a second partner joins</Keys></li>
            </ul>
            <p><small>A partner cannot approve their own request; the database refuses it too.</small></p>
          </div>
          <section aria-label="Approval rules">
            <h2>The rules</h2>
            <p>A spend over <strong>{usd(w.spendThresholdCents)}</strong> needs both of you. A request expires after <strong>{w.consentExpiryDays} days</strong>. RSVPs are due <strong>{w.chaseBufferDays} days</strong> before the earliest vendor count deadline. Changing any of these needs both of you too.</p>
            <ActionForm action={bind(proposeSettings)}>
              <label>Spend threshold <input name="spendThreshold" required defaultValue={(w.spendThresholdCents / 100).toFixed(2)} /></label>
              <label>Days until a request expires <input name="consentExpiryDays" inputMode="numeric" required defaultValue={w.consentExpiryDays} /></label>
              <label>RSVP chase buffer in days <input name="chaseBufferDays" inputMode="numeric" required defaultValue={w.chaseBufferDays} /></label>
              <button type="submit" className="secondary">Propose new rules</button>
            </ActionForm>
          </section>
        </div>
      </div>

      <section aria-label="Decided">
        <h2>Decided</h2>
        <TableWrap label="Decided requests">
        <table aria-label="Decided requests">
          <thead><tr><th scope="col">Request</th><th scope="col">Outcome</th><th scope="col">Proposed by</th><th scope="col">Decided by</th><th scope="col">When</th></tr></thead>
          <tbody>
            {decided.map((r) => (
              <tr key={r.id}>
                <th scope="row">{r.summary}</th><td><Status k={requestKind(r.status)}>{r.status}</Status>{r.solo && <> <Keys on={1} solo>(solo)</Keys></>}{r.declineReason && `: ${r.declineReason}`}</td><td>{nameOf(v, r.proposerId)}</td>
                <td>{r.deciderId ? nameOf(v, r.deciderId) : r.solo ? 'nobody: solo' : ''}</td><td className="num">{r.decidedAt ? when(r.decidedAt) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </TableWrap>
        {decided.length === 0 && <p>Nothing decided yet.</p>}
      </section>
    </main>
  );
}
