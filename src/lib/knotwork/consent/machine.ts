// The two-key state machine (PRD P0-2). PURE: no database, no clock; "now" is an argument.
//
// A partner proposes a designated action. It executes only when a DIFFERENT partner approves, before it expires.
//   pending → approved | declined   by another partner
//   pending → withdrawn             by the proposer
//   pending → expired               by time (checked on every transition, and swept by cron)
// Every other state is terminal. The machine decides; consent/store.ts persists; consent/execute.ts does the action.

export const DESIGNATED_KINDS = ['book_vendor', 'sign_contract', 'spend', 'change_date', 'change_settings', 'remove_guest', 'set_mode'] as const;
export type ConsentKind = (typeof DESIGNATED_KINDS)[number];
export type ConsentStatus = 'pending' | 'approved' | 'declined' | 'withdrawn' | 'expired';
export type ConsentEvent = 'approve' | 'decline' | 'withdraw' | 'expire';
export type Refusal = 'already-decided' | 'expired' | 'not-due' | 'not-a-partner' | 'own-request' | 'not-the-proposer';
export type RequestState = { status: ConsentStatus; proposerId: string; expiresAt: number }; // expiresAt: epoch ms
export type Actor = { userId: string; isPartner: boolean };
/** `status` is the request's status after the attempt: a refused attempt on an overdue request leaves it expired. */
export type Outcome = { ok: true; status: ConsentStatus } | { ok: false; reason: Refusal; status: ConsentStatus };

export const KIND_LABEL: Record<ConsentKind, string> = {
  book_vendor: 'Book a vendor',
  sign_contract: 'Sign a contract',
  spend: 'Spend over the threshold',
  change_date: 'Change the wedding date',
  change_settings: 'Change the approval rules',
  remove_guest: 'Remove a guest',
  set_mode: 'Switch between planning and life-admin mode',
};

/**
 * Phase 5 (D-144): the kinds that change the wedding plan, which is a read-only archive in life-admin mode. They can be
 * neither proposed nor executed there; the approval rules and the switch itself still can.
 */
export const PLAN_KINDS: readonly ConsentKind[] = ['book_vendor', 'sign_contract', 'spend', 'change_date', 'remove_guest'];

export const REFUSAL_MESSAGE: Record<Refusal, string> = {
  'already-decided': 'This request has already been decided.',
  expired: 'This request has expired. Propose it again.',
  'not-due': 'This request has not expired yet.',
  'not-a-partner': 'Only the two partners can approve or decline.',
  'own-request': 'You proposed this, so your partner has to decide it.',
  'not-the-proposer': 'Only the partner who proposed this can withdraw it.',
};

export const canPropose = (actor: Actor) => actor.isPartner;

/** A spend needs both partners when it is strictly over the threshold (D-14). */
export const spendNeedsConsent = (amountCents: number, thresholdCents: number) => amountCents > thresholdCents;

/** When a request proposed at `nowMs` expires. Whole days, at least one. */
export function expiresAt(nowMs: number, days: number): number {
  if (!Number.isInteger(days) || days < 1) throw new Error('expiry must be a whole number of days, at least 1');
  return nowMs + days * 86_400_000;
}

export function transition(r: RequestState, event: ConsentEvent, actor: Actor, nowMs: number): Outcome {
  if (r.status !== 'pending') return { ok: false, reason: 'already-decided', status: r.status };
  const overdue = nowMs >= r.expiresAt;
  if (event === 'expire') return overdue ? { ok: true, status: 'expired' } : { ok: false, reason: 'not-due', status: 'pending' };
  if (overdue) return { ok: false, reason: 'expired', status: 'expired' };
  const isProposer = actor.userId === r.proposerId;
  if (event === 'withdraw') return isProposer ? { ok: true, status: 'withdrawn' } : { ok: false, reason: 'not-the-proposer', status: 'pending' };
  if (!actor.isPartner) return { ok: false, reason: 'not-a-partner', status: 'pending' };
  if (isProposer) return { ok: false, reason: 'own-request', status: 'pending' };
  return { ok: true, status: event === 'approve' ? 'approved' : 'declined' };
}

/**
 * Solo mode (D-33, owner decision 2026-11-24). While a workspace has exactly one partner and has never had two, that
 * partner's designated actions execute at once, single-signed and marked solo. The moment a second partner has been
 * seen, the workspace is paired for good: losing a partner later does not bring solo back, or removing your partner
 * would be a way to act alone.
 */
export const soloAllowed = (w: { partnerCount: number; everPaired: boolean }, actor: Actor) => actor.isPartner && w.partnerCount === 1 && !w.everPaired;
