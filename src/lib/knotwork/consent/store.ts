// Consent requests in the database: propose, decide, and the lazy expiry. The state machine (machine.ts) decides;
// this file persists; execute.ts does the action. Everything runs inside the caller's withOrg transaction.
import { inOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import type { Prisma } from '@/generated/prisma/client';
import { ARCHIVE_REFUSAL, isPartner } from '../access';
import { logChange } from '../changelog';
import { syncPairing, type WeddingRow } from '../context';
import { executeApproved } from './execute';
import { canPropose, expiresAt, KIND_LABEL, PLAN_KINDS, REFUSAL_MESSAGE, soloAllowed, transition, type ConsentEvent, type ConsentKind, type ConsentStatus } from './machine';

type Ctx = { orgId: string; userId: string; role: string };

/**
 * A partner asks for a designated action. With two partners nothing changes but this row. In solo mode (D-33: one
 * partner, never paired) the request is approved and executed at once, marked solo, in this same transaction; a date
 * move then needs the fingerprint of the preview the proposer saw. Returns whether it executed.
 */
export async function propose(tx: Tx, ctx: Ctx, wedding: WeddingRow, kind: ConsentKind, payload: Prisma.InputJsonObject, summary: string, opts: { fingerprint?: string } = {}) {
  const actor = { userId: ctx.userId, isPartner: isPartner(ctx.role) };
  if (!canPropose(actor)) throw new Refused('Only the two partners can ask for this.');
  if (PLAN_KINDS.includes(kind) && wedding.mode === 'life') throw new Refused(ARCHIVE_REFUSAL); // D-144: the plan is an archive
  const pairing = await syncPairing(tx, ctx, wedding);
  const t = now();
  const r = await tx.consentRequest.create({
    data: { orgId: ctx.orgId, kind, payload, summary, proposerId: ctx.userId, proposedAt: t, expiresAt: new Date(expiresAt(t.getTime(), wedding.consentExpiryDays)) },
  });
  await logChange(tx, ctx, 'request', 'proposed', r.id, summary, null, { kind, status: 'pending', expiresAt: r.expiresAt });
  if (!soloAllowed({ partnerCount: pairing.partnerCount, everPaired: !!pairing.wedding.pairedAt }, actor)) return { ...r, executed: false };
  await tx.consentRequest.update({ where: { id: r.id }, data: { status: 'approved', solo: true, decidedAt: t, executedAt: t } });
  await logChange(tx, ctx, 'request', 'approved', r.id, summary, { status: 'pending' }, { status: 'approved', solo: true }, { kind, proposerId: ctx.userId, solo: true });
  await executeApproved(tx, ctx, { id: r.id, kind, payload }, { fingerprint: opts.fingerprint, solo: true });
  return { ...r, executed: true };
}

/** True when a pending request of this kind already names this vendor or guest (or, with neither, exists at all). */
export async function hasPending(tx: Tx, ctx: { orgId: string }, kind: ConsentKind, vendorId?: string, guestId?: string): Promise<boolean> {
  const rows = await tx.consentRequest.findMany({ where: { ...inOrg(ctx), kind, status: 'pending', expiresAt: { gt: now() } }, select: { payload: true } });
  if (vendorId) return rows.some((r) => (r.payload as { vendorId?: string }).vendorId === vendorId);
  if (guestId) return rows.some((r) => ((r.payload as { guestIds?: string[] }).guestIds ?? []).includes(guestId));
  return rows.length > 0;
}

/** Marks every overdue pending request of the org expired (the lazy sweep; pages call it before listing). */
export async function expireDue(tx: Tx, ctx: { orgId: string }): Promise<number> {
  const due = await tx.consentRequest.findMany({ where: { ...inOrg(ctx), status: 'pending', expiresAt: { lte: now() } }, select: { id: true, summary: true } });
  for (const r of due) {
    await tx.consentRequest.update({ where: { id: r.id }, data: { status: 'expired' } });
    await logChange(tx, { orgId: ctx.orgId, userId: null }, 'request', 'expired', r.id, r.summary, { status: 'pending' }, { status: 'expired' });
  }
  return due.length;
}

export type Decision = { ok: true; status: ConsentStatus } | { ok: false; message: string };

/**
 * Approve, decline or withdraw. The caller has already proved the request is in this org (notFound otherwise).
 * Returns a refusal instead of throwing, so that an overdue request's `expired` status still commits; a refusal from
 * execution (the vendor is gone, the plan changed) throws and rolls the approval back with it.
 */
export async function decide(tx: Tx, ctx: Ctx, id: string, event: Exclude<ConsentEvent, 'expire'>, opts: { fingerprint?: string; reason?: string } = {}): Promise<Decision> {
  const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "ConsentRequest" WHERE id = ${id}::uuid AND "orgId" = ${ctx.orgId}::uuid FOR UPDATE`;
  if (!locked) throw new Error('decide() needs a request of this org');
  const r = await tx.consentRequest.findUniqueOrThrow({ where: { id } });
  const t = now();
  const out = transition({ status: r.status, proposerId: r.proposerId, expiresAt: r.expiresAt.getTime() }, event, { userId: ctx.userId, isPartner: isPartner(ctx.role) }, t.getTime());
  if (!out.ok) {
    if (out.status === 'expired' && r.status === 'pending') {
      await tx.consentRequest.update({ where: { id }, data: { status: 'expired' } });
      await logChange(tx, { orgId: ctx.orgId, userId: null }, 'request', 'expired', id, r.summary, { status: 'pending' }, { status: 'expired' });
    }
    return { ok: false, message: REFUSAL_MESSAGE[out.reason] };
  }
  if (out.status === 'approved') {
    // One UPDATE writes the second key and the execution time; the action follows in this same transaction.
    await tx.consentRequest.update({ where: { id }, data: { status: 'approved', deciderId: ctx.userId, decidedAt: t, executedAt: t } });
    await logChange(tx, ctx, 'request', 'approved', id, r.summary, { status: 'pending' }, { status: 'approved' }, { kind: r.kind, proposerId: r.proposerId });
    await executeApproved(tx, ctx, { id, kind: r.kind, payload: r.payload }, { fingerprint: opts.fingerprint });
  } else if (out.status === 'declined') {
    await tx.consentRequest.update({ where: { id }, data: { status: 'declined', deciderId: ctx.userId, decidedAt: t, declineReason: opts.reason ?? '' } });
    await logChange(tx, ctx, 'request', 'declined', id, r.summary, { status: 'pending' }, { status: 'declined', reason: opts.reason ?? '' });
  } else {
    await tx.consentRequest.update({ where: { id }, data: { status: 'withdrawn' } });
    await logChange(tx, ctx, 'request', 'withdrawn', id, r.summary, { status: 'pending' }, { status: 'withdrawn' });
  }
  return { ok: true, status: out.status };
}

export const kindLabel = (k: ConsentKind) => KIND_LABEL[k];
