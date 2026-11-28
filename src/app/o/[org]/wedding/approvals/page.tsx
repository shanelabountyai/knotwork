import { inOrg, requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { PAYLOAD } from '@/lib/knotwork/consent/execute';
import { KIND_LABEL } from '@/lib/knotwork/consent/machine';
import { expireDue } from '@/lib/knotwork/consent/store';
import { usd } from '@/lib/knotwork/money';
import { movePreview } from '@/lib/knotwork/secrecy/views';
import { approveRequest, declineRequest, proposeSettings, withdrawRequest } from '../actions';
import { now } from '@/core/clock';
import { Keys, KeysLegend, requestKind, Status, TableWrap } from '@/app/ui/kw';
import { designatedSentence, MovePreviewView, NoWedding, WeddingNav } from '../bits';
import { nameOf, partnerName, view } from '../view';

export const metadata = { title: 'Approvals' };
const when = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
/** How long the result of your own approval or decline stays in place of its card. */
const RESULT_MS = 10 * 60 * 1000;

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
  // The other partner, by name, for the keys' words and the section heading (none yet: "your partner").
  const partner = partnerName(v, ctx.userId);
  // Round 2 (D-177): after you approve or decline, the card becomes the result. The action still redirects here as it
  // always did; the page shows the request you decided in the last few minutes, in place of its card.
  const t = now().getTime();
  const justDecided = decided
    .filter((r) => r.deciderId === ctx.userId && (r.status === 'approved' || r.status === 'declined') && r.decidedAt && t - r.decidedAt.getTime() < RESULT_MS)
    .sort((a, b) => b.decidedAt!.getTime() - a.decidedAt!.getTime())[0];

  return (
    <main>
      <WeddingNav who={v.who} slug={ctx.slug} life={v.wedding.mode === 'life'} counts={{ approvals: forMe.length, flags: 0 }} />
      <h1>Approvals</h1>
      <p className="kw-lede">{designatedSentence(usd(w.spendThresholdCents))} Nothing happens until the second key turns; approving does it in the same step.</p>
      {v.partners.length < 2 && (
        <p role="status">
          {w.pairedAt
            ? 'You have had two partners here and now have one. Nothing here can be approved until a second partner joins.'
            : 'You are the only partner so far, so these happen as soon as you ask and are marked solo. From the moment your partner joins, each needs both of you, for good.'}
        </p>
      )}

      <div className="kw-split">
        <div className="kw-col">
          <section aria-label="Waiting for you" className="kw-stack">
            <h2>Waiting for you</h2>
            {justDecided && (
              <article role="status" aria-label={`${justDecided.status === 'approved' ? 'You approved' : 'You declined'}: ${justDecided.summary}`} className="kw-request kw-result" data-k={justDecided.status === 'approved' ? 'ok' : 'off'}>
                <h3>{justDecided.status === 'approved' ? 'Approved' : 'Declined'}: {justDecided.summary}</h3>
                {justDecided.status === 'approved'
                  ? <Keys state="both" />
                  : <p>Nothing changed. {nameOf(v, justDecided.proposerId)} can see that you declined{justDecided.declineReason ? `, and why: ${justDecided.declineReason}` : ''}.</p>}
              </article>
            )}
            {forMe.length === 0 && <p>Nothing is waiting for you.</p>}
            {forMe.map((r) => {
              const p = previews.get(r.id);
              return (
                <article key={r.id} aria-label={`Request: ${r.summary}`} className="kw-request">
                  <h3>{r.summary}</h3>
                  <p className="kw-meta"><Status k="wait">waiting for you</Status> <span>{KIND_LABEL[r.kind]} · proposed by {nameOf(v, r.proposerId)} · expires {when(r.expiresAt)}</span></p>
                  <Keys state="theirs" partner={nameOf(v, r.proposerId)} />
                  {p && <MovePreviewView preview={p.preview} plan={p.plan} from={p.from} to={PAYLOAD.change_date.parse(r.payload).to} />}
                  <div className="kw-actions">
                    <div className="kw-approve">
                      <ActionForm action={bind(approveRequest)}>
                        <input type="hidden" name="id" value={r.id} />
                        {p && <input type="hidden" name="fingerprint" value={p.preview.fingerprint} />}
                        <button type="submit">Approve<span className="sr-only">: {r.summary}</span></button>
                      </ActionForm>
                    </div>
                    <details className="kw-decline">
                      <summary>Decline…<span className="sr-only">: {r.summary}</span></summary>
                      <ActionForm action={bind(declineRequest)}>
                        <input type="hidden" name="id" value={r.id} />
                        <label>Why not? (optional) <span className="hint">{nameOf(v, r.proposerId)} sees this.</span> <input name="reason" maxLength={500} /></label>
                        <button type="submit" className="secondary">Decline<span className="sr-only">: {r.summary}</span></button>
                      </ActionForm>
                    </details>
                  </div>
                </article>
              );
            })}
          </section>

          <section aria-label="Waiting for your partner" className="kw-stack">
            <h2>Waiting for {partner}</h2>
            {mine.length === 0 && <p>Nothing of yours is waiting for {partner}.</p>}
            {mine.map((r) => (
              <article key={r.id} aria-label={`Your request: ${r.summary}`} className="kw-request">
                <h3>{r.summary}</h3>
                <p className="kw-meta"><Status k="wait">waiting for {partner}</Status> <span>{KIND_LABEL[r.kind]} · expires {when(r.expiresAt)}. It has not happened yet.</span></p>
                <Keys state="yours" partner={partner} />
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
            <KeysLegend />
            <p><small>Nobody can approve their own request: the second key is always the other partner&apos;s.</small></p>
          </div>
          <section aria-label="Approval rules">
            <h2>The rules</h2>
            <p>A spend over <strong>{usd(w.spendThresholdCents)}</strong> needs both of you. A request expires after <strong>{w.consentExpiryDays} days</strong>. RSVPs are due <strong>{w.chaseBufferDays} days</strong> before the earliest vendor count deadline. Changing any of these needs both of you too.</p>
            <ActionForm action={bind(proposeSettings)}>
              <label>Spends over this need both of you <input name="spendThreshold" required defaultValue={(w.spendThresholdCents / 100).toFixed(2)} /></label>
              <label>Days until a request expires <input name="consentExpiryDays" inputMode="numeric" required defaultValue={w.consentExpiryDays} /></label>
              <label>RSVPs due this many days before the first vendor count <input name="chaseBufferDays" inputMode="numeric" required defaultValue={w.chaseBufferDays} /></label>
              <button type="submit" className="secondary">Propose new rules</button>
            </ActionForm>
          </section>
        </div>
      </div>

      <section aria-label="Decided">
        <h2>Decided</h2>
        <TableWrap label="Decided requests">
        <table aria-label="Decided requests" role="table" className="kw-stack-sm">
          <thead><tr role="row"><th role="columnheader" scope="col">Request</th><th role="columnheader" scope="col">Outcome</th><th role="columnheader" scope="col">Proposed by</th><th role="columnheader" scope="col">Decided by</th><th role="columnheader" scope="col">When</th></tr></thead>
          <tbody>
            {decided.map((r) => (
              <tr role="row" key={r.id}>
                <th role="rowheader" scope="row">{r.summary}</th><td role="cell" data-label="Outcome"><Status k={requestKind(r.status)}>{r.status}</Status>{r.status === 'approved' && <> <Keys state={r.solo ? 'solo' : 'both'} short /></>}{r.declineReason && `: ${r.declineReason}`}</td><td role="cell" data-label="Proposed by">{nameOf(v, r.proposerId)}</td>
                <td role="cell" data-label="Decided by">{r.deciderId ? nameOf(v, r.deciderId) : r.solo ? 'nobody: solo' : ''}</td><td role="cell" data-label="When" className="num">{r.decidedAt ? when(r.decidedAt) : ''}</td>
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
