// Link-out registry items in the database (PRD P1-8). Every write takes the wedding lock first, then RE-READS what is
// claimed: two households claiming the last one at once are served one after the other, and the second is refused
// (the database checks the same sum again at commit, RegistryClaim_wanted_check).
//
// The couple sees each item's claims by household NAME (as for pooled gifts); a guest sees how many are still wanted
// and its own claim only (gifts/public.ts builds that, through gifts/projection.ts).
import { inOrg } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { logChange } from '../changelog';
import { requireWedding, todayOf } from '../context';
import { dayOfDb, dbOfDay } from '../days';
import { lockWedding } from '../schedule/store';
import { planClaim, safeLink, type ClaimRefusal } from './links';

type Ctx = { orgId: string; userId: string | null };

/** A checked item: `url` is the canonical href that checkStoreUrl returned. */
export type LinkInput = { title: string; store: string; url: string; priceCents: number | null; quantityWanted: number };

const claimedOf = async (tx: Tx, orgId: string, linkId: string) => (await tx.registryClaim.aggregate({ where: { orgId, linkId }, _sum: { quantity: true } }))._sum.quantity ?? 0;

async function uniqueTitle(tx: Tx, ctx: Ctx, title: string, except?: string) {
  const other = await tx.registryLink.findFirst({ where: { ...inOrg(ctx), title, ...(except && { id: { not: except } }) }, select: { id: true } });
  if (other) throw new Refused(`There is already a store item called ${title}.`);
}

export async function addLink(tx: Tx, ctx: Ctx, input: LinkInput) {
  await lockWedding(tx, ctx.orgId);
  await uniqueTitle(tx, ctx, input.title);
  const link = await tx.registryLink.create({ data: { orgId: ctx.orgId, ...input, createdById: ctx.userId } });
  await logChange(tx, ctx, 'registrylink', 'created', link.id, link.title, null, { ...input });
  return link;
}

/** An item can change, but never to fewer wanted than households have already claimed. */
export async function updateLink(tx: Tx, ctx: Ctx, id: string, input: LinkInput) {
  await lockWedding(tx, ctx.orgId);
  const before = await tx.registryLink.findFirstOrThrow({ where: { id, ...inOrg(ctx) } });
  await uniqueTitle(tx, ctx, input.title, id);
  const claimed = await claimedOf(tx, ctx.orgId, id);
  if (input.quantityWanted < claimed) throw new Refused(`Guests have already marked ${claimed} of these as bought. Ask for at least ${claimed}.`);
  await tx.registryLink.update({ where: { id }, data: input });
  await logChange(tx, ctx, 'registrylink', 'updated', id, input.title, { title: before.title, store: before.store, url: before.url, priceCents: before.priceCents, quantityWanted: before.quantityWanted }, { ...input });
}

/** An item nobody has claimed can go. One somebody bought stays (it is on the thank-you ledger). */
export async function removeLink(tx: Tx, ctx: Ctx, id: string) {
  await lockWedding(tx, ctx.orgId);
  const link = await tx.registryLink.findFirstOrThrow({ where: { id, ...inOrg(ctx) } });
  if (await tx.registryClaim.count({ where: { ...inOrg(ctx), linkId: id } })) throw new Refused('A guest has already marked this as bought, so it stays on the registry.');
  await tx.registryLink.delete({ where: { id } });
  await logChange(tx, ctx, 'registrylink', 'deleted', id, link.title, { title: link.title, store: link.store, url: link.url, quantityWanted: link.quantityWanted }, null);
}

export type Claimed = { ok: true } | { ok: false; code: ClaimRefusal | 'not-here' | 'not-claimed' };

/**
 * A household marks `quantity` of an item as bought, through its own link. Null when the household is not (or no
 * longer) invited. Planned against what is claimed once every earlier claim has committed. The claim is also a gift
 * on the couple's thank-you ledger, owed from today (P1-3). The log line says who bought what.
 */
