// The guest's side of gifting (PRD P0-5, D-63): a household gives through its own RSVP link, /r/[token]/gifts. No new
// credential: the token lookup is guests/public.ts's (the one Knotwork file allowed to read across orgs), with the
// same rate limit and the same nothing for an unknown, malformed, queued or regrets token. Everything after that one
// lookup runs inside the household's own org, and everything returned comes from gifts/projection.ts (rule 3).
import { withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { requireWedding } from '../context';
import { dayOfDb, todayIn } from '../days';
import { householdOfLink } from '../guests/public';
import { parseCents } from '../money';
import { parseQuantity } from '../registry/links';
import { claim, withdraw } from '../registry/store';
import { giftView, type GiftDone, type GiftProblem, type GiftView } from './projection';
import { contribute } from './store';

async function viewOf(tx: Tx, orgId: string, householdId: string): Promise<GiftView | null> {
  const h = await tx.household.findFirst({ where: { id: householdId, orgId, state: 'invited' }, select: { name: true } });
  if (!h) return null;
  const wedding = await requireWedding(tx, { orgId });
  const items = await tx.registryItem.findMany({ where: { orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, title: true, note: true, targetCents: true, state: true } });
  // Progress is one sum per item: the same number for every household. Whose money it is has no path to this page.
  const pots = await tx.giftEntry.groupBy({ by: ['itemId'], where: { orgId }, _sum: { amountCents: true } });
  // This household's own entries, and only those.
  const own = await tx.giftEntry.findMany({ where: { orgId, householdId }, orderBy: [{ createdAt: 'asc' }, { kind: 'asc' }], select: { itemId: true, kind: true, amountCents: true, createdAt: true } });
  // P1-8: the store items, how many of each anyone has claimed (one sum per item), and this household's own claims.
  const links = await tx.registryLink.findMany({ where: { orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, title: true, store: true, url: true, priceCents: true, quantityWanted: true } });
  const claimed = await tx.registryClaim.groupBy({ by: ['linkId'], where: { orgId }, _sum: { quantity: true } });
  const ownClaims = await tx.registryClaim.findMany({ where: { orgId, householdId }, select: { linkId: true, quantity: true, claimedOn: true } });
  return giftView({
    wedding: { title: wedding.title },
    household: { name: h.name },
    items: items.map((i) => ({ ...i, potCents: pots.find((p) => p.itemId === i.id)?._sum.amountCents ?? 0 })),
    own: own.map((e) => ({ itemId: e.itemId, kind: e.kind, amountCents: e.amountCents, on: todayIn(wedding.timeZone, e.createdAt) })),
    links: links.map((l) => ({ ...l, claimed: claimed.find((c) => c.linkId === l.id)?._sum.quantity ?? 0 })),
    ownClaims: ownClaims.map((c) => ({ linkId: c.linkId, quantity: c.quantity, on: dayOfDb(c.claimedOn) })),
  });
}

/** What the gift page shows. Unknown, not-yet-invited and malformed tokens all return null: one 404 for all of them. */
export async function readGifts(token: string, ip: string): Promise<GiftView | 'limited' | null> {
  const h = await householdOfLink(token, ip);
  if (h === 'limited' || !h) return h;
  return withOrg({ orgId: h.orgId }, (tx) => viewOf(tx, h.orgId, h.id));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A household's contribution. `amount` is dollars as typed; it becomes integer cents with no float in between. */
export async function contributeGift(token: string, ip: string, input: { itemId: string; amount: string }): Promise<{ ok: true; done: GiftDone } | { ok: false; code: GiftProblem } | 'limited' | null> {
  const h = await householdOfLink(token, ip);
  if (h === 'limited' || !h) return h;
  if (!UUID.test(input.itemId)) return { ok: false, code: 'not-here' };
  const cents = parseCents(input.amount);
  if (cents === null) return { ok: false, code: 'amount' };
  try {
    const r = await withOrg({ orgId: h.orgId }, (tx) => contribute(tx, h.orgId, h.id, input.itemId, cents));
    if (!r) return null;
    return r.ok ? { ok: true, done: r.returned ? 'part' : 'thanks' } : { ok: false, code: r.code };
  } catch (e) {
    // A refusal from inside the store rolled everything back. One neutral sentence, never a 500 on a guest's own link.
    if (e instanceof Refused) return { ok: false, code: 'fail' };
    throw e;
  }
}

/**
 * P1-8: a household marks a store item as bought (`op: 'claim'`, with how many) or takes its own mark back
 * (`op: 'withdraw'`). The same answers as a contribution: 'limited', null for a link that names nobody, or a code from
 * the closed list. Bounded by how many the couple wants, under the wedding lock (registry/store.ts).
 */
export async function claimGift(token: string, ip: string, input: { linkId: string; op: string; quantity: string }): Promise<{ ok: true; done: GiftDone } | { ok: false; code: GiftProblem } | 'limited' | null> {
  const h = await householdOfLink(token, ip);
  if (h === 'limited' || !h) return h;
  if (!UUID.test(input.linkId)) return { ok: false, code: 'not-here' };
  const withdrawing = input.op === 'withdraw';
  const quantity = withdrawing ? 0 : parseQuantity(input.quantity === '' ? '1' : input.quantity);
  if (quantity === null) return { ok: false, code: 'quantity' };
  try {
    const r = await withOrg({ orgId: h.orgId }, (tx) => (withdrawing ? withdraw(tx, h.orgId, h.id, input.linkId) : claim(tx, h.orgId, h.id, input.linkId, quantity)));
    if (!r) return null;
    return r.ok ? { ok: true, done: withdrawing ? 'withdrawn' : 'claimed' } : { ok: false, code: r.code };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, code: 'fail' };
    throw e;
  }
}
