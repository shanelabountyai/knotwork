// What every Knotwork page and action needs first: who is asking (partner or helper, with which grants), the wedding,
// and today in the wedding's time zone. Runs inside the caller's withOrg transaction.
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { now } from '@/core/clock';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { allows, isPartner, type Capability, type GrantScope, type Who } from './access';
import { dayOfDb, todayIn, type Day } from './days';

export async function loadWho(tx: Tx, ctx: OrgCtx): Promise<Who> {
  if (isPartner(ctx.role)) return { role: ctx.role, grants: [] };
  const grants = await tx.helperGrant.findMany({ where: { ...inOrg(ctx), userId: ctx.userId }, select: { scope: true } });
  return { role: ctx.role, grants: grants.map((g) => g.scope as GrantScope) };
}

/** Refuses with a message the form can show. Partners pass every capability. */
export function need(who: Who, cap: Capability) {
  if (!allows(who, cap)) throw new Refused('You do not have access to that. Ask one of the partners for it.');
}

export const loadWedding = (tx: Tx, ctx: { orgId: string }) => tx.wedding.findUnique({ where: { orgId: ctx.orgId } });
export type WeddingRow = NonNullable<Awaited<ReturnType<typeof loadWedding>>>;

export async function requireWedding(tx: Tx, ctx: { orgId: string }): Promise<WeddingRow> {
  const w = await loadWedding(tx, ctx);
  if (!w) throw new Refused('Create the wedding first.');
  return w;
}

/** Today, as the couple sees it. The only place the scheduler's "today" comes from. */
export const todayOf = (w: { timeZone: string }): Day => todayIn(w.timeZone, now());
export const weddingDay = (w: { date: Date }): Day => dayOfDb(w.date);

/** The org's partners (owner memberships), for "who else can approve" and for names in the feed. */
export const partnersOf = (tx: Tx, ctx: { orgId: string }) =>
  tx.membership.findMany({ where: { orgId: ctx.orgId, role: 'owner' }, select: { userId: true, user: { select: { email: true, name: true } } }, orderBy: { createdAt: 'asc' } });

/** What ends with a membership (src/app/org-hooks.ts): the person's helper grants, and their task assignments. */
export async function endHelper(tx: Tx, orgId: string, userId: string) {
  await tx.helperGrant.deleteMany({ where: { orgId, userId } });
  await tx.task.updateMany({ where: { orgId, assigneeId: userId }, data: { assigneeId: null } });
}

/**
 * The pairing latch (D-33): the first time two partners are seen, `pairedAt` is set and never unset. Called by every
 * page (view.ts) and by propose(), so a second partner who has so much as opened a page ends solo mode for good.
 * Returns the wedding as it now is, and how many partners there are.
 */
export async function syncPairing(tx: Tx, ctx: { orgId: string }, wedding: WeddingRow): Promise<{ wedding: WeddingRow; partnerCount: number }> {
  const partnerCount = await tx.membership.count({ where: { orgId: ctx.orgId, role: 'owner' } });
  if (partnerCount < 2 || wedding.pairedAt) return { wedding, partnerCount };
  return { wedding: await tx.wedding.update({ where: { orgId: ctx.orgId }, data: { pairedAt: now() } }), partnerCount };
}