export async function claim(tx: Tx, orgId: string, householdId: string, linkId: string, quantity: number): Promise<Claimed | null> {
  await lockWedding(tx, orgId);
  const ctx = { orgId, userId: null };
  const household = await tx.household.findFirst({ where: { id: householdId, orgId, state: 'invited' }, select: { id: true, name: true } });
  if (!household) return null;
  const link = await tx.registryLink.findFirst({ where: { id: linkId, orgId } });
  if (!link) return { ok: false, code: 'not-here' };
  const mine = await tx.registryClaim.findUnique({ where: { linkId_householdId: { linkId, householdId } }, select: { quantity: true } });
  const plan = planClaim(link.quantityWanted, await claimedOf(tx, orgId, linkId), mine?.quantity ?? null, quantity);
  if (!plan.ok) return plan;
  const on = todayOf(await requireWedding(tx, ctx));
  const row = await tx.registryClaim.create({ data: { orgId, linkId, householdId, quantity, claimedOn: dbOfDay(on) } });
  await logChange(tx, ctx, 'claim', 'claimed', row.id, `${household.name} bought ${link.title}`, null, { household: household.name, item: link.title, quantity, claimedOn: on }, { via: 'gift-link' });
  return { ok: true };
}

/** A household takes its own claim back (bought by mistake, or returned). Its thank-you leaves the ledger with it. */
export async function withdraw(tx: Tx, orgId: string, householdId: string, linkId: string): Promise<Claimed | null> {
  await lockWedding(tx, orgId);
  const ctx = { orgId, userId: null };
  const household = await tx.household.findFirst({ where: { id: householdId, orgId, state: 'invited' }, select: { id: true, name: true } });
  if (!household) return null;
  const link = await tx.registryLink.findFirst({ where: { id: linkId, orgId }, select: { title: true } });
  if (!link) return { ok: false, code: 'not-here' };
  const mine = await tx.registryClaim.findUnique({ where: { linkId_householdId: { linkId, householdId } } });
  if (!mine) return { ok: false, code: 'not-claimed' };
  await tx.registryClaim.delete({ where: { id: mine.id } });
  await logChange(tx, ctx, 'claim', 'withdrawn', mine.id, `${household.name} took back ${link.title}`, { household: household.name, item: link.title, quantity: mine.quantity, acknowledgedOn: mine.acknowledgedOn ? dayOfDb(mine.acknowledgedOn) : null }, null, { via: 'gift-link' });
  return { ok: true };
}

/** A partner marks the thank-you for a claimed item as sent. Once. */
export async function acknowledgeClaim(tx: Tx, ctx: Ctx & { userId: string }, id: string) {
  const c = await tx.registryClaim.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, include: { household: { select: { name: true } }, link: { select: { title: true } } } });
  if (c.acknowledgedOn) throw new Refused('That thank-you is already marked as sent.');
  const on = todayOf(await requireWedding(tx, ctx));
  await tx.registryClaim.update({ where: { id }, data: { acknowledgedOn: dbOfDay(on), acknowledgedById: ctx.userId } });
  await logChange(tx, ctx, 'claim', 'acknowledged', id, `${c.household.name}, for ${c.link.title}`, { acknowledgedOn: null }, { acknowledgedOn: on });
}

export type CoupleLink = {
  id: string; title: string; store: string; url: string; link: { href: string; host: string } | null; priceCents: number | null;
  quantityWanted: number; claimed: number; remaining: number;
  /** Household names, A to Z: everyone who marked it as bought. */
  claimants: string[];
};

/** The couple's view of the link-out items: each with how many are claimed and by whom (names). */
export async function loadLinks(tx: Tx, ctx: { orgId: string }): Promise<CoupleLink[]> {
  const links = await tx.registryLink.findMany({ where: { orgId: ctx.orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { claims: { select: { quantity: true, household: { select: { name: true } } } } } });
  return links.map((l) => {
    const claimed = l.claims.reduce((n, c) => n + c.quantity, 0);
    return {
      id: l.id, title: l.title, store: l.store, url: l.url, link: safeLink(l.url), priceCents: l.priceCents,
      quantityWanted: l.quantityWanted, claimed, remaining: Math.max(0, l.quantityWanted - claimed),
      claimants: l.claims.map((c) => c.household.name).sort((a, b) => a.localeCompare(b)),
    };
  });
}

